// What this phone keeps, in IndexedDB ("hivedesk-remote"), never in the page itself:
//   identity   { alg, privateKey: CryptoKey (not extractable), publicRaw, deviceId, createdAt }
//   pairing    { deviceId, name, host: { key, pin, name, peerId }, reconnect, pairedAt }
// The private key cannot be read back as bytes; the browser only lets this origin sign with it.

import { newIdentityKey, deviceIdOf } from './vendor/phone/core/crypto.js';
import { identityOf } from './vendor/phone/core/handshake.js';

const DB = 'hivedesk-remote';
const STORE = 'kv';

function db() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error || new Error('IndexedDB is not available'));
  });
}

async function run(mode, fn) {
  const d = await db();
  try {
    return await new Promise((resolve, reject) => {
      const tx = d.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('aborted'));
    });
  } finally {
    d.close();
  }
}

export const get = (key) => run('readonly', (s) => s.get(key));
export const put = (key, value) => run('readwrite', (s) => s.put(value, key));
export const del = (key) => run('readwrite', (s) => s.delete(key));

/** This phone's identity, made on first use: Ed25519 where the browser has it, else ECDSA P-256. */
export async function identity() {
  let rec = await get('identity');
  if (!rec?.privateKey) {
    const k = await newIdentityKey();
    rec = { alg: k.alg, privateKey: k.privateKey, publicRaw: k.publicRaw, deviceId: await deviceIdOf(k.alg, k.publicRaw), createdAt: new Date().toISOString() };
    await put('identity', rec);
  }
  return { ...rec, signer: identityOf(rec.alg, rec.privateKey, rec.publicRaw) };
}

export const pairing = () => get('pairing');
export const savePairing = (p) => put('pairing', p);

/** Forgets the computer (and the identity, so a new pairing starts clean). */
export async function forget() {
  await del('pairing');
  await del('identity');
}

/** Asks the browser not to evict this storage when space runs low. */
export async function persist() {
  try { return await navigator.storage?.persist?.(); } catch { return false; }
}
