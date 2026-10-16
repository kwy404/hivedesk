// Adapted from howlden (MIT, Alexandre Kohler), app/core/qr.js. The same code also runs in filefinch.
// QR code encoder (ISO/IEC 18004), byte mode only, written from the spec.
// encodeQR() picks the smallest version that fits, adds Reed-Solomon error
// correction, interleaves the blocks, places the modules and tries all eight
// masks, keeping the one with the lowest penalty score.

const ECL = {
  L: { index: 0, bits: 1 },
  M: { index: 1, bits: 0 },
  Q: { index: 2, bits: 3 },
  H: { index: 3, bits: 2 },
};

// Error correction codewords per block, indexed [ecl][version].
const ECC_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];

// Number of error correction blocks, indexed [ecl][version].
const BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

/** Modules available for data and error correction in a version. */
export function rawModules(version) {
  let n = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    n -= (25 * align - 10) * align - 55;
    if (version >= 7) n -= 36;
  }
  return n;
}

/** Data codewords (bytes) a version holds at an error correction level. */
export function dataCodewords(version, ecl) {
  const e = ECL[ecl].index;
  return Math.floor(rawModules(version) / 8) - ECC_PER_BLOCK[e][version] * BLOCKS[e][version];
}

/** Largest byte payload a version holds in byte mode. */
export function byteCapacity(version, ecl) {
  const bits = dataCodewords(version, ecl) * 8 - 4 - (version < 10 ? 8 : 16);
  return Math.floor(bits / 8);
}

/** Center coordinates of the alignment patterns of a version. */
export function alignmentPositions(version) {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const out = [6];
  for (let pos = version * 4 + 10; out.length < count; pos -= step) out.splice(1, 0, pos);
  return out;
}

// GF(256) multiplication with the QR polynomial x^8 + x^4 + x^3 + x^2 + 1.
function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree) {
  const out = new Array(degree).fill(0);
  out[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      out[j] = gfMul(out[j], root);
      if (j + 1 < degree) out[j] ^= out[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return out;
}

/** Reed-Solomon remainder of data over the divisor polynomial. */
export function rsRemainder(data, degree) {
  const divisor = rsDivisor(degree);
  const out = new Array(degree).fill(0);
  for (const b of data) {
    const factor = b ^ out.shift();
    out.push(0);
    for (let i = 0; i < degree; i++) out[i] ^= gfMul(divisor[i], factor);
  }
  return out;
}

function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (Array.isArray(input)) return Uint8Array.from(input);
  return new TextEncoder().encode(String(input));
}

function pickVersion(length, ecl, minVersion, maxVersion) {
  for (let v = minVersion; v <= maxVersion; v++) if (length <= byteCapacity(v, ecl)) return v;
  return 0;
}

function buildCodewords(bytes, version, ecl) {
  const bits = [];
  const push = (value, count) => {
    for (let i = count - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  const capacity = dataCodewords(version, ecl) * 8;
  push(0, Math.min(4, capacity - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    data.push(b);
  }
  return data;
}

function interleave(data, version, ecl) {
  const e = ECL[ecl].index;
  const blockCount = BLOCKS[e][version];
  const eccLen = ECC_PER_BLOCK[e][version];
  const raw = Math.floor(rawModules(version) / 8);
  const shortCount = blockCount - (raw % blockCount);
  const shortLen = Math.floor(raw / blockCount);
  const blocks = [];
  for (let i = 0, k = 0; i < blockCount; i++) {
    const take = shortLen - eccLen + (i < shortCount ? 0 : 1);
    const dat = data.slice(k, k + take);
    k += take;
    const ecc = rsRemainder(dat, eccLen);
    if (i < shortCount) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const out = [];
  for (let i = 0; i < blocks[0].length; i++) {
    for (let j = 0; j < blocks.length; j++) {
      if (i !== shortLen - eccLen || j >= shortCount) out.push(blocks[j][i]);
    }
  }
  return out;
}

class Grid {
  constructor(version) {
    this.size = version * 4 + 17;
    this.dark = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
    this.fixed = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
  }

  set(x, y, dark) {
    this.dark[y][x] = dark;
    this.fixed[y][x] = true;
  }
}

function drawFunctionPatterns(g, version) {
  const n = g.size;
  for (let i = 0; i < n; i++) {
    g.set(6, i, i % 2 === 0);
    g.set(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [[3, 3], [n - 4, 3], [3, n - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= n || y >= n) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        g.set(x, y, d !== 2 && d !== 4);
      }
    }
  }
  const pos = alignmentPositions(version);
  const last = pos.length - 1;
  for (let i = 0; i < pos.length; i++) {
    for (let j = 0; j < pos.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) g.set(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }
  drawFormat(g, 'L', 0);
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const bit = ((bits >>> i) & 1) === 1;
      const a = n - 11 + (i % 3);
      const b = Math.floor(i / 3);
      g.set(a, b, bit);
      g.set(b, a, bit);
    }
  }
}

/** The 15 format bits for an error correction level and mask. */
export function formatBits(ecl, mask) {
  const data = (ECL[ecl].bits << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

function drawFormat(g, ecl, mask) {
  const bits = formatBits(ecl, mask);
  const bit = (i) => ((bits >>> i) & 1) === 1;
  const n = g.size;
  for (let i = 0; i <= 5; i++) g.set(8, i, bit(i));
  g.set(8, 7, bit(6));
  g.set(8, 8, bit(7));
  g.set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) g.set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) g.set(n - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) g.set(8, n - 15 + i, bit(i));
  g.set(8, n - 8, true);
}

function drawCodewords(g, codewords) {
  const n = g.size;
  let i = 0;
  const total = codewords.length * 8;
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < n; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? n - 1 - vert : vert;
        if (g.fixed[y][x] || i >= total) continue;
        g.dark[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
        i++;
      }
    }
  }
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function applyMask(g, mask) {
  const fn = MASKS[mask];
  for (let y = 0; y < g.size; y++) {
    for (let x = 0; x < g.size; x++) if (!g.fixed[y][x] && fn(x, y)) g.dark[y][x] = !g.dark[y][x];
  }
}

const FINDER_A = [true, false, true, true, true, false, true, false, false, false, false];
const FINDER_B = [false, false, false, false, true, false, true, true, true, false, true];

/** Penalty score of a module matrix (rules N1 to N4 of the spec). */
export function penalty(dark) {
  const n = dark.length;
  let score = 0;
  const line = (get) => {
    let run = 1;
    for (let i = 1; i <= n; i++) {
      if (i < n && get(i) === get(i - 1)) {
        run++;
      } else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
    for (let i = 0; i + 11 <= n; i++) {
      let a = true;
      let b = true;
      for (let k = 0; k < 11; k++) {
        const v = get(i + k);
        if (v !== FINDER_A[k]) a = false;
        if (v !== FINDER_B[k]) b = false;
      }
      if (a) score += 40;
      if (b) score += 40;
    }
  };
  for (let y = 0; y < n; y++) line((i) => dark[y][i]);
  for (let x = 0; x < n; x++) line((i) => dark[i][x]);
  let count = 0;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (dark[y][x]) count++;
      if (x + 1 < n && y + 1 < n) {
        const c = dark[y][x];
        if (c === dark[y][x + 1] && c === dark[y + 1][x] && c === dark[y + 1][x + 1]) score += 3;
      }
    }
  }
  const total = n * n;
  const k = Math.ceil(Math.abs(count * 20 - total * 10) / total) - 1;
  score += Math.max(0, k) * 10;
  return score;
}

/**
 * Encode text or bytes as a QR code.
 * @param {string|Uint8Array|number[]} input
 * @param {{ecl?: 'L'|'M'|'Q'|'H', minVersion?: number, maxVersion?: number, mask?: number, boost?: boolean}} [options]
 * @returns {{version: number, ecl: string, mask: number, size: number, modules: boolean[][]}}
 */
export function encodeQR(input, options = {}) {
  const bytes = toBytes(input);
  let ecl = options.ecl || 'M';
  if (!ECL[ecl]) throw new TypeError(`unknown error correction level ${ecl}`);
  const minVersion = options.minVersion || 1;
  const maxVersion = options.maxVersion || 40;
  const version = pickVersion(bytes.length, ecl, minVersion, maxVersion);
  if (!version) throw new RangeError(`data too long for a QR code (${bytes.length} bytes at level ${ecl})`);
  if (options.boost !== false) {
    for (const higher of ['M', 'Q', 'H']) {
      if (ECL[higher].index > ECL[ecl].index && bytes.length <= byteCapacity(version, higher)) ecl = higher;
    }
  }
  const codewords = interleave(buildCodewords(bytes, version, ecl), version, ecl);
  const g = new Grid(version);
  drawFunctionPatterns(g, version);
  drawCodewords(g, codewords);
  let mask = options.mask;
  if (mask === undefined) {
    let best = Infinity;
    for (let m = 0; m < 8; m++) {
      applyMask(g, m);
      drawFormat(g, ecl, m);
      const p = penalty(g.dark);
      if (p < best) {
        best = p;
        mask = m;
      }
      applyMask(g, m);
    }
  }
  applyMask(g, mask);
  drawFormat(g, ecl, mask);
  return { version, ecl, mask, size: g.size, modules: g.dark };
}

/** SVG path data for the dark modules, one unit per module, offset by margin. */
export function qrPath(qr, margin = 4) {
  let d = '';
  for (let y = 0; y < qr.size; y++) {
    let x = 0;
    while (x < qr.size) {
      if (!qr.modules[y][x]) {
        x++;
        continue;
      }
      const start = x;
      while (x < qr.size && qr.modules[y][x]) x++;
      d += `M${start + margin} ${y + margin}h${x - start}v1h${start - x}z`;
    }
  }
  return d;
}

/** A standalone SVG string for a QR code. Colors are plain CSS color values. */
export function qrSvg(qr, { margin = 4, dark = '#000', light = '#fff', title = 'QR code' } = {}) {
  const side = qr.size + margin * 2;
  const safe = (s) => String(s).replace(/[<>&"]/g, '');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}" shape-rendering="crispEdges" role="img"><title>${safe(title)}</title><rect width="${side}" height="${side}" fill="${safe(light)}"/><path d="${qrPath(qr, margin)}" fill="${safe(dark)}"/></svg>`;
}
