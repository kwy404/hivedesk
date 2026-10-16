// Adapted from howlden (MIT, Alexandre Kohler), app/core/words.js. The same code also runs in filefinch.
// Six word pairing codes from the BIP39 English wordlist. Each word carries 11 bits, so six
// words carry 66 random bits. Input is forgiving: case, accents, spaces and punctuation are
// ignored, the first four letters are enough (BIP39 words are unique by their first four
// letters), and a single typo is corrected when only one word is that close.

import { WORDLIST } from './wordlist.js';
import { randomBytes, utf8 } from './bytes.js';
import { Sha256 } from './sha256.js';

export const WORD_COUNT = 6;
export const BITS_PER_WORD = 11;
export const ENTROPY_BITS = WORD_COUNT * BITS_PER_WORD;

const INDEX = new Map(WORDLIST.map((w, i) => [w, i]));
const PREFIX = new Map(WORDLIST.map((w, i) => [w.slice(0, 4), i]));

/** Words for the first count * 11 bits of bytes, most significant bit first. */
export function wordsFromBytes(bytes, count = WORD_COUNT) {
  if (bytes.length * 8 < count * BITS_PER_WORD) throw new RangeError('Not enough bytes for the words');
  const out = [];
  for (let w = 0; w < count; w++) {
    let index = 0;
    for (let b = 0; b < BITS_PER_WORD; b++) {
      const bit = w * BITS_PER_WORD + b;
      index = (index << 1) | ((bytes[bit >> 3] >> (7 - (bit & 7))) & 1);
    }
    out.push(WORDLIST[index]);
  }
  return out;
}

/** Word indices back to the bits they carry (for tests and checks). */
export function indicesOf(words) {
  return words.map((w) => INDEX.get(w));
}

/** Six new random words: 66 bits from crypto.getRandomValues. */
export function generateWords(random = randomBytes) {
  return wordsFromBytes(random(Math.ceil(ENTROPY_BITS / 8)));
}

/** Lower case ASCII letters only: "  Abandon!" becomes "abandon", accents are dropped. */
export function normalizeWord(text) {
  return String(text ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
}

function editDistance(a, b, max = 2) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) cur[j] = Math.min(cur[j], prev[j - 2] + 1);
      best = Math.min(best, cur[j]);
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Turns what someone typed into a wordlist word.
 * Returns { word, how } where how is 'exact', 'prefix' (first four letters) or 'typo'
 * (one letter off, swapped letters included), or null when no single word fits.
 */
export function resolveWord(text) {
  const s = normalizeWord(text);
  if (!s) return null;
  if (INDEX.has(s)) return { word: s, how: 'exact' };
  if (s.length >= 4 && PREFIX.has(s.slice(0, 4))) return { word: WORDLIST[PREFIX.get(s.slice(0, 4))], how: 'prefix' };
  if (s.length < 4) return null; // too short to correct safely
  const near = WORDLIST.filter((w) => editDistance(s, w, 1) <= 1 || (s.length >= 4 && editDistance(s.slice(0, 4), w.slice(0, 4), 1) <= 1 && editDistance(s, w, 2) <= 2));
  if (near.length === 1) return { word: near[0], how: 'typo' };
  return null;
}

/** Up to limit words that start with what was typed, for autocomplete. */
export function suggestWords(text, limit = 8) {
  const s = normalizeWord(text);
  if (!s) return [];
  return WORDLIST.filter((w) => w.startsWith(s)).slice(0, limit);
}

/** Splits a pasted phrase ("abandon, ability able-about...") into its typed parts. */
export function splitPhrase(text) {
  return String(text ?? '')
    .split(/[^A-Za-z\u00c0-\u024f]+/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/** Resolves a full phrase. Returns { ok, words, missing } where missing lists bad positions. */
export function resolvePhrase(parts, count = WORD_COUNT) {
  const list = Array.isArray(parts) ? parts : splitPhrase(parts);
  const words = [];
  const missing = [];
  for (let i = 0; i < count; i++) {
    const r = resolveWord(list[i]);
    words.push(r?.word ?? null);
    if (!r) missing.push(i);
  }
  return { ok: missing.length === 0 && list.length === count, words, missing };
}

/** The canonical phrase: six lower case words separated by single spaces. */
export const phraseOf = (words) => words.map(normalizeWord).join(' ');

/**
 * Six confirmation words for one connection, the same on both devices: a hash of both DTLS
 * certificate fingerprints (sorted) and the session nonce. A device that joined with a code it
 * saw over someone's shoulder has its own certificate, so it gets different words.
 */
export function confirmWords(fingerprintA, fingerprintB, nonce) {
  if (!fingerprintA || !fingerprintB || !nonce) throw new Error('Missing fingerprint or nonce');
  const parts = [String(fingerprintA), String(fingerprintB)].sort();
  const digest = new Sha256().update(utf8(`hivedesk confirm v1|${parts[0]}|${parts[1]}|${nonce}`)).digest();
  return wordsFromBytes(digest);
}

// The share link helpers (wordsLink, wordsFromLink) moved to link.js.
