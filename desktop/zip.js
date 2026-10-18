// Reads one file out of a zip archive in memory, or extracts a whole zip (stored or deflated entries). No dependencies.
import fs from 'node:fs';
import path from 'node:path';
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

/** A relative path inside an archive that cannot escape the target folder, or null. */
export function safeEntryPath(name, strip = 0) {
  const parts = String(name).split(/[\\/]/).filter((p) => p !== '' && p !== '.');
  if (parts.some((p) => p === '..' || /^[A-Za-z]:$/.test(p))) return null;
  if (/^([A-Za-z]:)?[\\/]/.test(name)) return null;
  const rest = parts.slice(strip);
  return rest.length ? rest.join('/') : null;
}

/**
 * Extracts a whole zip (stored or deflated, no ZIP64) into a folder. Keeps the Unix modes and symbolic
 * links that zips made on macOS and Linux carry. Entries that would leave the folder are refused.
 * @param {Buffer} buf
 * @param {string} dest
 * @param {{ strip?: number }} [o] strip: leading path parts to drop ("hivedesk/" of the packages)
 * @returns {number} the number of files written
 */
export function extractZip(buf, dest, o = {}) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw Object.assign(new Error('not a zip file'), { code: 'bad_zip' });
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || p === 0xffffffff) throw Object.assign(new Error('ZIP64 archives are not supported'), { code: 'bad_zip' });
  let files = 0;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw Object.assign(new Error('broken zip directory'), { code: 'bad_zip' });
    const madeBy = buf.readUInt16LE(p + 4) >> 8;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const ext = buf.readUInt32LE(p + 38);
    const localAt = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    const rel = safeEntryPath(name, o.strip || 0);
    if (rel === null) {
      if (safeEntryPath(name, 0) === null) throw Object.assign(new Error(`unsafe path in zip: ${name}`), { code: 'bad_zip' });
      continue;
    }
    const out = path.join(dest, ...rel.split('/'));
    const mode = madeBy === 3 ? (ext >>> 16) & 0xffff : 0;
    const isDir = name.endsWith('/') || (mode & 0o170000) === 0o040000;
    if (isDir) { fs.mkdirSync(out, { recursive: true }); continue; }
    if (buf.readUInt32LE(localAt) !== 0x04034b50) throw Object.assign(new Error('broken zip entry'), { code: 'bad_zip' });
    const start = localAt + 30 + buf.readUInt16LE(localAt + 26) + buf.readUInt16LE(localAt + 28);
    const raw = buf.subarray(start, start + compSize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw Object.assign(new Error(`zip method ${method} is not supported`), { code: 'bad_zip' });
    if (data.length !== size) throw Object.assign(new Error(`size mismatch for ${name}`), { code: 'bad_zip' });
    fs.mkdirSync(path.dirname(out), { recursive: true });
    if ((mode & 0o170000) === 0o120000) {
      const target = data.toString('utf8');
      if (path.isAbsolute(target) || safeEntryPath(path.posix.join(path.posix.dirname(rel), target)) === null) throw Object.assign(new Error(`unsafe link in zip: ${name}`), { code: 'bad_zip' });
      fs.rmSync(out, { force: true });
      fs.symlinkSync(target, out);
    } else {
      fs.writeFileSync(out, data);
      if (mode & 0o777) { try { fs.chmodSync(out, mode & 0o777); } catch { /* Windows */ } }
    }
    files++;
  }
  return files;
}
