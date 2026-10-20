// Office mode: the crew at work on a refined isometric floor (docs/1.0/DESIGN.md, section 6).
// A full scene that replaces the window desktop (toggle in the top bar), driven by the
// same engine events as every widget. Click a bee to chat, right click for its menu,
// drag a sticky note from Mel's board onto a bee to hand the task over.

import { h, icon, clear, reducedMotion, append } from '/js/dom.js';
import { S, rev, ui, worker, onEvent, currentJob, jobTasks, roleName } from '/js/store.js';
import { t, onLocale } from '/js/i18n.js';
import { mdLine } from '/js/md.js';
import { setTip } from '/js/tooltip.js';
import * as net from '/js/net.js';
import * as wm from '/js/wm.js';
import * as menu from '/js/menu.js';
import * as act from '/js/actions.js';
import { beeAvatar } from '/js/bees.js';
import { track, STATUS_LABEL, TASK_LABEL } from '/js/widgets/util.js';
import { OfficeScene, levelOf, doneCount, dayPhase } from './scene.js';
import * as audio from './audio.js';
import { openWidget, openPip, pipSupported } from './popout.js';

const VIEW_KEY = 'hivedesk.view.v2'; // v2: City became the default home in 0.2.0
// What a bee is doing in the scene, read in the current language when shown (office.mode.*).
export const MODES = ['idle', 'sleep', 'type', 'plan', 'wait', 'stuck', 'test', 'read', 'error', 'celebrate', 'paused', 'fly'];
const modeLabel = (m) => (MODES.includes(m) ? t(`office.mode.${m}`) : '');
export const JOB_STATES = ['refining', 'awaiting_brief', 'planning', 'running', 'done', 'failed', 'cancelled'];
const roleOf = (w) => roleName(w) || t('office.worker');
const statusOf = (w, m, st) => (w.paused ? t('office.mode.paused') : modeLabel(m) || STATUS_LABEL[st.status] || st.status);

let layer;
let scene;
let canvas;
let hud = {};
let hitLayer;
let tip;
let bees = new Map();
let notes = new Map();
let mode = 'desktop';
let hiddenWins = [];
let deskEl;
let seg;
let hourOverride = null;
let shownHoney = null;
let honeyTimer = null;
let drag = null;

function linkCss() {
  if (document.querySelector('link[data-office]')) return;
  document.head.append(h('link', { rel: 'stylesheet', href: '/office/office.css', 'data-office': '' }));
}

function readHourOverride() {
  const q = new URLSearchParams(location.search).get('hour');
  if (q != null && q !== '' && !Number.isNaN(Number(q))) hourOverride = Math.max(0, Math.min(23.99, Number(q)));
}
const hourNow = () => {
  if (hourOverride != null) return hourOverride;
  const d = new Date();
  return d.getHours() + d.getMinutes() / 60;
};

/**
 * Mounts the Office. Hooks: a segmented toggle in the top bar and a dock entry for the
 * mini widget.
 * @param {{ desk: HTMLElement, barRight: HTMLElement|null, addDockItem?: Function }} opts
 */
export function initOffice({ desk, barRight, addDockItem }) {
  linkCss();
  readHourOverride();
  deskEl = desk;
  layer = h('section', { class: 'of-layer', hidden: true, ta: 'office.view.aria' });
  canvas = h('canvas', { class: 'of-canvas', 'aria-hidden': 'true' });
  hitLayer = h('div', { class: 'of-hits' });
  tip = h('div', { class: 'of-tip', role: 'tooltip', id: 'of-tip' });
  layer.append(canvas, hitLayer, buildHud(), tip);
  desk.append(layer);

  scene = new OfficeScene(canvas, {
    getState: S,
    reduced: reducedMotion,
    hour: hourNow,
    onSound: (n) => audio.fx(n),
    honeyTarget: () => {
      const r = hud.honey?.getBoundingClientRect();
      const lr = layer.getBoundingClientRect();
      return r ? { x: r.left - lr.left + 18, y: r.top - lr.top + r.height / 2 } : null;
    },
    onHoney: () => bumpHoney(),
    onFrame: (sc) => { syncHits(sc); audio.setLevels(sc.typingCount || 0, sc.flyingCount || 0); },
  });
  new ResizeObserver(() => { if (mode === 'office') scene.resize(layer.clientWidth, layer.clientHeight); }).observe(layer);

  // the toggle in the top bar
  const segOffice = h('button', { type: 'button', dataset: { v: 'office' }, on: { click: () => setMode('office') } }, officeGlyph(), h('span', { tx: 'office.seg.office' }));
  const segDesk = h('button', { type: 'button', dataset: { v: 'desktop' }, on: { click: () => setMode('desktop') } }, icon('hive', 'ico-sm'), h('span', { tx: 'office.seg.desktop' }));
  seg = h('div', { class: 'of-seg', role: 'group', ta: 'office.seg.aria' }, segOffice, segDesk);
  barRight?.prepend(seg);

  const dockBtn = addDockItem?.({
    id: 'widget', label: t('office.dock.label'), sub: () => t('office.dock.sub'),
    content: h('span', { class: 'dk-hex' }, miniGlyph()),
    onClick: () => openWidget(),
    menu: () => [
      { header: t('office.dock.label') },
      { label: t('office.dock.popOut'), icon: 'preview', action: () => openWidget() },
      { label: t('office.dock.pip'), icon: 'preview', disabled: !pipSupported(), action: () => openPip() },
      { sep: true },
      { label: mode === 'office' ? t('office.dock.toDesktop') : t('office.dock.toOffice'), icon: 'hive', action: () => setMode(mode === 'office' ? 'desktop' : 'office') },
    ],
  });
  // the dock keeps the label it got: keep it in the current language
  const dockTip = () => { if (!dockBtn?.setAttribute) return; dockBtn.setAttribute('aria-label', t('office.dock.label')); setTip(dockBtn, { title: t('office.dock.label'), help: t('office.dock.sub') }); };
  dockBtn?.addEventListener?.('pointerenter', dockTip);
  dockBtn?.addEventListener?.('focus', dockTip);
  const paintStatic = () => {
    segOffice.title = t('office.seg.officeTitle');
    segDesk.title = t('office.seg.desktopTitle');
    dockTip();
  };
  paintStatic();
  onLocale(() => { paintStatic(); paintSound(); if (hud.segs) hud.segs._key = null; paintHud(); });

  // engine wiring
  net.on('hello', () => { scene.reset(); shownHoney = null; paintHud(); });
  onEvent((ev) => {
    scene.handle(ev);
    feed(ev);
    if (ev.type === 'job.done' && mode === 'office') banner(ev);
    if (/^(brief|job)\./.test(ev.type)) paintHud();
  });
  track(() => [rev.jobs, rev.tasks, rev.queue, rev.crew, rev.workers, rev.chat, rev.approvals, ui.replay, ui.demo], () => paintHud());
  track(() => [rev.crew], () => scene.syncCrew(true));

  document.addEventListener('visibilitychange', () => {
    if (mode !== 'office') return;
    if (document.hidden) scene.stop(); else scene.start();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && drag) cancelDrag();
  });

  // City is the default home when it is registered (ui/city/); Office and Desktop stay one click away.
  let start = 'city';
  try { start = localStorage.getItem(VIEW_KEY) || 'city'; } catch { /* ignore */ }
  const q = new URLSearchParams(location.search).get('view');
  if (q) start = q;
  // wait for the first layout of the windows before hiding them
  net.on('hello', once(() => requestAnimationFrame(() => {
    if (start === 'office' || views.has(start)) setMode(start, { quiet: true });
  })));
  paintSeg();
  setInterval(() => { if (mode === 'office') paintClock(); }, 20000);
}

function once(fn) { let done = false; return (...a) => { if (!done) { done = true; fn(...a); } }; }

export function getMode() { return mode; }

/* Other full screen views next to Office and Desktop (the City registers here). */
const views = new Map();

/**
 * Adds a view to the toggle. `enter({ quiet })` shows it; `leave({ quiet, done })` hides it and
 * calls done when it is gone. `first` puts it at the start of the toggle.
 * @param {{ id: string, labelKey: string, titleKey?: string, glyph: () => Node, enter: Function, leave: Function, first?: boolean }} v
 */
export function addView(v) {
  views.set(v.id, v);
  const b = h('button', { type: 'button', dataset: { v: v.id }, tip: v.titleKey, on: { click: () => setMode(v.id) } }, v.glyph(), h('span', { tx: v.labelKey }));
  if (v.first) seg.prepend(b); else seg.append(b);
  seg.dataset.tour = 'office';
  paintSeg();
}

const isScene = (m) => m === 'office' || views.has(m);

export function setMode(next, { quiet = false } = {}) {
  if (next === mode || !(next === 'desktop' || isScene(next))) return;
  const prev = mode;
  mode = next;
  try { localStorage.setItem(VIEW_KEY, mode); } catch { /* ignore */ }
  paintSeg();
  if (isScene(next) && !isScene(prev)) {
    // tuck the open windows into the dock, and bring them back on the desktop
    hiddenWins = wm.list().filter((w) => !w.min).map((w) => w.id);
    for (const id of hiddenWins) wm.minimize(id);
    deskEl.classList.add('of-on');
  }
  const toDesk = () => {
    if (mode !== 'desktop') return;
    deskEl.classList.remove('of-on');
    for (const id of hiddenWins) if (wm.get(id)?.min) wm.restore(id);
    hiddenWins = [];
  };
  if (views.has(prev)) views.get(prev).leave({ quiet: quiet || isScene(next), done: toDesk });
  if (views.has(next)) { if (prev === 'office') leaveOffice(true, () => {}); views.get(next).enter({ quiet }); return; }
  if (mode === 'office') {
    layer.hidden = false;
    scene.resize(layer.clientWidth, layer.clientHeight);
    scene.reset();
    scene.start();
    audio.setActive(true);
    paintHud();
    if (!quiet && !reducedMotion()) layer.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: 'cubic-bezier(.2,0,0,1)' });
  } else if (prev === 'office') leaveOffice(quiet, toDesk);
  else toDesk();
}

function leaveOffice(quiet, after) {
  scene.stop();
  audio.setActive(false);
  hideTip();
  const done = () => { layer.hidden = true; after(); };
  if (reducedMotion() || quiet) done();
  else layer.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 150, easing: 'cubic-bezier(.4,0,1,1)' }).onfinish = done;
}

function paintSeg() {
  if (!seg) return;
  for (const b of seg.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.v === mode));
}

/* ---------- HUD ---------- */
function buildHud() {
  const xpFill = h('i');
  hud.req = h('div', { class: 'of-req' });
  hud.xpText = h('span', { class: 'of-xp-t' });
  hud.xpLv = h('span', { class: 'of-xp-lv' });
  // progress is a segmented timeline: one segment per task, colored by its state
  hud.segs = h('span', { class: 'of-tl', 'aria-hidden': 'true' });
  hud.xp = h('div', { class: 'of-xp', role: 'progressbar', ta: 'office.hud.progress', 'aria-valuemin': '0', 'aria-valuemax': '100' }, xpFill, hud.segs);
  hud.xpFill = xpFill;
  hud.state = h('span', { class: 'of-chip' });
  // waiting for the user's OK on Mel's brief: one clear way to it
  hud.openBrief = h('button', { type: 'button', class: 'btn btn-xs btn-primary of-brief-btn', style: 'justify-self:start', hidden: true, tx: 'office.hud.openBrief', on: { click: () => { setMode('desktop'); wm.open('brief'); } } });
  const job = h('div', { class: 'of-card of-job' },
    h('div', { class: 'of-row' }, h('span', { class: 'of-k', tx: 'office.hud.currentJob' }), hud.state),
    hud.req,
    h('div', { class: 'of-row', style: 'gap:10px' }, hud.xpLv, hud.xp),
    hud.xpText,
    hud.openBrief);

  const doneMark = h('span', { class: 'of-jar', html: CHECK_SVG, 'aria-hidden': 'true' });
  hud.honeyN = h('b', { text: '0' });
  hud.honeyT = h('span', { class: 'of-faint' });
  hud.honey = h('div', { class: 'of-pill of-honey' }, doneMark, hud.honeyN, hud.honeyT);
  hud.clock = h('div', { class: 'of-pill of-clock' });
  hud.sound = h('button', { type: 'button', class: 'of-ib', on: { click: () => { audio.setAmbient(!audio.ambientOn()); paintSound(); } } });
  hud.pop = h('button', { type: 'button', class: 'of-ib', ta: 'office.hud.popOut', on: { click: () => openWidget() } }, miniGlyph());
  hud.pip = h('button', { type: 'button', class: 'of-ib', ta: 'office.hud.pipAria', hidden: !pipSupported(), on: { click: () => openPip() } }, pipGlyph());
  const stats = h('div', { class: 'of-stats' }, hud.honey, hud.clock, h('div', { class: 'of-pill of-tools' }, hud.sound, hud.pop, hud.pip));

  hud.queue = h('div', { class: 'of-card of-queue' });
  hud.feed = h('ol', { class: 'of-card of-feed', ta: 'office.hud.feed', 'aria-live': 'polite' });
  hud.banner = h('div', { class: 'of-banner', role: 'status', hidden: true });
  hud.empty = h('div', { class: 'of-empty', hidden: true });
  paintSound();
  return h('div', { class: 'of-hud' }, job, stats, hud.queue, hud.feed, hud.banner, hud.empty);
}

function paintSound() {
  const on = audio.ambientOn();
  hud.sound.setAttribute('aria-pressed', String(on));
  hud.sound.setAttribute('aria-label', on ? t('office.hud.soundOn') : t('office.hud.soundOff'));
  hud.sound.title = on ? t('office.hud.soundOnTitle') : t('office.hud.soundOff');
  // the other fixed titles of the HUD, in the current language
  hud.honey.title = t('office.hud.honeyTitle');
  hud.pop.title = t('office.hud.popOut');
  hud.pip.title = t('office.hud.pip');
  hud.sound.innerHTML = on
    ? '<svg class="ico" viewBox="0 0 24 24"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4.2 4.2 0 0 1 0 6M18 6.5a8 8 0 0 1 0 11"/></svg>'
    : '<svg class="ico" viewBox="0 0 24 24"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/></svg>';
}

function paintHud() {
  if (!hud.req) return;
  const s = S();
  let j = [...(s.jobs || [])].reverse().find((x) => ['refining', 'awaiting_brief', 'planning', 'running'].includes(x.status)) || currentJob(s);
  if (j && scene?.briefWait && ['planning', 'refining'].includes(j.status)) j = { ...j, status: 'awaiting_brief' };
  else if (j && scene?.briefWrite && j.status === 'planning') j = { ...j, status: 'refining' };
  // job and XP
  if (j) {
    const tasks = jobTasks(s, j);
    // progress is completed tasks of all tasks, nothing weighted; the running task is told in words
    const done = tasks.filter((t) => t.status === 'done' || t.status === 'skipped').length;
    const runningTasks = tasks.filter((t) => t.status === 'running' || t.status === 'review');
    const running = runningTasks.length;
    const total = tasks.length;
    const pct = j.status === 'done' ? 100 : total ? Math.round((done / total) * 100) : 0;
    hud.req.textContent = j.request;
    hud.req.title = j.request;
    hud.xpFill.style.width = `${pct}%`;
    hud.xp.setAttribute('aria-valuenow', String(pct));
    hud.xpLv.textContent = `${pct}%`;
    paintTimeline(tasks);
    if (['refining', 'awaiting_brief', 'planning'].includes(j.status)) hud.xpText.textContent = t(`office.hud.line.${j.status}`);
    else {
      const progress = t('office.hud.done', { done, total });
      let what = running ? nowLine(s, runningTasks[0]) : '';
      if (running > 1) what = t('office.hud.more', { what, count: running - 1 });
      hud.xpText.textContent = running ? t('office.hud.doneNow', { progress, what }) : progress;
    }
    hud.state.textContent = JOB_STATES.includes(j.status) ? t(`office.state.${j.status}`) : j.status;
    hud.state.dataset.s = j.status;
    hud.openBrief.hidden = j.status !== 'awaiting_brief';
  } else {
    hud.req.textContent = t('office.hud.noJob');
    hud.req.title = '';
    hud.xpFill.style.width = '0%';
    hud.xpLv.textContent = '0%';
    hud.xpText.textContent = t('office.hud.noJobHint');
    paintTimeline([]);
    hud.state.textContent = t('office.state.idle');
    hud.state.dataset.s = 'idle';
    hud.openBrief.hidden = true;
  }
  // honey
  const honey = doneCount(s);
  if (shownHoney == null || honey < shownHoney || reducedMotion() || mode !== 'office') shownHoney = honey;
  else if (honey > shownHoney) { clearTimeout(honeyTimer); honeyTimer = setTimeout(() => { shownHoney = doneCount(S()); paintHoney(); }, 1800); }
  paintHoney();
  paintClock();
  // queue, the honest part: one model, workers take turns
  clear(hud.queue);
  const running = s.queue.running || [];
  const waiting = s.queue.waiting || [];
  hud.queue.append(h('div', { class: 'of-k', text: t('office.queue.title') }));
  const row = h('div', { class: 'of-qrow' });
  if (running.length) {
    for (const q of running) row.append(h('span', { class: 'of-q of-q-on', title: t('office.queue.hasModel', { name: worker(q.workerId).name }) }, beeAvatar(worker(q.workerId), 26, { ring: true, status: 'thinking' })));
    if (running.length === 1) row.append(h('span', { class: 'of-qname' }, h('b', { text: worker(running[0].workerId).name }), h('span', { class: 'of-faint', text: mdLine(s.tasks[running[0].taskId]?.title || '', 80) || t('office.queue.thinking') })));
  }
  else row.append(h('span', { class: 'of-faint small', text: t('office.queue.free') }));
  if (waiting.length) {
    row.append(h('span', { class: 'of-qsep', html: '<svg viewBox="0 0 16 16" class="ico ico-sm"><circle cx="8" cy="8" r="6.2"/><path d="M8 4.6V8l2.4 1.6"/></svg>' }));
    for (const q of waiting.slice(0, 6)) row.append(h('span', { class: 'of-q', title: t('office.queue.inQueue', { name: worker(q.workerId).name }) }, beeAvatar(worker(q.workerId), 22, { ring: true })));
    if (waiting.length > 6) row.append(h('span', { class: 'of-faint small', text: `+${waiting.length - 6}` }));
  }
  hud.queue.append(row, h('div', { class: 'of-faint tiny', text: (s.brains || []).length > 1 ? t('office.queue.brains', { count: s.brains.length }) : t('office.queue.oneModel') }));
  // nothing hired yet / no state yet
  hud.empty.hidden = !!(s.crew || []).length;
  hud.empty.textContent = ui.hello ? t('office.empty') : t('office.opening');
}

/** The running task in words: who does what right now, from the worker's real status. */
function nowLine(s, task) {
  if (!task) return '';
  const w = worker(task.assignee);
  const st = s.workers?.[task.assignee] || {};
  const what = NOW_KEYS.includes(st.status) ? st.status : task.status === 'review' ? 'review' : 'works';
  return t(`office.now.${what}`, { name: w.name, title: mdLine(task.title, 80) });
}
const NOW_KEYS = ['thinking', 'tool', 'queued', 'waiting_approval'];

function paintClock() {
  const hr = hourNow();
  const hh = Math.floor(hr); const mm = Math.floor((hr % 1) * 60);
  hud.clock.textContent = `${dayPhase(hr)} · ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function paintHoney() {
  if (hud.honeyN) hud.honeyN.textContent = String(shownHoney ?? 0);
  if (hud.honeyT) hud.honeyT.textContent = t('office.hud.tasksDone', { count: shownHoney ?? 0 });
}
function bumpHoney() {
  const real = doneCount(S());
  shownHoney = Math.min(real, (shownHoney ?? 0) + 1);
  paintHoney();
}

/** The segmented timeline: one segment per task of the job, in order, colored by its state. */
function paintTimeline(tasks) {
  if (!hud.segs) return;
  const key = tasks.map((x) => `${x.id}:${x.status}`).join('|');
  if (hud.segs._key === key) return;
  hud.segs._key = key;
  clear(hud.segs);
  for (const x of tasks) hud.segs.append(h('i', { dataset: { s: x.status }, title: `${mdLine(x.title, 120)}: ${TASK_LABEL[x.status] || x.status}` }));
}

/* activity feed: short, human lines from real events (tx keys, so a language switch rewrites them) */
function feed(ev) {
  if (!hud.feed) return;
  const d = ev.data || {};
  const s = S();
  const name = (id) => worker(id).name;
  const title = (task) => mdLine(task.title, 80);
  let line = null; let tone = '';
  switch (ev.type) {
    case 'job.created': line = ['office.feed.jobCreated']; tone = 'honey'; break;
    case 'job.planned': line = ['office.feed.jobPlanned', { count: d.tasks?.length || 0 }]; break;
    case 'brief.proposed': line = ['office.feed.briefProposed']; tone = 'warn'; break;
    case 'brief.approved': line = [d.source === 'original' ? 'office.feed.briefOriginal' : 'office.feed.briefApproved']; break;
    case 'task.status': {
      const task = s.tasks[d.taskId];
      if (!task) break;
      if (d.status === 'running') line = ['office.feed.started', { name: name(task.assignee), title: title(task) }];
      else if (d.status === 'done') { line = ['office.feed.finished', { name: name(task.assignee), title: title(task) }]; tone = 'ok'; }
      else if (d.status === 'failed') { line = ['office.feed.stuck', { name: name(task.assignee), title: title(task) }]; tone = 'bad'; }
      break;
    }
    case 'file.changed': line = [d.op === 'create' ? 'office.feed.fileCreate' : d.op === 'delete' ? 'office.feed.fileDelete' : 'office.feed.fileEdit', { name: name(d.workerId), path: String(d.path || '') }]; break;
    case 'approval.requested': line = ['office.feed.approval', { name: name(d.approval?.workerId) }]; tone = 'warn'; break;
    case 'qa.report': line = d.passed ? ['office.feed.qaPassed'] : ['office.feed.qaIssues', { count: d.issues?.length || 0 }]; tone = d.passed ? 'ok' : 'bad'; break;
    case 'task.updated': if (d.task?.assignee) line = ['office.feed.handed', { name: name(d.task.assignee) }]; break;
    case 'crew.hired': if (ui.hello && !d.worker?.builtin) { line = ['office.feed.joined', { name: d.worker?.name || '' }]; tone = 'honey'; } break;
    case 'job.done': line = ['office.feed.jobDone']; tone = 'ok'; break;
    default: break;
  }
  if (!line) return;
  const li = h('li', { dataset: { tone } }, h('span', { class: 'of-dot' }), h('span', { tx: line[0], txArgs: line[1] }));
  // the brief waits for the user's OK: the line opens it
  if (ev.type === 'brief.proposed') li.append(h('button', { type: 'button', class: 'btn btn-xs btn-quiet', style: 'margin-left:6px', tx: 'office.hud.openBrief', on: { click: () => { setMode('desktop'); wm.open('brief'); } } }));
  hud.feed.prepend(li);
  while (hud.feed.children.length > 5) hud.feed.lastChild.remove();
  if (!reducedMotion() && mode === 'office') li.animate([{ opacity: 0, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'none' }], { duration: 200, easing: 'cubic-bezier(.2,0,0,1)' });
}

function banner(ev) {
  const b = hud.banner;
  clear(b);
  // a calm activity toast: a check, the summary and one action
  b.append(h('span', { class: 'of-jar of-jar-big', html: CHECK_SVG, 'aria-hidden': 'true' }),
    h('div', {}, h('strong', { tx: 'office.banner.title' }), h('div', { class: 'of-faint', text: mdLine(ev.data?.summary || '', 140) || t('office.banner.fallback') })),
    h('button', { type: 'button', class: 'btn btn-xs btn-quiet', tx: 'office.banner.preview', on: { click: () => { setMode('desktop'); wm.open('preview'); } } }));
  b.hidden = false;
  if (!reducedMotion()) b.animate([{ opacity: 0, transform: 'translate(-50%, 6px)' }, { opacity: 1, transform: 'translate(-50%, 0)' }], { duration: 200, easing: 'cubic-bezier(.2,0,0,1)' });
  clearTimeout(b._t);
  b._t = setTimeout(() => { b.hidden = true; }, 7000);
}

/* ---------- the DOM layer over the canvas: focus, hover, click, menus, drag ---------- */
function syncHits(sc) {
  const s = S();
  // bees
  const seen = new Set();
  for (const hit of sc.hits) {
    seen.add(hit.id);
    let b = bees.get(hit.id);
    if (!b) b = makeBee(hit.id);
    const tx = Math.round(hit.x); const ty = Math.round(hit.y);
    if (b._x !== tx || b._y !== ty || b._w !== Math.round(hit.w)) {
      b._x = tx; b._y = ty; b._w = Math.round(hit.w);
      b.style.transform = `translate(${tx}px, ${ty}px)`;
      b.style.width = `${Math.round(hit.w)}px`;
      b.style.height = `${Math.round(hit.h)}px`;
    }
    const a = sc.actors.get(hit.id);
    const label = beeLabel(hit.id, a, s);
    if (b._label !== label) { b._label = label; b.setAttribute('aria-label', label); if (tip.dataset.for === `bee:${hit.id}`) showTip(b, hit.id); }
  }
  for (const [id, b] of bees) if (!seen.has(id)) { b.remove(); bees.delete(id); }
  // notes
  const nseen = new Set();
  for (const hit of sc.noteHits) {
    nseen.add(hit.id);
    let n = notes.get(hit.id);
    if (!n) n = makeNote(hit.id);
    const tx = Math.round(hit.x); const ty = Math.round(hit.y);
    if (n._x !== tx || n._y !== ty) {
      n._x = tx; n._y = ty;
      n.style.transform = `translate(${tx}px, ${ty}px)`;
      n.style.width = `${Math.round(hit.w)}px`;
      n.style.height = `${Math.round(hit.h)}px`;
    }
    const task = s.tasks[hit.id];
    const label = task ? t('office.note.aria', { title: mdLine(task.title, 120), status: TASK_LABEL[task.status] || task.status, name: worker(task.assignee).name }) : t('office.note.task');
    if (n._label !== label) { n._label = label; n.setAttribute('aria-label', label); }
  }
  for (const [id, n] of notes) if (!nseen.has(id) && !(drag && drag.taskId === id)) { n.remove(); notes.delete(id); }
}

function beeLabel(id, a, s) {
  const w = worker(id);
  const st = s.workers[id] || { status: 'idle' };
  const task = st.taskId && s.tasks[st.taskId];
  const m = a ? (a.seg ? 'fly' : a.mode) : 'idle';
  const lv = levelOf(s, id);
  const who = lv != null ? t('office.bee.whoLevel', { name: w.name, role: roleOf(w), level: lv }) : t('office.bee.who', { name: w.name, role: roleOf(w) });
  const status = statusOf(w, m, st);
  return task ? t('office.bee.ariaTask', { who, status, title: mdLine(task.title, 120) }) : t('office.bee.aria', { who, status });
}

function makeBee(id) {
  const b = h('button', { type: 'button', class: 'of-bee', 'aria-describedby': 'of-tip', dataset: { id } });
  b.addEventListener('click', () => { if (!drag) wm.open('worker', id); });
  b.addEventListener('pointerenter', () => { scene.highlight = id; showTip(b, id); });
  b.addEventListener('pointerleave', () => { if (scene.highlight === id) scene.highlight = null; hideTip(); });
  b.addEventListener('focus', () => { scene.highlight = id; showTip(b, id); });
  b.addEventListener('blur', () => { if (scene.highlight === id) scene.highlight = null; hideTip(); });
  menu.provide(b, () => beeMenu(id));
  hitLayer.append(b);
  bees.set(id, b);
  return b;
}

function beeMenu(id) {
  const w = worker(id);
  const s = S();
  const st = s.workers[id] || {};
  const mine = Object.values(s.tasks).filter((x) => x.assignee === id);
  const retryable = mine.filter((x) => ['failed', 'blocked'].includes(x.status)).pop() || (st.taskId && s.tasks[st.taskId]);
  const lv = levelOf(s, id);
  return [
    { header: lv != null ? t('office.menu.headerLevel', { name: w.name, role: roleOf(w), level: lv }) : t('office.menu.header', { name: w.name, role: roleOf(w) }) },
    { label: t('office.menu.chat', { name: w.name }), icon: 'chat', action: () => wm.open('worker', id) },
    { label: w.paused ? t('office.menu.resume') : t('office.menu.pause'), icon: w.paused ? 'arrow' : 'stop', disabled: !!ui.replay, action: () => act.pauseWorker(id, !w.paused) },
    { label: retryable ? t('office.menu.retryTask', { title: mdLine(retryable.title, 60) }) : t('office.menu.retryNone'), icon: 'replay', disabled: !retryable || !!ui.replay, action: () => act.retryTask(retryable.id) },
    { label: t('office.menu.files'), icon: 'folder', action: () => { setMode('desktop'); wm.open('files'); } },
  ];
}

function makeNote(id) {
  const n = h('button', { type: 'button', class: 'of-note', 'aria-describedby': 'of-tip', dataset: { id } });
  n.addEventListener('pointerenter', () => { scene.highlight = id; showNoteTip(n, id); });
  n.addEventListener('pointerleave', () => { if (scene.highlight === id) scene.highlight = null; hideTip(); });
  n.addEventListener('focus', () => { scene.highlight = id; showNoteTip(n, id); });
  n.addEventListener('blur', () => { if (scene.highlight === id) scene.highlight = null; hideTip(); });
  n.addEventListener('click', (e) => {
    if (n._dragged) { n._dragged = false; return; }
    const r = n.getBoundingClientRect();
    menu.open({ x: e.clientX || r.left + 10, y: e.clientY || r.bottom, items: noteMenu(id) });
  });
  n.addEventListener('pointerdown', (e) => startDrag(e, n, id));
  menu.provide(n, () => noteMenu(id));
  hitLayer.append(n);
  notes.set(id, n);
  return n;
}

function noteMenu(id) {
  const s = S();
  const task = s.tasks[id];
  if (!task) return null;
  const off = !!ui.replay || task.status === 'done';
  return [
    { header: mdLine(task.title, 60) },
    { label: t('office.menu.handTo'), icon: 'hire', disabled: off, items: s.crew.filter((w) => w.id !== task.assignee).map((w) => ({ label: t('office.menu.handToWho', { name: w.name, role: roleOf(w) }), iconEl: beeAvatar(w, 18, { ring: false }), action: () => reassign(id, w.id) })) },
    { label: t('office.menu.retry'), icon: 'replay', disabled: !!ui.replay || !['failed', 'blocked', 'done', 'skipped'].includes(task.status), action: () => act.retryTask(id) },
    { label: t('office.menu.cancel'), icon: 'x', danger: true, disabled: !!ui.replay || ['done', 'skipped'].includes(task.status), action: () => act.cancelTask(id) },
  ];
}

function reassign(taskId, workerId) {
  const task = S().tasks[taskId];
  if (!task || task.assignee === workerId) return;
  act.reassignTask(taskId, workerId);
}

function startDrag(e, el, id) {
  if (e.button !== 0 || ui.replay) return;
  const task = S().tasks[id];
  if (!task || task.status === 'done') return;
  const x0 = e.clientX; const y0 = e.clientY;
  let ghost = null;
  const move = (ev) => {
    if (!drag && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6) return;
    if (!drag) {
      drag = { taskId: id, el };
      scene.dragTask = id;
      ghost = h('div', { class: 'of-drag', 'aria-hidden': 'true' }, h('i', { style: `background:${worker(task.assignee).color}` }), h('span', { text: mdLine(task.title, 60) }));
      layer.append(ghost);
      layer.classList.add('of-dragging');
      hideTip();
    }
    const lr = layer.getBoundingClientRect();
    ghost.style.transform = `translate(${ev.clientX - lr.left + 8}px, ${ev.clientY - lr.top + 8}px) rotate(-4deg)`;
    const over = beeAt(ev.clientX, ev.clientY);
    scene.highlight = over || null;
    drag.over = over;
  };
  const up = () => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    removeEventListener('pointercancel', up);
    if (!drag) return;
    el._dragged = true;
    const target = drag.over;
    ghost?.remove();
    layer.classList.remove('of-dragging');
    scene.dragTask = null;
    scene.highlight = null;
    drag = null;
    if (target) reassign(id, target);
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
  addEventListener('pointercancel', up);
}

function cancelDrag() {
  layer.querySelector('.of-drag')?.remove();
  layer.classList.remove('of-dragging');
  scene.dragTask = null;
  scene.highlight = null;
  drag = null;
}

function beeAt(x, y) {
  for (const [id, b] of bees) {
    const r = b.getBoundingClientRect();
    if (x >= r.left - 6 && x <= r.right + 6 && y >= r.top - 6 && y <= r.bottom + 6) return id;
  }
  return null;
}

function showTip(el, id) {
  const s = S();
  const w = worker(id);
  const a = scene.actors.get(id);
  const st = s.workers[id] || { status: 'idle' };
  const task = st.taskId && s.tasks[st.taskId];
  const m = a ? (a.seg ? 'fly' : a.mode) : 'idle';
  const lastTask = task || Object.values(s.tasks).filter((x) => x.assignee === id && x.status === 'running').pop();
  const done = Object.values(s.tasks).filter((x) => x.assignee === id && x.status === 'done').length;
  const lv = levelOf(s, id);
  clear(tip);
  tip.append(
    h('div', { class: 'of-tip-h' }, beeAvatar(w, 30, { ring: true }), h('div', {}, h('strong', { text: w.name }), h('div', { class: 'of-faint', text: roleOf(w) })), lv != null ? h('span', { class: 'of-lv', text: t('office.level', { level: lv }) }) : null),
    h('div', { class: 'of-tip-r' }, h('span', { class: 'of-faint', tx: 'office.tip.status' }), h('span', { text: statusOf(w, m, st) })),
    h('div', { class: 'of-tip-r' }, h('span', { class: 'of-faint', tx: 'office.tip.task' }), h('span', { text: lastTask ? mdLine(lastTask.title, 80) : t('office.tip.none') })),
    h('div', { class: 'of-tip-r' }, h('span', { class: 'of-faint', tx: 'office.tip.done' }), h('span', { text: t('office.tip.doneCount', { count: done }) })),
    h('div', { class: 'of-tip-f', tx: 'office.tip.foot' }));
  tip.dataset.for = `bee:${id}`;
  place(el);
}

function showNoteTip(el, id) {
  const s = S();
  const task = s.tasks[id];
  if (!task) return;
  clear(tip);
  append(tip, [h('div', { class: 'of-tip-h' }, h('div', {}, h('strong', { text: mdLine(task.title, 120) }), h('div', { class: 'of-faint', text: t('office.tip.noteMeta', { status: TASK_LABEL[task.status] || task.status, name: worker(task.assignee).name }) }))),
    task.detail ? h('div', { class: 'of-tip-d', text: mdLine(task.detail, 180) }) : null,
    h('div', { class: 'of-tip-f', tx: task.status === 'done' ? 'office.tip.noteDone' : 'office.tip.noteFoot' })]);
  tip.dataset.for = `note:${id}`;
  place(el);
}

function place(el) {
  const r = el.getBoundingClientRect();
  const lr = layer.getBoundingClientRect();
  tip.classList.add('on');
  const tr = tip.getBoundingClientRect();
  let x = r.left - lr.left + r.width / 2 - tr.width / 2;
  let y = r.top - lr.top - tr.height - 10;
  if (y < 8) y = r.bottom - lr.top + 10;
  x = Math.max(8, Math.min(lr.width - tr.width - 8, x));
  tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
}
function hideTip() { tip?.classList.remove('on'); if (tip) tip.dataset.for = ''; }

/* ---------- glyphs ---------- */
function officeGlyph() {
  return h('span', { class: 'of-gl', html: '<svg viewBox="0 0 24 24" class="ico ico-sm"><path d="M12 3 21 8v8l-9 5-9-5V8z"/><path d="M3 8l9 5 9-5M12 13v8"/></svg>' });
}
function miniGlyph() {
  return h('span', { class: 'of-gl', html: '<svg viewBox="0 0 24 24" class="ico"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><rect x="11.5" y="11.5" width="7" height="6" rx="1.2"/></svg>' });
}
function pipGlyph() {
  return h('span', { class: 'of-gl', html: '<svg viewBox="0 0 24 24" class="ico"><rect x="3.5" y="5" width="17" height="14" rx="2.5"/><path d="M13 12.5h5.5v4.5H13z"/><path d="M7 9l3 3M7 9h2.6M7 9v2.6"/></svg>' });
}
const CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M8.2 12.2l2.6 2.6 5-5.2"/></svg>';
