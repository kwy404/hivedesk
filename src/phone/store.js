// What the desktop keeps about phones, in the engine home:
//   identity/phone-key.pem      the desktop's ECDSA P-256 phone key (PKCS8), private to the user
//   phones/<deviceId>.json      one paired phone: { v, deviceId, alg, publicKey, name, words, pairedAt, lastSeen, grants, reconnect }
// The phone files hold the reconnect secret, so they are written private too (src/p2p/keyfile.js).
// Removing a phone deletes its file: the phone can never reconnect without a new QR code.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { writePrivate } from '../p2p/keyfile.js';
import { b64u, fromB64u, hostPin, DEVICE_ID_RE, isAlg } from '../../ui/phone/core/crypto.js';
import { cleanGrants } from '../../ui/phone/core/grants.js';
import { cleanName } from '../../ui/phone/core/handshake.js';

export const STORE_VERSION = 1;

/** Loads or creates the desktop's phone key. Returns { publicRaw, pin, sign(...parts) }. */
export async function loadHostKey(home) {
  const file = path.join(home, 'identity', 'phone-key.pem');
  let key;
  try {
    key = crypto.createPrivateKey({ key: fs.readFileSync(file, 'utf8'), format: 'pem' });
  } catch (err) {
    if (err.code !== 'ENOENT') throw Object.assign(new Error(`the phone key cannot be read: ${err.message}`), { code: 'key_unreadable' });
    key = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
    writePrivate(file, key.export({ format: 'pem', type: 'pkcs8' }));
  }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw Object.assign(new Error('the phone key is not P-256'), { code: 'key_unreadable' });
  const subtle = globalThis.crypto.subtle;
  const privateKey = await subtle.importKey('pkcs8', key.export({ format: 'der', type: 'pkcs8' }), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const jwk = crypto.createPublicKey(key).export({ format: 'jwk' });
  const publicRaw = new Uint8Array(Buffer.concat([Buffer.of(4), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]));
  const sign = async (...parts) => new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'utf8') : Buffer.from(p))))));
  return { publicRaw, pin: await hostPin(publicRaw), sign };
}

function readRecord(raw) {
  if (!raw || typeof raw !== 'object' || !DEVICE_ID_RE.test(raw.deviceId || '') || !isAlg(raw.alg)) return null;
  try {
    fromB64u(raw.publicKey, raw.alg === 'ed25519' ? 32 : 65);
    fromB64u(raw.reconnect, 32);
  } catch {
    return null;
  }
  return {
    v: STORE_VERSION,
    deviceId: raw.deviceId,
    alg: raw.alg,
    publicKey: raw.publicKey,
    name: cleanName(raw.name),
    words: Array.isArray(raw.words) ? raw.words.slice(0, 6).map(String) : [],
    pairedAt: String(raw.pairedAt || ''),
    lastSeen: String(raw.lastSeen || raw.pairedAt || ''),
    grants: cleanGrants(raw.grants),
    reconnect: raw.reconnect
  };
}

export class PhoneStore {
  constructor({ dir }) {
    this.dir = dir;
    this.cache = new Map();
    this._load();
  }

  _load() {
    let names = [];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return;
    }
    for (const n of names) {
      if (!/^ph1[a-z2-7]{25}\.json$/.test(n)) continue;
      try {
        const r = readRecord(JSON.parse(fs.readFileSync(path.join(this.dir, n), 'utf8')));
        if (r && `${r.deviceId}.json` === n) this.cache.set(r.deviceId, r);
      } catch { /* a broken file is skipped; the phone pairs again */ }
    }
  }

  list() {
    return [...this.cache.values()];
  }

  get(deviceId) {
    return this.cache.get(deviceId) || null;
  }

  save(rec) {
    const clean = readRecord(rec);
    if (!clean) throw Object.assign(new Error('bad phone record'), { code: 'bad_request' });
    writePrivate(path.join(this.dir, `${clean.deviceId}.json`), JSON.stringify(clean, null, 2) + '\n');
    this.cache.set(clean.deviceId, clean);
    return clean;
  }

  /** Updates fields that change often (lastSeen) in memory, and on disk at most every 10 minutes. */
  touch(deviceId, now) {
    const r = this.cache.get(deviceId);
    if (!r) return;
    const prev = Date.parse(r.lastSeen) || 0;
    r.lastSeen = new Date(now).toISOString();
    if (now - prev > 10 * 60_000) {
      try { this.save(r); } catch { /* best effort */ }
    }
  }

  remove(deviceId) {
    const had = this.cache.delete(deviceId);
    try {
      fs.rmSync(path.join(this.dir, `${deviceId}.json`), { force: true });
    } catch { /* gone */ }
    return had;
  }
}

/** The phone list for the desktop window: never the reconnect secret. */
export const publicRecord = (r, online = false) => ({
  deviceId: r.deviceId, name: r.name, alg: r.alg, words: r.words, pairedAt: r.pairedAt, lastSeen: r.lastSeen, grants: { ...r.grants }, online
});

export { b64u };
