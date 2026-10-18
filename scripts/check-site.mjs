// Site check: docs/index.html exists, every local link and asset resolves, scripts come only from the allowed CDNs.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, rel } from './files.mjs';

const DOCS = path.join(ROOT, 'docs');
const ALLOWED = [/^https:\/\/cdn\.jsdelivr\.net\/npm\//, /^https:\/\/fonts\.googleapis\.com\//, /^https:\/\/fonts\.gstatic\.com\//];
const problems = [];

if (!fs.existsSync(path.join(DOCS, 'index.html'))) {
  console.error('site: docs/index.html is missing');
  process.exit(1);
}

const pages = [];
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(html|css)$/.test(e.name)) pages.push(p);
  }
};
walk(DOCS);

for (const page of pages) {
  // HTML comments are not links: a marked slot may describe markup for a file that is added later
  const text = fs.readFileSync(page, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const refs = [];
  for (const m of text.matchAll(/\b(?:href|src)=["']([^"']+)["']/gi)) refs.push(m[1]);
  for (const m of text.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) refs.push(m[1]);
  for (const m of text.matchAll(/srcset=["']([^"']+)["']/gi)) for (const c of m[1].split(',')) refs.push(c.trim().split(/\s+/)[0]);
  for (const m of text.matchAll(/<script\b[^>]*\bsrc=["'](https?:[^"']+)["']/gi)) {
    if (!ALLOWED.some((a) => a.test(m[1]))) problems.push(`${rel(page)}: script from a host that is not allowed: ${m[1]}`);
  }
  for (const raw of refs) {
    const ref = raw.trim();
    if (!ref || /^(https?:|mailto:|tel:|data:|javascript:|#|\/\/|\{)/i.test(ref)) continue;
    const clean = decodeURIComponent(ref.split('#')[0].split('?')[0]);
    if (!clean) continue;
    const base = clean.startsWith('/') ? DOCS : path.dirname(page);
    let target = path.join(base, clean.replace(/^\/(hivedesk\/)?/, ''));
    if (clean.endsWith('/')) target = path.join(target, 'index.html');
    if (!fs.existsSync(target)) problems.push(`${rel(page)}: missing ${ref}`);
  }
}

if (problems.length) {
  console.error(problems.join('\n'));
  console.error(`\n${problems.length} site problems`);
  process.exit(1);
}
console.log(`site: ${pages.length} files ok`);
