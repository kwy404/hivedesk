// Files: the workspace tree with a diff viewer, plus the Code viewer window.

import { h, icon, clear, fmtBytes, ago } from '../dom.js';
import { beeAvatar } from '../bees.js';
import { register } from '../wm.js';
import * as wm from '../wm.js';
import { S, rev, ui, worker, extra } from '../store.js';
import { provide } from '../menu.js';
import * as act from '../actions.js';
import { diffView, diffStats } from '../diff.js';
import { codeHtml } from '../highlight.js';
import { track, stateBox } from './util.js';

const V = window.V;
const sel = V.reactive({ path: null, mode: 'diff', reveal: 0 });
const collapsed = new Set();

export function showFile(path, mode = 'diff') {
  sel.path = path;
  sel.mode = mode;
  sel.reveal++;
  for (let p = path.split('/').slice(0, -1), i = 1; i <= p.length; i++) collapsed.delete(p.slice(0, i).join('/'));
  wm.open('files');
}

export function fileMenu(path) {
  return [
    { header: path },
    { label: 'Open', icon: 'code', kb: 'Enter', action: () => wm.open('code', path) },
    { label: 'Diff', icon: 'replay', action: () => showFile(path, 'diff') },
    { label: 'Reveal in Files', icon: 'folder', action: () => showFile(path, sel.mode) },
    { label: 'Open in preview', icon: 'preview', disabled: !/\.html?$/i.test(path), action: () => import('./preview.js').then((m) => m.previewPath(path)) },
    { sep: true },
    { label: 'Copy path', icon: 'copy', action: () => act.copy(path, 'Path copied') },
  ];
}

function buildTree(files) {
  const root = { dirs: new Map(), files: [] };
  for (const path of Object.keys(files).sort()) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts.slice(0, i + 1).join('/');
      if (!node.dirs.has(parts[i])) node.dirs.set(parts[i], { name: parts[i], key, dirs: new Map(), files: [] });
      node = node.dirs.get(parts[i]);
    }
    node.files.push({ name: parts[parts.length - 1], path, ...files[path] });
  }
  return root;
}

const fileIcon = (name) => (/\.(html?|css|js|mjs|ts|json|md)$/i.test(name) ? 'code' : 'writer');

register('files', {
  title: 'Files',
  glyph: () => icon('folder'),
  size: [700, 480],
  min: [360, 240],
  cardH: 520,
  create(ctx) {
    const tree = h('div', { class: 'pane ftree', role: 'tree', 'aria-label': 'Workspace files' });
    const head = h('div', { class: 'tb' });
    const view = h('div', { class: 'pane' });
    const right = h('div', { style: 'display:flex;flex-direction:column;min-height:0' }, head, view);
    ctx.body.append(h('div', { class: 'split' }, tree, right));
    let lastSeqSeen = 0;

    provide(tree, (target) => {
      const row = target.closest?.('.frow');
      if (row?.dataset.path) return fileMenu(row.dataset.path);
      if (row?.dataset.dir) return [{ label: collapsed.has(row.dataset.dir) ? 'Expand' : 'Collapse', icon: 'folder', action: () => { toggleDir(row.dataset.dir); } }, { label: 'Copy path', icon: 'copy', action: () => act.copy(row.dataset.dir, 'Path copied') }];
      return null;
    });
    provide(view, () => sel.path && S().files[sel.path] ? fileMenu(sel.path) : null);

    const toggleDir = (key) => { if (collapsed.has(key)) collapsed.delete(key); else collapsed.add(key); renderTree(); };

    tree.addEventListener('click', (e) => {
      const row = e.target.closest('.frow');
      if (!row) return;
      if (row.dataset.dir) toggleDir(row.dataset.dir);
      else { sel.path = row.dataset.path; }
    });
    tree.addEventListener('dblclick', (e) => { const row = e.target.closest('.frow'); if (row?.dataset.path) wm.open('code', row.dataset.path); });
    tree.addEventListener('keydown', (e) => {
      const rows = [...tree.querySelectorAll('.frow')];
      const i = rows.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); rows[Math.min(rows.length - 1, i + 1)]?.focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); rows[Math.max(0, i - 1)]?.focus(); }
      else if (e.key === 'Enter' && rows[i]) { e.preventDefault(); if (rows[i].dataset.path) wm.open('code', rows[i].dataset.path); else toggleDir(rows[i].dataset.dir); }
      else if (e.key === ' ' && rows[i]) { e.preventDefault(); rows[i].click(); }
      else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && rows[i]?.dataset.dir) { e.preventDefault(); const isC = collapsed.has(rows[i].dataset.dir); if ((e.key === 'ArrowLeft') !== isC) toggleDir(rows[i].dataset.dir); }
    });

    function renderTree() {
      const s = S();
      const files = s.files;
      const focusedPath = document.activeElement?.closest?.('.frow')?.dataset.path;
      clear(tree);
      const paths = Object.keys(files);
      ctx.setSub(paths.length ? `${paths.length} file${paths.length > 1 ? 's' : ''}` : '');
      if (!paths.length) {
        tree.append(h('div', { class: 'state', style: 'min-height:120px' }, h('p', { class: 'small', text: 'The workspace is empty. Files the crew writes show up here.' })));
        return;
      }
      const walk = (node, lvl) => {
        for (const d of [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
          const isC = collapsed.has(d.key);
          tree.append(h('div', { class: 'frow', role: 'treeitem', tabindex: '-1', 'aria-expanded': String(!isC), style: `--lvl:${lvl}`, dataset: { dir: d.key } },
            h('span', { html: `<svg class="ico" viewBox="0 0 24 24" style="width:10px;height:10px;transform:rotate(${isC ? 0 : 90}deg)"><path d="M9 6l6 6-6 6"/></svg>` }), icon('folder'), h('span', { class: 'nm', text: d.name })));
          if (!isC) walk(d, lvl + 1);
        }
        for (const f of node.files) {
          const fresh = f.lastSeq > lastSeqSeen && lastSeqSeen > 0;
          tree.append(h('div', { class: `frow${fresh ? ' fresh' : ''}`, role: 'treeitem', tabindex: '-1', 'aria-selected': String(f.path === sel.path), style: `--lvl:${lvl}`, dataset: { path: f.path }, title: `${f.path} · ${fmtBytes(f.bytes)}` },
            h('span', { style: 'width:10px' }), icon(fileIcon(f.name)), h('span', { class: 'nm', text: f.name }), h('span', { class: 'op', dataset: { op: f.op || '' } })));
        }
      };
      walk(buildTree(files), 0);
      lastSeqSeen = Math.max(lastSeqSeen, ...Object.values(files).map((f) => f.lastSeq || 0), 1);
      const rows = tree.querySelectorAll('.frow');
      const target = [...rows].find((r) => r.dataset.path === (focusedPath || sel.path)) || rows[0];
      if (target) target.tabIndex = 0;
      if (focusedPath) target?.focus({ preventScroll: true });
    }

    async function renderView() {
      const s = S();
      if (!sel.path || !s.files[sel.path]) {
        const latest = Object.entries(s.files).sort((a, b) => (b[1].lastSeq || 0) - (a[1].lastSeq || 0))[0];
        if (latest && !sel.path) { sel.path = latest[0]; return; }
      }
      const path = sel.path && s.files[sel.path] ? sel.path : null;
      clear(head); clear(view);
      if (!path) {
        const n = Object.keys(s.files).length;
        view.append(stateBox({ icon: 'folder', title: n ? 'Pick a file' : 'No files yet', text: n ? 'Select a file to see what changed. Every write by the crew is shown as a diff.' : 'When a worker writes a file you will see the diff here, line by line.' }));
        return;
      }
      const f = s.files[path];
      const diffs = extra.diffs[path] || [];
      const last = diffs[diffs.length - 1];
      const by = last?.workerId || f.workerId;
      const st = last ? diffStats(last.diff) : null;
      const seg = h('div', { class: 'seg', role: 'tablist', 'aria-label': 'View' },
        h('button', { type: 'button', role: 'tab', 'aria-selected': String(sel.mode === 'diff'), on: { click: () => { sel.mode = 'diff'; } } }, 'Diff'),
        h('button', { type: 'button', role: 'tab', 'aria-selected': String(sel.mode === 'code'), on: { click: () => { sel.mode = 'code'; } } }, 'Code'));
      head.append(
        h('div', { class: 'grow' }, h('div', { class: 'crumbs ellipsis' }, ...path.split('/').flatMap((p, i, arr) => (i < arr.length - 1 ? [p, h('span', { class: 'faint', text: '/' })] : [h('b', { text: p, style: 'color:var(--text);font-weight:600' })]))),
          h('div', { class: 'tiny muted row', style: 'gap:6px;margin-top:2px' }, by ? beeAvatar(worker(by), 16, { ring: false }) : null,
            h('span', { text: [by ? worker(by).name : null, last ? (last.op === 'create' ? 'created' : 'edited') : null, last ? ago(last.ts) : null, fmtBytes(f.bytes)].filter(Boolean).join(' · ') }),
            st ? h('span', { style: 'color:var(--ok)', text: `+${st.add}` }) : null, st ? h('span', { style: 'color:var(--bad)', text: `-${st.del}` }) : null)),
        seg,
        h('button', { class: 'ibtn', type: 'button', title: 'Open in Code viewer', 'aria-label': 'Open in Code viewer', on: { click: () => wm.open('code', path) } }, icon('code')));
      if (sel.mode === 'diff') {
        if (last) view.append(diffView(last.diff, last.op === 'create' && !last.diff ? f.content : null));
        else view.append(stateBox({ icon: 'replay', title: 'No diff in this session', text: 'This file was written before you opened the page. Switch to Code to read it.' }));
      } else {
        const holder = h('div', { class: 'code' }, h('div', { class: 'skel', style: 'margin:10px 14px;width:60%' }));
        view.append(holder);
        try {
          const content = await act.readFile(path);
          holder.innerHTML = codeHtml(content, path);
        } catch (err) {
          clear(holder).append(h('div', { class: 'honest bad' }, icon('x'), h('div', { text: `Could not read the file: ${err.message}` })));
        }
      }
    }

    track(() => [rev.files, ui.replay, sel.path, sel.reveal], renderTree);
    track(() => [rev.files, sel.path, sel.mode, ui.replay], renderView);
    track(() => [sel.reveal], () => {
      requestAnimationFrame(() => tree.querySelector(`.frow[data-path="${CSS.escape(sel.path || '')}"]`)?.scrollIntoView({ block: 'nearest' }));
    });
  },
});

register('code', {
  title: (path) => (path ? path.split('/').pop() : 'Code'),
  glyph: () => icon('code'),
  size: [620, 520],
  min: [320, 220],
  cardH: 480,
  multi: true,
  create(ctx, path) {
    const head = h('div', { class: 'tb' });
    const pane = h('div', { class: 'pane' });
    ctx.body.append(head, pane);
    provide(pane, () => (path ? [...fileMenu(path).filter((x) => x.label !== 'Open')] : null));
    let lastSeq = -1;
    track(() => [rev.files, ui.replay], async () => {
      const f = S().files[path];
      ctx.setSub(path);
      clear(head);
      head.append(h('div', { class: 'grow crumbs ellipsis', text: path }), f ? h('span', { class: 'hchip hchip-mono', text: fmtBytes(f.bytes) }) : null,
        h('button', { class: 'ibtn', type: 'button', title: 'Copy path', 'aria-label': 'Copy path', on: { click: () => act.copy(path, 'Path copied') } }, icon('copy')),
        h('button', { class: 'ibtn', type: 'button', title: 'Reveal in Files', 'aria-label': 'Reveal in Files', on: { click: () => showFile(path) } }, icon('folder')));
      if (!f) { clear(pane).append(stateBox({ icon: 'code', title: 'File not in the workspace', text: 'It was deleted, or it does not exist at this point of the replay.' })); lastSeq = -1; return; }
      if (f.lastSeq === lastSeq) return;
      lastSeq = f.lastSeq;
      try {
        const content = await act.readFile(path);
        const top = pane.scrollTop;
        clear(pane).append(h('div', { class: 'code', html: codeHtml(content, path) }));
        pane.scrollTop = top;
      } catch (err) {
        clear(pane).append(h('div', { class: 'honest bad' }, icon('x'), h('div', { text: `Could not read the file: ${err.message}` })));
      }
    });
  },
});
