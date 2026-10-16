// Adapted from howlden (MIT, Alexandre Kohler), app/core/invite.js (findCode, codeLink) and the
// wordsLink helpers in app/core/words.js. In hivedesk the share link carries only the six
// words: the WebRTC offer travels sealed over the rendezvous relays, never in the link.
//   https://kwy404.github.io/hivedesk/lend/#w=word-word-word-word-word-word
// The host pastes that link (or just the words) into the Join window, or opens hivedesk
// with it so the window fills itself.

import { WORD_COUNT, normalizeWord, resolvePhrase, splitPhrase } from './words.js';

export const LINK_BASE = 'https://kwy404.github.io/hivedesk/lend/';

/** The share link for six words. base may be any page; its hash is replaced. */
export function lendLink(words, base = LINK_BASE) {
  if (!Array.isArray(words) || words.length !== WORD_COUNT) throw new RangeError(`A lend link needs ${WORD_COUNT} words`);
  return `${String(base).split('#')[0]}#w=${words.map(normalizeWord).join('-')}`;
}

/** The words in a link, a hash or a query (#w=..., ?w=..., &w=...), or null. */
export function wordsFromLink(text) {
  const m = /(?:^|[#&?])w=([A-Za-z-]+)/.exec(String(text ?? '').trim());
  return m ? m[1].split('-').filter(Boolean) : null;
}

/**
 * Whatever the host gave us (a link, a pasted phrase, words with commas or numbers) as the six
 * resolved words. Returns { ok, words, missing, from } where from is 'link' or 'words'.
 */
export function readJoinInput(text) {
  const fromLink = wordsFromLink(text);
  const parts = fromLink || splitPhrase(text);
  return { ...resolvePhrase(parts), from: fromLink ? 'link' : 'words' };
}
