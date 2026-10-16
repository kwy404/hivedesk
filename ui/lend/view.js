// Small view pieces shared by the Lend screen and the Join window.

import { h, clear } from '../js/dom.js';
import { encodeQR, qrSvg } from './core/qr.js';
import { T } from './text.js';

export { h, clear };

/** Six numbered words in a 3 by 2 grid. data-words holds them for tests and copy. */
export function wordGrid(words, cls = '') {
  return h(
    'ol',
    { class: `lend-words ${cls}`.trim(), dataset: { words: words.join(' ') }, attrs: { 'aria-label': words.join(' ') } },
    words.map((w, i) => h('li', null, h('span', { class: 'lend-n', text: String(i + 1) }), h('b', { text: w }))),
  );
}

export function qrNode(text, title) {
  const wrap = h('div', { class: 'lend-qr' });
  wrap.innerHTML = qrSvg(encodeQR(text, { ecl: 'M' }), { margin: 3, dark: '#16130e', light: '#f4ead7', title });
  return wrap;
}

export async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h('textarea', { value: text, style: { position: 'fixed', opacity: '0' } });
    document.body.append(ta);
    ta.select();
    document.execCommand?.('copy');
    ta.remove();
  }
  if (button) {
    const old = button.textContent;
    button.textContent = T.copied;
    setTimeout(() => (button.textContent = old), 1400);
  }
}

const time = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const fmtMs = (ms) => (ms == null ? '' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

/** A live request log. add(entry) inserts or updates the row of entry.id. */
export function requestLog({ title, empty, withPreview = false }) {
  const body = h('tbody');
  const none = h('p', { class: 'lend-empty', text: empty });
  const table = h('table', { class: 'lend-log-table' }, h('thead', null, h('tr', null, T.logHead.map((c) => h('th', { text: c })))), body);
  const el = h('section', { class: 'lend-log', attrs: { 'aria-live': 'polite' } }, h('h3', { text: title }), none, table);
  table.hidden = true;
  const rows = new Map();
  let count = 0;

  function add(e) {
    none.hidden = true;
    table.hidden = false;
    const key = e.id && e.id !== '-' ? e.id : `x${count}`;
    let row = rows.get(key);
    if (!row) {
      count++;
      row = { tr: h('tr'), first: e.at ?? Date.now(), data: {} };
      rows.set(key, row);
      body.prepend(row.tr);
      while (body.children.length > 200) body.lastChild.remove();
    }
    Object.assign(row.data, e);
    const d = row.data;
    const status = d.status || d.kind;
    row.tr.className = `is-${status}`;
    row.tr.dataset.id = d.id || '';
    row.tr.dataset.status = status;
    clear(row.tr);
    const note = d.message ? h('small', { text: d.message }) : null;
    const prompt = withPreview && d.preview ? h('details', null, h('summary', { text: `${(d.chars ?? 0).toLocaleString('en-US')} chars` }), h('pre', { text: d.preview })) : `${(d.chars ?? 0).toLocaleString('en-US')} chars`;
    row.tr.append(
      h('td', { text: time(row.first) }),
      h('td', null, h('span', { class: 'lend-pill', text: T.status[status] || status }), note),
      h('td', { text: d.messages ?? '' }),
      h('td', null, d.chars != null ? prompt : ''),
      h('td', { text: d.completionTokens != null ? `${d.completionTokens} tokens` : d.tokens != null ? `${d.tokens} tokens` : '' }),
      h('td', { text: fmtMs(d.ms) }),
    );
  }

  return { el, add, get size() {
    return count;
  } };
}

export function failText(reason) {
  return T.failed[reason] || String(reason || T.failed.failed);
}
