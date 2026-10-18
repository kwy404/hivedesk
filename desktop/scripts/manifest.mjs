// Writes and signs the update manifest of a release. Used by .github/workflows/desktop.yml.
//   HIVEDESK_UPDATE_KEY=<Ed25519 private key PEM> node desktop/scripts/manifest.mjs --dist dist --version 1.0.0
//     [--notes desktop/release-notes/1.0.0.json] [--tag v1.0.0]
//   HIVEDESK_UPDATE_KEY=... node desktop/scripts/manifest.mjs --check   (only checks the key, early in CI)
//   --skip-without-key: when HIVEDESK_UPDATE_KEY is empty, print a ::warning:: and exit 0 without writing
//     anything (a release without latest.json; sign it later with desktop/scripts/sign-release.mjs).
// Fails (exit 1) when the key is missing (without --skip-without-key), is not Ed25519, or does not match the
// public key the app embeds: an unsigned or wrongly signed manifest is never written. The key is never printed.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildManifest, signManifest, verifyManifest, rawPublicKey, ASSETS, MANIFEST_NAME, SIGNATURE_NAME, LOCALES } from '../update/manifest.js';
import { UPDATE_PUBLIC_KEY } from '../update/pubkey.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const checkOnly = process.argv.includes('--check');
const skipWithoutKey = process.argv.includes('--skip-without-key');
const opts = {};
const args = process.argv.slice(2).filter((a) => a !== '--check' && a !== '--skip-without-key');
for (let i = 0; i < args.length; i += 2) opts[args[i].replace(/^--/, '')] = args[i + 1];
const die = (msg) => { console.error(`::error::${msg}`); console.error(`manifest: ${msg}`); process.exit(1); };

if (!checkOnly && (!opts.dist || !opts.version)) die('usage: manifest.mjs --dist <dir> --version <x.y.z> [--notes <json>] [--tag <tag>]');
const key = (process.env.HIVEDESK_UPDATE_KEY || '').trim();
if (!key && skipWithoutKey) {
  console.log(`::warning::HIVEDESK_UPDATE_KEY is not set: ${checkOnly ? 'the key check is skipped' : 'no latest.json is written'}. Installed apps will not see this release as an update until it is signed with desktop/scripts/sign-release.mjs (desktop/RELEASE.md).`);
  process.exit(0);
}
if (!key) die('HIVEDESK_UPDATE_KEY is not set. The release stops here instead of publishing an unsigned update manifest. See desktop/RELEASE.md.');
let pub;
try { pub = rawPublicKey(key); } catch (err) { die(`HIVEDESK_UPDATE_KEY is not a readable private key (${err.message})`); }
if (pub !== UPDATE_PUBLIC_KEY) die(`HIVEDESK_UPDATE_KEY does not match the public key in desktop/update/pubkey.js (${UPDATE_PUBLIC_KEY}); installed apps would reject this manifest`);
if (checkOnly) { console.log('manifest: HIVEDESK_UPDATE_KEY is set and matches the embedded public key'); process.exit(0); }

const notesFile = opts.notes || path.join(ROOT, 'desktop', 'release-notes', `${opts.version}.json`);
let notes;
try { notes = JSON.parse(fs.readFileSync(notesFile, 'utf8')); } catch { die(`no release notes at ${notesFile}`); }
const missing = LOCALES.filter((l) => typeof notes[l] !== 'string' || !notes[l].trim());
if (missing.length) die(`release notes miss ${missing.join(', ')}`);

const files = {};
for (const name of Object.values(ASSETS)) {
  const p = path.join(opts.dist, name);
  if (!fs.existsSync(p)) { console.warn(`manifest: ${name} is not in ${opts.dist}, left out`); continue; }
  const buf = fs.readFileSync(p);
  files[name] = { size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
}
if (!Object.keys(files).length) die('no app packages found');
const manifest = buildManifest({ version: opts.version, tag: opts.tag, notes, files });
const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
const sig = signManifest(bytes, key);
verifyManifest(bytes, sig, UPDATE_PUBLIC_KEY);
fs.writeFileSync(path.join(opts.dist, MANIFEST_NAME), bytes);
fs.writeFileSync(path.join(opts.dist, SIGNATURE_NAME), `${sig}\n`);
console.log(`manifest: ${MANIFEST_NAME} for ${manifest.version} (${manifest.channel}) with ${Object.keys(manifest.assets).join(', ')}, signed and verified`);
