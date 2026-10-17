// The Code window: a full code editor on the hive's workspace.
// Explorer tree, tabs, breadcrumb, the editor (minimap, multi-cursor, find and replace, go to
// line, its own command palette on F1), a side by side review of crew changes with Accept or
// Reject per hunk, "Mel is editing" marks, format on save, a run log panel and a status bar.
// Files are shared documents (ui/lend/collab/docs.js): alone they load from and save to this
// PC's engine; in Code together everyone edits the same text and sees each other's cursors.

import { h, clear } from '/js/dom.js';
import { t } from '/js/i18n.js';
import { collab } from '/lend/collab/client.js';
import { avatar } from '/lend/collab/panel.js';
import { loadMonaco } from './monaco.js';
import { FORMATTABLE, badgeOf, languageLabel, languageOf } from './languages.js';
import { acceptHunk, changedLines, hunks, rejectHunk } from './linediff.js';

// Every string reads the current language when used (i18n/*.json, keys code.*).
const tc = (key, params) => t(`code.${key}`, params);
const T = {
  get explorer() { return tc('explorer'); },
  get newFile() { return tc('newFile'); },
  get newFilePrompt() { return tc('newFilePrompt'); },
  get refresh() { return tc('refresh'); },
  get empty() { return tc('empty'); },
  get emptyTree() { return tc('emptyTree'); },
  get loading() { return tc('loading'); },
  get save() { return tc('save'); },
  get saved() { return tc('saved'); },
  get saving() { return tc('saving'); },
  get approval() { return tc('approval'); },
  notSaved: (error) => tc('notSaved', { error }),
  get readOnly() { return tc('readOnly'); },
  get format() { return tc('format'); },
  formatLang: (lang) => tc('formatLang', { lang }),
  get trim() { return tc('trim'); },
  review: (count) => (count ? tc('reviewCount', { count }) : tc('review')),
  reviewTitle: (path) => tc('reviewTitle', { path }),
  get toReview() { return tc('toReview'); },
  get accept() { return tc('accept'); },
  get reject() { return tc('reject'); },
  get acceptAll() { return tc('acceptAll'); },
  get rejectAll() { return tc('rejectAll'); },
  get closeReview() { return tc('closeReview'); },
  hunkLines: (from, to) => tc('hunkLines', { from, to }),
  hunkAfter: (line) => tc('hunkAfter', { line }),
  editing: (who, file) => tc('editing', { who, file }),
  editingShort: (who) => tc('editingShort', { who }),
  diskChanged: (who) => tc('diskChanged', { who }),
  get loadTheirs() { return tc('loadTheirs'); },
  get keepMine() { return tc('keepMine'); },
  get runlog() { return tc('runlog'); },
  get runlogEmpty() { return tc('runlogEmpty'); },
  exit: (code, ms, timedOut) => `${tc('exit', { code, ms })}${timedOut ? `, ${tc('timedOut')}` : ''}`,
  get theme() { return tc('theme'); },
  follow: (name) => tc('follow', { name }),
  get stopFollow() { return tc('stopFollow'); },
  clickFollow: (name, file) => (file ? tc('clickFollow', { name, file }) : tc('clickFollowNoFile', { name })),
  you: (name) => tc('you', { name }),
  lnCol: (line, col) => tc('lnCol', { line, col }),
  spaces: (n) => tc('spaces', { n }),
  closeFile: (path) => tc('closeFile', { path }),
  get breadcrumb() { return tc('breadcrumb'); },
  action: (k) => tc(`action.${k}`),
};

const store = {
  get(k, d) {
    try {
      return localStorage.getItem(`hivedesk.editor.${k}`) ?? d;
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(`hivedesk.editor.${k}`, v);
    } catch {
      // not remembered
    }
  },
};

const cssId = (id) => String(id).replace(/[^a-zA-Z0-9_-]/g, '_');
const cssText = (s) => String(s).replace(/["\\\n\r]/g, ' ');

function desk() {
  return globalThis.hivedesk;
}

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

export function mountEditor(root, { path: firstPath } = {}) {
  root.classList.add('ed-root');
  if (store.get('theme', 'dark') === 'light') root.classList.add('ed-light');
  const st = {
    tabs: [],
    active: null,
    files: [],
    collapsed: new Set(JSON.parse(store.get('collapsed', '[]'))),
    baselines: new Map(), // path -> text before the crew changes not reviewed yet
    known: new Map(), // path -> last text seen on disk
    follow: null,
    review: null,
    panel: store.get('panel', '1') === '1',
    disposed: false,
  };
  const entries = new Map(); // path -> { model, handle, offs: [], view }
  const offs = [];
  let monaco = null;
  let editor = null;
  let diffEditor = null;
  let remoteDecos = [];
  let crewDecos = [];
  let crewTimer = null;
  let saveState = '';

  /* ---------- layout ---------- */
  const treeEl = h('div', { class: 'ed-tree', role: 'tree', attrs: { 'aria-label': T.explorer } });
  const newBtn = h('button', { class: 'ed-ibtn', type: 'button', title: T.newFile, attrs: { 'aria-label': T.newFile }, html: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>', on: { click: () => newFile() } });
  const refreshBtn = h('button', { class: 'ed-ibtn', type: 'button', title: T.refresh, attrs: { 'aria-label': T.refresh }, html: '<svg viewBox="0 0 24 24"><path d="M19 12a7 7 0 1 1-2.1-5"/><path d="M19 4v4h-4"/></svg>', on: { click: () => refreshFiles() } });
  const explorer = h('aside', { class: 'ed-explorer' }, h('div', { class: 'ed-side-h' }, h('span', { text: T.explorer }), h('span', { class: 'ed-sp' }), newBtn, refreshBtn), treeEl);
  const tabsEl = h('div', { class: 'ed-tabs', role: 'tablist' });
  const crumbs = h('nav', { class: 'ed-crumbs', attrs: { 'aria-label': T.breadcrumb } });
  const reviewBtn = h('button', { class: 'ed-btn', type: 'button', dataset: { act: 'review' }, on: { click: () => (st.review ? closeReview() : openReview(st.active)) } });
  const formatBtn = h('button', { class: 'ed-btn', type: 'button', text: T.format, on: { click: () => format(st.active) } });
  const saveBtn = h('button', { class: 'ed-btn is-primary', type: 'button', text: T.save, dataset: { act: 'save' }, on: { click: () => save() } });
  const themeBtn = h('button', { class: 'ed-ibtn', type: 'button', title: T.theme, attrs: { 'aria-label': T.theme }, html: '<svg viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 1 1 9.5 4 6.5 6.5 0 0 0 20 14.5z"/></svg>', on: { click: () => toggleTheme() } });
  const bar = h('div', { class: 'ed-bar' }, crumbs, h('span', { class: 'ed-sp' }), reviewBtn, formatBtn, saveBtn, themeBtn);
  const editorHost = h('div', { class: 'ed-monaco' });
  const diffHost = h('div', { class: 'ed-diff' });
  const hunkBar = h('div', { class: 'ed-hunks' });
  const reviewLayer = h('div', { class: 'ed-review', hidden: true }, hunkBar, diffHost);
  const banner = h('div', { class: 'ed-banner', hidden: true });
  const editingPill = h('div', { class: 'ed-editing', hidden: true, attrs: { role: 'status' } });
  const emptyEl = h('div', { class: 'ed-empty' }, h('p', { text: T.loading }));
  const stage = h('div', { class: 'ed-stage' }, editorHost, reviewLayer, emptyEl, editingPill);
  const runPre = h('pre', { class: 'ed-runlog', attrs: { 'aria-live': 'polite' } }, h('span', { class: 'ed-faint', text: T.runlogEmpty }));
  const panelToggle = h('button', { class: 'ed-panel-h', type: 'button', attrs: { 'aria-expanded': String(st.panel) }, on: { click: () => togglePanel() } }, h('span', { text: T.runlog }));
  const panel = h('section', { class: 'ed-panel' }, panelToggle, runPre);
  const statusEl = h('footer', { class: 'ed-status' });
  const main = h('div', { class: 'ed-main' }, tabsEl, bar, banner, stage, panel);
  root.append(h('div', { class: 'ed-body' }, explorer, main), statusEl);
  root.classList.toggle('ed-panel-open', st.panel);

  /* ---------- files and tree ---------- */
  async function refreshFiles() {
    try {
      const r = await desk().command('files.list', {});
      st.files = (r.files || []).map((f) => f.path).sort();
    } catch {
      st.files = Object.keys(desk().state().files || {}).sort();
    }
    paintTree();
  }

  function paintTree() {
    const people = collab.people();
    const viewing = new Map();
    for (const p of people) if (p.file && p.id !== collab.myId()) viewing.set(p.file, [...(viewing.get(p.file) || []), p]);
    const all = [...new Set([...st.files, ...st.tabs])].sort();
    const tree = {};
    for (const p of all) {
      let node = tree;
      const parts = p.split('/');
      parts.forEach((part, i) => {
        if (i === parts.length - 1) (node.$files ??= []).push(p);
        else node = node[part] ??= {};
      });
    }
    clear(treeEl);
    if (!all.length) {
      treeEl.append(h('p', { class: 'ed-faint ed-pad', text: T.emptyTree }));
      return;
    }
    const walk = (node, prefix, depth) => {
      for (const dir of Object.keys(node).filter((k) => k !== '$files').sort()) {
        const key = prefix + dir;
        const closed = st.collapsed.has(key);
        treeEl.append(h('div', { class: 'ed-row is-dir', role: 'treeitem', tabindex: '0', attrs: { 'aria-expanded': String(!closed) }, style: { paddingLeft: `${8 + depth * 12}px` }, dataset: { dir: key }, on: { click: () => toggleDir(key) } },
          h('span', { class: `ed-chev${closed ? '' : ' is-open'}` }), h('span', { class: 'ed-folder' }), h('span', { class: 'ed-name', text: dir })));
        if (!closed) walk(node[dir], `${key}/`, depth + 1);
      }
      for (const p of node.$files || []) {
        const [txt, color] = badgeOf(p);
        const dots = (viewing.get(p) || []).map((x) => h('span', { class: 'ed-dot', style: { background: x.color }, title: x.name }));
        treeEl.append(h('div', { class: `ed-row${p === st.active ? ' is-active' : ''}`, role: 'treeitem', tabindex: '0', style: { paddingLeft: `${20 + depth * 12}px` }, dataset: { path: p }, on: { click: () => openFile(p), keydown: (e) => e.key === 'Enter' && openFile(p) } },
          h('span', { class: 'ed-badge', style: { color }, text: txt }), h('span', { class: 'ed-name', text: p.split('/').pop() }), st.baselines.has(p) ? h('span', { class: 'ed-mark', title: T.toReview }) : null, ...dots));
      }
    };
    walk(tree, '', 0);
  }

  function toggleDir(key) {
    if (st.collapsed.has(key)) st.collapsed.delete(key);
    else st.collapsed.add(key);
    store.set('collapsed', JSON.stringify([...st.collapsed]));
    paintTree();
  }

  function newFile() {
    const input = h('input', { class: 'ed-new', placeholder: T.newFilePrompt, attrs: { 'aria-label': T.newFilePrompt } });
    const done = (ok) => {
      const v = input.value.trim().replace(/\\/g, '/').replace(/^\/+/, '');
      input.remove();
      if (ok && v && !v.includes('..')) openFile(v);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') done(true);
      if (e.key === 'Escape') done(false);
    });
    input.addEventListener('blur', () => done(true));
    treeEl.prepend(input);
    input.focus();
  }

  /* ---------- tabs, breadcrumb, status ---------- */
  function paintTabs() {
    clear(tabsEl);
    const people = collab.people();
    for (const p of st.tabs) {
      const e = entries.get(p);
      const [txt, color] = badgeOf(p);
      const dots = people.filter((x) => x.file === p && x.id !== collab.myId()).map((x) => h('span', { class: 'ed-dot', style: { background: x.color }, title: x.name }));
      const close = h('button', { class: 'ed-x', type: 'button', attrs: { 'aria-label': T.closeFile(p) }, html: '<svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7 7 17"/></svg>', on: { click: (ev) => { ev.stopPropagation(); closeTab(p); } } });
      tabsEl.append(h('div', { class: `ed-tab${p === st.active ? ' is-active' : ''}${e?.handle.dirty ? ' is-dirty' : ''}`, role: 'tab', tabindex: '0', title: p, attrs: { 'aria-selected': String(p === st.active) }, dataset: { path: p }, on: { click: () => openFile(p), auxclick: (ev) => ev.button === 1 && closeTab(p) } },
        h('span', { class: 'ed-badge', style: { color }, text: txt }), h('span', { class: 'ed-name', text: p.split('/').pop() }), ...dots, h('span', { class: 'ed-dirty' }), close));
    }
  }

  function paintCrumbs() {
    clear(crumbs);
    if (!st.active) return;
    const parts = st.active.split('/');
    parts.forEach((part, i) => {
      if (i) crumbs.append(h('span', { class: 'ed-crumb-sep', text: '›' }));
      const dir = parts.slice(0, i + 1).join('/');
      crumbs.append(i === parts.length - 1 ? h('b', { text: part }) : h('button', { type: 'button', class: 'ed-crumb', text: part, on: { click: () => { st.collapsed.delete(dir); paintTree(); treeEl.querySelector(`[data-dir="${CSS.escape(dir)}"]`)?.scrollIntoView({ block: 'nearest' }); } } }));
    });
    const n = st.baselines.size;
    reviewBtn.textContent = st.review ? T.closeReview : T.review(n);
    reviewBtn.disabled = !st.review && !st.baselines.has(st.active);
    const lang = languageOf(st.active);
    formatBtn.hidden = !collab.canEdit();
    saveBtn.disabled = !collab.canEdit();
    formatBtn.title = FORMATTABLE.has(lang) ? T.formatLang(languageLabel(lang)) : T.trim;
  }

  function paintStatus() {
    clear(statusEl);
    const pos = editor?.getPosition();
    const lang = st.active ? languageOf(st.active) : null;
    const people = collab.people();
    const left = h('div', { class: 'ed-status-l' },
      lang ? h('span', { class: 'ed-st', text: languageLabel(lang) }) : null,
      pos && st.active ? h('span', { class: 'ed-st', dataset: { pos: `${pos.lineNumber}:${pos.column}` }, text: T.lnCol(pos.lineNumber, pos.column) }) : null,
      st.active ? h('span', { class: 'ed-st', text: T.spaces(2) }) : null,
      st.active ? h('span', { class: 'ed-st', text: 'UTF-8' }) : null,
      !collab.canEdit() ? h('span', { class: 'ed-st is-warn', text: T.readOnly }) : null,
      saveState ? h('span', { class: 'ed-st', dataset: { save: saveState }, text: saveState }) : null);
    const who = h('div', { class: 'ed-status-r' });
    if (people.length) {
      for (const p of people) {
        const av = avatar(p, 18);
        const mine = p.id === collab.myId();
        av.title = mine ? T.you(p.name) : T.clickFollow(p.name, p.file);
        if (!mine) {
          av.classList.add('is-click');
          av.addEventListener('click', () => setFollow(st.follow === p.id ? null : p.id));
        }
        if (st.follow === p.id) av.classList.add('is-followed');
        who.append(av);
      }
      if (st.follow) {
        const p = people.find((x) => x.id === st.follow);
        who.append(h('button', { class: 'ed-st ed-follow', type: 'button', text: `${T.follow(p?.name || '')} · ${T.stopFollow}`, on: { click: () => setFollow(null) } }));
      }
    }
    statusEl.append(left, who);
  }

  /* ---------- documents ---------- */
  async function entryFor(path) {
    if (entries.has(path)) return entries.get(path);
    const handle = await collab.docs().open(path);
    if (st.disposed) return null;
    if (entries.has(path)) return entries.get(path);
    const uri = monaco.Uri.from({ scheme: 'hive', path: `/${path}` });
    monaco.editor.getModel(uri)?.dispose();
    const model = monaco.editor.createModel(handle.text(), languageOf(path), uri);
    const e = { path, model, handle, offs: [], view: null };
    entries.set(path, e);
    if (!st.known.has(path)) st.known.set(path, handle.savedText);
    let applying = false;
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
        // Line ends were normalized by the editor: resync the view from the shared text.
        applying = true;
        model.setValue(handle.text());
        applying = false;
      }
      paintTabs();
      paintRemote();
      if (st.review === path) renderHunks();
    }));
    e.offs.push(handle.on('saved', () => {
      st.known.set(path, handle.savedText);
      paintTabs();
    }));
    if (model.getValue() !== handle.text() && collab.canEdit()) handle.setText(model.getValue(), 'editor');
    return e;
  }

  async function openFile(path, { focus = true } = {}) {
    if (!path || st.disposed) return;
    if (!st.tabs.includes(path)) st.tabs.push(path);
    const prev = st.active && entries.get(st.active);
    if (prev && editor && editor.getModel() === prev.model) prev.view = editor.saveViewState();
    st.active = path;
    store.set('tabs', JSON.stringify(st.tabs));
    store.set('active', path);
    paintTabs();
    paintCrumbs();
    paintTree();
    if (!monaco) return;
    let e;
    try {
      e = await entryFor(path);
    } catch (err) {
      emptyEl.hidden = false;
      clear(emptyEl).append(h('p', { class: 'ed-error', text: `${path}: ${err.message}` }));
      return;
    }
    if (!e || st.active !== path) return;
    if (st.review && st.review !== path) closeReview();
    emptyEl.hidden = true;
    editor.setModel(e.model);
    if (e.view) editor.restoreViewState(e.view);
    editor.updateOptions({ readOnly: !collab.canEdit() });
    if (focus) editor.focus();
    paintRemote();
    paintStatus();
    sendPresence();
    root.dispatchEvent(new CustomEvent('ed-open', { detail: path }));
  }

  function closeTab(path) {
    const i = st.tabs.indexOf(path);
    if (i < 0) return;
    st.tabs.splice(i, 1);
    const e = entries.get(path);
    if (e) {
      for (const off of e.offs) off();
      e.model.dispose();
      entries.delete(path);
      if (collab.mode === 'solo') collab.docs().docs.delete(path); // reload from disk next time
    }
    store.set('tabs', JSON.stringify(st.tabs));
    if (st.active === path) {
      st.active = null;
      const next = st.tabs[Math.min(i, st.tabs.length - 1)];
      if (next) openFile(next);
      else {
        editor?.setModel(null);
        emptyEl.hidden = false;
        clear(emptyEl).append(h('p', { text: T.empty }));
        sendPresence();
      }
    }
    paintTabs();
    paintCrumbs();
    paintTree();
    paintStatus();
  }

  /** The shared documents changed source (a session started or ended): reopen every tab. */
  async function rebind() {
    const tabs = [...st.tabs];
    const active = st.active;
    for (const e of entries.values()) {
      for (const off of e.offs) off();
      e.model.dispose();
    }
    entries.clear();
    editor?.setModel(null);
    st.active = null;
    st.tabs = [];
    await refreshFiles();
    for (const p of tabs) if (!st.tabs.includes(p)) st.tabs.push(p);
    if (active) await openFile(active, { focus: false });
    else paintTabs();
  }

  /* ---------- saving and formatting ---------- */
  function setSave(text) {
    saveState = text;
    paintStatus();
  }

  async function format(path = st.active) {
    const e = entries.get(path);
    if (!e || !collab.canEdit() || editor.getModel() !== e.model) return;
    const lang = languageOf(path);
    if (FORMATTABLE.has(lang)) {
      const NL = String.fromCharCode(10);
      const hadNewline = e.model.getValue().endsWith(NL);
      await editor.getAction('editor.action.formatDocument')?.run();
      // Keep the final newline the file had (the CSS and HTML formatters drop it).
      const now = e.model.getValue();
      if (hadNewline && now && !now.endsWith(NL)) {
        const end = e.model.getFullModelRange().getEndPosition();
        e.model.pushEditOperations([], [{ range: new monaco.Range(end.lineNumber, end.column, end.lineNumber, end.column), text: NL }], () => null);
      }
      return;
    }
    const text = e.model.getValue();
    const tidy = text.replace(/[ \t]+$/gm, '').replace(/\n*$/, '\n');
    if (tidy !== text && text.length) {
      e.model.pushEditOperations([], [{ range: e.model.getFullModelRange(), text: tidy }], () => null);
    }
  }

  async function save(path = st.active, { tidy = true } = {}) {
    const e = entries.get(path);
    if (!e) return;
    if (!collab.canEdit()) return setSave(T.readOnly);
    if (tidy && store.get('formatOnSave', '1') === '1') await format(path).catch(() => {});
    setSave(collab.mode === 'guest' ? T.approval : T.saving);
    try {
      await e.handle.save();
      setSave(T.saved);
      refreshFiles();
    } catch (err) {
      setSave(T.notSaved(err.message));
    }
    paintTabs();
  }

  /* ---------- presence ---------- */
  let presenceTimer = null;
  function sendPresence() {
    clearTimeout(presenceTimer);
    presenceTimer = setTimeout(() => {
      if (collab.mode === 'solo') return;
      const e = st.active && entries.get(st.active);
      if (!e || !editor || editor.getModel() !== e.model) return collab.setPresence({ file: st.active || null, sel: [] });
      const sel = editor.getSelections().slice(0, 8).map((s) => ({
        a: e.handle.anchor(e.model.getOffsetAt({ lineNumber: s.selectionStartLineNumber, column: s.selectionStartColumn })),
        h: e.handle.anchor(e.model.getOffsetAt(s.getPosition())),
      }));
      collab.setPresence({ file: st.active, sel });
      return undefined;
    }, 60);
  }

  function paintRemote() {
    if (!editor || !st.active) return;
    const e = entries.get(st.active);
    if (!e) return;
    const people = new Map(collab.people().map((p) => [p.id, p]));
    const decos = [];
    for (const [id, p] of collab.presence()) {
      if (id === collab.myId() || p.file !== st.active) continue;
      const who = people.get(id) || { name: id, color: '#f2a93b' };
      ensureStyle('u', id, who.color, who.name);
      for (const s of p.sel || []) {
        const a = e.model.getPositionAt(e.handle.offset(s.a));
        const hd = e.model.getPositionAt(e.handle.offset(s.h));
        const start = monaco.Position.isBefore(a, hd) ? a : hd;
        const end = start === a ? hd : a;
        if (!a.equals(hd)) decos.push({ range: monaco.Range.fromPositions(start, end), options: { className: `ed-rsel ed-u-${cssId(id)}`, stickiness: 1 } });
        decos.push({ range: monaco.Range.fromPositions(hd, hd), options: { beforeContentClassName: `ed-rcaret ed-u-${cssId(id)}`, stickiness: 1, hoverMessage: { value: who.name } } });
      }
    }
    remoteDecos = editor.deltaDecorations(remoteDecos, decos);
  }

  function setFollow(id) {
    st.follow = id;
    paintStatus();
    if (id) followTo(collab.presence().get(id));
  }

  function followTo(p) {
    if (!p?.file) return;
    const go = () => {
      const e = entries.get(p.file);
      const head = p.sel?.[0]?.h;
      if (e && head !== undefined && editor.getModel() === e.model) editor.revealLineInCenterIfOutsideViewport(e.model.getPositionAt(e.handle.offset(head)).lineNumber);
    };
    if (p.file !== st.active) openFile(p.file, { focus: false }).then(go);
    else go();
  }

  /* ---------- crew activity ---------- */
  function workerOf(id) {
    return desk().worker?.(id) || { id, name: id, color: '#f2a93b' };
  }

  const isCrew = (id) => id && id !== 'user' && !String(id).startsWith('guest');

  function showEditing(workerId, path) {
    const w = workerOf(workerId);
    clear(editingPill).append(h('span', { class: 'ed-dot', style: { background: w.color } }), h('span', { text: T.editing(w.name, path.split('/').pop()) }));
    editingPill.hidden = false;
    clearTimeout(editingPill.timer);
    editingPill.timer = setTimeout(() => (editingPill.hidden = true), 8000);
  }

  function markCrewLines(path, workerId, before, after) {
    if (path !== st.active || !editor) return;
    const w = workerOf(workerId);
    ensureStyle('w', workerId, w.color, w.name);
    const c = cssId(workerId);
    const ls = changedLines(before ?? '', after).slice(0, 400);
    const decos = ls.map((line, i) => ({
      range: new monaco.Range(line, 1, line, 1),
      options: { isWholeLine: true, className: `ed-crew-line ed-w-${c}`, linesDecorationsClassName: `ed-crew-gutter ed-w-${c}`, ...(i === 0 ? { after: { content: `  ${T.editingShort(w.name)}`, inlineClassName: `ed-crew-tag ed-w-${c}` } } : {}) },
    }));
    crewDecos = editor.deltaDecorations(crewDecos, decos);
    clearTimeout(crewTimer);
    crewTimer = setTimeout(() => (crewDecos = editor?.deltaDecorations(crewDecos, []) || []), 6000);
  }

  function showBanner(text, actions) {
    clear(banner).append(h('span', { text }), ...actions.map(([label, run]) => h('button', { class: 'ed-btn', type: 'button', text: label, on: { click: () => { banner.hidden = true; run(); } } })));
    banner.hidden = false;
  }

  function onEvent(ev) {
    const d = ev.data || {};
    if (ev.type === 'tool.called' && (d.tool === 'write_file' || d.tool === 'edit_file') && d.args?.path && isCrew(d.workerId)) {
      if (st.tabs.includes(d.args.path) || st.active === d.args.path) showEditing(d.workerId, d.args.path);
    } else if (ev.type === 'file.changed') {
      const before = st.known.get(d.path) ?? (typeof d.content === 'string' ? null : undefined);
      if (typeof d.content === 'string') st.known.set(d.path, d.content);
      if (isCrew(d.workerId) && d.op !== 'delete') {
        if (!st.baselines.has(d.path)) st.baselines.set(d.path, before ?? '');
        const e = entries.get(d.path);
        if (e && typeof d.content === 'string' && collab.mode !== 'guest') {
          if (e.handle.text() === e.handle.savedText) {
            e.handle.setText(d.content, 'crew');
            e.handle.savedText = d.content;
            paintTabs();
          } else if (e.handle.text() !== d.content) {
            showBanner(T.diskChanged(workerOf(d.workerId).name), [[T.loadTheirs, () => { e.handle.setText(d.content, 'crew'); e.handle.savedText = d.content; paintTabs(); }], [T.keepMine, () => {}]]);
          }
        }
        if (typeof d.content === 'string') setTimeout(() => markCrewLines(d.path, d.workerId, before, d.content), 30);
        if (st.baselines.get(d.path) === d.content) st.baselines.delete(d.path);
      }
      if (!st.files.includes(d.path) || d.op === 'delete') refreshFiles();
      else paintTree();
      paintCrumbs();
    } else if (ev.type === 'tool.called' && d.tool === 'run') {
      appendRun(`\n$ ${d.args?.command || ''}\n`, 'cmd');
    } else if (ev.type === 'run.finished') {
      appendRun(`\n[${T.exit(d.exitCode, d.ms, d.timedOut)}]\n`, d.exitCode === 0 ? 'ok' : 'bad');
    }
  }

  /* ---------- run log ---------- */
  let runChars = 0;
  function appendRun(text, kind) {
    if (runPre.firstChild?.classList?.contains('ed-faint')) clear(runPre);
    const clean = String(text).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
    runPre.append(kind ? h('span', { class: `ed-run-${kind}`, text: clean }) : document.createTextNode(clean));
    runChars += clean.length;
    while (runChars > 200000 && runPre.firstChild) {
      runChars -= runPre.firstChild.textContent.length;
      runPre.firstChild.remove();
    }
    runPre.scrollTop = runPre.scrollHeight;
  }

  function togglePanel() {
    st.panel = !st.panel;
    store.set('panel', st.panel ? '1' : '0');
    root.classList.toggle('ed-panel-open', st.panel);
    panelToggle.setAttribute('aria-expanded', String(st.panel));
  }

  /* ---------- review ---------- */
  let originalModel = null;

  async function openReview(path) {
    if (!path || !st.baselines.has(path)) return;
    const e = await entryFor(path);
    if (!e) return;
    if (st.active !== path) await openFile(path);
    st.review = path;
    diffEditor ??= monaco.editor.createDiffEditor(diffHost, { renderSideBySide: true, readOnly: true, originalEditable: false, automaticLayout: true, minimap: { enabled: false }, theme: currentTheme() });
    originalModel?.dispose();
    originalModel = monaco.editor.createModel(st.baselines.get(path), languageOf(path));
    diffEditor.setModel({ original: originalModel, modified: e.model });
    reviewLayer.hidden = false;
    editorHost.hidden = true;
    renderHunks();
    paintCrumbs();
  }

  function closeReview() {
    st.review = null;
    reviewLayer.hidden = true;
    editorHost.hidden = false;
    diffEditor?.setModel(null);
    originalModel?.dispose();
    originalModel = null;
    paintCrumbs();
    paintTree();
    editor?.layout();
  }

  function renderHunks() {
    const path = st.review;
    const e = entries.get(path);
    if (!path || !e) return;
    const base = st.baselines.get(path) ?? '';
    const cur = e.handle.text();
    const hs = hunks(base, cur);
    clear(hunkBar);
    if (!hs.length) {
      // Every hunk is accepted or rejected: back to the editor.
      st.baselines.delete(path);
      closeReview();
      return;
    }
    const edit = collab.canEdit();
    hunkBar.append(h('div', { class: 'ed-hunks-h' }, h('b', { text: T.reviewTitle(path) }), h('span', { class: 'ed-sp' }),
      h('button', { class: 'ed-btn', type: 'button', text: T.acceptAll, on: { click: () => { st.baselines.set(path, cur); renderHunks(); } } }),
      edit ? h('button', { class: 'ed-btn', type: 'button', text: T.rejectAll, on: { click: () => applyReject(path, base) } }) : null,
      h('button', { class: 'ed-btn', type: 'button', text: T.closeReview, on: { click: closeReview } })));
    const list = h('ol', { class: 'ed-hunk-list' });
    hs.forEach((hk) => {
      const added = hk.bEnd - hk.b;
      const removed = hk.aEnd - hk.a;
      const label = added ? T.hunkLines(hk.b + 1, hk.bEnd) : T.hunkAfter(hk.b);
      list.append(h('li', { dataset: { hunk: String(hk.b) } },
        h('button', { class: 'ed-hunk-go', type: 'button', on: { click: () => diffEditor.getModifiedEditor().revealLineInCenter(Math.max(1, hk.b + 1)) } }, h('span', { text: label }), h('span', { class: 'ed-add', text: `+${added}` }), h('span', { class: 'ed-del', text: `-${removed}` })),
        h('button', { class: 'ed-btn', type: 'button', text: T.accept, dataset: { act: 'accept' }, on: { click: () => { st.baselines.set(path, acceptHunk(base, cur, hk)); originalModel.setValue(st.baselines.get(path)); renderHunks(); } } }),
        edit ? h('button', { class: 'ed-btn', type: 'button', text: T.reject, dataset: { act: 'reject' }, on: { click: () => applyReject(path, rejectHunk(base, cur, hk)) } }) : null));
    });
    hunkBar.append(list);
  }

  async function applyReject(path, text) {
    const e = entries.get(path);
    if (!e) return;
    e.handle.setText(text, 'review');
    renderHunks();
    await save(path, { tidy: false }); // a reject restores the old lines exactly
  }

  /* ---------- theme ---------- */
  const currentTheme = () => (root.classList.contains('ed-light') ? 'hivedesk-light' : 'hivedesk-dark');
  function toggleTheme() {
    root.classList.toggle('ed-light');
    store.set('theme', root.classList.contains('ed-light') ? 'light' : 'dark');
    monaco?.editor.setTheme(currentTheme());
  }

  /* ---------- boot ---------- */
  offs.push(desk().onEvent(onEvent));
  offs.push(desk().on('live', (f) => f.type === 'run.output' && appendRun(f.data?.text || '', f.data?.stream === 'stderr' ? 'bad' : '')));
  offs.push(collab.on('presence', (p) => {
    paintRemote();
    if (st.follow && p.from === st.follow) followTo(p);
  }));
  offs.push(collab.on('people', () => {
    paintTabs();
    paintTree();
    paintStatus();
    paintRemote();
  }));
  offs.push(collab.on('role', () => {
    editor?.updateOptions({ readOnly: !collab.canEdit() });
    paintCrumbs();
    paintStatus();
  }));
  offs.push(collab.on('change', () => {
    st.follow = null;
    rebind().then(() => {
      editor?.updateOptions({ readOnly: !collab.canEdit() });
      paintStatus();
    });
  }));

  const api = {
    root,
    open: (p) => openFile(p),
    save: (p) => save(p),
    get active() {
      return st.active;
    },
    get editor() {
      return editor;
    },
    text: (p = st.active) => entries.get(p)?.handle.text() ?? null,
    review: (p = st.active) => openReview(p),
    reviewHunks: () => (st.review ? hunks(st.baselines.get(st.review) ?? '', entries.get(st.review).handle.text()) : []),
    follow: (id) => setFollow(id),
    dispose() {
      st.disposed = true;
      for (const off of offs) off?.();
      collab.setPresence({ file: null, sel: [] });
      for (const e of entries.values()) {
        for (const off of e.offs) off();
        e.model.dispose();
      }
      entries.clear();
      editor?.dispose();
      diffEditor?.dispose();
      originalModel?.dispose();
    },
    ready: null,
  };

  api.ready = (async () => {
    refreshFiles();
    try {
      monaco = await loadMonaco();
    } catch (err) {
      clear(emptyEl).append(h('p', { class: 'ed-error', text: err.message }));
      throw err;
    }
    if (st.disposed) return api;
    editor = monaco.editor.create(editorHost, {
      model: null,
      theme: currentTheme(),
      automaticLayout: true,
      fontFamily: '"Cascadia Code", "JetBrains Mono", Consolas, "Courier New", monospace',
      fontSize: 13,
      lineHeight: 20,
      tabSize: 2,
      minimap: { enabled: true, renderCharacters: false },
      smoothScrolling: true,
      cursorBlinking: 'smooth',
      cursorSmoothCaretAnimation: 'on',
      scrollBeyondLastLine: false,
      renderWhitespace: 'selection',
      bracketPairColorization: { enabled: true },
      guides: { bracketPairs: true, indentation: true },
      multiCursorModifier: 'alt',
      stickyScroll: { enabled: true },
      fixedOverflowWidgets: true,
      padding: { top: 8 },
    });
    editor.addAction({ id: 'hivedesk.save', label: T.action('save'), keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS], run: () => save() });
    editor.addAction({ id: 'hivedesk.review', label: T.action('review'), run: () => openReview(st.active) });
    editor.addAction({ id: 'hivedesk.format', label: T.action('format'), keybindings: [monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyF], run: () => format() });
    editor.addAction({ id: 'hivedesk.newFile', label: T.action('newFile'), run: () => newFile() });
    editor.onDidChangeCursorPosition(() => paintStatus());
    editor.onDidChangeCursorSelection(() => sendPresence());
    emptyEl.hidden = false;
    clear(emptyEl).append(h('p', { text: T.empty }));
    let saved = [];
    try {
      saved = JSON.parse(store.get('tabs', '[]'));
    } catch {
      saved = [];
    }
    for (const p of saved) if (typeof p === 'string' && !st.tabs.includes(p)) st.tabs.push(p);
    const start = firstPath || store.get('active', '') || st.tabs[0];
    if (start) await openFile(start);
    else paintTabs();
    paintStatus();
    return api;
  })();
  api.ready.catch(() => {});
  return api;
}
