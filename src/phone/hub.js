// The phone remote on the desktop engine (docs/1.0/protocol/phone.md). The engine is the authority:
// it holds the desktop's phone key, makes the one time invites, runs the handshakes and the
// sessions, keeps the paired phones and their grants, and checks every command a phone sends
// against those grants, a rate limit and the session's expiry before anything runs. The page on
// the phone only renders and asks. Every action lands in the hash chained audit log.
//
// Events: 'pair.request' (dialog), 'pair.gone', 'pair.decided', 'invite.used', 'invite.expired',
// 'changed' (phones, sessions or requests changed), 'session' ('open' | 'close', rec),
// 'remote.message' (rec, msg) and 'remote.off' (deviceId) for the remote desktop port (port.js).

import { EventEmitter } from 'node:events';
import path from 'node:path';
import crypto from 'node:crypto';
import { PhoneStore, loadHostKey, publicRecord } from './store.js';
import { statusView, chatView, approvalCard, feedItem, noticeOf, SNAPSHOT_EVENTS } from './view.js';
import { PairHost, KnownHost, PhoneHandshakeError, failMessage, parseHs, cleanName } from '../../ui/phone/core/handshake.js';
import { FrameSession } from '../../ui/phone/core/session.js';
import { b64u, fromB64u, randomBytes } from '../../ui/phone/core/crypto.js';
import { inviteLink, deriveInvite, homeTopic, homeSeal, INVITE_MS, PAGE_URL } from '../../ui/phone/core/invite.js';
import { OPS, cleanGrants, grantList, GRANT_NAMES } from '../../ui/phone/core/grants.js';

export const HANDSHAKE_MS = 15_000;
export const DECISION_MS = 3 * 60_000;
export const SESSION_MS = 8 * 60 * 60_000;
export const IDLE_MS = 90_000;
export const MAX_HANDSHAKES_PER_MINUTE = 12;
export const MAX_INVITES = 4;

export class PhoneError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const USER = Object.freeze({ kind: 'user' });
const rid = (p) => p + crypto.randomBytes(6).toString('hex');

function nextText(conn, ms) {
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      conn.off('message', onMsg);
      conn.off('close', onClose);
    };
    const onMsg = (t) => { done(); resolve(t); };
    const onClose = () => { done(); reject(new PhoneHandshakeError('closed', 'the connection closed during the handshake')); };
    const timer = setTimeout(() => { done(); reject(new PhoneHandshakeError('timeout', 'the handshake took too long')); }, ms);
    conn.on('message', onMsg);
    conn.on('close', onClose);
  });
}

const userOnly = (origin) => {
  if (!origin || origin.kind !== 'user') throw new PhoneError('forbidden', 'only the person at this computer can do that');
};

/** The computer's name for the phones: the first usable name in the list, else "hivedesk". */
export function hostLabel(...names) {
  for (const n of names) {
    const s = typeof n === 'string' ? cleanName(n, '') : '';
    if (s) return s;
  }
  return 'hivedesk';
}

export class PhoneHub extends EventEmitter {
  /**
   * @param {{ home: string, run: (type: string, data: object) => Promise<any>, state: () => any,
   *   audit?: (entry: object) => any, hostName?: () => string, peerId?: () => string | null, now?: () => number,
   *   inviteMs?: number, sessionMs?: number, handshakesPerMinute?: number, idleMs?: number, decisionMs?: number, handshakeMs?: number, pageUrl?: string }} o
   */
  constructor(o) {
    super();
    this.home = o.home;
    this.run = o.run;
    this.getState = o.state;
    this.auditFn = o.audit || (() => null);
    const hostName = o.hostName || (() => null);
    // Every name the phones see goes through here: never null, empty or hidden characters.
    this.hostName = () => { try { return hostLabel(hostName()); } catch { return 'hivedesk'; } };
    this.peerId = o.peerId || (() => null);
    this.now = o.now || (() => Date.now());
    this.inviteMs = o.inviteMs ?? INVITE_MS;
    this.sessionMs = o.sessionMs ?? SESSION_MS;
    this.idleMs = o.idleMs ?? IDLE_MS;
    this.decisionMs = o.decisionMs ?? DECISION_MS;
    this.handshakeMs = o.handshakeMs ?? HANDSHAKE_MS;
    this.pageUrl = o.pageUrl || PAGE_URL;
    this.maxHandshakes = o.handshakesPerMinute ?? MAX_HANDSHAKES_PER_MINUTE;
    this.invites = new Map(); // topicId -> invite
    this.requests = new Map(); // requestId -> pair request
    this.sessions = new Map(); // sessionId -> rec
    this.rates = new Map();
    this.refused = new Map();
    this.handshakes = [];
    this.started = false;
  }

  async start() {
    if (this.started) return this;
    this.hostKey = await loadHostKey(this.home);
    this.store = new PhoneStore({ dir: path.join(this.home, 'phones') });
    this.homeTopic = await homeTopic(this.hostKey.publicRaw);
    this.timer = setInterval(() => this.sweep(), 1000);
    this.timer.unref?.();
    this.started = true;
    return this;
  }

  _audit(type, data = {}) {
    try {
      return this.auditFn({ type, ...data });
    } catch {
      return null;
    }
  }

  _changed() {
    this.emit('changed');
  }

  // ------------------------------------------------------------------ invites

  /** A new one time invite. Returns { inviteId, url, expiresAt, rendezvous: { topic, seal } }; the psk never leaves. */
  async createInvite(origin = USER) {
    userOnly(origin);
    for (const [id, inv] of this.invites) if (inv.used || this.now() >= inv.expiresAt) this.invites.delete(id);
    if (this.invites.size >= MAX_INVITES) {
      const oldest = [...this.invites.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
      this.invites.delete(oldest.topicId);
    }
    const secret = randomBytes(32);
    const d = await deriveInvite(secret);
    const inv = { id: rid('pi_'), topicId: d.topicId, psk: d.psk, createdAt: this.now(), expiresAt: this.now() + this.inviteMs, used: false };
    this.invites.set(d.topicId, inv);
    this._audit('phone.invite.created', { inviteId: inv.id, expiresAt: new Date(inv.expiresAt).toISOString() });
    this._changed();
    const url = inviteLink(secret, this.hostKey.pin, this.pageUrl);
    secret.fill(0);
    return { inviteId: inv.id, url, expiresAt: new Date(inv.expiresAt).toISOString(), rendezvous: { topic: d.topic, seal: b64u(d.seal) } };
  }

  cancelInvite(inviteId, origin = USER) {
    userOnly(origin);
    for (const [k, inv] of this.invites) if (inv.id === inviteId) {
      this.invites.delete(k);
      this._audit('phone.invite.cancelled', { inviteId });
      this._changed();
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------------ connections

  /** Takes a connection from the window's pipe: a pairing (ph.1) or a known phone (pk.1). */
  async accept(conn) {
    const t = this.now();
    this.handshakes = this.handshakes.filter((x) => x > t - 60_000);
    if (this.handshakes.length >= this.maxHandshakes) {
      this._auditRefused('handshake', 'rate_limited');
      conn.send(failMessage('busy'));
      conn.close('too many handshakes');
      return null;
    }
    this.handshakes.push(t);
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
    if (first.t === 'ph.1') return this._pair(conn, text, first);
    if (first.t === 'pk.1') return this._known(conn, text);
    conn.send(failMessage('protocol'));
    conn.close('bad handshake');
    return null;
  }

  async _pair(conn, m1, first) {
    const inv = this.invites.get(typeof first.inv === 'string' ? first.inv : '');
    let code = null;
    if (!inv) code = 'unknown';
    else if (inv.used) code = 'used';
    else if (this.now() >= inv.expiresAt) code = 'expired';
    if (code) {
      this._audit('phone.invite.refused', { inviteId: inv?.id, reason: code });
      conn.send(failMessage(code));
      conn.close(`invite ${code}`);
      return null;
    }
    // Single use: the first handshake that names the invite burns it, whatever happens next.
    inv.used = true;
    this._audit('phone.invite.used', { inviteId: inv.id });
    this.emit('invite.used', { inviteId: inv.id });
    this._changed();
    const hs = new PairHost({ hostKey: this.hostKey, invite: { topicId: inv.topicId, psk: inv.psk }, hostName: this.hostName(), peerId: this.peerId() || undefined });
    let r;
    try {
      conn.send(await hs.onM1(m1));
      r = await hs.onM3(await nextText(conn, this.handshakeMs));
    } catch (err) {
      this._audit('phone.pair.failed', { inviteId: inv.id, reason: err.code || 'failed' });
      conn.send(failMessage(err.code === 'timeout' ? 'timeout' : 'bad'));
      conn.close('handshake failed');
      return null;
    } finally {
      inv.psk.fill(0);
      this.invites.delete(inv.topicId);
    }
    const rec = this._openSession(conn, r, { deviceId: r.device.deviceId, accepted: false, confirmed: true });
    rec.session.send('ping', {});
    const req = { id: rid('pr_'), sessionId: rec.id, device: r.device, sas: r.sas, reconnect: r.reconnect, createdAt: this.now(), expiresAt: this.now() + this.decisionMs };
    rec.pairRequest = req.id;
    this.requests.set(req.id, req);
    this._audit('phone.pair.requested', { requestId: req.id, deviceId: r.device.deviceId, name: r.device.name, alg: r.device.alg, repair: !!this.store.get(r.device.deviceId) });
    this.emit('pair.request', this.pairDialog(req));
    this._changed();
    return rec;
  }

  /** What the accept dialog shows: the device, the six words to compare, and the grants (status on, the rest off). */
  pairDialog(req) {
    const known = this.store.get(req.device.deviceId);
    return {
      requestId: req.id,
      device: { deviceId: req.device.deviceId, name: req.device.name, alg: req.device.alg, words: req.device.words, pairedBefore: !!known },
      sas: req.sas,
      grants: known ? { ...known.grants } : cleanGrants({ 'phone.status': true }),
      expiresAt: new Date(req.expiresAt).toISOString()
    };
  }

  pairRequests() {
    return [...this.requests.values()].map((r) => this.pairDialog(r));
  }

  /** The person's answer. Accept needs sasMatches: true, the statement that the six words match on the phone. */
  answerPair(requestId, { accept, sasMatches, grants } = {}, origin = USER) {
    userOnly(origin);
    const req = this.requests.get(String(requestId || ''));
    if (!req) throw new PhoneError('not_found', 'no such pairing request (it may have expired)');
    if (accept && sasMatches !== true) throw new PhoneError('sas_unconfirmed', 'compare the six words with the phone first');
    this.requests.delete(req.id);
    const rec = this.sessions.get(req.sessionId);
    if (!rec || rec.session.state !== 'open') {
      this._audit('phone.pair.lost', { requestId: req.id, deviceId: req.device.deviceId });
      req.reconnect.fill(0);
      this._changed();
      throw new PhoneError('not_found', 'the phone is gone');
    }
    rec.pairRequest = null;
    if (!accept) {
      const reason = sasMatches === false ? 'sas_mismatch' : 'refused';
      rec.session.send('pair.refuse', { reason });
      this._audit('phone.pair.refused', { requestId: req.id, deviceId: req.device.deviceId, reason });
      this.emit('pair.decided', { requestId: req.id, accepted: false });
      req.reconnect.fill(0);
      setImmediate(() => rec.session.close(reason));
      this._changed();
      return { accepted: false };
    }
    const g = cleanGrants(grants);
    const now = new Date(this.now()).toISOString();
    const phone = this.store.save({
      deviceId: req.device.deviceId, alg: req.device.alg, publicKey: req.device.publicKey, name: req.device.name, words: req.device.words,
      pairedAt: now, lastSeen: now, grants: g, reconnect: b64u(req.reconnect)
    });
    req.reconnect.fill(0);
    this._audit('phone.pair.accepted', { requestId: req.id, deviceId: phone.deviceId, name: phone.name, sas: true, grants: grantList(g) });
    rec.session.send('pair.accept', { deviceId: phone.deviceId, grants: grantList(g), host: { name: this.hostName() } });
    this._welcome(rec);
    this.emit('pair.decided', { requestId: req.id, accepted: true, deviceId: phone.deviceId });
    this._changed();
    return { accepted: true, deviceId: phone.deviceId, grants: grantList(g) };
  }

  async _known(conn, m1) {
    const hs = new KnownHost({
      hostKey: this.hostKey,
      pin: this.hostKey.pin,
      lookup: (id) => {
        const p = this.store.get(id);
        return p ? { alg: p.alg, publicKey: p.publicKey, reconnect: fromB64u(p.reconnect, 32) } : null;
      }
    });
    let out;
    try {
      out = await hs.onM1(m1);
    } catch (err) {
      this._audit('phone.reconnect.refused', { reason: err.code || 'failed' });
      conn.send(failMessage(err.code === 'unknown_phone' ? 'unknown_phone' : 'bad'));
      conn.close('handshake failed');
      return null;
    }
    conn.send(out.m2);
    const rec = this._openSession(conn, out.result, { deviceId: out.result.deviceId, accepted: false, confirmed: false });
    const timer = setTimeout(() => rec.session.state === 'open' && !rec.session.confirmed && rec.session.close('not confirmed'), this.handshakeMs);
    timer.unref?.();
    rec.session.on('confirmed', () => {
      clearTimeout(timer);
      if (!this.store.get(rec.deviceId)) return rec.session.close('revoked');
      this._welcome(rec);
    });
    return rec;
  }

  // ------------------------------------------------------------------ sessions

  _openSession(conn, r, { deviceId, accepted, confirmed }) {
    const rec = { id: r.sessionId, deviceId, conn, accepted, notify: false, openedAt: this.now(), expiresAt: this.now() + this.sessionMs, lastIn: this.now(), pushTimer: null, feedQueue: [] };
    rec.session = new FrameSession({ id: r.sessionId, side: 'desktop', sendKey: r.sendKey, recvKey: r.recvKey, write: (t) => conn.send(t), now: this.now, confirmed });
    conn.on('message', (t) => rec.session.receive(t));
    conn.on('close', (reason) => rec.session._closed(reason || 'transport closed'));
    rec.session.on('message', (msg) => this._onMessage(rec, msg));
    rec.session.on('close', (reason) => this._sessionClosed(rec, reason));
    this.sessions.set(rec.id, rec);
    return rec;
  }

  _welcome(rec) {
    const phone = this.store.get(rec.deviceId);
    if (!phone) return rec.session.close('revoked');
    for (const other of this.sessions.values()) if (other !== rec && other.deviceId === rec.deviceId && other.accepted) other.session.close('replaced by a new session');
    rec.accepted = true;
    rec.openedAt = this.now();
    rec.expiresAt = this.now() + this.sessionMs;
    this.store.touch(rec.deviceId, this.now());
    rec.session.send('welcome', {
      deviceId: phone.deviceId, name: phone.name, host: { name: this.hostName(), peerId: this.peerId() || undefined },
      grants: grantList(phone.grants), expiresAt: rec.expiresAt, idleMs: this.idleMs
    });
    this._audit('phone.session.open', { deviceId: rec.deviceId, sessionId: rec.id, expiresAt: new Date(rec.expiresAt).toISOString() });
    if (phone.grants['phone.status']) this._pushState(rec);
    this.emit('session', 'open', rec);
    this._changed();
  }

  _sessionClosed(rec, reason) {
    if (!this.sessions.has(rec.id)) return;
    this.sessions.delete(rec.id);
    clearTimeout(rec.pushTimer);
    try { rec.conn.close(String(reason).slice(0, 80)); } catch { /* gone */ }
    if (rec.pairRequest && this.requests.has(rec.pairRequest)) {
      const req = this.requests.get(rec.pairRequest);
      this.requests.delete(rec.pairRequest);
      req.reconnect.fill(0);
      this.emit('pair.gone', { requestId: rec.pairRequest });
    }
    if (rec.accepted) {
      this._audit('phone.session.close', { deviceId: rec.deviceId, sessionId: rec.id, reason: String(reason).slice(0, 80) });
      this.emit('session', 'close', rec);
    }
    this._changed();
  }

  sessionsOf(deviceId) {
    return [...this.sessions.values()].filter((r) => r.deviceId === deviceId && r.accepted && r.session.state === 'open');
  }

  _rateOk(key, [count, windowMs]) {
    const t = this.now();
    const hits = (this.rates.get(key) || []).filter((x) => x > t - windowMs);
    const ok = hits.length < count;
    if (ok) hits.push(t);
    this.rates.set(key, hits);
    return ok;
  }

  _auditRefused(what, code, deviceId) {
    const key = `${deviceId || '-'}|${what}|${code}`;
    const last = this.refused.get(key) || 0;
    if (this.now() - last < 10_000) return;
    this.refused.set(key, this.now());
    this._audit('phone.refused', { deviceId, what, code });
  }

  _onMessage(rec, msg) {
    rec.lastIn = this.now();
    const s = rec.session;
    if (msg.t === 'ping') return s.send('pong', {}, { re: msg.id });
    if (msg.t === 'pong' || msg.t === 'error') return;
    if (!rec.accepted) {
      if (msg.id) s.send('error', { code: 'not_accepted', message: 'the computer has not accepted this phone yet' }, { re: msg.id });
      return;
    }
    if (this.now() >= rec.expiresAt) return s.close('expired');
    const phone = this.store.get(rec.deviceId);
    if (!phone) return s.close('revoked');
    if (msg.t === 'cmd') return this._command(rec, phone, msg);
    // remote desktop: cap.request and remote.*; the port (port.js) and src/remote/ check the rest
    if (!phone.grants['phone.remote']) {
      this._auditRefused(msg.t, 'not_granted', rec.deviceId);
      if (msg.id) s.send('error', { code: 'not_granted', message: 'remote desktop is not allowed for this phone' }, { re: msg.id });
      return;
    }
    this.emit('remote.message', rec, msg);
  }

  async _command(rec, phone, msg) {
    const { op, a } = msg.body;
    const reply = (body) => rec.session.state === 'open' && rec.session.send('cmd.re', body, { re: msg.id });
    const spec = OPS[op];
    if (!spec) {
      this._auditRefused(`cmd:${String(op).slice(0, 40)}`, 'unknown_op', rec.deviceId);
      return reply({ ok: false, error: { code: 'bad_request', message: 'unknown command' } });
    }
    if (!phone.grants[spec.grant]) {
      this._auditRefused(op, 'not_granted', rec.deviceId);
      return reply({ ok: false, error: { code: 'not_granted', message: `${op} needs ${spec.grant}`, grant: spec.grant } });
    }
    if (!this._rateOk(`${rec.deviceId}|${op}`, spec.rate) || !this._rateOk(`${rec.deviceId}|*`, [60, 10_000])) {
      this._auditRefused(op, 'rate_limited', rec.deviceId);
      return reply({ ok: false, error: { code: 'rate_limited', message: 'too many commands, wait a few seconds' } });
    }
    try {
      const result = await this._run(op, a || {}, rec, phone);
      if (op !== 'state.get' && op !== 'chat.log' && op !== 'approval.get') this._audit('phone.cmd', { deviceId: rec.deviceId, op, ok: true, ...this._auditArgs(op, a) });
      reply({ ok: true, result: result ?? {} });
    } catch (err) {
      const code = typeof err?.code === 'string' && /^[a-z_]{2,40}$/.test(err.code) ? err.code : 'failed';
      this._audit('phone.cmd', { deviceId: rec.deviceId, op, ok: false, code, ...this._auditArgs(op, a) });
      reply({ ok: false, error: { code, message: String(err?.message || err).slice(0, 300) } });
    }
  }

  /** Ids only in the audit log, never request or chat text. */
  _auditArgs(op, a = {}) {
    const pick = (k) => (typeof a[k] === 'string' ? a[k].slice(0, 80) : undefined);
    if (op === 'approval.resolve') return { approvalId: pick('approvalId'), approved: a.approved === true };
    if (op === 'job.cancel' || op === 'brief.approve') return { jobId: pick('jobId') };
    if (op === 'worker.pause' || op === 'worker.resume') return { workerId: pick('workerId') };
    if (op === 'chat.send') return { channel: pick('channel') || 'general', chars: typeof a.text === 'string' ? a.text.length : 0 };
    if (op === 'job.create') return { chars: typeof a.request === 'string' ? a.request.length : 0 };
    if (op === 'notify.set') return { on: a.on === true };
    return {};
  }

  async _run(op, a, rec, phone) {
    const state = this.getState() || {};
    const str = (v, max, what) => {
      if (typeof v !== 'string' || !v.trim()) throw new PhoneError('bad_request', `${what} is required`);
      return v.trim().slice(0, max);
    };
    const worker = (id) => {
      const w = (state.crew || []).find((x) => x.id === id);
      if (!w) throw new PhoneError('not_found', 'no such worker');
      return w.id;
    };
    switch (op) {
      case 'state.get':
        return statusView(state, phone.grants);
      case 'job.create':
        return this.run('job.create', { request: str(a.request, 4000, 'request') });
      case 'brief.approve': {
        const use = ['refined', 'edited', 'original'].includes(a.use) ? a.use : 'refined';
        return this.run('brief.approve', { jobId: str(a.jobId, 40, 'jobId'), use, ...(use === 'edited' ? { text: str(a.text, 8000, 'text') } : {}) });
      }
      case 'chat.send': {
        const channel = a.channel === undefined || a.channel === 'general' ? 'general' : `dm:${worker(String(a.channel).replace(/^dm:/, ''))}`;
        // phone.crew also lets the phone start jobs (job.create): a request typed in the chat starts one too, in the phone's language.
        return this.run('chat.send', { channel, text: str(a.text, 2000, 'text'), jobs: true, ...(typeof a.lang === 'string' && /^[a-zA-Z-]{2,10}$/.test(a.lang) ? { lang: a.lang } : {}) });
      }
      case 'chat.log':
        return chatView(state, typeof a.channel === 'string' ? a.channel : 'general');
      case 'approval.get': {
        const ap = (state.approvals || []).find((x) => x.id === a.approvalId);
        if (!ap) throw new PhoneError('not_found', 'that approval is no longer pending');
        return approvalCard(ap, state);
      }
      case 'approval.resolve': {
        const id = str(a.approvalId, 80, 'approvalId');
        const ap = (state.approvals || []).find((x) => x.id === id);
        if (!ap) throw new PhoneError('not_found', 'that approval is no longer pending');
        const approved = a.approved === true;
        // Output of a model on another machine: its actions need the person at this computer (SEC-3).
        if (approved && (ap.strict || ap.origin || ap.remoteOrigin)) throw new PhoneError('forbidden', 'actions proposed by a model on another machine are approved at the computer');
        const note = typeof a.note === 'string' && a.note.trim() ? a.note.trim().slice(0, 300) : `${approved ? 'approved' : 'rejected'} from the phone ${phone.name}`;
        return this.run('approval.resolve', { approvalId: id, approved, note });
      }
      case 'worker.pause':
      case 'worker.resume':
        await this.run('crew.update', { workerId: worker(a.workerId), paused: op === 'worker.pause' });
        return { workerId: a.workerId, paused: op === 'worker.pause' };
      case 'job.cancel':
        return this.run('job.cancel', { jobId: str(a.jobId, 40, 'jobId') });
      case 'notify.set':
        rec.notify = a.on === true;
        return { on: rec.notify };
      default:
        throw new PhoneError('bad_request', 'unknown command');
    }
  }

  // ------------------------------------------------------------------ live

  /** Every engine event: feed lines, snapshot refreshes and notices for the phones allowed to see them. */
  onEvent(e) {
    if (!e || typeof e.type !== 'string') return;
    const item = feedItem(e);
    const snap = SNAPSHOT_EVENTS.has(e.type) || e.type.startsWith('city.');
    let notice;
    for (const rec of this.sessions.values()) {
      if (!rec.accepted || rec.session.state !== 'open') continue;
      const phone = this.store.get(rec.deviceId);
      if (!phone) continue;
      if (phone.grants['phone.status']) {
        if (item) this._queueFeed(rec, item);
        if (snap) this._schedulePush(rec);
      }
      if (rec.notify && phone.grants['phone.notify']) {
        if (notice === undefined) notice = noticeOf(e, this.getState() || {});
        if (notice) rec.session.send('notice', notice);
      }
    }
  }

  _queueFeed(rec, item) {
    rec.feedQueue.push(item);
    if (rec.feedQueue.length === 1) queueMicrotask(() => {
      const items = rec.feedQueue.splice(0, 50);
      rec.feedQueue.length = 0;
      if (items.length && rec.session.state === 'open') rec.session.send('feed', { items });
    });
  }

  _schedulePush(rec) {
    if (rec.pushTimer) return;
    rec.pushTimer = setTimeout(() => {
      rec.pushTimer = null;
      this._pushState(rec);
    }, 250);
    rec.pushTimer.unref?.();
  }

  _pushState(rec) {
    const phone = this.store.get(rec.deviceId);
    if (!phone || !phone.grants['phone.status'] || rec.session.state !== 'open') return;
    try {
      rec.session.send('state', statusView(this.getState() || {}, phone.grants));
    } catch { /* closing */ }
  }

  // ------------------------------------------------------------------ phones

  /** The paired phones for the desktop window (no secrets). */
  phones() {
    return this.store.list().map((p) => publicRecord(p, this.sessionsOf(p.deviceId).length > 0));
  }

  setGrants(deviceId, grants, origin = USER) {
    userOnly(origin);
    const p = this.store.get(String(deviceId || ''));
    if (!p) throw new PhoneError('not_found', 'no such phone');
    const before = p.grants;
    const next = cleanGrants({ ...before, ...Object.fromEntries(Object.entries(grants || {}).filter(([k]) => GRANT_NAMES.includes(k))) });
    const saved = this.store.save({ ...p, grants: next });
    this._audit('phone.grants', { deviceId: p.deviceId, grants: grantList(next) });
    for (const rec of this.sessionsOf(p.deviceId)) {
      rec.session.send('grants', { grants: grantList(next) });
      if (next['phone.status']) this._pushState(rec);
      if (!next['phone.notify']) rec.notify = false;
    }
    if (before['phone.remote'] && !next['phone.remote']) this.emit('remote.off', p.deviceId);
    this._changed();
    return publicRecord(saved, this.sessionsOf(p.deviceId).length > 0);
  }

  /** Removes a phone at once: its file, its sessions and its remote grants. It needs a new QR code to come back. */
  revoke(deviceId, origin = USER) {
    userOnly(origin);
    const id = String(deviceId || '');
    const had = this.store.remove(id);
    if (!had) throw new PhoneError('not_found', 'no such phone');
    this.emit('remote.off', id);
    for (const rec of [...this.sessions.values()]) if (rec.deviceId === id) rec.session.close('revoked');
    this._audit('phone.revoked', { deviceId: id });
    this._changed();
    return { revoked: true };
  }

  /** For the window's listener on the home topic: one seal key per paired phone (never the reconnect secret). */
  async listenKeys() {
    const keys = [];
    for (const p of this.store.list()) keys.push({ deviceId: p.deviceId, seal: b64u(await homeSeal(fromB64u(p.reconnect, 32))) });
    return { topic: this.homeTopic, keys };
  }

  // ------------------------------------------------------------------ time

  sweep() {
    const now = this.now();
    for (const [k, inv] of this.invites) if (now >= inv.expiresAt) {
      this.invites.delete(k);
      inv.psk.fill(0);
      this._audit('phone.invite.expired', { inviteId: inv.id });
      this.emit('invite.expired', { inviteId: inv.id });
      this._changed();
    }
    for (const req of [...this.requests.values()]) if (now >= req.expiresAt) {
      try {
        this.answerPair(req.id, { accept: false, reason: 'timeout' }, USER);
      } catch {
        this.requests.delete(req.id);
      }
    }
    for (const rec of [...this.sessions.values()]) {
      if (rec.session.state !== 'open') continue;
      if (rec.accepted && now >= rec.expiresAt) rec.session.close('expired');
      else if (now - rec.lastIn > this.idleMs) rec.session.close('idle');
    }
  }

  async close() {
    clearInterval(this.timer);
    for (const rec of [...this.sessions.values()]) rec.session.close('engine stopping');
    for (const inv of this.invites.values()) inv.psk.fill(0);
    this.invites.clear();
    this.started = false;
  }
}

export { USER };
