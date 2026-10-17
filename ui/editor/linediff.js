// Line diff and hunks for the review view: what the crew changed in a file since you last
// looked, one hunk at a time, with Accept (keep the change) and Reject (put the old lines back).

/** Splits text into lines, keeping the line ends, so joining gives the text back. */
export function lines(text) {
  return String(text ?? '').match(/[^\n]*\n|[^\n]+/g) || [];
}

/**
 * Hunks between two texts: [{ a, aEnd, b, bEnd }] where lines [a, aEnd) of the old text became
 * lines [b, bEnd) of the new one. Common lines are found with a longest common subsequence
 * after trimming the shared start and end.
 */
export function hunks(oldText, newText) {
  const A = lines(oldText);
  const B = lines(newText);
  let s = 0;
  while (s < A.length && s < B.length && A[s] === B[s]) s++;
  let ea = A.length;
  let eb = B.length;
  while (ea > s && eb > s && A[ea - 1] === B[eb - 1]) {
    ea--;
    eb--;
  }
  const n = ea - s;
  const m = eb - s;
  if (!n && !m) return [];
  if (!n || !m || n * m > 4e6) return [{ a: s, aEnd: ea, b: s, bEnd: eb }];
  // LCS table over the changed middle.
  const w = m + 1;
  const L = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i * w + j] = A[s + i] === B[s + j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  let open = null;
  const close = () => {
    if (open) out.push({ a: open.a, aEnd: s + i, b: open.b, bEnd: s + j });
    open = null;
  };
  while (i < n || j < m) {
    if (i < n && j < m && A[s + i] === B[s + j]) {
      close();
      i++;
      j++;
    } else {
      open ??= { a: s + i, b: s + j };
      if (j < m && (i === n || L[i * w + j + 1] >= L[(i + 1) * w + j])) j++;
      else i++;
    }
  }
  close();
  return out;
}

/** The new text with hunk h rejected: its new lines replaced by the old ones. */
export function rejectHunk(oldText, newText, h) {
  const A = lines(oldText);
  const B = lines(newText);
  return [...B.slice(0, h.b), ...A.slice(h.a, h.aEnd), ...B.slice(h.bEnd)].join('');
}

/** The old text with hunk h accepted: its old lines replaced by the new ones (the new baseline). */
export function acceptHunk(oldText, newText, h) {
  const A = lines(oldText);
  const B = lines(newText);
  return [...A.slice(0, h.a), ...B.slice(h.b, h.bEnd), ...A.slice(h.aEnd)].join('');
}

/** Line numbers (1 based, in the new text) that a change touched, for "is editing" marks. */
export function changedLines(oldText, newText) {
  const out = [];
  for (const h of hunks(oldText, newText)) {
    if (h.bEnd > h.b) for (let l = h.b; l < h.bEnd; l++) out.push(l + 1);
    else out.push(h.b + 1);
  }
  return out;
}
