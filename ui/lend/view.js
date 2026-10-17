// Small view pieces shared by the Lend screen and the Join window.

import { h, clear } from '../js/dom.js';
import { t, onLocale, fmtNumber, fmtTime, fmtDuration, fmtBytes } from '/js/i18n.js';
import { encodeQR, qrSvg } from './core/qr.js';
import { T } from './text.js';

export { h, clear };

/**
 * Text that follows a live language switch, for one mounted screen.
 *   add(fn, anchor)            runs fn now and again on every switch while anchor is on the page
 *                              (dropped once anchor has been shown and then removed: an old phase)
 *   text(tag, props, fn, ...)  a node whose text is fn(), kept up to date the same way
 *   stop()                     unsubscribes; it also happens by itself once root leaves the page
 */
export function liveScope(root) {
  const entries = new Set();
  let seen = root.isConnected;
  let off = null;
  const stop = () => {
    entries.clear();
    off?.();
    off = null;
  };
  off = onLocale(() => {
    if (!root.isConnected) {
      if (seen) stop();
      return;
    }
    seen = true;
    for (const e of [...entries]) {
      if (!e.anchor.isConnected) {
        if (e.seen) entries.delete(e);
        continue;
      }
      e.seen = true;
      try {
        e.fn();
      } catch (err) {
        console.error(err);
      }
    }
  });
  const add = (fn, anchor = root) => {
    const e = { fn, anchor, seen: anchor.isConnected };
    entries.add(e);
    // nodes are usually placed on the page right after they are built
    queueMicrotask(() => (e.seen ||= anchor.isConnected));
    fn();
    return fn;
  };
  const text = (tag, props, fn, ...children) => {
    const el = h(tag, props, ...children);
    el.lendLabel = fn;
    add(() => (el.textContent = fn()), el);
    return el;
  };
  return { add, text, stop };
}

/** Six numbered words in a 3 by 2 grid. data-words holds them for tests and copy. */
export function wordGrid(words, cls = '') {
  return h(
    'ol',
    { class: `lend-words ${cls}`.trim(), dataset: { words: words.join(' ') }, attrs: { 'aria-label': words.join(' ') } },
    words.map((w, i) => h('li', null, h('span', { class: 'lend-n', text: fmtNumber(i + 1) }), h('b', { text: w }))),
  );
}

/** The QR code of text. retitle(title) changes its accessible title (after a language switch). */
export function qrNode(text, title) {
  const wrap = h('div', { class: 'lend-qr' });
  wrap.innerHTML = qrSvg(encodeQR(text, { ecl: 'M' }), { margin: 3, dark: '#16130e', light: '#f4ead7', title });
  wrap.retitle = (next) => {
    const el = wrap.querySelector('title');
    if (el) el.textContent = next;
    else wrap.querySelector('svg')?.setAttribute('aria-label', next);
  };
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
    setTimeout(() => (button.textContent = button.lendLabel ? button.lendLabel() : old), 1400);
  }
}

const time = (ms) => fmtTime(ms, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const fmtMs = (ms) => (ms == null ? '' : fmtDuration(ms));

/**
 * A live request log. add(entry) inserts or updates the row of entry.id. relabel() paints the
 * title, headings and every row again in the current language. title and empty may be functions.
 */
export function requestLog({ title, empty, withPreview = false }) {
  const read = (x) => (typeof x === 'function' ? x() : x);
  const body = h('tbody');
  const none = h('p', { class: 'lend-empty', text: read(empty) });
  const head = h('tr');
  const heading = h('h3', { text: read(title) });
  const table = h('table', { class: 'lend-log-table' }, h('thead', null, head), body);
  const el = h('section', { class: 'lend-log', attrs: { 'aria-live': 'polite' } }, heading, none, table);
  table.hidden = true;
  const rows = new Map();
  let count = 0;

  const paintHead = () => {
    clear(head).append(...T.logHead.map((c) => h('th', { text: c })));
  };

  function paint(row) {
    const d = row.data;
    const status = d.status || d.kind;
    row.tr.className = `is-${status}`;
    row.tr.dataset.id = d.id || '';
    row.tr.dataset.status = status;
    const open = !!row.tr.querySelector('details')?.open;
    clear(row.tr);
    const message = coreText(d.message);
    const note = message ? h('small', { text: message }) : null;
    const chars = T.logChars(d.chars ?? 0);
    const prompt = withPreview && d.preview ? h('details', { open }, h('summary', { text: chars, tip: 'tip.lend.preview' }), h('pre', { text: d.preview })) : chars;
    const tokens = d.completionTokens ?? d.tokens;
    row.tr.append(
      h('td', { text: time(row.first) }),
      h('td', null, h('span', { class: 'lend-pill', text: T.status[status] || status }), note),
      h('td', { text: d.messages != null ? fmtNumber(d.messages) : '' }),
      h('td', null, d.chars != null ? prompt : ''),
      h('td', { text: tokens != null ? T.logTokens(tokens) : '' }),
      h('td', { text: fmtMs(d.ms) }),
    );
  }

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
    paint(row);
  }

  function relabel() {
    heading.textContent = read(title);
    none.textContent = read(empty);
    paintHead();
    for (const row of rows.values()) if (row.tr.parentNode === body) paint(row);
  }

  paintHead();
  return { el, add, relabel, get size() {
    return count;
  } };
}

// English messages the core modules, hive.js and the engine's lend plug-in produce, mapped to
// keys at display time (the core stays plain English so Node tests and the wire format keep it).
const CORE = {
  'A request id is missing or malformed': 'lend.core.badId',
  'A request needs at least one message': 'lend.core.noMessages',
  'Each message needs a role and a text content': 'lend.core.badMessage',
  'The schema must be a JSON object': 'lend.core.badSchema',
  'An answer needs a text': 'lend.core.noText',
  'hello needs a role': 'lend.core.helloRole',
  'Unknown frame': 'lend.core.unknownFrame',
  'Frames are text': 'lend.core.notText',
  'A frame is not valid JSON': 'lend.core.badJson',
  'The friend could not answer': 'lend.core.noAnswer',
  'A frame arrived before the confirmation words were checked': 'lend.core.notConfirmed',
  'The connection is closed': 'lend.core.closed',
  'link is not open': 'lend.core.closed',
  'Lending is stopped': 'lend.core.lendingStopped',
  'One request at a time': 'lend.core.busy',
  'Could not send the request to the friend': 'lend.core.sendFailed',
  'No local brain to lend': 'lend.core.noBrain',
  'No local model is ready': 'lend.core.noModel',
  'This hivedesk was not started with --lend': 'lend.core.notLending',
  'Could not reach the local hivedesk': 'lend.hive.unreachable',
  'The local hivedesk closed the connection': 'lend.hive.closed',
  'Not connected to the local hivedesk': 'lend.hive.notConnected',
  'command failed': 'lend.hive.commandFailed',
  'The friend stopped lending': 'lend.reason.friendStopped',
  'The host stopped borrowing': 'lend.reason.hostStopped',
  'The window was closed': 'lend.reason.windowClosed',
  'The confirmation words did not match': 'lend.reason.mismatch',
  stopped: 'lend.reason.stopped',
};

const PATTERNS = [
  [/^stopped by the other side: ([\s\S]*)$/, (m) => t('lend.reason.otherSide', { reason: coreText(m[1]) })],
  [/^(answer|offer): ([\s\S]*)$/, (m) => t('lend.core.handshake', { message: coreText(m[2]) })],
  [/^Too many (characters|requests) this minute, retry in (\d+) s$/, (m) => t('lend.core.rateLimited', { kind: m[1] === 'characters' ? 'chars' : 'requests', wait: fmtDuration(Number(m[2]) * 1000) })],
  [/^Rate limit reached \((\w+)\), retry in (\d+) s$/, (m) => t('lend.core.rateLimited', { kind: m[1] === 'chars' ? 'chars' : 'requests', wait: fmtDuration(Number(m[2]) * 1000) })],
  [/^A request may carry at most (\d+) messages$/, (m) => t('lend.core.tooManyMessages', { count: Number(m[1]) })],
  [/^The prompt has (\d+) characters, the limit is (\d+)$/, (m) => t('lend.core.promptTooLong', { chars: Number(m[1]), limit: Number(m[2]) })],
  [/^The schema has (\d+) characters, the limit is (\d+)$/, (m) => t('lend.core.schemaTooBig', { chars: Number(m[1]), limit: Number(m[2]) })],
  [/^The answer has (\d+) characters, the limit is (\d+)$/, (m) => t('lend.core.answerTooLong', { chars: Number(m[1]), limit: Number(m[2]) })],
  [/^A frame may be at most (\d+) bytes$/, (m) => t('lend.core.frameTooBig', { size: fmtBytes(Number(m[1])) })],
  [/^(\S+) timed out$/, (m) => t('lend.hive.timeout', { command: m[1] })],
];

/** A message from the core, hive.js or the engine in the current language; unknown text as is. */
export function coreText(msg) {
  const s = String(msg ?? '');
  if (!s) return '';
  if (CORE[s]) return t(CORE[s]);
  const failed = T.failed;
  if (Object.hasOwn(failed, s)) return failed[s];
  for (const [re, fn] of PATTERNS) {
    const m = re.exec(s);
    if (m) return fn(m);
  }
  return s;
}

export function failText(reason) {
  return reason ? coreText(reason) : T.failed.failed;
}
