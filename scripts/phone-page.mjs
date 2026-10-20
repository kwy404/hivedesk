// Copies the shared browser modules the phone page needs into docs/remote/js/vendor/, keeping their
// relative layout, so the static page on GitHub Pages runs the very code the engine and the tests run.
// test/phone/page.test.js fails when a copy drifts from its source.
// Usage: node scripts/phone-page.mjs [--check]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const VENDOR = path.join(ROOT, 'docs', 'remote', 'js', 'vendor');
export const SHARED = [
  'lend/core/bytes.js', 'lend/core/emitter.js', 'lend/core/mqtt.js', 'lend/core/relay.js', 'lend/core/rtc.js', 'lend/core/rendezvous.js',
  'lend/core/pairing.js', 'lend/core/words.js', 'lend/core/wordlist.js', 'lend/core/sha256.js', 'lend/core/p2p-pipe.js',
  'phone/core/crypto.js', 'phone/core/invite.js', 'phone/core/handshake.js', 'phone/core/messages.js', 'phone/core/session.js',
  'phone/core/client.js', 'phone/core/grants.js', 'phone/core/connect.js',
  'remote/media.js', 'remote/abr.js', 'remote/pointer.js', 'js/md.js',
  '../i18n/index.js'
];
const HEADER = '// Copied from {file} by scripts/phone-page.mjs. Edit the source, then run the script.\n';
/** Where a copy lands: ui/x goes to vendor/x, i18n/index.js to vendor/i18n/index.js. */
export const target = (rel) => path.join(VENDOR, rel.startsWith('../') ? rel.slice(3) : rel);
const source = (rel) => path.join(ROOT, 'ui', rel);
const shown = (rel) => (rel.startsWith('../') ? rel.slice(3) : `ui/${rel}`);

export const expected = (rel) => HEADER.replace('{file}', shown(rel)) + fs.readFileSync(source(rel), 'utf8');

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  const stale = [];
  for (const rel of SHARED) {
    const out = target(rel);
    const want = expected(rel);
    const have = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : null;
    if (have === want) continue;
    stale.push(rel);
    if (!check) {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, want);
    }
  }
  if (check && stale.length) {
    console.error(`phone page: stale copies: ${stale.join(', ')}\nrun node scripts/phone-page.mjs`);
    process.exit(1);
  }
  console.log(check ? 'phone page: copies are current' : `phone page: ${stale.length} files written`);
}
