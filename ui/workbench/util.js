// Small pure helpers shared by the workbench panels.

/** The same conservative branch name rule as src/github/git.js validBranch. */
export function validBranchName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(name) && !name.includes('..') && !name.endsWith('/') && !name.endsWith('.lock') && !name.includes('//');
}

/** Problems from editor markers, grouped by file, errors first. Pure. */
export function groupMarkers(markers, { fromUri }) {
  const files = new Map();
  let errors = 0;
  let warnings = 0;
  let infos = 0;
  for (const m of markers) {
    const where = fromUri(m.resource);
    if (!where) continue;
    const sev = m.severity >= 8 ? 'error' : m.severity >= 4 ? 'warning' : 'info';
    if (sev === 'error') errors++;
    else if (sev === 'warning') warnings++;
    else infos++;
    const key = `${where.root}\u0001${where.path}`;
    if (!files.has(key)) files.set(key, { root: where.root, path: where.path, items: [] });
    files.get(key).items.push({ sev, message: String(m.message || ''), line: m.startLineNumber, col: m.startColumn, source: m.source || m.owner || '', code: typeof m.code === 'object' ? m.code?.value : m.code });
  }
  const rank = { error: 0, warning: 1, info: 2 };
  const list = [...files.values()];
  for (const f of list) f.items.sort((a, b) => rank[a.sev] - rank[b.sev] || a.line - b.line || a.col - b.col);
  list.sort((a, b) => rank[a.items[0].sev] - rank[b.items[0].sev] || a.path.localeCompare(b.path));
  return { files: list, errors, warnings, infos };
}

/** Decodes terminal text for the basic (pipe) terminal: line editing happens here, not in a TTY. */
export function lineEdit(buffer, data) {
  let line = buffer;
  const out = [];
  let echo = '';
  const chars = [...data];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === '\x1b') {
      // Arrow keys and other escape sequences mean nothing without a TTY: skip them whole.
      if (chars[i + 1] === '[' || chars[i + 1] === 'O') {
        i += 2;
        while (i < chars.length && !/[A-Za-z~]/.test(chars[i])) i++;
      }
      continue;
    }
    if (ch === '\r' && chars[i + 1] === '\n') continue;
    if (ch === '\r' || ch === '\n') {
      out.push(line);
      echo += '\r\n';
      line = '';
    } else if (ch === '\x7f' || ch === '\b') {
      if (line.length) {
        line = line.slice(0, -1);
        echo += '\b \b';
      }
    } else if (ch === '\x03') {
      out.push(null);
      echo += '^C\r\n';
      line = '';
    } else if (ch >= ' ' || ch === '\t') {
      line += ch;
      echo += ch;
    }
  }
  return { line, lines: out, echo };
}

export const CODE_FILE = /\.(m?[jt]sx?|cjs|cts|mts)$/i;

/** Which files to feed, in order: TypeScript first, then JavaScript, by path. Pure. */
export function pickProjectFiles(files, { maxFiles = 2000, maxFile = 256 * 1024, maxTotal = 24 * 1024 * 1024 } = {}) {
  const list = files.filter((f) => CODE_FILE.test(f.path) && f.bytes <= maxFile && !/(^|\/)(dist|build|coverage|vendor)\//.test(f.path) && !/\.min\.js$/.test(f.path));
  list.sort((a, b) => (/\.tsx?$/.test(b.path) - /\.tsx?$/.test(a.path)) || a.path.localeCompare(b.path));
  const out = [];
  let total = 0;
  for (const f of list) {
    if (out.length >= maxFiles || total + f.bytes > maxTotal) return { files: out, capped: true };
    out.push(f);
    total += f.bytes;
  }
  return { files: out, capped: list.length > out.length };
}

const CODE_LETTER = { A: 'A', M: 'M', D: 'D', R: 'R', C: 'C', T: 'T' };

/** Splits a status into the two lists the panel shows. Pure. */
export function groupStatus(files) {
  const staged = [];
  const changes = [];
  const conflicts = [];
  for (const f of files || []) {
    if (f.conflict) conflicts.push(f);
    if (f.staged) staged.push({ ...f, letter: CODE_LETTER[f.x] || 'M' });
    if (f.unstaged) changes.push({ ...f, letter: CODE_LETTER[f.y] || 'M' });
    if (f.untracked) changes.push({ ...f, letter: 'U' });
  }
  const byPath = (a, b) => a.path.localeCompare(b.path);
  return { staged: staged.sort(byPath), changes: changes.sort(byPath), conflicts: conflicts.sort(byPath) };
}

const NAME_RE = /^[^<>:"|?*\\/\0]{1,255}$/;
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/** What is wrong with a new file or folder name (or a relative path), as a code, or ''. Pure. */
export function nameProblem(value, { allowSlash = true } = {}) {
  const v = String(value ?? '').trim();
  if (!v) return { code: 'empty' };
  const parts = v.replace(/\\/g, '/').split('/').filter(Boolean);
  if (!allowSlash && parts.length > 1) return { code: 'slash' };
  if (v.startsWith('/') || /^[a-zA-Z]:/.test(v)) return { code: 'absolute' };
  for (const p of parts) {
    if (p === '..' || p === '.') return { code: 'dots' };
    if (/^\.git$/i.test(p)) return { code: 'git' };
    if (!NAME_RE.test(p) || RESERVED.test(p) || /[. ]$/.test(p)) return { code: 'bad', name: p };
  }
  return null;
}

/** Scrolls only `box` so `el` is visible (scrollIntoView would also scroll the desktop behind the window). */
export function scrollInto(box, el) {
  if (!box || !el) return;
  const b = box.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  if (r.top < b.top) box.scrollTop -= b.top - r.top;
  else if (r.bottom > b.bottom) box.scrollTop += r.bottom - b.bottom;
}
