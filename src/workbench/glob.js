// Small glob and ignore rules for search, quick open and the explorer. Paths are relative and
// use forward slashes. Supported: `*`, `**`, `?`, `[abc]`, `{a,b}`, a leading `/` to anchor,
// a trailing `/` for folders only, and `!` to re-include (in .gitignore files).

const ALWAYS_SKIP = new Set(['.git', 'node_modules', '.hivedesk']);
export const skipDir = (name) => ALWAYS_SKIP.has(name);

function escapeRe(c) {
  return /[.+^$()|\\]/.test(c) ? `\\${c}` : c;
}

/** Turns one glob into a RegExp source that matches a whole relative path. */
export function globSource(glob) {
  let g = String(glob).trim().replace(/\\/g, '/');
  let out = '';
  let i = 0;
  let brace = 0;
  while (i < g.length) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        // `**/` matches zero or more folders, a lone `**` matches anything.
        if (g[i + 2] === '/') { out += '(?:[^/]*/)*'; i += 3; continue; }
        out += '.*';
        i += 2;
        continue;
      }
      out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else if (c === '[') {
      const end = g.indexOf(']', i + 1);
      if (end < 0) out += '\\[';
      else {
        let set = g.slice(i + 1, end).replace(/\\/g, '\\\\');
        if (set.startsWith('!')) set = '^' + set.slice(1);
        out += `[${set}]`;
        i = end;
      }
    } else if (c === '{') { brace++; out += '(?:'; }
    else if (c === '}' && brace) { brace--; out += ')'; }
    else if (c === ',' && brace) out += '|';
    else out += escapeRe(c);
    i++;
  }
  while (brace-- > 0) out += ')';
  return out;
}

/**
 * A matcher for a list of globs. A glob without a slash matches a name at any depth
 * (`*.log` matches `a/b/c.log`); a glob with a slash matches from the root.
 * Matching a folder also matches everything inside it.
 */
export function globMatcher(globs) {
  const res = [];
  for (const raw of globs || []) {
    const g = String(raw || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
    if (!g) continue;
    const anchored = g.startsWith('/') || g.replace(/\/$/, '').includes('/');
    const body = globSource(g.replace(/^\//, '').replace(/\/$/, ''));
    res.push(new RegExp(`^${anchored ? '' : '(?:.*/)?'}${body}(?:/.*)?$`, process.platform === 'win32' ? 'i' : ''));
  }
  if (!res.length) return null;
  return (rel) => res.some((r) => r.test(rel));
}

/**
 * The basics of a .gitignore file: comments, blank lines, `!` negation, `/` anchors and
 * trailing `/` for folders. Later rules win, as in git.
 * @returns {(rel: string, isDir: boolean) => boolean} true when the path is ignored
 */
export function parseGitignore(text, base = '') {
  const rules = [];
  for (let line of String(text || '').split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    line = line.replace(/(?<!\\)\s+$/, '');
    if (!line) continue;
    let neg = false;
    if (line.startsWith('!')) { neg = true; line = line.slice(1); }
    if (line.startsWith('\\')) line = line.slice(1);
    const dirOnly = line.endsWith('/');
    const pat = line.replace(/\/+$/, '');
    if (!pat) continue;
    const anchored = pat.startsWith('/') || pat.includes('/');
    const body = globSource(pat.replace(/^\//, ''));
    const prefix = base ? `${base.replace(/\/$/, '')}/` : '';
    const re = new RegExp(`^${escapeBase(prefix)}${anchored ? '' : '(?:.*/)?'}${body}$`);
    rules.push({ re, neg, dirOnly });
  }
  return (rel, isDir) => {
    let ignored = false;
    for (const r of rules) {
      if (r.dirOnly && !isDir) continue;
      if (r.re.test(rel)) ignored = !r.neg;
    }
    return ignored;
  };
}

function escapeBase(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
