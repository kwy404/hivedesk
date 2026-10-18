// The crypto primitives of the control plane, all from node:crypto (PLAN 3.1): SHA-256, HKDF,
// PBKDF2, X25519, Ed25519 and ChaCha20-Poly1305. No new dependencies, no browser crypto.

import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { b64u, fromB64u } from './encoding.js';

const pbkdf2Async = promisify(crypto.pbkdf2);

export class CryptoError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CryptoError';
    this.code = code;
  }
}

const bytesOf = (p) => (typeof p === 'string' ? Buffer.from(p, 'utf8') : Buffer.from(p));

/** SHA-256 over the concatenation of the parts (strings are UTF-8). */
export function sha256(...parts) {
  const h = crypto.createHash('sha256');
  for (const p of parts) h.update(bytesOf(p));
  return h.digest();
}

/** HKDF-SHA256. salt may be empty. */
export function hkdf(ikm, salt, info, length = 32) {
  return Buffer.from(crypto.hkdfSync('sha256', bytesOf(ikm), bytesOf(salt ?? Buffer.alloc(0)), bytesOf(info), length));
}

/** PBKDF2-SHA256, async so 100,000 iterations never block the engine's event loop. */
export async function pbkdf2(secret, salt, iterations, length = 32) {
  return pbkdf2Async(bytesOf(secret), bytesOf(salt), iterations, length, 'sha256');
}

export const randomBytes = (n) => crypto.randomBytes(n);

/** Constant time compare of two byte strings of any length. */
export function equalBytes(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ---- X25519 ephemeral keys ----

/** A fresh X25519 key pair: { publicRaw: Buffer(32), privateKey: KeyObject }. */
export function x25519Pair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  return { publicRaw: fromB64u(publicKey.export({ format: 'jwk' }).x, 32), privateKey };
}

/** X25519(private, remote raw public). Refuses the all zero output of a low order point. */
export function x25519(privateKey, remotePublicRaw) {
  let pub;
  try {
    pub = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: b64u(remotePublicRaw) }, format: 'jwk' });
  } catch {
    throw new CryptoError('bad_key', 'not an X25519 public key');
  }
  const shared = crypto.diffieHellman({ privateKey, publicKey: pub });
  if (shared.every((b) => b === 0)) throw new CryptoError('bad_key', 'low order X25519 key');
  return shared;
}

// ---- Ed25519 identity keys ----

export function ed25519Pair() {
  return crypto.generateKeyPairSync('ed25519');
}

export function ed25519PublicRaw(keyObject) {
  const pub = keyObject.type === 'private' ? crypto.createPublicKey(keyObject) : keyObject;
  return fromB64u(pub.export({ format: 'jwk' }).x, 32);
}

export function ed25519PublicKey(raw) {
  try {
    return crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: b64u(raw) }, format: 'jwk' });
  } catch {
    throw new CryptoError('bad_key', 'not an Ed25519 public key');
  }
}

export function sign(privateKey, ...parts) {
  return crypto.sign(null, Buffer.concat(parts.map(bytesOf)), privateKey);
}

export function verify(publicRaw, signature, ...parts) {
  try {
    const sig = Buffer.from(signature);
    if (sig.length !== 64) return false;
    return crypto.verify(null, Buffer.concat(parts.map(bytesOf)), ed25519PublicKey(publicRaw), sig);
  } catch {
    return false;
  }
}

// ---- ChaCha20-Poly1305 ----

export const TAG_BYTES = 16;

/** Seals plaintext; the output is ciphertext followed by the 16 byte tag. */
export function seal(key, nonce, plaintext, aad = Buffer.alloc(0)) {
  const c = crypto.createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: TAG_BYTES });
  c.setAAD(bytesOf(aad), { plaintextLength: Buffer.byteLength(plaintext) });
  const ct = Buffer.concat([c.update(bytesOf(plaintext)), c.final()]);
  return Buffer.concat([ct, c.getAuthTag()]);
}

/** Opens what seal made. Throws CryptoError('bad_tag') on any change. */
export function open(key, nonce, sealed, aad = Buffer.alloc(0)) {
  const buf = Buffer.from(sealed);
  if (buf.length < TAG_BYTES) throw new CryptoError('bad_tag', 'ciphertext too short');
  try {
    const d = crypto.createDecipheriv('chacha20-poly1305', key, nonce, { authTagLength: TAG_BYTES });
    d.setAAD(bytesOf(aad), { plaintextLength: buf.length - TAG_BYTES });
    d.setAuthTag(buf.subarray(buf.length - TAG_BYTES));
    return Buffer.concat([d.update(buf.subarray(0, buf.length - TAG_BYTES)), d.final()]);
  } catch {
    throw new CryptoError('bad_tag', 'could not open the message');
  }
}

/** Overwrites key material that is no longer needed. */
export function wipe(...bufs) {
  for (const b of bufs) if (Buffer.isBuffer(b)) b.fill(0);
}
