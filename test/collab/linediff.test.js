import { describe, expect, it } from 'vitest';
import { acceptHunk, changedLines, hunks, lines, rejectHunk } from '../../ui/editor/linediff.js';

const OLD = 'a\nb\nc\nd\ne\n';
const NEW = 'a\nB\nc\nd\nx\ny\ne\n';

describe('review hunks', () => {
  it('splits lines and keeps line ends', () => {
    expect(lines('a\nb')).toEqual(['a\n', 'b']);
    expect(lines('')).toEqual([]);
  });

  it('finds each changed block', () => {
    expect(hunks(OLD, NEW)).toEqual([
      { a: 1, aEnd: 2, b: 1, bEnd: 2 },
      { a: 4, aEnd: 4, b: 4, bEnd: 6 },
    ]);
    expect(hunks(OLD, OLD)).toEqual([]);
    expect(hunks('', 'x\n')).toEqual([{ a: 0, aEnd: 0, b: 0, bEnd: 1 }]);
  });

  it('rejecting every hunk gives the old text, accepting every hunk the new one', () => {
    let cur = NEW;
    let base = OLD;
    const hs = hunks(OLD, NEW);
    // Reject the second, accept the first.
    cur = rejectHunk(base, cur, hs[1]);
    expect(cur).toBe('a\nB\nc\nd\ne\n');
    const left = hunks(base, cur);
    base = acceptHunk(base, cur, left[0]);
    expect(base).toBe(cur);
    expect(hunks(base, cur)).toEqual([]);
  });

  it('lists the lines a crew write touched', () => {
    expect(changedLines(OLD, NEW)).toEqual([2, 5, 6]);
  });
});
