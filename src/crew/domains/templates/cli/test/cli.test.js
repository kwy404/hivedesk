import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { countText, formatCounts } from '../src/lib.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'cli.js');
const run = (args, input) => spawnSync(process.execPath, [CLI, ...args], { input, encoding: 'utf8' });

test('counts lines, words and characters', () => {
  assert.deepEqual(countText('one two\nthree\n'), { lines: 2, words: 3, chars: 14 });
  assert.deepEqual(countText(''), { lines: 0, words: 0, chars: 0 });
  assert.match(formatCounts([{ name: 'a', lines: 1, words: 2, chars: 3 }, { name: 'b', lines: 1, words: 1, chars: 1 }]), /total/);
});

test('reads files and standard input', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-test-'));
  const file = path.join(dir, 'a.txt');
  fs.writeFileSync(file, 'hello world\n');
  try {
    const r = run(['--json', file]);
    assert.equal(r.status, 0);
    assert.equal(JSON.parse(r.stdout)[0].words, 2);
    const piped = run([], 'a b c');
    assert.equal(piped.status, 0);
    assert.match(piped.stdout, /\s3\s/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--help, unknown flags and missing files', () => {
  assert.match(run(['--help']).stdout, /Usage:/);
  const bad = run(['--nope']);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /unknown option/);
  const missing = run(['does-not-exist.txt']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /no such file/);
});
