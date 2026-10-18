// The two handshakes of PLAN 3.3, as small state machines that take and return message text.
// They do no I/O, so tests can tamper with every message; node.js drives them over a transport.
//
// Invite (guest G joins host H with the six words):
//   hs.1  G -> H  { v: 2, inv: topic, e: eG, n: nG }
//   hs.2  H -> G  { e: eH, n: nH, box: AEAD_k1({ id: idH, sig: sigH, offeredCaps, hostName }) }
//         k1   = HKDF(X25519(eH, eG) || psk, salt = T(m1, eH, nH), "hivedesk v2 k1")
//         sigH = Ed25519(idH, "hivedesk v2 host" || T(m1, eH, nH, pkH, offeredCaps, hostName))
//   hs.3  G -> H  { box: AEAD_k2({ id: idG, sig: sigG, name, requestedCaps }) }
//         k2   = HKDF(k1, salt = T(m1, m2), "hivedesk v2 k2")
//         sigG = Ed25519(idG, "hivedesk v2 guest" || T(T(m1, m2), pkG, requestedCaps, name))
//   both: th3 = T(T(m1, m2), m3); sas = six words of sha256("hivedesk v2 sas", th3, pkH, pkG)
//         kHG, kGH = HKDF(k2, salt = th3, "hivedesk v2 session h>g" / "g>h")
// Known peer reconnect (initiator I, responder R, both already know each other's key):
//   hs.k1 I -> R  { v: 2, e: eI, n: nI, from: idI, to: peerIdR, sig: Ed25519(idI, "hivedesk v2 known init" || T(eI, nI, pkI, to)) }
//   hs.k2 R -> I  { e: eR, n: nR, box: AEAD_k({ publicKey: pkR, sig: Ed25519(idR, "hivedesk v2 known resp" || T(m1, eR, nR)) }) }
//         k = HKDF(X25519(eR, eI), salt = T(m1, eR, nR), "hivedesk v2 known k")
//         kIR, kRI = HKDF(k, salt = T(m1, m2), "hivedesk v2 session i>r" / "r>i")
// T(...) is SHA-256 over the parts, each prefixed with its 4 byte length, so no two different
// part lists hash alike. Messages are hashed as the exact text that crossed the wire.
// Any failure is a HandshakeError; the host burns the invite on every failure.

import { wordsFromBytes } from '../../ui/lend/core/words.js';
import { b64u, base32, canonical, fromB64u } from './encoding.js';
import { equalBytes, hkdf, open, randomBytes, seal, sha256, verify, wipe, x25519, x25519Pair } from './primitives.js';
import { cleanName, publicIdentity, readPeerIdentity } from './identity.js';
import { normalizeCapList } from './caps.js';

export const HS_VERSION = 2;
export const MAX_HS_CHARS = 16 * 1024;

export class HandshakeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'HandshakeError';
    this.code = code;
  }
}

/** Length prefixed transcript hash. */
export function T(...parts) {
  const bufs = [];
  for (const p of parts) {
    const b = typeof p === 'string' ? Buffer.from(p, 'utf8') : Buffer.from(p);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(b.length);
    bufs.push(len, b);
  }
  return sha256(...bufs);
}

const NONCE_M2 = Buffer.from('hs2\0\0\0\0\0\0\0\0\0');
const NONCE_M3 = Buffer.from('hs3\0\0\0\0\0\0\0\0\0');
const NONCE_K2 = Buffer.from('hsk2\0\0\0\0\0\0\0\0');

export function parseHs(text, type) {
  if (typeof text !== 'string' || text.length > MAX_HS_CHARS) throw new HandshakeError('protocol', 'handshake message too large');
  let m;
  try {
    m = JSON.parse(text);
  } catch {
    throw new HandshakeError('protocol', 'handshake message is not JSON');
  }
  if (!m || typeof m !== 'object') throw new HandshakeError('protocol', 'not a handshake message');
  if (m.t === 'hs.fail') throw new HandshakeError(typeof m.code === 'string' ? m.code.slice(0, 30) : 'failed', 'the other side ended the handshake');
  if (type && m.t !== type) throw new HandshakeError('protocol', `expected ${type}`);
  return m;
}

const bytes = (v, n, what) => {
  try {
    return fromB64u(v, n);
  } catch {
    throw new HandshakeError('protocol', `bad ${what}`);
  }
};

const wireId = (id) => ({ peerId: id.peerId, publicKey: id.publicKey, name: id.name, createdAt: id.createdAt });

/** The short authentication string: six words both people compare. */
export function sasWords(th3, pkH, pkG) {
  return wordsFromBytes(sha256('hivedesk v2 sas', th3, pkH, pkG), 6);
}

export const sessionIdOf = (th) => 'ss_' + base32(sha256('hivedesk v2 session id', th)).slice(0, 16);

function readBox(key, nonce, aad, boxText) {
  let plain;
  try {
    plain = open(key, nonce, bytes(boxText, undefined, 'box'), aad);
  } catch (err) {
    if (err instanceof HandshakeError) throw err;
    throw new HandshakeError('words', 'the words did not work');
  }
  try {
    return JSON.parse(plain.toString('utf8'));
  } catch {
    throw new HandshakeError('protocol', 'box is not JSON');
  }
}

// ---------------------------------------------------------------- invite handshake

export class InviteGuest {
  /** @param {{ identity: any, invite: { topic: string, psk: Buffer }, name?: string, requestedCaps?: any[] }} o */
  constructor({ identity, invite, name, requestedCaps = [] }) {
    this.identity = identity;
    this.topic = invite.topic;
    this.psk = Buffer.from(invite.psk);
    this.name = cleanName(name ?? identity.name);
    this.requestedCaps = normalizeCapList(requestedCaps);
    this.state = 'new';
  }

  start() {
    if (this.state !== 'new') throw new HandshakeError('protocol', 'already started');
    this.e = x25519Pair();
    this.n = randomBytes(16);
    this.m1 = JSON.stringify({ t: 'hs.1', v: HS_VERSION, inv: this.topic, e: b64u(this.e.publicRaw), n: b64u(this.n) });
    this.state = 'sent1';
    return this.m1;
  }

  /** Reads hs.2 and returns { m3, result }. Throws HandshakeError('words') for wrong words. */
  onM2(m2) {
    if (this.state !== 'sent1') throw new HandshakeError('protocol', 'hs.2 out of order');
    this.state = 'failed';
    const msg = parseHs(m2, 'hs.2');
    const eH = bytes(msg.e, 32, 'key');
    const nH = bytes(msg.n, 16, 'nonce');
    const dh = x25519(this.e.privateKey, eH);
    const k1 = hkdf(Buffer.concat([dh, this.psk]), T(this.m1, eH, nH), 'hivedesk v2 k1', 32);
    wipe(dh, this.psk);
    const box = readBox(k1, NONCE_M2, 'hivedesk v2 m2', msg.box);
    let host;
    try {
      host = readPeerIdentity(box.id);
    } catch (err) {
      throw new HandshakeError('bad_identity', err.message);
    }
    const offeredCaps = normalizeCapList(box.offeredCaps);
    const hostName = cleanName(box.hostName, host.name);
    if (!verify(host.publicRaw, bytes(box.sig, 64, 'signature'), 'hivedesk v2 host', T(this.m1, eH, nH, host.publicRaw, canonical(offeredCaps), hostName))) {
      throw new HandshakeError('bad_signature', 'the host signature does not verify');
    }
    const th2 = T(this.m1, m2);
    const k2 = hkdf(k1, th2, 'hivedesk v2 k2', 32);
    wipe(k1);
    const pkG = this.identity.publicRaw;
    const inner = canonical({
      id: wireId(this.identity),
      sig: b64u(this.identity.sign('hivedesk v2 guest', T(th2, pkG, canonical(this.requestedCaps), this.name))),
      name: this.name,
      requestedCaps: this.requestedCaps,
    });
    const m3 = JSON.stringify({ t: 'hs.3', box: b64u(seal(k2, NONCE_M3, inner, 'hivedesk v2 m3')) });
    const th3 = T(th2, m3);
    const result = {
      sessionId: sessionIdOf(th3),
      sendKey: hkdf(k2, th3, 'hivedesk v2 session g>h', 32),
      recvKey: hkdf(k2, th3, 'hivedesk v2 session h>g', 32),
      sas: sasWords(th3, host.publicRaw, pkG),
      host,
      hostName,
      offeredCaps,
      role: 'guest',
    };
    wipe(k2);
    this.state = 'done';
    return { m3, result };
  }
}

export class InviteHost {
  /** @param {{ identity: any, invite: { topic: string, psk: Buffer, offeredCaps: any[] }, hostName?: string }} o */
  constructor({ identity, invite, hostName }) {
    this.identity = identity;
    this.invite = invite;
    this.hostName = cleanName(hostName ?? identity.name);
    this.state = 'new';
  }

  /** Reads hs.1 and returns hs.2. */
  onM1(m1) {
    if (this.state !== 'new') throw new HandshakeError('protocol', 'hs.1 out of order');
    this.state = 'failed';
    const msg = parseHs(m1, 'hs.1');
    if (msg.v !== HS_VERSION) throw new HandshakeError('version', `handshake version ${msg.v} is not supported`);
    const eG = bytes(msg.e, 32, 'key');
    bytes(msg.n, 16, 'nonce');
    this.m1 = m1;
    const e = x25519Pair();
    const nH = randomBytes(16);
    const dh = x25519(e.privateKey, eG);
    const k1 = hkdf(Buffer.concat([dh, this.invite.psk]), T(m1, e.publicRaw, nH), 'hivedesk v2 k1', 32);
    wipe(dh);
    const offeredCaps = normalizeCapList(this.invite.offeredCaps);
    const inner = canonical({
      id: wireId(this.identity),
      sig: b64u(this.identity.sign('hivedesk v2 host', T(m1, e.publicRaw, nH, this.identity.publicRaw, canonical(offeredCaps), this.hostName))),
      offeredCaps,
      hostName: this.hostName,
    });
    this.m2 = JSON.stringify({ t: 'hs.2', e: b64u(e.publicRaw), n: b64u(nH), box: b64u(seal(k1, NONCE_M2, inner, 'hivedesk v2 m2')) });
    this.k2 = hkdf(k1, T(m1, this.m2), 'hivedesk v2 k2', 32);
    wipe(k1);
    this.state = 'sent2';
    return this.m2;
  }

  /** Reads hs.3 and returns the result. Throws HandshakeError('words') for a guest without the words. */
  onM3(m3) {
    if (this.state !== 'sent2') throw new HandshakeError('protocol', 'hs.3 out of order');
    this.state = 'failed';
    const msg = parseHs(m3, 'hs.3');
    const th2 = T(this.m1, this.m2);
    const box = readBox(this.k2, NONCE_M3, 'hivedesk v2 m3', msg.box);
    let guest;
    try {
      guest = readPeerIdentity(box.id);
    } catch (err) {
      throw new HandshakeError('bad_identity', err.message);
    }
    if (guest.peerId === this.identity.peerId) throw new HandshakeError('bad_identity', 'a peer cannot join itself');
    const requestedCaps = normalizeCapList(box.requestedCaps);
    const name = cleanName(box.name, guest.name);
    if (!verify(guest.publicRaw, bytes(box.sig, 64, 'signature'), 'hivedesk v2 guest', T(th2, guest.publicRaw, canonical(requestedCaps), name))) {
      throw new HandshakeError('bad_signature', 'the guest signature does not verify');
    }
    const th3 = T(th2, m3);
    const result = {
      sessionId: sessionIdOf(th3),
      sendKey: hkdf(this.k2, th3, 'hivedesk v2 session h>g', 32),
      recvKey: hkdf(this.k2, th3, 'hivedesk v2 session g>h', 32),
      sas: sasWords(th3, this.identity.publicRaw, guest.publicRaw),
      guest: { ...guest, name },
      name,
      requestedCaps,
      role: 'host',
    };
    wipe(this.k2);
    this.state = 'done';
    return result;
  }
}

// ---------------------------------------------------------------- known peer reconnect

export class KnownInitiator {
  /** @param {{ identity: any, peer: { peerId: string, publicRaw: Buffer } }} o */
  constructor({ identity, peer }) {
    this.identity = identity;
    this.peer = peer;
    this.state = 'new';
  }

  start() {
    this.e = x25519Pair();
    this.n = randomBytes(16);
    const sig = this.identity.sign('hivedesk v2 known init', T(this.e.publicRaw, this.n, this.identity.publicRaw, this.peer.peerId));
    this.m1 = JSON.stringify({ t: 'hs.k1', v: HS_VERSION, e: b64u(this.e.publicRaw), n: b64u(this.n), from: wireId(this.identity), to: this.peer.peerId, sig: b64u(sig) });
    this.state = 'sent1';
    return this.m1;
  }

  onM2(m2) {
    if (this.state !== 'sent1') throw new HandshakeError('protocol', 'hs.k2 out of order');
    this.state = 'failed';
    const msg = parseHs(m2, 'hs.k2');
    const eR = bytes(msg.e, 32, 'key');
    const nR = bytes(msg.n, 16, 'nonce');
    const dh = x25519(this.e.privateKey, eR);
    const salt = T(this.m1, eR, nR);
    const k = hkdf(dh, salt, 'hivedesk v2 known k', 32);
    wipe(dh);
    let box;
    try {
      box = readBox(k, NONCE_K2, 'hivedesk v2 known m2', msg.box);
    } catch (err) {
      throw new HandshakeError('bad_box', err.message);
    }
    if (!equalBytes(bytes(box.publicKey, 32, 'key'), this.peer.publicRaw)) throw new HandshakeError('identity_changed', 'the peer answered with another key');
    if (!verify(this.peer.publicRaw, bytes(box.sig, 64, 'signature'), 'hivedesk v2 known resp', salt)) throw new HandshakeError('bad_signature', 'the peer signature does not verify');
    const th = T(this.m1, m2);
    const result = { sessionId: sessionIdOf(th), sendKey: hkdf(k, th, 'hivedesk v2 session i>r', 32), recvKey: hkdf(k, th, 'hivedesk v2 session r>i', 32), peerId: this.peer.peerId };
    wipe(k);
    this.state = 'done';
    return result;
  }
}

export class KnownResponder {
  /**
   * lookup(peerId) returns { publicRaw, trust } of a stored peer or null.
   * @param {{ identity: any, lookup: (peerId: string) => any }} o
   */
  constructor({ identity, lookup }) {
    this.identity = identity;
    this.lookup = lookup;
  }

  /** Reads hs.k1 and returns { m2, result }. The session stays unconfirmed until a frame from I opens. */
  onM1(m1) {
    const msg = parseHs(m1, 'hs.k1');
    if (msg.v !== HS_VERSION) throw new HandshakeError('version', `handshake version ${msg.v} is not supported`);
    let from;
    try {
      from = readPeerIdentity(msg.from);
    } catch (err) {
      throw new HandshakeError('bad_identity', err.message);
    }
    if (msg.to !== this.identity.peerId) throw new HandshakeError('wrong_peer', 'this hello is for another peer');
    const known = this.lookup(from.peerId);
    if (!known) throw new HandshakeError('unknown_peer', 'not a known peer; use an invite');
    if (known.trust === 'blocked') throw new HandshakeError('blocked', 'this peer is blocked');
    if (known.trust !== 'known') throw new HandshakeError('unknown_peer', 'this peer was never accepted');
    if (!equalBytes(known.publicRaw, from.publicRaw)) throw new HandshakeError('identity_changed', 'stored key differs');
    const eI = bytes(msg.e, 32, 'key');
    const nI = bytes(msg.n, 16, 'nonce');
    if (!verify(from.publicRaw, bytes(msg.sig, 64, 'signature'), 'hivedesk v2 known init', T(eI, nI, from.publicRaw, this.identity.peerId))) {
      throw new HandshakeError('bad_signature', 'the hello signature does not verify');
    }
    const e = x25519Pair();
    const nR = randomBytes(16);
    const dh = x25519(e.privateKey, eI);
    const salt = T(m1, e.publicRaw, nR);
    const k = hkdf(dh, salt, 'hivedesk v2 known k', 32);
    wipe(dh);
    const inner = canonical({ publicKey: this.identity.publicKey, sig: b64u(this.identity.sign('hivedesk v2 known resp', salt)) });
    const m2 = JSON.stringify({ t: 'hs.k2', e: b64u(e.publicRaw), n: b64u(nR), box: b64u(seal(k, NONCE_K2, inner, 'hivedesk v2 known m2')) });
    const th = T(m1, m2);
    const result = { sessionId: sessionIdOf(th), sendKey: hkdf(k, th, 'hivedesk v2 session r>i', 32), recvKey: hkdf(k, th, 'hivedesk v2 session i>r', 32), peer: from };
    wipe(k);
    return { m2, result };
  }
}

export const failMessage = (code) => JSON.stringify({ t: 'hs.fail', code });
export { publicIdentity };
