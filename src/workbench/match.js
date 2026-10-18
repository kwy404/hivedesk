// Line based matching for search and replace. Pure: used by the search worker and the tests.

export class QueryError extends Error {
  constructor(message) {
    super(message);
    this.code = 'bad_request';
  }
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * @param {{ query: string, regex?: boolean, caseSensitive?: boolean, wholeWord?: boolean }} spec
 * @returns {RegExp} a global RegExp
 */
export function buildRegex(spec) {
  const q = String(spec?.query ?? '');
  if (!q) throw new QueryError('the search text is empty');
  if (q.length > 1000) throw new QueryError('the search text is too long (max 1000 characters)');
  let src = spec.regex ? q : escapeRe(q);
  if (spec.wholeWord) src = `(?<![\\p{L}\\p{N}_])(?:${src})(?![\\p{L}\\p{N}_])`;
  const flags = `g${spec.caseSensitive ? '' : 'i'}${spec.wholeWord ? 'u' : ''}`;
  try {
    return new RegExp(src, flags);
  } catch (err) {
    if (spec.wholeWord) {
      // The pattern is not valid in unicode mode: fall back to ASCII word boundaries.
      try { return new RegExp(`\\b(?:${spec.regex ? q : escapeRe(q)})\\b`, `g${spec.caseSensitive ? '' : 'i'}`); } catch { /* report below */ }
    }
    throw new QueryError(`the regular expression is not valid: ${err.message}`);
  }
}

const PREVIEW = 240;

/** A short view of a line around a match, with the match offsets inside the view. */
export function previewOf(line, col0, len) {
  if (line.length <= PREVIEW) return { text: line, start: col0, end: col0 + len };
  const from = Math.max(0, Math.min(col0 - 60, line.length - PREVIEW));
  const text = (from ? '…' : '') + line.slice(from, from + PREVIEW);
  const shift = from ? 1 - from : 0;
  return { text, start: col0 + shift, end: Math.min(text.length, col0 + len + shift) };
}

/**
 * Every match in a text, line by line.
 * @returns {Array<{ line: number, col: number, len: number, preview: { text: string, start: number, end: number } }>}
 */
export function findInText(text, re, limit = Infinity) {
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length && out.length < limit; i++) {
    const line = lines[i].endsWith('\r') ? lines[i].slice(0, -1) : lines[i];
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(line)) !== null) {
      if (m[0].length === 0) { re.lastIndex++; if (re.lastIndex > line.length) break; continue; }
      out.push({ line: i + 1, col: m.index + 1, len: m[0].length, preview: previewOf(line, m.index, m[0].length) });
      if (out.length >= limit) break;
    }
  }
  return out;
}

/**
 * Replaces every match, line by line, keeping the line endings.
 * With a regex, `$1` and `$<name>` in the replacement work as in String.replace; a literal
 * search inserts the replacement as it is.
 * @returns {{ after: string, count: number, changes: Array<{ line: number, before: string, after: string }> }}
 */
export function replaceInText(text, re, replacement, { regex = false, maxChanges = 200 } = {}) {
  const rep = String(replacement ?? '');
  const parts = text.split(/(\r?\n)/);
  let count = 0;
  const changes = [];
  for (let i = 0; i < parts.length; i += 2) {
    const line = parts[i];
    let n = 0;
    re.lastIndex = 0;
    const next = line.replace(re, (...args) => {
      if (args[0] === '') return '';
      n++;
      if (!regex) return rep;
      // Expand $& $1 $<name> the way String.prototype.replace does.
      const hasGroups = typeof args[args.length - 1] === 'object' && args[args.length - 1] !== null;
      const groups = hasGroups ? args[args.length - 1] : undefined;
      const caps = args.slice(1, hasGroups ? -3 : -2);
      return rep.replace(/\$(\$|&|\d{1,2}|<[^>]*>)/g, (all, k) => {
        if (k === '$') return '$';
        if (k === '&') return args[0];
        if (k[0] === '<') return groups?.[k.slice(1, -1)] ?? '';
        const idx = Number(k);
        return idx >= 1 && idx <= caps.length ? (caps[idx - 1] ?? '') : all;
      });
    });
    if (n) {
      count += n;
      if (changes.length < maxChanges) changes.push({ line: i / 2 + 1, before: line, after: next });
      parts[i] = next;
    }
  }
  return { after: parts.join(''), count, changes };
}
