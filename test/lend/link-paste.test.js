import { describe, expect, it } from 'vitest';
import { LINK_BASE, lendLink, readJoinInput, wordsFromLink } from '../../ui/lend/core/link.js';
import { looksLikePaste, spread } from '../../ui/lend/core/paste.js';

const SIX = ['abandon', 'ability', 'able', 'about', 'above', 'absent'];
const empty = () => Array(6).fill('');

describe('lend link', () => {
  it('puts the six words in the hash and reads them back', () => {
    const link = lendLink(SIX);
    expect(link).toBe(`${LINK_BASE}#w=abandon-ability-able-about-above-absent`);
    expect(wordsFromLink(link)).toEqual(SIX);
    expect(lendLink(['Abandon', ...SIX.slice(1)], 'http://127.0.0.1:5000/?t=x#old')).toBe('http://127.0.0.1:5000/?t=x#w=abandon-ability-able-about-above-absent');
    expect(() => lendLink(SIX.slice(0, 5))).toThrow(RangeError);
  });

  it('finds words in a query or a bare hash, not in other text', () => {
    expect(wordsFromLink('http://127.0.0.1:4000/?t=abc&w=abandon-ability')).toEqual(['abandon', 'ability']);
    expect(wordsFromLink('#w=abandon-zoo')).toEqual(['abandon', 'zoo']);
    expect(wordsFromLink('abandon ability')).toBeNull();
    expect(wordsFromLink('')).toBeNull();
  });

  it('reads a link, a phrase or a messy list as the six words', () => {
    expect(readJoinInput(lendLink(SIX))).toMatchObject({ ok: true, words: SIX, from: 'link' });
    expect(readJoinInput('ABANDON, abil, able, about, above, absen')).toMatchObject({ ok: true, words: SIX, from: 'words' });
    expect(readJoinInput('abandon ability').ok).toBe(false);
  });
});

describe('paste spread', () => {
  it('spreads a whole phrase pasted into any box over all six boxes', () => {
    const r = spread(empty(), 3, 'abandon ability able about above absent');
    expect(r.values).toEqual(SIX);
    expect(r.focus).toBe(5);
  });

  it('spreads a pasted share link', () => {
    expect(spread(empty(), 0, lendLink(SIX)).values).toEqual(SIX);
  });

  it('keeps the last six real words of a numbered list', () => {
    const r = spread(empty(), 0, 'My words: 1. abandon 2. ability 3. able 4. about 5. above 6. absent');
    expect(r.values).toEqual(SIX);
  });

  it('spreads a few words from the box that got them and focuses the first empty box', () => {
    const r = spread(['abandon', 'ability', '', '', '', ''], 2, 'able about');
    expect(r.values).toEqual(['abandon', 'ability', 'able', 'about', '', '']);
    expect(r.focus).toBe(4);
  });

  it('leaves a single word to the browser', () => {
    expect(spread(empty(), 0, 'abandon')).toBeNull();
    expect(spread(empty(), 0, '')).toBeNull();
  });

  it('notices pasted text on phone keyboards without a paste event', () => {
    expect(looksLikePaste('abandon ability')).toBe(true);
    expect(looksLikePaste('abandon')).toBe(false);
  });
});
