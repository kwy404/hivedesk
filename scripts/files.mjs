// Lists the project's own text files (no dependencies, vendor copies or binaries).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'vendor', '.hivedesk', 'coverage']);
const TEXT = /\.(js|mjs|cjs|json|md|html|css|svg|yml|yaml|txt|xml)$|^(LICENSE|\.gitignore|\.editorconfig|\.gitattributes)$/;

export function projectFiles(dir = ROOT) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) {
        // ui/editor/vs is a vendored copy of the Monaco editor.
        if (!SKIP_DIRS.has(e.name) && !(e.name === 'vs' && d.endsWith('editor'))) walk(path.join(d, e.name));
      } else if (TEXT.test(e.name) && e.name !== 'package-lock.json') {
        out.push(path.join(d, e.name));
      }
    }
  };
  walk(dir);
  return out;
}

export const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
