// The P2P control plane of one engine (PLAN 1.2, 3 and 4): identity, invites, the handshakes,
// sessions, the join decision, capabilities and grants, the peer store and the audit log.
// It runs in Node only; the window renders what it reports and asks through commands.
//
// Other modules use three things:
//   node.handle(type, fn)        a handler for a message type; it runs only after the grant check
//   node.send(peerId, type, b)   send to a peer with an accepted open session
//   node.can(peerId, cap)        the active grant this engine gave that peer, or null
// and listen to: 'join.request', 'join.decided', 'peer.online', 'peer.offline', 'grant.created',
// 'grant.revoked' (also on expiry and session end: stop the work it allowed), 'held.changed',
// 'cap.request', 'invite.burned', 'audit'.

import { EventEmitter } from 'node:events';
import path from 'node:path';
import crypto from 'node:crypto';
import { AuditLog } from './audit.js';
import { PeerStore } from './peers.js';
import { InviteBook, deriveInvite, deriveAddressInvite, readWords, INVITE_ITERATIONS } from './invites.js';
import { deriveAddress } from '../remote/address.js';
import { HandshakeError, InviteGuest, InviteHost, KnownInitiator, KnownResponder, failMessage, parseHs } from './handshake.js';
import { SecureSession } from './session.js';
import { messageSpec } from './messages.js';
import { CAPABILITIES, CapError, findGrant, grantForWire, isActive, joinDialogToggles, makeGrant, normalizeCapability, normalizeCapList, readWireGrant } from './caps.js';
import { cleanName, isPeerId, loadOrCreateIdentity, publicIdentity } from './identity.js';
import { base32, b64u } from './encoding.js';
import { publicProfile } from '../profile/sanitize.js';

export const HANDSHAKE_MS = 15_000;
export const DECISION_MS = 5 * 60_000;
export const PING_MS = 5_000;
export const DEAD_MS = 10_000; // PLAN 8: no pong for 10 s is a disconnect

/** Incoming handshakes per minute on this machine's address (a published address must not flood the host). */
const ADDRESS_RATE = 10;
const USER = Object.freeze({ kind: 'user' });
const SYSTEM = Object.freeze({ kind: 'system' });

/** Waits for the next text on a connection, with a deadline. */
function nextText(conn, ms) {
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      conn.off('message', onMsg);
      conn.off('close', onClose);
    };
    const onMsg = (t) => {
      done();
      resolve(t);
    };
    const onClose = () => {
      done();
      reject(new HandshakeError('closed', 'the connection closed during the handshake'));
    };
    const timer = setTimeout(() => {
      done();
      reject(new HandshakeError('timeout', 'the handshake took too long'));
    }, ms);
    conn.on('message', onMsg);
    conn.on('close', onClose);
  });
}

const rid = (prefix) => prefix + base32(crypto.randomBytes(8)).slice(0, 12);

export class P2PNode extends EventEmitter {
  /**
   * @param {{ home: string, name?: string, now?: () => number, iterations?: number, handshakeMs?: number,
   *   decisionMs?: number, pingMs?: number, deadMs?: number, rekeyMessages?: number, rekeyMs?: number,
   *   cityId?: string, machineId?: string, viewCommands?: string[] }} o
   */
  constructor(o) {
    super();
    this.home = o.home;
    this.opts = o;
    this.now = o.now || (() => Date.now());
    this.iterations = o.iterations ?? INVITE_ITERATIONS;
    this.handshakeMs = o.handshakeMs ?? HANDSHAKE_MS;
    this.decisionMs = o.decisionMs ?? DECISION_MS;
    this.pingMs = o.pingMs ?? PING_MS;
    this.deadMs = o.deadMs ?? DEAD_MS;
    this.viewCommands = new Set(o.viewCommands || []);
    this.handlers = new Map();
    this.sessions = new Map(); // sessionId -> rec
    this.byPeer = new Map(); // peerId -> sessionId
    this.sessionGrants = new Map(); // grantId -> grant (scope session, memory only)
    this.joinRequests = new Map(); // requestId -> request (host side)
    this.capRequests = new Map(); // id -> { peerId, capability, reason, at }
    this.ended = new Set(); // grant ids whose end (expiry) was already announced
    this.refusedAudit = new Map();
    this.seenOnline = new Set(); // peers that had a session in this run: the next one is a resume
    this.addressBook = new Map(); // topic -> { address, invite, hits: number[] } while listening by address
    this.addressRate = o.addressRate ?? ADDRESS_RATE;
    this.profile = null; // { name, avatar } this engine shows its peers (src/profile/)
    this.peerProfiles = new Map(); // peerId -> { name, avatar } they showed us, sanitized
    this.started = false;
  }

  /** Loads (or creates) the identity and opens the peer store and the audit log. */
  start() {
    if (this.started) return this;
    const { identity, created } = loadOrCreateIdentity(this.home, { name: this.opts.name, now: this.now });
    this.identity = identity;
    this.audit = new AuditLog({ dir: path.join(this.home, 'audit'), now: this.now });
    if (this.audit.repaired) this._audit({ type: 'audit.repaired', ...this.audit.repaired });
    if (created) this._audit({ type: 'identity.created', peerId: identity.peerId });
    this.peers = new PeerStore({ dir: path.join(this.home, 'peers'), now: this.now });
    this.invites = new InviteBook({ now: this.now, iterations: this.iterations });
    this.timer = setInterval(() => this.sweep(), 1000);
    this.timer.unref?.();
    this.started = true;
    return this;
  }

  _audit(entry) {
    const rec = this.audit.append(entry);
    this.emit('audit', rec);
    return rec;
  }

  info() {
    return { ...publicIdentity(this.identity) };
  }

  /** The name and avatar this engine shows its peers; sent to every open session and to each new one. */
  setProfile(p) {
    const prof = publicProfile(p, this.identity?.peerId);
    if (Number.isFinite(p?.achievements)) prof.achievements = Math.max(0, Math.min(1000, Math.round(p.achievements)));
    this.profile = prof;
    for (const rec of this.sessions.values()) if (rec.online && rec.session.state === 'open') rec.session.send('profile.hello', prof);
    return prof;
  }

  /** What a peer showed us, or null. */
  profileOf(peerId) {
    return this.peerProfiles.get(peerId) || this.peers?.get(peerId)?.profile || null;
  }

  // ------------------------------------------------------------------ invites (host)

  /** A new invite. Returns { inviteId, words, expiresAt, offeredCaps, rendezvous: { topic, seal } }. */
  async createInvite({ caps = [], minutes, origin = USER } = {}) {
    if (origin.kind !== 'user') throw new CapError('forbidden', 'only a person makes an invite');
    const inv = await this.invites.create({ minutes, offeredCaps: caps });
    this._audit({ type: 'invite.created', inviteId: inv.id, expiresAt: new Date(inv.expiresAt).toISOString(), offered: inv.offeredCaps.map((c) => c.name) });
    return { inviteId: inv.id, words: [...inv.words], expiresAt: new Date(inv.expiresAt).toISOString(), offeredCaps: inv.offeredCaps, rendezvous: { topic: inv.topic, seal: b64u(inv.seal) } };
  }

  cancelInvite(inviteId) {
    const inv = this.invites.cancel(inviteId);
    if (inv) this._audit({ type: 'invite.cancelled', inviteId });
    return !!inv;
  }

  // ------------------------------------------------------------------ incoming connections

  /** Takes an incoming connection: an invite handshake (hs.1) or a known peer reconnect (hs.k1). */
  async accept(conn) {
    let text;
    try {
      text = await nextText(conn, this.handshakeMs);
    } catch {
      conn.close('no handshake');
      return null;
    }
    let first;
    try {
      first = parseHs(text);
    } catch (err) {
      conn.send(failMessage(err.code));
      conn.close('bad handshake');
      return null;
    }
    if (first.t === 'hs.1' && typeof first.inv === 'string' && this.addressBook.has(first.inv)) return this._hostAddress(conn, text, this.addressBook.get(first.inv));
    if (first.t === 'hs.1') return this._hostInvite(conn, text, first);
    if (first.t === 'hs.k1') return this._respondKnown(conn, text);
    conn.send(failMessage('protocol'));
    conn.close('bad handshake');
    return null;
  }

  async _hostInvite(conn, m1, first) {
    let inv;
    try {
      inv = this.invites.take({ topic: typeof first.inv === 'string' ? first.inv : '' });
    } catch (err) {
      conn.send(failMessage(err.code === 'unknown' ? 'words' : err.code));
      conn.close('no invite');
      return null;
    }
    const hs = new InviteHost({ identity: this.identity, invite: inv, hostName: this.identity.name });
    let r;
    try {
      conn.send(hs.onM1(m1));
      r = hs.onM3(await nextText(conn, this.handshakeMs));
      const known = this.peers.get(r.guest.peerId);
      if (known?.trust === 'blocked') throw new HandshakeError('blocked', 'this peer is blocked');
    } catch (err) {
      this.invites.burn(inv.id, err.code);
      this._audit({ type: 'invite.burned', inviteId: inv.id, reason: err.code || 'failed' });
      this.emit('invite.burned', { inviteId: inv.id, reason: err.code || 'failed' });
      // "The words did not work" on both sides, whatever the reason was here.
      conn.send(failMessage(err.code === 'blocked' ? 'refused' : 'words'));
      conn.close('handshake failed');
      return null;
    }
    this.invites.consume(inv.id);
    const rec = this._openSession(conn, { ...r, peerId: r.guest.peerId, accepted: false, confirmed: true });
    // Key confirmation for the guest: the first frame it can open.
    rec.session.send('ping', {});
    const request = {
      id: rid('jr_'),
      inviteId: inv.id,
      sessionId: rec.session.id,
      peer: r.guest,
      name: r.name,
      requestedCaps: r.requestedCaps,
      offeredCaps: inv.offeredCaps,
      sas: r.sas,
      createdAt: this.now(),
      expiresAt: this.now() + this.decisionMs,
    };
    this.joinRequests.set(request.id, request);
    const audit = this._audit({ type: 'join.requested', requestId: request.id, peerId: r.guest.peerId, name: r.name, requested: r.requestedCaps.map((c) => c.name) });
    request.auditHash = audit.hash;
    this.emit('join.request', this.joinDialog(request));
    return rec.session;
  }

  // ------------------------------------------------------------------ by address (remote desktop)

  /** This machine's 10 digit address (src/remote/address.js), from its public key. */
  address() {
    return deriveAddress(this.identity.publicRaw);
  }

  /**
   * Listen (or stop) for handshakes on this machine's address. Off by default. A handshake by
   * address grants nothing: the caller gets a session in which it may ask, and only the host's
   * click grants (the remote desktop dialog). Incoming handshakes are rate limited per address.
   */
  listenAddress(on) {
    const address = this.address();
    const inv = deriveAddressInvite(address);
    if (on) this.addressBook.set(inv.topic, { address, invite: { id: `ad_${address}`, topic: inv.topic, psk: inv.psk, offeredCaps: [] }, hits: [] });
    else this.addressBook.delete(inv.topic);
    this._audit({ type: on ? 'address.listen' : 'address.stop', address });
    return { address, listening: !!on, rendezvous: { topic: inv.topic, seal: b64u(inv.seal) } };
  }

  /** The relay meeting point of an address, for the window half of browser-pipe: { topic, seal }. */
  addressRendezvous(address) {
    const inv = deriveAddressInvite(address);
    return { topic: inv.topic, seal: b64u(inv.seal) };
  }

  async _hostAddress(conn, m1, entry) {
    const t = this.now();
    entry.hits = entry.hits.filter((x) => t - x < 60_000);
    if (entry.hits.length >= this.addressRate) {
      if (entry.hits.length === this.addressRate) this._audit({ type: 'address.rate_limited', address: entry.address });
      entry.hits.push(t);
      conn.send(failMessage('rate_limited'));
      conn.close('rate limited');
      return null;
    }
    entry.hits.push(t);
    const hs = new InviteHost({ identity: this.identity, invite: { ...entry.invite, psk: Buffer.from(entry.invite.psk) }, hostName: this.identity.name });
    let r;
    try {
      conn.send(hs.onM1(m1));
      r = hs.onM3(await nextText(conn, this.handshakeMs));
      if (this.peers.get(r.guest.peerId)?.trust === 'blocked') throw new HandshakeError('blocked', 'this peer is blocked');
      if (r.guest.peerId === this.identity.peerId) throw new HandshakeError('protocol', 'that is this machine');
    } catch (err) {
      this._audit({ type: 'address.failed', reason: err.code || 'failed' });
      conn.send(failMessage(err.code === 'blocked' ? 'refused' : 'failed'));
      conn.close('handshake failed');
      return null;
    }
    // Remembered so a grant can name it; trust is not raised: a known peer stays known, a new one unknown.
    this.peers.upsert(r.guest, { relation: this.peers.get(r.guest.peerId)?.relation || 'remote', name: r.name });
    const rec = this._openSession(conn, { ...r, peerId: r.guest.peerId, accepted: true, confirmed: true, via: 'address' });
    rec.sas = r.sas;
    rec.session.send('ping', {});
    this._audit({ type: 'address.session', peerId: r.guest.peerId, sessionId: rec.session.id, name: r.name });
    this._online(rec);
    this.emit('address.session', { peerId: r.guest.peerId, sessionId: rec.session.id, name: r.name, sas: r.sas, role: 'host' });
    return rec.session;
  }

  /**
   * Dials a machine by its address over conn: the identity handshake without words. The answer
   * must come from a key whose address is the one dialed. Resolves with { sessionId, sas, host }.
   */
  async dialAddress(address, conn, { name } = {}) {
    const inv = deriveAddressInvite(address);
    const guest = new InviteGuest({ identity: this.identity, invite: { topic: inv.topic, psk: inv.psk }, name: name || this.identity.name, requestedCaps: [] });
    let r;
    try {
      conn.send(guest.start());
      const m2 = await nextText(conn, this.handshakeMs);
      ({ m3: guest.m3, result: r } = guest.onM2(m2));
      if (deriveAddress(r.host.publicRaw) !== address) throw new HandshakeError('address_mismatch', 'the machine that answered does not own that address');
      // Ten digits can be forged with enough work: the key first seen behind this address is pinned, and a
      // different key behind it blocks the call until the person forgets the old computer on purpose.
      const pinned = this.peers.pinnedFor(address);
      if (pinned && pinned.identity.peerId !== r.host.peerId) {
        throw new HandshakeError('address_key_changed', `WARNING: the computer at this address is not the one you connected to before (${pinned.identity.name || 'a known computer'}). Someone may be pretending to be it, so the call is blocked. If that computer was really reinstalled, forget it in your peers first.`);
      }
      if (r.host.peerId === this.identity.peerId) throw new HandshakeError('protocol', 'that is this machine');
      if (this.peers.get(r.host.peerId)?.trust === 'blocked') throw new HandshakeError('blocked', 'you blocked this machine');
    } catch (err) {
      conn.send(failMessage(err.code || 'failed'));
      conn.close('handshake failed');
      this._audit({ type: 'address.dial.failed', address, reason: err.code || 'failed' });
      throw err;
    }
    conn.send(guest.m3);
    this.peers.upsert({ ...r.host, name: r.hostName }, { relation: this.peers.get(r.host.peerId)?.relation || 'remote', name: r.hostName });
    const rec = this._openSession(conn, { ...r, peerId: r.host.peerId, accepted: true, confirmed: false, via: 'address' });
    rec.sas = r.sas;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => done(new HandshakeError('timeout', 'the machine did not answer')), this.handshakeMs);
      const done = (err) => {
        clearTimeout(timer);
        rec.session.off('confirmed', ok);
        rec.session.off('hsfail', onFail);
        if (err) {
          rec.session.close('handshake failed');
          reject(err);
        } else resolve();
      };
      const ok = () => done();
      const onFail = (code) => done(new HandshakeError(code || 'failed', 'the machine refused the handshake'));
      rec.session.once('confirmed', ok);
      rec.session.on('hsfail', onFail);
    });
    this.peers.pinAddress(r.host.peerId, address);
    this._audit({ type: 'address.dial', address, peerId: r.host.peerId, sessionId: rec.session.id });
    this._online(rec);
    this.emit('address.session', { peerId: r.host.peerId, sessionId: rec.session.id, name: r.hostName, sas: r.sas, role: 'guest' });
    return { sessionId: rec.session.id, sas: r.sas, host: { peerId: r.host.peerId, name: r.hostName, fingerprint: r.host.fingerprint } };
  }

  /** The data the Accept dialog shows (PLAN 3.3 step 5). Not a single Yes button: sasMatches is required. */
  joinDialog(req) {
    const known = this.peers.get(req.peer.peerId);
    return {
      requestId: req.id,
      peer: { peerId: req.peer.peerId, name: req.name, fingerprint: req.peer.fingerprint, knownBefore: known?.trust === 'known' },
      sas: req.sas,
      question: 'Do these words match on their screen?',
      requestedCaps: req.requestedCaps,
      toggles: joinDialogToggles(req.requestedCaps, req.offeredCaps),
      expiresAt: new Date(req.expiresAt).toISOString(),
      myFingerprint: this.identity.fingerprint,
    };
  }

  listJoinRequests() {
    return [...this.joinRequests.values()].map((r) => this.joinDialog(r));
  }

  /**
   * The host's answer. accept needs sasMatches: true, the person's statement that the six words
   * match on both screens. caps: [{ capability, minutes?, scope?, on? }] (the dialog toggles).
   */
  answerJoin(requestId, { accept, sasMatches, caps = [], reason } = {}, origin = USER) {
    if (origin.kind !== 'user') throw new CapError('forbidden', 'only a person answers a join request');
    const req = this.joinRequests.get(requestId);
    if (!req) throw new CapError('not_found', 'no such join request (it may have expired)');
    const rec = this.sessions.get(req.sessionId);
    if (accept && sasMatches !== true) throw new CapError('sas_unconfirmed', 'compare the six words with the other screen first');
    this.joinRequests.delete(requestId);
    if (!rec || rec.session.state !== 'open') {
      this._audit({ type: 'join.lost', requestId, peerId: req.peer.peerId });
      throw new CapError('not_found', 'the guest is gone');
    }
    if (!accept) {
      const why = sasMatches === false ? 'sas_mismatch' : (typeof reason === 'string' ? reason.slice(0, 120) : 'refused');
      rec.session.send('join.refuse', { reason: why });
      this._audit({ type: 'join.refused', requestId, peerId: req.peer.peerId, reason: why });
      this.emit('join.decided', { requestId, peerId: req.peer.peerId, accepted: false, reason: why });
      setImmediate(() => rec.session.close(why));
      return { accepted: false };
    }
    const peer = this.peers.upsert(req.peer, { trust: 'known', relation: 'guest', name: req.name });
    rec.accepted = true;
    const grants = [];
    for (const c of caps) {
      if (c && c.on === false) continue;
      const g = makeGrant({ peerId: req.peer.peerId, capability: c.capability ?? c, scope: c.scope, minutes: c.minutes, sessionId: rec.session.id, trust: peer.trust, origin, now: this.now() });
      this._storeGrant(g, rec);
      grants.push(g);
    }
    const audit = this._audit({ type: 'join.accepted', requestId, peerId: req.peer.peerId, sas: true, grants: grants.map((g) => ({ id: g.id, name: g.capability.name, expiresAt: g.expiresAt, scope: g.scope })) });
    rec.session.send('join.accept', { grants: grants.map(grantForWire), cityId: this.opts.cityId, machineId: this.opts.machineId });
    rec.session.send('audit.ref', { entryHash: audit.hash, type: 'join.accepted' });
    this._online(rec);
    this.emit('join.decided', { requestId, peerId: req.peer.peerId, accepted: true, grants: grants.map(grantForWire) });
    for (const g of grants) this.emit('grant.created', grantForWire(g));
    return { accepted: true, grants: grants.map(grantForWire) };
  }

  // ------------------------------------------------------------------ joining (guest)

  /**
   * Joins with six words over conn. Resolves once the host has opened our hs.3 (or rejects with a
   * HandshakeError: 'words' for wrong words or a burned invite). The result carries the SAS words
   * to show, the host's fingerprint, and decision: a promise of the host's Accept or Refuse.
   */
  async join(words, conn, { name, requestedCaps = [] } = {}) {
    const w = readWords(words);
    const d = await deriveInvite(w, this.iterations);
    const guest = new InviteGuest({ identity: this.identity, invite: { topic: d.topic, psk: d.psk }, name: name || this.identity.name, requestedCaps });
    let r;
    try {
      conn.send(guest.start());
      const m2 = await nextText(conn, this.handshakeMs);
      ({ m3: guest.m3, result: r } = guest.onM2(m2));
      if (this.peers.get(r.host.peerId)?.trust === 'blocked') throw new HandshakeError('blocked', 'you blocked this host');
    } catch (err) {
      conn.send(failMessage(err.code || 'failed'));
      conn.close('handshake failed');
      this._audit({ type: 'join.failed', reason: err.code || 'failed' });
      throw err;
    }
    conn.send(guest.m3);
    const rec = this._openSession(conn, { ...r, peerId: r.host.peerId, accepted: false, confirmed: false });
    rec.joining = true;
    rec.hostIdentity = { ...r.host, name: r.hostName };
    // The host may answer in the same burst as its first frame: be ready for the decision now.
    rec.decision = new Promise((resolve) => {
      rec.decide = resolve;
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => fail(new HandshakeError('timeout', 'the host did not answer')), this.handshakeMs);
      const ok = () => {
        clearTimeout(timer);
        rec.session.off('hsfail', onFail);
        resolve();
      };
      const fail = (err) => {
        clearTimeout(timer);
        rec.session.off('confirmed', ok);
        rec.session.off('hsfail', onFail);
        rec.session.close('handshake failed');
        reject(err);
      };
      const onFail = (code) => fail(new HandshakeError(code === 'refused' ? 'refused' : 'words', 'the words did not work'));
      rec.session.once('confirmed', ok);
      rec.session.on('hsfail', onFail);
    }).catch((err) => {
      this._audit({ type: 'join.failed', reason: err.code });
      throw err;
    });
    this._audit({ type: 'join.sent', peerId: r.host.peerId, requested: guest.requestedCaps.map((c) => c.name) });
    return {
      sessionId: rec.session.id,
      sas: r.sas,
      host: { peerId: r.host.peerId, name: r.hostName, fingerprint: r.host.fingerprint },
      offeredCaps: r.offeredCaps,
      decision: rec.decision,
    };
  }

  // ------------------------------------------------------------------ known peers

  /** Reconnects to a known peer over conn (no words). Resolves with the session. */
  async connect(peerId, conn) {
    const peer = this.peers.get(peerId);
    if (!peer) throw new HandshakeError('unknown_peer', 'not a known peer; use an invite');
    if (peer.trust === 'blocked') throw new HandshakeError('blocked', 'this peer is blocked');
    if (peer.trust !== 'known') throw new HandshakeError('unknown_peer', 'this peer was never accepted');
    const hs = new KnownInitiator({ identity: this.identity, peer: { peerId, publicRaw: peer.identity.publicRaw } });
    let r;
    try {
      conn.send(hs.start());
      r = hs.onM2(await nextText(conn, this.handshakeMs));
    } catch (err) {
      conn.send(failMessage(err.code || 'failed'));
      conn.close('handshake failed');
      this._audit({ type: 'reconnect.failed', peerId, reason: err.code || 'failed' });
      throw err;
    }
    const rec = this._openSession(conn, { ...r, peerId, role: peer.relation === 'guest' ? 'host' : 'guest', accepted: true, confirmed: true, via: 'known' });
    rec.session.send('ping', {});
    this._online(rec);
    return rec.session;
  }

  _respondKnown(conn, m1) {
    const hs = new KnownResponder({
      identity: this.identity,
      lookup: (id) => {
        const p = this.peers.get(id);
        return p ? { publicRaw: p.identity.publicRaw, trust: p.trust } : null;
      },
    });
    let out;
    try {
      out = hs.onM1(m1);
    } catch (err) {
      conn.send(failMessage(err.code));
      conn.close('handshake failed');
      this._audit({ type: 'reconnect.refused', reason: err.code });
      return null;
    }
    conn.send(out.m2);
    const peer = this.peers.get(out.result.peer.peerId);
    const rec = this._openSession(conn, { ...out.result, peerId: peer.identity.peerId, role: peer.relation === 'guest' ? 'host' : 'guest', accepted: true, confirmed: false, via: 'known' });
    const timer = setTimeout(() => rec.session.state === 'open' && !rec.session.confirmed && rec.session.close('not confirmed'), this.handshakeMs);
    timer.unref?.();
    rec.session.once('confirmed', () => {
      clearTimeout(timer);
      this._online(rec);
    });
    return rec.session;
  }

  // ------------------------------------------------------------------ sessions

  _openSession(conn, r) {
    const session = new SecureSession({
      id: r.sessionId,
      peerId: r.peerId,
      role: r.role,
      conn,
      sendKey: r.sendKey,
      recvKey: r.recvKey,
      now: this.now,
      rekeyMessages: this.opts.rekeyMessages,
      rekeyMs: this.opts.rekeyMs,
      confirmed: r.confirmed,
    });
    conn.remote.peerId = r.peerId;
    const rec = { session, peerId: r.peerId, accepted: r.accepted, via: r.via === 'known' ? 'known' : 'invite', grantsThere: new Map(), lastSeen: this.now(), online: false };
    this.sessions.set(session.id, rec);
    session.on('message', (msg, stream) => this._onMessage(rec, msg, stream));
    session.on('refused', (x) => this.emit('frame.refused', { peerId: r.peerId, ...x }));
    session.on('close', (reason) => this._sessionClosed(rec, reason));
    return rec;
  }

  _online(rec) {
    if (rec.online) return;
    const old = this.byPeer.get(rec.peerId);
    if (old && old !== rec.session.id) this.sessions.get(old)?.session.close('replaced by a new session');
    this.byPeer.set(rec.peerId, rec.session.id);
    rec.online = true;
    this.peers.touch(rec.peerId);
    this._audit({ type: 'session.open', peerId: rec.peerId, sessionId: rec.session.id, transport: rec.session.conn.transport });
    // Tell the peer what it holds here (standing grants survive; session grants never do).
    for (const g of this.grantsOf(rec.peerId, rec.session.id)) rec.session.send('cap.grant', { grant: grantForWire(g) });
    if (this.profile) rec.session.send('profile.hello', this.profile);
    // Liveness: a ping every pingMs, and a session that heard nothing for deadMs is closed.
    rec.pingAt = this.now();
    rec.keepalive = setInterval(() => {
      if (rec.session.state !== 'open') return clearInterval(rec.keepalive);
      if (this.now() - rec.lastSeen > this.deadMs) return rec.session.close('no answer');
      if (this.now() - rec.pingAt >= this.pingMs) {
        rec.pingAt = this.now();
        rec.session.send('ping', {});
      }
    }, Math.min(1000, this.pingMs));
    rec.keepalive.unref?.();
    const resumed = this.seenOnline.has(rec.peerId);
    this.seenOnline.add(rec.peerId);
    this.emit('peer.online', { peerId: rec.peerId, sessionId: rec.session.id, resumed, via: rec.via });
  }

  _sessionClosed(rec, reason) {
    clearInterval(rec.keepalive);
    this.sessions.delete(rec.session.id);
    rec.decide?.({ accepted: false, reason: `session closed: ${reason}` });
    rec.decide = null;
    for (const [id, req] of this.joinRequests) if (req.sessionId === rec.session.id) {
      this.joinRequests.delete(id);
      this.emit('join.gone', { requestId: id });
    }
    // Session grants end with their session.
    for (const g of [...this.sessionGrants.values()]) if (g.sessionId === rec.session.id && !g.revokedAt) this._endGrant(g, 'session_ended', SYSTEM);
    if (this.byPeer.get(rec.peerId) === rec.session.id) {
      this.byPeer.delete(rec.peerId);
      if (rec.online) {
        this._audit({ type: 'session.close', peerId: rec.peerId, sessionId: rec.session.id, reason: String(reason).slice(0, 80) });
        this.emit('peer.offline', { peerId: rec.peerId, sessionId: rec.session.id, reason });
      }
    }
  }

  sessionOf(peerId) {
    const id = this.byPeer.get(peerId);
    const rec = id && this.sessions.get(id);
    return rec && rec.session.state === 'open' ? rec : null;
  }

  // ------------------------------------------------------------------ messages

  _onMessage(rec, msg, stream) {
    rec.lastSeen = this.now();
    const { session } = rec;
    const spec = messageSpec(msg.t);
    if (!rec.accepted && !spec.pre) {
      // Nothing but the join answer travels before the host accepted.
      if (msg.t !== 'join.accept' && msg.t !== 'join.refuse') {
        if (msg.t !== 'error') session.send('error', { code: 'not_accepted', message: 'the join was not accepted yet' }, { re: msg.id });
        return;
      }
    }
    switch (msg.t) {
      case 'ping':
        return session.send('pong', { rtt: undefined }, { re: msg.id });
      case 'pong':
        if (rec.pingAt) session.conn.rttMs = this.now() - rec.pingAt;
        return;
      case 'session.close':
        return session.close(`closed by the peer: ${msg.body.reason}`);
      case 'join.accept':
        return this._joinAccepted(rec, msg);
      case 'join.refuse':
        if (!rec.joining) return;
        rec.joining = false;
        this._audit({ type: 'join.refused.by_host', peerId: rec.peerId, reason: msg.body.reason });
        rec.decide?.({ accepted: false, reason: msg.body.reason });
        rec.decide = null;
        return session.close('refused');
      case 'cap.grant': {
        const g = readWireGrant(msg.body.grant, this.identity.peerId);
        if (!g) return;
        rec.grantsThere.set(g.id, g);
        this._saveHeld(rec);
        this.emit('held.granted', { peerId: rec.peerId, sessionId: session.id, grant: g });
        return;
      }
      case 'cap.revoke': {
        const gone = rec.grantsThere.get(msg.body.grantId);
        if (!gone) return;
        rec.grantsThere.delete(msg.body.grantId);
        this._saveHeld(rec);
        this.emit('held.revoked', { peerId: rec.peerId, grantId: msg.body.grantId, capability: gone.capability.name, reason: msg.body.reason });
        return;
      }
      case 'cap.request': {
        const id = rid('cr_');
        const req = { id, peerId: rec.peerId, capability: msg.body.capability, reason: msg.body.reason, minutes: msg.body.minutes, at: new Date(this.now()).toISOString() };
        this.capRequests.set(id, req);
        while (this.capRequests.size > 50) this.capRequests.delete(this.capRequests.keys().next().value);
        this._audit({ type: 'cap.requested', peerId: rec.peerId, capability: msg.body.capability.name });
        this.emit('cap.request', req);
        return;
      }
      case 'audit.ref':
        this.emit('audit.ref', { peerId: rec.peerId, ...msg.body });
        return;
      case 'error':
        this.emit('peer.error', { peerId: rec.peerId, re: msg.re, ...msg.body });
        return;
      case 'identity.rotated':
        this.emit('identity.rotated', { peerId: rec.peerId, statement: msg.body });
        return;
      case 'profile.hello': {
        // bounded and sanitized again here: a name of 32 characters, an avatar id from the allowlist, the PeerId fallback
        const prof = publicProfile(msg.body, rec.peerId);
        if (Number.isFinite(msg.body.achievements)) prof.achievements = msg.body.achievements;
        this.peerProfiles.set(rec.peerId, prof);
        this.peers.setProfile?.(rec.peerId, prof);
        this.emit('peer.profile', { peerId: rec.peerId, profile: prof });
        return;
      }
      default:
        break;
    }
    let grant = null;
    if (spec.cap) {
      const cap = msg.t === 'city.cmd' && this.viewCommands.has(msg.body.type) ? 'city.view' : spec.cap;
      // city.member includes everything city.view allows.
      grant = this.can(rec.peerId, cap, session.id) || (cap === 'city.view' ? this.can(rec.peerId, 'city.member', session.id) : null);
      if (!grant) {
        this._auditRefused(rec.peerId, msg.t, cap);
        // A type may answer a refusal in its own protocol (job.offer: job.reject not_granted).
        const own = spec.refuse?.(msg.body);
        if (own) return session.send(own[0], own[1], { re: msg.id });
        return session.send('error', { code: 'not_granted', message: `${msg.t} needs ${cap}` }, { re: msg.id });
      }
    }
    const handler = this.handlers.get(msg.t);
    if (!handler) return session.send('error', { code: 'unsupported', message: `${msg.t} is not handled here` }, { re: msg.id });
    const ctx = {
      peerId: rec.peerId,
      sessionId: session.id,
      grant,
      stream,
      reply: (type, body) => session.send(type, body, { re: msg.id }),
    };
    Promise.resolve()
      .then(() => handler(msg, ctx))
      .catch((err) => session.state === 'open' && session.send('error', { code: typeof err?.code === 'string' ? err.code.slice(0, 40) : 'failed', message: String(err?.message || err).slice(0, 200) }, { re: msg.id }));
  }

  _auditRefused(peerId, type, cap) {
    const key = `${peerId}|${type}`;
    const last = this.refusedAudit.get(key) || 0;
    if (this.now() - last < 10_000) return;
    this.refusedAudit.set(key, this.now());
    this._audit({ type: 'message.refused', peerId, message: type, capability: cap, code: 'not_granted' });
  }

  _joinAccepted(rec, msg) {
    if (!rec.joining) return;
    rec.joining = false;
    rec.accepted = true;
    const host = this.peers.upsert(rec.hostIdentity, { trust: 'known', relation: 'host' });
    for (const raw of msg.body.grants) {
      const g = readWireGrant(raw, this.identity.peerId);
      if (g) rec.grantsThere.set(g.id, g);
    }
    if (msg.body.machineId) this.peers.setMachine(host.identity.peerId, msg.body.machineId);
    this._saveHeld(rec);
    this._audit({ type: 'join.accepted.by_host', peerId: rec.peerId, grants: [...rec.grantsThere.values()].map((g) => ({ id: g.id, name: g.capability.name })) });
    this._online(rec);
    rec.decide?.({ accepted: true, grants: [...rec.grantsThere.values()], cityId: msg.body.cityId, machineId: msg.body.machineId });
    rec.decide = null;
  }

  _saveHeld(rec) {
    const held = [...rec.grantsThere.values()].filter((g) => isActive(g, this.now()));
    this.peers.setHeld(rec.peerId, held);
    this.emit('held.changed', { peerId: rec.peerId, held });
  }

  /** A handler for a message type. One per type; it runs after the grant check. */
  handle(type, fn) {
    if (!messageSpec(type)) throw new TypeError(`register the message type ${type} first (messages.js registerMessage)`);
    this.handlers.set(type, fn);
    return () => this.handlers.get(type) === fn && this.handlers.delete(type);
  }

  /** Sends a message to a peer with an open, accepted session. Returns the message id. */
  send(peerId, type, body = {}, opts) {
    const rec = this.sessionOf(peerId);
    if (!rec || !rec.accepted) throw new CapError('offline', 'no open session with this peer');
    return rec.session.send(type, body, opts);
  }

  /** Asks a peer for a capability (asking is free; the peer rate limits it to 5 per minute). */
  requestCapability(peerId, capability, reason = '', minutes) {
    return this.send(peerId, 'cap.request', { capability: normalizeCapability(capability), reason: String(reason).slice(0, 200), minutes });
  }

  // ------------------------------------------------------------------ grants

  _storeGrant(g, rec) {
    if (g.scope === 'standing') this.peers.addGrant(g);
    else this.sessionGrants.set(g.id, g);
    if (rec) rec.session.state === 'open' && rec.accepted !== false && rec.online && rec.session.send('cap.grant', { grant: grantForWire(g) });
  }

  /** Active grants this engine gave a peer (standing ones and those of the given session). */
  grantsOf(peerId, sessionId) {
    const now = this.now();
    const standing = this.peers.activeGrants(peerId, now);
    const session = [...this.sessionGrants.values()].filter((g) => g.peerId === peerId && isActive(g, now) && (sessionId === undefined || g.sessionId === sessionId));
    return [...standing, ...session];
  }

  /** The active grant for a capability that this engine gave the peer, or null. */
  can(peerId, capability, sessionId) {
    const peer = this.peers.get(peerId);
    if (!peer || peer.trust === 'blocked') return null;
    const sid = sessionId ?? this.byPeer.get(peerId);
    return findGrant(this.grantsOf(peerId, sid), capability, this.now(), undefined);
  }

  /** Grants held on a remote peer (announced by it), active only. */
  held(peerId) {
    const now = this.now();
    const rec = this.sessionOf(peerId);
    const list = rec ? [...rec.grantsThere.values()] : (this.peers.get(peerId)?.held || []);
    return list.filter((g) => isActive(g, now));
  }

  /** A person grants a capability to a known peer. */
  grant(peerId, capability, { minutes, scope } = {}, origin = USER) {
    if (!isPeerId(peerId)) throw new CapError('bad_request', 'bad peer id');
    const peer = this.peers.get(peerId);
    if (!peer) throw new CapError('not_found', 'not a known peer');
    const rec = this.sessionOf(peerId);
    const name = normalizeCapability(capability).name;
    const sc = scope || (CAPABILITIES[name].standing ? 'standing' : 'session');
    const g = makeGrant({ peerId, capability, scope: sc, minutes, sessionId: rec?.session.id, trust: peer.trust, origin, now: this.now() });
    this._storeGrant(g, rec);
    const a = this._audit({ type: 'grant', grantId: g.id, peerId, capability: g.capability.name, limits: g.capability.limits, scope: g.scope, expiresAt: g.expiresAt });
    if (rec?.online) rec.session.send('audit.ref', { entryHash: a.hash, type: 'grant' });
    this.emit('grant.created', grantForWire(g));
    return grantForWire(g);
  }

  _findGrant(grantId) {
    if (this.sessionGrants.has(grantId)) return this.sessionGrants.get(grantId);
    for (const p of this.peers.list()) {
      const g = p.grants.find((x) => x.id === grantId);
      if (g) return g;
    }
    return null;
  }

  /** Revokes a grant now. The peer is told, and 'grant.revoked' lets modules stop the work it allowed. */
  revoke(grantId, reason = 'revoked', origin = USER) {
    if (origin.kind !== 'user' && origin.kind !== 'system') throw new CapError('forbidden', 'a peer cannot revoke here');
    const g = this._findGrant(grantId);
    if (!g) throw new CapError('not_found', 'no such grant');
    if (g.revokedAt) return grantForWire(g);
    this._endGrant(g, typeof reason === 'string' ? reason.slice(0, 120) : 'revoked', origin);
    return grantForWire(g);
  }

  _endGrant(g, reason, origin) {
    const ts = new Date(this.now()).toISOString();
    // An expired grant keeps its expiresAt as the end; anything else is a revoke.
    if (reason !== 'expired') {
      if (g.scope === 'standing') this.peers.revokeGrant(g.id, ts);
      g.revokedAt = ts;
    }
    this.ended.add(g.id);
    const rec = this.sessionOf(g.peerId);
    if (rec?.online) rec.session.send('cap.revoke', { grantId: g.id, reason });
    const a = this._audit({ type: reason === 'expired' ? 'grant.expired' : 'revoke', grantId: g.id, peerId: g.peerId, capability: g.capability.name, reason, by: origin.kind });
    if (rec?.online) rec.session.send('audit.ref', { entryHash: a.hash, type: 'revoke' });
    this.emit('grant.revoked', { grant: grantForWire(g), reason });
  }

  /** Blocks a peer: every grant revoked, its session closed, no reconnect, no invite accepted. */
  block(peerId, origin = USER) {
    if (origin.kind !== 'user') throw new CapError('forbidden', 'only a person blocks a peer');
    const peer = this.peers.get(peerId);
    if (!peer) throw new CapError('not_found', 'not a known peer');
    for (const g of this.grantsOf(peerId)) this._endGrant(g, 'blocked', origin);
    this.peers.setTrust(peerId, 'blocked');
    this._audit({ type: 'block', peerId });
    this.emit('peer.blocked', { peerId });
    this.sessionOf(peerId)?.session.close('blocked');
    return true;
  }

  unblock(peerId, origin = USER) {
    if (origin.kind !== 'user') throw new CapError('forbidden', 'only a person unblocks a peer');
    if (!this.peers.setTrust(peerId, 'unknown')) throw new CapError('not_found', 'not a known peer');
    this._audit({ type: 'unblock', peerId });
    return true;
  }

  /** Forgets a peer: grants revoked, session closed, its file removed. It needs a new invite. */
  forget(peerId, origin = USER) {
    if (origin.kind !== 'user') throw new CapError('forbidden', 'only a person forgets a peer');
    for (const g of this.grantsOf(peerId)) this._endGrant(g, 'forgotten', origin);
    this.sessionOf(peerId)?.session.close('forgotten');
    const gone = this.peers.remove(peerId);
    if (gone) this._audit({ type: 'forget', peerId });
    return gone;
  }

  /** Peer of PLAN section 2, for every stored peer. */
  listPeers() {
    return this.peers.list().map((p) => {
      const rec = this.sessionOf(p.identity.peerId);
      return {
        identity: { peerId: p.identity.peerId, publicKey: p.identity.publicKey, name: p.identity.name, fingerprint: p.identity.fingerprint, createdAt: p.identity.createdAt },
        trust: p.trust,
        relation: p.relation,
        firstSeen: p.firstSeen,
        lastSeen: p.lastSeen,
        online: !!rec?.online,
        ...(rec?.online ? { sessionId: rec.session.id, transport: rec.session.conn.transport, rttMs: rec.session.conn.rttMs } : {}),
        grants: this.grantsOf(p.identity.peerId, rec?.session.id).map(grantForWire),
        held: this.held(p.identity.peerId).map(grantForWire),
        ...(p.machineId ? { machineId: p.machineId } : {}),
        ...(this.profileOf(p.identity.peerId) ? { profile: this.profileOf(p.identity.peerId) } : {}),
      };
    });
  }

  listCapRequests() {
    return [...this.capRequests.values()];
  }

  // ------------------------------------------------------------------ time

  /** Expires grants, invites and join requests that are due. Runs every second. */
  sweep() {
    const now = this.now();
    for (const inv of this.invites.sweep()) {
      this._audit({ type: 'invite.expired', inviteId: inv.id });
      this.emit('invite.expired', { inviteId: inv.id });
    }
    for (const [id, req] of this.joinRequests) if (now >= req.expiresAt) {
      try {
        this.answerJoin(id, { accept: false, reason: 'timeout' });
      } catch {
        this.joinRequests.delete(id);
      }
    }
    const all = [...this.sessionGrants.values(), ...this.peers.list().flatMap((p) => p.grants)];
    for (const g of all) {
      if (g.revokedAt || this.ended.has(g.id) || g.expiresAt === null) continue;
      if (Date.parse(g.expiresAt) <= now) this._endGrant(g, 'expired', SYSTEM);
    }
    for (const rec of this.sessions.values()) {
      let changed = false;
      for (const [id, g] of rec.grantsThere) if (!isActive(g, now)) {
        rec.grantsThere.delete(id);
        changed = true;
        this.emit('held.revoked', { peerId: rec.peerId, grantId: id, capability: g.capability.name, reason: 'expired' });
      }
      if (changed) this._saveHeld(rec);
    }
  }

  async close() {
    clearInterval(this.timer);
    for (const rec of [...this.sessions.values()]) rec.session.close('engine stopping');
    this.started = false;
  }
}

export { USER, SYSTEM, cleanName, normalizeCapList };
