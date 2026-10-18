// Editor groups: up to three columns of tabs side by side (layout.js), one code editor per
// group, one model per file shared by every group that shows it. Built on the Code window
// (ui/editor/code-window.js): crew hunk review with Accept or Reject, "Mel is editing" marks,
// other people's cursors, format on save. Workspace files are shared documents (session.js);
// files of other roots load and save as they are.

import { h, clear } from '/js/dom.js';
import { FORMATTABLE, badgeOf, languageLabel, languageOf } from '/editor/languages.js';
import { acceptHunk, changedLines, hunks, rejectHunk } from '/editor/linediff.js';
import * as L from './layout.js';
import { PlainHandle, sessionFor, collab } from './session.js';
import { wb } from './net.js';
import { tw } from './strings.js';
import { choose } from './dialogs.js';

const ICON = {
  x: '<svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7 7 17"/></svg>',
  split: '<svg viewBox="0 0 24 24"><rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M12 4.5v15"/></svg>',
  more: '<svg viewBox="0 0 24 24"><circle cx="6" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="18" cy="12" r="1.3"/></svg>',
};

const cssId = (id) => String(id).replace(/[^a-zA-Z0-9_-]/g, '_');
const cssText = (s) => String(s).replace(/["\\\n\r]/g, ' ');

/** One style element for per person and per worker colors (cursors, name tags, crew marks). */
const styles = new Map();
function ensureStyle(kind, id, color, name) {
  const key = `${kind}:${id}:${color}:${name}`;
  if (styles.get(`${kind}:${id}`) === key) return;
  styles.set(`${kind}:${id}`, key);
  let el = document.getElementById('ed-dyn-style');
  if (!el) {
    el = document.createElement('style');
    el.id = 'ed-dyn-style';
    document.head.append(el);
  }
  const c = cssId(id);
  const rules = kind === 'u'
    ? `.ed-u-${c}.ed-rsel{background:${color}38}.ed-u-${c}.ed-rcaret{border-left:2px solid ${color}}.ed-u-${c}.ed-rcaret::after{content:"${cssText(name)}";background:${color}}`
    : `.ed-w-${c}.ed-crew-line{background:${color}1c}.ed-w-${c}.ed-crew-gutter{border-left:3px solid ${color}}.ed-w-${c}.ed-crew-tag{color:${color}}`;
  el.textContent = el.textContent.replace(new RegExp(`/\\*${kind}:${c}\\*/[^\\n]*\\n`, 'g'), '') + `/*${kind}:${c}*/${rules}\n`;
}

export const uriFor = (monaco, root, path) => monaco.Uri.from({ scheme: 'file', path: `/${root}/${path}` });
/** { root, path } from a model URI made by uriFor, or null. */
export function fromUri(uri) {
  if (!uri || uri.scheme !== 'file') return null;
  const m = /^\/([^/]+)\/(.+)$/.exec(uri.path);
  return m ? { root: m[1], path: m[2] } : null;
}

/**
 * @param {{
 *   monaco: any, room: import('./session.js').RoomSession, settings: () => object, themeId: () => string,
 *   desk: any, projectModels: { adopt(uri): boolean, release(uri, text): void },
 *   onChange: () => void, reveal: (root: string, path: string) => void, renderSettings: (el: HTMLElement) => void,
 *   rootName: (id: string) => string
 * }} ctx
 */
export function createEditors(ctx) {
  const { monaco, room } = ctx;
  const el = h('div', { class: 'wb-groups' });
  let layout = L.deserialize(read('layout', ''));
  const views = new Map(); // group id -> view
  const entries = new Map(); // file key -> entry
  const diffs = new Map(); // diff key -> { original, modified, data }
  const baselines = new Map(); // file key -> text before the crew changes not reviewed yet
  const known = new Map(); // ws path -> last text seen on disk
  const offs = [];
  let disposed = false;
  let settingsEl = null;
  let follow = null;
  let saveState = '';

  function read(k, d) { try { return localStorage.getItem(`hivedesk.wb.${k}`) ?? d; } catch { return d; } }
  function write(k, v) { try { localStorage.setItem(`hivedesk.wb.${k}`, v); } catch { /* not kept */ } }

  const S = () => sessionFor(room);
  const canEdit = (e) => (e && e.kind === 'plain') || S().canEdit();

  function setLayout(next) {
    layout = next;
    write('layout', L.serialize(layout));
    render();
    ctx.onChange();
  }

  /* ---------- documents ---------- */
  async function entryFor(key) {
    if (entries.has(key)) return entries.get(key);
    const { root, path } = L.parseKey(key);
    let handle;
    let kind;
    if (root === 'ws') {
      const s = S();
      kind = s === room ? 'room' : 'collab';
      handle = await s.docs().open(path);
    } else {
      const r = await wb('wb.fs.read', { root, path });
      if (r.content == null) throw new Error(r.binary ? tw('wb.ed.binary') : tw('wb.ed.tooLarge', { size: Math.round(r.bytes / 1048576) }));
      kind = 'plain';
      handle = new PlainHandle(root, path, r.content);
    }
    if (disposed) return null;
    if (entries.has(key)) return entries.get(key);
    const uri = uriFor(monaco, root, path);
    let model = monaco.editor.getModel(uri);
    const adopted = !!model && ctx.projectModels.adopt(uri);
    if (model && !adopted) { model.dispose(); model = null; }
    if (!model) model = monaco.editor.createModel(handle.text(), languageOf(path), uri);
    const e = { key, root, path, kind, model, handle, offs: [], adopted };
    entries.set(key, e);
    if (root === 'ws' && !known.has(path)) known.set(path, handle.savedText);
    let applying = false;
    if (model.getValue() !== handle.text()) {
      applying = true;
      model.setValue(handle.text());
      applying = false;
    }
    const sub = model.onDidChangeContent((ev) => {
      if (applying) return;
      const changes = [...ev.changes].sort((a, b) => b.rangeOffset - a.rangeOffset);
      for (const c of changes) handle.localEdit(c.rangeOffset, c.rangeLength, c.text);
      paintTabs();
      sendPresence();
    });
    e.offs.push(() => sub.dispose());
    e.offs.push(handle.on('remote', (changes) => {
      applying = true;
      try {
        for (const c of changes) {
          const a = model.getPositionAt(c.at);
          const b = model.getPositionAt(c.at + c.remove);
          model.applyEdits([{ range: new monaco.Range(a.lineNumber, a.column, b.lineNumber, b.column), text: c.insert, forceMoveMarkers: true }]);
        }
      } finally {
        applying = false;
      }
      if (model.getValue() !== handle.text()) {
        applying = true;
        model.setValue(handle.text());
        applying = false;
      }
      paintTabs();
      paintRemote();
      for (const v of views.values()) if (v.review === key) renderHunks(v);
    }));
    e.offs.push(handle.on('saved', () => {
      if (root === 'ws') known.set(path, handle.savedText);
      paintTabs();
    }));
    return e;
  }

  function dropEntry(key) {
    const e = entries.get(key);
    if (!e) return;
    for (const off of e.offs) off();
    entries.delete(key);
    if (e.adopted) ctx.projectModels.release(e.model.uri, e.handle.savedText);
    else e.model.dispose();
    if (e.kind === 'room') room.close(e.path);
    else if (e.kind === 'collab' && collab.mode === 'solo') collab.docs().docs.delete(e.path);
  }

  /* ---------- views ---------- */
  function editorOptions() {
    const s = ctx.settings();
    return {
      theme: ctx.themeId(),
      fontSize: s.fontSize,
      lineHeight: s.lineHeight || 0,
      tabSize: s.tabSize,
      insertSpaces: s.insertSpaces,
      wordWrap: s.wordWrap,
      minimap: { enabled: s.minimap, renderCharacters: false },
      lineNumbers: s.lineNumbers,
      renderWhitespace: s.renderWhitespace,
      stickyScroll: { enabled: s.stickyScroll },
    };
  }

  function makeView(g) {
    const tabsEl = h('div', { class: 'wb-tabs', role: 'tablist', on: { dragover: (ev) => onTabDragOver(ev, v), drop: (ev) => onTabDrop(ev, v) } });
    const splitBtn = h('button', { class: 'wb-ibtn', type: 'button', title: tw('wb.ed.split'), attrs: { 'aria-label': tw('wb.ed.split') }, html: ICON.split, on: { click: () => setLayout(L.split(layout, { group: g.id })) } });
    const closeGroupBtn = h('button', { class: 'wb-ibtn', type: 'button', title: tw('wb.ed.closeGroup'), attrs: { 'aria-label': tw('wb.ed.closeGroup') }, html: ICON.x, on: { click: () => closeGroup(g.id) } });
    const head = h('div', { class: 'wb-group-h' }, tabsEl, h('div', { class: 'wb-tabs-act' }, splitBtn, closeGroupBtn));
    const crumbs = h('nav', { class: 'wb-crumbs', attrs: { 'aria-label': tw('wb.ed.breadcrumb') } });
    const reviewBtn = h('button', { class: 'wb-btn is-sm', type: 'button', on: { click: () => (v.review ? closeReview(v) : openReview(v)) } });
    const formatBtn = h('button', { class: 'wb-btn is-sm', type: 'button', text: tw('wb.ed.format'), on: { click: () => format(v) } });
    const saveBtn = h('button', { class: 'wb-btn is-sm is-primary', type: 'button', text: tw('wb.ed.save'), on: { click: () => save(v.tab) } });
    const bar = h('div', { class: 'wb-bar' }, crumbs, h('span', { class: 'wb-sp' }), reviewBtn, formatBtn, saveBtn);
    const editorHost = h('div', { class: 'wb-monaco' });
    const diffHost = h('div', { class: 'wb-diff', hidden: true });
    const hunkBar = h('div', { class: 'wb-hunks', hidden: true });
    const settingsHost = h('div', { class: 'wb-settings-host', hidden: true });
    const banner = h('div', { class: 'wb-banner', hidden: true });
    const emptyEl = h('div', { class: 'wb-empty' });
    const editingPill = h('div', { class: 'wb-editing', hidden: true, attrs: { role: 'status' } });
    const stage = h('div', { class: 'wb-stage' }, editorHost, hunkBar, diffHost, settingsHost, emptyEl, editingPill);
    const root = h('section', { class: 'wb-group', dataset: { group: g.id }, on: { pointerdown: () => { if (layout.activeGroup !== g.id) setLayout(L.focusGroup(layout, g.id)); } } }, head, bar, banner, stage);
    const editor = monaco.editor.create(editorHost, {
      model: null,
      automaticLayout: true,
      fontFamily: '"Cascadia Code", "JetBrains Mono", Consolas, "Courier New", monospace',
      cursorBlinking: 'smooth',
      cursorSmoothCaretAnimation: 'on',
      smoothScrolling: true,
      scrollBeyondLastLine: false,
      bracketPairColorization: { enabled: true },
      guides: { bracketPairs: true, indentation: true },
      multiCursorModifier: 'alt',
      fixedOverflowWidgets: true,
      padding: { top: 8 },
      ...editorOptions(),
    });
    const v = { id: g.id, root, tabsEl, crumbs, bar, reviewBtn, formatBtn, saveBtn, banner, stage, editorHost, diffHost, hunkBar, settingsHost, emptyEl, editingPill, editor, diffEditor: null, tab: null, review: null, viewStates: new Map(), decos: { remote: [], crew: [] }, crewTimer: null };
    editor.onDidFocusEditorText(() => { if (layout.activeGroup !== g.id) { layout = L.focusGroup(layout, g.id); paintActive(); ctx.onChange(); } });
    editor.onDidChangeCursorPosition(() => ctx.onChange());
    editor.onDidChangeCursorSelection(() => sendPresence());
    ctx.addEditorActions?.(editor, v);
    return v;
  }

  function disposeView(v) {
    v.editor.dispose();
    v.diffEditor?.dispose();
    v.originalModel?.dispose();
    v.root.remove();
  }

  function render() {
    if (disposed) return;
    const ids = new Set(layout.groups.map((g) => g.id));
    for (const [id, v] of views) if (!ids.has(id)) { disposeView(v); views.delete(id); }
    clear(el);
    layout.groups.forEach((g, i) => {
      let v = views.get(g.id);
      if (!v) { v = makeView(g); views.set(g.id, v); }
      v.root.style.flex = `${layout.sizes[i]} 1 0`;
      if (i) el.append(sash(i - 1));
      el.append(v.root);
    });
    el.dataset.groups = String(layout.groups.length);
    for (const g of layout.groups) showTab(views.get(g.id), g.active);
    // Models no tab shows any more are released.
    const open = new Set(L.openKeys(layout));
    for (const key of [...entries.keys()]) if (!open.has(key)) dropEntry(key);
    for (const key of [...diffs.keys()]) if (!open.has(key)) { diffs.get(key).original.dispose(); diffs.get(key).modified.dispose(); diffs.delete(key); }
    paintTabs();
    paintActive();
  }

  function sash(i) {
    const s = h('div', { class: 'wb-sash', role: 'separator', attrs: { 'aria-orientation': 'vertical', tabindex: '0', 'aria-label': tw('wb.ed.resize') } });
    s.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      s.setPointerCapture(ev.pointerId);
      const rect = el.getBoundingClientRect();
      const before = layout.sizes.slice(0, i).reduce((a, b) => a + b, 0);
      const move = (e2) => {
        const f = (e2.clientX - rect.left) / rect.width - before;
        layout = L.resize(layout, i, f);
        layout.groups.forEach((g, k) => { const v = views.get(g.id); if (v) v.root.style.flex = `${layout.sizes[k]} 1 0`; });
      };
      const up = () => { s.removeEventListener('pointermove', move); s.removeEventListener('pointerup', up); write('layout', L.serialize(layout)); };
      s.addEventListener('pointermove', move);
      s.addEventListener('pointerup', up);
    });
    s.addEventListener('keydown', (ev) => {
      if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
      setLayout(L.resize(layout, i, layout.sizes[i] + (ev.key === 'ArrowLeft' ? -0.04 : 0.04)));
    });
    return s;
  }

  function paintActive() {
    for (const [id, v] of views) v.root.classList.toggle('is-active', id === layout.activeGroup && layout.groups.length > 1);
  }

  /* ---------- tabs ---------- */
  function tabLabel(key) {
    const p = L.parseKey(key);
    if (p.kind === 'settings') return { name: tw('wb.settings.title'), badge: ['{}', 'var(--wb-accent)'], title: tw('wb.settings.title') };
    const name = p.path.split('/').pop();
    if (p.kind === 'diff') return { name: `${name} (${p.staged ? tw('wb.scm.staged') : tw('wb.scm.workTree')})`, badge: ['±', 'var(--wb-ok)'], title: `${p.path} ${tw('wb.scm.diff')}` };
    const [txt, color] = badgeOf(p.path);
    return { name, badge: [txt, color], title: p.root === 'ws' ? p.path : `${ctx.rootName(p.root)}: ${p.path}` };
  }

  function paintTabs() {
    const people = S().people();
    for (const g of layout.groups) {
      const v = views.get(g.id);
      if (!v) continue;
      clear(v.tabsEl);
      for (const key of g.tabs) {
        const e = entries.get(key);
        const p = L.parseKey(key);
        const lab = tabLabel(key);
        const dots = p.kind === 'file' && p.root === 'ws' ? people.filter((x) => x.file === p.path && x.id !== S().myId()).map((x) => h('span', { class: 'wb-dot', style: { background: x.color }, title: x.name })) : [];
        const close = h('button', { class: 'wb-x', type: 'button', tabindex: '-1', attrs: { 'aria-label': tw('wb.ed.closeTab', { name: lab.name }) }, html: ICON.x, on: { click: (ev) => { ev.stopPropagation(); closeTab(key, g.id); } } });
        const dirty = !!e?.handle.dirty;
        const tab = h('div', {
          class: `wb-tab${key === g.active ? ' is-active' : ''}${dirty ? ' is-dirty' : ''}`,
          role: 'tab', tabindex: key === g.active ? '0' : '-1', title: lab.title, draggable: 'true',
          attrs: { 'aria-selected': String(key === g.active) }, dataset: { key },
          on: {
            click: () => setLayout(L.setActive(layout, g.id, key)),
            auxclick: (ev) => { if (ev.button === 1) closeTab(key, g.id); },
            contextmenu: (ev) => { ev.preventDefault(); ctx.tabMenu?.(ev.clientX, ev.clientY, key, g.id); },
            dragstart: (ev) => { ev.dataTransfer.setData('text/x-wb-tab', JSON.stringify({ key, from: g.id })); ev.dataTransfer.effectAllowed = 'move'; },
            keydown: (ev) => {
              if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); setLayout(L.setActive(layout, g.id, key)); }
              if (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') {
                ev.preventDefault();
                const i = g.tabs.indexOf(key) + (ev.key === 'ArrowRight' ? 1 : -1);
                v.tabsEl.children[(i + g.tabs.length) % g.tabs.length]?.focus();
              }
              if (ev.key === 'Delete') closeTab(key, g.id);
            },
          },
        }, h('span', { class: 'wb-badge', style: { color: lab.badge[1] }, text: lab.badge[0] }), h('span', { class: 'wb-name', text: lab.name }), ...dots, h('span', { class: 'wb-dirty' }), close);
        v.tabsEl.append(tab);
      }
    }
  }

  function onTabDragOver(ev, v) {
    if (![...ev.dataTransfer.types].includes('text/x-wb-tab')) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'move';
    v.tabsEl.classList.add('is-drop');
    clearTimeout(v.dropTimer);
    v.dropTimer = setTimeout(() => v.tabsEl.classList.remove('is-drop'), 150);
  }

  function onTabDrop(ev, v) {
    let d;
    try { d = JSON.parse(ev.dataTransfer.getData('text/x-wb-tab')); } catch { return; }
    ev.preventDefault();
    const tabs = [...v.tabsEl.children];
    let index = tabs.findIndex((t) => ev.clientX < t.getBoundingClientRect().left + t.offsetWidth / 2);
    if (index < 0) index = tabs.length;
    setLayout(L.moveTab(layout, d.key, v.id, index));
  }

  /* ---------- showing a tab in a group ---------- */
  async function showTab(v, key) {
    if (!v) return;
    const prev = v.tab;
    if (prev && prev !== key && entries.get(prev) && v.editor.getModel() === entries.get(prev).model) v.viewStates.set(prev, v.editor.saveViewState());
    v.tab = key;
    const p = key ? L.parseKey(key) : { kind: 'none' };
    if (v.review && v.review !== key) closeReview(v);
    v.editorHost.hidden = p.kind !== 'file' || !!v.review;
    v.diffHost.hidden = p.kind !== 'diff' && !v.review;
    v.hunkBar.hidden = !v.review;
    v.settingsHost.hidden = p.kind !== 'settings';
    v.bar.hidden = p.kind === 'settings' || p.kind === 'none';
    v.emptyEl.hidden = p.kind !== 'none';
    if (p.kind === 'none') {
      v.editor.setModel(null);
      clear(v.emptyEl).append(emptyCard());
      paintCrumbs(v);
      return;
    }
    if (p.kind === 'settings') {
      if (!settingsEl) { settingsEl = h('div', { class: 'wb-settings' }); ctx.renderSettings(settingsEl); }
      v.settingsHost.replaceChildren(settingsEl);
      paintCrumbs(v);
      return;
    }
    if (p.kind === 'diff') return showDiff(v, key, p);
    let e;
    try {
      e = await entryFor(key);
    } catch (err) {
      if (v.tab !== key) return;
      v.editorHost.hidden = true;
      v.emptyEl.hidden = false;
      clear(v.emptyEl).append(h('p', { class: 'wb-error', text: `${p.path}: ${err.message}` }));
      return;
    }
    if (!e || v.tab !== key) return;
    if (v.editor.getModel() !== e.model) {
      v.editor.setModel(e.model);
      const vs = v.viewStates.get(key);
      if (vs) v.editor.restoreViewState(vs);
    }
    v.editor.updateOptions({ readOnly: !canEdit(e) });
    paintCrumbs(v);
    paintRemote();
    sendPresence();
    if (v.pendingReveal?.key === key) {
      const { line, col } = v.pendingReveal;
      v.pendingReveal = null;
      v.editor.setPosition({ lineNumber: line, column: col || 1 });
      v.editor.revealLineInCenter(line);
    }
    if (v.id === layout.activeGroup && v.wantFocus) { v.wantFocus = false; v.editor.focus(); }
    ctx.onChange();
  }

  async function showDiff(v, key, p) {
    let d = diffs.get(key);
    if (!d) {
      let data;
      try { data = await wb('wb.scm.diff', { root: p.root, path: p.path, staged: p.staged }); } catch (err) {
        if (v.tab !== key) return;
        v.diffHost.hidden = true;
        v.emptyEl.hidden = false;
        clear(v.emptyEl).append(h('p', { class: 'wb-error', text: `${p.path}: ${err.message}` }));
        return;
      }
      const lang = languageOf(p.path);
      d = { data, original: monaco.editor.createModel(data.before ?? '', lang), modified: monaco.editor.createModel(data.after ?? tw('wb.ed.tooLargeShort'), lang) };
      diffs.set(key, d);
    }
    if (v.tab !== key) return;
    v.diffEditor ??= monaco.editor.createDiffEditor(v.diffHost, { renderSideBySide: true, readOnly: true, originalEditable: false, automaticLayout: true, minimap: { enabled: false }, theme: ctx.themeId() });
    v.diffEditor.updateOptions({ renderSideBySide: v.root.clientWidth > 720 });
    v.diffEditor.setModel({ original: d.original, modified: d.modified });
    paintCrumbs(v);
  }

  async function refreshDiff(key) {
    const d = diffs.get(key);
    if (!d) return;
    const p = L.parseKey(key);
    try {
      const data = await wb('wb.scm.diff', { root: p.root, path: p.path, staged: p.staged });
      d.original.setValue(data.before ?? '');
      d.modified.setValue(data.after ?? '');
    } catch { /* the file is gone: keep the last diff */ }
  }

  function emptyCard() {
    const k = (keys) => h('span', { class: 'wb-keys' }, ...keys.split(' ').map((x) => h('kbd', { text: x })));
    return h('div', { class: 'wb-empty-card' },
      h('div', { class: 'wb-empty-mark', html: '<svg viewBox="0 0 48 48"><path d="M24 4 41 14v20L24 44 7 34V14z"/><path d="M17 20l-4 4 4 4M31 20l4 4-4 4M26 17l-4 14"/></svg>' }),
      h('p', { class: 'wb-empty-t', text: tw('wb.ed.emptyTitle') }),
      h('ul', { class: 'wb-empty-keys' },
        h('li', {}, h('span', { text: tw('wb.cmd.quickOpen') }), k('Ctrl P')),
        h('li', {}, h('span', { text: tw('wb.cmd.palette') }), k('Ctrl Shift P')),
        h('li', {}, h('span', { text: tw('wb.cmd.search') }), k('Ctrl Shift F')),
        h('li', {}, h('span', { text: tw('wb.cmd.terminal') }), k('Ctrl J'))));
  }

  /* ---------- breadcrumb and bar ---------- */
  function paintCrumbs(v) {
    clear(v.crumbs);
    const p = v.tab ? L.parseKey(v.tab) : null;
    if (!p || p.kind === 'settings') return;
    if (p.root !== 'ws') v.crumbs.append(h('span', { class: 'wb-crumb-root', text: ctx.rootName(p.root) }), h('span', { class: 'wb-crumb-sep', text: '/' }));
    const parts = p.path.split('/');
    parts.forEach((part, i) => {
      if (i) v.crumbs.append(h('span', { class: 'wb-crumb-sep', text: '/' }));
      const dir = parts.slice(0, i + 1).join('/');
      v.crumbs.append(i === parts.length - 1 ? h('b', { text: part }) : h('button', { type: 'button', class: 'wb-crumb', text: part, on: { click: () => ctx.reveal(p.root, dir) } }));
    });
    const isFile = p.kind === 'file';
    const e = entries.get(v.tab);
    v.reviewBtn.hidden = !isFile || (!baselines.has(v.tab) && !v.review);
    v.reviewBtn.textContent = v.review ? tw('wb.ed.closeReview') : tw('wb.ed.review');
    v.formatBtn.hidden = !isFile || !canEdit(e);
    v.saveBtn.hidden = !isFile;
    v.saveBtn.disabled = !canEdit(e);
    v.formatBtn.title = isFile && FORMATTABLE.has(languageOf(p.path)) ? tw('wb.ed.formatLang', { lang: languageLabel(languageOf(p.path)) }) : tw('wb.ed.trim');
  }

  /* ---------- opening and closing ---------- */
  function open(root, path, { group, line, col, focus = true, side = false } = {}) {
    const key = L.fileKey(root, path);
    let next = layout;
    if (side) next = L.split(next, { group: next.activeGroup, key });
    else next = L.openTab(next, key, { group });
    const g = L.activeGroup(next);
    setLayout(next);
    const v = views.get(g.id);
    if (v) {
      v.wantFocus = focus;
      if (line) {
        v.pendingReveal = { key, line, col };
        if (v.tab === key && v.editor.getModel() === entries.get(key)?.model) {
          v.pendingReveal = null;
          v.editor.setPosition({ lineNumber: line, column: col || 1 });
          v.editor.revealLineInCenter(line);
        }
      }
      if (focus && v.tab === key && v.editor.getModel()) v.editor.focus();
    }
  }

  function openDiff(root, path, staged) {
    const key = L.diffKey(root, path, staged);
    if (diffs.has(key)) refreshDiff(key);
    setLayout(L.openTab(layout, key));
  }

  function openSettings() {
    setLayout(L.openTab(layout, L.SETTINGS_KEY));
  }

  async function closeTab(key, group) {
    const e = entries.get(key);
    const elsewhere = layout.groups.filter((g) => g.tabs.includes(key)).length > 1;
    if (e?.handle.dirty && !elsewhere && e.kind !== 'collab') {
      const name = e.path.split('/').pop();
      const r = await choose({ title: tw('wb.ed.unsavedTitle'), text: tw('wb.ed.unsaved', { name }), buttons: [{ id: 'cancel', label: tw('wb.cancel') }, { id: 'drop', label: tw('wb.ed.dontSave'), danger: true }, { id: 'save', label: tw('wb.ed.save'), primary: true }] });
      if (r === 'cancel' || r === null) return;
      if (r === 'save') {
        const ok = await save(key);
        if (!ok) return;
      }
      if (r === 'drop' && e.kind === 'room') await room.reload(e.path).catch(() => {});
    }
    setLayout(L.closeTab(layout, key, { group }));
  }

  function closeGroup(id) {
    setLayout(L.closeGroup(layout, id));
  }

  /* ---------- saving and formatting ---------- */
  async function format(v = activeView()) {
    const e = v && entries.get(v.tab);
    if (!e || !canEdit(e) || v.editor.getModel() !== e.model) return;
    const lang = languageOf(e.path);
    if (FORMATTABLE.has(lang) || ['javascript', 'typescript'].includes(lang)) {
      const NL = String.fromCharCode(10);
      const hadNewline = e.model.getValue().endsWith(NL);
      try { await v.editor.getAction('editor.action.formatDocument')?.run(); } catch { /* no formatter */ }
      const now = e.model.getValue();
      if (hadNewline && now && !now.endsWith(NL)) {
        const end = e.model.getFullModelRange().getEndPosition();
        e.model.pushEditOperations([], [{ range: new monaco.Range(end.lineNumber, end.column, end.lineNumber, end.column), text: NL }], () => null);
      }
      return;
    }
    const text = e.model.getValue();
    const tidy = text.replace(/[ \t]+$/gm, '').replace(/\n*$/, '\n');
    if (tidy !== text && text.length) e.model.pushEditOperations([], [{ range: e.model.getFullModelRange(), text: tidy }], () => null);
  }

  function setSave(text) {
    saveState = text;
    ctx.onChange();
  }

  /** Saves one file tab. Returns true when it was saved. */
  async function save(key = activeTab(), { tidy = true } = {}) {
    const e = entries.get(key);
    if (!e) return false;
    if (!canEdit(e)) { setSave(tw('wb.ed.readOnly')); return false; }
    const v = [...views.values()].find((x) => x.tab === key && x.editor.getModel() === e.model);
    if (tidy && ctx.settings().formatOnSave && v) await format(v).catch(() => {});
    setSave(collab.mode === 'guest' && e.kind === 'collab' ? tw('wb.ed.approval') : tw('wb.ed.saving'));
    try {
      await e.handle.save();
      setSave(tw('wb.ed.saved'));
      paintTabs();
      ctx.saved?.(e.root, e.path);
      return true;
    } catch (err) {
      setSave(tw('wb.ed.notSaved', { error: err.message }));
      paintTabs();
      return false;
    }
  }

  async function saveAll() {
    for (const [key, e] of entries) if (e.handle.dirty) await save(key, { tidy: false });
  }

  /* ---------- presence and remote cursors ---------- */
  let presenceTimer = null;
  function sendPresence() {
    clearTimeout(presenceTimer);
    presenceTimer = setTimeout(() => {
      const s = S();
      if (s === collab && collab.mode === 'solo') return;
      const v = activeView();
      const e = v && entries.get(v.tab);
      if (!e || e.root !== 'ws' || v.editor.getModel() !== e.model) return s.setPresence({ file: e?.root === 'ws' ? e.path : null, sel: [] });
      const sel = v.editor.getSelections().slice(0, 8).map((x) => ({
        a: e.handle.anchor(e.model.getOffsetAt({ lineNumber: x.selectionStartLineNumber, column: x.selectionStartColumn })),
        h: e.handle.anchor(e.model.getOffsetAt(x.getPosition())),
      }));
      s.setPresence({ file: e.path, sel });
      return undefined;
    }, 80);
  }

  function paintRemote() {
    const s = S();
    const people = new Map(s.people().map((p) => [p.id, p]));
    for (const v of views.values()) {
      const e = entries.get(v.tab);
      if (!e || e.root !== 'ws' || v.editor.getModel() !== e.model) { v.decos.remote = v.editor.deltaDecorations(v.decos.remote, []); continue; }
      const decos = [];
      for (const [id, p] of s.presence()) {
        if (id === s.myId() || p.file !== e.path) continue;
        const who = people.get(id) || { name: id, color: '#f2a93b' };
        ensureStyle('u', id, who.color, who.name);
        for (const x of p.sel || []) {
          const a = e.model.getPositionAt(e.handle.offset(x.a));
          const hd = e.model.getPositionAt(e.handle.offset(x.h));
          const start = monaco.Position.isBefore(a, hd) ? a : hd;
          const end = start === a ? hd : a;
          if (!a.equals(hd)) decos.push({ range: monaco.Range.fromPositions(start, end), options: { className: `ed-rsel ed-u-${cssId(id)}`, stickiness: 1 } });
          decos.push({ range: monaco.Range.fromPositions(hd, hd), options: { beforeContentClassName: `ed-rcaret ed-u-${cssId(id)}`, stickiness: 1, hoverMessage: { value: who.name } } });
        }
      }
      v.decos.remote = v.editor.deltaDecorations(v.decos.remote, decos);
    }
  }

  function setFollow(id) {
    follow = id;
    ctx.onChange();
    if (id) followTo(S().presence().get(id));
  }

  function followTo(p) {
    if (!p?.file) return;
    open('ws', p.file, { focus: false });
    setTimeout(() => {
      const v = activeView();
      const e = v && entries.get(v.tab);
      const head = p.sel?.[0]?.h;
      if (e && head !== undefined && v.editor.getModel() === e.model) v.editor.revealLineInCenterIfOutsideViewport(e.model.getPositionAt(e.handle.offset(head)).lineNumber);
    }, 120);
  }

  /* ---------- crew activity ---------- */
  const isCrew = (id) => id && id !== 'user' && !String(id).startsWith('guest') && !String(id).startsWith('peer:');
  const workerOf = (id) => ctx.desk.worker?.(id) || { id, name: id, color: '#f2a93b' };

  function showEditing(workerId, path) {
    const w = workerOf(workerId);
    for (const v of views.values()) {
      if (v.tab !== L.fileKey('ws', path)) continue;
      clear(v.editingPill).append(h('span', { class: 'wb-dot', style: { background: w.color } }), h('span', { text: tw('wb.ed.editing', { who: w.name, file: path.split('/').pop() }) }));
      v.editingPill.hidden = false;
      clearTimeout(v.editingPill.timer);
      v.editingPill.timer = setTimeout(() => (v.editingPill.hidden = true), 8000);
    }
  }

  function markCrewLines(path, workerId, before, after) {
    const w = workerOf(workerId);
    ensureStyle('w', workerId, w.color, w.name);
    const c = cssId(workerId);
    const ls = changedLines(before ?? '', after).slice(0, 400);
    for (const v of views.values()) {
      if (v.tab !== L.fileKey('ws', path)) continue;
      const decos = ls.map((line, i) => ({
        range: new monaco.Range(line, 1, line, 1),
        options: { isWholeLine: true, className: `ed-crew-line ed-w-${c}`, linesDecorationsClassName: `ed-crew-gutter ed-w-${c}`, ...(i === 0 ? { after: { content: `  ${tw('wb.ed.editingShort', { who: w.name })}`, inlineClassName: `ed-crew-tag ed-w-${c}` } } : {}) },
      }));
      v.decos.crew = v.editor.deltaDecorations(v.decos.crew, decos);
      clearTimeout(v.crewTimer);
      v.crewTimer = setTimeout(() => (v.decos.crew = v.editor.deltaDecorations(v.decos.crew, [])), 6000);
    }
  }

  function showBanner(path, text, actions) {
    for (const v of views.values()) {
      if (v.tab !== L.fileKey('ws', path) && !v.tab?.endsWith(`:${path}`)) continue;
      clear(v.banner).append(h('span', { text }), h('span', { class: 'wb-sp' }), ...actions.map(([label, run]) => h('button', { class: 'wb-btn is-sm', type: 'button', text: label, on: { click: () => { v.banner.hidden = true; run(); } } })));
      v.banner.hidden = false;
    }
  }

  function onEngineEvent(ev) {
    const d = ev.data || {};
    if (ev.type === 'tool.called' && (d.tool === 'write_file' || d.tool === 'edit_file') && d.args?.path && isCrew(d.workerId)) {
      if (L.openKeys(layout).includes(L.fileKey('ws', d.args.path))) showEditing(d.workerId, d.args.path);
    } else if (ev.type === 'file.changed') {
      const key = L.fileKey('ws', d.path);
      const before = known.get(d.path) ?? (typeof d.content === 'string' ? null : undefined);
      if (typeof d.content === 'string') known.set(d.path, d.content);
      if (isCrew(d.workerId) && d.op !== 'delete') {
        if (!baselines.has(key)) baselines.set(key, before ?? '');
        const e = entries.get(key);
        // In the engine room the engine takes the change into the shared text itself.
        if (e && e.kind === 'collab' && typeof d.content === 'string' && collab.mode !== 'guest') {
          if (e.handle.text() === e.handle.savedText) {
            e.handle.setText(d.content, 'crew');
            e.handle.savedText = d.content;
          } else if (e.handle.text() !== d.content) {
            showBanner(d.path, tw('wb.ed.diskChanged', { who: workerOf(d.workerId).name }), [[tw('wb.ed.loadTheirs'), () => { e.handle.setText(d.content, 'crew'); e.handle.savedText = d.content; paintTabs(); }], [tw('wb.ed.keepMine'), () => {}]]);
          }
        }
        if (typeof d.content === 'string') setTimeout(() => markCrewLines(d.path, d.workerId, before, d.content), 40);
        if (baselines.get(key) === d.content) baselines.delete(key);
      }
      for (const k of diffs.keys()) if (k.endsWith(`:${d.path}`) && k.startsWith('d:ws:')) refreshDiff(k);
      for (const v of views.values()) paintCrumbs(v);
      paintTabs();
    }
  }

  /** A root outside the workspace changed on disk (fs.watch): reload clean files, warn about dirty ones. */
  async function onDiskChanged(root, paths) {
    for (const path of paths) {
      const key = L.fileKey(root, path);
      const e = entries.get(key);
      if (!e || e.kind !== 'plain') continue;
      let r;
      try { r = await wb('wb.fs.read', { root, path }); } catch { continue; }
      if (r.content == null || r.content === e.handle.savedText) continue;
      if (!e.handle.dirty) { e.handle.setText(r.content); e.handle.savedText = r.content; paintTabs(); }
      else showBanner(path, tw('wb.ed.diskChangedOutside'), [[tw('wb.ed.loadTheirs'), () => { e.handle.setText(r.content); e.handle.savedText = r.content; paintTabs(); }], [tw('wb.ed.keepMine'), () => {}]]);
    }
  }

  /* ---------- review of crew changes ---------- */
  async function openReview(v = activeView()) {
    const key = v?.tab;
    if (!key || !baselines.has(key)) return;
    const e = await entryFor(key);
    if (!e) return;
    v.review = key;
    v.diffEditor ??= monaco.editor.createDiffEditor(v.diffHost, { renderSideBySide: true, readOnly: true, originalEditable: false, automaticLayout: true, minimap: { enabled: false }, theme: ctx.themeId() });
    v.originalModel?.dispose();
    v.originalModel = monaco.editor.createModel(baselines.get(key), languageOf(e.path));
    v.diffEditor.setModel({ original: v.originalModel, modified: e.model });
    v.editorHost.hidden = true;
    v.diffHost.hidden = false;
    v.hunkBar.hidden = false;
    renderHunks(v);
    paintCrumbs(v);
  }

  function closeReview(v) {
    v.review = null;
    v.hunkBar.hidden = true;
    v.diffHost.hidden = !(v.tab && L.parseKey(v.tab).kind === 'diff');
    v.editorHost.hidden = !(v.tab && L.parseKey(v.tab).kind === 'file');
    if (v.diffHost.hidden) v.diffEditor?.setModel(null);
    v.originalModel?.dispose();
    v.originalModel = null;
    paintCrumbs(v);
    v.editor.layout();
  }

  function renderHunks(v) {
    const key = v.review;
    const e = entries.get(key);
    if (!key || !e) return;
    const base = baselines.get(key) ?? '';
    const cur = e.handle.text();
    const hs = hunks(base, cur);
    clear(v.hunkBar);
    if (!hs.length) {
      baselines.delete(key);
      closeReview(v);
      return;
    }
    const edit = canEdit(e);
    v.hunkBar.append(h('div', { class: 'wb-hunks-h' }, h('b', { text: tw('wb.ed.reviewTitle', { path: e.path }) }), h('span', { class: 'wb-sp' }),
      h('button', { class: 'wb-btn is-sm', type: 'button', text: tw('wb.ed.acceptAll'), on: { click: () => { baselines.set(key, cur); renderHunks(v); } } }),
      edit ? h('button', { class: 'wb-btn is-sm', type: 'button', text: tw('wb.ed.rejectAll'), on: { click: () => applyReject(v, key, base) } }) : null,
      h('button', { class: 'wb-btn is-sm', type: 'button', text: tw('wb.ed.closeReview'), on: { click: () => closeReview(v) } })));
    const list = h('ol', { class: 'wb-hunk-list' });
    for (const hk of hs) {
      const added = hk.bEnd - hk.b;
      const removed = hk.aEnd - hk.a;
      const label = added ? tw('wb.ed.hunkLines', { from: hk.b + 1, to: hk.bEnd }) : tw('wb.ed.hunkAfter', { line: hk.b });
      list.append(h('li', {},
        h('button', { class: 'wb-hunk-go', type: 'button', on: { click: () => v.diffEditor.getModifiedEditor().revealLineInCenter(Math.max(1, hk.b + 1)) } }, h('span', { text: label }), h('span', { class: 'wb-add', text: `+${added}` }), h('span', { class: 'wb-del', text: `-${removed}` })),
        h('button', { class: 'wb-btn is-sm', type: 'button', text: tw('wb.ed.accept'), on: { click: () => { baselines.set(key, acceptHunk(base, cur, hk)); v.originalModel.setValue(baselines.get(key)); renderHunks(v); } } }),
        edit ? h('button', { class: 'wb-btn is-sm', type: 'button', text: tw('wb.ed.reject'), on: { click: () => applyReject(v, key, rejectHunk(base, cur, hk)) } }) : null));
    }
    v.hunkBar.append(list);
  }

  async function applyReject(v, key, text) {
    const e = entries.get(key);
    if (!e) return;
    e.handle.setText(text, 'review');
    renderHunks(v);
    await save(key, { tidy: false });
  }

  /* ---------- renames and deletes from the explorer ---------- */
  function renamed(root, from, to, isDir) {
    let next = layout;
    for (const key of L.openKeys(layout)) {
      const p = L.parseKey(key);
      if (p.kind !== 'file' || p.root !== root) continue;
      const hit = isDir ? p.path === from || p.path.startsWith(`${from}/`) : p.path === from;
      if (!hit) continue;
      const np = to + p.path.slice(from.length);
      const e = entries.get(key);
      if (e?.handle.dirty) continue; // keep unsaved work under its old name
      dropEntry(key);
      next = L.renameTab(next, key, L.fileKey(root, np));
    }
    setLayout(next);
  }

  function removed(root, path, isDir) {
    let next = layout;
    for (const key of L.openKeys(layout)) {
      const p = L.parseKey(key);
      if (p.kind !== 'file' || p.root !== root) continue;
      if (isDir ? p.path === path || p.path.startsWith(`${path}/`) : p.path === path) {
        dropEntry(key);
        next = L.closeEverywhere(next, key);
      }
    }
    setLayout(next);
  }

  /** The shared documents changed source (Code together started or ended): reopen workspace tabs. */
  function rebind() {
    for (const key of [...entries.keys()]) if (entries.get(key).root === 'ws') dropEntry(key);
    for (const v of views.values()) { v.editor.setModel(null); v.tab = null; }
    render();
  }

  /* ---------- queries ---------- */
  const activeView = () => views.get(layout.activeGroup) || [...views.values()][0];
  const activeTab = () => L.activeTab(layout);

  function themeChanged() {
    const id = ctx.themeId();
    monaco.editor.setTheme(id);
  }

  function settingsChanged() {
    const o = editorOptions();
    delete o.theme;
    for (const v of views.values()) v.editor.updateOptions(o);
    themeChanged();
  }

  offs.push(ctx.desk.onEvent(onEngineEvent));
  offs.push(room.on('presence', (p) => { paintRemote(); if (follow && p.from === follow) followTo(p); }));
  offs.push(room.on('people', () => { paintTabs(); paintRemote(); ctx.onChange(); }));
  offs.push(room.on('change', () => { if (S() === room) rebind(); }));
  offs.push(room.on('disk', (d) => showBanner(d.path, tw('wb.ed.diskChanged', { who: d.by ? workerOf(d.by).name : tw('wb.ed.someone') }), [[tw('wb.ed.loadTheirs'), () => room.reload(d.path)], [tw('wb.ed.keepMine'), () => {}]])));
  offs.push(room.on('reset', (d) => { const key = L.fileKey('ws', d.path); if (entries.has(key)) { dropEntry(key); render(); } }));
  offs.push(collab.on('presence', (p) => { paintRemote(); if (follow && p.from === follow) followTo(p); }));
  offs.push(collab.on('people', () => { paintTabs(); paintRemote(); ctx.onChange(); }));
  offs.push(collab.on('role', () => { for (const v of views.values()) { const e = entries.get(v.tab); v.editor.updateOptions({ readOnly: !canEdit(e) }); paintCrumbs(v); } ctx.onChange(); }));
  offs.push(collab.on('change', () => { follow = null; rebind(); }));

  render();

  return {
    el,
    open,
    openDiff,
    openSettings,
    refreshDiff,
    save,
    saveAll,
    format: () => format(),
    closeActive: () => { const k = activeTab(); if (k) closeTab(k, layout.activeGroup); },
    closeAllIn: () => { const g = L.activeGroup(layout); for (const k of [...g.tabs]) closeTab(k, g.id); },
    closeOthers: (key, group) => { const g = layout.groups.find((x) => x.id === group); for (const k of [...(g?.tabs || [])]) if (k !== key) closeTab(k, group); },
    closeTab,
    split: (key) => {
      layout = L.split(layout, { key });
      const nv = views.get(layout.activeGroup);
      if (nv) nv.wantFocus = true;
      setLayout(layout);
      const v = views.get(layout.activeGroup);
      if (v) { v.wantFocus = true; if (v.editor.getModel()) v.editor.focus(); }
    },
    focusGroup: (i) => { const g = layout.groups[i]; if (!g) return; setLayout(L.focusGroup(layout, g.id)); views.get(g.id)?.editor.focus(); },
    cycle: (dir) => setLayout(L.cycleTab(layout, dir)),
    openReview: () => openReview(),
    hasReview: () => baselines.has(activeTab()),
    reviewPaths: (root) => new Set([...baselines.keys()].map((k) => L.parseKey(k)).filter((x) => x.root === root).map((x) => x.path)),
    renamed,
    removed,
    rebind,
    onDiskChanged,
    themeChanged,
    settingsChanged,
    setFollow,
    get follow() { return follow; },
    get layout() { return layout; },
    get saveState() { return saveState; },
    active() {
      const key = activeTab();
      return key ? { key, ...L.parseKey(key) } : null;
    },
    activeEditor() {
      const v = activeView();
      return v && !v.editorHost.hidden ? v.editor : null;
    },
    entry: (key) => entries.get(key) || null,
    dirty: () => [...entries.values()].filter((e) => e.handle.dirty).map((e) => e.key),
    session: S,
    layoutAll() { for (const v of views.values()) { v.editor.layout(); v.diffEditor?.layout(); } },
    dispose() {
      disposed = true;
      for (const off of offs) off?.();
      for (const key of [...entries.keys()]) dropEntry(key);
      for (const d of diffs.values()) { d.original.dispose(); d.modified.dispose(); }
      for (const v of views.values()) disposeView(v);
      views.clear();
    },
  };
}
