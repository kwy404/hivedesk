// Small encodings for the P2P control plane: lower case base32 (RFC 4648 alphabet, no padding),
// base64url, and a canonical JSON form (sorted keys) for everything that is hashed or signed.

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** Lower case base32 without padding. 32 bytes give 52 characters. */
export function base32(bytes) {
  const buf = Buffer.from(bytes);
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of buf) {
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

export const isBase32 = (s, len) => typeof s === 'string' && (len === undefined || s.length === len) && /^[a-z2-7]*$/.test(s);

export const b64u = (bytes) => Buffer.from(bytes).toString('base64url');

/**
 * Decodes base64url and checks the length. Throws a TypeError on anything else, so a peer
 * cannot smuggle padding, other alphabets or the wrong size into a key field.
 */
export function fromB64u(text, length) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text)) throw new TypeError('not base64url');
  const buf = Buffer.from(text, 'base64url');
  if (buf.toString('base64url') !== text) throw new TypeError('not canonical base64url');
  if (length !== undefined && buf.length !== length) throw new TypeError(`expected ${length} bytes`);
  return buf;
}

/** JSON with object keys sorted at every level; undefined values are dropped. */
export function canonical(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('non finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonical(v))).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}
