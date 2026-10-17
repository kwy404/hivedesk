// Strings for the GitHub and Changelog windows. The shared tables in /i18n/<locale>.json win
// when they carry a github.* or changelog.* key; until then the tables in this folder are used.

import { t as coreT, has, locale, onLocale } from '/js/i18n.js';
import { format } from '/i18n/index.js';

const V = window.V;
export const strings = V.reactive({ v: 0 });
const tables = new Map();
let en = {};
let cur = {};

async function load(code) {
  if (tables.has(code)) return tables.get(code);
  try {
    const r = await fetch(`/github/strings/${code}.json`, { cache: 'no-cache' });
    const m = r.ok ? await r.json() : {};
    tables.set(code, m);
    return m;
  } catch { return {}; }
}

export async function initStrings() {
  en = await load('en');
  cur = await load(locale());
  strings.v++;
  onLocale(async (code) => { cur = await load(code); strings.v++; });
}

/** Translates a github.* or changelog.* key with ICU style parameters. */
export function T(key, params) {
  void strings.v;
  if (has(key)) return coreT(key, params);
  const msg = cur[key] ?? en[key];
  return msg == null ? key : format(locale(), msg, params);
}
