// A small zip reader (stored and deflate entries) for extension installs. No dependencies.
import zlib from 'node:zlib';

export const MAX_FILES = 200;
export const MAX_BYTES = 5 * 1024 * 1024;

/**
 * Reads every file of a zip into memory, refusing paths that leave the folder.
 * When all entries share one top folder (a zipped folder), that folder is stripped.
 * @param {Buffer} buf
 * @returns {Map<string, Buffer>} relative path with "/" separators -> content
 */
export function readZip(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('not a zip file');
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error('not a zip file (no end of central directory)');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  if (count > MAX_FILES) throw new Error(`the zip has ${count} entries, at most ${MAX_FILES} are allowed`);
  const out = new Map();
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('broken zip central directory');
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const usize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const local = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen).replace(/\\/g, '/');
    off += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    const parts = name.split('/');
    if (name.startsWith('/') || /^[A-Za-z]:/.test(name) || parts.some((p) => p === '..' || p === '') || name.includes('\0')) {
      throw new Error(`the zip contains an unsafe path: ${name}`);
    }
    total += usize;
    if (total > MAX_BYTES) throw new Error(`the zip unpacks to more than ${MAX_BYTES / 1024 / 1024} MB`);
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error('broken zip local header');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw, { maxOutputLength: MAX_BYTES });
    else throw new Error(`unsupported zip compression method ${method} in ${name}`);
    if (data.length !== usize) throw new Error(`size mismatch in ${name}`);
    out.set(name, data);
  }
  const tops = new Set([...out.keys()].map((k) => (k.includes('/') ? k.split('/')[0] : '')));
  if (tops.size === 1 && !tops.has('')) {
    const top = [...tops][0] + '/';
    return new Map([...out].map(([k, v]) => [k.slice(top.length), v]));
  }
  return out;
}

/** Writes a zip with stored (or deflated) entries. Used by the tests and the export of dev extensions. */
export function writeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of files) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(String(content));
    const comp = zlib.deflateRawSync(data);
    const nameBuf = Buffer.from(name);
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.size ?? files.length, 8); end.writeUInt16LE(files.size ?? files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

let table;
function crc32(buf) {
  if (!table) {
    table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[i] = c >>> 0; }
  }
  let c = 0xffffffff;
  for (const b of buf) c = table[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
