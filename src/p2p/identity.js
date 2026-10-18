// One Ed25519 identity per install (PLAN 3.2), kept in <home>/identity/:
//   key.pem         the private key, PKCS8 PEM, private to the user (keyfile.js)
//   identity.json   { v, peerId, publicKey, name, createdAt }
// peerId = "hd1" + base32(sha256(raw public key)), 52 characters in all; the fingerprint words are six BIP39 words
// from the first 66 bits of the same hash, so people compare words they already know.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { wordsFromBytes } from '../../ui/lend/core/words.js';
import { base32, b64u, fromB64u, isBase32, canonical } from './encoding.js';
import { ed25519Pair, ed25519PublicRaw, sha256, sign, verify } from './primitives.js';
import { restrictToUser, writeJsonAtomic, writePrivate } from './keyfile.js';

export const IDENTITY_VERSION = 1;
export const NAME_MAX = 40;
// 52 characters in all: "hd1" and the first 49 base32 characters (245 bits) of the hash (PLAN 3.2).
export const PEER_ID_RE = /^hd1[a-z2-7]{49}$/;

export class IdentityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'IdentityError';
    this.code = code;
  }
}

export const identityDir = (home) => path.join(home, 'identity');
export const keyFile = (home) => path.join(identityDir(home), 'key.pem');
export const identityFile = (home) => path.join(identityDir(home), 'identity.json');

// Control characters, zero width marks and bidi overrides, which could disguise a name.
const HIDDEN = new RegExp(`[${[[0x00, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2066, 0x2069]].map(([a, z]) => `${String.fromCharCode(a)}-${String.fromCharCode(z)}`).join('')}]`, 'g');

/** Display names: printable, trimmed, at most 40 characters. Display only, never trusted. */
export function cleanName(name, fallback = 'hivedesk') {
  const s = String(name ?? '').replace(HIDDEN, '').trim().slice(0, NAME_MAX);
  return s || fallback;
}

export function peerIdOf(publicRaw) {
  return 'hd1' + base32(sha256(publicRaw)).slice(0, 49);
}

export function fingerprintOf(publicRaw) {
  const hash = sha256(publicRaw);
  const b = base32(hash);
  return { hex: hash.toString('hex'), words: wordsFromBytes(hash, 6), short: `hd1${b.slice(0, 4)}-${b.slice(4, 8)}` };
}

/** The public part that travels to peers: PeerIdentity of PLAN section 2. */
export function publicIdentity(id) {
  return { peerId: id.peerId, publicKey: id.publicKey, name: id.name, fingerprint: fingerprintOf(id.publicRaw), createdAt: id.createdAt };
}

/**
 * Checks a PeerIdentity from a peer: the key is a real Ed25519 key and the peerId is its hash.
 * Returns a clean copy (unknown fields dropped, the fingerprint recomputed here).
 */
export function readPeerIdentity(obj) {
  if (!obj || typeof obj !== 'object') throw new IdentityError('bad_identity', 'missing identity');
  let raw;
  try {
    raw = fromB64u(obj.publicKey, 32);
  } catch {
    throw new IdentityError('bad_identity', 'bad public key');
  }
  const peerId = peerIdOf(raw);
  if (obj.peerId !== peerId) throw new IdentityError('bad_identity', 'peerId does not match the key');
  const createdAt = typeof obj.createdAt === 'string' && obj.createdAt.length <= 40 ? obj.createdAt : new Date(0).toISOString();
  return { peerId, publicKey: b64u(raw), publicRaw: raw, name: cleanName(obj.name, 'friend'), fingerprint: fingerprintOf(raw), createdAt };
}

function build(privateKey, meta) {
  const publicRaw = ed25519PublicRaw(privateKey);
  const peerId = peerIdOf(publicRaw);
  const id = {
    peerId,
    publicKey: b64u(publicRaw),
    publicRaw,
    name: cleanName(meta.name),
    createdAt: meta.createdAt,
    fingerprint: fingerprintOf(publicRaw),
    sign: (...parts) => sign(privateKey, ...parts),
  };
  // The private key object stays out of enumerable fields so it never lands in JSON or logs.
  Object.defineProperty(id, 'privateKey', { value: privateKey, enumerable: false });
  return id;
}

function writeIdentity(home, privateKey, meta) {
  const dir = identityDir(home);
  const fresh = !fs.existsSync(dir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (fresh) restrictToUser(dir);
  const acl = writePrivate(keyFile(home), privateKey.export({ format: 'pem', type: 'pkcs8' }));
  const id = build(privateKey, meta);
  writeJsonAtomic(identityFile(home), { v: IDENTITY_VERSION, peerId: id.peerId, publicKey: id.publicKey, name: id.name, createdAt: id.createdAt });
  return { id, acl };
}

/**
 * Reads the identity without creating one. Throws IdentityError with code 'missing',
 * 'unreadable', 'bad_key' or 'mismatch'.
 */
export function readIdentity(home) {
  let pem;
  try {
    pem = fs.readFileSync(keyFile(home), 'utf8');
  } catch (err) {
    throw new IdentityError(err.code === 'ENOENT' ? 'missing' : 'unreadable', `identity key: ${err.message}`);
  }
  let privateKey;
  try {
    privateKey = crypto.createPrivateKey({ key: pem, format: 'pem' });
  } catch {
    throw new IdentityError('bad_key', 'the identity key file is not a valid key');
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new IdentityError('bad_key', 'the identity key is not Ed25519');
  let meta = {};
  try {
    meta = JSON.parse(fs.readFileSync(identityFile(home), 'utf8'));
  } catch {
    meta = {};
  }
  const id = build(privateKey, { name: meta.name, createdAt: typeof meta.createdAt === 'string' ? meta.createdAt : new Date(fs.statSync(keyFile(home)).mtimeMs).toISOString() });
  if (meta.peerId && meta.peerId !== id.peerId) throw new IdentityError('mismatch', 'identity.json names another key than key.pem');
  if (!meta.peerId) writeJsonAtomic(identityFile(home), { v: IDENTITY_VERSION, peerId: id.peerId, publicKey: id.publicKey, name: id.name, createdAt: id.createdAt });
  return id;
}

/**
 * Loads the identity, creating it on first use. A key that exists but cannot be read is an
 * error, never a reason to make a new identity silently (known peers would stop knowing us).
 * Returns { identity, created }.
 */
export function loadOrCreateIdentity(home, { name, now = () => Date.now() } = {}) {
  try {
    const identity = readIdentity(home);
    if (name && cleanName(name) !== identity.name) return { identity: renameIdentity(home, identity, name), created: false };
    return { identity, created: false };
  } catch (err) {
    if (err.code !== 'missing' || fs.existsSync(identityFile(home))) {
      if (err.code === 'missing') throw new IdentityError('key_lost', 'identity.json exists but key.pem is missing; run "hivedesk identity --rotate" to make a new identity');
      throw err;
    }
  }
  const { privateKey } = ed25519Pair();
  const { id } = writeIdentity(home, privateKey, { name, createdAt: new Date(now()).toISOString() });
  return { identity: id, created: true };
}

export function renameIdentity(home, identity, name) {
  const next = build(identity.privateKey, { name, createdAt: identity.createdAt });
  writeJsonAtomic(identityFile(home), { v: IDENTITY_VERSION, peerId: next.peerId, publicKey: next.publicKey, name: next.name, createdAt: next.createdAt });
  return next;
}

const ROTATE_CONTEXT = 'hivedesk v2 identity rotated';

/**
 * Makes a new key and a statement signed by the old key that known peers can verify:
 * { t: 'identity.rotated', oldPeerId, newPeerId, newPublicKey, ts, sig }.
 */
export function rotateIdentity(home, { now = () => Date.now() } = {}) {
  const old = readIdentity(home);
  const { privateKey } = ed25519Pair();
  const { id } = writeIdentity(home, privateKey, { name: old.name, createdAt: new Date(now()).toISOString() });
  const body = { t: 'identity.rotated', oldPeerId: old.peerId, newPeerId: id.peerId, newPublicKey: id.publicKey, ts: now() };
  const sig = b64u(old.sign(ROTATE_CONTEXT, canonical(body)));
  return { identity: id, previous: { peerId: old.peerId, publicKey: old.publicKey }, statement: { ...body, sig } };
}

/** Verifies a rotation statement against the old public key. Returns the new PeerIdentity parts or throws. */
export function verifyRotation(statement, oldPublicRaw) {
  const s = statement || {};
  if (s.t !== 'identity.rotated' || !PEER_ID_RE.test(s.oldPeerId || '') || !PEER_ID_RE.test(s.newPeerId || '') || !Number.isFinite(s.ts)) {
    throw new IdentityError('bad_rotation', 'malformed rotation statement');
  }
  if (peerIdOf(oldPublicRaw) !== s.oldPeerId) throw new IdentityError('bad_rotation', 'the statement is for another peer');
  let newRaw;
  let sig;
  try {
    newRaw = fromB64u(s.newPublicKey, 32);
    sig = fromB64u(s.sig, 64);
  } catch {
    throw new IdentityError('bad_rotation', 'bad key or signature encoding');
  }
  if (peerIdOf(newRaw) !== s.newPeerId) throw new IdentityError('bad_rotation', 'new peerId does not match the new key');
  const body = { t: s.t, oldPeerId: s.oldPeerId, newPeerId: s.newPeerId, newPublicKey: s.newPublicKey, ts: s.ts };
  if (!verify(oldPublicRaw, sig, ROTATE_CONTEXT, canonical(body))) throw new IdentityError('bad_rotation', 'the signature does not verify');
  return { peerId: s.newPeerId, publicKey: s.newPublicKey, publicRaw: newRaw };
}

export const isPeerId = (s) => typeof s === 'string' && PEER_ID_RE.test(s) && isBase32(s.slice(3), 49);
