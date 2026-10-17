// Writes the per-platform desktop runtime binaries that `npx hivedesk` downloads from the GitHub release
// (hivedesk-runtime-win-x64.exe, hivedesk-runtime-mac-arm64, ...), each checked against desktop/platform.js.
//   node desktop/scripts/runtime-assets.mjs <out dir>
import fs from 'node:fs';
import path from 'node:path';
import { RUNTIME, BINARIES, TARGETS, target } from '../platform.js';
import { sha256 } from '../runtime.js';
import { extractEntry } from '../zip.js';

const out = path.resolve(process.argv[2] || 'dist');
fs.mkdirSync(out, { recursive: true });
const res = await fetch(RUNTIME.zip.url, { redirect: 'follow' });
if (!res.ok) throw new Error(`HTTP ${res.status} for ${RUNTIME.zip.url}`);
const zip = Buffer.from(await res.arrayBuffer());
if (sha256(zip) !== RUNTIME.zip.sha256) throw new Error('runtime archive checksum mismatch');

const assets = new Map();
for (const key of Object.keys(TARGETS)) {
  const t = target(key);
  assets.set(t.asset, BINARIES[TARGETS[key].bin]);
}
assets.set('hivedesk-runtime-mac-universal', BINARIES.mac_universal);
for (const [asset, b] of assets) {
  const bin = extractEntry(zip, b.file);
  if (!bin || sha256(bin) !== b.sha256) throw new Error(`${b.file}: checksum mismatch`);
  fs.writeFileSync(path.join(out, asset), bin, { mode: 0o755 });
  console.log(`${asset}  ${b.sha256}`);
}
const lic = await fetch(RUNTIME.license);
if (!lic.ok) throw new Error('runtime license: HTTP ' + lic.status);
fs.writeFileSync(path.join(out, 'hivedesk-runtime-LICENSE.txt'), Buffer.from(await lic.arrayBuffer()));
console.log('hivedesk-runtime-LICENSE.txt');
