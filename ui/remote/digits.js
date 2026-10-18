// The 10 digit address in the window: grouping while typing and the same Damm check digit as
// src/remote/address.js, so a typo is caught before anything is sent. The engine checks again.

const DAMM = [[0, 3, 1, 7, 5, 9, 8, 6, 4, 2], [7, 0, 9, 2, 1, 5, 4, 8, 6, 3], [4, 2, 0, 6, 8, 7, 1, 3, 5, 9], [1, 7, 5, 0, 9, 8, 3, 4, 2, 6], [6, 1, 2, 3, 0, 4, 5, 9, 7, 8], [3, 6, 7, 4, 2, 0, 9, 5, 8, 1], [5, 8, 6, 9, 7, 2, 0, 1, 3, 4], [8, 9, 4, 5, 3, 6, 2, 0, 1, 7], [9, 4, 3, 8, 6, 1, 7, 2, 0, 5], [2, 5, 8, 1, 4, 3, 6, 7, 9, 0]];

/** null when the text is a valid address, else 'format', 'length' or 'check_digit'. */
export function checkAddress(v) {
  const d = String(v || '').replace(/[\s.\-_/]/g, '');
  if (!/^\d+$/.test(d)) return 'format';
  if (d.length !== 10) return 'length';
  let x = 0;
  for (const c of d) x = DAMM[x][c.charCodeAt(0) - 48];
  return x === 0 ? null : 'check_digit';
}

/** "999 999 999 9" while typing: digits only, grouped 3 3 3 1. */
export function groupDigits(v) {
  const d = String(v || '').replace(/\D/g, '').slice(0, 10);
  return [d.slice(0, 3), d.slice(3, 6), d.slice(6, 9), d.slice(9)].filter(Boolean).join(' ');
}
