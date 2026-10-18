// The explorer: every project root (the workspace and the folders the user opened), loaded one
// folder at a time. Create, rename, move (drag a row onto a folder) and delete, with the keyboard
// (arrows, Enter, F2, Delete) and a context menu. Every change goes through the engine
// (src/workbench/fs.js), so the path rules and, for peers, host approval apply.

import { h, clear } from '/js/dom.js';
import { badgeOf } from '/editor/languages.js';
import { wb } from './net.js';
import { tw } from './strings.js';
import { confirm, prompt, contextMenu } from './dialogs.js';
import { nameProblem, scrollInto } from './util.js';

const ICON = {
  file: '<svg viewBox="0 0 24 24"><path d="M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5z"/><path d="M14 3.5v5h5M12 12v5M9.5 14.5h5"/></svg>',
  folder: '<svg viewBox="0 0 24 24"><path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/><path d="M12 10.5v5M9.5 13h5"/></svg>',
  refresh: '<svg viewBox="0 0 24 24"><path d="M19 12a7 7 0 1 1-2.1-5"/><path d="M19 4v4h-4"/></svg>',
  collapse: '<svg viewBox="0 0 24 24"><path d="M7 15l5-5 5 5"/><path d="M5 19h14"/></svg>',
  add: '<svg viewBox="0 0 24 24"><path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/></svg>',
};

const NAME_KEYS = { empty: 'wb.ex.nameEmpty', slash: 'wb.ex.nameSlash', absolute: 'wb.ex.nameAbsolute', dots: 'wb.ex.nameDots', git: 'wb.ex.nameGit', bad: 'wb.ex.nameBad' };

/** The error text for a new name, or ''. */
export function checkName(value, o) {
  const p = nameProblem(value, o);
  return p ? tw(NAME_KEYS[p.code], p) : '';
}

/**
 * @param {{
 *   roots: () => Array<{ id: string, name: string, path?: string, workspace: boolean, missing?: boolean }>,
 *   open: (root: string, path: string, o?: object) => void,
 *   active: () => ({ root: string, path: string } | null),
 *   reviewMarks: (root: string) => Set<string>,
 *   people: () => Array<{ id: string, name: string, color: string, file?: string }>,
 *   renamed: (root, from, to, isDir) => void, removed: (root, path, isDir) => void,
 *   addRoot: () => void, removeRoot: (id: string) => void, terminalHere: (root: string, dir: string) => void,
 *   searchIn: (root: string, dir: string) => void, notify: (text: string, kind?: string) => void
 * }} ctx
 */
export function createExplorer(ctx) {
  const tree = h('div', { class: 'wb-tree', role: 'tree', tabindex: '0', attrs: { 'aria-label': tw('wb.ex.title') } });
  const addBtn = h('button', { class: 'wb-ibtn', type: 'button', title: tw('wb.ex.openFolder'), attrs: { 'aria-label': tw('wb.ex.openFolder') }, html: ICON.add, on: { click: () => ctx.addRoot() } });
  const collapseBtn = h('button', { class: 'wb-ibtn', type: 'button', title: tw('wb.ex.collapse'), attrs: { 'aria-label': tw('wb.ex.collapse') }, html: ICON.collapse, on: { click: () => { for (const r of state.values()) r.expanded.clear(); persist(); paint(); } } });
  const el = h('div', { class: 'wb-side-body wb-explorer' }, tree);
  const actions = [addBtn, collapseBtn];

  /** root id -> { expanded: Set<dir>, children: Map<dir, entries>, loading: Set<dir>, collapsed: boolean } */
  const state = new Map();
  let focusKey = null; // `${root}\u0001${path}`
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('hivedesk.wb.expanded') || '{}'); } catch { saved = {}; }

  function rs(id) {
    let r = state.get(id);
    if (!r) {
      r = { expanded: new Set(Array.isArray(saved[id]) ? saved[id] : []), children: new Map(), loading: new Set(), collapsed: !!saved[`${id}:closed`] };
      state.set(id, r);
    }
    return r;
  }

  function persist() {
    const o = {};
    for (const [id, r] of state) {
      o[id] = [...r.expanded].slice(0, 300);
      if (r.collapsed) o[`${id}:closed`] = true;
    }
    try { localStorage.setItem('hivedesk.wb.expanded', JSON.stringify(o)); } catch { /* not kept */ }
  }

  async function load(root, dir) {
    const r = rs(root);
    if (r.loading.has(dir)) return;
    r.loading.add(dir);
    try {
      const res = await wb('wb.fs.list', { root, dir });
      r.children.set(dir, res.entries);
    } catch (err) {
      r.children.set(dir, []);
      if (err.code === 'not_found') r.expanded.delete(dir);
    } finally {
      r.loading.delete(dir);
    }
    paint();
  }

  async function reload(root, dirs) {
    const r = rs(root);
    const list = dirs ? [...new Set(dirs)] : [...r.children.keys()];
    await Promise.all(list.filter((d) => r.children.has(d)).map((d) => load(root, d)));
  }

  const parentOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  const ancestors = (p) => { const out = []; let d = p; do { d = parentOf(d); out.push(d); } while (d); return out; };

  /** Something changed at these paths: reload the folders that show them. */
  function changed(root, paths) {
    const r = state.get(root);
    if (!r) return;
    const dirs = new Set();
    for (const p of paths) {
      // Every loaded folder above the path: a new file may come with new folders.
      let d = p;
      do { d = parentOf(d); dirs.add(d); } while (d);
      if (r.children.has(p)) dirs.add(p);
    }
    reload(root, [...dirs]);
  }

  function toggle(root, dir, open) {
    const r = rs(root);
    const want = open ?? !r.expanded.has(dir);
    if (want) {
      r.expanded.add(dir);
      if (!r.children.has(dir)) load(root, dir);
    } else r.expanded.delete(dir);
    persist();
    paint();
  }

  /** Opens every folder above a path and scrolls to it. */
  async function reveal(root, path, { select = true } = {}) {
    const r = rs(root);
    r.collapsed = false;
    const parts = path.split('/');
    let dir = '';
    if (!r.children.has('')) await load(root, '');
    for (let i = 0; i < parts.length - 1; i++) {
      dir = dir ? `${dir}/${parts[i]}` : parts[i];
      r.expanded.add(dir);
      if (!r.children.has(dir)) await load(root, dir);
    }
    if (select) focusKey = `${root}\u0001${path}`;
    persist();
    paint();
    scrollInto(tree, tree.querySelector(`[data-key="${CSS.escape(`${root}\u0001${path}`)}"]`));
  }

  /* ---------- painting ---------- */
  function paint() {
    const roots = ctx.roots();
    const active = ctx.active();
    const people = ctx.people();
    const viewing = new Map();
    for (const p of people) if (p.file) viewing.set(p.file, [...(viewing.get(p.file) || []), p]);
    clear(tree);
    for (const root of roots) {
      const r = rs(root.id);
      if (!r.children.has('') && !r.loading.has('') && !root.missing && !r.collapsed) load(root.id, '');
      const marks = ctx.reviewMarks(root.id);
      const head = h('div', {
        class: `wb-root${r.collapsed ? '' : ' is-open'}`, role: 'treeitem', tabindex: '-1', title: root.path || root.name,
        attrs: { 'aria-expanded': String(!r.collapsed), 'aria-level': '1' }, dataset: { key: `${root.id}\u0001`, root: root.id, dir: '', kind: 'root' },
        on: { click: () => { r.collapsed = !r.collapsed; persist(); paint(); }, contextmenu: (ev) => { ev.preventDefault(); rootMenu(ev.clientX, ev.clientY, root); } },
      }, h('span', { class: 'wb-chev' }), h('span', { class: 'wb-root-name', text: root.workspace ? tw('wb.ex.workspace') : root.name }), root.missing ? h('span', { class: 'wb-root-missing', text: tw('wb.ex.missing') }) : null,
      h('span', { class: 'wb-sp' }),
      h('button', { class: 'wb-ibtn is-xs', type: 'button', title: tw('wb.ex.newFile'), attrs: { 'aria-label': tw('wb.ex.newFile') }, html: ICON.file, on: { click: (ev) => { ev.stopPropagation(); newItem(root.id, '', 'file'); } } }),
      h('button', { class: 'wb-ibtn is-xs', type: 'button', title: tw('wb.ex.newFolder'), attrs: { 'aria-label': tw('wb.ex.newFolder') }, html: ICON.folder, on: { click: (ev) => { ev.stopPropagation(); newItem(root.id, '', 'dir'); } } }),
      h('button', { class: 'wb-ibtn is-xs', type: 'button', title: tw('wb.ex.refresh'), attrs: { 'aria-label': tw('wb.ex.refresh') }, html: ICON.refresh, on: { click: (ev) => { ev.stopPropagation(); reload(root.id); } } }));
      dropTarget(head, root.id, '');
      tree.append(head);
      if (r.collapsed || root.missing) continue;
      const walk = (dir, depth) => {
        const list = r.children.get(dir);
        if (!list) {
          if (r.loading.has(dir)) tree.append(h('div', { class: 'wb-row is-note', style: { paddingLeft: `${14 + depth * 12}px` }, text: tw('wb.loading') }));
          return;
        }
        if (!list.length && dir === '') tree.append(h('div', { class: 'wb-row is-note', style: { paddingLeft: '14px' }, text: tw('wb.ex.empty') }));
        for (const e of list) {
          const key = `${root.id}\u0001${e.path}`;
          if (e.type === 'dir') {
            const open = r.expanded.has(e.path);
            const row = h('div', {
              class: `wb-row is-dir${focusKey === key ? ' is-focus' : ''}${e.heavy ? ' is-heavy' : ''}`, role: 'treeitem', tabindex: '-1', draggable: 'true',
              attrs: { 'aria-expanded': String(open), 'aria-level': String(depth + 2) }, style: { paddingLeft: `${8 + depth * 12}px` },
              dataset: { key, root: root.id, path: e.path, kind: 'dir' },
              on: { click: () => { focusKey = key; toggle(root.id, e.path); }, contextmenu: (ev) => { ev.preventDefault(); focusKey = key; paint(); rowMenu(ev.clientX, ev.clientY, root, e); } },
            }, h('span', { class: `wb-chev${open ? ' is-open' : ''}` }), h('span', { class: `wb-folder${open ? ' is-open' : ''}` }), h('span', { class: 'wb-name', text: e.name }));
            drag(row, root.id, e);
            dropTarget(row, root.id, e.path);
            tree.append(row);
            if (open) walk(e.path, depth + 1);
          } else {
            const [txt, color] = badgeOf(e.path);
            const isActive = active && active.root === root.id && active.path === e.path;
            const dots = root.workspace ? (viewing.get(e.path) || []).map((x) => h('span', { class: 'wb-dot', style: { background: x.color }, title: x.name })) : [];
            const row = h('div', {
              class: `wb-row${isActive ? ' is-active' : ''}${focusKey === key ? ' is-focus' : ''}`, role: 'treeitem', tabindex: '-1', draggable: e.type === 'file' ? 'true' : 'false',
              attrs: { 'aria-level': String(depth + 2), 'aria-selected': String(!!isActive) }, style: { paddingLeft: `${20 + depth * 12}px` },
              dataset: { key, root: root.id, path: e.path, kind: e.type },
              on: {
                click: () => { focusKey = key; if (e.type === 'file') ctx.open(root.id, e.path, { focus: false }); paint(); },
                dblclick: () => { if (e.type === 'file') ctx.open(root.id, e.path, { focus: true }); },
                contextmenu: (ev) => { ev.preventDefault(); focusKey = key; paint(); rowMenu(ev.clientX, ev.clientY, root, e); },
              },
            }, h('span', { class: 'wb-badge', style: { color }, text: e.type === 'link' ? '->' : txt }), h('span', { class: 'wb-name', text: e.name }), marks.has(e.path) ? h('span', { class: 'wb-mark', title: tw('wb.ed.toReview') }) : null, ...dots);
            if (e.type === 'file') drag(row, root.id, e);
            tree.append(row);
          }
        }
      };
      walk('', 0);
    }
    const f = focusKey && tree.querySelector(`[data-key="${CSS.escape(focusKey)}"]`);
    if (f) f.tabIndex = 0;
  }

  /* ---------- drag and drop to move ---------- */
  function drag(row, root, e) {
    row.addEventListener('dragstart', (ev) => {
      ev.dataTransfer.setData('text/x-wb-path', JSON.stringify({ root, path: e.path, type: e.type }));
      ev.dataTransfer.effectAllowed = 'move';
    });
  }

  function dropTarget(row, root, dir) {
    row.addEventListener('dragover', (ev) => {
      if (![...ev.dataTransfer.types].includes('text/x-wb-path')) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'move';
      row.classList.add('is-drop');
    });
    row.addEventListener('dragleave', () => row.classList.remove('is-drop'));
    row.addEventListener('drop', async (ev) => {
      row.classList.remove('is-drop');
      let d;
      try { d = JSON.parse(ev.dataTransfer.getData('text/x-wb-path')); } catch { return; }
      ev.preventDefault();
      if (d.root !== root) { ctx.notify(tw('wb.ex.otherRoot'), 'warn'); return; }
      const name = d.path.split('/').pop();
      const to = dir ? `${dir}/${name}` : name;
      if (to === d.path || (d.type === 'dir' && (`${dir}/`).startsWith(`${d.path}/`))) return;
      await move(root, d.path, to, d.type === 'dir');
    });
  }

  /* ---------- operations ---------- */
  async function newItem(root, dir, kind) {
    const r = rs(root);
    r.collapsed = false;
    if (dir) toggle(root, dir, true);
    const title = kind === 'dir' ? tw('wb.ex.newFolder') : tw('wb.ex.newFile');
    const name = await prompt({ title, label: dir ? tw('wb.ex.inFolder', { dir }) : tw('wb.ex.inRoot'), check: (v) => checkName(v) });
    if (name == null) return;
    const rel = (dir ? `${dir}/` : '') + name.trim().replace(/\\/g, '/').replace(/^\/+/, '');
    try {
      if (kind === 'dir') await wb('wb.fs.mkdir', { root, path: rel });
      else {
        const exists = await wb('wb.fs.read', { root, path: rel }).then(() => true, () => false);
        if (!exists) await wb('wb.fs.write', { root, path: rel, content: '' });
      }
      await reload(root, ancestors(rel));
      await reveal(root, rel);
      if (kind === 'file') ctx.open(root, rel, { focus: true });
    } catch (err) {
      ctx.notify(err.message, 'bad');
    }
  }

  async function rename(root, e) {
    const dot = e.type === 'file' ? e.name.lastIndexOf('.') : -1;
    const name = await prompt({ title: tw('wb.ex.rename'), label: e.path, value: e.name, select: [0, dot > 0 ? dot : e.name.length], check: (v) => (v.trim() === e.name ? ' ' : checkName(v, { allowSlash: true })) });
    if (name == null) return;
    const dir = parentOf(e.path);
    const to = (dir ? `${dir}/` : '') + name.trim().replace(/\\/g, '/');
    await move(root, e.path, to, e.type === 'dir');
  }

  async function move(root, from, to, isDir) {
    try {
      await wb('wb.fs.rename', { root, from, to }, { timeout: 15 * 60 * 1000 });
      ctx.renamed(root, from, to, isDir);
      const r = rs(root);
      if (isDir) {
        for (const d of [...r.expanded]) if (d === from || d.startsWith(`${from}/`)) { r.expanded.delete(d); r.expanded.add(to + d.slice(from.length)); }
        for (const d of [...r.children.keys()]) if (d === from || d.startsWith(`${from}/`)) r.children.delete(d);
      }
      await reload(root, [...ancestors(from), ...ancestors(to)]);
      await reveal(root, to);
      tree.focus({ preventScroll: true });
    } catch (err) {
      ctx.notify(err.message, 'bad');
    }
  }

  async function remove(root, e) {
    let detail = '';
    if (e.type === 'dir') {
      let count;
      try { count = await wb('wb.fs.count', { root, path: e.path }); } catch (err) { ctx.notify(err.message, 'bad'); return; }
      detail = count.files || count.folders ? tw('wb.ex.deleteDirCount', { files: count.files, folders: count.folders }) : '';
      const ok = await confirm({ title: tw('wb.ex.deleteTitle'), text: tw('wb.ex.deleteDir', { name: e.path }), detail: detail ? h('p', { class: 'wb-dlg-warn', text: detail }) : null, ok: tw('wb.ex.delete'), danger: true });
      if (!ok) return;
      try {
        await wb('wb.fs.delete', { root, path: e.path, recursive: count.files + count.folders > 0, confirmFiles: count.files }, { timeout: 15 * 60 * 1000 });
      } catch (err) { ctx.notify(err.message, 'bad'); return; }
    } else {
      const ok = await confirm({ title: tw('wb.ex.deleteTitle'), text: tw('wb.ex.deleteFile', { name: e.path }), detail: h('p', { class: 'wb-dlg-note', text: tw('wb.ex.deleteNote') }), ok: tw('wb.ex.delete'), danger: true });
      if (!ok) return;
      try { await wb('wb.fs.delete', { root, path: e.path }, { timeout: 15 * 60 * 1000 }); } catch (err) { ctx.notify(err.message, 'bad'); return; }
    }
    const r = rs(root);
    r.expanded.delete(e.path);
    r.children.delete(e.path);
    ctx.removed(root, e.path, e.type === 'dir');
    changed(root, [e.path]);
    tree.focus({ preventScroll: true });
  }

  const copy = (text) => navigator.clipboard?.writeText(text).then(() => ctx.notify(tw('wb.ex.copied')), () => {});
  const absOf = (root, rel) => (root.path ? `${root.path}${root.path.includes('\\') ? '\\' : '/'}${rel.split('/').join(root.path.includes('\\') ? '\\' : '/')}` : rel);

  function rowMenu(x, y, root, e) {
    const dir = e.type === 'dir' ? e.path : parentOf(e.path);
    contextMenu(x, y, [
      ...(e.type === 'file' ? [{ label: tw('wb.ex.open'), run: () => ctx.open(root.id, e.path, { focus: true }) }, { label: tw('wb.ex.openSide'), keys: 'Ctrl Enter', run: () => ctx.open(root.id, e.path, { side: true }) }, 'sep'] : []),
      { label: tw('wb.ex.newFile'), run: () => newItem(root.id, dir, 'file') },
      { label: tw('wb.ex.newFolder'), run: () => newItem(root.id, dir, 'dir') },
      'sep',
      { label: tw('wb.ex.rename'), keys: 'F2', run: () => rename(root.id, e) },
      { label: tw('wb.ex.delete'), keys: 'Delete', danger: true, run: () => remove(root.id, e) },
      'sep',
      { label: tw('wb.ex.copyPath'), run: () => copy(absOf(root, e.path)) },
      { label: tw('wb.ex.copyRel'), run: () => copy(e.path) },
      ...(e.type === 'dir' ? [{ label: tw('wb.ex.findIn'), run: () => ctx.searchIn(root.id, e.path) }, { label: tw('wb.ex.terminalHere'), run: () => ctx.terminalHere(root.id, e.path) }] : []),
    ]);
  }

  function rootMenu(x, y, root) {
    contextMenu(x, y, [
      { label: tw('wb.ex.newFile'), run: () => newItem(root.id, '', 'file') },
      { label: tw('wb.ex.newFolder'), run: () => newItem(root.id, '', 'dir') },
      { label: tw('wb.ex.refresh'), run: () => reload(root.id) },
      'sep',
      { label: tw('wb.ex.findIn'), run: () => ctx.searchIn(root.id, '') },
      { label: tw('wb.ex.terminalHere'), run: () => ctx.terminalHere(root.id, '') },
      { label: tw('wb.ex.copyPath'), run: () => copy(root.path || '') },
      ...(root.workspace ? [] : ['sep', { label: tw('wb.ex.removeRoot'), run: () => ctx.removeRoot(root.id) }]),
    ]);
  }

  /* ---------- keyboard ---------- */
  tree.addEventListener('keydown', (ev) => {
    const rows = [...tree.querySelectorAll('[role="treeitem"]')];
    if (!rows.length) return;
    let i = rows.findIndex((r) => r.dataset.key === focusKey);
    const cur = rows[i];
    const go = (j) => {
      const r = rows[Math.max(0, Math.min(rows.length - 1, j))];
      focusKey = r.dataset.key;
      for (const x of rows) x.tabIndex = -1;
      r.tabIndex = 0;
      r.focus({ preventScroll: true });
      scrollInto(tree, r);
      for (const x of rows) x.classList.toggle('is-focus', x === r);
    };
    const info = cur ? { root: cur.dataset.root, path: cur.dataset.path || '', kind: cur.dataset.kind } : null;
    const entry = () => {
      const list = rs(info.root).children.get(parentOf(info.path)) || [];
      return list.find((x) => x.path === info.path);
    };
    switch (ev.key) {
      case 'ArrowDown': ev.preventDefault(); go(i < 0 ? 0 : i + 1); break;
      case 'ArrowUp': ev.preventDefault(); go(i < 0 ? 0 : i - 1); break;
      case 'Home': ev.preventDefault(); go(0); break;
      case 'End': ev.preventDefault(); go(rows.length - 1); break;
      case 'ArrowRight':
        if (!info) return;
        ev.preventDefault();
        if (info.kind === 'dir' && !rs(info.root).expanded.has(info.path)) toggle(info.root, info.path, true);
        else if (info.kind === 'root' && rs(info.root).collapsed) { rs(info.root).collapsed = false; persist(); paint(); } else go(i + 1);
        break;
      case 'ArrowLeft':
        if (!info) return;
        ev.preventDefault();
        if (info.kind === 'dir' && rs(info.root).expanded.has(info.path)) toggle(info.root, info.path, false);
        else if (info.kind === 'root') { rs(info.root).collapsed = true; persist(); paint(); } else {
          const parent = parentOf(info.path);
          const j = rows.findIndex((r) => r.dataset.key === `${info.root}\u0001${parent}`);
          if (j >= 0) go(j);
        }
        break;
      case 'Enter':
        if (!info) return;
        ev.preventDefault();
        if (info.kind === 'file') ctx.open(info.root, info.path, { focus: true, side: ev.ctrlKey || ev.metaKey });
        else if (info.kind === 'dir') toggle(info.root, info.path);
        break;
      case 'F2':
        if (info && (info.kind === 'file' || info.kind === 'dir')) { ev.preventDefault(); const e = entry(); if (e) rename(info.root, e); }
        break;
      case 'Delete':
        if (info && (info.kind === 'file' || info.kind === 'dir')) { ev.preventDefault(); const e = entry(); if (e) remove(info.root, e); }
        break;
      default:
    }
  });
  tree.addEventListener('focus', () => {
    if (!focusKey) {
      const first = tree.querySelector('[role="treeitem"]');
      if (first) { focusKey = first.dataset.key; first.classList.add('is-focus'); }
    }
  });

  return {
    el,
    actions,
    paint,
    reload,
    changed,
    reveal,
    newFile: (root = 'ws') => newItem(root, '', 'file'),
    newFolder: (root = 'ws') => newItem(root, '', 'dir'),
    focus: () => { tree.focus({ preventScroll: true }); },
    forget(rootId) { state.delete(rootId); persist(); },
  };
}
