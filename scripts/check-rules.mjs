// Project rules: no emoji, no en or em dashes, no assistant names, no comparisons with other products,
// at most 6 package keywords and a one sentence description.
import fs from 'node:fs';
import path from 'node:path';
import { projectFiles, rel, ROOT } from './files.mjs';

const DASHES = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`);
const EMOJI = new RegExp(`\\p{Emoji_Presentation}|${String.fromCharCode(0xfe0f)}`, 'u');
// Built from parts so this file does not match itself.
const NAMES = new RegExp(`\\b(${['Cla', 'ude'].join('')}|${['Anth', 'ropic'].join('')})\\b`, 'i');
// Provider and model names may appear as supported options (provider list, adapters, their tests, the
// Providers window and the setup wizard), never in comparisons: the phrase check below still applies there.
const PROVIDER_FILES = new Set(['PROTOCOL.md', 'FIRST-RUN.md', 'src/brain/cloud.js', 'src/brain/keys.js', 'test/cloud.test.js', 'ui/js/widgets/providers.js', 'src/wizard/core.js', 'src/wizard/i18n.js', 'test/wizard.test.js']);
const PHRASES = [/\balternative to\b/i, /\ba clone of\b/i, /\bbetter than\b/i, /\binspired by\b/i];

const problems = [];
for (const f of projectFiles()) {
  const r = rel(f);
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  lines.forEach((line, i) => {
    const at = `${r}:${i + 1}`;
    // A character class that lists the dashes (a check for them, like the one in this script) is fine.
    const DASH_CLASS = new RegExp(`\[[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]+\]`, 'g');
    if (DASHES.test(line.replace(DASH_CLASS, ''))) problems.push(`${at}: en or em dash`);
    if (EMOJI.test(line)) problems.push(`${at}: emoji`);
    if (NAMES.test(line) && !PROVIDER_FILES.has(r)) problems.push(`${at}: names an AI assistant or its maker`);
    for (const p of PHRASES) if (p.test(line)) problems.push(`${at}: comparison phrase "${line.match(p)[0]}"`);
  });
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
if ((pkg.keywords || []).length > 6) problems.push(`package.json: ${pkg.keywords.length} keywords, at most 6`);
const sentences = String(pkg.description || '').split(/[.!?](\s|$)/).filter((s) => s && s.trim()).length;
if (!pkg.description || sentences > 1) problems.push('package.json: the description must be one plain sentence');

if (problems.length) {
  console.error(problems.join('\n'));
  console.error(`\n${problems.length} rule problems`);
  process.exit(1);
}
console.log('rules: ok');
