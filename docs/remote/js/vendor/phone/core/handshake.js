// Copied from ui/phone/core/handshake.js by scripts/phone-page.mjs. Edit the source, then run the script.
// The phone handshakes (docs/1.0/protocol/phone.md section 3). They follow the Stream 2 handshake of
// PLAN 3.3 step by step (ephemeral DH plus a pre shared key, signed identities, a transcript, six SAS
// words, an explicit Accept on the desktop), on the primitives every phone browser has: ECDH P-256,
// AES-256-GCM, and Ed25519 or ECDSA P-256 signatures. Like src/p2p/handshake.js they do no I/O.
//
// Pairing (phone G scanned the QR of desktop H):
//   ph.1  G -> H  { v: 1, inv: topicId, e: eG, n: nG }
//   ph.2  H -> G  { e: eH, n: nH, box: AEAD_k1({ key: pkH, sig: sigH, name, peerId }) }
//         k1   = HKDF(ECDH(eH, eG) || psk, salt = T(m1, eH, nH), "hivedesk phone v1 k1")
//         sigH = ECDSA(H, "hivedesk phone v1 host" || T(m1, eH, nH, pkH, name))      G checks pin(pkH) from the QR
//   ph.3  G -> H  { box: AEAD_k2({ alg, key: pkG, sig: sigG, name }) }
//         k2   = HKDF(k1, salt = T(m1, m2), "hivedesk phone v1 k2")
//         sigG = Sign(G, "hivedesk phone v1 phone" || T(T(m1, m2), alg, pkG, name))
//   both: th3 = T(T(m1, m2), m3); sas = six words of SHA-256("hivedesk phone v1 sas", th3, pkH, pkG)
//         kGH, kHG = HKDF(k2, salt = th3, "hivedesk phone v1 session g>h" / "h>g")
//         reconnect secret r = HKDF(k2, salt = th3, "hivedesk phone v1 reconnect")
// Known phone (no QR):
//   pk.1  G -> H  { v: 1, e, n, from: { alg, key, id }, to: pin, sig: Sign(G, "hivedesk phone v1 known init" || T(e, n, alg, pkG, pin)) }
//   pk.2  H -> G  { e, n, box: AEAD_k({ sig: ECDSA(H, "hivedesk phone v1 known resp" || T(m1, eH, nH)) }) }
//         k = HKDF(ECDH(eH, eG) || r, salt = T(m1, eH, nH), "hivedesk phone v1 known k")
//         kGH, kHG = HKDF(k, salt = T(m1, m2), "hivedesk phone v1 session g>h" / "h>g")
// The desktop's session of a known phone stays unconfirmed until a frame from the phone opens.

import { wordsFromBytes } from '../../lend/core/words.js';
import {
  b64u, fromB64u, base32, sha256, T, hkdf, seal, open, ecdhPair, ecdh, signWith, verifyWith, checkPublicKey,
  deviceIdOf, hostPin, isAlg, equalBytes, concatBytes, randomBytes, utf8, PhoneCryptoError
} from './crypto.js';

export const HS_VERSION = 1;
export const MAX_HS_CHARS = 8 * 1024;
export const NAME_MAX = 40;

export class PhoneHandshakeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PhoneHandshakeError';
    this.code = code;
  }
}

const NONCE_M2 = Uint8Array.of(0x70, 0x68, 0x32, 0, 0, 0, 0, 0, 0, 0, 0, 0);
const NONCE_M3 = Uint8Array.of(0x70, 0x68, 0x33, 0, 0, 0, 0, 0, 0, 0, 0, 0);
const NONCE_K2 = Uint8Array.of(0x70, 0x6b, 0x32, 0, 0, 0, 0, 0, 0, 0, 0, 0);

// Control characters, zero width marks and bidi overrides, which could disguise a device name.
const HIDDEN = new RegExp('[' + [[0x00, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2066, 0x2069]].map(([a, z]) => String.fromCharCode(a) + '-' + String.fromCharCode(z)).join('') + ']', 'g');

/** Display names: printable, trimmed, at most 40 characters. Display only, never trusted. */
export function cleanName(name, fallback = 'Phone') {
  const s = String(name ?? '').replace(HIDDEN, '').trim().slice(0, NAME_MAX);
  return s || fallback;
}

/** JSON with sorted keys, for everything that is sealed or signed. */
export function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
}

export function parseHs(text, type) {
  if (typeof text !== 'string' || text.length > MAX_HS_CHARS) throw new PhoneHandshakeError('protocol', 'handshake message too large');
  let m;
  try {
    m = JSON.parse(text);
  } catch {
    throw new PhoneHandshakeError('protocol', 'handshake message is not JSON');
  }
  if (!m || typeof m !== 'object') throw new PhoneHandshakeError('protocol', 'not a handshake message');
  if (m.t === 'ph.fail') throw new PhoneHandshakeError(typeof m.code === 'string' ? m.code.slice(0, 30) : 'failed', 'the other side ended the handshake');
  if (type && m.t !== type) throw new PhoneHandshakeError('protocol', `expected ${type}`);
  return m;
}

export const failMessage = (code) => JSON.stringify({ t: 'ph.fail', code: String(code || 'failed').slice(0, 30) });

const bytes = (v, n, what) => {
  try {
    return fromB64u(v, n);
  } catch {
    throw new PhoneHandshakeError('protocol', `bad ${what}`);
  }
};

async function readBox(key, nonce, aad, text, code = 'bad_box') {
  let plain;
  try {
    plain = await open(key, nonce, bytes(text, undefined, 'box'), aad);
  } catch (err) {
    if (err instanceof PhoneHandshakeError) throw err;
    throw new PhoneHandshakeError(code, 'the handshake could not be opened');
  }
  try {
    const o = JSON.parse(new TextDecoder().decode(plain));
    if (!o || typeof o !== 'object') throw new Error('not an object');
    return o;
  } catch {
    throw new PhoneHandshakeError('protocol', 'box is not JSON');
  }
}

/** The six words both people compare. */
export async function sasWords(th3, pkH, pkG) {
  return wordsFromBytes(await sha256('hivedesk phone v1 sas', th3, pkH, pkG), 6);
}

/** Fingerprint words of a key (the device list shows them). */
export async function keyWords(alg, raw) {
  return wordsFromBytes(await sha256('hivedesk phone v1 words|', alg, '|', raw), 6);
}

export const sessionIdOf = async (th) => 'ps_' + base32(await sha256('hivedesk phone v1 session id', th)).slice(0, 16);

const keysFrom = async (k, th) => ({
  g2h: await hkdf(k, th, 'hivedesk phone v1 session g>h', 32),
  h2g: await hkdf(k, th, 'hivedesk phone v1 session h>g', 32)
});

// ------------------------------------------------------------------ pairing

/** The phone side of pairing. identity: { alg, publicRaw, sign(...parts) }. */
export class PairGuest {
  /** @param {{ identity: any, invite: { topicId: string, psk: Uint8Array, pin: Uint8Array }, name?: string }} o */
  constructor({ identity, invite, name }) {
    this.identity = identity;
    this.invite = invite;
    this.name = cleanName(name);
    this.state = 'new';
  }

  async start() {
    if (this.state !== 'new') throw new PhoneHandshakeError('protocol', 'already started');
    this.e = await ecdhPair();
    this.n = randomBytes(16);
    this.m1 = JSON.stringify({ t: 'ph.1', v: HS_VERSION, inv: this.invite.topicId, e: b64u(this.e.publicRaw), n: b64u(this.n) });
    this.state = 'sent1';
    return this.m1;
  }

  /** Reads ph.2 and returns { m3, result }. */
  async onM2(m2) {
    if (this.state !== 'sent1') throw new PhoneHandshakeError('protocol', 'ph.2 out of order');
    this.state = 'failed';
    const msg = parseHs(m2, 'ph.2');
    const eH = bytes(msg.e, 65, 'key');
    const nH = bytes(msg.n, 16, 'nonce');
    let dh;
    try {
      dh = await ecdh(this.e.privateKey, eH);
    } catch {
      throw new PhoneHandshakeError('protocol', 'bad ephemeral key');
    }
    const salt1 = await T(this.m1, eH, nH);
    const k1 = await hkdf(concatBytes([dh, this.invite.psk]), salt1, 'hivedesk phone v1 k1', 32);
    const box = await readBox(k1, NONCE_M2, 'hivedesk phone v1 m2', msg.box, 'bad_secret');
    const pkH = bytes(box.key, 65, 'host key');
    if (!equalBytes(await hostPin(pkH), this.invite.pin)) throw new PhoneHandshakeError('pin', 'the computer that answered is not the one that showed the QR code');
    const hostName = cleanName(box.name, 'hivedesk');
    if (!(await verifyWith('p256', pkH, bytes(box.sig, 64, 'signature'), 'hivedesk phone v1 host', await T(this.m1, eH, nH, pkH, hostName)))) {
      throw new PhoneHandshakeError('bad_signature', 'the computer signature does not verify');
    }
    const th2 = await T(this.m1, m2);
    const k2 = await hkdf(k1, th2, 'hivedesk phone v1 k2', 32);
    const pkG = this.identity.publicRaw;
    const sig = await this.identity.sign('hivedesk phone v1 phone', await T(th2, this.identity.alg, pkG, this.name));
    const inner = canonical({ alg: this.identity.alg, key: b64u(pkG), sig: b64u(sig), name: this.name });
    const m3 = JSON.stringify({ t: 'ph.3', box: b64u(await seal(k2, NONCE_M3, inner, 'hivedesk phone v1 m3')) });
    const th3 = await T(th2, m3);
    const keys = await keysFrom(k2, th3);
    const result = {
      sessionId: await sessionIdOf(th3),
      sendKey: keys.g2h,
      recvKey: keys.h2g,
      sas: await sasWords(th3, pkH, pkG),
      reconnect: await hkdf(k2, th3, 'hivedesk phone v1 reconnect', 32),
      host: { key: pkH, name: hostName, peerId: typeof box.peerId === 'string' && /^hd1[a-z2-7]{49}$/.test(box.peerId) ? box.peerId : null, words: await keyWords('p256', pkH) },
      role: 'phone'
    };
    this.state = 'done';
    return { m3, result };
  }
}

/** The desktop side of pairing. hostKey: { publicRaw, sign(...parts) }, the ECDSA P-256 phone key. */
export class PairHost {
  /** @param {{ hostKey: any, invite: { topicId: string, psk: Uint8Array }, hostName?: string, peerId?: string }} o */
  constructor({ hostKey, invite, hostName, peerId }) {
    this.hostKey = hostKey;
    this.invite = invite;
    this.hostName = cleanName(hostName, 'hivedesk');
    this.peerId = peerId || undefined;
    this.state = 'new';
  }

  async onM1(m1) {
    if (this.state !== 'new') throw new PhoneHandshakeError('protocol', 'ph.1 out of order');
    this.state = 'failed';
    const msg = parseHs(m1, 'ph.1');
    if (msg.v !== HS_VERSION) throw new PhoneHandshakeError('version', `phone handshake version ${msg.v} is not supported`);
    if (msg.inv !== this.invite.topicId) throw new PhoneHandshakeError('unknown', 'another invite');
    const eG = bytes(msg.e, 65, 'key');
    bytes(msg.n, 16, 'nonce');
    this.m1 = m1;
    const e = await ecdhPair();
    const nH = randomBytes(16);
    let dh;
    try {
      dh = await ecdh(e.privateKey, eG);
    } catch {
      throw new PhoneHandshakeError('protocol', 'bad ephemeral key');
    }
    const salt1 = await T(m1, e.publicRaw, nH);
    const k1 = await hkdf(concatBytes([dh, this.invite.psk]), salt1, 'hivedesk phone v1 k1', 32);
    const pkH = this.hostKey.publicRaw;
    const sig = await this.hostKey.sign('hivedesk phone v1 host', await T(m1, e.publicRaw, nH, pkH, this.hostName));
    const inner = canonical({ key: b64u(pkH), sig: b64u(sig), name: this.hostName, peerId: this.peerId });
    this.m2 = JSON.stringify({ t: 'ph.2', e: b64u(e.publicRaw), n: b64u(nH), box: b64u(await seal(k1, NONCE_M2, inner, 'hivedesk phone v1 m2')) });
    this.k2 = await hkdf(k1, await T(m1, this.m2), 'hivedesk phone v1 k2', 32);
    this.state = 'sent2';
    return this.m2;
  }

  async onM3(m3) {
    if (this.state !== 'sent2') throw new PhoneHandshakeError('protocol', 'ph.3 out of order');
    this.state = 'failed';
    const msg = parseHs(m3, 'ph.3');
    const th2 = await T(this.m1, this.m2);
    const box = await readBox(this.k2, NONCE_M3, 'hivedesk phone v1 m3', msg.box, 'bad_secret');
    if (!isAlg(box.alg)) throw new PhoneHandshakeError('bad_identity', 'unknown signature scheme');
    const pkG = bytes(box.key, box.alg === 'ed25519' ? 32 : 65, 'phone key');
    if (!(await checkPublicKey(box.alg, pkG))) throw new PhoneHandshakeError('bad_identity', 'not a public key');
    const name = cleanName(box.name);
    if (!(await verifyWith(box.alg, pkG, bytes(box.sig, 64, 'signature'), 'hivedesk phone v1 phone', await T(th2, box.alg, pkG, name)))) {
      throw new PhoneHandshakeError('bad_signature', 'the phone signature does not verify');
    }
    const th3 = await T(th2, m3);
    const keys = await keysFrom(this.k2, th3);
    const result = {
      sessionId: await sessionIdOf(th3),
      sendKey: keys.h2g,
      recvKey: keys.g2h,
      sas: await sasWords(th3, this.hostKey.publicRaw, pkG),
      reconnect: await hkdf(this.k2, th3, 'hivedesk phone v1 reconnect', 32),
      device: { deviceId: await deviceIdOf(box.alg, pkG), alg: box.alg, publicKey: b64u(pkG), name, words: await keyWords(box.alg, pkG) },
      role: 'desktop'
    };
    this.k2 = null;
    this.state = 'done';
    return result;
  }
}

// ------------------------------------------------------------------ known phone

/** The phone reconnecting to a desktop it paired with. host: { key: Uint8Array, pin: Uint8Array }, reconnect: the stored secret. */
export class KnownGuest {
  constructor({ identity, deviceId, host, reconnect }) {
    this.identity = identity;
    this.deviceId = deviceId;
    this.host = host;
    this.reconnect = reconnect;
    this.state = 'new';
  }

  async start() {
    this.e = await ecdhPair();
    this.n = randomBytes(16);
    const pin = b64u(this.host.pin);
    const sig = await this.identity.sign('hivedesk phone v1 known init', await T(this.e.publicRaw, this.n, this.identity.alg, this.identity.publicRaw, pin));
    this.m1 = JSON.stringify({ t: 'pk.1', v: HS_VERSION, e: b64u(this.e.publicRaw), n: b64u(this.n), from: { alg: this.identity.alg, key: b64u(this.identity.publicRaw), id: this.deviceId }, to: pin, sig: b64u(sig) });
    this.state = 'sent1';
    return this.m1;
  }

  async onM2(m2) {
    if (this.state !== 'sent1') throw new PhoneHandshakeError('protocol', 'pk.2 out of order');
    this.state = 'failed';
    const msg = parseHs(m2, 'pk.2');
    const eH = bytes(msg.e, 65, 'key');
    const nH = bytes(msg.n, 16, 'nonce');
    let dh;
    try {
      dh = await ecdh(this.e.privateKey, eH);
    } catch {
      throw new PhoneHandshakeError('protocol', 'bad ephemeral key');
    }
    const salt = await T(this.m1, eH, nH);
    const k = await hkdf(concatBytes([dh, this.reconnect]), salt, 'hivedesk phone v1 known k', 32);
    const box = await readBox(k, NONCE_K2, 'hivedesk phone v1 known m2', msg.box, 'bad_box');
    if (!(await verifyWith('p256', this.host.key, bytes(box.sig, 64, 'signature'), 'hivedesk phone v1 known resp', salt))) {
      throw new PhoneHandshakeError('bad_signature', 'the computer signature does not verify');
    }
    const th = await T(this.m1, m2);
    const keys = await keysFrom(k, th);
    this.state = 'done';
    return { sessionId: await sessionIdOf(th), sendKey: keys.g2h, recvKey: keys.h2g };
  }
}

/**
 * The desktop answering a known phone. lookup(deviceId) returns { alg, publicKey (base64url), reconnect: Uint8Array }
 * of a paired, not revoked phone, or null.
 */
export class KnownHost {
  constructor({ hostKey, pin, lookup }) {
    this.hostKey = hostKey;
    this.pin = pin;
    this.lookup = lookup;
  }

  /** Reads pk.1 and returns { m2, result }. */
  async onM1(m1) {
    const msg = parseHs(m1, 'pk.1');
    if (msg.v !== HS_VERSION) throw new PhoneHandshakeError('version', `phone handshake version ${msg.v} is not supported`);
    const from = msg.from && typeof msg.from === 'object' ? msg.from : {};
    if (!isAlg(from.alg)) throw new PhoneHandshakeError('bad_identity', 'unknown signature scheme');
    const pkG = bytes(from.key, from.alg === 'ed25519' ? 32 : 65, 'phone key');
    const deviceId = await deviceIdOf(from.alg, pkG);
    if (from.id !== deviceId) throw new PhoneHandshakeError('bad_identity', 'the id does not match the key');
    if (msg.to !== b64u(this.pin)) throw new PhoneHandshakeError('wrong_host', 'this hello is for another computer');
    const known = await this.lookup(deviceId);
    if (!known) throw new PhoneHandshakeError('unknown_phone', 'this phone is not paired (or was removed); scan a new QR code');
    if (known.alg !== from.alg || known.publicKey !== b64u(pkG)) throw new PhoneHandshakeError('unknown_phone', 'stored key differs');
    const eG = bytes(msg.e, 65, 'key');
    const nG = bytes(msg.n, 16, 'nonce');
    if (!(await verifyWith(from.alg, pkG, bytes(msg.sig, 64, 'signature'), 'hivedesk phone v1 known init', await T(eG, nG, from.alg, pkG, msg.to)))) {
      throw new PhoneHandshakeError('bad_signature', 'the hello signature does not verify');
    }
    const e = await ecdhPair();
    const nH = randomBytes(16);
    let dh;
    try {
      dh = await ecdh(e.privateKey, eG);
    } catch {
      throw new PhoneHandshakeError('protocol', 'bad ephemeral key');
    }
    const salt = await T(m1, e.publicRaw, nH);
    const k = await hkdf(concatBytes([dh, known.reconnect]), salt, 'hivedesk phone v1 known k', 32);
    const inner = canonical({ sig: b64u(await this.hostKey.sign('hivedesk phone v1 known resp', salt)) });
    const m2 = JSON.stringify({ t: 'pk.2', e: b64u(e.publicRaw), n: b64u(nH), box: b64u(await seal(k, NONCE_K2, inner, 'hivedesk phone v1 known m2')) });
    const th = await T(m1, m2);
    const keys = await keysFrom(k, th);
    return { m2, result: { sessionId: await sessionIdOf(th), sendKey: keys.h2g, recvKey: keys.g2h, deviceId } };
  }
}

/** Wraps a non extractable CryptoKey as the identity the handshakes take. */
export function identityOf(alg, privateKey, publicRaw) {
  return { alg, publicRaw, sign: (...parts) => signWith(alg, privateKey, ...parts) };
}

export { utf8, PhoneCryptoError };
