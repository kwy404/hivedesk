import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';

async function withServer(fn) {
  const server = createApp();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { await new Promise((resolve) => server.close(resolve)); }
}

test('creates, reads, updates and deletes an item', () => withServer(async (base) => {
  let r = await fetch(`${base}/items`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Write tests' }) });
  assert.equal(r.status, 201);
  assert.match(r.headers.get('content-type'), /application\/json/);
  const item = await r.json();
  assert.equal(item.title, 'Write tests');
  assert.equal(item.done, false);

  r = await fetch(`${base}/items/${item.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ done: true }) });
  assert.equal((await r.json()).done, true);

  r = await fetch(`${base}/items`);
  assert.equal((await r.json()).items.length, 1);

  r = await fetch(`${base}/items/${item.id}`, { method: 'DELETE' });
  assert.equal(r.status, 204);
  r = await fetch(`${base}/items/${item.id}`);
  assert.equal(r.status, 404);
}));

test('rejects bad input with 400, unknown routes with 404 and wrong methods with 405', () => withServer(async (base) => {
  let r = await fetch(`${base}/items`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"title": ""}' });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, 'title is required');
  r = await fetch(`${base}/items`, { method: 'POST', body: '{broken' });
  assert.equal(r.status, 400);
  r = await fetch(`${base}/nothing`);
  assert.equal(r.status, 404);
  r = await fetch(`${base}/health`, { method: 'DELETE' });
  assert.equal(r.status, 405);
}));

test('refuses bodies over the size limit', () => withServer(async (base) => {
  const r = await fetch(`${base}/items`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'x'.repeat(200 * 1024) }) }).catch(() => null);
  assert.ok(!r || r.status === 413);
}));
