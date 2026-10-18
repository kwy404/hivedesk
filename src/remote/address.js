// The 10 digit machine address of remote desktop: nine digits from a hash of the install's Ed25519
// public key (src/p2p/identity.js) plus one Damm check digit, so any single wrong digit and any swap
// of two neighbouring digits is caught before dialing.
//
// The address is NOT a secret and NOT a credential. It only locates a machine: it names a rendezvous
// topic on the public relays, and whoever answers there must still pass the p2p identity handshake,
// and the host must still click Accept (or the separate unattended password grant must be on).
// Nine digits are a small space: two installs can share an address. findCollision() checks the
// known peers, and the dialer always sees the answering machine's name and fingerprint words.

import crypto from 'node:crypto';

const DAMM = [
  [0, 3, 1, 7, 5, 9, 8, 6, 4, 2],
  [7, 0, 9, 2, 1, 5, 4, 8, 6, 3],
  [4, 2, 0, 6, 8, 7, 1, 3, 5, 9],
  [1, 7, 5, 0, 9, 8, 3, 4, 2, 6],
  [6, 1, 2, 3, 0, 4, 5, 9, 7, 8],
  [3, 6, 7, 4, 2, 0, 9, 5, 8, 1],
  [5, 8, 6, 9, 7, 2, 0, 1, 3, 4],
  [8, 9, 4, 5, 3, 6, 2, 0, 1, 7],
  [9, 4, 3, 8, 6, 1, 7, 2, 0, 5],
  [2, 5, 8, 1, 4, 3, 6, 7, 9, 0]
];

/** The Damm check digit of a string of digits. */
export function dammDigit(digits) {
  let interim = 0;
  for (const c of String(digits)) interim = DAMM[interim][c.charCodeAt(0) - 48];
  return interim;
}

/** True when a string of digits ends with its correct Damm check digit. */
export function dammValid(digits) {
  return /^\d+$/.test(digits) && dammDigit(digits) === 0;
}

const toRaw = (publicKey) => {
  if (Buffer.isBuffer(publicKey) || publicKey instanceof Uint8Array) return Buffer.from(publicKey);
  const s = String(publicKey || '');
  if (!/^[A-Za-z0-9_-]{43}=?$/.test(s)) throw new Error('address: expected the 32 byte Ed25519 public key in base64url');
  return Buffer.from(s.replace(/=$/, ''), 'base64url');
};

/** The address of a public key: ten digits, the first never 0. */
export function deriveAddress(publicKey) {
  const raw = toRaw(publicKey);
  if (raw.length !== 32) throw new Error('address: an Ed25519 public key has 32 bytes');
  const h = crypto.createHash('sha256').update('hivedesk remote address v1\0').update(raw).digest();
  const n = 100_000_000n + (BigInt(`0x${h.subarray(0, 16).toString('hex')}`) % 900_000_000n);
  const nine = n.toString();
  return nine + String(dammDigit(nine));
}

/** Digits out of whatever a person typed or pasted ("999 999 999 9", "999-999-9999", ...). */
export function parseAddress(input) {
  const digits = String(input || '').replace(/[\s.\-_/]/g, '');
  if (!/^\d{10}$/.test(digits)) return { ok: false, code: digits.length && /^\d+$/.test(digits) ? 'length' : 'format' };
  if (!dammValid(digits)) return { ok: false, code: 'check_digit' };
  return { ok: true, address: digits };
}

/** "999 999 999 9" (style "3331", the default) or "999 999 9999" (style "334"). */
export function formatAddress(address, style = '3331') {
  const a = String(address);
  if (!/^\d{10}$/.test(a)) return a;
  return style === '334' ? `${a.slice(0, 3)} ${a.slice(3, 6)} ${a.slice(6)}` : `${a.slice(0, 3)} ${a.slice(3, 6)} ${a.slice(6, 9)} ${a.slice(9)}`;
}

/** The public relay topic where a machine with this address listens for remote desktop calls. */
export function addressTopic(address) {
  const h = crypto.createHash('sha256').update(`hivedesk remote topic v1|${address}`).digest('base64url');
  return `hivedesk/r1/${h.slice(0, 22)}`;
}

/**
 * A known peer whose address equals this one but whose key differs, or null.
 * @param {string} address
 * @param {Array<{ peerId: string, publicKey: string }>} peers
 * @param {string} [ownKey]  the key the address was derived from, to skip the machine itself
 */
export function findCollision(address, peers, ownKey) {
  for (const p of peers || []) {
    if (!p?.publicKey || p.publicKey === ownKey) continue;
    try { if (deriveAddress(p.publicKey) === address) return p; } catch { /* not a valid key */ }
  }
  return null;
}

/** A stable avatar for an address: two letters of the name and a hue, so a person recognizes a caller. */
export function avatarFor(address, name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  const initials = (words.length > 1 ? words[0][0] + words[1][0] : (words[0] || '?').slice(0, 2)).toUpperCase();
  const hue = Number(BigInt(`0x${crypto.createHash('sha256').update(String(address)).digest('hex').slice(0, 8)}`) % 360n);
  return { initials, hue };
}
