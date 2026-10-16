import { describe, expect, it } from 'vitest';
import { TextDoc, diffText, readOps } from '../../ui/lend/collab/crdt.js';

/** Applies visible changes to a plain string, the way an editor would. */
function applyChanges(text, changes) {
  for (const c of changes) text = text.slice(0, c.at) + c.insert + text.slice(c.at + c.remove);
  return text;
}

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe('text CRDT', () => {
  it('edits locally like a string', () => {
    const d = TextDoc.fromText('hello world', 'h');
    d.edit(5, 6, ', hive');
    expect(d.text()).toBe('hello, hive');
    d.edit(0, 1, 'H');
    expect(d.text()).toBe('Hello, hive');
    expect(d.length).toBe(11);
  });

  it('converges on concurrent inserts at the same spot, in any arrival order', () => {
    const base = TextDoc.fromText('ab', 'h');
    const snap = base.snapshot();
    const a = TextDoc.fromSnapshot(snap, 'a');
    const b = TextDoc.fromSnapshot(snap, 'b');
    const opsA = a.edit(1, 0, 'XX');
    const opsB = b.edit(1, 0, 'YY');
    a.apply(opsB);
    b.apply(opsA);
    base.apply(opsB);
    base.apply(opsA);
    expect(a.text()).toBe(b.text());
    expect(base.text()).toBe(a.text());
    expect(a.text()).toMatch(/^a(XXYY|YYXX)b$/);
  });

  it('converges on concurrent deletes and inserts in a deleted range', () => {
    const base = TextDoc.fromText('the quick brown fox', 'h');
    const a = TextDoc.fromSnapshot(base.snapshot(), 'a');
    const b = TextDoc.fromSnapshot(base.snapshot(), 'b');
    const opsA = a.edit(4, 6, ''); // delete "quick "
    const opsB = b.edit(6, 0, 'ee'); // insert inside "quick"
    const opsA2 = a.edit(4, 5, 'slow'); // replace "brown"
    for (const ops of [opsA, opsA2]) b.apply(ops);
    a.apply(opsB);
    expect(a.text()).toBe(b.text());
    expect(a.text()).toBe('the slowee fox');
  });

  it('reports editor changes that rebuild the same text', () => {
    const a = TextDoc.fromText('line one\nline two\n', 'h');
    const b = TextDoc.fromSnapshot(a.snapshot(), 'b');
    let mirror = b.text();
    const ops = [...a.edit(5, 3, 'ONE'), ...a.edit(0, 0, '# '), ...a.edit(a.length, 0, 'three\n')];
    mirror = applyChanges(mirror, b.apply(ops));
    expect(mirror).toBe(a.text());
    expect(b.text()).toBe(a.text());
  });

  it('waits for ops that depend on ones not seen yet', () => {
    const a = TextDoc.fromText('', 'a');
    const b = new TextDoc('b');
    const first = a.edit(0, 0, 'abc');
    const second = a.edit(3, 0, 'def');
    const third = a.edit(1, 2, '');
    expect(b.apply([...third, ...second])).toEqual([]);
    expect(b.text()).toBe('');
    b.apply(first);
    expect(b.text()).toBe(a.text());
    expect(b.text()).toBe('adef');
  });

  it('ignores duplicates', () => {
    const a = TextDoc.fromText('', 'a');
    const b = new TextDoc('b');
    const ops = a.edit(0, 0, 'x');
    b.apply(ops);
    b.apply(ops);
    expect(b.text()).toBe('x');
  });

  it('converges for three replicas under random concurrent edits and random delivery', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const r = rng(seed);
      const origin = TextDoc.fromText('function hive() {\n  return 1;\n}\n', 'h');
      const docs = ['h', 'a', 'b'].map((c) => (c === 'h' ? origin : TextDoc.fromSnapshot(origin.snapshot(), c)));
      const inbox = docs.map(() => []);
      for (let step = 0; step < 60; step++) {
        const who = Math.floor(r() * 3);
        const d = docs[who];
        const at = Math.floor(r() * (d.length + 1));
        const remove = r() < 0.4 ? Math.floor(r() * Math.min(4, d.length - at + 1)) : 0;
        const insert = r() < 0.7 ? 'xyz'.slice(0, 1 + Math.floor(r() * 3)) + who : '';
        const ops = d.edit(at, remove, insert);
        for (let o = 0; o < 3; o++) if (o !== who) inbox[o].push(ops);
        // Deliver some pending messages in a random order to a random replica.
        const to = Math.floor(r() * 3);
        while (inbox[to].length && r() < 0.6) {
          const pick = Math.floor(r() * inbox[to].length);
          docs[to].apply(inbox[to].splice(pick, 1)[0]);
        }
      }
      for (let o = 0; o < 3; o++) for (const ops of inbox[o].splice(0)) docs[o].apply(ops);
      expect(docs[1].text(), `seed ${seed}`).toBe(docs[0].text());
      expect(docs[2].text(), `seed ${seed}`).toBe(docs[0].text());
    }
  });

  it('keeps cursors on the same character through remote edits', () => {
    const a = TextDoc.fromText('abcdef', 'a');
    const b = TextDoc.fromSnapshot(a.snapshot(), 'b');
    const anchor = b.anchorAt(3); // before "d"
    b.apply(a.edit(0, 0, 'XYZ'));
    expect(b.offsetOf(anchor)).toBe(6);
    b.apply(a.edit(5, 2, ''));
    expect(b.offsetOf(anchor)).toBe(5);
    expect(b.offsetOf(null)).toBe(b.length);
  });

  it('round trips snapshots with tombstones', () => {
    const a = TextDoc.fromText('hello', 'a');
    a.edit(1, 3, 'EY');
    const b = TextDoc.fromSnapshot(JSON.parse(JSON.stringify(a.snapshot())), 'b');
    expect(b.text()).toBe('hEYo');
    const ops = b.edit(2, 0, '!');
    a.apply(ops);
    expect(a.text()).toBe('hE!Yo');
  });

  it('finds the smallest edit between two texts', () => {
    expect(diffText('abc', 'abc')).toBeNull();
    expect(diffText('hello world', 'hello brave world')).toEqual({ at: 6, remove: 0, insert: 'brave ' });
    expect(diffText('aaa', 'a')).toEqual({ at: 1, remove: 2, insert: '' });
  });

  it('rejects malformed ops from the network', () => {
    expect(() => readOps([{ i: ['a', 1], o: null, s: '' }])).toThrow();
    expect(() => readOps([{ d: [['a', -1, 1]] }])).toThrow();
    expect(() => readOps([{ x: 1 }])).toThrow();
    expect(readOps([{ i: ['a', 1], o: ['h', 3], s: 'x', extra: 1 }])).toEqual([{ i: ['a', 1], o: ['h', 3], s: 'x' }]);
  });
});
