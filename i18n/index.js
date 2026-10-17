// Shared message formatter for the desktop (ui/) and the terminal (src/). No dependencies,
// works in Node 18+ and in the browser.
//
// Messages are flat keys in i18n/<locale>.json. Values use a small ICU subset:
//   {name}                                    a parameter
//   {count, plural, =0 {none} one {# file} other {# files}}   plural (Intl.PluralRules), # is the number
//   {kind, select, a {...} other {...}}       select
// Numbers given to {name} and # are formatted with Intl.NumberFormat for the locale.

export const LOCALES = [
  { code: 'en', name: 'English' },
  { code: 'pt-BR', name: 'Português (Brasil)' },
  { code: 'es', name: 'Español' },
  { code: 'fr', name: 'Français' },
  { code: 'de', name: 'Deutsch' },
  { code: 'it', name: 'Italiano' },
  { code: 'ja', name: '日本語' },
  { code: 'ko', name: '한국어' },
  { code: 'zh-CN', name: '简体中文' },
  { code: 'ru', name: 'Русский' }
];

export const CODES = LOCALES.map((l) => l.code);
export const FALLBACK = 'en';

/**
 * Best supported locale for a list of language tags (browser or OS), or null.
 * "pt", "pt-PT" and "pt-BR" all map to pt-BR; any "zh" maps to zh-CN.
 * @param {string|string[]} tags
 */
export function match(tags) {
  for (const raw of [].concat(tags || [])) {
    const tag = String(raw || '').replace(/_/g, '-').replace(/\..*$/, '').trim();
    if (!tag || tag === 'C' || tag === 'POSIX') continue;
    const exact = CODES.find((c) => c.toLowerCase() === tag.toLowerCase());
    if (exact) return exact;
    const lang = tag.split('-')[0].toLowerCase();
    const byLang = CODES.find((c) => c.split('-')[0].toLowerCase() === lang);
    if (byLang) return byLang;
  }
  return null;
}

const pluralCache = new Map();
function plural(locale, n) {
  let pr = pluralCache.get(locale);
  if (!pr) { try { pr = new Intl.PluralRules(locale); } catch { pr = new Intl.PluralRules('en'); } pluralCache.set(locale, pr); }
  return pr.select(n);
}

const numCache = new Map();
export function number(locale, n, opts) {
  const k = `${locale}|${opts ? JSON.stringify(opts) : ''}`;
  let nf = numCache.get(k);
  if (!nf) { try { nf = new Intl.NumberFormat(locale, opts); } catch { nf = new Intl.NumberFormat('en', opts); } numCache.set(k, nf); }
  return nf.format(n);
}

/** Splits "a {b} c" at the top level into text and {...} blocks. */
function blocks(msg) {
  const out = [];
  let depth = 0;
  let start = 0;
  let text = '';
  for (let i = 0; i < msg.length; i++) {
    const c = msg[i];
    if (c === "'" && msg[i + 1] === "'") { if (!depth) text += "'"; i++; continue; }
    if (c === '{') {
      if (depth === 0) { if (text) out.push(text); text = ''; start = i + 1; }
      depth++;
    } else if (c === '}' && depth > 0) {
      depth--;
      if (depth === 0) out.push({ body: msg.slice(start, i) });
    } else if (!depth) text += c;
  }
  if (text) out.push(text);
  return out;
}

/** "=0 {x} one {y} other {z}" into { '=0': 'x', one: 'y', other: 'z' }. */
function options(src) {
  const opts = {};
  let i = 0;
  while (i < src.length) {
    while (i < src.length && /\s/.test(src[i])) i++;
    let sel = '';
    while (i < src.length && !/[\s{]/.test(src[i])) sel += src[i++];
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src[i] !== '{') break;
    let depth = 0;
    const s = i + 1;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (!depth) break; }
    }
    opts[sel] = src.slice(s, i);
    i++;
  }
  return opts;
}

/**
 * Formats one message.
 * @param {string} locale
 * @param {string} msg
 * @param {Record<string, any>} [params]
 * @param {number} [hash] value of # inside a plural branch
 */
export function format(locale, msg, params = {}, hash) {
  if (typeof msg !== 'string') return '';
  if (!msg.includes('{') && !msg.includes('#')) return msg;
  let out = '';
  for (const b of blocks(msg)) {
    if (typeof b === 'string') {
      out += hash != null ? b.replace(/#/g, number(locale, hash)) : b;
      continue;
    }
    const m = /^\s*([\w.]+)\s*(?:,\s*(plural|select|number)\s*(?:,([\s\S]*))?)?$/.exec(b.body);
    if (!m) { out += `{${b.body}}`; continue; }
    const [, name, kind, rest] = m;
    const v = params[name];
    if (!kind) out += v == null ? '' : typeof v === 'number' ? number(locale, v) : String(v);
    else if (kind === 'number') out += number(locale, Number(v) || 0);
    else if (kind === 'plural') {
      const n = Number(v) || 0;
      const o = options(rest || '');
      const branch = o[`=${n}`] ?? o[plural(locale, n)] ?? o.other ?? '';
      out += format(locale, branch, params, n);
    } else {
      const o = options(rest || '');
      out += format(locale, o[String(v)] ?? o.other ?? '', params, hash);
    }
  }
  return out;
}

/**
 * A translate function over a message table, falling back to English, then to the key.
 * @param {string} locale
 * @param {Record<string,string>} messages
 * @param {Record<string,string>} [fallback]
 */
export function translator(locale, messages, fallback = {}) {
  return (key, params) => {
    const msg = messages[key] ?? fallback[key];
    if (msg == null) return key;
    return format(locale, msg, params);
  };
}

/** The placeholders a message uses, for the key check test. */
export function placeholders(msg) {
  const names = new Set();
  const walk = (s) => {
    for (const b of blocks(String(s))) {
      if (typeof b === 'string') continue;
      const m = /^\s*([\w.]+)\s*(?:,\s*(plural|select|number)\s*(?:,([\s\S]*))?)?$/.exec(b.body);
      if (!m) continue;
      names.add(m[1]);
      if (m[2] === 'plural' || m[2] === 'select') for (const v of Object.values(options(m[3] || ''))) walk(v);
    }
  };
  walk(msg);
  return [...names].sort();
}
