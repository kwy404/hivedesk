// A small CSV parser: quoted fields, commas and line breaks inside quotes, doubled quotes, CRLF.

/** Rows of a CSV text as arrays of strings, with the line each row starts on. */
export function parseRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let line = 1;
  let start = 1;
  const s = String(text).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else { if (c === '\n') line++; field += c; }
      continue;
    }
    if (c === '"' && field === '') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      if (row.length > 1 || row[0] !== '') rows.push({ line: start, cells: row });
      row = []; field = ''; line++; start = line;
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push({ line: start, cells: row }); }
  return rows;
}

/**
 * Records with the header names as keys; rows with the wrong column count are returned as problems.
 * @returns {{ header: string[], records: Array<Record<string, string>>, problems: Array<{ line: number, message: string }> }}
 */
export function parseCsv(text) {
  const rows = parseRows(text);
  if (!rows.length) return { header: [], records: [], problems: [{ line: 1, message: 'the file is empty' }] };
  const header = rows[0].cells.map((h) => h.trim());
  const records = [];
  const problems = [];
  for (const r of rows.slice(1)) {
    if (r.cells.length !== header.length) { problems.push({ line: r.line, message: `${r.cells.length} columns, the header has ${header.length}` }); continue; }
    records.push(Object.fromEntries(header.map((h, i) => [h, r.cells[i]])));
  }
  return { header, records, problems };
}
