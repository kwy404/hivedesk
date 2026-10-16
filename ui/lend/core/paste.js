// Adapted from howlden (MIT, Alexandre Kohler), app/js/ui-pair.js: the paste `spread` fix.
// A whole phrase, a share link or a few words pasted into one box are spread over the boxes,
// one word per box, instead of landing in that single box. Kept free of the DOM so it can be
// tested; the Join window calls it from its paste and input handlers.

import { WORD_COUNT, resolveWord, splitPhrase } from './words.js';
import { wordsFromLink } from './link.js';

/** True when typed text holds more than one word (phone keyboards paste without a paste event). */
export const looksLikePaste = (text) => /[^A-Za-zÀ-ɏ]/.test(String(text ?? '').trim());

/**
 * Spreads pasted text over the word boxes.
 *   values: the current box values, index: the box that got the paste, text: what was pasted.
 * Returns { values, focus } with the new values and the box to focus next, or null when the text
 * holds a single word (then the paste is left to the browser).
 * A whole phrase (six words or more) always starts at the first box. With more than six parts,
 * as in "my words are: 1. abandon 2. ability ...", the last six real words win.
 */
export function spread(values, index, text, count = WORD_COUNT) {
  let parts = wordsFromLink(text) || splitPhrase(text);
  if (parts.length < 2) return null;
  if (parts.length > count) {
    const known = parts.filter((p) => resolveWord(p)?.how === 'exact');
    if (known.length >= count) parts = known.slice(-count);
  }
  const out = Array.from({ length: count }, (_, k) => String(values?.[k] ?? ''));
  const i = Math.min(Math.max(0, index | 0), count - 1);
  const start = parts.length >= count ? 0 : i;
  out[i] = '';
  parts.slice(0, count - start).forEach((p, k) => (out[start + k] = p));
  const firstBad = out.findIndex((v) => !resolveWord(v));
  return { values: out, focus: firstBad === -1 ? count - 1 : firstBad };
}
