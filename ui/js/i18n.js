// Languages for the desktop. Strings live in the shared folder i18n/<locale>.json (flat keys,
// ICU style plurals, see i18n/index.js). The locale comes from the saved choice, then the
// browser languages, then the OS locale the engine reports, then English. Switching is live:
// nodes built with the tx / ta / tp props (dom.js h()) are rewritten in place, every
// widget render that goes through track() runs again, and onLocale listeners fire.

import { LOCALES, CODES, FALLBACK, match, format, number } from '/i18n/index.js';

const V = globalThis.V;
const KEY = 'hivedesk.lang';

export { LOCALES, CODES };

/** Reactive: read L.v inside an effect to re-render when the language changes. */
export const L = V ? V.reactive({ code: FALLBACK, v: 0, ready: false }) : { code: FALLBACK, v: 0, ready: false };

const tables = new Map(); // code -> messages
let messages = {};
let english = {};
let code = FALLBACK;
const listeners = new Set();

export const locale = () => code;
export const onLocale = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

async function load(c) {
  if (tables.has(c)) return tables.get(c);
  const r = await fetch(`/i18n/${c}.json`, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`i18n/${c}.json: ${r.status}`);
  const m = await r.json();
  tables.set(c, m);
  return m;
}

function saved() { try { return localStorage.getItem(KEY); } catch { return null; } }

/** The locale to start with: saved choice, browser languages, OS locale, English. */
export function detect(osLocale) {
  const s = saved();
  if (s && CODES.includes(s)) return s;
  const browser = [...(navigator.languages || []), navigator.language].filter(Boolean);
  let intl = '';
  try { intl = Intl.DateTimeFormat().resolvedOptions().locale; } catch {}
  return match(browser) || match(osLocale) || match(intl) || FALLBACK;
}

/** Translates a key. Missing keys fall back to English, then to the key itself. */
export function t(key, params) {
  void L.v;
  const msg = messages[key] ?? english[key];
  if (msg == null) return key;
  return format(code, msg, params);
}

/** True when the key exists (in the current language or English). */
export const has = (key) => key in messages || key in english;

/** A map-like object: tmap('task.status').done === t('task.status.done'), undefined when missing. */
export function tmap(prefix) {
  return new Proxy({}, {
    get: (_, k) => (typeof k === 'string' && has(`${prefix}.${k}`) ? t(`${prefix}.${k}`) : undefined),
    has: (_, k) => typeof k === 'string' && has(`${prefix}.${k}`),
  });
}

export async function init(osLocale) {
  try { english = await load(FALLBACK); } catch (err) { console.warn('[hivedesk] no English strings', err.message); }
  await setLocale(detect(osLocale), { save: false });
  L.ready = true;
}

/** Uses the OS locale reported by the engine when nothing was chosen and the browser did not match. */
export function adoptOsLocale(osLocale) {
  if (saved()) return;
  const browser = [...(navigator.languages || []), navigator.language].filter(Boolean);
  if (match(browser)) return;
  const os = match(osLocale);
  if (os && os !== code) setLocale(os, { save: false });
}

/** Switches the language live, without a reload. */
export async function setLocale(next, { save = true } = {}) {
  if (!CODES.includes(next)) next = FALLBACK;
  try { messages = await load(next); } catch (err) { console.warn('[hivedesk] language not available', next, err.message); messages = english; next = FALLBACK; }
  code = next;
  if (save) { try { localStorage.setItem(KEY, next); } catch {} }
  const root = document.documentElement;
  root.lang = next;
  root.dataset.locale = next;
  root.dataset.script = /^(ja|ko|zh)/.test(next) ? 'cjk' : 'latin';
  L.code = next;
  L.v++;
  retranslate(document);
  for (const fn of listeners) { try { fn(next); } catch (err) { console.error(err); } }
}

function args(el, attr) {
  const raw = el.getAttribute(attr);
  if (!raw) return undefined;
  try { return JSON.parse(raw); } catch { return undefined; }
}

/** Rewrites every node that carries a translation key. */
export function retranslate(root = document) {
  for (const el of root.querySelectorAll('[data-tx]')) el.textContent = t(el.dataset.tx, args(el, 'data-tx-args'));
  for (const el of root.querySelectorAll('[data-ta]')) el.setAttribute('aria-label', t(el.dataset.ta, args(el, 'data-tx-args')));
  for (const el of root.querySelectorAll('[data-tp]')) el.setAttribute('placeholder', t(el.dataset.tp, args(el, 'data-tx-args')));
}

/* ---------- Intl formatting in the current language ---------- */

export const fmtNumber = (n, opts) => number(code, n, opts);

export function fmtTime(ts, opts = { hour: '2-digit', minute: '2-digit' }) {
  const d = new Date(ts);
  if (isNaN(d)) return '';
  return new Intl.DateTimeFormat(code, opts).format(d);
}

export function fmtDate(ts, opts = { dateStyle: 'medium' }) {
  const d = new Date(ts);
  if (isNaN(d)) return '';
  return new Intl.DateTimeFormat(code, opts).format(d);
}

export function fmtDateTime(ts) { return fmtDate(ts, { dateStyle: 'medium', timeStyle: 'short' }); }

export function fmtBytes(n) {
  if (n == null || isNaN(n)) return '';
  const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'];
  let i = 0; let v = Number(n);
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
  const digits = v >= 100 || i === 0 ? 0 : 1;
  try { return new Intl.NumberFormat(code, { style: 'unit', unit: units[i], unitDisplay: 'short', maximumFractionDigits: digits, minimumFractionDigits: digits }).format(v); } catch { return `${v.toFixed(digits)} ${['B', 'KB', 'MB', 'GB', 'TB'][i]}`; }
}

function unit(v, u, digits = 0) {
  try { return new Intl.NumberFormat(code, { style: 'unit', unit: u, unitDisplay: 'short', maximumFractionDigits: digits }).format(v); } catch { return `${v} ${u}`; }
}

export function fmtDuration(ms) {
  if (ms == null || isNaN(ms)) return '';
  if (ms < 1000) return unit(Math.round(ms), 'millisecond');
  const s = ms / 1000;
  if (s < 60) return unit(Number(s.toFixed(s < 10 ? 1 : 0)), 'second', 1);
  const m = Math.floor(s / 60);
  if (m < 60) return `${unit(m, 'minute')} ${unit(Math.round(s % 60), 'second')}`;
  return `${unit(Math.floor(m / 60), 'hour')} ${unit(m % 60, 'minute')}`;
}

export function fmtAgo(ts) {
  const d = Date.now() - new Date(ts).getTime();
  if (isNaN(d)) return '';
  const rtf = new Intl.RelativeTimeFormat(code, { numeric: 'auto', style: 'short' });
  if (d < 45e3) return t('time.justNow');
  if (d < 3600e3) return rtf.format(-Math.round(d / 60e3), 'minute');
  if (d < 86400e3) return rtf.format(-Math.round(d / 3600e3), 'hour');
  return fmtDate(ts);
}

/** Keyboard shortcut text for the current language: "Ctrl Alt Left" becomes "Strg Alt Links" in German. */
export function fmtKeys(kb) {
  if (!kb) return [];
  return String(kb).split(/\s+/).filter(Boolean).map((k) => (has(`key.${k.toLowerCase()}`) ? t(`key.${k.toLowerCase()}`) : k));
}

/** A list in the current language: "a, b and c". */
export function fmtList(items, type = 'conjunction') {
  try { return new Intl.ListFormat(code, { style: 'long', type }).format(items); } catch { return items.join(', '); }
}

/**
 * A download, install or load failure in the user's language, from its code: what happened and what to
 * do. The engine's own English line (sizes, paths, the HTTP status) stays as the detail under it.
 * @param {{ code?: string, message?: string, detail?: string, hint?: string, status?: number }} d
 */
export function dlError(d = {}) {
  const key = `dl.err.${d.code}`;
  const raw = d.message || d.detail || '';
  if (d.code && has(key)) return { text: t(key, { status: d.status ?? '' }), detail: raw };
  return { text: [raw, d.hint].filter(Boolean).join(' ') || t('dl.err.unknown'), detail: '' };
}
