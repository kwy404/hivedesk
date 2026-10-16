// Adapted from howlden (MIT, Alexandre Kohler), app/core/sha256.js. The same code also runs in filefinch.
// Incremental SHA-256 (FIPS 180-4). WebCrypto only hashes a whole buffer at once, which would
// force a large file into memory, so this hashes chunk by chunk as they stream past.
// The state can be saved and restored, which lets an interrupted transfer continue its hash.

import { toHex } from './bytes.js';

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const INIT = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

export class Sha256 {
  constructor() {
    this.h = new Uint32Array(INIT);
    this.w = new Uint32Array(64);
    this.buf = new Uint8Array(64);
    this.bufLen = 0;
    this.length = 0; // bytes hashed so far, exact up to 2^53
    this.done = false;
  }

  /** Feeds more bytes. Returns this for chaining. */
  update(data) {
    if (this.done) throw new Error('Hash already finalized');
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    let i = 0;
    const n = bytes.length;
    this.length += n;
    if (this.bufLen > 0) {
      const take = Math.min(64 - this.bufLen, n);
      this.buf.set(bytes.subarray(0, take), this.bufLen);
      this.bufLen += take;
      i = take;
      if (this.bufLen < 64) return this;
      this.block(this.buf, 0);
      this.bufLen = 0;
    }
    for (; i + 64 <= n; i += 64) this.block(bytes, i);
    if (i < n) {
      this.buf.set(bytes.subarray(i), 0);
      this.bufLen = n - i;
    }
    return this;
  }

  block(d, o) {
    const w = this.w;
    const h = this.h;
    for (let t = 0; t < 16; t++, o += 4) w[t] = (d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3];
    for (let t = 16; t < 64; t++) {
      const a = w[t - 15];
      const b = w[t - 2];
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
    }
    let a = h[0], b = h[1], c = h[2], e = h[4], f = h[5], g = h[6], dd = h[3], hh = h[7];
    for (let t = 0; t < 64; t++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[t] + w[t]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      hh = g;
      g = f;
      f = e;
      e = (dd + t1) | 0;
      dd = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] = (h[0] + a) | 0;
    h[1] = (h[1] + b) | 0;
    h[2] = (h[2] + c) | 0;
    h[3] = (h[3] + dd) | 0;
    h[4] = (h[4] + e) | 0;
    h[5] = (h[5] + f) | 0;
    h[6] = (h[6] + g) | 0;
    h[7] = (h[7] + hh) | 0;
  }

  /** Returns the 32 byte digest. The object can no longer be updated afterwards. */
  digest() {
    if (this.done) return this.result;
    const bitsHigh = Math.floor(this.length / 0x20000000);
    const bitsLow = (this.length * 8) >>> 0;
    const pad = new Uint8Array(this.bufLen < 56 ? 64 - this.bufLen : 128 - this.bufLen);
    pad[0] = 0x80;
    const tail = new Uint8Array(8);
    tail[0] = bitsHigh >>> 24;
    tail[1] = bitsHigh >>> 16;
    tail[2] = bitsHigh >>> 8;
    tail[3] = bitsHigh;
    tail[4] = bitsLow >>> 24;
    tail[5] = bitsLow >>> 16;
    tail[6] = bitsLow >>> 8;
    tail[7] = bitsLow;
    const length = this.length;
    this.update(pad.subarray(0, pad.length - 8));
    this.update(tail);
    this.length = length;
    const out = new Uint8Array(32);
    for (let i = 0; i < 8; i++) {
      out[i * 4] = this.h[i] >>> 24;
      out[i * 4 + 1] = this.h[i] >>> 16;
      out[i * 4 + 2] = this.h[i] >>> 8;
      out[i * 4 + 3] = this.h[i];
    }
    this.done = true;
    this.result = out;
    return out;
  }

  hex() {
    return toHex(this.digest());
  }

  /** A plain object that restore() turns back into a hasher at the same position. */
  save() {
    if (this.done) throw new Error('Hash already finalized');
    return { h: Array.from(this.h), buf: Array.from(this.buf.subarray(0, this.bufLen)), length: this.length };
  }

  static restore(state) {
    const s = new Sha256();
    if (!state || !Array.isArray(state.h) || state.h.length !== 8) throw new Error('Invalid hash state');
    s.h.set(state.h.map((x) => x >>> 0));
    s.buf.set(state.buf);
    s.bufLen = state.buf.length;
    s.length = state.length;
    return s;
  }

  clone() {
    return Sha256.restore(this.save());
  }
}

/** One shot helper. */
export const sha256Hex = (data) => new Sha256().update(data).hex();
