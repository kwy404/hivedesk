// City strings. The keys live in i18n/parts/city.en.json; Stream 1 merges the parts into
// i18n/<locale>.json. Until then this bridge reads the part from the engine (GET /api/city/strings)
// and uses it as the English fallback, so a key never shows raw. Once merged, t() finds every key
// first and this file only forwards.

import { t, has, locale, onLocale } from '/js/i18n.js';
import { format } from '/i18n/index.js';
import * as net from '/js/net.js';

let part = {};
let loading = null;

/** Loads the City part once. Resolves even when the engine does not serve it. */
export function loadCityStrings() {
  if (loading) return loading;
  loading = fetch('/api/city/strings', { credentials: 'same-origin', cache: 'no-store', headers: net.token ? { authorization: `Bearer ${net.token}` } : {} })
    .then((r) => (r.ok ? r.json() : {}))
    .then((m) => { if (m && typeof m === 'object') part = m; })
    .catch(() => {});
  return loading;
}

/** Translates a City key: the merged tables first, then the City part, then the key itself. */
export function tr(key, params) {
  if (has(key)) return t(key, params);
  const msg = part[key];
  if (msg == null) return key;
  try { return format(locale(), msg, params); } catch { return msg; }
}

export const hasTr = (key) => has(key) || key in part;
export { onLocale };
