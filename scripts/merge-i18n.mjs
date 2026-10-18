// Merges the per stream string parts into the locale files (PLAN.md section 15: Stream 1 merges i18n).
//   i18n/parts/<stream>.en.json      the English strings of a stream
//   i18n/parts/<stream>.<code>.json  their translation for one locale
// Keys stay sorted. A part key that already exists with another English text is reported, never overwritten.
// A part without a translation file for every locale waits (it is listed as pending): the UI shows its English meanwhile.
// Usage: node scripts/merge-i18n.mjs [--check]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODES } from '../i18n/index.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'i18n');
const PARTS = path.join(DIR, 'parts');
const check = process.argv.includes('--check');

const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const sorted = (obj) => Object.fromEntries(Object.keys(obj).sort().map((k) => [k, obj[k]]));

const streams = fs.existsSync(PARTS) ? fs.readdirSync(PARTS).filter((f) => f.endsWith('.en.json')).map((f) => f.slice(0, -'.en.json'.length)) : [];
const problems = [];
const pending = [];
let added = 0;
const en = read(path.join(DIR, 'en.json'));
const locales = Object.fromEntries(CODES.filter((c) => c !== 'en').map((c) => [c, read(path.join(DIR, `${c}.json`))]));
for (const stream of streams) {
  const missingLocales = Object.keys(locales).filter((code) => !fs.existsSync(path.join(PARTS, `${stream}.${code}.json`)));
  if (missingLocales.length) { pending.push(`${stream} (no ${missingLocales.join(', ')})`); continue; }
  const part = read(path.join(PARTS, `${stream}.en.json`));
  for (const [k, v] of Object.entries(part)) {
    if (k in en && en[k] !== v) { problems.push(`${stream}: ${k} already exists with another English text`); continue; }
    if (!(k in en)) added += 1;
    en[k] = v;
  }
  for (const code of Object.keys(locales)) {
    const file = path.join(PARTS, `${stream}.${code}.json`);
    const tr = fs.existsSync(file) ? read(file) : {};
    for (const k of Object.keys(part)) {
      if (typeof tr[k] === 'string' && tr[k].trim()) locales[code][k] = tr[k];
      else if (!(k in locales[code])) problems.push(`${stream}: ${code} has no translation for ${k}`);
    }
  }
}
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
const merged = streams.length - pending.length;
if (pending.length) console.log(`pending, not translated yet: ${pending.join('; ')}`);
if (check) {
  console.log(`i18n parts: ${merged} streams ready, ${added} keys not merged yet`);
} else {
  fs.writeFileSync(path.join(DIR, 'en.json'), JSON.stringify(sorted(en), null, 2) + '\n');
  for (const [code, m] of Object.entries(locales)) fs.writeFileSync(path.join(DIR, `${code}.json`), JSON.stringify(sorted(m), null, 2) + '\n');
  console.log(`i18n parts merged: ${merged} streams, ${added} new keys`);
}
