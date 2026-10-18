// Copied from ui/lend/core/rendezvous.js by scripts/phone-page.mjs. Edit the source, then run the script.
// Adapted from howlden (MIT, Alexandre Kohler), app/core/rendezvous.js. The same code also runs in filefinch.
// Meeting on public relays with nothing but the six words.
// From the normalized phrase, PBKDF2-SHA256 (100,000 iterations, fixed app salt) gives a master
// secret; HKDF then derives two independent values from it: the topic name and an AES-GCM key.
// Every message is sealed with that key (fresh IV, the topic as additional data) and carries a
// nonce and a timestamp, so relays only ever see a random topic and ciphertext, and replayed,
// stale or altered messages are rejected.

import { fromUtf8, randomBytes, randomId, toBase64Url, utf8 } from './bytes.js';
import { phraseOf } from './words.js';

export const RENDEZVOUS_ITERATIONS = 100000;
export const MAX_AGE_MS = 11 * 60 * 1000;
export const MAX_SKEW_MS = 2 * 60 * 1000;
const SALT = 'hivedesk lend rendezvous v1';
const VERSION = 1;

const subtle = () => globalThis.crypto.subtle;

/** { topic, key } for a six word phrase. Both devices get the same values. */
export async function deriveRendezvous(words, iterations = RENDEZVOUS_ITERATIONS) {
  const phrase = phraseOf(words);
  const base = await subtle().importKey('raw', utf8(phrase), 'PBKDF2', false, ['deriveBits']);
  const master = await subtle().deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: utf8(SALT), iterations }, base, 256);
  const hkdf = await subtle().importKey('raw', master, 'HKDF', false, ['deriveBits', 'deriveKey']);
  const params = (info) => ({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: utf8(info) });
  const topicBits = new Uint8Array(await subtle().deriveBits(params('hivedesk topic'), hkdf, 128));
  const key = await subtle().deriveKey(params('hivedesk handshake key'), hkdf, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return { topic: `hivedesk/v1/${toBase64Url(topicBits)}`, key };
}

/** Seals a message: version byte, 12 byte IV, AES-GCM ciphertext of the JSON with ts and n added. */
export async function sealMessage(rv, body, now = Date.now()) {
  const plain = utf8(JSON.stringify({ ...body, ts: now, n: randomId(12) }));
  const iv = randomBytes(12);
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: utf8(rv.topic) }, rv.key, plain));
  const out = new Uint8Array(1 + 12 + ct.length);
  out[0] = VERSION;
  out.set(iv, 1);
  out.set(ct, 13);
  return out;
}

/** Opens a sealed message. Throws when it was made with other words, on another topic, or edited. */
export async function openMessage(rv, bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 1 + 12 + 16 || bytes[0] !== VERSION) throw new Error('Not a hivedesk handshake message');
  let plain;
  try {
    plain = await subtle().decrypt({ name: 'AES-GCM', iv: bytes.subarray(1, 13), additionalData: utf8(rv.topic) }, rv.key, bytes.subarray(13));
  } catch {
    throw new Error('Could not open the handshake message');
  }
  const msg = JSON.parse(fromUtf8(new Uint8Array(plain)));
  if (!msg || typeof msg !== 'object' || typeof msg.k !== 'string' || !Number.isFinite(msg.ts) || typeof msg.n !== 'string') throw new Error('Malformed handshake message');
  return msg;
}

/** Rejects replays (a nonce seen before) and messages too old or from the future. */
export class ReplayGuard {
  constructor({ maxAge = MAX_AGE_MS, skew = MAX_SKEW_MS, now = () => Date.now() } = {}) {
    this.maxAge = maxAge;
    this.skew = skew;
    this.now = now;
    this.seen = new Set();
  }
  accept(msg) {
    const t = this.now();
    if (msg.ts < t - this.maxAge || msg.ts > t + this.skew) return false;
    if (this.seen.has(msg.n)) return false;
    this.seen.add(msg.n);
    return true;
  }
}
