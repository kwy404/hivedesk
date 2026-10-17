// GitHub in the Hive: the GitHub window, the confirmation card, Ctrl K commands and
// runIntent(text, { confirm }) for the palette, the chat and voice. Importing this module
// registers everything (the GitHub window, the Changelog window and the dock buttons).
//
//   import { runIntent } from '/github/index.js';
//   const r = await runIntent('crie um repositorio privado chamado loja');   // shows the card
//   const r = await runIntent('commit and push', { confirm: async (plan) => askByVoice(plan) });
//
// confirm(plan) may resolve to true / false, or to { yes, edits }. Anything but an explicit
// yes runs nothing. Without confirm, the card is shown.

import { h, icon, clear } from '/js/dom.js';
import * as wm from '/js/wm.js';
import * as net from '/js/net.js';
import { notify } from '/js/notify.js';
import { onEvent } from '/js/store.js';
import { track } from '/js/widgets/util.js';
import { T, strings, initStrings } from './t.js';
import { confirmCard, stepLabel } from './confirm.js';
import '/changelog/index.js';

export { confirmCard, stepLabel };

const V = window.V;
const LONG = { timeout: 180_000 };
export const gh = V.reactive({ v: 0, status: null, loading: false, error: null, repos: null, reposQuery: '', reposError: null, pending: null, device: null, prs: {} });

function linkCss(href) {
  if (document.querySelector(`link[href="${href}"]`)) return;
  document.head.append(h('link', { rel: 'stylesheet', href }));
}
linkCss('/github/github.css');
initStrings();

const errText = (err) => String(err?.message || err || T('github.err.generic'));

export async function refresh() {
  gh.loading = true;
  try { gh.status = await net.command('github.status', {}, LONG); gh.error = null; } catch (err) { gh.error = errText(err); }
  gh.loading = false;
  gh.v++;
}

/** Shows what a result means and opens the window it points to. */
function afterRun(result) {
  if (!result) return;
  if (result.open === 'changelog') { wm.open('changelog'); import('/changelog/index.js').then((m) => m.showTab?.(result.tab)); return; }
  if (result.open === 'github') { wm.open('github'); showSection(result.section, result.query); return; }
  const links = [];
  if (result.pr?.url) links.push({ label: T('github.done.openPr'), primary: true, run: () => window.open(result.pr.url, '_blank', 'noopener') });
  else if (result.url) links.push({ label: T('github.done.openRepo'), primary: true, run: () => window.open(result.url, '_blank', 'noopener') });
  const body = result.pr ? `#${result.pr.number} ${result.pr.title}` : result.pushed ? T('github.done.pushed', { branch: result.pushed }) : result.sha ? T('github.done.committed', { sha: result.sha.slice(0, 7), count: result.files }) : result.repo || '';
  notify({ title: T('github.done.title'), body, tone: 'ok', icon: 'github', actions: links, timeout: 9000 });
  refresh();
}

function failed(err) {
  notify({ title: T('github.err.title'), body: errText(err), tone: 'bad', icon: 'github', sticky: true, actions: [{ label: T('github.open'), run: () => wm.open('github') }] });
}

/** Asks with the card (or the given confirm), then runs the confirmed plan. */
export async function confirmAndRun(plan, { confirm, text } = {}) {
  let answer;
  try { answer = confirm ? await confirm(plan) : await confirmCard(plan, { text }); } catch { answer = false; }
  const yes = answer === true || (answer && typeof answer === 'object' && answer.yes === true);
  const edits = answer && typeof answer === 'object' ? answer.edits || {} : {};
  if (!yes) { net.command('github.cancel', { planId: plan.id }).catch(() => {}); return { ok: true, ran: false, plan }; }
  try {
    const result = await net.command('github.confirm', { planId: plan.id, edits }, LONG);
    afterRun(result);
    return { ok: true, ran: true, plan, result };
  } catch (err) {
    failed(err);
    return { ok: false, ran: false, plan, error: { code: err.code, message: errText(err) } };
  }
}

/**
 * Plain language to a confirmed action: "conecte meu GitHub", "faça commit e push",
 * "abra um pull request", "mostre o changelog". Nothing runs without an explicit yes.
 * @param {string} text
 * @param {{ confirm?: (plan: object) => Promise<boolean | { yes: boolean, edits?: object }>, jobId?: string }} [opts]
 */
export async function runIntent(text, opts = {}) {
  let r;
  try {
    r = await net.command('github.intent', { text: String(text || ''), ...(opts.jobId ? { jobId: opts.jobId } : {}) }, LONG);
  } catch (err) {
    if (!opts.quiet) failed(err);
    return { ok: false, ran: false, error: { code: err.code, message: errText(err) } };
  }
  if (!r.plan) {
    if (!opts.quiet) notify({ title: T('github.err.notUnderstood'), body: T('github.err.tryThese'), tone: 'info', icon: 'github', timeout: 7000 });
    return { ok: false, ran: false, parsed: r.parsed, message: r.message };
  }
  return { parsed: r.parsed, ...(await confirmAndRun(r.plan, { confirm: opts.confirm, text })) };
}

/** Plans one action from a button (same card as runIntent). */
export async function planAndRun(intent, data = {}) {
  try {
    const plan = await net.command('github.plan', { intent, ...data }, LONG);
    return confirmAndRun(plan);
  } catch (err) { failed(err); return { ok: false, ran: false }; }
}

/* ---------- live frames: a GitHub request typed in the chat ---------- */
net.on('live', (f) => {
  if (f.type === 'github.plan' && f.data?.plan) confirmAndRun(f.data.plan, { text: f.data.text });
  if (f.type === 'github.device') { gh.device = { ...(gh.device || {}), ...f.data }; if (f.data.state === 'connected') refresh(); gh.v++; }
});
onEvent((ev) => {
  if (/^github\./.test(ev.type) || (ev.type === 'file.changed' && gh.status)) { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 400); }
});
let refreshTimer = null;

/* ---------- Ctrl K ---------- */
const INTENT_WORDS = /\b(github|git|repo|reposit|commit|push|pull request|pr|branch|changelog|clon)/i;

/** Commands for the Ctrl K palette: [{ group, label, run, icon }]. */
export function paletteCommands(q = '') {
  const g = T('github.pal.group');
  const list = [
    { group: g, label: T('github.pal.open'), icon: 'github', run: () => wm.open('github') },
    { group: g, label: T('github.pal.connect'), icon: 'key', run: () => runIntent('connect GitHub') },
    { group: g, label: T('github.pal.commit'), icon: 'check', run: () => planAndRun('commit') },
    { group: g, label: T('github.pal.commitPush'), icon: 'arrow', run: () => planAndRun('commit_push') },
    { group: g, label: T('github.pal.pr'), icon: 'github', run: () => planAndRun('open_pr') },
    { group: g, label: T('changelog.pal.open'), icon: 'tag', run: () => runIntent('show changelog') },
    { group: g, label: T('changelog.pal.activity'), icon: 'clock', run: () => runIntent('show activity') }
  ];
  const text = String(q || '').trim();
  if (text.length > 3 && INTENT_WORDS.test(text)) list.unshift({ group: g, label: T('github.pal.ask', { text }), icon: 'sparkle', keep: true, run: () => runIntent(text) });
  return list;
}
(globalThis.hivedeskPalette ||= []).push(paletteCommands);
// For code that is not a module (the voice mode can also import runIntent from this file).
window.hivedeskGitHub = { runIntent, planAndRun, paletteCommands, confirmCard };

/* ---------- dock ---------- */
function addDock() {
  if (!document.querySelector('.dock-shelf')) { setTimeout(addDock, 300); return; }
  import('/js/dock.js').then(({ addDockItem }) => {
    addDockItem({ id: 'github', label: T('github.title'), sub: () => (gh.status?.account ? `@${gh.status.account.login}` : T('github.notConnected')), content: h('span', { class: 'dk-hex' }, icon('github')), onClick: () => wm.toggleFromDock('github') });
    addDockItem({ id: 'changelog', label: T('changelog.title'), sub: () => T('changelog.dockSub'), content: h('span', { class: 'dk-hex' }, icon('tag')), onClick: () => wm.toggleFromDock('changelog') });
  }).catch(() => {});
}
addDock();

/* ---------- the GitHub window ---------- */
let sectionFn = null;
function showSection(section, query) { sectionFn?.(section, query); }

const SECTIONS = ['account', 'repo', 'repos', 'prs'];

wm.register('github', {
  title: () => T('github.title'),
  glyph: () => icon('github'),
  size: [560, 600],
  min: [320, 280],
  cardH: 560,
  create(ctx) {
    let section = gh.status?.connected ? 'repo' : 'account';
    const tabs = h('div', { class: 'gh-tabs', role: 'tablist', 'aria-label': T('github.title') });
    const pane = h('div', { class: 'pane pane-pad gh-pane', role: 'tabpanel' });
    ctx.body.append(tabs, pane);
    sectionFn = (s, q) => { if (SECTIONS.includes(s)) section = s; if (q !== undefined) gh.reposQuery = q; if (s === 'repos') loadRepos(); gh.v++; };
    ctx.onDispose(() => { sectionFn = null; clearInterval(prTimer); });
    const prTimer = setInterval(() => { if (section === 'prs' && !document.hidden) pollPrs(); }, 30_000);
    refresh();
    track(() => [gh.v, strings.v], () => {
      const s = gh.status;
      ctx.setSub(s?.account ? `@${s.account.login}` : '');
      tabs.replaceChildren(...SECTIONS.map((k) => h('button', { type: 'button', role: 'tab', class: 'gh-tab', 'aria-selected': String(k === section), text: T(`github.tab.${k}`), on: { click: () => { section = k; if (k === 'repos' && !gh.repos) loadRepos(); if (k === 'prs') pollPrs(); gh.v++; } } })));
      clear(pane);
      if (!s) { pane.append(h('p', { class: 'muted', text: gh.error || T('github.loading') })); return; }
      if (!s.git.ok) pane.append(banner('bad', T('github.git.missing'), [s.git.message, s.git.hint].filter(Boolean).join(' ')));
      else if (s.git.hint) pane.append(banner('warn', T('github.git.old'), s.git.hint));
      if (gh.error) pane.append(banner('bad', T('github.err.title'), gh.error));
      pane.append(({ account: accountView, repo: repoView, repos: reposView, prs: prsView })[section](s));
    });
  }
});

function banner(tone, title, text) {
  return h('div', { class: `gh-banner ${tone}`, role: tone === 'bad' ? 'alert' : 'status' }, h('strong', { text: title }), text ? h('p', { text }) : null);
}

function button(label, onClick, cls = 'btn btn-sm btn-quiet', ic) {
  return h('button', { type: 'button', class: cls, on: { click: onClick } }, ic ? icon(ic, 'ico-sm') : null, label);
}

function accountView(s) {
  const box = h('div', { class: 'gh-stack' });
  if (s.account) {
    const a = s.account;
    box.append(h('div', { class: 'gh-account' },
      a.avatarUrl ? h('img', { src: a.avatarUrl, alt: '', width: 44, height: 44, referrerpolicy: 'no-referrer' }) : h('div', { class: 'gh-av' }, icon('github')),
      h('div', { class: 'grow' }, h('div', { class: 'gh-login', text: `@${a.login}` }), a.name ? h('div', { class: 'muted', text: a.name }) : null,
        h('div', { class: 'tiny faint', text: T(`github.source.${a.source}`) })),
      button(T('github.disconnect'), async () => {
        try { await net.command('github.disconnect'); refresh(); } catch (err) { failed(err); }
      }, 'btn btn-sm btn-bad')));
    box.append(h('p', { class: 'tiny muted', text: a.source === 'gh' ? T('github.stored.gh') : T('github.stored.file', { file: s.methods.token.file }) }));
    return box;
  }
  box.append(h('p', { class: 'muted', text: T('github.connect.lead') }));
  // 1. the gh command line
  const ghCard = h('section', { class: 'gh-card' }, h('h3', { text: T('github.connect.gh.title') }));
  if (!s.methods.gh.available) ghCard.append(h('p', { class: 'tiny muted', text: T('github.connect.gh.none') }));
  else if (gh.pending) {
    const p = gh.pending;
    ghCard.append(h('p', { text: T('github.connect.gh.ask', { login: p.account.login, name: p.account.name || p.account.login }) }),
      h('div', { class: 'row' },
        button(T('github.connect.gh.yes', { login: p.account.login }), async () => {
          try { await net.command('github.gh.confirm', { pendingId: p.pendingId }); gh.pending = null; refresh(); } catch (err) { failed(err); }
        }, 'btn btn-sm btn-primary'),
        button(T('github.card.no'), () => { gh.pending = null; gh.v++; })));
  } else {
    ghCard.append(h('p', { class: 'tiny muted', text: T('github.connect.gh.help') }),
      button(T('github.connect.gh.check'), async () => {
        try { gh.pending = await net.command('github.gh.check', {}, LONG); gh.v++; } catch (err) { failed(err); }
      }, 'btn btn-sm btn-quiet', 'github'));
  }
  // 2. a fine-grained token
  const input = h('input', { class: 'field-in', type: 'password', autocomplete: 'off', spellcheck: false, placeholder: 'github_pat_...', 'aria-label': T('github.connect.token.label') });
  const save = button(T('github.connect.token.save'), async () => {
    const value = input.value.trim();
    if (!value) { input.focus(); return; }
    save.disabled = true;
    try { await net.command('github.token.set', { token: value }, LONG); input.value = ''; refresh(); } catch (err) { failed(err); } finally { save.disabled = false; }
  }, 'btn btn-sm btn-primary', 'key');
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save.click(); });
  const tokenCard = h('section', { class: 'gh-card' }, h('h3', { text: T('github.connect.token.title') }),
    h('p', { class: 'tiny' }, T('github.connect.token.open'), ' ', h('a', { href: s.methods.token.page, target: '_blank', rel: 'noopener noreferrer', text: s.methods.token.page })),
    h('p', { class: 'tiny muted', text: T('github.connect.token.choose') }),
    h('ul', { class: 'gh-perms' }, s.methods.token.permissions.map((p) => h('li', { text: T(`github.perm.${p.id}`) === `github.perm.${p.id}` ? p.label : T(`github.perm.${p.id}`) }))),
    h('div', { class: 'row' }, input, save),
    h('p', { class: 'tiny faint', text: T('github.connect.token.where', { file: s.methods.token.file }) }));
  // 3. the device flow
  const devCard = h('section', { class: 'gh-card' }, h('h3', { text: T('github.connect.device.title') }));
  if (!s.methods.device.available) devCard.append(h('p', { class: 'tiny muted', text: T('github.connect.device.off', { file: s.methods.device.configFile }) }));
  else if (gh.device?.state === 'waiting') {
    devCard.append(h('p', { text: T('github.connect.device.enter') }), h('div', { class: 'gh-code', text: gh.device.userCode }),
      h('p', {}, h('a', { href: gh.device.verificationUri, target: '_blank', rel: 'noopener noreferrer', text: gh.device.verificationUri })),
      button(T('github.card.no'), () => { net.command('github.device.cancel').catch(() => {}); gh.device = null; gh.v++; }));
  } else {
    if (gh.device?.state === 'failed') devCard.append(h('p', { class: 'gh-warn-t', text: gh.device.message }));
    devCard.append(button(T('github.connect.device.start'), async () => {
      try { gh.device = { state: 'waiting', ...(await net.command('github.device.start', {}, LONG)) }; gh.v++; } catch (err) { failed(err); }
    }, 'btn btn-sm btn-quiet'));
  }
  box.append(ghCard, tokenCard, devCard);
  return box;
}

function repoView(s) {
  const box = h('div', { class: 'gh-stack' });
  const r = s.repo;
  if (!s.git.ok) return box;
  if (!r?.isRepo) {
    box.append(h('p', { class: 'muted', text: T('github.repo.none', { count: r?.files ?? 0 }) }));
  } else {
    const dl = h('dl', { class: 'gh-dl' },
      h('dt', { text: T('github.fact.branch') }), h('dd', {}, h('code', { text: r.branch || T('github.repo.detached') })),
      h('dt', { text: T('github.fact.remote') }), h('dd', {}, h('code', { text: r.origin || T('github.repo.noRemote') })),
      h('dt', { text: T('github.repo.changes') }), h('dd', { text: T('github.card.fileCount', { count: r.changes.length }) }),
      h('dt', { text: T('github.repo.ahead') }), h('dd', { text: r.ahead == null ? T('github.repo.aheadUnknown') : String(r.ahead) }));
    box.append(dl);
    if (r.changes.length) box.append(h('details', { class: 'ghc-files' }, h('summary', { text: T('github.repo.changedFiles') }), h('ul', {}, r.changes.slice(0, 200).map((x) => h('li', {}, h('code', { text: x.path }), ' ', h('span', { class: 'faint', text: T(`github.status.${x.status}`) }))))));
  }
  box.append(h('div', { class: 'gh-actions' },
    button(T('github.act.commit'), () => planAndRun('commit'), 'btn btn-sm btn-quiet', 'check'),
    button(T('github.act.commitPush'), () => planAndRun('commit_push'), 'btn btn-sm btn-primary', 'arrow'),
    button(T('github.act.push'), () => planAndRun('push'), 'btn btn-sm btn-quiet'),
    button(T('github.act.pr'), () => planAndRun('open_pr'), 'btn btn-sm btn-quiet', 'github'),
    button(T('github.act.branch'), () => planAndRun('branch'), 'btn btn-sm btn-quiet')));
  box.append(h('p', { class: 'tiny muted', text: T('github.repo.jobBranch') }));
  if (s.account) {
    const name = h('input', { class: 'field-in', type: 'text', maxlength: 100, spellcheck: false, placeholder: T('github.card.namePlaceholder'), 'aria-label': T('github.fact.name') });
    const vis = h('select', { class: 'field-sel', 'aria-label': T('github.fact.visibility') }, h('option', { value: 'private', text: T('github.vis.private') }), h('option', { value: 'public', text: T('github.vis.public') }));
    box.append(h('section', { class: 'gh-card' }, h('h3', { text: T('github.create.title') }), h('p', { class: 'tiny muted', text: T('github.create.help') }),
      h('div', { class: 'row gh-wrap' }, name, vis, button(T('github.create.go'), () => planAndRun('create_repo', { name: name.value.trim(), private: vis.value === 'private' }), 'btn btn-sm btn-quiet'))));
  } else {
    box.append(h('p', { class: 'tiny muted' }, T('github.repo.connectFirst'), ' ', h('button', { type: 'button', class: 'linkish', text: T('github.tab.account'), on: { click: () => showSection('account') } })));
  }
  return box;
}

async function loadRepos() {
  gh.reposError = null;
  try { gh.repos = (await net.command('github.repos', { query: gh.reposQuery }, LONG)).repos; } catch (err) { gh.repos = []; gh.reposError = errText(err); }
  gh.v++;
}

function reposView(s) {
  const box = h('div', { class: 'gh-stack' });
  if (!s.account) { box.append(h('p', { class: 'muted', text: T('github.repo.connectFirst') })); return box; }
  const search = h('input', { class: 'field-in', type: 'search', value: gh.reposQuery, placeholder: T('github.repos.search'), 'aria-label': T('github.repos.search') });
  let timer = null;
  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { gh.reposQuery = search.value; loadRepos().then(() => document.querySelector('.gh-pane input[type=search]')?.focus()); }, 300); });
  box.append(search);
  if (gh.reposError) box.append(banner('bad', T('github.err.title'), gh.reposError));
  if (!gh.repos) { box.append(h('p', { class: 'muted', text: T('github.loading') })); return box; }
  if (!gh.repos.length) { box.append(h('p', { class: 'muted', text: T('github.repos.empty') })); return box; }
  const emptyWs = !s.repo?.isRepo && !(s.repo?.files > 0);
  box.append(h('ul', { class: 'gh-repos' }, gh.repos.map((r) => h('li', {},
    h('div', { class: 'grow' },
      h('div', { class: 'row' }, h('a', { href: r.htmlUrl, target: '_blank', rel: 'noopener noreferrer', text: r.fullName }), h('span', { class: `hchip ${r.private ? 'hchip-warn' : ''}`, text: T(`github.vis.${r.private ? 'private' : 'public'}`) })),
      r.description ? h('div', { class: 'tiny muted ellipsis', text: r.description }) : null),
    button(T('github.repos.clone'), () => planAndRun('clone', { repo: r.fullName }), 'btn btn-xs btn-quiet', null)))));
  if (!emptyWs) box.append(h('p', { class: 'tiny faint', text: T('github.repos.cloneNeedsEmpty') }));
  return box;
}

async function pollPrs() {
  const list = gh.status?.prs || [];
  for (const p of list.slice(0, 5)) {
    try { gh.prs[`${p.repo}#${p.number}`] = (await net.command('github.pr.status', { repo: p.repo, number: p.number }, LONG)).pr; } catch (err) { gh.prs[`${p.repo}#${p.number}`] = { error: errText(err) }; }
  }
  gh.v++;
}

const CI_CHIP = { success: 'hchip-ok', failure: 'hchip-bad', pending: 'hchip-honey', none: '', unknown: '' };

function prsView(s) {
  const box = h('div', { class: 'gh-stack' });
  const list = s.prs || [];
  if (!list.length) { box.append(h('p', { class: 'muted', text: T('github.prs.empty') })); return box; }
  box.append(h('div', { class: 'row' }, h('span', { class: 'grow tiny muted', text: T('github.prs.auto') }), button(T('github.prs.refresh'), () => pollPrs(), 'btn btn-xs btn-quiet', 'replay')));
  box.append(h('ul', { class: 'gh-repos' }, list.map((p) => {
    const st = gh.prs[`${p.repo}#${p.number}`];
    const ci = st?.ci;
    return h('li', { class: 'gh-pr' },
      h('div', { class: 'grow' },
        h('div', { class: 'row' }, h('a', { href: p.url, target: '_blank', rel: 'noopener noreferrer', text: `#${p.number} ${p.title}` })),
        h('div', { class: 'tiny muted', text: T('github.prs.into', { repo: p.repo, head: p.head, base: p.base }) }),
        st?.error ? h('div', { class: 'tiny gh-warn-t', text: st.error }) : null,
        ci?.checks?.length ? h('ul', { class: 'gh-checks' }, ci.checks.map((c) => h('li', {}, h('span', { class: `dot ${c.conclusion === 'success' ? 'ok' : c.conclusion ? 'bad' : 'run'}` }), c.url ? h('a', { href: c.url, target: '_blank', rel: 'noopener noreferrer', text: c.name }) : c.name))) : null),
      h('div', { class: 'gh-pr-st' },
        st?.state ? h('span', { class: 'hchip', text: T(`github.pr.${st.state}`) }) : null,
        h('span', { class: `hchip ${CI_CHIP[ci?.state] || ''}`, text: T(`github.ci.${ci?.state || 'unknown'}`) })));
  })));
  if (!Object.keys(gh.prs).length) pollPrs();
  return box;
}
