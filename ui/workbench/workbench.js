// The code workbench (PLAN section 11): an activity bar (explorer, search, source control),
// editor groups with tabs and splits, a bottom panel (terminal, problems, output), a status bar,
// a quick picker (files, commands, symbols, lines) and keyboard shortcuts for all of it.
// Mounted in the Code window by ui/editor/register.js; everything talks to the engine through
// the wb.* commands (src/workbench/index.js).

import { h, clear } from '/js/dom.js';
import * as wm from '/js/wm.js';
import { avatar } from '/lend/collab/panel.js';
import { loadMonaco, defineDeskTheme } from '/editor/monaco.js';
import { languageLabel, languageOf, badgeOf } from '/editor/languages.js';
import { wb, onFrame, onEvent } from './net.js';
import { tw, loadStrings } from './strings.js';
import { Commands, rankFiles, fuzzy } from './commands.js';
import { createQuick } from './quick.js';
import { createEditors, uriFor, fromUri } from './editors.js';
import { createExplorer } from './explorer.js';
import { createSearch } from './searchview.js';
import { createScm } from './scmview.js';
import { createProblems } from './problems.js';
import { createTerminals } from './terminal.js';
import { renderSettings } from './settingsview.js';
import { ProjectModels } from './models.js';
import { RoomSession, collab } from './session.js';
import { terminalTheme, editorThemeId } from './theme.js';
import { prompt, contextMenu, confirm } from './dialogs.js';

const ICON = {
  explorer: '<svg viewBox="0 0 24 24"><path d="M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5z"/><path d="M14 3.5v5h5M8.5 13h7M8.5 16.5h5"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 5 5"/></svg>',
  scm: '<svg viewBox="0 0 24 24"><circle cx="7" cy="5.5" r="2"/><circle cx="7" cy="18.5" r="2"/><circle cx="17" cy="8" r="2"/><path d="M7 7.5v9M17 10c0 4.5-6.5 3-9.3 6.8"/></svg>',
  settings: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8"/></svg>',
  palette: '<svg viewBox="0 0 24 24"><path d="M4 7h16M4 12h10M4 17h7"/><path d="m15 15 3 3 3-3"/></svg>',
  max: '<svg viewBox="0 0 24 24"><path d="M6 15l6-6 6 6"/></svg>',
  min: '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7 7 17"/></svg>',
};

function store(k, v) {
  try {
    if (v === undefined) return localStorage.getItem(`hivedesk.wb.${k}`);
    localStorage.setItem(`hivedesk.wb.${k}`, v);
  } catch { /* not kept */ }
  return null;
}

/** True when the engine has the workbench (src/workbench). */
export async function workbenchAvailable() {
  try {
    await wb('wb.info', {}, { timeout: 8000 });
    return true;
  } catch (err) {
    if (err.code === 'bad_request' && /unknown command/.test(err.message)) return false;
    throw err;
  }
}

export function mountWorkbench(host, { path: firstPath } = {}) {
  host.classList.add('wb-root');
  const desk = globalThis.hivedesk;
  const st = {
    view: store('view') || 'explorer',
    sideOpen: store('side') !== '0',
    sideW: Number(store('sideW')) || 260,
    panel: store('panel') || 'terminal',
    panelOpen: store('panelOpen') === '1',
    panelH: Number(store('panelH')) || 240,
    panelMax: false,
    info: null,
    settings: null,
    roots: [],
    branch: null,
    scmCount: 0,
    problems: { errors: 0, warnings: 0 },
    terminals: 0,
    disposed: false,
  };
  const offs = [];
  const commands = new Commands();
  let monaco = null;
  let editors = null;
  let explorer = null;
  let search = null;
  let scm = null;
  let problems = null;
  let terms = null;
  let project = null;
  let settingsView = null;
  let deskTheme = null;
  const room = new RoomSession();

  /* ---------- shell ---------- */
  const actBtn = (id, label, keys) => h('button', { class: 'wb-act', type: 'button', title: `${label} (${keys})`, attrs: { 'aria-label': label, 'aria-pressed': 'false' }, dataset: { view: id }, html: ICON[id], on: { click: () => showView(id, { toggle: true }) } });
  const actExplorer = actBtn('explorer', tw('wb.view.explorer'), 'Ctrl+Shift+E');
  const actSearch = actBtn('search', tw('wb.view.search'), 'Ctrl+Shift+F');
  const actScm = actBtn('scm', tw('wb.view.scm'), 'Ctrl+Shift+G');
  const scmBadge = h('span', { class: 'wb-act-badge', hidden: true });
  actScm.append(scmBadge);
  const actPalette = h('button', { class: 'wb-act', type: 'button', title: `${tw('wb.cmd.palette')} (Ctrl+Shift+P)`, attrs: { 'aria-label': tw('wb.cmd.palette') }, html: ICON.palette, on: { click: () => quick.open('>') } });
  const actSettings = h('button', { class: 'wb-act', type: 'button', title: `${tw('wb.settings.title')} (Ctrl+,)`, attrs: { 'aria-label': tw('wb.settings.title') }, html: ICON.settings, on: { click: () => editors?.openSettings() } });
  const activity = h('nav', { class: 'wb-activity', attrs: { 'aria-label': tw('wb.views') } }, actExplorer, actSearch, actScm, h('span', { class: 'wb-sp' }), actPalette, actSettings);
  const sideTitle = h('span', { class: 'wb-side-t' });
  const sideActs = h('div', { class: 'wb-side-acts' });
  const sideBody = h('div', { class: 'wb-side-b' });
  const side = h('aside', { class: 'wb-side' }, h('div', { class: 'wb-side-h' }, sideTitle, h('span', { class: 'wb-sp' }), sideActs), sideBody);
  const sideSash = h('div', { class: 'wb-side-sash', role: 'separator', attrs: { 'aria-orientation': 'vertical', 'aria-label': tw('wb.resizeSide'), tabindex: '0' } });
  const groupsHost = h('div', { class: 'wb-groups-host' }, h('div', { class: 'wb-boot' }, h('span', { class: 'wb-spin' }), h('span', { text: tw('wb.loading') })));
  const panelTabs = h('div', { class: 'wb-panel-tabs', role: 'tablist' });
  const panelActs = h('div', { class: 'wb-panel-acts' });
  const panelBody = h('div', { class: 'wb-panel-b' });
  const panel = h('section', { class: 'wb-panel', attrs: { 'aria-label': tw('wb.panel') } }, h('div', { class: 'wb-panel-h' }, panelTabs, h('span', { class: 'wb-sp' }), panelActs), panelBody);
  const panelSash = h('div', { class: 'wb-panel-sash', role: 'separator', attrs: { 'aria-orientation': 'horizontal', 'aria-label': tw('wb.resizePanel'), tabindex: '0' } });
  const center = h('div', { class: 'wb-center' }, groupsHost, panelSash, panel);
  const statusL = h('div', { class: 'wb-status-l' });
  const statusR = h('div', { class: 'wb-status-r' });
  const status = h('footer', { class: 'wb-status' }, statusL, statusR);
  const shell = h('div', { class: 'wb-shell' }, activity, side, sideSash, center);
  host.append(shell, status);
  // Focus moves (a dialog closing, a terminal, the editor) must never scroll the window frame itself.
  for (let el = host; el && !el.classList?.contains('desk'); el = el.parentElement) {
    if (el.classList?.contains('wb-tree') || el === document.body) break;
    const node = el;
    const pin = () => { if (node.scrollTop || node.scrollLeft) { node.scrollTop = 0; node.scrollLeft = 0; } };
    node.addEventListener('scroll', pin);
    offs.push(() => node.removeEventListener('scroll', pin));
    if (node.classList?.contains('win')) break;
  }

  const quick = createQuick(host, { provide: provideQuick, placeholder: (mode) => tw(`wb.quick.ph.${mode}`) });

  /* ---------- side views ---------- */
  function showView(id, { toggle = false, focus = true } = {}) {
    if (toggle && st.view === id && st.sideOpen) { st.sideOpen = false; store('side', '0'); paintShell(); editors?.layoutAll(); return; }
    st.view = id;
    st.sideOpen = true;
    store('view', id);
    store('side', '1');
    paintShell();
    const v = viewObj(id);
    if (!v) return;
    sideBody.replaceChildren(v.el);
    clear(sideActs).append(...(v.actions || []));
    if (id === 'scm') scm.refresh();
    if (focus) (id === 'search' ? search.focus() : id === 'scm' ? scm.focusMessage() : explorer.focus());
    editors?.layoutAll();
  }
  const viewObj = (id) => ({ explorer, search, scm }[id]);

  function paintShell() {
    for (const b of [actExplorer, actSearch, actScm]) {
      const on = st.sideOpen && b.dataset.view === st.view;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', String(on));
    }
    sideTitle.textContent = tw(`wb.view.${st.view}`);
    host.classList.toggle('is-side-closed', !st.sideOpen);
    host.classList.toggle('is-panel-open', st.panelOpen);
    host.classList.toggle('is-panel-max', st.panelOpen && st.panelMax);
    host.style.setProperty('--wb-side-w', `${Math.max(180, Math.min(560, st.sideW))}px`);
    host.style.setProperty('--wb-panel-h', `${Math.max(120, st.panelH)}px`);
    scmBadge.hidden = !st.scmCount;
    scmBadge.textContent = st.scmCount > 99 ? '99+' : String(st.scmCount);
  }

  /* ---------- panel ---------- */
  const runPre = h('pre', { class: 'wb-runlog', attrs: { 'aria-live': 'polite' } }, h('span', { class: 'wb-faint', text: tw('wb.out.empty') }));
  const PANELS = ['terminal', 'problems', 'output'];
  function showPanel(id, { toggle = false, focus = true } = {}) {
    if (toggle && st.panelOpen && st.panel === id) { closePanel(); return; }
    st.panel = id;
    st.panelOpen = true;
    store('panel', id);
    store('panelOpen', '1');
    paintPanel();
    if (id === 'terminal') terms?.show().then(() => focus && terms.focus());
    else terms?.hide();
    paintShell();
    editors?.layoutAll();
  }
  function closePanel() {
    st.panelOpen = false;
    store('panelOpen', '0');
    terms?.hide();
    paintShell();
    editors?.layoutAll();
    editors?.activeEditor()?.focus();
  }
  function paintPanel() {
    clear(panelTabs);
    for (const id of PANELS) {
      const label = tw(`wb.panel.${id}`);
      let count = null;
      if (id === 'problems' && (st.problems.errors || st.problems.warnings)) count = String(st.problems.errors + st.problems.warnings);
      if (id === 'terminal' && st.terminals) count = String(st.terminals);
      panelTabs.append(h('button', { class: `wb-panel-tab${st.panel === id ? ' is-on' : ''}`, type: 'button', role: 'tab', attrs: { 'aria-selected': String(st.panel === id) }, on: { click: () => showPanel(id) } }, h('span', { text: label }), count ? h('span', { class: 'wb-count', text: count }) : null));
    }
    clear(panelActs).append(
      h('button', { class: 'wb-ibtn', type: 'button', title: st.panelMax ? tw('wb.panel.restore') : tw('wb.panel.maximize'), attrs: { 'aria-label': st.panelMax ? tw('wb.panel.restore') : tw('wb.panel.maximize') }, html: st.panelMax ? ICON.min : ICON.max, on: { click: () => { st.panelMax = !st.panelMax; paintPanel(); paintShell(); editors?.layoutAll(); } } }),
      h('button', { class: 'wb-ibtn', type: 'button', title: `${tw('wb.panel.close')} (Ctrl+J)`, attrs: { 'aria-label': tw('wb.panel.close') }, html: ICON.x, on: { click: () => closePanel() } }));
    const body = st.panel === 'terminal' ? terms?.el : st.panel === 'problems' ? problems?.el : runPre;
    if (body && panelBody.firstChild !== body) panelBody.replaceChildren(body);
  }

  let runChars = 0;
  function appendRun(text, kind) {
    if (runPre.firstChild?.classList?.contains('wb-faint')) clear(runPre);
    const clean = String(text).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
    runPre.append(kind ? h('span', { class: `wb-run-${kind}`, text: clean }) : document.createTextNode(clean));
    runChars += clean.length;
    while (runChars > 200000 && runPre.firstChild) {
      runChars -= runPre.firstChild.textContent.length;
      runPre.firstChild.remove();
    }
    runPre.scrollTop = runPre.scrollHeight;
  }

  /* ---------- sashes ---------- */
  function dragSash(elm, axis, onMove, onEnd) {
    elm.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      elm.setPointerCapture(ev.pointerId);
      host.classList.add('is-dragging');
      const move = (e) => onMove(e);
      const up = () => { elm.removeEventListener('pointermove', move); elm.removeEventListener('pointerup', up); host.classList.remove('is-dragging'); onEnd(); };
      elm.addEventListener('pointermove', move);
      elm.addEventListener('pointerup', up);
    });
    elm.addEventListener('keydown', (e) => {
      const d = axis === 'x' ? { ArrowLeft: -16, ArrowRight: 16 }[e.key] : { ArrowUp: 16, ArrowDown: -16 }[e.key];
      if (!d) return;
      e.preventDefault();
      if (axis === 'x') st.sideW += d; else st.panelH += d;
      paintShell();
      onEnd();
    });
  }
  dragSash(sideSash, 'x', (e) => { st.sideW = e.clientX - side.getBoundingClientRect().left; paintShell(); }, () => { store('sideW', String(Math.round(st.sideW))); editors?.layoutAll(); });
  dragSash(panelSash, 'y', (e) => { st.panelH = center.getBoundingClientRect().bottom - e.clientY; paintShell(); }, () => { store('panelH', String(Math.round(st.panelH))); editors?.layoutAll(); });

  /* ---------- status bar ---------- */
  function paintStatus() {
    if (!editors) return;
    clear(statusL);
    clear(statusR);
    const a = editors.active();
    const ed = editors.activeEditor();
    const pos = ed?.getPosition();
    const s = st.settings || {};
    if (st.branch) statusL.append(h('button', { class: 'wb-st is-btn', type: 'button', title: tw('wb.view.scm'), on: { click: () => showView('scm') } }, h('span', { class: 'wb-st-ico', html: ICON.scm }), h('span', { text: st.branch })));
    statusL.append(h('button', { class: `wb-st is-btn${st.problems.errors ? ' is-bad' : ''}`, type: 'button', title: tw('wb.panel.problems'), on: { click: () => showPanel('problems', { toggle: true }) } },
      h('span', { text: `✕ ${st.problems.errors}` }), h('span', { text: `⚠ ${st.problems.warnings}` })));
    const p = project?.status;
    if (p?.state === 'loading') statusL.append(h('span', { class: 'wb-st wb-faint', text: tw('wb.pr.loading', { n: p.files }) }));
    if (a?.kind === 'file') {
      const lang = languageOf(a.path);
      if (a.root !== 'ws') statusR.append(h('span', { class: 'wb-st', text: rootName(a.root) }));
      if (pos) statusR.append(h('button', { class: 'wb-st is-btn', type: 'button', title: tw('wb.cmd.gotoLine'), text: tw('wb.st.lnCol', { line: pos.lineNumber, col: pos.column }), on: { click: () => runEditorAction('editor.action.gotoLine') } }));
      statusR.append(h('span', { class: 'wb-st', text: s.insertSpaces === false ? tw('wb.st.tabs', { n: s.tabSize || 2 }) : tw('wb.st.spaces', { n: s.tabSize || 2 }) }), h('span', { class: 'wb-st', text: 'UTF-8' }), h('span', { class: 'wb-st', text: languageLabel(lang) }));
      const e = editors.entry(a.key);
      if (e && e.kind !== 'plain' && !editors.session().canEdit()) statusR.append(h('span', { class: 'wb-st is-warn', text: tw('wb.ed.readOnly') }));
    }
    if (editors.saveState) statusR.append(h('span', { class: 'wb-st', text: editors.saveState }));
    const people = editors.session().people();
    if (people.length) {
      const who = h('span', { class: 'wb-st wb-people' });
      for (const x of people) {
        const av = avatar(x, 18);
        const mine = x.id === editors.session().myId();
        av.title = mine ? tw('wb.st.you', { name: x.name }) : tw('wb.st.follow', { name: x.name });
        if (!mine) {
          av.classList.add('is-click');
          av.addEventListener('click', () => editors.setFollow(editors.follow === x.id ? null : x.id));
        }
        if (editors.follow === x.id) av.classList.add('is-followed');
        who.append(av);
      }
      statusR.append(who);
    }
    if (st.info?.terminal?.kind === 'basic') statusR.append(h('span', { class: 'wb-st is-warn', title: st.info.terminal.reason || '', text: tw('wb.term.basic') }));
  }

  let statusTimer = null;
  const paintStatusSoon = () => { if (!statusTimer) statusTimer = requestAnimationFrame(() => { statusTimer = null; paintStatus(); }); };

  /* ---------- roots ---------- */
  const rootName = (id) => (id === 'ws' ? tw('wb.ex.workspace') : st.roots.find((r) => r.id === id)?.name || id);
  async function refreshRoots() {
    try { st.roots = (await wb('wb.roots.list', {})).roots; } catch { /* keep */ }
    explorer?.paint();
    search?.paintRoots();
    scm?.paintRoots();
    settingsView?.paint();
    for (const r of st.roots) if (!r.workspace && !r.missing) wb('wb.fs.watch', { root: r.id }).catch(() => {});
  }
  async function addRoot() {
    const p = await prompt({ title: tw('wb.ex.openFolder'), label: tw('wb.ex.openFolderHelp'), ok: tw('wb.ex.open'), check: (v) => (v.trim() ? '' : tw('wb.ex.nameEmpty')) });
    if (!p) return;
    try {
      const { root } = await wb('wb.roots.add', { path: p.trim() });
      await refreshRoots();
      notifyText(tw('wb.ex.opened', { name: root.name }), 'ok');
      explorer.reveal(root.id, '', { select: false });
      showView('explorer');
    } catch (err) {
      notifyText(err.message, 'bad');
    }
  }
  async function removeRoot(id) {
    const r = st.roots.find((x) => x.id === id);
    const ok = await confirm({ title: tw('wb.ex.removeRoot'), text: tw('wb.ex.removeRootText', { name: r?.name || id }), ok: tw('wb.ex.removeRootOk') });
    if (!ok) return;
    try {
      await wb('wb.roots.remove', { id });
      explorer.forget(id);
      editors.removed(id, '', true);
      await refreshRoots();
    } catch (err) { notifyText(err.message, 'bad'); }
  }

  function notifyText(text, kind = 'info') {
    desk?.notify?.({ title: text, kind: kind === 'bad' ? 'error' : kind === 'warn' ? 'warn' : kind === 'ok' ? 'ok' : 'info', key: `wb:${text.slice(0, 40)}` });
  }

  /* ---------- themes: one source for the editor, the terminal and the panels ---------- */
  const themeId = () => editorThemeId(st.settings?.theme || 'desk', deskTheme);
  const termTheme = () => terminalTheme(st.settings?.theme === 'hivedesk-light' ? { scheme: 'light', colors: { bg2: '#FBF7F0', text: '#2B1D12', text2: '#4A3A2B', accent: '#C97A00', accent2: '#A15C00', ok: '#3F7A2E', bad: '#B24A3A', info: '#2F6A9E', faint: '#9C8D7A', panel4: '#D6C9B5', bg: '#F6F0E6' } } : st.settings?.theme === 'hivedesk-dark' ? null : deskTheme);
  function applyTheme() {
    if (!monaco) return;
    if (deskTheme) defineDeskTheme(monaco, deskTheme);
    host.dataset.scheme = (st.settings?.theme === 'hivedesk-light' || (st.settings?.theme !== 'hivedesk-dark' && deskTheme?.scheme === 'light')) ? 'light' : 'dark';
    editors?.themeChanged();
    terms?.themeChanged();
  }

  /* ---------- quick picker ---------- */
  let fileCache = { at: 0, list: [] };
  async function allFiles() {
    if (Date.now() - fileCache.at < 15000 && fileCache.list.length) return fileCache.list;
    const lists = await Promise.all(st.roots.filter((r) => !r.missing).map((r) => wb('wb.fs.files', { root: r.id }).then((x) => x.files.map((f) => ({ root: r.id, path: f.path })), () => [])));
    fileCache = { at: Date.now(), list: lists.flat() };
    return fileCache.list;
  }

  function editorActionEntries() {
    const ed = editors?.activeEditor();
    if (!ed) return [];
    return ed.getSupportedActions().filter((a) => a.label && a.isSupported()).map((a) => ({ id: a.id, label: a.label, group: 'editor', run: () => { ed.focus(); a.run(); } }));
  }

  // Pickers that are not files, commands or symbols (branches): the scm view fills these.
  let pickItems = [];

  async function provideQuick(mode, q) {
    if (mode === 'pick') {
      return pickItems.map((it) => ({ it, m: fuzzy(it.label, q) })).filter((x) => x.m).sort((a, b) => (q ? b.m.score - a.m.score : 0)).map(({ it, m }) => ({ ...it, marks: m.marks }));
    }
    if (mode === 'files') {
      const files = await allFiles();
      const multi = st.roots.length > 1;
      const keys = files.map((f) => (multi && f.root !== 'ws' ? `${rootName(f.root)}/${f.path}` : f.path));
      const byKey = new Map(files.map((f, i) => [keys[i], f]));
      return rankFiles(keys, q).map((r) => {
        const f = byKey.get(r.path);
        const name = f.path.split('/').pop();
        return { label: r.path, marks: r.marks, badge: badgeOf(name), run: () => editors.open(f.root, f.path, { focus: true }) };
      });
    }
    if (mode === 'commands') {
      const list = [...commands.entries(), ...editorActionEntries()];
      const seen = new Set();
      const scored = [];
      for (const c of list) {
        if (seen.has(c.label)) continue;
        seen.add(c.label);
        const m = fuzzy(c.label, q);
        if (m) scored.push({ ...c, score: m.score, marks: m.marks });
      }
      if (q) scored.sort((a, b) => b.score - a.score);
      return scored.map((c) => ({ label: c.label, marks: c.marks, keys: c.keys?.map((k) => k.replace(/\+/g, ' ')), hint: c.group === 'editor' ? tw('wb.quick.editor') : '', run: c.run }));
    }
    if (mode === 'line') {
      const ed = editors.activeEditor();
      const m = /^(\d+)(?::(\d+))?$/.exec(q);
      if (!ed) return [];
      const total = ed.getModel()?.getLineCount() || 0;
      if (!m) return [{ label: tw('wb.quick.lineHelp', { n: total }), run: () => {} }];
      const line = Math.min(total, Number(m[1]));
      return [{ label: tw('wb.quick.goLine', { line, col: m[2] || 1 }), run: () => { ed.setPosition({ lineNumber: line, column: Number(m[2]) || 1 }); ed.revealLineInCenter(line); ed.focus(); } }];
    }
    if (mode === 'outline') return outlineItems(q);
    if (mode === 'symbols') return workspaceSymbols(q);
    return [];
  }

  /** Symbols of the active file from the language service (or the editor's own outline). */
  async function outlineItems(q) {
    const a = editors.active();
    const ed = editors.activeEditor();
    if (!a || !ed) return [];
    const worker = await tsWorker(a.path);
    if (!worker) return [{ label: tw('wb.quick.outlineEditor'), run: () => runEditorAction('editor.action.quickOutline') }];
    const model = ed.getModel();
    const tree = await worker.w.getNavigationTree(model.uri.toString());
    const out = [];
    const walk = (n, container) => {
      if (n.text !== '<global>' && n.spans?.[0]) out.push({ name: n.text, kind: n.kind, container, start: n.spans[0].start });
      for (const c of n.childItems || []) walk(c, n.text === '<global>' ? '' : n.text);
    };
    if (tree) walk(tree, '');
    return out.map((s) => ({ s, m: fuzzy(s.name, q) })).filter((x) => x.m).sort((a2, b) => (q ? b.m.score - a2.m.score : a2.s.start - b.s.start)).map(({ s, m }) => ({
      label: s.name, marks: m.marks, detail: s.container, hint: s.kind,
      run: () => { const p = model.getPositionAt(s.start); ed.setPosition(p); ed.revealPositionInCenter(p); ed.focus(); },
    }));
  }

  async function tsWorker(path) {
    if (!monaco?.languages.typescript) return null;
    const lang = languageOf(path || '');
    const isTs = lang === 'typescript';
    const isJs = lang === 'javascript';
    if (!isTs && !isJs) return null;
    try {
      const get = isTs ? await monaco.languages.typescript.getTypeScriptWorker() : await monaco.languages.typescript.getJavaScriptWorker();
      const anyModel = monaco.editor.getModels().find((m) => m.getLanguageId() === lang);
      if (!anyModel) return null;
      return { w: await get(anyModel.uri), lang };
    } catch {
      return null;
    }
  }

  /** Workspace symbols: the TypeScript workers over every fed file, then a text search fallback. */
  async function workspaceSymbols(q) {
    if (!q) return [{ label: tw('wb.quick.symbolsHelp'), run: () => {} }];
    const out = [];
    for (const lang of ['typescript', 'javascript']) {
      const any = monaco.editor.getModels().find((m) => m.getLanguageId() === lang);
      if (!any) continue;
      try {
        const get = lang === 'typescript' ? await monaco.languages.typescript.getTypeScriptWorker() : await monaco.languages.typescript.getJavaScriptWorker();
        const w = await get(any.uri);
        const items = await w.getNavigateToItems(any.uri.toString(), q);
        for (const it of items || []) {
          const uri = monaco.Uri.parse(it.fileName);
          const where = fromUri(uri);
          const model = monaco.editor.getModel(uri);
          if (!where || !model) continue;
          const p = model.getPositionAt(it.textSpan.start);
          out.push({ name: it.name, kind: it.kind, container: it.containerName, where, line: p.lineNumber, col: p.column });
        }
      } catch { /* that worker is not ready */ }
    }
    if (!out.length) {
      // Plain files: definitions found by a text search (function, class, def and friends).
      const esc = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      try {
        const r = await wb('wb.search', { root: editors.active()?.root || 'ws', query: `\\b(?:function|class|def|fn|func|interface|struct|enum|type|trait|module)\\s+\\w*${esc}\\w*`, regex: true, wait: true, maxHits: 80 });
        for (const f of r.results) for (const hit of f.hits) out.push({ name: hit.preview.text.trim().slice(0, 80), kind: 'text', container: '', where: { root: editors.active()?.root || 'ws', path: f.path }, line: hit.line, col: hit.col });
      } catch { /* nothing */ }
    }
    return out.map((s) => ({ s, m: fuzzy(s.name, q) || { score: 0, marks: [] } })).sort((a, b) => b.m.score - a.m.score).slice(0, 80).map(({ s, m }) => ({
      label: s.name, marks: m.marks, detail: `${s.where.path}:${s.line}`, hint: s.kind,
      run: () => editors.open(s.where.root, s.where.path, { line: s.line, col: s.col, focus: true }),
    }));
  }

  function runEditorAction(id) {
    const ed = editors?.activeEditor();
    if (!ed) return;
    ed.focus();
    ed.getAction(id)?.run();
  }

  /* ---------- commands and shortcuts ---------- */
  function registerCommands() {
    const c = (id, keys, run, o = {}) => commands.register({ id, keys, run, title: () => tw(`wb.cmd.${id.replace(/^wb\./, '')}`), ...o });
    const hasFile = () => editors?.active()?.kind === 'file';
    c('wb.quickOpen', ['Ctrl+P'], () => quick.open(''));
    c('wb.palette', ['Ctrl+Shift+P'], () => quick.open('>'), { palette: false });
    c('wb.symbols', ['Ctrl+T'], () => quick.open('#'));
    c('wb.outline', ['Ctrl+Shift+O'], () => quick.open('@'), { when: hasFile });
    c('wb.gotoLine', ['Ctrl+G'], () => quick.open(':'), { when: hasFile });
    c('wb.view.explorer', ['Ctrl+Shift+E'], () => showView('explorer'));
    c('wb.view.search', ['Ctrl+Shift+F'], () => {
      const sel = editors.activeEditor();
      const text = sel ? sel.getModel()?.getValueInRange(sel.getSelection()) : '';
      showView('search', { focus: false });
      search.focus(text && !text.includes('\n') ? text : undefined);
    });
    c('wb.view.scm', ['Ctrl+Shift+G'], () => showView('scm'));
    c('wb.toggleSide', ['Ctrl+B'], () => { st.sideOpen = !st.sideOpen; store('side', st.sideOpen ? '1' : '0'); if (st.sideOpen) showView(st.view, { focus: false }); else paintShell(); editors.layoutAll(); });
    c('wb.togglePanel', ['Ctrl+J'], () => (st.panelOpen ? closePanel() : showPanel(st.panel)));
    c('wb.terminal', ['Ctrl+Alt+T'], () => { showPanel('terminal'); });
    c('wb.newTerminal', [], async () => { showPanel('terminal', { focus: false }); await terms.open(); });
    c('wb.problems', ['Ctrl+Shift+M'], () => showPanel('problems', { toggle: true }));
    c('wb.nextProblem', ['Alt+F8'], () => problems.next(1));
    c('wb.prevProblem', ['Alt+Shift+F8'], () => problems.next(-1));
    c('wb.output', [], () => showPanel('output'));
    c('wb.split', ['Ctrl+\\'], () => editors.split());
    c('wb.focus1', ['Ctrl+1'], () => editors.focusGroup(0), { palette: false });
    c('wb.focus2', ['Ctrl+2'], () => editors.focusGroup(1), { palette: false });
    c('wb.focus3', ['Ctrl+3'], () => editors.focusGroup(2), { palette: false });
    c('wb.closeTab', ['Ctrl+F4', 'Alt+W'], () => editors.closeActive());
    c('wb.closeAll', [], () => editors.closeAllIn());
    c('wb.nextTab', ['Ctrl+PageDown'], () => editors.cycle(1));
    c('wb.prevTab', ['Ctrl+PageUp'], () => editors.cycle(-1));
    c('wb.save', ['Ctrl+S'], () => editors.save(), { when: hasFile });
    c('wb.saveAll', ['Ctrl+Alt+S'], () => editors.saveAll());
    c('wb.format', ['Shift+Alt+F'], () => editors.format(), { when: hasFile });
    c('wb.review', [], () => editors.openReview(), { when: () => editors?.hasReview() });
    c('wb.newFile', ['Ctrl+Alt+N'], () => explorer.newFile(editors.active()?.root || 'ws'));
    c('wb.newFolder', [], () => explorer.newFolder(editors.active()?.root || 'ws'));
    c('wb.openFolder', [], () => addRoot());
    c('wb.reveal', [], () => { const a = editors.active(); if (a?.path) { showView('explorer', { focus: false }); explorer.reveal(a.root, a.path); } }, { when: hasFile });
    c('wb.settings', ['Ctrl+,'], () => editors.openSettings());
    c('wb.commit', [], () => { showView('scm'); scm.focusMessage(); });
    c('wb.refreshScm', [], () => scm.refresh());
    c('wb.definition', [], () => runEditorAction('editor.action.revealDefinition'), { when: hasFile });
    c('wb.references', [], () => runEditorAction('editor.action.goToReferences'), { when: hasFile });
  }

  // Shortcuts work while focus is in the workbench, or nowhere in particular while its window is the focused one.
  let lastInside = false;
  const track = (e) => { if (e.target?.closest?.('.hd-dlg, .wb-menu, .hd-scrim')) return; lastInside = host.contains(e.target); };
  document.addEventListener('pointerdown', track, true);
  document.addEventListener('focusin', track, true);
  offs.push(() => { document.removeEventListener('pointerdown', track, true); document.removeEventListener('focusin', track, true); });
  const ours = (e) => host.contains(e.target) || ((e.target === document.body || e.target === document.documentElement || !!e.target.closest?.('.hd-dlg:not(.on)')) && (lastInside || host.closest('.win')?.dataset.id === wm.focusedId()));
  function onKey(e) {
    if (st.disposed || (quick.isOpen && e.key !== 'Escape') || !ours(e)) return;
    if (e.target.closest?.('.hd-dlg.on, .wb-menu')) return;
    const cmd = commands.forEvent(e);
    if (!cmd) return;
    e.preventDefault();
    e.stopPropagation();
    cmd.run();
  }
  document.addEventListener('keydown', onKey, true);

  /* ---------- tab context menu ---------- */
  function tabMenu(x, y, key, group) {
    const a = key.startsWith('f:') ? key.slice(2) : null;
    const root = a ? a.slice(0, a.indexOf(':')) : null;
    const path = a ? a.slice(a.indexOf(':') + 1) : null;
    contextMenu(x, y, [
      { label: tw('wb.cmd.closeTab'), keys: 'Alt W', run: () => editors.closeTab(key, group) },
      { label: tw('wb.ed.closeOthers'), run: () => editors.closeOthers(key, group) },
      'sep',
      { label: tw('wb.cmd.split'), keys: 'Ctrl \\', run: () => editors.split(key) },
      ...(path ? ['sep', { label: tw('wb.cmd.reveal'), run: () => { showView('explorer', { focus: false }); explorer.reveal(root, path); } }, { label: tw('wb.ex.copyRel'), run: () => navigator.clipboard?.writeText(path) }] : []),
    ]);
  }

  /* ---------- engine events ---------- */
  function onEngineEvent(ev) {
    const d = ev.data || {};
    if (ev.type === 'file.changed') {
      fileCache.at = 0;
      explorer?.changed('ws', [d.path]);
      if (d.op === 'delete') project?.update('ws', d.path, null);
      else if (typeof d.content === 'string') {
        if (d.op === 'create') project?.add('ws', d.path, d.content);
        else project?.update('ws', d.path, d.content);
      }
      scm?.refreshSoon();
    } else if (ev.type === 'tool.called' && d.tool === 'run') appendRun(`\n$ ${d.args?.command || ''}\n`, 'cmd');
    else if (ev.type === 'run.finished') appendRun(`\n[${tw('wb.out.exit', { code: d.exitCode, ms: d.ms })}${d.timedOut ? `, ${tw('wb.out.timedOut')}` : ''}]\n`, d.exitCode === 0 ? 'ok' : 'bad');
    else if (ev.type === 'github.committed' || ev.type === 'github.branch') scm?.refreshSoon();
  }

  function onWbFrame(f) {
    if (f.type === 'fs.changed') {
      fileCache.at = 0;
      explorer?.changed(f.data.root, f.data.paths || []);
      editors?.onDiskChanged(f.data.root, f.data.paths || []);
      if (f.data.root === scm?.root) scm.refreshSoon();
    }
  }

  /* ---------- boot ---------- */
  const api = {
    root: host,
    open: (p, o = {}) => (editors ? editors.open(o.root || 'ws', p, { focus: true, ...o }) : (firstPathQueue.push(p))),
    save: () => editors?.save(),
    get active() { const a = editors?.active(); return a?.kind === 'file' && a.root === 'ws' ? a.path : null; },
    get editor() { return editors?.activeEditor() || null; },
    review: () => editors?.openReview(),
    follow: (id) => editors?.setFollow(id),
    commands: () => commands.entries(),
    run: (id) => commands.run(id),
    quick: (text) => quick.open(text),
    dispose() {
      st.disposed = true;
      for (const off of offs) off?.();
      document.removeEventListener('keydown', onKey, true);
      editors?.dispose();
      terms?.dispose();
      problems?.dispose();
      search?.dispose();
      project?.clear();
      room.dispose();
    },
    ready: null,
  };
  const firstPathQueue = firstPath ? [firstPath] : [];

  api.ready = (async () => {
    await loadStrings();
    const [info, m] = await Promise.all([wb('wb.info', {}), loadMonaco()]);
    if (st.disposed) return api;
    monaco = m;
    st.info = info;
    st.settings = info.settings;
    st.roots = info.roots;
    try { deskTheme = (await import('/themes/index.js')).activeTheme?.() || null; } catch { deskTheme = null; }
    project = new ProjectModels(monaco, uriFor);
    editors = createEditors({
      monaco, room, desk,
      settings: () => st.settings,
      themeId,
      projectModels: project,
      onChange: () => { paintStatusSoon(); explorer?.paint(); },
      reveal: (root, dir) => { showView('explorer', { focus: false }); explorer.reveal(root, dir); },
      renderSettings: (el) => { settingsView = renderSettings(el, { get: () => st.settings, set: (s) => { st.settings = s; editors.settingsChanged(); terms?.settingsChanged(); applyTheme(); if (s.projectDiagnostics && project.status.state === 'off') project.feed('ws'); if (!s.projectDiagnostics) project.clear(); }, roots: () => st.roots, addRoot, removeRoot, notify: notifyText, info: () => st.info }); },
      rootName,
      tabMenu,
      saved: () => { fileCache.at = 0; scm?.refreshSoon(); },
      addEditorActions: (editor) => {
        editor.addAction({ id: 'hivedesk.save', label: tw('wb.cmd.save'), run: () => editors.save() });
        editor.addAction({ id: 'hivedesk.quickOpen', label: tw('wb.cmd.quickOpen'), run: () => quick.open('') });
        editor.addAction({ id: 'hivedesk.palette', label: tw('wb.cmd.palette'), run: () => quick.open('>') });
        editor.addAction({ id: 'hivedesk.split', label: tw('wb.cmd.split'), run: () => editors.split() });
        editor.addAction({ id: 'hivedesk.review', label: tw('wb.cmd.review'), run: () => editors.openReview() });
      },
    });
    explorer = createExplorer({
      roots: () => st.roots,
      open: (root, path, o) => editors.open(root, path, o),
      active: () => { const a = editors.active(); return a?.kind === 'file' ? a : null; },
      reviewMarks: (root) => editors.reviewPaths(root),
      people: () => editors.session().people().filter((p) => p.id !== editors.session().myId()),
      renamed: (root, from, to, isDir) => { editors.renamed(root, from, to, isDir); fileCache.at = 0; scm?.refreshSoon(); },
      removed: (root, path, isDir) => { editors.removed(root, path, isDir); fileCache.at = 0; scm?.refreshSoon(); },
      addRoot, removeRoot,
      terminalHere: async (root, dir) => { showPanel('terminal', { focus: false }); await terms.open({ root, cwd: dir }); },
      searchIn: (root, dir) => { showView('search', { focus: false }); search.in(root, dir); },
      notify: notifyText,
    });
    search = createSearch({ roots: () => st.roots, open: (root, path, o) => editors.open(root, path, o), notify: notifyText, saved: () => { fileCache.at = 0; scm?.refreshSoon(); } });
    scm = createScm({
      roots: () => st.roots,
      openDiff: (root, path, staged) => editors.openDiff(root, path, staged),
      open: (root, path) => editors.open(root, path, { focus: true }),
      notify: notifyText,
      onCount: (n) => { st.scmCount = n; paintShell(); },
      quick: (items, placeholder) => { pickItems = items; quick.open('', { mode: 'pick', placeholder }); },
    });
    problems = createProblems({
      monaco, fromUri, rootName,
      open: (root, path, o) => editors.open(root, path, o),
      onCount: (c) => { st.problems = c; paintPanel(); paintStatusSoon(); },
      project: () => project.status,
      cursor: () => { const a = editors.active(); const p = editors.activeEditor()?.getPosition(); return a && p ? { root: a.root, path: a.path, line: p.lineNumber, col: p.column } : null; },
    });
    terms = createTerminals({ termTheme, settings: () => st.settings, info: () => st.info, notify: notifyText, onCount: (n) => { st.terminals = n; paintPanel(); } });
    offs.push(project.onStatus(() => { problems.paint(); paintStatusSoon(); }));

    // Go to definition across files opens the target in the workbench.
    const opener = monaco.editor.registerEditorOpener({
      openCodeEditor(_source, resource, selection) {
        const where = fromUri(resource);
        if (!where) return false;
        const line = selection ? (selection.startLineNumber ?? selection.lineNumber) : undefined;
        const col = selection ? (selection.startColumn ?? selection.column) : undefined;
        editors.open(where.root, where.path, { line, col, focus: true });
        return true;
      },
    });
    offs.push(() => opener.dispose());

    groupsHost.replaceChildren(editors.el);
    offs.push(onEvent(onEngineEvent));
    offs.push(onFrame(onWbFrame));
    offs.push(desk.on('live', (f) => f.type === 'run.output' && appendRun(f.data?.text || '', f.data?.stream === 'stderr' ? 'bad' : '')));
    offs.push(room.on('people', paintStatusSoon));
    offs.push(collab.on('people', paintStatusSoon));
    try {
      const themes = await import('/themes/index.js');
      offs.push(themes.onPaint?.((t) => { deskTheme = t; applyTheme(); }));
    } catch { /* themes module not loaded */ }
    registerCommands();
    applyTheme();
    showView(st.view, { focus: false });
    if (st.panelOpen) showPanel(st.panel, { focus: false });
    paintPanel();
    paintShell();
    refreshRoots();
    scm.refresh().then(async () => {
      try { const s = await wb('wb.scm.status', { root: 'ws' }); st.branch = s.branch; } catch { st.branch = null; }
      paintStatusSoon();
    });
    if (st.settings.projectDiagnostics) project.feed('ws');
    for (const p of firstPathQueue.splice(0)) editors.open('ws', p, { focus: true });
    paintStatus();
    return api;
  })();
  api.ready.catch((err) => {
    groupsHost.replaceChildren(h('div', { class: 'wb-boot' }, h('p', { class: 'wb-error', text: tw('wb.loadFail', { error: err.message }) })));
  });

  return api;
}
