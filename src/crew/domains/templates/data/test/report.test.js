import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv, parseRows } from '../src/csv.js';
import { summarize, toNumber, toTable } from '../src/report.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('parses quotes, commas inside quotes, doubled quotes and CRLF', () => {
  const rows = parseRows('a,b\r\n"x, y","say ""hi"""\r\n\r\n3,4');
  assert.deepEqual(rows.map((r) => r.cells), [['a', 'b'], ['x, y', 'say "hi"'], ['3', '4']]);
  const { records, problems } = parseCsv('a,b\n1,2\n3\n');
  assert.deepEqual(records, [{ a: '1', b: '2' }]);
  assert.equal(problems[0].line, 3);
});

test('reads numbers in both decimal styles', () => {
  assert.equal(toNumber('1.234,56'), 1234.56);
  assert.equal(toNumber('1,234.56'), 1234.56);
  assert.equal(toNumber('R$ 10,5'), 10.5);
  assert.ok(Number.isNaN(toNumber('n/a')));
});

test('sums per group, biggest first, and skips rows without a number', () => {
  const s = summarize([{ c: 'a', v: '2' }, { c: 'b', v: '5' }, { c: 'a', v: '1.5' }, { c: 'a', v: '' }], { by: 'c', value: 'v' });
  assert.deepEqual(s.rows.map((r) => [r.group, r.sum, r.count]), [['b', 5, 1], ['a', 3.5, 2]]);
  assert.equal(s.skipped.length, 1);
  assert.match(toTable(s), /total/);
});

test('the script runs on the sample and fails clearly on a wrong column', () => {
  const ok = spawnSync(process.execPath, ['bin/run.js', 'data/sample.csv', '--by', 'category', '--value', 'amount', '--json'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).total, 183);
  const bad = spawnSync(process.execPath, ['bin/run.js', 'data/sample.csv', '--by', 'nope', '--value', 'amount'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /no column "nope"/);
});
