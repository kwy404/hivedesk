// The domain strings in the user's language. Keys live in i18n/parts/domains.<locale>.json until the
// core stream merges them into i18n/<locale>.json; this reads the merged table first, then the parts
// file of the locale, then the English parts file, then the English text given by the caller.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { say, localeOf } from '../say.js';
import { format } from '../../../i18n/index.js';

const PARTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'i18n', 'parts');
const tables = new Map();

function part(code) {
  if (!tables.has(code)) {
    let t = {};
    try { t = JSON.parse(fs.readFileSync(path.join(PARTS, `domains.${code}.json`), 'utf8')); } catch { /* not translated yet */ }
    tables.set(code, t);
  }
  return tables.get(code);
}

/** One domain string: key in the locale, else the given English text. */
export function tr(lang, key, params = {}, fallback = key) {
  const code = localeOf(lang);
  const merged = say(code, key, params);
  if (merged !== key) return merged;
  const msg = part(code)[key] ?? part('en')[key] ?? fallback;
  try { return format(code, msg, params); } catch { return msg; }
}

/** Whether a key has a translation in that locale (tests). */
export function hasPart(lang, key) {
  return Object.prototype.hasOwnProperty.call(part(localeOf(lang)), key);
}
