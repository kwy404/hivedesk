// Extracts a .tar.gz (ustar, GNU long names, pax paths) into a folder, keeping modes and symbolic links.
// Entries that would leave the folder are refused. Used for the Linux package of the updater.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { safeEntryPath } from '../zip.js';

const str = (b, s, n) => { const x = b.subarray(s, s + n); const z = x.indexOf(0); return x.toString('utf8', 0, z < 0 ? n : z); };
const oct = (b, s, n) => parseInt(str(b, s, n).trim() || '0', 8);

/**
 * @param {Buffer} gz
 * @param {string} dest
 * @param {{ strip?: number }} [o]
 * @returns {number} files written
 */
export function extractTarGz(gz, dest, o = {}) {
  const buf = zlib.gunzipSync(gz);
  let p = 0;
  let files = 0;
  let longName = null;
  let paxPath = null;
  const bad = (m) => Object.assign(new Error(m), { code: 'bad_tar' });
  while (p + 512 <= buf.length) {
    const h = buf.subarray(p, p + 512);
    if (h.every((b) => b === 0)) break;
    const size = oct(h, 124, 12);
    const type = String.fromCharCode(h[156] || 48);
    const body = buf.subarray(p + 512, p + 512 + size);
    p += 512 + Math.ceil(size / 512) * 512;
    if (type === 'L') { longName = str(body, 0, body.length); continue; }
    if (type === 'x') {
      const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString('utf8'));
      paxPath = m ? m[1] : null;
      continue;
    }
    if (type === 'g') continue;
    const prefix = str(h, 345, 155);
    const name = paxPath || longName || (prefix ? `${prefix}/${str(h, 0, 100)}` : str(h, 0, 100));
    longName = null;
    paxPath = null;
    const rel = safeEntryPath(name, o.strip || 0);
    if (rel === null) {
      if (safeEntryPath(name, 0) === null) throw bad(`unsafe path in tar: ${name}`);
      continue;
    }
    const out = path.join(dest, ...rel.split('/'));
    const mode = oct(h, 100, 8) & 0o777;
    if (type === '5') { fs.mkdirSync(out, { recursive: true }); continue; }
    fs.mkdirSync(path.dirname(out), { recursive: true });
    if (type === '2') {
      const target = str(h, 157, 100);
      if (path.isAbsolute(target) || safeEntryPath(path.posix.join(path.posix.dirname(rel), target)) === null) throw bad(`unsafe link in tar: ${name}`);
      fs.rmSync(out, { force: true });
      fs.symlinkSync(target, out);
      files++;
      continue;
    }
    if (type !== '0' && type !== '\0' && type !== '7') continue;
    fs.writeFileSync(out, body);
    try { fs.chmodSync(out, mode || 0o644); } catch { /* Windows */ }
    files++;
  }
  return files;
}
