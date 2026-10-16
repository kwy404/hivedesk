import { describe, expect, it } from 'vitest';
import { WORD_COUNT, confirmWords, generateWords, phraseOf, resolvePhrase, resolveWord, splitPhrase, wordsFromBytes } from '../../ui/lend/core/words.js';
import { WORDLIST } from '../../ui/lend/core/wordlist.js';

describe('lend words', () => {
  it('uses the 2048 word BIP39 list, unique by four letters', () => {
    expect(WORDLIST.length).toBe(2048);
    expect(new Set(WORDLIST.map((w) => w.slice(0, 4))).size).toBe(2048);
  });

  it('makes six words carrying 66 bits', () => {
    const words = generateWords();
    expect(words).toHaveLength(WORD_COUNT);
    for (const w of words) expect(WORDLIST).toContain(w);
    expect(wordsFromBytes(new Uint8Array(9))).toEqual(Array(6).fill('abandon'));
    expect(wordsFromBytes(new Uint8Array(9).fill(255))).toEqual(Array(6).fill('zoo'));
  });

  it('forgives case, accents, prefixes and one typo', () => {
    expect(resolveWord('  ABANDON! ')).toEqual({ word: 'abandon', how: 'exact' });
    expect(resolveWord('abil')).toEqual({ word: 'ability', how: 'prefix' });
    expect(resolveWord('zebrq')?.word).toBe('zebra');
    expect(resolveWord('ab')).toBeNull();
    expect(resolveWord('qqqqqq')).toBeNull();
  });

  it('resolves a phrase and lists the bad positions', () => {
    expect(splitPhrase('abandon, ability;able-about\nabove absent')).toHaveLength(6);
    const ok = resolvePhrase('Abandon ability able about above absent');
    expect(ok.ok).toBe(true);
    expect(phraseOf(ok.words)).toBe('abandon ability able about above absent');
    const bad = resolvePhrase('abandon xx able about above');
    expect(bad.ok).toBe(false);
    expect(bad.missing).toEqual([1, 5]);
  });

  it('gives both sides the same confirmation words, and another certificate other words', () => {
    const a = 'sha-256 AA:BB';
    const b = 'sha-256 CC:DD';
    const one = confirmWords(a, b, 'nonce1');
    expect(one).toHaveLength(6);
    expect(confirmWords(b, a, 'nonce1')).toEqual(one);
    expect(confirmWords(a, 'sha-256 EE:FF', 'nonce1')).not.toEqual(one);
    expect(confirmWords(a, b, 'nonce2')).not.toEqual(one);
    expect(() => confirmWords(a, '', 'n')).toThrow();
  });
});
