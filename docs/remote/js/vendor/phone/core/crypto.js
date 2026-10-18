// Copied from ui/phone/core/crypto.js by scripts/phone-page.mjs. Edit the source, then run the script.
// The crypto of the phone remote, on WebCrypto only, so the same file runs in the phone page
// (docs/remote/) and in the engine (Node 20 has globalThis.crypto.subtle). No dependencies.
//   SHA-256, HKDF-SHA256, AES-256-GCM, ECDH P-256 (ephemeral keys), and two signature schemes for
//   device identities: Ed25519 where the browser has it, ECDSA P-256 with SHA-256 everywhere else.
// The desktop's phone key is always ECDSA P-256, so every phone browser can verify it.

import { concatBytes, equalBytes, fromBase64Url, randomBytes, toBase64Url, utf8 } from '../../lend/core/bytes.js';

const subtle = () => globalThis.crypto.subtle;

export class PhoneCryptoError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PhoneCryptoError';
    this.code = code;
  }
}

export { randomBytes, equalBytes, concatBytes, utf8 };

/** Strings become UTF-8; byte arrays and ArrayBuffers are used as they are. */
export const bytesOf = (p) => (typeof p === 'string' ? utf8(p) : p instanceof Uint8Array ? p : new Uint8Array(p));

export const b64u = (bytes) => toBase64Url(bytesOf(bytes));

/** Strict base64url: the URL alphabet only, canonical, and an exact length when one is given. */
export function fromB64u(text, length) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text) || text.length > 8192) throw new PhoneCryptoError('bad_encoding', 'not base64url');
  let out;
  try {
    out = fromBase64Url(text);
  } catch {
    throw new PhoneCryptoError('bad_encoding', 'not base64url');
  }
  if (toBase64Url(out) !== text) throw new PhoneCryptoError('bad_encoding', 'not canonical base64url');
  if (length !== undefined && out.length !== length) throw new PhoneCryptoError('bad_encoding', `expected ${length} bytes`);
  return out;
}

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** Lower case base32 without padding. */
export function base32(bytes) {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of bytesOf(bytes)) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export async function sha256(...parts) {
  return new Uint8Array(await subtle().digest('SHA-256', concatBytes(parts.map(bytesOf))));
}

/** Length prefixed transcript hash: each part gets a 4 byte big endian length, so no two lists hash alike. */
export async function T(...parts) {
  const out = [];
  for (const p of parts) {
    const b = bytesOf(p);
    out.push(Uint8Array.of((b.length >>> 24) & 255, (b.length >>> 16) & 255, (b.length >>> 8) & 255, b.length & 255), b);
  }
  return sha256(...out);
}

/** HKDF-SHA256 to `length` bytes. */
export async function hkdf(ikm, salt, info, length = 32) {
  const key = await subtle().importKey('raw', bytesOf(ikm), 'HKDF', false, ['deriveBits']);
  const bits = await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: bytesOf(salt ?? new Uint8Array(0)), info: bytesOf(info) }, key, length * 8);
  return new Uint8Array(bits);
}

// ---- AES-256-GCM ----

export async function aesKey(raw) {
  const b = bytesOf(raw);
  if (b.length !== 32) throw new PhoneCryptoError('bad_key', 'an AES key has 32 bytes');
  return subtle().importKey('raw', b, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** Seals with a 12 byte nonce; the output is the ciphertext followed by the 16 byte tag. */
export async function seal(key, nonce, plain, aad = '') {
  const k = key instanceof Uint8Array ? await aesKey(key) : key;
  return new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: bytesOf(nonce), additionalData: bytesOf(aad), tagLength: 128 }, k, bytesOf(plain)));
}

/** Opens what seal made. Throws PhoneCryptoError('bad_tag') on any change. */
export async function open(key, nonce, sealed, aad = '') {
  const k = key instanceof Uint8Array ? await aesKey(key) : key;
  try {
    return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: bytesOf(nonce), additionalData: bytesOf(aad), tagLength: 128 }, k, bytesOf(sealed)));
  } catch {
    throw new PhoneCryptoError('bad_tag', 'could not open the message');
  }
}

/** A 12 byte nonce from a 32 bit stream id and a 64 bit counter (the counter stays below 2^53). */
export function nonceOf(stream, n) {
  const b = new Uint8Array(12);
  const v = new DataView(b.buffer);
  v.setUint32(0, stream);
  v.setUint32(4, Math.floor(n / 2 ** 32));
  v.setUint32(8, n >>> 0);
  return b;
}

// ---- ECDH P-256 ephemeral keys ----

/** A fresh ephemeral key pair: { privateKey: CryptoKey, publicRaw: 65 bytes uncompressed }. */
export async function ecdhPair() {
  const kp = await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  return { privateKey: kp.privateKey, publicRaw: new Uint8Array(await subtle().exportKey('raw', kp.publicKey)) };
}

/** ECDH(private, remote raw public): 32 bytes. Refuses anything that is not a point on P-256. */
export async function ecdh(privateKey, remoteRaw) {
  const raw = bytesOf(remoteRaw);
  if (raw.length !== 65 || raw[0] !== 4) throw new PhoneCryptoError('bad_key', 'not an uncompressed P-256 point');
  let pub;
  try {
    pub = await subtle().importKey('raw', raw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  } catch {
    throw new PhoneCryptoError('bad_key', 'not a P-256 public key');
  }
  return new Uint8Array(await subtle().deriveBits({ name: 'ECDH', public: pub }, privateKey, 256));
}

// ---- identity keys ----

export const ALGS = Object.freeze({
  ed25519: { gen: { name: 'Ed25519' }, sig: { name: 'Ed25519' }, imp: { name: 'Ed25519' }, pub: 32 },
  p256: { gen: { name: 'ECDSA', namedCurve: 'P-256' }, sig: { name: 'ECDSA', hash: 'SHA-256' }, imp: { name: 'ECDSA', namedCurve: 'P-256' }, pub: 65 }
});
export const isAlg = (a) => a === 'ed25519' || a === 'p256';

/** Does this WebCrypto sign with Ed25519? Older mobile browsers do not. */
export async function hasEd25519() {
  try {
    const kp = await subtle().generateKey(ALGS.ed25519.gen, false, ['sign', 'verify']);
    await subtle().sign(ALGS.ed25519.sig, kp.privateKey, new Uint8Array(1));
    return true;
  } catch {
    return false;
  }
}

/**
 * A new identity key: Ed25519 when available, else ECDSA P-256. The private key is not extractable,
 * so it can live in IndexedDB but never leaves the device as bytes.
 * @returns {Promise<{ alg: 'ed25519' | 'p256', privateKey: CryptoKey, publicRaw: Uint8Array }>}
 */
export async function newIdentityKey({ prefer = 'ed25519', extractable = false } = {}) {
  const order = prefer === 'p256' ? ['p256'] : ['ed25519', 'p256'];
  for (const alg of order) {
    try {
      const kp = await subtle().generateKey(ALGS[alg].gen, extractable, ['sign', 'verify']);
      await subtle().sign(ALGS[alg].sig, kp.privateKey, new Uint8Array(1));
      return { alg, privateKey: kp.privateKey, publicRaw: new Uint8Array(await subtle().exportKey('raw', kp.publicKey)) };
    } catch { /* try the next scheme */ }
  }
  throw new PhoneCryptoError('no_crypto', 'this browser cannot make a signing key');
}

/** Signs the concatenation of the parts. ECDSA signatures are r || s, 64 bytes, on both sides. */
export async function signWith(alg, privateKey, ...parts) {
  return new Uint8Array(await subtle().sign(ALGS[alg].sig, privateKey, concatBytes(parts.map(bytesOf))));
}

export async function verifyWith(alg, publicRaw, signature, ...parts) {
  if (!isAlg(alg)) return false;
  const raw = bytesOf(publicRaw);
  const sig = bytesOf(signature);
  if (raw.length !== ALGS[alg].pub || sig.length !== 64) return false;
  try {
    const key = await subtle().importKey('raw', raw, ALGS[alg].imp, false, ['verify']);
    return await subtle().verify(ALGS[alg].sig, key, sig, concatBytes(parts.map(bytesOf)));
  } catch {
    return false;
  }
}

/** Checks that raw is a public key of that scheme (the import validates the point). */
export async function checkPublicKey(alg, raw) {
  if (!isAlg(alg) || bytesOf(raw).length !== ALGS[alg].pub) return false;
  try {
    await subtle().importKey('raw', bytesOf(raw), ALGS[alg].imp, false, ['verify']);
    return true;
  } catch {
    return false;
  }
}

/** "ph1" and 25 base32 characters of the hash of the scheme and the key: a phone's id, never a p2p PeerId. */
export async function deviceIdOf(alg, publicRaw) {
  return 'ph1' + base32(await sha256('hivedesk phone id v1|', alg, '|', publicRaw)).slice(0, 25);
}

export const DEVICE_ID_RE = /^ph1[a-z2-7]{25}$/;

/** The first 12 bytes of the hash of the desktop's phone key: pinned by the QR, checked in the handshake. */
export async function hostPin(publicRaw) {
  return (await sha256('hivedesk phone host v1|', publicRaw)).slice(0, 12);
}
