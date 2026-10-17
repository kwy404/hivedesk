// Reads one file out of a zip archive in memory (stored or deflated entries). No dependencies.
import zlib from 'node:zlib';

/**
 * @param {Buffer} buf the whole zip file
 * @param {string} name the entry name, for example "neutralino-win_x64.exe"
 * @returns {Buffer | null}
 */
export function extractEntry(buf, name) {
  // End of central directory: signature 0x06054b50 in the last 64 KB.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw Object.assign(new Error('not a zip file'), { code: 'bad_zip' });
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw Object.assign(new Error('broken zip directory'), { code: 'bad_zip' });
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localAt = buf.readUInt32LE(p + 42);
    const entry = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (entry === name) {
      if (buf.readUInt32LE(localAt) !== 0x04034b50) throw Object.assign(new Error('broken zip entry'), { code: 'bad_zip' });
      const start = localAt + 30 + buf.readUInt16LE(localAt + 26) + buf.readUInt16LE(localAt + 28);
      const data = buf.subarray(start, start + compSize);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return zlib.inflateRawSync(data);
      throw Object.assign(new Error(`zip method ${method} is not supported`), { code: 'bad_zip' });
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}
