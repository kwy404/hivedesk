#!/usr/bin/env node
// Usage: node bin/run.js <file.csv> --by <column> --value <column> [--json]
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { parseCsv } from '../src/csv.js';
import { summarize, toTable } from '../src/report.js';

const HELP = 'Usage: node bin/run.js <file.csv> --by <column> --value <column> [--json]\nGroups the rows by one column and sums another. The input file is never changed.';

function main() {
  let args;
  try {
    args = parseArgs({ allowPositionals: true, strict: true, options: { by: { type: 'string' }, value: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
  } catch (err) {
    process.stderr.write(`${err.message.replace(/\. To specify.*$/, '')} (unknown option, see --help)\n`);
    process.exitCode = 1;
    return;
  }
  const { values, positionals } = args;
  if (values.help) { process.stdout.write(`${HELP}\n`); return; }
  if (positionals.length !== 1 || !values.by || !values.value) { process.stderr.write(`${HELP}\n`); process.exitCode = 1; return; }
  let text;
  try { text = fs.readFileSync(positionals[0], 'utf8'); } catch (err) { process.stderr.write(`cannot read ${positionals[0]}: ${err.code || err.message}\n`); process.exitCode = 1; return; }
  const { header, records, problems } = parseCsv(text);
  for (const col of [values.by, values.value]) {
    if (!header.includes(col)) { process.stderr.write(`no column "${col}"; the columns are: ${header.join(', ')}\n`); process.exitCode = 1; return; }
  }
  for (const p of problems) process.stderr.write(`line ${p.line}: ${p.message}, skipped\n`);
  const summary = summarize(records, { by: values.by, value: values.value });
  if (summary.skipped.length) process.stderr.write(`${summary.skipped.length} rows have no number in "${values.value}", skipped\n`);
  process.stdout.write(`${values.json ? JSON.stringify(summary, null, 2) : toTable(summary)}\n`);
}

main();
