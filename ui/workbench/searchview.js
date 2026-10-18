// Search and replace across files. The engine walks and matches in worker threads
// (src/workbench/search.js) and streams results to this window; replace shows a preview of
// every changed line first and applies only the files you keep checked.

import { h, clear } from '/js/dom.js';
import { badgeOf } from '/editor/languages.js';
import { wb, onFrame } from './net.js';
import { tw } from './strings.js';
import { confirm } from './dialogs.js';

const toggle = (label, title, on, key) => h('button', { class: `wb-tog${on ? ' is-on' : ''}`, type: 'button', title, text: label, attrs: { 'aria-pressed': String(on), 'aria-label': title }, dataset: { key } });

/**
 * @param {{ roots: () => Array<{ id: string, name: string, workspace: boolean }>, open: (root, path, o) => void, notify: (t, k?) => void, saved?: () => void }} ctx
 */
export function createSearch(ctx) {
  const st = { root: 'ws', regex: false, caseSensitive: false, wholeWord: false, searchId: null, results: new Map(), summary: null, collapsed: new Set(), preview: null, error: '' };
  try { Object.assign(st, JSON.parse(localStorage.getItem('hivedesk.wb.search') || '{}'), { searchId: null, results: new Map(), summary: null, collapsed: new Set(), preview: null, error: '' }); } catch { /* defaults */ }
  const q = h('input', { class: 'wb-input', type: 'text', placeholder: tw('wb.se.query'), spellcheck: false, attrs: { 'aria-label': tw('wb.se.query') } });
  const rep = h('input', { class: 'wb-input', type: 'text', placeholder: tw('wb.se.replace'), spellcheck: false, attrs: { 'aria-label': tw('wb.se.replace') } });
  const inc = h('input', { class: 'wb-input is-sm', type: 'text', placeholder: tw('wb.se.include'), spellcheck: false, attrs: { 'aria-label': tw('wb.se.include') } });
  const exc = h('input', { class: 'wb-input is-sm', type: 'text', placeholder: tw('wb.se.exclude'), spellcheck: false, attrs: { 'aria-label': tw('wb.se.exclude') } });
  const rootSel = h('select', { class: 'wb-select', attrs: { 'aria-label': tw('wb.se.where') } });
  const togs = h('div', { class: 'wb-togs' });
  const repBtn = h('button', { class: 'wb-btn is-sm', type: 'button', text: tw('wb.se.preview'), on: { click: () => preview() } });
  const summary = h('div', { class: 'wb-se-sum', attrs: { 'aria-live': 'polite' } });
  const list = h('div', { class: 'wb-se-list', role: 'tree', attrs: { 'aria-label': tw('wb.se.results') } });
  const form = h('div', { class: 'wb-se-form' },
    h('div', { class: 'wb-se-q' }, q, togs),
    h('div', { class: 'wb-se-r' }, rep, repBtn),
    h('details', { class: 'wb-se-more', open: !!(st.include || st.exclude) }, h('summary', { text: tw('wb.se.files') }), h('div', { class: 'wb-se-globs' }, rootSel, inc, exc)));
  const el = h('div', { class: 'wb-side-body wb-search' }, form, summary, list);
  inc.value = st.include || '';
  exc.value = st.exclude || '';

  function paintToggles() {
    clear(togs).append(
      toggle('Aa', tw('wb.se.case'), st.caseSensitive, 'caseSensitive'),
      toggle('ab', tw('wb.se.word'), st.wholeWord, 'wholeWord'),
      toggle('.*', tw('wb.se.regex'), st.regex, 'regex'));
  }
  togs.addEventListener('click', (ev) => {
    const k = ev.target.closest('[data-key]')?.dataset.key;
    if (!k) return;
    st[k] = !st[k];
    paintToggles();
    remember();
    schedule();
  });

  function paintRoots() {
    const roots = ctx.roots();
    if (!roots.some((r) => r.id === st.root)) st.root = 'ws';
    clear(rootSel).append(...roots.map((r) => h('option', { value: r.id, text: r.workspace ? tw('wb.ex.workspace') : r.name, selected: r.id === st.root })));
  }
  rootSel.addEventListener('change', () => { st.root = rootSel.value; remember(); schedule(); });

  function remember() {
    try { localStorage.setItem('hivedesk.wb.search', JSON.stringify({ root: st.root, regex: st.regex, caseSensitive: st.caseSensitive, wholeWord: st.wholeWord, include: inc.value, exclude: exc.value })); } catch { /* not kept */ }
  }

  let timer = null;
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(run, 260);
  }

  async function run() {
    const query = q.value;
    if (st.searchId) wb('wb.search.cancel', { searchId: st.searchId }).catch(() => {});
    st.results = new Map();
    st.summary = null;
    st.preview = null;
    st.error = '';
    if (!query) { st.searchId = null; paint(); return; }
    const started = performance.now();
    try {
      const r = await wb('wb.search', { root: st.root, query, regex: st.regex, caseSensitive: st.caseSensitive, wholeWord: st.wholeWord, include: inc.value, exclude: exc.value });
      st.searchId = r.searchId;
      st.started = started;
    } catch (err) {
      st.error = err.message;
      st.searchId = null;
    }
    paint();
  }

  let paintTimer = null;
  const paintSoon = () => { if (!paintTimer) paintTimer = setTimeout(() => { paintTimer = null; paint(); }, 60); };

  const offFrames = onFrame((f) => {
    if (f.type === 'search.result' && f.data.searchId === st.searchId) {
      st.results.set(f.data.path, f.data.hits);
      paintSoon();
    } else if (f.type === 'search.done' && f.data.searchId === st.searchId) {
      st.summary = f.data;
      if (f.data.error) st.error = f.data.error.message;
      paint();
    }
  });

  function hitRow(path, hit) {
    const p = hit.preview;
    const text = p.text;
    return h('div', { class: 'wb-se-hit', role: 'treeitem', tabindex: '-1', title: `${path}:${hit.line}:${hit.col}`, on: { click: () => ctx.open(st.root, path, { line: hit.line, col: hit.col, focus: false }), dblclick: () => ctx.open(st.root, path, { line: hit.line, col: hit.col, focus: true }), keydown: (e) => { if (e.key === 'Enter') ctx.open(st.root, path, { line: hit.line, col: hit.col, focus: true }); } } },
      h('span', { class: 'wb-se-ln', text: String(hit.line) }),
      h('span', { class: 'wb-se-txt' }, text.slice(0, p.start).replace(/^\s+/, ''), h('mark', { text: text.slice(p.start, p.end) }), text.slice(p.end)));
  }

  function paint() {
    clear(list);
    clear(summary);
    if (st.error) { summary.append(h('p', { class: 'wb-error', text: st.error })); return; }
    if (st.preview) return paintPreview();
    const files = [...st.results.keys()].sort();
    const hits = [...st.results.values()].reduce((n, x) => n + x.length, 0);
    if (st.searchId && !st.summary) summary.append(h('span', { class: 'wb-spin' }), h('span', { text: tw('wb.se.searching', { hits, files: files.length }) }));
    else if (st.summary) {
      const s = st.summary;
      summary.append(h('span', { text: s.hits ? tw('wb.se.found', { hits: s.hits, files: s.files }) : tw('wb.se.none') }),
        s.truncated ? h('span', { class: 'wb-warn', text: tw('wb.se.truncated') }) : null,
        s.timedOut ? h('span', { class: 'wb-warn', text: tw('wb.se.timedOut') }) : null,
        s.skippedLarge ? h('span', { class: 'wb-faint', text: tw('wb.se.skipped', { n: s.skippedLarge }) }) : null,
        h('span', { class: 'wb-faint', text: tw('wb.se.ms', { ms: Math.round(s.ms) }) }));
    }
    for (const path of files) {
      const hs = st.results.get(path);
      const [txt, color] = badgeOf(path);
      const closed = st.collapsed.has(path);
      const name = path.split('/').pop();
      const dir = path.slice(0, path.length - name.length).replace(/\/$/, '');
      list.append(h('div', { class: 'wb-se-file', role: 'treeitem', tabindex: '-1', attrs: { 'aria-expanded': String(!closed) }, on: { click: () => { if (closed) st.collapsed.delete(path); else st.collapsed.add(path); paint(); } } },
        h('span', { class: `wb-chev${closed ? '' : ' is-open'}` }), h('span', { class: 'wb-badge', style: { color }, text: txt }), h('span', { class: 'wb-name', text: name }), dir ? h('span', { class: 'wb-faint wb-ell', text: dir }) : null, h('span', { class: 'wb-sp' }), h('span', { class: 'wb-count', text: String(hs.length) })));
      if (!closed) for (const hit of hs.slice(0, 200)) list.append(hitRow(path, hit));
      if (!closed && hs.length > 200) list.append(h('div', { class: 'wb-se-more-hits', text: tw('wb.se.moreHits', { n: hs.length - 200 }) }));
    }
  }

  async function preview() {
    if (!q.value) return;
    st.error = '';
    summary.replaceChildren(h('span', { class: 'wb-spin' }), h('span', { text: tw('wb.se.previewing') }));
    try {
      const r = await wb('wb.replace.preview', { root: st.root, query: q.value, replace: rep.value, regex: st.regex, caseSensitive: st.caseSensitive, wholeWord: st.wholeWord, include: inc.value, exclude: exc.value }, { timeout: 120000 });
      st.preview = { ...r, keep: new Set(r.files.map((f) => f.path)) };
    } catch (err) {
      st.error = err.message;
    }
    paint();
  }

  function paintPreview() {
    const pv = st.preview;
    const kept = pv.files.filter((f) => pv.keep.has(f.path));
    const total = kept.reduce((n, f) => n + f.count, 0);
    const apply = h('button', { class: 'wb-btn is-sm is-primary', type: 'button', text: tw('wb.se.apply', { n: total, files: kept.length }), disabled: !kept.length, on: { click: () => applyReplace() } });
    summary.append(h('span', { text: pv.files.length ? tw('wb.se.previewSum', { n: pv.total, files: pv.files.length }) : tw('wb.se.none') }), h('span', { class: 'wb-sp' }),
      h('button', { class: 'wb-btn is-sm', type: 'button', text: tw('wb.cancel'), on: { click: () => { st.preview = null; paint(); } } }), apply);
    for (const f of pv.files) {
      const cb = h('input', { type: 'checkbox', checked: pv.keep.has(f.path), attrs: { 'aria-label': tw('wb.se.keepFile', { path: f.path }) }, on: { change: () => { if (cb.checked) pv.keep.add(f.path); else pv.keep.delete(f.path); paint(); } } });
      list.append(h('div', { class: 'wb-se-file is-preview' }, cb, h('span', { class: 'wb-name', text: f.path }), h('span', { class: 'wb-sp' }), h('span', { class: 'wb-count', text: String(f.count) })));
      for (const c of f.changes.slice(0, 50)) {
        list.append(h('div', { class: 'wb-se-change', on: { click: () => ctx.open(st.root, f.path, { line: c.line, focus: false }) } },
          h('span', { class: 'wb-se-ln', text: String(c.line) }),
          h('div', { class: 'wb-se-pair' }, h('span', { class: 'wb-del', text: c.before.trim().slice(0, 240) }), h('span', { class: 'wb-add', text: c.after.trim().slice(0, 240) }))));
      }
    }
  }

  async function applyReplace() {
    const pv = st.preview;
    const paths = pv.files.filter((f) => pv.keep.has(f.path)).map((f) => f.path);
    const ok = await confirm({ title: tw('wb.se.applyTitle'), text: tw('wb.se.applyText', { files: paths.length }), ok: tw('wb.se.applyOk') });
    if (!ok) return;
    try {
      const r = await wb('wb.replace.apply', { previewId: pv.previewId, paths }, { timeout: 15 * 60 * 1000 });
      ctx.notify(tw('wb.se.applied', { n: r.total, files: r.files.length }), 'ok');
      if (r.skipped.length) ctx.notify(tw('wb.se.appliedSkipped', { files: r.skipped.map((s) => `${s.path} (${s.reason})`).join(', ') }), 'warn');
      ctx.saved?.(st.root, r.files.map((f) => f.path));
    } catch (err) {
      ctx.notify(err.message, 'bad');
    }
    st.preview = null;
    run();
  }

  q.addEventListener('input', schedule);
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(timer); run(); } });
  rep.addEventListener('keydown', (e) => { if (e.key === 'Enter') preview(); });
  for (const x of [inc, exc]) x.addEventListener('input', () => { remember(); schedule(); });

  paintToggles();
  paintRoots();

  return {
    el,
    focus(text) {
      if (typeof text === 'string' && text) q.value = text;
      q.focus();
      q.select();
      if (q.value) schedule();
    },
    in(root, dir) {
      st.root = root;
      paintRoots();
      inc.value = dir ? `${dir}/**` : '';
      form.querySelector('details').open = true;
      remember();
      q.focus();
      if (q.value) schedule();
    },
    paintRoots,
    dispose() { offFrames(); clearTimeout(timer); },
  };
}
