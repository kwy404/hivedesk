// Desktop strings (cli.desktop.* keys) in the 10 UI languages, through the shared i18n/ formatter.
// The shared i18n/<locale>.json wins when it has a key; desktop/i18n.json is the built in copy.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BUILTIN = JSON.parse(fs.readFileSync(path.join(HERE, 'i18n.json'), 'utf8'));

let shared = null;
async function sharedI18n() {
  if (shared !== null) return shared;
  try { shared = await import('../i18n/index.js'); } catch { shared = false; }
  return shared;
}

function readShared(locale) {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'i18n', `${locale}.json`), 'utf8')); } catch { return {}; }
}

/** The locale: HIVEDESK_LANG, the wizard answer, then the OS language; English when unknown. */
export function pickLocale({ env = process.env, configLang, match } = {}) {
  const codes = Object.keys(BUILTIN);
  const m = match || ((tags) => {
    for (const raw of [].concat(tags || [])) {
      const tag = String(raw || '').replace(/_/g, '-').replace(/\..*$/, '').trim().toLowerCase();
      if (!tag || tag === 'c' || tag === 'posix') continue;
      const exact = codes.find((c) => c.toLowerCase() === tag);
      if (exact) return exact;
      const lang = tag.split('-')[0];
      const byLang = codes.find((c) => c.split('-')[0].toLowerCase() === lang);
      if (byLang) return byLang;
    }
    return null;
  });
  let intl = '';
  try { intl = Intl.DateTimeFormat().resolvedOptions().locale; } catch { /* none */ }
  return m([env.HIVEDESK_LANG, configLang === 'pt' ? 'pt-BR' : configLang, env.LC_ALL, env.LC_MESSAGES, env.LANG, env.LANGUAGE, intl]) || 'en';
}

const simpleFormat = (msg, params = {}) => String(msg).replace(/\{(\w+)\}/g, (_, k) => (params[k] == null ? '' : String(params[k])));

/** A translate function for cli.desktop.* keys, plus the locale and a byte formatter. */
export async function desktopStrings(locale = 'en') {
  const lib = await sharedI18n();
  const table = { ...BUILTIN.en, ...(BUILTIN[locale] || {}), ...pick(readShared(locale)) };
  const fallback = { ...BUILTIN.en, ...pick(readShared('en')) };
  const t = (key, params) => {
    const msg = table[key] ?? fallback[key];
    if (msg == null) return key;
    return lib && lib.format ? lib.format(locale, msg, params) : simpleFormat(msg, params);
  };
  return { t, locale, bytes: (n) => formatBytes(n, locale), table };
}

function pick(messages) {
  const out = {};
  for (const [k, v] of Object.entries(messages || {})) if (k.startsWith('cli.desktop.')) out[k] = v;
  return out;
}

/** "2.7 MB" in English, "2,7 MB" in Portuguese. */
export function formatBytes(n, locale = 'en') {
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = Number(n) || 0;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
  let s;
  try { s = new Intl.NumberFormat(locale, { maximumFractionDigits: i >= 2 ? 1 : 0 }).format(v); } catch { s = v.toFixed(1); }
  return `${s} ${units[i]}`;
}

export const BUILTIN_STRINGS = BUILTIN;
