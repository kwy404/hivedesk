// Syntax check of every JavaScript file (in parallel), plus a few style rules from .editorconfig.
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { projectFiles, rel } from './files.mjs';

const problems = [];
const files = projectFiles();

const check = (f) => new Promise((resolve) => {
  const c = spawn(process.execPath, ['--check', f], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let err = '';
  c.stderr.on('data', (d) => (err += d));
  c.on('close', (code) => {
    if (code !== 0) problems.push(`${rel(f)}: ${err.split('\n').find((l) => /Error/.test(l)) || 'syntax error'}`);
    resolve();
  });
});
const queue = files.filter((x) => /\.(js|mjs|cjs)$/.test(x));
const total = queue.length;
await Promise.all(Array.from({ length: Math.max(2, Math.min(8, os.cpus().length)) }, async () => {
  while (queue.length) await check(queue.shift());
}));

for (const f of files.filter((x) => /\.(js|mjs|cjs|json|md|css|html|yml)$/.test(x))) {
  const text = fs.readFileSync(f, 'utf8');
  if (text.includes('\t') && !/\.md$/.test(f)) problems.push(`${rel(f)}: contains a tab`);
  if (text.length && !text.endsWith('\n')) problems.push(`${rel(f)}: no final newline`);
}
if (problems.length) {
  console.error(problems.sort().join('\n'));
  console.error(`\n${problems.length} lint problems`);
  process.exit(1);
}
console.log(`lint: ${total} scripts and ${files.length} files ok`);
