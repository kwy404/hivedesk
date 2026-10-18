// What the crew says to the user, in the user's language: the same i18n/<locale>.json files the
// desktop uses. A chat message keeps its key and parameters too, so the desktop can show it again
// in another language after a switch.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODES, FALLBACK, LOCALES, match, translator } from '../../i18n/index.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'i18n');
const tables = new Map();

function table(code) {
  if (!tables.has(code)) {
    let messages = {};
    try { messages = JSON.parse(fs.readFileSync(path.join(DIR, `${code}.json`), 'utf8')); } catch { /* missing file: English */ }
    tables.set(code, messages);
  }
  return tables.get(code);
}

/** A supported locale code for any tag ("pt", "pt-BR", "en-US"), or English. */
export function localeOf(tag) {
  if (typeof tag === 'string' && CODES.includes(tag)) return tag;
  return match(tag) || FALLBACK;
}

/** The name of a locale in its own language, for model prompts ("Português (Brasil)"). */
export function languageName(code) {
  return LOCALES.find((l) => l.code === localeOf(code))?.name || 'English';
}

/** One message in a locale. */
export function say(lang, key, params) {
  const code = localeOf(lang);
  return translator(code, table(code), table(FALLBACK))(key, params);
}

/** The raw message of a key in a locale (lexicons like voice.lex.build). */
export function raw(lang, key) {
  return table(localeOf(lang))[key] ?? table(FALLBACK)[key] ?? '';
}
