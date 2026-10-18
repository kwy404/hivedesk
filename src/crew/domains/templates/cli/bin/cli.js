#!/usr/bin/env node
import { parseArgs } from 'node:util';
import fs from 'node:fs';
import { countText, formatCounts } from '../src/lib.js';

const HELP = `Usage: count [options] [file ...]

Counts lines, words and characters of the files (or of standard input when no file is given).

Options:
  -j, --json     print JSON instead of a table
  -h, --help     show this help
  -v, --version  show the version`;

function fail(message) {
  process.stderr.write(`count: ${message}\n`);
  process.exitCode = 1;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv, allowPositionals: true, strict: true,
      options: { json: { type: 'boolean', short: 'j' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' } }
    });
  } catch (err) {
    fail(`${err.message.replace(/\. To specify.*$/, '')} (unknown option, see --help)`);
    return;
  }
  const { values, positionals } = parsed;
  if (values.help) { process.stdout.write(`${HELP}\n`); return; }
  if (values.version) { process.stdout.write('0.1.0\n'); return; }
  const rows = [];
  if (!positionals.length) rows.push({ name: '-', ...countText(await readStdin()) });
  for (const file of positionals) {
    try { rows.push({ name: file, ...countText(fs.readFileSync(file, 'utf8')) }); } catch (err) { fail(`${file}: ${err.code === 'ENOENT' ? 'no such file' : err.message}`); }
  }
  if (rows.length) process.stdout.write(`${values.json ? JSON.stringify(rows, null, 2) : formatCounts(rows)}\n`);
}

main(process.argv.slice(2)).catch((err) => { fail(err.message); process.exit(1); });
