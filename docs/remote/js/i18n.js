// Languages of the phone page: the 10 hivedesk locales, picked from the saved choice, then the
// browser languages, then English. Strings live in docs/remote/i18n/<code>.json (flat keys, ICU style
// plurals through the shared formatter).

import { LOCALES, CODES, FALLBACK, match, format } from './vendor/i18n/index.js';

const KEY = 'hivedesk.remote.lang';
let code = FALLBACK;
let messages = {};
let english = {};

export { LOCALES, CODES };
export const locale = () => code;

async function load(c) {
  const r = await fetch(`i18n/${c}.json`, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`i18n/${c}.json: ${r.status}`);
  return r.json();
}

export function detect() {
  let saved = null;
  try { saved = localStorage.getItem(KEY); } catch { /* private mode */ }
  if (saved && CODES.includes(saved)) return saved;
  return match([...(navigator.languages || []), navigator.language].filter(Boolean)) || FALLBACK;
}

export async function init(c = detect()) {
  english = await load('en');
  code = CODES.includes(c) ? c : FALLBACK;
  messages = code === 'en' ? english : await load(code).catch(() => english);
  document.documentElement.lang = code;
  document.documentElement.dir = 'ltr';
  return code;
}

export async function setLocale(c) {
  try { localStorage.setItem(KEY, c); } catch { /* private mode */ }
  return init(c);
}

/** Translates a key; missing keys fall back to English, then to the key. */
export function t(key, params) {
  const msg = messages[key] ?? english[key];
  return msg == null ? key : format(code, msg, params || {});
}

export function ago(iso) {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const rtf = new Intl.RelativeTimeFormat(code, { numeric: 'auto', style: 'short' });
  const s = Math.round(ms / 1000);
  if (s < 45) return rtf.format(-Math.max(0, s), 'second');
  if (s < 2700) return rtf.format(-Math.round(s / 60), 'minute');
  if (s < 64800) return rtf.format(-Math.round(s / 3600), 'hour');
  return rtf.format(-Math.round(s / 86400), 'day');
}

export const clock = (iso) => {
  try { return new Date(iso).toLocaleTimeString(code, { hour: '2-digit', minute: '2-digit' }); } catch { return ''; }
};
