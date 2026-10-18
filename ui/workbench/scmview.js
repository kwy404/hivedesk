// Source control: the branch, staged changes and changes apart, a diff per file, stage and
// unstage (one file or all), discard for tracked files (with a confirm), commit what is staged
// (Ctrl+Enter), branches (switch or create) and the stash list, on src/github/git.js.

import { h, clear } from '/js/dom.js';
import { wb } from './net.js';
import { tw } from './strings.js';
import { confirm, prompt } from './dialogs.js';
import { validBranchName, groupStatus } from './util.js';

const ICON = {
  plus: '<svg viewBox="0 0 24 24"><path d="M12 6v12M6 12h12"/></svg>',
  minus: '<svg viewBox="0 0 24 24"><path d="M6 12h12"/></svg>',
  undo: '<svg viewBox="0 0 24 24"><path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></svg>',
  refresh: '<svg viewBox="0 0 24 24"><path d="M19 12a7 7 0 1 1-2.1-5"/><path d="M19 4v4h-4"/></svg>',
  branch: '<svg viewBox="0 0 24 24"><circle cx="7" cy="6" r="2"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="8" r="2"/><path d="M7 8v8M17 10c0 4-6 3-9.2 6.4"/></svg>',
  open: '<svg viewBox="0 0 24 24"><path d="M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5z"/><path d="M14 3.5v5h5"/></svg>',
};

/**
 * @param {{ roots: () => Array<{ id, name, workspace }>, openDiff: (root, path, staged) => void, open: (root, path) => void, notify: (t, k?) => void, onCount: (n: number) => void, quick: (items, placeholder) => void }} ctx
 */
export function createScm(ctx) {
  const st = { root: 'ws', status: null, error: '', busy: false, stashes: [], message: '' };
  try { st.message = localStorage.getItem('hivedesk.wb.commitMsg') || ''; } catch { /* none */ }
  const rootSel = h('select', { class: 'wb-select', attrs: { 'aria-label': tw('wb.scm.repo') } });
  const branchBtn = h('button', { class: 'wb-btn is-sm wb-branch', type: 'button', on: { click: () => pickBranch() } });
  const refreshBtn = h('button', { class: 'wb-ibtn', type: 'button', title: tw('wb.scm.refresh'), attrs: { 'aria-label': tw('wb.scm.refresh') }, html: ICON.refresh, on: { click: () => refresh() } });
  const msg = h('textarea', { class: 'wb-input wb-commit-msg', rows: 3, placeholder: tw('wb.scm.message'), spellcheck: true, attrs: { 'aria-label': tw('wb.scm.message') } });
  msg.value = st.message;
  const commitBtn = h('button', { class: 'wb-btn is-primary wb-commit', type: 'button', on: { click: () => commit() } });
  const body = h('div', { class: 'wb-scm-body' });
  const el = h('div', { class: 'wb-side-body wb-scm' }, h('div', { class: 'wb-scm-top' }, rootSel, branchBtn), h('div', { class: 'wb-scm-commit' }, msg, commitBtn), body);
  const actions = [refreshBtn];

  msg.addEventListener('input', () => {
    try { localStorage.setItem('hivedesk.wb.commitMsg', msg.value); } catch { /* not kept */ }
    paintCommit();
  });
  msg.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commit(); } });
  rootSel.addEventListener('change', () => { st.root = rootSel.value; refresh(); });

  function paintRoots() {
    const roots = ctx.roots();
    if (!roots.some((r) => r.id === st.root)) st.root = 'ws';
    clear(rootSel).append(...roots.map((r) => h('option', { value: r.id, text: r.workspace ? tw('wb.ex.workspace') : r.name, selected: r.id === st.root })));
    rootSel.hidden = roots.length < 2;
  }

  let inflight = null;
  async function refresh() {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        st.status = await wb('wb.scm.status', { root: st.root });
        st.error = '';
        if (st.status.isRepo) st.stashes = (await wb('wb.scm.stashes', { root: st.root }).catch(() => ({ stashes: [] }))).stashes;
      } catch (err) {
        st.status = null;
        st.error = err.code === 'git_missing' ? tw('wb.scm.gitMissing') : err.message;
      }
      paint();
    })();
    try { await inflight; } finally { inflight = null; }
  }

  let soonTimer = null;
  const refreshSoon = () => { clearTimeout(soonTimer); soonTimer = setTimeout(refresh, 400); };

  async function act(fn) {
    if (st.busy) return;
    st.busy = true;
    paintCommit();
    try { await fn(); } catch (err) { ctx.notify(err.hint ? `${err.message} ${err.hint}` : err.message, 'bad'); } finally { st.busy = false; }
    await refresh();
  }

  const stage = (paths) => act(() => wb('wb.scm.stage', { root: st.root, paths }));
  const unstage = (paths) => act(() => wb('wb.scm.unstage', { root: st.root, paths }));
  async function discard(paths) {
    const ok = await confirm({ title: tw('wb.scm.discardTitle'), text: paths.length === 1 ? tw('wb.scm.discardOne', { path: paths[0] }) : tw('wb.scm.discardMany', { n: paths.length }), ok: tw('wb.scm.discard'), danger: true });
    if (ok) act(() => wb('wb.scm.discard', { root: st.root, paths }));
  }

  async function commit() {
    const g = groupStatus(st.status?.files);
    const message = msg.value.trim();
    if (!message) { msg.focus(); ctx.notify(tw('wb.scm.needMessage'), 'warn'); return; }
    if (!g.staged.length) {
      if (!g.changes.length) return;
      const ok = await confirm({ title: tw('wb.scm.stageAllTitle'), text: tw('wb.scm.stageAllText', { n: g.changes.length }), ok: tw('wb.scm.stageAllOk') });
      if (!ok) return;
      try { await wb('wb.scm.stage', { root: st.root, paths: g.changes.map((f) => f.path) }); } catch (err) { ctx.notify(err.message, 'bad'); return; }
    }
    await act(async () => {
      const r = await wb('wb.scm.commit', { root: st.root, message }, { timeout: 120000 });
      msg.value = '';
      try { localStorage.removeItem('hivedesk.wb.commitMsg'); } catch { /* fine */ }
      ctx.notify(tw('wb.scm.committed', { sha: r.sha.slice(0, 7), n: r.files.length, branch: r.branch || '' }), 'ok');
    });
  }

  async function pickBranch() {
    if (!st.status?.isRepo) return;
    let list;
    try { list = await wb('wb.scm.branches', { root: st.root }); } catch (err) { ctx.notify(err.message, 'bad'); return; }
    const items = list.branches.map((b) => ({ label: b.name, detail: b.upstream ? `${b.sha} → ${b.upstream}` : b.sha, hint: b.current ? tw('wb.scm.current') : '', run: () => { if (!b.current) act(() => wb('wb.scm.checkout', { root: st.root, branch: b.name })); } }));
    items.unshift({ label: tw('wb.scm.newBranch'), detail: '', hint: '+', run: () => newBranch() });
    ctx.quick(items, tw('wb.scm.pickBranch'));
  }

  async function newBranch() {
    const name = await prompt({ title: tw('wb.scm.newBranch'), label: tw('wb.scm.branchName'), check: (v) => (validBranchName(v.trim()) ? '' : tw('wb.scm.badBranch')) });
    if (name) act(() => wb('wb.scm.checkout', { root: st.root, branch: name.trim(), create: true }));
  }

  async function init() {
    const ok = await confirm({ title: tw('wb.scm.initTitle'), text: tw('wb.scm.initText'), ok: tw('wb.scm.init') });
    if (ok) act(() => wb('wb.scm.init', { root: st.root }));
  }

  function paintCommit() {
    const g = groupStatus(st.status?.files);
    commitBtn.textContent = g.staged.length ? tw('wb.scm.commitN', { n: g.staged.length }) : tw('wb.scm.commit');
    commitBtn.disabled = st.busy || !st.status?.isRepo || (!g.staged.length && !g.changes.length);
    commitBtn.title = tw('wb.scm.commitTip');
  }

  function fileRow(f, staged) {
    const name = f.path.split('/').pop();
    const dir = f.path.slice(0, f.path.length - name.length).replace(/\/$/, '');
    const btn = (icon, title, run) => h('button', { class: 'wb-ibtn is-xs', type: 'button', title, attrs: { 'aria-label': `${title}: ${f.path}` }, html: icon, on: { click: (e) => { e.stopPropagation(); run(); } } });
    return h('div', { class: `wb-scm-file is-${f.letter}`, role: 'listitem', tabindex: '0', title: f.from ? `${f.from} -> ${f.path}` : f.path,
      on: { click: () => ctx.openDiff(st.root, f.path, staged), keydown: (e) => { if (e.key === 'Enter') ctx.openDiff(st.root, f.path, staged); if (e.key === ' ') { e.preventDefault(); (staged ? unstage : stage)([f.path]); } } } },
    h('span', { class: 'wb-name', text: name }), dir ? h('span', { class: 'wb-faint wb-ell', text: dir }) : null, h('span', { class: 'wb-sp' }),
    h('span', { class: 'wb-scm-acts' },
      f.letter !== 'D' ? btn(ICON.open, tw('wb.scm.openFile'), () => ctx.open(st.root, f.path)) : null,
      !staged && !f.untracked ? btn(ICON.undo, tw('wb.scm.discard'), () => discard([f.path])) : null,
      staged ? btn(ICON.minus, tw('wb.scm.unstage'), () => unstage([f.path])) : btn(ICON.plus, tw('wb.scm.stage'), () => stage([f.path]))),
    h('span', { class: 'wb-scm-letter', text: f.letter, title: tw(`wb.scm.letter.${f.letter}`) }));
  }

  function section(title, files, staged, extra) {
    if (!files.length) return null;
    return h('section', { class: 'wb-scm-sec' },
      h('div', { class: 'wb-scm-sec-h' }, h('span', { text: title }), h('span', { class: 'wb-count', text: String(files.length) }), h('span', { class: 'wb-sp' }), ...extra),
      h('div', { role: 'list' }, ...files.slice(0, 1000).map((f) => fileRow(f, staged))));
  }

  function paint() {
    paintRoots();
    clear(body);
    const s = st.status;
    branchBtn.hidden = !s?.isRepo;
    if (st.error) { body.append(h('p', { class: 'wb-error wb-pad', text: st.error })); ctx.onCount(0); paintCommit(); return; }
    if (!s) { body.append(h('p', { class: 'wb-faint wb-pad', text: tw('wb.loading') })); paintCommit(); return; }
    if (!s.isRepo) {
      body.append(h('div', { class: 'wb-pad wb-scm-empty' }, h('p', { text: tw('wb.scm.notRepo') }), h('button', { class: 'wb-btn', type: 'button', text: tw('wb.scm.init'), on: { click: () => init() } })));
      ctx.onCount(0);
      paintCommit();
      return;
    }
    clear(branchBtn).append(h('span', { class: 'wb-ico', html: ICON.branch }), h('span', { text: s.branch || (s.detached ? tw('wb.scm.detached', { sha: s.head || '' }) : tw('wb.scm.noBranch')) }));
    const g = groupStatus(s.files);
    ctx.onCount(g.staged.length + g.changes.length);
    const all = (label, run) => h('button', { class: 'wb-link', type: 'button', text: label, on: { click: run } });
    if (g.conflicts.length) body.append(h('p', { class: 'wb-warn wb-pad', text: tw('wb.scm.conflicts', { n: g.conflicts.length }) }));
    body.append(section(tw('wb.scm.staged'), g.staged, true, [all(tw('wb.scm.unstageAll'), () => unstage(g.staged.map((f) => f.path)))]) || '');
    body.append(section(tw('wb.scm.changes'), g.changes, false, [all(tw('wb.scm.stageAll'), () => stage(g.changes.map((f) => f.path)))]) || '');
    if (!g.staged.length && !g.changes.length) body.append(h('p', { class: 'wb-faint wb-pad', text: tw('wb.scm.clean') }));
    if (st.stashes.length) {
      body.append(h('section', { class: 'wb-scm-sec' }, h('div', { class: 'wb-scm-sec-h' }, h('span', { text: tw('wb.scm.stashes') }), h('span', { class: 'wb-count', text: String(st.stashes.length) })),
        ...st.stashes.slice(0, 50).map((x) => h('div', { class: 'wb-scm-stash', title: x.date || '' }, h('span', { class: 'wb-faint', text: x.ref }), h('span', { class: 'wb-ell', text: x.subject })))));
    }
    if (s.truncated) body.append(h('p', { class: 'wb-faint wb-pad', text: tw('wb.scm.truncated') }));
    paintCommit();
  }

  paint();

  return {
    el,
    actions,
    refresh,
    refreshSoon,
    paintRoots,
    focusMessage() { msg.focus(); },
    get root() { return st.root; },
  };
}
