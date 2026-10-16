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
import { approvalTitle } from './widgets/approvals.js';
import { beeAvatar } from './bees.js';
import { openHire } from './widgets/hire.js';
import { shortModel } from './brainstate.js';
import * as act from './actions.js';

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

const WALLS = [['comb', 'Honeycomb'], ['fine', 'Fine comb'], ['dusk', 'Dusk'], ['plain', 'Plain charcoal']];

function desktopMenu() {
  const open = (t) => () => wm.open(t);
  return [
    { label: 'New window', icon: 'hive', items: [
      { label: 'Timeline', icon: 'plan', action: open('timeline') },
      { label: '#general', icon: 'chat', action: open('chat') },
      { label: 'Files', icon: 'folder', action: open('files') },
      { label: 'Live preview', icon: 'preview', action: open('preview') },
      { label: 'Run log', icon: 'terminal', action: open('runlog') },
      { label: 'Playbooks', icon: 'playbook', action: open('playbooks') },
      { label: 'Replay', icon: 'replay', action: open('replay') },
      { label: 'Approvals', icon: 'approval', action: open('approvals') },
      { sep: true },
      { label: 'Worker chat', icon: 'chat', items: () => S().crew.map((w) => ({ label: w.name, iconEl: dockAv(w), action: () => wm.open('worker', w.id) })) },
      { label: 'Settings', icon: 'model', action: open('settings') },
      { label: 'Lend your PC', icon: 'lend', action: open('lend') },
    ] },
    { label: 'Arrange', icon: 'plan', items: [
      { label: 'Tidy grid', icon: 'hive', action: () => wm.arrange('grid') },
      { label: 'Cascade', icon: 'copy', action: () => wm.arrange('cascade') },
      { label: 'Minimize all', icon: 'stop', action: () => wm.minimizeAll() },
      { sep: true },
      { label: 'Reset layout', icon: 'replay', action: () => resetLayout() },
    ] },
    { label: 'Wallpaper', icon: 'design', items: WALLS.map(([k, label]) => ({ label, checked: ui.wallpaper === k, action: () => setWall(k) })) },
    { sep: true },
    { label: 'Hire a worker', icon: 'hire', disabled: !!ui.replay, action: () => openHire() },
    { label: 'Command palette', icon: 'arrow', kb: 'Ctrl K', action: () => import('./palette.js').then((m) => m.openPalette()) },
  ];
}

function dockAv(w) { return beeAvatar(w, 18, { ring: false }); }

function setWall(k) {
  ui.wallpaper = k;
  desk.dataset.wall = k;
  try { localStorage.setItem('hivedesk.wallpaper', k); } catch {}
}

function windowMenu(id) {
  const w = wm.get(id);
  if (!w) return null;
  const phone = wm.isPhone();
  return [
    { header: w.titleEl.textContent },
    { label: 'Minimize', icon: 'stop', kb: 'Ctrl Alt Down', action: () => wm.minimize(id) },
    { label: w.snap === 'max' ? 'Restore' : 'Maximize', icon: 'preview', kb: 'Ctrl Alt Up', action: () => wm.toggleMax(id) },
    { label: 'Snap left', icon: 'arrow', kb: 'Ctrl Alt Left', disabled: phone, action: () => wm.snap(id, 'left') },
    { label: 'Snap right', icon: 'arrow', kb: 'Ctrl Alt Right', disabled: phone, action: () => wm.snap(id, 'right') },
    { label: 'Snap to a quarter', icon: 'hive', disabled: phone, items: [
      { label: 'Top left', kb: 'Ctrl Alt 1', action: () => wm.snap(id, 'tl') },
      { label: 'Top right', kb: 'Ctrl Alt 2', action: () => wm.snap(id, 'tr') },
      { label: 'Bottom left', kb: 'Ctrl Alt 3', action: () => wm.snap(id, 'bl') },
      { label: 'Bottom right', kb: 'Ctrl Alt 4', action: () => wm.snap(id, 'br') },
    ] },
    { sep: true },
    { label: 'Close', icon: 'x', kb: 'Ctrl Alt W', danger: true, action: () => wm.close(id) },
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
    boot.querySelector('h1').textContent = 'This page needs its secret link';
    boot.querySelector('p').textContent = 'hivedesk only answers the address printed in the terminal, which carries a one time token. Open that address again, or restart with npx hivedesk.';
    boot.querySelector('.spin')?.remove();
    return;
  }
  if (!ui.hello) return; // the boot screen already says "connecting"
  conn.replaceChildren(icon('offline'), h('span', { text: c.state === 'offline' ? `Lost the connection to hivedesk. Retrying in ${Math.max(1, Math.round((c.nextRetryAt - Date.now()) / 1000))} s.` : 'Reconnecting to hivedesk...' }),
    h('button', { type: 'button', class: 'btn btn-xs btn-quiet', text: 'Retry now', on: { click: () => net.retryNow() } }));
  conn.classList.add('on');
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
  boot.classList.add('gone');
  setTimeout(() => boot.setAttribute('hidden', ''), 400);
  if (firstHello) {
    firstHello = false;
    const saved = wm.savedLayout();
    wm.applyLayout(saved?.wins?.length ? saved : defaultLayout());
    if (wm.isPhone()) requestAnimationFrame(() => { desk.scrollTop = 0; });
    if (/(?:^|[#&?])w=[A-Za-z-]+/.test(location.hash + location.search)) wm.open('lend');
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
      if (d.status === 'done') { play('task'); const t = liveState().tasks[d.taskId]; if (t) dock.bounce(`worker:${t.assignee}`); }
      if (d.status === 'failed') { const t = liveState().tasks[d.taskId]; notify({ title: 'A task failed', body: `${t ? `${t.title}. ` : ''}${d.note || 'Mel can retry it or hand it to someone else.'}`, tone: 'bad', sound: 'error', worker: t ? worker(t.assignee) : null }); }
      break;
    case 'job.done': {
      const j = liveState().jobs.find((x) => x.id === ev.jobId);
      notify({ title: 'Job done', body: d.summary || j?.request || '', tone: 'ok', sound: 'job', icon: 'check', actions: [{ label: 'Open preview', primary: true, run: () => wm.open('preview') }, { label: 'Files', run: () => wm.open('files') }] });
      break;
    }
    case 'job.failed': notify({ title: 'The job failed', body: typeof d.error === 'string' ? d.error : d.error?.message || '', tone: 'bad', sound: 'error', actions: [{ label: 'Timeline', run: () => wm.open('timeline') }] }); break;
    case 'job.cancelled': notify({ title: 'Job cancelled', tone: 'info', timeout: 2600 }); break;
    case 'approval.requested': {
      const a = d.approval;
      dock.bounce('approvals');
      notify({
        title: approvalTitle(a), body: a.summary || a.args?.path || a.args?.command || '', tone: 'warn', sound: 'approval', worker: worker(a.workerId), sticky: true, key: `appr-${a.id}`,
        actions: [{ label: 'Approve', primary: true, run: () => act.resolveApproval(a.id, true) }, { label: 'Reject', danger: true, run: () => act.resolveApproval(a.id, false) }, { label: 'Review', run: () => wm.open('approvals') }],
      });
      break;
    }
    case 'approval.resolved': dismissKey(`appr-${d.approvalId}`); break;
    case 'qa.report': if (!d.passed) notify({ title: `QA found ${d.issues?.length || 0} issue${d.issues?.length === 1 ? '' : 's'}`, body: (d.issues || []).slice(0, 2).join(' · '), tone: 'warn', worker: worker('qa'), timeout: 7000 }); break;
    case 'brain.status':
      if (d.state === 'ready' && prevBrain && prevBrain !== 'ready') notify({ title: 'Model ready', body: shortModel(d.model) || 'The crew can start.', tone: 'ok', sound: 'tick' });
      if (d.state === 'error') notify({ title: 'Model error', body: d.detail || 'Open Settings for details.', tone: 'bad', sound: 'error', actions: [{ label: 'Settings', run: () => wm.open('settings') }] });
      prevBrain = d.state;
      break;
    case 'brain.download.failed': notify({ title: 'Model download stopped', body: [d.message, d.hint].filter(Boolean).join(' '), tone: 'bad', sound: 'error', sticky: true, key: 'dl-fail', actions: [{ label: 'Retry', primary: true, run: () => act.startDownload(d.model) }, { label: 'Settings', run: () => wm.open('settings') }] }); break;
    case 'brain.download.finished': notify({ title: 'Model downloaded', body: shortModel(d.model), tone: 'ok', quiet: true }); break;
    case 'brain.fallback': notify({ title: 'Switched to a lighter setup', body: d.reason, tone: 'warn', icon: 'gpu', timeout: 9000 }); break;
    case 'brain.attached': if (d.kind === 'remote') notify({ title: `${d.label} joined as a brain`, body: 'One more worker can take a turn at the same time.', tone: 'ok', icon: 'lend' }); break;
    case 'brain.detached': if (d.reason) notify({ title: 'A brain left', body: d.reason, tone: 'info', icon: 'lend' }); break;
    case 'crew.fired': notify({ title: 'Worker left the crew', tone: 'info', timeout: 2600 }); wm.close(`worker:${d.workerId}`); break;
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
await loadSprite();
desk.dataset.wall = ui.wallpaper;
wm.init(desk);
menu.init();
notifyMod.init();
topbar.init(bar);
dock.init(dockEl, desktopMenu);
menu.provide(desk, (target) => {
  const win = target.closest?.('.win');
  if (win) return windowMenu(win.dataset.id);
  return desktopMenu();
});
desk.tabIndex = -1;
const empty = h('div', { class: 'desk-empty', hidden: true }, h('div', {}, h('img', { src: '/assets/mascot-dark.svg', alt: '' }), h('p', { text: 'Open a window from the dock, or right click the desktop.' })));
desk.prepend(empty);
wm.onChange(() => { empty.hidden = wm.list().some((w) => !w.min); });
net.connect();

// Keep the desk label up to date for screen readers.
V.effect(() => { void rev.crew; desk.setAttribute('aria-label', 'Hive desktop. Right click or Shift F10 for the desktop menu.'); });
