// Strings for the Models window and the first launch dialog. The shared tables in /i18n/<locale>.json
// win when they carry a models.* key; until then the tables in this folder are used.

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
    const r = await fetch(`/models/strings/${code}.json`, { cache: 'no-cache' });
    const m = r.ok ? await r.json() : {};
    tables.set(code, m);
    return m;
  } catch { return {}; }
}

// Listen first: the desktop may pick its language while the English table is still loading.
let wanted = null;
onLocale(async (code) => { wanted = code; const m = await load(code); if (wanted === code) { cur = m; strings.v++; } });

export const ready = (async () => {
  en = await load('en');
  const code = wanted || locale();
  const m = await load(code);
  if (!wanted || wanted === code) cur = m;
  strings.v++;
})();

/** Translates a models.* key with ICU style parameters. */
export function T(key, params) {
  void strings.v;
  if (has(key)) return coreT(key, params);
  const msg = cur[key] ?? en[key];
  return msg == null ? key : format(locale(), msg, params);
}
