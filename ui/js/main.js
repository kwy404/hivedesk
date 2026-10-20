// hivedesk desktop: boot, wiring between the engine, the store and the shell.

import { h, icon } from './dom.js';
import * as net from './net.js';
import { ui, rev, S, loadHello, applyEvent, applyLive, onEvent, worker, liveState, hydrateExtra } from './store.js';
import * as wm from './wm.js';
import * as menu from './menu.js';
import * as notifyMod from './notify.js';
import { notify, dismissKey } from './notify.js';
import { play, setMuted } from './sound.js';
import * as topbar from './topbar.js';
import * as dock from './dock.js';
import './hive.js';
import './palette.js';
import './widgets/timeline.js';
import './widgets/chat.js';
import './widgets/worker.js';
import './widgets/files.js';
import './widgets/runlog.js';
import './widgets/preview.js';
import './widgets/playbooks.js';
import './widgets/replay.js';
import './widgets/approvals.js';
import './widgets/settings.js';
import './widgets/lend.js';
import '/editor/register.js'; // the Code editor and Code together windows (ui/editor/, ui/lend/collab/)
import './widgets/brief.js';
import './widgets/memory.js';
import './widgets/providers.js';
import './widgets/prompts.js';
import './widgets/library.js';
import { tr as libT } from './widgets/library-strings.js';
import { approvalTitle } from './widgets/approvals.js';
import { beeAvatar } from './bees.js';
import { openHire } from './widgets/hire.js';
import { shortModel } from './brainstate.js';
import * as act from './actions.js';
import { initOffice, addView, setMode, getMode } from '../office/office.js';
import { initCity } from '../city/city.js';
import * as i18n from './i18n.js';
import { t, dlError } from './i18n.js';
import * as tooltip from './tooltip.js';
import { celebrate } from './fx.js';
import '../github/index.js'; // GitHub and Changelog windows, dock buttons, Ctrl K entries, runIntent
import '../models/index.js'; // Models window, first launch analysis and consent before any model download
import '../themes/index.js'; // Themes window, theme editor, live theme tokens, Ctrl K entries
import '../extensions/index.js'; // Extensions window, permission prompt, widget frames, Ctrl K entries
import '../profile/ui.js'; // the local profile: top bar avatar, Profile window, avatar gallery (docs/1.0/PROFILE.md)

const V = window.V;
const root = document.documentElement;

try {
  const m = localStorage.getItem('hivedesk.motion');
  if (m) root.dataset.motion = m;
  const wp = localStorage.getItem('hivedesk.wallpaper');
  if (wp) ui.wallpaper = wp;
} catch {}

/* ---------- icons ---------- */
async function loadSprite() {
  try {
    const r = await fetch('/assets/icons/sprite.svg');
    if (!r.ok) throw new Error(String(r.status));
    const text = await r.text();
    const holder = h('div', { 'aria-hidden': 'true', style: 'position:absolute;width:0;height:0;overflow:hidden' });
    holder.innerHTML = text.replace(/style="display:none"/, '');
    document.body.prepend(holder);
  } catch (err) {
    console.warn('[hivedesk] icon sprite missing', err.message);
  }
}

/* ---------- shell ---------- */
const app = document.querySelector('.app');
const bar = app.querySelector('.topbar');
const desk = app.querySelector('.desk');
const dockEl = app.querySelector('.hdock');

const WALLS = ['comb', 'fine', 'dusk', 'plain'];

function desktopMenu() {
  const open = (type) => () => wm.open(type);
  return [
    { label: t('menu.newWindow'), icon: 'hive', items: [
      { label: t('dock.timeline'), icon: 'plan', action: open('timeline') },
      { label: t('dock.chat'), icon: 'chat', action: open('chat') },
      { label: t('dock.files'), icon: 'folder', action: open('files') },
      { label: t('dock.preview'), icon: 'preview', action: open('preview') },
      { label: t('dock.runlog'), icon: 'terminal', action: open('runlog') },
      { label: t('dock.playbooks'), icon: 'playbook', action: open('playbooks') },
      { label: t('dock.replay'), icon: 'replay', action: open('replay') },
      { label: t('dock.approvals'), icon: 'approval', action: open('approvals') },
      { sep: true },
      { label: t('menu.workerChat'), icon: 'chat', items: () => S().crew.map((w) => ({ label: w.name, iconEl: dockAv(w), action: () => wm.open('worker', w.id) })) },
      { label: t('dock.settings'), icon: 'model', action: open('settings') },
      { label: t('dock.lend'), icon: 'lend', action: open('lend') },
      { label: 'Brief and report', icon: 'plan', action: open('brief') },
      { label: 'Memory', icon: 'playbook', action: open('memory') },
      { label: 'Providers', icon: 'key', action: open('providers') },
      { label: 'Prompts (debug)', icon: 'code', action: open('prompts') },
      { label: libT('library.dock'), icon: 'playbook', action: open('library') },
    ] },
    { label: t('menu.arrange'), icon: 'plan', items: [
      { label: t('menu.tidy'), icon: 'hive', action: () => wm.arrange('grid') },
      { label: t('menu.cascade'), icon: 'copy', action: () => wm.arrange('cascade') },
      { label: t('pal.minimizeAll'), icon: 'stop', action: () => wm.minimizeAll() },
      { sep: true },
      { label: t('pal.resetLayout'), icon: 'replay', action: () => resetLayout() },
    ] },
    { label: t('menu.wallpaper'), icon: 'design', items: WALLS.map((k) => ({ label: t(`menu.wall.${k}`), checked: ui.wallpaper === k, action: () => setWall(k) })) },
    { label: t('menu.language'), icon: 'globe', items: () => i18n.LOCALES.map((l) => ({ label: l.name, checked: i18n.locale() === l.code, action: () => i18n.setLocale(l.code) })) },
    { sep: true },
    { label: t('dock.hire'), icon: 'hire', disabled: !!ui.replay, action: () => openHire() },
    { label: t('top.palette'), icon: 'arrow', kb: 'Ctrl K', action: () => import('./palette.js').then((m) => m.openPalette()) },
    { label: t('menu.help'), icon: 'compass', items: () => helpItems() },
  ];
}

function helpItems() {
  return [
    { label: t('pal.tour'), icon: 'compass', action: () => import('./tour.js').then((m) => m.startTour()) },
    { label: t('pal.shortcuts'), icon: 'plan', action: () => import('./help.js').then((m) => m.openShortcuts()) },
    { sep: true },
    { label: t('pal.about'), icon: 'hive', action: () => import('./about.js').then((m) => m.openAbout()) },
  ];
}

function dockAv(w) { return beeAvatar(w, 18, { ring: false }); }

function setWall(k) {
  ui.wallpaper = k;
  desk.dataset.wall = k;
  try { localStorage.setItem('hivedesk.wallpaper', k); } catch {}
}

const kb = (s) => i18n.fmtKeys(s).join(' ');

function windowMenu(id) {
  const w = wm.get(id);
  if (!w) return null;
  const phone = wm.isPhone();
  return [
    { header: w.titleEl.textContent },
    { label: t('win.minimize'), icon: 'stop', kb: kb('Ctrl Alt Down'), action: () => wm.minimize(id) },
    { label: w.snap === 'max' ? t('win.restore') : t('win.maximize'), icon: 'preview', kb: kb('Ctrl Alt Up'), action: () => wm.toggleMax(id) },
    { label: t('menu.snapLeft'), icon: 'arrow', kb: kb('Ctrl Alt Left'), disabled: phone, action: () => wm.snap(id, 'left') },
    { label: t('menu.snapRight'), icon: 'arrow', kb: kb('Ctrl Alt Right'), disabled: phone, action: () => wm.snap(id, 'right') },
    { label: t('menu.quarter'), icon: 'hive', disabled: phone, items: [
      { label: t('menu.tl'), kb: kb('Ctrl Alt 1'), action: () => wm.snap(id, 'tl') },
      { label: t('menu.tr'), kb: kb('Ctrl Alt 2'), action: () => wm.snap(id, 'tr') },
      { label: t('menu.bl'), kb: kb('Ctrl Alt 3'), action: () => wm.snap(id, 'bl') },
      { label: t('menu.br'), kb: kb('Ctrl Alt 4'), action: () => wm.snap(id, 'br') },
    ] },
    { sep: true },
    { label: t('win.close'), icon: 'x', kb: kb('Ctrl Alt W'), danger: true, action: () => wm.close(id) },
  ];
}

const DEFAULT_SETS = {
  wide: (W, H, g) => {
    const c1 = Math.round(W * 0.25); const c3 = Math.round(W * 0.27); const c2 = W - c1 - c3 - g * 4;
    const h1 = Math.round(H * 0.56); const h2 = Math.round(H * 0.6); const h3 = Math.round(H * 0.58);
    return [
      ['timeline', null, g, g, c1, h1],
      ['chat', null, g, h1 + g * 2, c1, H - h1 - g * 3],
      ['preview', null, c1 + g * 2, g, c2, h2],
      ['files', null, c1 + g * 2, h2 + g * 2, c2, H - h2 - g * 3],
      ['worker', 'dev', c1 + c2 + g * 3, g, c3, h3],
      ['runlog', null, c1 + c2 + g * 3, h3 + g * 2, c3, H - h3 - g * 3],
    ];
  },
};

function defaultLayout() {
  const W = desk.clientWidth || innerWidth;
  const H = desk.clientHeight || innerHeight - 140;
  const rects = DEFAULT_SETS.wide(W, H, 10);
  let z = 20;
  return {
    wins: rects.map(([type, arg, x, y, w, hh]) => ({ type, arg, g: { x: x / W, y: y / H, w: w / W, h: hh / H }, snap: null, min: false, z: z++ })),
    focused: 'worker:dev',
  };
}

export function resetLayout() {
  try { localStorage.removeItem('hivedesk.layout.v2'); } catch {}
  wm.applyLayout(defaultLayout());
}

/* ---------- connection overlay ---------- */
const boot = document.querySelector('.boot');
const conn = h('div', { class: 'conn', role: 'status' });
document.body.append(conn);

function paintConnection(c) {
  ui.connection = c.state;
  if (c.state === 'open') { conn.classList.remove('on'); return; }
  if (c.state === 'unauthorized') {
    boot.classList.remove('gone');
    boot.querySelector('h1').textContent = t('boot.auth.title');
    boot.querySelector('p').textContent = t('boot.auth.text');
    boot.querySelector('.spin')?.remove();
    return;
  }
  if (!ui.hello) {
    // Before the first hello the boot screen says "connecting"; after a few failed tries it says why and offers Retry.
    if (c.state === 'offline' && c.attempts >= 3) bootStuck();
    return;
  }
  conn.replaceChildren(icon('offline'), h('span', { text: c.state === 'offline' ? t('conn.lost', { s: Math.max(1, Math.round((c.nextRetryAt - Date.now()) / 1000)) }) : t('conn.reconnecting') }),
    h('button', { type: 'button', class: 'btn btn-xs btn-quiet', text: t('conn.retry'), tip: 'tip.conn.retry', on: { click: () => net.retryNow() } }));
  conn.classList.add('on');
}
// The boot screen never spins without end: no hello within BOOT_WAIT_MS (the engine is not reachable, the
// socket hangs, or it opened and nothing came) or a few failed tries show the reason and a Retry button.
const BOOT_WAIT_MS = 12000;
let bootWatch = setTimeout(bootStuck, BOOT_WAIT_MS);
function bootSay(title, text, params) {
  const h1 = boot.querySelector('h1');
  const p = boot.querySelector('p');
  h1.dataset.tx = title;
  p.dataset.tx = text;
  if (params) p.setAttribute('data-tx-args', JSON.stringify(params)); else p.removeAttribute('data-tx-args');
  h1.textContent = t(title);
  p.textContent = t(text, params);
}
function bootStuck() {
  clearTimeout(bootWatch);
  if (ui.hello || ui.connection === 'unauthorized' || boot.classList.contains('stuck')) return;
  boot.classList.add('stuck');
  bootSay('boot.offline.title', 'boot.offline.text', { host: location.host });
  boot.querySelector('.spin')?.setAttribute('hidden', '');
  const retry = h('button', { type: 'button', class: 'btn btn-primary boot-retry', tx: 'boot.failed.retry', on: { click: bootRetry } });
  boot.querySelector('.boot-in').append(retry);
  retry.focus();
}
function bootRetry() {
  boot.classList.remove('stuck');
  boot.querySelector('.boot-retry')?.remove();
  bootSay('boot.title', 'boot.text');
  boot.querySelector('.spin')?.removeAttribute('hidden');
  // A socket that is open but sent no hello is not worth keeping: load the page again.
  if (net.isOpen()) { location.reload(); return; }
  net.retryNow();
  bootWatch = setTimeout(bootStuck, BOOT_WAIT_MS);
}
let connTimer = null;
net.on('connection', (c) => {
  paintConnection(c);
  clearInterval(connTimer);
  if (c.state === 'offline') connTimer = setInterval(() => paintConnection({ ...net.connection }), 1000);
});

/* ---------- engine frames ---------- */
let firstHello = true;
net.on('hello', (f) => {
  loadHello(f);
  if (f.state?.settings?.sound === false) setMuted(true);
  clearTimeout(bootWatch);
  boot.classList.remove('stuck');
  boot.querySelector('.boot-retry')?.remove();
  boot.classList.add('gone');
  setTimeout(() => boot.setAttribute('hidden', ''), 400);
  if (firstHello) {
    firstHello = false;
    const saved = wm.savedLayout();
    wm.applyLayout(saved?.wins?.length ? saved : defaultLayout());
    if (wm.isPhone()) requestAnimationFrame(() => { desk.scrollTop = 0; });
    if (/(?:^|[#&?])w=[A-Za-z-]+/.test(location.hash + location.search)) wm.open('lend');
    // the OS locale from the engine is the fallback when the browser languages did not match
    if (f.locale) i18n.adoptOsLocale(f.locale);
    if (!f.lend && !/[?&]notour/.test(location.search)) import('./tour.js').then((m) => m.maybeAutoStart());
  }
  if (f.lend) wm.open('lending', undefined, { snap: 'max' });
  // Diffs, tool calls and QA reports from before this page opened come from the log.
  net.command('events.since', { seq: Math.max(0, (f.lastSeq || 0) - 5000), limit: 5000 }, { timeout: 60000 }).then((r) => hydrateExtra(r.events || [])).catch((err) => console.warn('[hivedesk] could not load past events', err.message));
});
net.on('event', (f) => applyEvent(f.event));
net.on('live', (f) => applyLive(f));

/* ---------- reactions: sounds, notifications, unread ---------- */
let prevBrain = null;
onEvent((ev) => {
  const d = ev.data || {};
  switch (ev.type) {
    case 'task.status':
      if (d.status === 'done') { play('task'); const tk = liveState().tasks[d.taskId]; if (tk) dock.bounce(`worker:${tk.assignee}`); }
      if (d.status === 'failed') { const tk = liveState().tasks[d.taskId]; notify({ title: t('note.taskFailed'), body: `${tk ? `${tk.title}. ` : ''}${d.note || t('note.taskFailedBody')}`, tone: 'bad', sound: 'error', worker: tk ? worker(tk.assignee) : null }); }
      break;
    case 'job.done': {
      const j = liveState().jobs.find((x) => x.id === ev.jobId);
      notify({ title: t('note.jobDone'), body: d.summary || j?.request || '', tone: 'ok', sound: 'job', icon: 'check', actions: [{ label: t('note.openPreview'), primary: true, run: () => wm.open('preview') }, { label: t('dock.files'), run: () => wm.open('files') }] });
      celebrate();
      break;
    }
    case 'job.failed': notify({ title: t('note.jobFailed'), body: typeof d.error === 'string' ? d.error : d.error?.message || '', tone: 'bad', sound: 'error', actions: [{ label: t('dock.timeline'), run: () => wm.open('timeline') }] }); break;
    case 'job.cancelled': notify({ title: t('note.jobCancelled'), tone: 'info', timeout: 2600 }); break;
    case 'approval.requested': {
      const a = d.approval;
      dock.bounce('approvals');
      notify({
        title: approvalTitle(a), body: a.summary || a.args?.path || a.args?.command || '', tone: 'warn', sound: 'approval', worker: worker(a.workerId), sticky: true, key: `appr-${a.id}`,
        actions: [{ label: t('note.approve'), primary: true, run: () => act.resolveApproval(a.id, true) }, { label: t('note.reject'), danger: true, run: () => act.resolveApproval(a.id, false) }, { label: t('note.review'), run: () => wm.open('approvals') }],
      });
      break;
    }
    case 'approval.resolved': dismissKey(`appr-${d.approvalId}`); break;
    case 'qa.report': if (!d.passed) notify({ title: t('note.qaIssues', { count: d.issues?.length || 0 }), body: (d.issues || []).slice(0, 2).join(' · '), tone: 'warn', worker: worker('qa'), timeout: 7000 }); break;
    case 'brain.status':
      if (d.state === 'ready' && prevBrain && prevBrain !== 'ready') notify({ title: t('note.modelReady'), body: shortModel(d.model) || t('note.modelReadyBody'), tone: 'ok', sound: 'tick' });
      if (d.state === 'error') notify({ title: t('brain.error.label'), body: d.detail || t('brain.error.detail'), tone: 'bad', sound: 'error', actions: [{ label: t('dock.settings'), run: () => wm.open('settings') }] });
      prevBrain = d.state;
      break;
    case 'brain.download.failed': notify({ title: t('note.dlStopped'), body: dlError(d).text, tone: 'bad', sound: 'error', sticky: true, key: 'dl-fail', actions: [{ label: t('note.retry'), primary: true, run: () => act.startDownload(d.model) }, { label: t('dock.settings'), run: () => wm.open('settings') }] }); break;
    case 'brain.download.finished': notify({ title: t('note.dlDone'), body: shortModel(d.model), tone: 'ok', quiet: true }); break;
    case 'brain.fallback': notify({ title: t('note.fallback'), body: d.reason, tone: 'warn', icon: 'gpu', timeout: 9000 }); break;
    case 'brain.attached': if (d.kind === 'remote') notify({ title: t('note.brainJoined', { label: d.label }), body: t('note.brainJoinedBody'), tone: 'ok', icon: 'lend' }); break;
    case 'brain.detached': if (d.reason) notify({ title: t('note.brainLeft'), body: d.reason, tone: 'info', icon: 'lend' }); break;
    case 'crew.fired': notify({ title: t('note.fired'), tone: 'info', timeout: 2600 }); wm.close(`worker:${d.workerId}`); break;
    case 'chat.message': {
      if (d.from === 'user' || d.from === 'system') break;
      const ch = d.channel || 'general';
      const winId = ch === 'general' ? 'chat' : `worker:${ch.slice(3)}`;
      const w = wm.get(winId);
      if (!w || w.min) { ui.unread[ch] = (ui.unread[ch] || 0) + 1; ui.unread.__v++; }
      break;
    }
    default: break;
  }
});
net.on('hello', (f) => { prevBrain = f.state?.brain?.state || null; });

// Opening or restoring a chat window clears its unread count.
wm.onChange(() => {
  const raw = V.toRaw(ui.unread);
  let changed = false;
  for (const ch of Object.keys(raw)) {
    if (ch === '__v' || !raw[ch]) continue;
    const w = wm.get(ch === 'general' ? 'chat' : `worker:${ch.slice(3)}`);
    if (w && !w.min) { raw[ch] = 0; changed = true; }
  }
  if (changed) ui.unread.__v++;
});

/* ---------- start ---------- */
await Promise.all([loadSprite(), i18n.init(document.documentElement.dataset.osLocale)]);
tooltip.init();
desk.dataset.wall = ui.wallpaper;
wm.init(desk);
menu.init();
notifyMod.init();
topbar.init(bar);
dock.init(dockEl, desktopMenu);
initOffice({ desk, barRight: bar.querySelector('.bar-right'), addDockItem: dock.addDockItem });
initCity({ desk, addDockItem: dock.addDockItem, office: { addView, setMode, getMode } });
menu.provide(desk, (target) => {
  const win = target.closest?.('.win');
  if (win) return windowMenu(win.dataset.id);
  return desktopMenu();
});
desk.tabIndex = -1;
const empty = h('div', { class: 'desk-empty', hidden: true }, h('div', {}, h('img', { src: '/assets/mascot-dark.svg', alt: '' }), h('p', { tx: 'desk.empty' })));
desk.prepend(empty);
wm.onChange(() => { empty.hidden = wm.list().some((w) => !w.min); });
net.connect();
window.__hiveBooted = true;

// Remote screen (src/remote/, ui/remote/): the host dialog, the session bar, the viewer windows and a dock entry.
import('/remote/index.js').then(async (m) => {
  m.install();
  const { tr } = await import('/remote/common.js');
  dock.addDockItem({
    id: 'remote-home', label: tr('remote.home.title'),
    content: h('span', { class: 'dk-hex', html: '<svg viewBox="0 0 24 24" class="ico" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>' }),
    onClick: () => window.hivedeskRemote?.openHome(),
  });
}).catch((err) => console.error('remote screen', err));

// The phone remote (ui/phone/): pair a phone by QR, and its grants.
import('/phone/desktop.js').then(async (m) => {
  m.install();
  const { EN } = await import('/phone/strings.js').catch(() => ({ EN: {} }));
  const label = t('phone.button');
  dock.addDockItem({
    id: 'phone', label: label && label !== 'phone.button' ? label : EN['phone.button'] || 'Control from your phone',
    content: h('span', { class: 'dk-hex', html: '<svg viewBox="0 0 24 24" class="ico" aria-hidden="true"><rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M11 18.5h2"/></svg>' }),
    onClick: () => window.hivedeskPhone?.open(),
  });
}).catch((err) => console.error('phone remote', err));

// Keep the desk label up to date for screen readers.
V.effect(() => { void rev.crew; void i18n.L.v; desk.setAttribute('aria-label', t('desk.label')); });
