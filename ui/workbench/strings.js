// Workbench strings. The keys live in i18n/parts/workbench.en.json and are merged into the
// language files by the release (Stream 1); until a key is in the loaded language, the English
// part file served by the engine (/api/workbench/strings) fills it in, so nothing shows a raw key.

import { t, has, locale, onLocale } from '/js/i18n.js';
import { format } from '/i18n/index.js';

let english = {};
let loaded = null;

export function loadStrings() {
  loaded ??= fetch('/api/workbench/strings', { cache: 'no-cache', credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : {}))
    .then((m) => { english = m && typeof m === 'object' ? m : {}; })
    .catch(() => { english = {}; });
  return loaded;
}

/** Translates a workbench key: the current language, then the English part file, then the key. */
export function tw(key, params) {
  if (has(key)) return t(key, params);
  const msg = english[key];
  return msg == null ? key : format(locale(), msg, params);
}

export { onLocale };
