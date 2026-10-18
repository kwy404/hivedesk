import test from 'node:test';
import assert from 'node:assert/strict';
import { load, save, addItem, removeItem } from '../www/store.js';

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
}

test('adds, removes and keeps items across a reload', () => {
  const storage = memoryStorage();
  let items = addItem([], '  Buy bread  ', 1000);
  items = addItem(items, 'Call mom', 2000);
  assert.equal(items.length, 2);
  assert.equal(items[0].text, 'Call mom');
  assert.equal(items[1].text, 'Buy bread');
  assert.ok(save(storage, items));
  assert.deepEqual(load(storage), items);
  assert.deepEqual(removeItem(items, items[0].id).map((x) => x.text), ['Buy bread']);
});

test('ignores empty text and survives broken storage', () => {
  assert.deepEqual(addItem([], '   '), []);
  const broken = { getItem: () => '{not json', setItem: () => { throw new Error('full'); } };
  assert.deepEqual(load(broken), []);
  assert.equal(save(broken, []), false);
});
