// Creates the Ed25519 key pair that signs the update manifest (latest.json) of every release.
//   node desktop/scripts/update-keygen.mjs [--out <private key file>] [--force]
// The private key goes OUTSIDE the repository (default ~/.hivedesk-release/update-key.pem, mode 600) and
// then into the HIVEDESK_UPDATE_KEY secret of the GitHub repository (desktop/RELEASE.md has the command).
// The public key is written into desktop/update/pubkey.js, which the app embeds.
// Refuses to replace an existing private key without --force: a new key means every installed copy built
// with the old public key stops accepting updates.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rawPublicKey } from '../update/manifest.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const args = process.argv.slice(2);
const at = args.indexOf('--out');
const out = path.resolve(at >= 0 ? args[at + 1] : path.join(os.homedir(), '.hivedesk-release', 'update-key.pem'));
const force = args.includes('--force');

const rel = path.relative(ROOT, out);
if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
  console.error(`update-keygen: ${out} is inside the repository; keep the private key outside it`);
  process.exit(2);
}

let pem;
if (fs.existsSync(out) && !force) {
  pem = fs.readFileSync(out, 'utf8');
  console.log(`update-keygen: keeping the existing private key ${out}`);
} else {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  pem = privateKey.export({ format: 'pem', type: 'pkcs8' });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, pem, { mode: 0o600 });
  try { fs.chmodSync(out, 0o600); } catch { /* Windows: the user profile ACL protects it */ }
  console.log(`update-keygen: private key written to ${out}`);
}
const pub = rawPublicKey(pem);
const file = path.join(ROOT, 'desktop', 'update', 'pubkey.js');
fs.writeFileSync(file, [
  '// The public half of the update signing key (Ed25519, raw 32 bytes in base64). The app accepts an update',
  '// manifest only when its signature checks against this key. Written by desktop/scripts/update-keygen.mjs.',
  `export const UPDATE_PUBLIC_KEY = '${pub}';`,
  ''
].join('\n'));
console.log(`update-keygen: public key ${pub} written to ${path.relative(ROOT, file)}`);
