import test from 'node:test';
import assert from 'node:assert/strict';
import { serialize, parse, stats } from '../resources/js/notes.js';

test('a saved note reads back the same', () => {
  const json = serialize('Hello desktop\nsecond line', new Date('2026-01-02T03:04:05Z'));
  assert.equal(parse(json), 'Hello desktop\nsecond line');
  assert.equal(JSON.parse(json).savedAt, '2026-01-02T03:04:05.000Z');
});

test('broken or foreign files give an empty note', () => {
  assert.equal(parse('{oops'), '');
  assert.equal(parse('{"version": 2, "text": "x"}'), '');
  assert.equal(parse(''), '');
});

test('counts words and characters', () => {
  assert.deepEqual(stats('  two words '), { words: 2, chars: 12 });
  assert.deepEqual(stats(''), { words: 0, chars: 0 });
});
