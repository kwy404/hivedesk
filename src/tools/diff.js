// Small unified diff (line based LCS). Good enough for the files a crew writes.

function lcsTable(a, b) {
  const n = a.length;
  const m = b.length;
  const t = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
    }
  }
  return t;
}

/** @returns {Array<{ op: ' ' | '-' | '+', line: string }>} */
export function diffLines(before, after) {
  const lines = (t) => {
    if (t === '') return [];
    const l = t.split('\n');
    if (l[l.length - 1] === '') l.pop();
    return l;
  };
  const a = lines(before);
  const b = lines(after);
  // Trim common head and tail so the table stays small.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const am = a.slice(head, a.length - tail);
  const bm = b.slice(head, b.length - tail);
  const ops = [];
  for (let i = 0; i < head; i++) ops.push({ op: ' ', line: a[i] });
  if (am.length * bm.length > 4_000_000) {
    for (const l of am) ops.push({ op: '-', line: l });
    for (const l of bm) ops.push({ op: '+', line: l });
  } else {
    const t = lcsTable(am, bm);
    let i = 0;
    let j = 0;
    while (i < am.length && j < bm.length) {
      if (am[i] === bm[j]) { ops.push({ op: ' ', line: am[i] }); i++; j++; }
      else if (t[i + 1][j] >= t[i][j + 1]) { ops.push({ op: '-', line: am[i] }); i++; }
      else { ops.push({ op: '+', line: bm[j] }); j++; }
    }
    while (i < am.length) ops.push({ op: '-', line: am[i++] });
    while (j < bm.length) ops.push({ op: '+', line: bm[j++] });
  }
  for (let i = a.length - tail; i < a.length; i++) ops.push({ op: ' ', line: a[i] });
  return ops;
}

/** Unified diff text with `context` lines around each change. */
export function unifiedDiff(file, before, after, context = 3) {
  if (before === after) return '';
  const ops = diffLines(before ?? '', after ?? '');
  const lines = [`--- ${before == null ? '/dev/null' : 'a/' + file}`, `+++ ${after == null ? '/dev/null' : 'b/' + file}`];
  // Group changes into hunks.
  const changeIdx = [];
  ops.forEach((o, i) => { if (o.op !== ' ') changeIdx.push(i); });
  let k = 0;
  while (k < changeIdx.length) {
    let start = Math.max(0, changeIdx[k] - context);
    let end = Math.min(ops.length - 1, changeIdx[k] + context);
    while (k + 1 < changeIdx.length && changeIdx[k + 1] - context <= end + 1) {
      k++;
      end = Math.min(ops.length - 1, changeIdx[k] + context);
    }
    let aLine = 1;
    let bLine = 1;
    for (let i = 0; i < start; i++) {
      if (ops[i].op !== '+') aLine++;
      if (ops[i].op !== '-') bLine++;
    }
    let aCount = 0;
    let bCount = 0;
    const body = [];
    for (let i = start; i <= end; i++) {
      const o = ops[i];
      if (o.op !== '+') aCount++;
      if (o.op !== '-') bCount++;
      body.push(o.op + o.line);
    }
    lines.push(`@@ -${aCount ? aLine : aLine - 1},${aCount} +${bCount ? bLine : bLine - 1},${bCount} @@`, ...body);
    k++;
    start = end;
  }
  return lines.join('\n');
}

export function diffStats(diff) {
  let added = 0;
  let removed = 0;
  for (const l of diff.split('\n')) {
    if (l.startsWith('+++') || l.startsWith('---')) continue;
    if (l.startsWith('+')) added++;
    else if (l.startsWith('-')) removed++;
  }
  return { added, removed };
}
