// Chat lines written before 1.0 kept no i18n key, so a pt-BR desktop showed them in English
// ("On it: ... First I will write it up as a clear brief", "Job cancelled...", the old canned
// "Got it. Type a request in the top bar..."). legacyKey() finds the key and the parameters of such a
// line from the English texts, so the desktop shows it in its language like any other crew line.
import { raw } from './say.js';

// English texts that changed since they were written, and lines that no longer exist.
const OLD = {
  'crew.say.briefReady': ['Here is the brief. Use it, edit it, or keep your original request.'],
  'crew.legacy.topBar': ['Got it. Type a request in the top bar and the crew will start a job.']
};
// The crew lines that can be found in an old chat log, from their current English text.
const KEYS = [
  'crew.say.onItBrief', 'crew.say.onItPlan', 'crew.say.briefReady', 'crew.say.cancelled', 'crew.say.noModel', 'crew.say.briefFailed',
  'crew.talk.started', 'crew.talk.startedLead', 'crew.talk.startedMel', 'crew.talk.startedFlow', 'crew.talk.noted', 'crew.talk.ambiguous',
  'crew.talk.noModel', 'crew.talk.empty', 'crew.talk.hostOnly'
];

const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A template with simple {name} parameters as a regular expression; null for plurals and selects. */
function pattern(template) {
  if (!template || /\{\w+,/.test(template)) return null;
  const names = [];
  const src = template.split(/(\{\w+\})/).map((part) => {
    const m = /^\{(\w+)\}$/.exec(part);
    if (!m) return reEsc(part);
    names.push(m[1]);
    return '([\\s\\S]+?)';
  }).join('');
  return { re: new RegExp(`^${src}$`), names };
}

let table = null;
function patterns() {
  if (table) return table;
  table = [];
  for (const key of KEYS) {
    const p = pattern(raw('en', key));
    if (p) table.push({ key, ...p });
  }
  for (const [key, texts] of Object.entries(OLD)) for (const text of texts) table.push({ key, re: new RegExp(`^${reEsc(text)}$`), names: [] });
  return table;
}

/**
 * The i18n key of an old English crew line, or null.
 * @param {string} text
 * @returns {{ key: string, params: Record<string, string> } | null}
 */
export function legacyKey(text) {
  const s = String(text || '').trim();
  if (!s || s.length > 2000) return null;
  for (const p of patterns()) {
    const m = p.re.exec(s);
    if (m) return { key: p.key, params: Object.fromEntries(p.names.map((n, i) => [n, m[i + 1]])) };
  }
  return null;
}

/** Gives the old crew lines of a chat state their i18n key (in place); returns how many were found. */
export function tagLegacyChat(chat) {
  let n = 0;
  for (const list of Object.values(chat || {})) {
    for (const m of list || []) {
      if (!m || m.i18n || m.from === 'user' || typeof m.text !== 'string') continue;
      const hit = legacyKey(m.text);
      if (hit) { m.i18n = hit; n++; }
    }
  }
  return n;
}
