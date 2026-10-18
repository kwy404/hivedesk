// Walks a project root for search and quick open. Never follows a symlink (so nothing leaves
// the root), never enters .git, node_modules or .hivedesk, and honors .gitignore files.
import fs from 'node:fs';
import path from 'node:path';
import { skipDir, parseGitignore, globMatcher } from './glob.js';

export const MAX_SEARCH_BYTES = 2 * 1024 * 1024;

/**
 * @param {string} rootAbs real path of the root
 * @param {{ include?: string[], exclude?: string[], gitignore?: boolean, maxFiles?: number, signal?: { aborted: boolean } }} [o]
 * @returns {{ files: Array<{ rel: string, abs: string, bytes: number }>, truncated: boolean, skippedLarge: number }}
 */
export function walkFiles(rootAbs, o = {}) {
  const max = o.maxFiles ?? 20000;
  const include = globMatcher(o.include);
  const exclude = globMatcher(o.exclude);
  const files = [];
  let truncated = false;
  let skippedLarge = 0;
  const visit = (dirAbs, dirRel, ignores) => {
    if (truncated || o.signal?.aborted) return;
    let entries;
    try { entries = fs.readdirSync(dirAbs, { withFileTypes: true }); } catch { return; }
    let local = ignores;
    if (o.gitignore !== false && entries.some((e) => e.name === '.gitignore' && e.isFile())) {
      try {
        const text = fs.readFileSync(path.join(dirAbs, '.gitignore'), 'utf8').slice(0, 64 * 1024);
        local = [...ignores, parseGitignore(text, dirRel)];
      } catch { /* unreadable: no rules */ }
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (truncated) return;
      if (e.isSymbolicLink()) continue;
      const rel = dirRel ? `${dirRel}/${e.name}` : e.name;
      const abs = path.join(dirAbs, e.name);
      if (e.isDirectory()) {
        if (skipDir(e.name)) continue;
        if (local.some((m) => m(rel, true))) continue;
        if (exclude && exclude(rel)) continue;
        visit(abs, rel, local);
      } else if (e.isFile()) {
        if (local.some((m) => m(rel, false))) continue;
        if (exclude && exclude(rel)) continue;
        if (include && !include(rel)) continue;
        let bytes = 0;
        try { bytes = fs.statSync(abs).size; } catch { continue; }
        if (files.length >= max) { truncated = true; return; }
        if (bytes > MAX_SEARCH_BYTES) skippedLarge++;
        files.push({ rel, abs, bytes });
      }
    }
  };
  visit(rootAbs, '', []);
  return { files, truncated, skippedLarge };
}
