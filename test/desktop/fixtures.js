// Archive builders for the desktop tests: real zip and tar.gz files made in memory.
import zlib from 'node:zlib';

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * @param {Record<string, Buffer | string | { data: Buffer | string, mode?: number, link?: string }>} files
 */
export function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, v] of Object.entries(files)) {
    const spec = Buffer.isBuffer(v) || typeof v === 'string' ? { data: v } : v;
    const data = Buffer.from(spec.link ?? spec.data ?? '');
    const comp = zlib.deflateRawSync(data);
    const nameBuf = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc32(data), 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameBuf.length, 26);
    const ch = Buffer.alloc(46);
    const mode = spec.link ? 0o120777 : spec.mode ? 0o100000 | spec.mode : 0;
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(mode ? (3 << 8) | 20 : 20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc32(data), 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE((mode << 16) >>> 0, 38);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, nameBuf, comp);
    centrals.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centrals.length / 2, 8); end.writeUInt16LE(centrals.length / 2, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** A ustar .tar.gz: files with modes, plus directories and symbolic links. */
export function makeTarGz(files) {
  const blocks = [];
  const header = (name, size, type, mode, link = '') => {
    const h = Buffer.alloc(512);
    h.write(name, 0, 100);
    h.write(`${mode.toString(8).padStart(7, '0')}\0`, 100);
    h.write('0000000\0', 108); h.write('0000000\0', 116);
    h.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
    h.write('00000000000\0', 136);
    h.write('        ', 148);
    h.write(type, 156);
    h.write(link, 157, 100);
    h.write('ustar\0', 257); h.write('00', 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    return h;
  };
  for (const [name, v] of Object.entries(files)) {
    const spec = Buffer.isBuffer(v) || typeof v === 'string' ? { data: v } : v;
    if (name.endsWith('/')) { blocks.push(header(name, 0, '5', 0o755)); continue; }
    if (spec.link) { blocks.push(header(name, 0, '2', 0o777, spec.link)); continue; }
    const data = Buffer.from(spec.data);
    blocks.push(header(name, data.length, '0', spec.mode || 0o644));
    blocks.push(data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks));
}

/** A fake fetch over a map of URL to Buffer, with Range support and a request log. */
export function fakeFetch(routes, { failAfter = null, ignoreRange = false } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const range = init.headers?.range || init.headers?.Range;
    calls.push({ url, range });
    const body = typeof routes === 'function' ? routes(url) : routes[url];
    if (body === undefined) return { ok: false, status: 404, headers: new Map(), arrayBuffer: async () => new ArrayBuffer(0) };
    let buf = Buffer.from(body);
    let status = 200;
    const headers = new Map();
    if (range && !ignoreRange) {
      const from = Number(/bytes=(\d+)-/.exec(range)[1]);
      if (from >= buf.length) return { ok: false, status: 416, headers, arrayBuffer: async () => new ArrayBuffer(0) };
      headers.set('content-range', `bytes ${from}-${buf.length - 1}/${buf.length}`);
      buf = buf.subarray(from);
      status = 206;
    }
    const cut = failAfter !== null && calls.length === 1 ? failAfter : null;
    const res = {
      ok: true, status, headers: { get: (k) => headers.get(k.toLowerCase()) ?? null },
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length),
      body: {
        getReader() {
          let i = 0;
          const chunk = 1000;
          return {
            async read() {
              if (cut !== null && i >= cut) throw new Error('connection reset');
              if (i >= buf.length) return { done: true };
              const end = Math.min(buf.length, i + chunk, cut ?? Infinity);
              const value = new Uint8Array(buf.subarray(i, end));
              i = end;
              return { done: false, value };
            }
          };
        }
      }
    };
    return res;
  };
  fn.calls = calls;
  return fn;
}
