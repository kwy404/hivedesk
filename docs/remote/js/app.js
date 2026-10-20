// hivedesk remote, the phone page. Scanning the QR code opens this page with a one time invite in
// the URL fragment; the page removes it from the address bar at once, makes (or loads) this phone's
// key in IndexedDB, meets the desktop window on the public relays, opens a WebRTC data channel and
// runs the handshake. After the Accept on the computer it shows what the grants allow. Every command
// is checked again on the computer; this page only renders and asks.

import { h, icon, mark, clear } from './dom.js';
import { t, init as initI18n, setLocale, LOCALES, locale, ago, clock } from './i18n.js';
import * as store from './store.js';
import { readInviteHash, deriveInvite, homeTopic, homeSeal } from './vendor/phone/core/invite.js';
import { PhoneClient } from './vendor/phone/core/client.js';
import { cleanName } from './vendor/phone/core/handshake.js';
import { dial, rendezvousOf } from './vendor/phone/core/connect.js';
import { mdStrip, mdLine } from './vendor/js/md.js';

if (window.top !== window.self) throw new Error('hivedesk remote does not run inside a frame');

const app = document.getElementById('app');
const S = {
  screen: 'boot', tab: 'status', client: null, pairing: null, me: null, grants: [], state: null, feed: [], chat: null,
  channel: 'general', mode: 'request', notify: false, host: null, conn: 'off', toasts: null, viewer: null
};
const has = (g) => S.grants.includes(g);
// The names on screen: the computer's (from the desktop) and this phone's (chosen when pairing), never empty.
const hostName = (pairing = S.pairing) => cleanName(S.host?.name || pairing?.host?.name, 'hivedesk');
const phoneName = () => cleanName(S.pairing?.name);
const live = (el) => el && el.setAttribute('aria-live', 'polite');

// ---------------------------------------------------------------- toasts

function toast(text, tone = '', ms = 3500) {
  if (!S.toasts) { S.toasts = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }); document.body.append(S.toasts); }
  const el = h('div', { class: `toast ${tone}` }, icon(tone === 'bad' ? 'alert' : tone === 'ok' ? 'check' : 'bell'), h('span', { class: 'grow', text }));
  S.toasts.append(el);
  setTimeout(() => el.remove(), ms);
}

const errText = (err) => t(`err.${err?.code}`) !== `err.${err?.code}` ? t(`err.${err.code}`) : t('err.generic', { message: err?.message || String(err) });

// ---------------------------------------------------------------- full screen states

function screen(...children) {
  clear(app);
  S.screen = 'full';
  const el = h('main', { class: 'screen', tabindex: '-1' }, ...children);
  app.append(h('div', { class: 'sky', 'aria-hidden': 'true' }), el);
  el.focus({ preventScroll: true });
  return el;
}

function welcome() {
  screen(
    h('div', { class: 'brand' }, mark(), h('span', { text: 'hivedesk' })),
    mark('hero-mark'),
    h('h1', { text: t('welcome.title') }),
    h('p', { text: t('welcome.body') }),
    h('ol', { class: 'steps' }, h('li', { text: t('welcome.step1') }), h('li', { text: t('welcome.step2') }), h('li', { text: t('welcome.step3') })),
    h('div', { class: 'note' }, icon('lock'), h('span', { text: t('welcome.private') })),
    h('div', { class: 'spacer' }),
    langPicker()
  );
}

function failure({ title, body, tone = 'bad', actions = [] }) {
  screen(
    h('div', { class: `err-ico ${tone === 'warn' ? 'warn' : ''}` }, icon(tone === 'warn' ? 'phone' : 'alert')),
    h('h1', { text: title }),
    h('p', { text: body }),
    h('div', { class: 'spacer' }),
    h('div', { class: 'stack' }, ...actions)
  );
}

function progress(steps, now) {
  return h('ol', { class: 'progress', 'aria-live': 'polite' }, ...steps.map((s, i) => h('li', { class: i < now ? 'done' : i === now ? 'now' : '' }, h('span', { class: 'dot', 'aria-hidden': 'true' }), h('span', { text: t(s) }))));
}

const defaultName = () => {
  const ua = navigator.userAgent || '';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  const m = /Android [\d.]+; ([^;)]+?)(?: Build|\))/.exec(ua);
  if (m && !/^K$/.test(m[1])) return m[1].trim().slice(0, 40);
  if (/Android/.test(ua)) return t('pair.androidName');
  return t('pair.phoneName');
};

// ---------------------------------------------------------------- pairing

async function pairScreen(invite) {
  const name = h('input', { class: 'input', id: 'pname', value: defaultName(), maxLength: 40, autocomplete: 'off', enterkeyhint: 'go' });
  const go = h('button', { class: 'btn btn-honey btn-wide', type: 'button', 'data-pair': '1', text: t('pair.go') });
  const el = screen(
    h('div', { class: 'brand' }, mark(), h('span', { text: 'hivedesk' })),
    h('h1', { text: t('pair.title') }),
    h('p', { text: t('pair.body') }),
    h('div', { class: 'field' }, h('label', { for: 'pname', text: t('pair.name') }), name),
    h('div', { class: 'note' }, icon('lock'), h('span', { text: t('pair.private') })),
    h('div', { class: 'spacer' }),
    go
  );
  const start = () => { go.disabled = true; runPair(invite, name.value.trim() || defaultName()); };
  go.addEventListener('click', start);
  name.addEventListener('keydown', (e) => e.key === 'Enter' && start());
  void el;
}

async function runPair(invite, name) {
  const steps = ['pair.step.relays', 'pair.step.link', 'pair.step.keys', 'pair.step.words'];
  const box = h('div');
  const show = (n) => box.replaceChildren(progress(steps, n));
  screen(h('div', { class: 'brand' }, mark(), h('span', { text: 'hivedesk' })), h('h1', { text: t('pair.connecting') }), box);
  show(0);
  try {
    const me = await store.identity();
    await store.persist();
    const d = await deriveInvite(invite.secret);
    const rv = await rendezvousOf(d.topic, d.seal);
    const link = await dial(rv, { onStatus: (s) => show(s === 'connecting' ? 1 : 0) });
    show(2);
    const client = new PhoneClient({ identity: me.signer, deviceId: me.deviceId, name });
    adopt(client);
    const r = await client.pair(link, { topicId: d.topicId, psk: d.psk, pin: invite.pin });
    invite.secret.fill(0);
    sasScreen(r);
    const decision = await r.decision;
    if (!decision.accepted) {
      return failure({ title: t('pair.refused.title'), body: t(decision.reason === 'sas_mismatch' ? 'pair.refused.mismatch' : 'pair.refused.body'), actions: [h('button', { class: 'btn btn-ghost', type: 'button', text: t('action.close'), on: { click: welcome } })] });
    }
    const pairing = { deviceId: me.deviceId, name: cleanName(name), host: { key: r.host.key, pin: invite.pin, name: r.host.name, peerId: r.host.peerId }, reconnect: r.reconnect, pairedAt: new Date().toISOString() };
    await store.savePairing(pairing);
    S.pairing = pairing;
    S.grants = decision.grants;
    if (client.welcome && S.screen !== 'shell') { shell(); setConn('on'); render(); }
    toast(t('pair.done', { host: r.host.name }), 'ok');
  } catch (err) {
    pairFailed(err);
  }
}

function pairFailed(err) {
  const code = err?.code;
  const map = { expired: 'expired', used: 'used', unknown: 'used', no_desktop: 'nodesk', relays: 'relays', pin: 'pin', bad_secret: 'bad', bad: 'bad', busy: 'busy' };
  const k = map[code] || 'generic';
  failure({
    title: t(`fail.${k}.title`),
    body: k === 'generic' ? errText(err) : t(`fail.${k}.body`),
    tone: k === 'nodesk' || k === 'relays' ? 'warn' : 'bad',
    actions: [h('button', { class: 'btn btn-ghost', type: 'button', text: t('action.close'), on: { click: welcome } })]
  });
}

function sasScreen(r) {
  screen(
    h('div', { class: 'brand' }, mark(), h('span', { text: r.host.name })),
    h('h1', { text: t('sas.title') }),
    h('p', { text: t('sas.body', { host: r.host.name }) }),
    h('ol', { class: 'sas', 'aria-label': t('sas.title'), 'data-sas': r.sas.join(' ') }, ...r.sas.map((w) => h('li', { text: w }))),
    h('div', { class: 'note warn' }, icon('alert'), h('span', { text: t('sas.warn') })),
    h('div', { class: 'spacer' }),
    progress(['sas.waiting'], 0)
  );
}

// ---------------------------------------------------------------- known phone

let retryTimer = null;
async function reconnect(pairing, attempt = 0) {
  clearTimeout(retryTimer);
  S.pairing = pairing;
  if (S.screen !== 'shell') {
    const box = h('div');
    screen(h('div', { class: 'brand' }, mark(), h('span', { text: hostName(pairing) })), h('h1', { text: t('connect.title', { host: hostName(pairing) }) }), box);
    box.replaceChildren(progress(['pair.step.relays', 'pair.step.link', 'pair.step.keys'], 0));
  } else setConn('wait');
  try {
    const me = await store.identity();
    const rv = await rendezvousOf(await homeTopic(pairing.host.key), await homeSeal(pairing.reconnect));
    const link = await dial(rv, { joinTimeout: 30_000 });
    const client = new PhoneClient({ identity: me.signer, deviceId: me.deviceId, name: pairing.name });
    adopt(client);
    await client.reconnect(link, { host: { key: pairing.host.key, pin: pairing.host.pin }, reconnect: pairing.reconnect });
  } catch (err) {
    if (err?.code === 'unknown_phone') {
      await store.del('pairing');
      return failure({ title: t('fail.removed.title'), body: t('fail.removed.body'), actions: [h('button', { class: 'btn btn-ghost', type: 'button', text: t('action.close'), on: { click: welcome } })] });
    }
    if (S.screen === 'shell') { setConn('off'); retryTimer = setTimeout(() => reconnect(pairing, attempt + 1), Math.min(30_000, 3000 * 2 ** attempt)); return; }
    failure({
      title: t('fail.nodesk.title'), body: t('fail.nodesk.body'), tone: 'warn',
      actions: [
        h('button', { class: 'btn btn-honey', type: 'button', text: t('action.retry'), on: { click: () => reconnect(pairing) } }),
        h('button', { class: 'btn btn-ghost', type: 'button', text: t('settings.forget'), on: { click: forgetComputer } })
      ]
    });
  }
}

// ---------------------------------------------------------------- the session

function adopt(client) {
  S.client = client;
  client.on('welcome', (w) => {
    S.grants = w.grants;
    S.host = w.host;
    S.expiresAt = w.expiresAt;
    if (S.screen !== 'shell') shell();
    setConn('on');
    render();
    if (has('phone.status')) client.cmd('state.get').then(onState).catch(() => {});
    if (S.notify && has('phone.notify')) client.cmd('notify.set', { on: true }).catch(() => {});
  });
  client.on('grants', (g) => { S.grants = g; render(); });
  client.on('state', onState);
  client.on('feed', (items) => { S.feed = [...items.reverse(), ...S.feed].slice(0, 60); if (S.tab === 'status') renderFeed(); });
  client.on('notice', onNotice);
  client.on('remote', (m) => S.viewer?.onMessage(m));
  client.on('close', (why) => {
    S.viewer?.onMessage({ t: 'remote.stop', body: { reason: 'disconnected' } });
    if (S.client !== client) return;
    S.client = null;
    if (/revoked/.test(why)) {
      store.del('pairing');
      return failure({ title: t('fail.removed.title'), body: t('fail.removed.body'), actions: [h('button', { class: 'btn btn-ghost', type: 'button', text: t('action.close'), on: { click: welcome } })] });
    }
    if (S.screen === 'shell' && S.pairing) { setConn('off'); toast(t('conn.lost'), 'bad'); retryTimer = setTimeout(() => reconnect(S.pairing), 2000); }
  });
}

function onState(s) {
  S.state = s;
  if (S.screen === 'shell') render();
}

async function onNotice(n) {
  const title = t(`notice.${n.kind}`);
  const body = n.text || '';
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      if (reg) return reg.showNotification(title, { body, tag: `hd-${n.kind}-${n.jobId || ''}`, icon: 'icon-192.png', badge: 'icon-192.png' });
      return new Notification(title, { body });
    } catch { /* fall back to the toast */ }
  }
  toast(body ? `${title}: ${body}` : title, n.kind === 'job.failed' ? 'bad' : n.kind === 'job.done' ? 'ok' : 'hl', 6000);
  if (n.kind === 'approval' && S.tab !== 'approvals') { S.badge = true; renderNav(); }
}

async function cmd(op, a, okText) {
  if (!S.client?.connected) { toast(t('conn.offline'), 'bad'); throw Object.assign(new Error('offline'), { code: 'offline' }); }
  try {
    const r = await S.client.cmd(op, a);
    if (okText) toast(okText, 'ok');
    return r;
  } catch (err) {
    toast(errText(err), 'bad', 5000);
    throw err;
  }
}

// ---------------------------------------------------------------- the shell

let els = {};
function shell() {
  clear(app);
  S.screen = 'shell';
  const conn = h('span', { class: 'pill', role: 'status' });
  const name = h('b');
  const top = h('header', { class: 'top' }, mark(), h('div', { class: 'host grow' }, name, conn), h('button', { class: 'ibtn', type: 'button', 'aria-label': t('settings.title'), on: { click: settings } }, icon('menu')));
  const view = h('main', { class: 'view', id: 'view', tabindex: '-1' });
  const nav = h('nav', { class: 'nav', role: 'tablist', 'aria-label': t('nav.label') });
  app.append(h('div', { class: 'sky', 'aria-hidden': 'true' }), h('div', { class: 'shell' }, top, view, nav));
  els = { conn, name, view, nav };
  renderNav();
}

function setConn(c) {
  S.conn = c;
  if (!els.conn) return;
  els.conn.className = `pill ${c === 'on' ? 'on' : c === 'wait' ? 'wait' : ''}`;
  els.conn.textContent = t(`conn.${c}`);
}

const TABS = [['status', 'status'], ['crew', 'crew'], ['approvals', 'approve'], ['remote', 'remote']];
function renderNav() {
  if (!els.nav) return;
  const count = S.state?.approvals?.count || 0;
  els.nav.replaceChildren(...TABS.map(([id, ic]) => {
    const b = h('button', { type: 'button', role: 'tab', 'aria-selected': String(S.tab === id), 'aria-controls': 'view', 'data-tab': id, on: { click: () => { S.tab = id; if (id === 'approvals') S.badge = false; render(); els.view.focus({ preventScroll: true }); } } },
      icon(ic), h('span', { text: t(`nav.${id}`) }), id === 'approvals' && count ? h('span', { class: 'badge', 'aria-label': t('ap.count', { n: count }), text: String(count) }) : null);
    return b;
  }));
}

function render() {
  if (S.screen !== 'shell') return;
  els.name.textContent = hostName();
  setConn(S.conn);
  renderNav();
  const v = els.view;
  const de = document.documentElement;
  const nearBottom = de.scrollHeight - (de.scrollTop + innerHeight) < 160 || S.lastTab !== S.tab;
  S.lastTab = S.tab;
  const views = { status: viewStatus, crew: viewCrew, approvals: viewApprovals, remote: viewRemote };
  const focused = document.activeElement?.id;
  const draft = document.getElementById('compose')?.value;
  v.replaceChildren(...[].concat(views[S.tab]()));
  if (draft != null && document.getElementById('compose')) document.getElementById('compose').value = draft;
  if (focused && document.getElementById(focused)) document.getElementById(focused).focus({ preventScroll: true });
  // The chat reads from the bottom: keep the newest message in view unless the person scrolled up.
  if (S.tab === 'crew' && nearBottom) requestAnimationFrame(() => scrollTo({ top: document.documentElement.scrollHeight }));
}

function locked(text) {
  return h('div', { class: 'locked' }, h('div', { class: 'lk' }, icon('lock')), h('b', { text: t('locked.title') }), h('span', { text }));
}

// ---------------------------------------------------------------- status

const STATUS_OF = (s) => t(`job.${s}`) !== `job.${s}` ? t(`job.${s}`) : s;

function viewStatus() {
  if (!has('phone.status')) return locked(t('locked.status'));
  const s = S.state;
  if (!s) return h('div', { class: 'empty', text: t('status.loading') });
  const running = s.jobs.filter((j) => ['running', 'planning', 'refining', 'awaiting_brief'].includes(j.status)).length;
  const busy = s.crew.filter((w) => w.status !== 'idle').length;
  const city = h('section', { class: 'card city', 'aria-labelledby': 'cityh' },
    h('div', { class: 'row' }, h('h2', { id: 'cityh', class: 'grow', style: { margin: 0, fontSize: '18px' }, text: t('status.city') }), s.demo ? h('span', { class: 'status', text: t('status.demo') }) : null),
    h('div', { class: 'stats' },
      stat(running, t('status.jobsRunning'), running > 0),
      stat(`${busy}/${s.crew.length}`, t('status.workersBusy')),
      stat(s.approvals.count, t('status.approvals'), s.approvals.count > 0),
      stat(s.city.machines ? `${s.city.online}/${s.city.machines}` : s.queue.running + s.queue.waiting, s.city.machines ? t('status.machines') : t('status.queue'))),
    h('div', { class: 'brainline' }, icon('bolt'), h('span', { text: s.brain.state === 'ready' ? t('status.brainReady', { model: s.brain.model || '' }) : t('status.brainNot', { state: s.brain.state || '' }) })));
  const jobs = s.jobs.length ? s.jobs.slice(0, 8).map((j) => jobCard(j, s)) : [h('div', { class: 'card empty', text: t('status.noJobs') })];
  return [city, sect(t('status.jobs')), ...jobs, sect(t('status.activity')), h('section', { class: 'card', style: { padding: '6px 14px' } }, feedList())];
}

const stat = (v, label, hl) => h('div', { class: `stat ${hl ? 'hl' : ''}` }, h('b', { text: String(v) }), h('span', { text: label }));
const sect = (title, extra) => h('div', { class: 'sect' }, h('h2', { text: title }), extra || null);

function jobCard(j, s) {
  const tasks = s.tasks.filter((x) => x.jobId === j.id || j.taskIds.includes(x.id));
  const done = tasks.filter((x) => x.status === 'done').length;
  const card = h('article', { class: 'card job', 'data-job': j.id },
    h('div', { class: 'job-h' }, h('div', { class: 'grow' }, h('div', { class: 'req', text: j.request }), h('div', { class: 'small dim', text: `${j.id} · ${ago(j.createdAt)}` })), h('span', { class: `status ${j.status}`, text: STATUS_OF(j.status) })),
    tasks.length ? h('div', { class: 'bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(tasks.length), 'aria-valuenow': String(done), 'aria-label': t('status.progress', { done, total: tasks.length }) }, h('i', { style: { width: `${Math.round((done / tasks.length) * 100)}%` } })) : null,
    tasks.length ? h('ul', { class: 'tasks' }, ...tasks.slice(0, 6).map((x) => h('li', { class: x.status }, h('span', { class: 'tdot', 'aria-hidden': 'true' }), h('span', { class: 'grow', text: x.title }), h('span', { class: 'small dim', text: x.workerId || '' })))) : null,
    j.summary ? h('div', { class: 'small dim', text: j.summary }) : null,
    j.error ? h('div', { class: 'small', style: { color: 'var(--bad)' }, text: j.error }) : null);
  if (j.status === 'awaiting_brief' && j.brief) {
    card.append(h('div', { class: 'small', style: { fontWeight: 600 }, text: t('brief.title') }), h('pre', { class: 'brief', text: j.brief.text }));
    if (has('phone.crew')) {
      card.append(h('div', { class: 'ap-act' },
        h('button', { class: 'btn btn-sm', type: 'button', text: t('brief.original'), on: { click: () => cmd('brief.approve', { jobId: j.id, use: 'original' }, t('brief.started')) } }),
        h('button', { class: 'btn btn-sm btn-honey', type: 'button', 'data-brief': j.id, text: t('brief.approve'), on: { click: () => cmd('brief.approve', { jobId: j.id, use: 'refined' }, t('brief.started')) } })));
    }
  }
  if (has('phone.control') && ['running', 'planning', 'refining', 'awaiting_brief'].includes(j.status)) {
    card.append(h('button', { class: 'btn btn-sm btn-bad', type: 'button', text: t('job.cancelBtn'), on: { click: () => confirm(t('job.cancelConfirm')) && cmd('job.cancel', { jobId: j.id }, t('job.cancelledToast')) } }, icon('stop')));
  }
  return card;
}

const FEED_ICON = { 'job.created': ['bolt', 'hl'], 'job.done': ['check', 'ok'], 'job.failed': ['alert', 'bad'], 'job.cancelled': ['stop', 'bad'], 'task.running': ['play', 'hl'], 'task.done': ['check', 'ok'], 'task.failed': ['x', 'bad'], 'approval.requested': ['approve', 'hl'], 'approval.approved': ['check', 'ok'], 'approval.rejected': ['x', 'bad'], 'file.changed': ['doc', ''], chat: ['crew', ''], 'brief.proposed': ['doc', 'hl'], 'job.planned': ['status', ''], 'worker.paused': ['pause', ''], 'worker.resumed': ['play', ''] };
function feedList() {
  if (!S.feed.length) return h('div', { class: 'empty', text: t('status.noActivity') });
  return h('ul', { class: 'feed', id: 'feed', 'aria-live': 'polite' }, ...S.feed.slice(0, 30).map((f) => {
    const [ic, tone] = FEED_ICON[f.k] || ['bolt', ''];
    const text = f.k === 'chat' ? `${f.from}: ${mdLine(f.text, 160)}` : t(`feed.${f.k}`, { text: f.text || '', path: f.path || '', n: f.n || 0, worker: f.workerId || '' });
    return h('li', {}, h('span', { class: `fi ${tone}` }, icon(ic)), h('span', { class: 'grow', text }), h('time', { dateTime: f.ts, text: clock(f.ts) }));
  }));
}
function renderFeed() {
  const old = document.getElementById('feed') || els.view.querySelector('.feed, .empty:last-child');
  if (old && old.parentElement?.classList.contains('card')) old.replaceWith(feedList());
}

// ---------------------------------------------------------------- crew

function viewCrew() {
  if (!has('phone.crew')) return locked(t('locked.crew'));
  const s = S.state;
  const crew = s?.crew || [];
  if (!S.chat || S.chat.channel !== S.channel) {
    S.chat = { channel: S.channel, lines: S.channel === 'general' ? s?.chat?.lines || [] : [] };
    cmd('chat.log', { channel: S.channel }).then((c) => { S.chat = c; if (S.tab === 'crew') render(); }).catch(() => {});
  } else if (S.channel === 'general' && s?.chat) S.chat = s.chat;
  const workers = h('div', { class: 'workers', role: 'list', 'aria-label': t('crew.workers') },
    h('button', { class: 'worker', type: 'button', role: 'listitem', 'aria-pressed': String(S.channel === 'general'), on: { click: () => { S.channel = 'general'; render(); } } },
      h('div', { class: 'ava', style: { background: 'var(--honey)' } }, icon('crew')), h('span', { text: t('crew.everyone') })),
    ...crew.map((w) => {
      const st = w.paused ? 'paused' : w.status === 'idle' ? '' : w.status.startsWith('waiting') ? 'wait' : 'busy';
      return h('button', { class: 'worker', type: 'button', role: 'listitem', 'aria-pressed': String(S.channel === `dm:${w.id}`), 'aria-label': `${w.name}, ${w.role}, ${t(`worker.${w.paused ? 'paused' : w.status}`)}`, on: { click: () => { S.channel = `dm:${w.id}`; render(); } } },
        h('div', { class: 'ava', style: { background: w.color || 'var(--honey)' } }, w.avatar || w.name.slice(0, 1), h('i', { class: st })), h('span', { text: w.name }));
    }));
  const out = [workers];
  const dm = S.channel.startsWith('dm:') ? crew.find((w) => `dm:${w.id}` === S.channel) : null;
  if (dm) {
    out.push(h('div', { class: 'card row' },
      h('div', { class: 'grow' }, h('b', { text: dm.name }), h('div', { class: 'small dim', text: `${dm.role} · ${t(`worker.${dm.paused ? 'paused' : dm.status}`)}${dm.detail ? ` · ${dm.detail}` : ''}` })),
      has('phone.control') ? h('button', { class: `btn btn-sm ${dm.paused ? 'btn-ok' : ''}`, type: 'button', on: { click: () => cmd(dm.paused ? 'worker.resume' : 'worker.pause', { workerId: dm.id }, t(dm.paused ? 'crew.resumed' : 'crew.paused', { name: dm.name })) } }, icon(dm.paused ? 'play' : 'pause'), h('span', { text: t(dm.paused ? 'crew.resume' : 'crew.pause') })) : null));
  }
  const lines = S.chat?.lines || [];
  out.push(h('section', { class: 'chat', 'aria-live': 'polite', 'aria-label': t('crew.chat') },
    lines.length ? lines.slice(-40).map((m) => {
      const who = m.from === 'user' ? 'me' : m.from === 'system' ? 'sys' : 'them';
      const w = crew.find((x) => x.id === m.from);
      return h('div', { class: `msg ${who}` }, who === 'them' ? h('span', { class: 'who', text: w?.name || m.from }) : null,
        // Crew text is markdown: the page never builds HTML from data, so the marks are taken out (no raw ** or #).
        who === 'them' ? mdStrip(m.text) : m.text);
    }) : h('div', { class: 'empty', text: t('crew.empty') })));
  out.push(composer(dm));
  return out;
}

function composer(dm) {
  if (dm && S.mode === 'request') S.mode = 'message';
  const ta = h('textarea', { id: 'compose', rows: 1, maxLength: 4000, enterkeyhint: 'send', 'aria-label': t(S.mode === 'request' ? 'crew.requestLabel' : 'crew.messageLabel'), placeholder: t(S.mode === 'request' ? 'crew.requestHint' : 'crew.messageHint', { name: dm?.name || '' }) });
  const send = h('button', { class: 'send', type: 'button', 'aria-label': t('crew.send'), 'data-send': '1' }, icon('send'));
  const grow = () => { ta.style.height = 'auto'; ta.style.height = `${Math.min(140, ta.scrollHeight)}px`; };
  ta.addEventListener('input', grow);
  const submit = async () => {
    const text = ta.value.trim();
    if (!text) return;
    send.disabled = true;
    try {
      if (S.mode === 'request') {
        const r = await cmd('job.create', { request: text });
        toast(t('crew.jobStarted', { id: r.jobId }), 'ok');
        S.tab = 'status';
      } else await cmd('chat.send', { channel: S.channel, text, lang: locale() });
      // A state push may have rebuilt the composer meanwhile: clear the one on screen.
      ta.value = '';
      const live = document.getElementById('compose');
      if (live) live.value = '';
      render();
    } catch { /* toast shown */ } finally { send.disabled = false; }
  };
  send.addEventListener('click', submit);
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); } });
  const seg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': t('crew.kind') },
    ...['request', 'message'].map((m) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(S.mode === m), disabled: m === 'request' && !!dm, on: { click: () => { S.mode = m; render(); } }, text: t(`crew.mode.${m}`) })));
  return h('div', { class: 'composer' }, dm ? null : seg, h('div', { class: 'row' }, voiceButton(ta), ta, send));
}

function voiceButton(ta) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const b = h('button', { class: 'mic', type: 'button', 'aria-pressed': 'false', 'aria-label': t('voice.start'), title: t('voice.hint') }, icon('mic'));
  if (!SR) { b.disabled = true; b.title = t('voice.none'); return b; }
  let rec = null;
  b.addEventListener('click', () => {
    if (rec) { rec.stop(); return; }
    rec = new SR();
    rec.lang = locale();
    rec.interimResults = true;
    rec.continuous = false;
    const base = ta.value ? `${ta.value.trim()} ` : '';
    rec.onresult = (e) => { ta.value = base + [...e.results].map((r) => r[0].transcript).join(''); ta.dispatchEvent(new Event('input')); };
    rec.onerror = (e) => { if (e.error !== 'aborted' && e.error !== 'no-speech') toast(t('voice.error'), 'bad'); };
    rec.onend = () => { rec = null; b.setAttribute('aria-pressed', 'false'); b.setAttribute('aria-label', t('voice.start')); ta.focus(); };
    b.setAttribute('aria-pressed', 'true');
    b.setAttribute('aria-label', t('voice.stop'));
    try { rec.start(); } catch { rec = null; b.setAttribute('aria-pressed', 'false'); }
  });
  return b;
}

// ---------------------------------------------------------------- approvals

function viewApprovals() {
  if (!has('phone.approve')) {
    const n = S.state?.approvals?.count || 0;
    return [locked(t('locked.approve')), n ? h('div', { class: 'note', text: t('ap.waitingAtDesk', { n }) }) : null];
  }
  const cards = S.state?.approvals?.cards || [];
  if (!cards.length) return h('div', { class: 'card empty' }, h('div', { class: 'locked' }, h('div', { class: 'lk' }, icon('approve')), h('b', { text: t('ap.none') }), h('span', { text: t('ap.noneBody') })));
  return [sect(t('ap.title'), h('span', { class: 'small dim', text: t('ap.count', { n: cards.length }) })), ...cards.map(approvalCard)];
}

function diffView(text) {
  const pre = h('pre', { class: 'diff' });
  for (const line of text.split('\n').slice(0, 600)) pre.append(h('span', { class: line.startsWith('@@') ? 'h' : line.startsWith('+') && !line.startsWith('+++') ? 'a' : line.startsWith('-') && !line.startsWith('---') ? 'd' : '', text: line || ' ' }));
  return pre;
}

function approvalCard(a) {
  const decide = async (approved, btn) => {
    btn.disabled = true;
    try { await cmd('approval.resolve', { approvalId: a.id, approved }, t(approved ? 'ap.approved' : 'ap.rejected')); } catch { btn.disabled = false; }
  };
  const approve = h('button', { class: 'btn btn-honey', type: 'button', 'data-approve': a.id }, icon('check'), h('span', { text: t('ap.approve') }));
  const reject = h('button', { class: 'btn btn-bad', type: 'button', 'data-reject': a.id }, icon('x'), h('span', { text: t('ap.reject') }));
  approve.addEventListener('click', () => decide(true, approve));
  reject.addEventListener('click', () => decide(false, reject));
  if (a.origin?.remote) approve.disabled = true;
  return h('article', { class: 'card ap', 'aria-label': a.summary, 'data-approval': a.id },
    h('div', { class: 'ap-h' }, h('div', { class: 'ap-ico' }, icon(a.command ? 'term' : 'doc')), h('div', { class: 'grow' }, h('div', { class: 'ap-t', text: a.summary }), h('div', { class: 'small dim', text: ago(a.createdAt) }))),
    h('dl', { class: 'kv' },
      h('dt', { text: t('ap.who') }), h('dd', { text: a.origin?.worker || '' }),
      a.origin?.job ? [h('dt', { text: t('ap.job') }), h('dd', { text: a.origin.job })] : null,
      h('dt', { text: t('ap.tool') }), h('dd', { class: 'mono', text: a.tool }),
      a.path ? [h('dt', { text: t('ap.path') }), h('dd', { class: 'mono', text: a.path })] : null,
      a.origin?.remote ? [h('dt', { text: t('ap.origin') }), h('dd', { text: t('ap.remoteModel') })] : null),
    a.command ? h('pre', { class: 'cmd', text: a.command }) : null,
    a.diff ? h('details', {}, h('summary', {}, h('span', { class: 'diffsum' }, h('span', { text: t('ap.changes') }), h('span', { class: 'add', text: `+${a.diff.added}` }), h('span', { class: 'del', text: `-${a.diff.removed}` }))), diffView(a.diff.text)) : null,
    a.origin?.remote ? h('div', { class: 'note warn small' }, icon('alert'), h('span', { text: t('ap.remoteOnlyDesk') })) : null,
    h('div', { class: 'ap-act' }, reject, approve));
}

// ---------------------------------------------------------------- remote desktop

function viewRemote() {
  if (!has('phone.remote')) return locked(t('locked.remote'));
  const ask = (control) => async () => {
    const { openViewer } = await import('./viewer.js');
    S.viewer = openViewer({ client: S.client, control, t, toast, onClose: () => { S.viewer = null; } });
  };
  return h('section', { class: 'card rd-hero' },
    h('div', { class: 'rd-screen', 'aria-hidden': 'true' }, icon('remote')),
    h('h2', { style: { margin: 0, fontSize: '19px' }, text: t('rd.title') }),
    h('p', { class: 'dim', style: { margin: 0 }, text: t('rd.body') }),
    h('button', { class: 'btn btn-honey', type: 'button', 'data-rd': 'view', on: { click: ask(false) } }, icon('remote'), h('span', { text: t('rd.view') })),
    h('button', { class: 'btn', type: 'button', 'data-rd': 'control', on: { click: ask(true) } }, icon('touch'), h('span', { text: t('rd.control') })),
    h('div', { class: 'note small' }, icon('lock'), h('span', { text: t('rd.safety') })));
}

// ---------------------------------------------------------------- settings

function langPicker() {
  const sel = h('select', { class: 'input', 'aria-label': t('settings.language') }, ...LOCALES.map((l) => h('option', { value: l.code, text: l.name, selected: l.code === locale() })));
  sel.addEventListener('change', async () => { await setLocale(sel.value); S.screen === 'shell' ? (shell(), render()) : boot(); });
  return sel;
}

function settings() {
  const close = () => { scrim.remove(); sheet.remove(); };
  const scrim = h('div', { class: 'scrim', on: { click: close } });
  const nt = h('input', { type: 'checkbox', role: 'switch', checked: S.notify, disabled: !has('phone.notify') });
  nt.addEventListener('change', async () => {
    if (nt.checked && 'Notification' in window && Notification.permission === 'default') await Notification.requestPermission().catch(() => 'denied');
    try { await cmd('notify.set', { on: nt.checked }); S.notify = nt.checked; try { localStorage.setItem('hivedesk.remote.notify', S.notify ? '1' : '0'); } catch { /* private */ } } catch { nt.checked = !nt.checked; }
  });
  const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('settings.title') },
    h('div', { class: 'grab', 'aria-hidden': 'true' }),
    h('h2', { text: t('settings.title') }),
    h('div', { class: 'setting' }, icon('remote'), h('div', { class: 'grow' }, h('b', { text: hostName() }), h('div', { class: 'small dim', text: t('settings.paired', { when: S.pairing ? ago(S.pairing.pairedAt) : '' }) }))),
    h('div', { class: 'setting' }, icon('phone'), h('div', { class: 'grow' }, h('b', { text: phoneName() }), h('div', { class: 'small dim', text: t('settings.grants', { list: S.grants.map((g) => t(`grant.${g}`)).join(', ') }) }))),
    h('label', { class: 'setting' }, icon('bell'), h('div', { class: 'grow' }, h('b', { text: t('settings.notify') }), h('div', { class: 'small dim', text: has('phone.notify') ? t('settings.notifyHelp') : t('locked.notify') })), h('span', { class: 'switch' }, nt, h('span'))),
    h('div', { class: 'setting' }, h('div', { class: 'grow' }, h('b', { text: t('settings.language') })), langPicker()),
    S.expiresAt ? h('div', { class: 'small dim', text: t('settings.expires', { time: clock(new Date(S.expiresAt).toISOString()) }) }) : null,
    h('button', { class: 'btn btn-bad btn-wide', type: 'button', text: t('settings.forget'), on: { click: () => { close(); forgetComputer(); } } }),
    h('button', { class: 'btn btn-ghost btn-wide', type: 'button', text: t('action.close'), on: { click: close } }));
  sheet.addEventListener('keydown', (e) => e.key === 'Escape' && close());
  document.body.append(scrim, sheet);
  sheet.querySelector('button, input')?.focus();
}

async function forgetComputer() {
  if (!confirm(t('settings.forgetConfirm'))) return;
  clearTimeout(retryTimer);
  S.client?.close('forgotten by the phone');
  S.pairing = null;
  await store.forget();
  welcome();
}

// ---------------------------------------------------------------- start

async function boot() {
  await initI18n();
  try { S.notify = localStorage.getItem('hivedesk.remote.notify') === '1'; } catch { /* private */ }
  let invite = null;
  try {
    invite = readInviteHash(location.hash);
  } catch {
    history.replaceState(null, '', location.pathname);
    return failure({ title: t('fail.bad.title'), body: t('fail.bad.body'), actions: [h('button', { class: 'btn btn-ghost', type: 'button', text: t('action.close'), on: { click: welcome } })] });
  }
  // The invite must not stay in the address bar, the history or a screenshot of it.
  if (location.hash) history.replaceState(null, '', location.pathname);
  if (!crypto?.subtle || !window.RTCPeerConnection || !window.indexedDB) {
    return failure({ title: t('fail.browser.title'), body: t('fail.browser.body') });
  }
  if (invite) return pairScreen(invite);
  const p = await store.pairing().catch(() => null);
  if (p?.reconnect) return reconnect(p);
  welcome();
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js', { scope: './' }).catch(() => {});
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.pairing && !S.client && S.screen === 'shell') reconnect(S.pairing); });
boot().catch((err) => failure({ title: t('fail.generic.title'), body: errText(err) }));
void live;
