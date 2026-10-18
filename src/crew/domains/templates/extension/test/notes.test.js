import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { siteKey, cleanNote, badgeFor } from '../src/notes.js';

test('one note per site, only on http and https pages', () => {
  assert.equal(siteKey('https://example.com/a/b?c=1'), 'note:https://example.com');
  assert.equal(siteKey('http://localhost:8080/x'), 'note:http://localhost:8080');
  assert.equal(siteKey('chrome://extensions'), null);
  assert.equal(siteKey('not a url'), null);
});

test('notes are cut to 2000 characters and the badge shows when there is one', () => {
  assert.equal(cleanNote('x'.repeat(3000)).length, 2000);
  assert.equal(badgeFor('  '), '');
  assert.notEqual(badgeFor('remember this'), '');
});

test('the manifest is Manifest V3 with narrow permissions', () => {
  const m = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.equal(m.manifest_version, 3);
  assert.ok(m.background.service_worker);
  assert.deepEqual(m.permissions.sort(), ['activeTab', 'storage']);
  assert.equal(m.host_permissions, undefined);
});
