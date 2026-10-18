// The problems panel: every marker the language services report (the TypeScript worker for
// JavaScript and TypeScript, fed the whole project by models.js; the CSS, JSON and HTML
// workers for open files), grouped by file, errors first. A click opens the file at the spot.

import { h, clear } from '/js/dom.js';
import { badgeOf } from '/editor/languages.js';
import { groupMarkers } from './util.js';
import { tw } from './strings.js';

const SEV = { error: '●', warning: '▲', info: 'ⓘ' };

/**
 * @param {{ monaco: any, fromUri: (uri) => ({ root, path } | null), open: (root, path, o) => void, rootName: (id) => string, onCount: (c: { errors: number, warnings: number }) => void, project: () => object }} ctx
 */
export function createProblems(ctx) {
  const { monaco } = ctx;
  const filter = h('input', { class: 'wb-input is-sm', type: 'search', placeholder: tw('wb.pr.filter'), attrs: { 'aria-label': tw('wb.pr.filter') } });
  const only = h('select', { class: 'wb-select is-sm', attrs: { 'aria-label': tw('wb.pr.show') } },
    h('option', { value: 'all', text: tw('wb.pr.all') }), h('option', { value: 'error', text: tw('wb.pr.errors') }), h('option', { value: 'warning', text: tw('wb.pr.warnings') }));
  const status = h('span', { class: 'wb-faint wb-pr-status' });
  const list = h('div', { class: 'wb-pr-list', role: 'tree', attrs: { 'aria-label': tw('wb.pr.title') } });
  const el = h('div', { class: 'wb-problems' }, h('div', { class: 'wb-pr-bar' }, filter, only, h('span', { class: 'wb-sp' }), status), list);
  const collapsed = new Set();
  let data = { files: [], errors: 0, warnings: 0, infos: 0 };

  function compute() {
    data = groupMarkers(monaco.editor.getModelMarkers({}), { fromUri: ctx.fromUri });
    ctx.onCount({ errors: data.errors, warnings: data.warnings });
    paint();
  }

  let timer = null;
  const soon = () => { clearTimeout(timer); timer = setTimeout(compute, 150); };

  function paint() {
    clear(list);
    const q = filter.value.trim().toLowerCase();
    const want = only.value;
    const p = ctx.project();
    status.textContent = p.state === 'loading' ? tw('wb.pr.loading', { n: p.files }) : p.state === 'ready' ? tw(p.capped ? 'wb.pr.projectCapped' : 'wb.pr.project', { n: p.files }) : '';
    let shown = 0;
    for (const f of data.files) {
      const items = f.items.filter((i) => (want === 'all' || i.sev === want) && (!q || i.message.toLowerCase().includes(q) || f.path.toLowerCase().includes(q)));
      if (!items.length) continue;
      const key = `${f.root}\u0001${f.path}`;
      const closed = collapsed.has(key);
      const [txt, color] = badgeOf(f.path);
      list.append(h('div', { class: 'wb-pr-file', role: 'treeitem', tabindex: '-1', attrs: { 'aria-expanded': String(!closed) }, on: { click: () => { if (closed) collapsed.delete(key); else collapsed.add(key); paint(); } } },
        h('span', { class: `wb-chev${closed ? '' : ' is-open'}` }), h('span', { class: 'wb-badge', style: { color }, text: txt }), h('span', { class: 'wb-name', text: f.path.split('/').pop() }),
        h('span', { class: 'wb-faint wb-ell', text: `${f.root === 'ws' ? '' : `${ctx.rootName(f.root)}: `}${f.path}` }), h('span', { class: 'wb-sp' }), h('span', { class: 'wb-count', text: String(items.length) })));
      if (closed) continue;
      for (const i of items.slice(0, 300)) {
        shown++;
        list.append(h('div', { class: `wb-pr-it is-${i.sev}`, role: 'treeitem', tabindex: '0', title: i.message,
          on: { click: () => ctx.open(f.root, f.path, { line: i.line, col: i.col, focus: true }), keydown: (e) => { if (e.key === 'Enter') ctx.open(f.root, f.path, { line: i.line, col: i.col, focus: true }); } } },
        h('span', { class: 'wb-pr-sev', text: SEV[i.sev], attrs: { 'aria-label': tw(`wb.pr.sev.${i.sev}`) } }),
        h('span', { class: 'wb-pr-msg', text: i.message.split('\n')[0] }),
        h('span', { class: 'wb-faint', text: `${i.source}${i.code ? `(${i.code})` : ''}` }),
        h('span', { class: 'wb-faint wb-pr-pos', text: `[${i.line}, ${i.col}]` })));
      }
    }
    if (!shown) list.append(h('p', { class: 'wb-faint wb-pad', text: data.files.length ? tw('wb.pr.noneFiltered') : tw('wb.pr.none') }));
  }

  filter.addEventListener('input', paint);
  only.addEventListener('change', paint);
  const sub = monaco.editor.onDidChangeMarkers(soon);
  compute();

  return {
    el,
    refresh: compute,
    paint,
    get counts() { return { errors: data.errors, warnings: data.warnings }; },
    /** The next problem after the cursor (F8), across files. */
    next(dir = 1) {
      const flat = data.files.flatMap((f) => f.items.map((i) => ({ ...i, root: f.root, path: f.path })));
      if (!flat.length) return null;
      const cur = ctx.cursor?.();
      let i = cur ? flat.findIndex((x) => x.root === cur.root && x.path === cur.path && (x.line > cur.line || (x.line === cur.line && x.col > cur.col))) : 0;
      if (dir < 0) {
        const before = cur ? flat.filter((x) => x.root === cur.root && x.path === cur.path && (x.line < cur.line || (x.line === cur.line && x.col < cur.col))) : [];
        const it = before.length ? before[before.length - 1] : flat[flat.length - 1];
        ctx.open(it.root, it.path, { line: it.line, col: it.col, focus: true });
        return it;
      }
      if (i < 0) i = 0;
      const it = flat[i];
      ctx.open(it.root, it.path, { line: it.line, col: it.col, focus: true });
      return it;
    },
    dispose() { sub.dispose(); clearTimeout(timer); },
  };
}
