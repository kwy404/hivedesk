// The Changelog window: the project's CHANGELOG.md (rendered), Mel's proposed entry for the
// last job (edit, pick the version, approve), and the activity log (who did what and when,
// with filters, export, and the file and diff behind each entry).

import { h, icon, clear } from '/js/dom.js';
import * as wm from '/js/wm.js';
import * as net from '/js/net.js';
import { notify } from '/js/notify.js';
import { onEvent, worker } from '/js/store.js';
import { beeAvatar } from '/js/bees.js';
import { diffView } from '/js/diff.js';
import { fmtDateTime, fmtTime } from '/js/i18n.js';
import { track } from '/js/widgets/util.js';
import { T, strings } from '/github/t.js';
import { renderMarkdown } from './markdown.js';

const V = window.V;
const cl = V.reactive({ v: 0, tab: 'changelog', content: null, exists: false, current: null, proposals: [], error: null, activity: null, people: [], kinds: [], filter: { who: '', kind: '', q: '' }, detail: null });

if (!document.querySelector('link[href="/changelog/changelog.css"]')) document.head.append(h('link', { rel: 'stylesheet', href: '/changelog/changelog.css' }));

export function showTab(tab) {
  if (tab === 'changelog' || tab === 'activity') cl.tab = tab;
  if (cl.tab === 'activity') loadActivity();
  cl.v++;
}

async function loadChangelog() {
  try {
    const [r, p] = await Promise.all([net.command('changelog.read'), net.command('changelog.proposals')]);
    Object.assign(cl, { content: r.content, exists: r.exists, current: r.current, proposals: p.proposals, error: null });
  } catch (err) { cl.error = err.message; }
  cl.v++;
}

async function loadActivity() {
  try {
    const f = cl.filter;
    const r = await net.command('activity.list', { ...(f.who ? { who: f.who } : {}), ...(f.kind ? { kind: f.kind } : {}), ...(f.q ? { q: f.q } : {}), limit: 400 });
    Object.assign(cl, { activity: r.entries, total: r.total, people: r.people, kinds: r.kinds, error: null });
  } catch (err) { cl.error = err.message; }
  cl.v++;
}

let timer = null;
onEvent((ev) => {
  if (!wm.get('changelog')) return;
  clearTimeout(timer);
  timer = setTimeout(() => {
    if (ev.type.startsWith('changelog.') || (ev.type === 'file.changed' && ev.data?.path === 'CHANGELOG.md')) loadChangelog();
    if (cl.tab === 'activity') loadActivity();
  }, 300);
});
onEvent((ev) => {
  if (ev.type !== 'changelog.proposed') return;
  const s = ev.data?.suggestion;
  notify({ title: T('changelog.proposed.title'), body: s ? T('changelog.proposed.body', { version: s.version, bump: T(`changelog.bump.${s.bump}`) }) : '', worker: worker('mel'), tone: 'info', timeout: 12000, actions: [{ label: T('changelog.proposed.review'), primary: true, run: () => { wm.open('changelog'); showTab('changelog'); loadChangelog(); } }] });
});

wm.register('changelog', {
  title: () => T('changelog.title'),
  glyph: () => icon('tag'),
  size: [620, 620],
  min: [320, 280],
  cardH: 560,
  create(ctx) {
    const tabs = h('div', { class: 'gh-tabs', role: 'tablist', 'aria-label': T('changelog.title') });
    const pane = h('div', { class: 'pane pane-pad cl-pane', role: 'tabpanel' });
    ctx.body.append(tabs, pane);
    loadChangelog();
    if (cl.tab === 'activity') loadActivity();
    track(() => [cl.v, strings.v], () => {
      tabs.replaceChildren(...['changelog', 'activity'].map((k) => h('button', { type: 'button', role: 'tab', class: 'gh-tab', 'aria-selected': String(cl.tab === k), text: T(`changelog.tab.${k}`), on: { click: () => showTab(k) } })));
      clear(pane);
      if (cl.error) pane.append(h('div', { class: 'gh-banner bad', role: 'alert' }, h('strong', { text: T('github.err.title') }), h('p', { text: cl.error })));
      pane.append(cl.tab === 'changelog' ? changelogView() : activityView());
    });
  }
});

/* ---------- CHANGELOG.md ---------- */

function proposalCard(p) {
  const ta = h('textarea', { class: 'field-ta cl-ta', rows: 8, spellcheck: true, value: p.markdown, 'aria-label': T('changelog.edit.label') });
  const release = h('input', { type: 'checkbox', checked: true, id: `cl-rel-${p.proposalId}` });
  const version = h('input', { class: 'field-in cl-ver', type: 'text', value: p.suggestion.version, 'aria-label': T('changelog.version'), spellcheck: false });
  release.addEventListener('change', () => { version.disabled = !release.checked; });
  const write = h('button', { type: 'button', class: 'btn btn-sm btn-primary', text: T('changelog.write') });
  write.addEventListener('click', async () => {
    write.disabled = true;
    try {
      await net.command('changelog.write', { proposalId: p.proposalId, markdown: ta.value, release: release.checked, version: version.value.trim() });
      notify({ title: T('changelog.written'), body: release.checked ? version.value.trim() : T('changelog.unreleased'), tone: 'ok', icon: 'tag', actions: [{ label: T('github.act.commit'), primary: true, run: () => import('/github/index.js').then((m) => m.planAndRun('commit')) }] });
      loadChangelog();
    } catch (err) { notify({ title: T('github.err.title'), body: err.message, tone: 'bad', sticky: true }); } finally { write.disabled = false; }
  });
  return h('section', { class: 'gh-card cl-prop' },
    h('div', { class: 'row' }, beeAvatar(worker('mel'), 28, { ring: true }), h('div', { class: 'grow' }, h('h3', { text: T('changelog.proposal.title') }), h('div', { class: 'tiny muted ellipsis', text: p.request }))),
    h('p', { class: 'tiny muted', text: p.by === 'mel' ? T('changelog.proposal.byMel') : T('changelog.proposal.byReport') }),
    ta,
    h('div', { class: 'cl-bump' },
      h('span', { class: `hchip ${p.suggestion.bump === 'major' ? 'hchip-bad' : p.suggestion.bump === 'minor' ? 'hchip-honey' : 'hchip-ok'}`, text: T(`changelog.bump.${p.suggestion.bump}`) }),
      h('span', { class: 'tiny', text: T('changelog.bump.line', { current: p.suggestion.current || T('changelog.noVersion'), version: p.suggestion.version }) }),
      h('p', { class: 'tiny muted', text: p.suggestion.reason })),
    h('div', { class: 'row gh-wrap' },
      h('label', { class: 'row tiny', for: `cl-rel-${p.proposalId}` }, release, T('changelog.release')), version,
      h('span', { class: 'grow' }),
      h('button', { type: 'button', class: 'btn btn-sm btn-quiet', text: T('changelog.dismiss'), on: { click: async () => { await net.command('changelog.dismiss', { proposalId: p.proposalId }).catch(() => {}); loadChangelog(); } } }),
      write),
    h('p', { class: 'tiny faint', text: T('changelog.proposal.note') }));
}

function changelogView() {
  const box = h('div', { class: 'gh-stack' });
  for (const p of cl.proposals || []) box.append(proposalCard(p));
  const bar = h('div', { class: 'row' },
    h('span', { class: 'grow tiny muted', text: cl.current?.version ? T('changelog.currentVersion', { version: cl.current.version, from: cl.current.from }) : T('changelog.noVersion') }),
    h('button', { type: 'button', class: 'btn btn-xs btn-quiet', text: T('changelog.propose'), on: { click: async () => {
      try { await net.command('changelog.propose', {}, { timeout: 120000 }); loadChangelog(); } catch (err) { notify({ title: T('github.err.title'), body: err.message, tone: 'bad' }); }
    } } }));
  box.append(bar);
  if (cl.content == null) box.append(h('p', { class: 'muted', text: T('github.loading') }));
  else if (!cl.exists) box.append(h('div', { class: 'state' }, h('div', { class: 'hexi' }, icon('tag')), h('h3', { text: T('changelog.empty.title') }), h('p', { text: T('changelog.empty.text') })));
  else box.append(h('article', { class: 'cl-md', html: renderMarkdown(cl.content) }));
  return box;
}

/* ---------- activity ---------- */

const KIND_ICON = { file: 'code', chat: 'chat', job: 'plan', task: 'check', approval: 'approval', git: 'github', changelog: 'tag', crew: 'hire', run: 'terminal' };

/** "opened pull request" -> changelog.action.openedPullRequest, or the English words. */
function actionLabel(action) {
  const key = `changelog.action.${String(action).replace(/\s+(\w)/g, (m, c) => c.toUpperCase())}`;
  const v = T(key);
  return v === key ? action : v;
}

function whoBadge(who) {
  if (who.kind === 'worker') return beeAvatar(worker(who.id), 22, { ring: false });
  return h('span', { class: `cl-who ${who.kind}`, text: (who.name || '?').slice(0, 1).toUpperCase(), 'aria-hidden': 'true' });
}

function activityView() {
  const box = h('div', { class: 'gh-stack' });
  const f = cl.filter;
  const who = h('select', { class: 'field-sel', 'aria-label': T('changelog.filter.who') },
    h('option', { value: '', text: T('changelog.filter.everyone') }),
    h('option', { value: 'humans', text: T('changelog.filter.humans'), selected: f.who === 'humans' }),
    h('option', { value: 'workers', text: T('changelog.filter.workers'), selected: f.who === 'workers' }),
    (cl.people || []).map((p) => h('option', { value: p.id, selected: f.who === p.id, text: p.kind === 'guest' ? T('changelog.guest', { name: p.name }) : p.name })));
  const kind = h('select', { class: 'field-sel', 'aria-label': T('changelog.filter.kind') },
    h('option', { value: '', text: T('changelog.filter.allKinds') }),
    (cl.kinds || []).map((k) => h('option', { value: k, selected: f.kind === k, text: T(`changelog.kind.${k}`) })));
  const q = h('input', { class: 'field-in', type: 'search', value: f.q, placeholder: T('changelog.filter.search'), 'aria-label': T('changelog.filter.search') });
  let t = null;
  who.addEventListener('change', () => { f.who = who.value; loadActivity(); });
  kind.addEventListener('change', () => { f.kind = kind.value; loadActivity(); });
  q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { f.q = q.value.trim(); loadActivity().then(() => document.querySelector('.cl-pane input[type=search]')?.focus()); }, 300); });
  const exp = (format) => h('button', { type: 'button', class: 'btn btn-xs btn-quiet', text: T(`changelog.export.${format}`), on: { click: () => exportAs(format) } });
  box.append(h('div', { class: 'row gh-wrap cl-filters' }, who, kind, q), h('div', { class: 'row gh-wrap' }, h('span', { class: 'grow tiny muted', text: cl.activity ? T('changelog.count', { count: cl.total ?? cl.activity.length }) : '' }), h('span', { class: 'tiny faint', text: T('changelog.export.label') }), exp('csv'), exp('json'), exp('md')));
  if (cl.detail) box.append(detailView(cl.detail));
  if (!cl.activity) { box.append(h('p', { class: 'muted', text: T('github.loading') })); loadActivity(); return box; }
  if (!cl.activity.length) { box.append(h('p', { class: 'muted', text: T('changelog.activity.empty') })); return box; }
  box.append(h('ol', { class: 'cl-list' }, cl.activity.map((e) => {
    const clickable = e.kind === 'file' || e.url;
    const row = h(clickable ? 'button' : 'div', { class: 'cl-row', type: clickable ? 'button' : undefined, title: fmtDateTime(e.ts) },
      whoBadge(e.who),
      h('span', { class: 'cl-name', text: e.who.kind === 'guest' ? T('changelog.guest', { name: e.who.name }) : e.who.name }),
      h('span', { class: 'cl-act' }, icon(KIND_ICON[e.kind] || 'hive', 'ico-sm'), actionLabel(e.action)),
      h('span', { class: 'cl-text ellipsis', text: e.text }),
      e.kind === 'file' ? h('span', { class: 'tiny faint', text: `+${e.added} -${e.removed}` }) : null,
      h('time', { class: 'tiny faint', datetime: e.ts, text: fmtTime(e.ts) }));
    if (e.kind === 'file') row.addEventListener('click', () => openDetail(e));
    else if (e.url) row.addEventListener('click', () => window.open(e.url, '_blank', 'noopener'));
    return h('li', {}, row);
  })));
  return box;
}

async function openDetail(e) {
  try { cl.detail = { entry: e, ...(await net.command('activity.detail', { seq: e.seq })) }; } catch (err) { cl.detail = { entry: e, error: err.message }; }
  cl.v++;
  requestAnimationFrame(() => document.querySelector('.cl-detail')?.scrollIntoView({ block: 'nearest' }));
}

function detailView(d) {
  const e = d.entry;
  return h('section', { class: 'gh-card cl-detail', 'aria-label': T('changelog.detail.title') },
    h('div', { class: 'row' },
      h('h3', { class: 'grow ellipsis', text: `${e.who.kind === 'guest' ? T('changelog.guest', { name: e.who.name }) : e.who.name}: ${e.path}` }),
      d.exists ? h('button', { type: 'button', class: 'btn btn-xs btn-quiet', text: T('changelog.detail.open'), on: { click: () => wm.open('code', e.path) } }) : h('span', { class: 'tiny faint', text: T('changelog.detail.gone') }),
      h('button', { type: 'button', class: 'ibtn ibtn-sm', 'aria-label': T('changelog.detail.close'), on: { click: () => { cl.detail = null; cl.v++; } } }, icon('x', 'ico-sm'))),
    h('div', { class: 'tiny muted', text: fmtDateTime(e.ts) }),
    d.error ? h('p', { class: 'gh-warn-t', text: d.error }) : diffView(d.diff, d.op === 'create' && !d.diff ? d.content : undefined));
}

async function exportAs(format) {
  const f = cl.filter;
  const params = new URLSearchParams({ format, ...(f.who ? { who: f.who } : {}), ...(f.kind ? { kind: f.kind } : {}), ...(f.q ? { q: f.q } : {}) });
  try {
    const r = await fetch(net.withToken(`/api/activity/export?${params}`), { cache: 'no-store' });
    if (!r.ok) throw new Error(`${r.status}`);
    const blob = await r.blob();
    const name = /filename="([^"]+)"/.exec(r.headers.get('content-disposition') || '')?.[1] || `hivedesk-activity.${format}`;
    const a = h('a', { href: URL.createObjectURL(blob), download: name });
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  } catch (err) { notify({ title: T('changelog.export.failed'), body: err.message, tone: 'bad' }); }
}
