// Downloads one official Node.js build for a package, checks it against SHASUMS256.txt and extracts it.
//   node desktop/scripts/fetch-node.mjs --version v24.21.0 --platform win-x64|darwin-x64|darwin-arm64|linux-x64 --out <dir>
// Prints the path of the node binary. Uses the system tar (Windows 10+, macOS and Linux all have one).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const o = {};
for (let i = 2; i < process.argv.length; i += 2) o[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
if (!/^v\d+\.\d+\.\d+$/.test(o.version || '') || !o.platform || !o.out) {
  console.error('usage: fetch-node.mjs --version vX.Y.Z --platform win-x64|darwin-x64|darwin-arm64|linux-x64 --out <dir>');
  process.exit(2);
}
const ext = o.platform.startsWith('win') ? 'zip' : o.platform.startsWith('linux') ? 'tar.xz' : 'tar.gz';
const name = `node-${o.version}-${o.platform}`;
const file = `${name}.${ext}`;
const base = `https://nodejs.org/dist/${o.version}`;

const get = async (url) => {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
};
const sums = (await get(`${base}/SHASUMS256.txt`)).toString('utf8');
const want = sums.split('\n').find((l) => l.trim().endsWith(`  ${file}`))?.split(/\s+/)[0];
if (!want) throw new Error(`${file} is not in SHASUMS256.txt`);
const archive = await get(`${base}/${file}`);
const got = crypto.createHash('sha256').update(archive).digest('hex');
if (got !== want) throw new Error(`${file}: checksum mismatch`);
const out = path.resolve(o.out);
fs.mkdirSync(out, { recursive: true });
const archivePath = path.join(out, file);
fs.writeFileSync(archivePath, archive);
// On Windows use the system bsdtar (it reads zip files); a GNU tar from Git for Windows does not.
const sysTar = path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'tar.exe');
const tar = process.platform === 'win32' && fs.existsSync(sysTar) ? sysTar : 'tar';
execFileSync(tar, ['-xf', archivePath, '-C', out], { stdio: 'inherit' });
fs.rmSync(archivePath);
const bin = o.platform.startsWith('win') ? path.join(out, name, 'node.exe') : path.join(out, name, 'bin', 'node');
if (!fs.existsSync(bin)) throw new Error(`node binary not found after extracting ${file}`);
console.log(bin);
