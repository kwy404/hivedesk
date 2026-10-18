// The work of the CLI as pure functions: easy to test without spawning a process.

export function countText(text) {
  const s = String(text);
  const lines = s ? s.split(/\r\n|\n/).length - (/\r?\n$/.test(s) ? 1 : 0) : 0;
  const words = s.trim() ? s.trim().split(/\s+/).length : 0;
  return { lines, words, chars: [...s].length };
}

/** A right aligned table; a total row when there is more than one input. */
export function formatCounts(rows) {
  const all = rows.length > 1 ? [...rows, { name: 'total', lines: sum(rows, 'lines'), words: sum(rows, 'words'), chars: sum(rows, 'chars') }] : rows;
  const w = Math.max(5, ...all.map((r) => String(Math.max(r.lines, r.words, r.chars)).length));
  const pad = (n) => String(n).padStart(w);
  return [`${pad('lines')} ${pad('words')} ${pad('chars')}`, ...all.map((r) => `${pad(r.lines)} ${pad(r.words)} ${pad(r.chars)} ${r.name}`)].join('\n');
}

function sum(rows, key) {
  return rows.reduce((n, r) => n + r[key], 0);
}
