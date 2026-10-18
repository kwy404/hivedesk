// Totals per group: the sum, count, average, minimum and maximum of a numeric column.

/** "1.234,56", "1,234.56", "R$ 10" and "-3" as numbers; anything else is NaN. */
export function toNumber(value) {
  let s = String(value ?? '').trim().replace(/[^\d,.-]/g, '');
  if (!s) return NaN;
  if (s.includes(',') && s.includes('.')) s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (s.includes(',')) s = /,\d{1,2}$/.test(s) ? s.replace(',', '.') : s.replace(/,/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * @param {Array<Record<string, string>>} records
 * @param {{ by: string, value: string }} opts the group column and the numeric column
 */
export function summarize(records, { by, value }) {
  const groups = new Map();
  const skipped = [];
  records.forEach((r, i) => {
    const n = toNumber(r[value]);
    if (Number.isNaN(n)) { skipped.push({ index: i, value: r[value] }); return; }
    const key = String(r[by] ?? '').trim() || '(empty)';
    const g = groups.get(key) || { group: key, count: 0, sum: 0, min: Infinity, max: -Infinity };
    g.count++; g.sum += n; g.min = Math.min(g.min, n); g.max = Math.max(g.max, n);
    groups.set(key, g);
  });
  const rows = [...groups.values()].map((g) => ({ ...g, sum: round(g.sum), average: round(g.sum / g.count) })).sort((a, b) => b.sum - a.sum);
  return { rows, skipped, total: round(rows.reduce((n, r) => n + r.sum, 0)) };
}

const round = (n) => Math.round(n * 100) / 100;

export function toTable(summary) {
  const head = ['group', 'count', 'sum', 'average', 'min', 'max'];
  const lines = [head, ...summary.rows.map((r) => [r.group, r.count, r.sum, r.average, r.min, r.max].map(String)), ['total', '', String(summary.total), '', '', '']];
  const widths = head.map((_, i) => Math.max(...lines.map((l) => l[i].length)));
  return lines.map((l) => l.map((c, i) => (i ? c.padStart(widths[i]) : c.padEnd(widths[i]))).join('  ')).join('\n');
}
