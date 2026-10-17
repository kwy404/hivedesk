// Copies the part of the code editor package the Code window needs into ui/editor/vs/, so the
// hivedesk server serves it locally (offline, no CDN) and the published package stays small.
// The package is a devDependency pinned to one version; run this after changing that version.
//
//   node scripts/vendor-monaco.mjs          copy
//   node scripts/vendor-monaco.mjs --check  fail when ui/editor/vs/ is missing or out of date
//
// Kept: the AMD loader, the editor core and its CSS, the worker bootstrap, the icon font, the
// HTML, CSS and JSON language services (for completion, validation and formatting), and syntax
// highlighting for the languages in LANGS. The TypeScript language service (about 6 MB) is left
// out: a small stub takes its place, so JS and TS keep full highlighting without it.

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgDir = join(root, 'node_modules', 'monaco-editor');
const src = join(pkgDir, 'min', 'vs');
const out = join(root, 'ui', 'editor', 'vs');

// Syntax highlighting shipped (folder names under basic-languages). Keep in sync with
// ui/editor/languages.js.
export const LANGS = [
  'html', 'css', 'scss', 'less', 'javascript', 'typescript', 'markdown', 'python', 'xml', 'yaml', 'shell', 'bat',
  'powershell', 'sql', 'go', 'rust', 'java', 'kotlin', 'cpp', 'csharp', 'php', 'ruby', 'lua', 'swift', 'dockerfile',
  'ini', 'graphql', 'handlebars', 'pug', 'r', 'dart', 'perl', 'scala',
];

const FILES = ['loader.js', 'editor/editor.main.js', 'editor/editor.main.css', 'base/worker/workerMain.js', 'base/browser/ui/codicons/codicon/codicon.ttf'];
const DIRS = ['language/css', 'language/html', 'language/json', ...LANGS.map((l) => `basic-languages/${l}`)];

const TS_STUB = `/* hivedesk: stand-in for the TypeScript language service, which is not shipped (about 6 MB).
   JavaScript and TypeScript keep syntax highlighting from basic-languages. */
define("vs/language/typescript/tsMode", ["exports"], function (exports) {
  "use strict";
  var none = function () { return Promise.reject(new Error("The TypeScript language service is not included in hivedesk")); };
  exports.setupTypeScript = function () {};
  exports.setupJavaScript = function () {};
  exports.getTypeScriptWorker = none;
  exports.getJavaScriptWorker = none;
});
`;

function sizeOf(p) {
  const st = statSync(p);
  if (!st.isDirectory()) return st.size;
  return readdirSync(p).reduce((n, f) => n + sizeOf(join(p, f)), 0);
}

function version() {
  return JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version;
}

function stamp() {
  return `monaco-editor ${version()}\n${[...FILES, ...DIRS].join('\n')}\n`;
}

if (process.argv.includes('--check')) {
  const file = join(out, 'VENDORED.txt');
  if (!existsSync(file)) {
    console.error('ui/editor/vs/ is missing. Run: node scripts/vendor-monaco.mjs');
    process.exit(1);
  }
  if (existsSync(pkgDir) && readFileSync(file, 'utf8') !== stamp()) {
    console.error('ui/editor/vs/ is out of date. Run: node scripts/vendor-monaco.mjs');
    process.exit(1);
  }
  console.log('ui/editor/vs/ is up to date');
  process.exit(0);
}

if (!existsSync(src)) {
  console.error('Install the devDependencies first (npm install): node_modules/monaco-editor is missing.');
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
for (const rel of [...FILES, ...DIRS]) {
  const from = join(src, rel);
  if (!existsSync(from)) {
    console.error(`missing in the package: ${rel}`);
    process.exit(1);
  }
  mkdirSync(dirname(join(out, rel)), { recursive: true });
  cpSync(from, join(out, rel), { recursive: true });
}
mkdirSync(join(out, 'language', 'typescript'), { recursive: true });
writeFileSync(join(out, 'language', 'typescript', 'tsMode.js'), TS_STUB);
cpSync(join(pkgDir, 'LICENSE'), join(out, 'LICENSE'));
cpSync(join(pkgDir, 'ThirdPartyNotices.txt'), join(out, 'ThirdPartyNotices.txt'));
writeFileSync(join(out, 'VENDORED.txt'), stamp());
console.log(`copied monaco-editor ${version()} to ui/editor/vs/ (${(sizeOf(out) / 1048576).toFixed(1)} MB)`);
