// Office mode: the crew at work in a little isometric honeycomb office.
// A full scene that replaces the window desktop (toggle in the top bar), driven by the
// same engine events as every widget. Click a bee to chat, right click for its menu,
// drag a sticky note from Mel's board onto a bee to hand the task over.

import { h, icon, clear, reducedMotion } from '/js/dom.js';
import { S, rev, ui, worker, onEvent, currentJob, jobTasks } from '/js/store.js';
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
const MODE_LABEL = {
  idle: 'Idle', sleep: 'Napping (idle)', type: 'Typing', plan: 'Planning on the board', wait: 'In the queue for the model',
  stuck: 'Waiting for your approval', test: 'Running checks', read: 'Reading files', error: 'Error', celebrate: 'Celebrating',
  paused: 'Paused', fly: 'Flying over',
};

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
  layer = h('section', { class: 'of-layer', hidden: true, 'aria-label': 'Office. The crew at work. Tab to a bee or a note, Enter to open, Shift F10 for its menu.' });
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
  seg = h('div', { class: 'of-seg', role: 'group', 'aria-label': 'View' },
    h('button', { type: 'button', dataset: { v: 'office' }, title: 'Office: the crew at work', on: { click: () => setMode('office') } }, officeGlyph(), h('span', { text: 'Office' })),
    h('button', { type: 'button', dataset: { v: 'desktop' }, title: 'Desktop: windows and widgets', on: { click: () => setMode('desktop') } }, icon('hive', 'ico-sm'), h('span', { text: 'Desktop' })));
  barRight?.prepend(seg);

  addDockItem?.({
    id: 'widget', label: 'Mini widget', sub: 'a small always on view',
    content: h('span', { class: 'dk-hex' }, miniGlyph()),
    onClick: () => openWidget(),
    menu: () => [
      { header: 'Mini widget' },
      { label: 'Pop out a window (360 by 480)', icon: 'preview', action: () => openWidget() },
      { label: 'Picture in picture', icon: 'preview', disabled: !pipSupported(), action: () => openPip() },
      { sep: true },
      { label: mode === 'office' ? 'Back to the desktop' : 'Open the Office', icon: 'hive', action: () => setMode(mode === 'office' ? 'desktop' : 'office') },
    ],
  });

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
    if (!quiet && !reducedMotion()) layer.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, easing: 'ease-out' });
  } else if (prev === 'office') leaveOffice(quiet, toDesk);
  else toDesk();
}

function leaveOffice(quiet, after) {
  scene.stop();
  audio.setActive(false);
  hideTip();
  const done = () => { layer.hidden = true; after(); };
  if (reducedMotion() || quiet) done();
  else layer.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180, easing: 'ease-in' }).onfinish = done;
}

function paintSeg() {
  if (!seg) return;
  for (const b of seg.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.v === mode));
}

/* ---------- HUD ---------- */
function buildHud() {
  const xpFill = h('i');
  const xpGlow = h('b');
  hud.req = h('div', { class: 'of-req' });
  hud.xpText = h('span', { class: 'of-xp-t' });
  hud.xpLv = h('span', { class: 'of-xp-lv' });
  hud.xp = h('div', { class: 'of-xp', role: 'progressbar', 'aria-label': 'Job progress', 'aria-valuemin': '0', 'aria-valuemax': '100' }, xpFill, xpGlow);
  hud.xpFill = xpFill;
  hud.state = h('span', { class: 'of-chip' });
  const job = h('div', { class: 'of-card of-job' },
    h('div', { class: 'of-row' }, h('span', { class: 'of-k', text: 'Current job' }), hud.state),
    hud.req,
    h('div', { class: 'of-row', style: 'gap:10px' }, hud.xpLv, hud.xp),
    hud.xpText);

  const jarCanvasFree = h('span', { class: 'of-jar', html: JAR_SVG, 'aria-hidden': 'true' });
  hud.honeyN = h('b', { text: '0' });
  hud.honey = h('div', { class: 'of-pill of-honey', title: 'Honey: one jar for every finished task' }, jarCanvasFree, hud.honeyN, h('span', { class: 'of-faint', text: 'honey' }));
  hud.clock = h('div', { class: 'of-pill of-clock' });
  hud.sound = h('button', { type: 'button', class: 'of-ib', on: { click: () => { audio.setAmbient(!audio.ambientOn()); paintSound(); } } });
  const pop = h('button', { type: 'button', class: 'of-ib', title: 'Pop out the mini widget', 'aria-label': 'Pop out the mini widget', on: { click: () => openWidget() } }, miniGlyph());
  const pip = h('button', { type: 'button', class: 'of-ib', title: 'Picture in picture', 'aria-label': 'Picture in picture mini window', hidden: !pipSupported(), on: { click: () => openPip() } }, pipGlyph());
  const stats = h('div', { class: 'of-stats' }, hud.honey, hud.clock, h('div', { class: 'of-pill of-tools' }, hud.sound, pop, pip));

  hud.queue = h('div', { class: 'of-card of-queue' });
  hud.feed = h('ol', { class: 'of-card of-feed', 'aria-label': 'Office activity', 'aria-live': 'polite' });
  hud.banner = h('div', { class: 'of-banner', role: 'status', hidden: true });
  hud.empty = h('div', { class: 'of-empty', hidden: true });
  paintSound();
  return h('div', { class: 'of-hud' }, job, stats, hud.queue, hud.feed, hud.banner, hud.empty);
}

function paintSound() {
  const on = audio.ambientOn();
  hud.sound.setAttribute('aria-pressed', String(on));
  hud.sound.setAttribute('aria-label', on ? 'Office sounds on' : 'Office sounds off');
  hud.sound.title = on ? 'Office sounds on (soft room tone, typing, wings)' : 'Office sounds off';
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
    const done = tasks.filter((t) => t.status === 'done' || t.status === 'skipped').length;
    const running = tasks.filter((t) => t.status === 'running' || t.status === 'review').length;
    const total = tasks.length;
    const pct = j.status === 'done' ? 100 : total ? Math.round(((done + running * 0.4) / total) * 100) : (['planning', 'refining', 'awaiting_brief'].includes(j.status) ? 4 : 0);
    hud.req.textContent = j.request;
    hud.req.title = j.request;
    hud.xpFill.style.width = `${pct}%`;
    hud.xp.setAttribute('aria-valuenow', String(pct));
    hud.xpLv.textContent = `${pct}%`;
    hud.xpText.textContent = {
      refining: 'Mel is writing a clear brief from your request',
      awaiting_brief: 'Mel waits for you: check the brief in its window',
      planning: 'Mel is writing the plan on the board',
    }[j.status] || `${done} of ${total} tasks done${running ? `, ${running} in progress` : ''}`;
    hud.state.textContent = { refining: 'Brief', awaiting_brief: 'Waiting for you', planning: 'Planning', running: 'Working', done: 'Done', failed: 'Failed', cancelled: 'Cancelled' }[j.status] || j.status;
    hud.state.dataset.s = j.status;
  } else {
    hud.req.textContent = 'No job yet. Ask the crew in the box above.';
    hud.xpFill.style.width = '0%';
    hud.xpLv.textContent = '0%';
    hud.xpText.textContent = 'Every finished task fills the bar and adds a jar of honey.';
    hud.state.textContent = 'Resting';
    hud.state.dataset.s = 'idle';
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
  hud.queue.append(h('div', { class: 'of-k', text: 'Turn on the model' }));
  const row = h('div', { class: 'of-qrow' });
  if (running.length) {
    for (const q of running) row.append(h('span', { class: 'of-q of-q-on', title: `${worker(q.workerId).name} has the model now` }, beeAvatar(worker(q.workerId), 26, { ring: true, status: 'thinking' })));
    if (running.length === 1) row.append(h('span', { class: 'of-qname' }, h('b', { text: worker(running[0].workerId).name }), h('span', { class: 'of-faint', text: s.tasks[running[0].taskId]?.title || 'thinking' })));
  }
  else row.append(h('span', { class: 'of-faint small', text: 'The model is free' }));
  if (waiting.length) {
    row.append(h('span', { class: 'of-qsep', html: '<svg viewBox="0 0 16 16" class="ico ico-sm"><circle cx="8" cy="8" r="6.2"/><path d="M8 4.6V8l2.4 1.6"/></svg>' }));
    for (const q of waiting.slice(0, 6)) row.append(h('span', { class: 'of-q', title: `${worker(q.workerId).name} is in the queue` }, beeAvatar(worker(q.workerId), 22, { ring: true })));
    if (waiting.length > 6) row.append(h('span', { class: 'of-faint small', text: `+${waiting.length - 6}` }));
  }
  hud.queue.append(row, h('div', { class: 'of-faint tiny', text: (s.brains || []).length > 1 ? `${s.brains.length} brains attached, so ${s.brains.length} bees can think at once.` : 'One shared model: the bees take turns, so a job takes minutes.' }));
  // nothing hired yet / no state yet
  hud.empty.hidden = !!(s.crew || []).length;
  hud.empty.textContent = ui.hello ? 'The office is empty.' : 'Opening the office...';
}

function paintClock() {
  const hr = hourNow();
  const hh = Math.floor(hr); const mm = Math.floor((hr % 1) * 60);
  hud.clock.textContent = `${dayPhase(hr)} · ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function paintHoney() { if (hud.honeyN) hud.honeyN.textContent = String(shownHoney ?? 0); }
function bumpHoney() {
  const real = doneCount(S());
  shownHoney = Math.min(real, (shownHoney ?? 0) + 1);
  paintHoney();
  if (!reducedMotion()) hud.honey.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.18)' }, { transform: 'scale(1)' }], { duration: 380, easing: 'cubic-bezier(.2,.8,.2,1.4)' });
}

/* activity feed: short, human lines from real events */
function feed(ev) {
  if (!hud.feed) return;
  const d = ev.data || {};
  const s = S();
  const name = (id) => worker(id).name;
  let line = null; let tone = '';
  switch (ev.type) {
    case 'job.created': line = 'New job on the board'; tone = 'honey'; break;
    case 'job.planned': line = `Mel planned ${d.tasks?.length || 0} tasks`; break;
    case 'brief.proposed': line = 'Mel wrote a brief: use it, edit it or keep yours'; tone = 'warn'; break;
    case 'brief.approved': line = d.source === 'original' ? 'Working from your words' : 'Brief approved, planning'; break;
    case 'task.status': {
      const t = s.tasks[d.taskId];
      if (!t) break;
      if (d.status === 'running') line = `${name(t.assignee)} started "${t.title}"`;
      else if (d.status === 'done') { line = `${name(t.assignee)} finished "${t.title}" +1 honey`; tone = 'ok'; }
      else if (d.status === 'failed') { line = `${name(t.assignee)} is stuck on "${t.title}"`; tone = 'bad'; }
      break;
    }
    case 'file.changed': line = `${name(d.workerId)} ${d.op === 'create' ? 'wrote' : d.op === 'delete' ? 'deleted' : 'edited'} ${d.path}`; break;
    case 'approval.requested': line = `${name(d.approval?.workerId)} waits for your approval`; tone = 'warn'; break;
    case 'qa.report': line = d.passed ? 'QA: all checks passed' : `QA found ${d.issues?.length || 0} issue${d.issues?.length === 1 ? '' : 's'}`; tone = d.passed ? 'ok' : 'bad'; break;
    case 'task.updated': if (d.task?.assignee) line = `Task handed to ${name(d.task.assignee)}`; break;
    case 'crew.hired': if (ui.hello && !d.worker?.builtin) { line = `${d.worker?.name} joined the crew, building a desk`; tone = 'honey'; } break;
    case 'job.done': line = 'Job done! Party at the hive'; tone = 'ok'; break;
    default: break;
  }
  if (!line) return;
  const li = h('li', { dataset: { tone } }, h('span', { class: 'of-dot' }), h('span', { text: line }));
  hud.feed.prepend(li);
  while (hud.feed.children.length > 5) hud.feed.lastChild.remove();
  if (!reducedMotion() && mode === 'office') li.animate([{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: 'ease-out' });
}

function banner(ev) {
  const b = hud.banner;
  clear(b);
  b.append(h('span', { class: 'of-jar of-jar-big', html: JAR_SVG, 'aria-hidden': 'true' }),
    h('div', {}, h('strong', { text: 'Job done!' }), h('div', { class: 'of-faint', text: String(ev.data?.summary || 'The crew finished the job.').slice(0, 140) })),
    h('button', { type: 'button', class: 'btn btn-xs btn-quiet', text: 'Open preview', on: { click: () => { setMode('desktop'); wm.open('preview'); } } }));
  b.hidden = false;
  if (!reducedMotion()) b.animate([{ opacity: 0, transform: 'translate(-50%, -14px) scale(.96)' }, { opacity: 1, transform: 'translate(-50%, 0) scale(1)' }], { duration: 420, easing: 'cubic-bezier(.16,1,.3,1)' });
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
    const t = s.tasks[hit.id];
    const label = t ? `Task: ${t.title}. ${TASK_LABEL[t.status] || t.status}. Assigned to ${worker(t.assignee).name}. Enter to hand it to another bee.` : 'Task';
    if (n._label !== label) { n._label = label; n.setAttribute('aria-label', label); }
  }
  for (const [id, n] of notes) if (!nseen.has(id) && !(drag && drag.taskId === id)) { n.remove(); notes.delete(id); }
}

function beeLabel(id, a, s) {
  const w = worker(id);
  const st = s.workers[id] || { status: 'idle' };
  const t = st.taskId && s.tasks[st.taskId];
  const m = a ? (a.seg ? 'fly' : a.mode) : 'idle';
  return `${w.name}, ${w.role || 'worker'}, level ${levelOf(s, id)}. ${w.paused ? 'Paused' : MODE_LABEL[m] || STATUS_LABEL[st.status] || st.status}${t ? `. Task: ${t.title}` : ''}. Enter to chat.`;
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
  const mine = Object.values(s.tasks).filter((t) => t.assignee === id);
  const retryable = mine.filter((t) => ['failed', 'blocked'].includes(t.status)).pop() || (st.taskId && s.tasks[st.taskId]);
  return [
    { header: `${w.name} · ${w.role || 'worker'} · level ${levelOf(s, id)}` },
    { label: `Chat with ${w.name}`, icon: 'chat', action: () => wm.open('worker', id) },
    { label: w.paused ? 'Resume' : 'Pause', icon: w.paused ? 'arrow' : 'stop', disabled: !!ui.replay, action: () => act.pauseWorker(id, !w.paused) },
    { label: retryable ? `Retry "${retryable.title}"` : 'Retry (nothing to retry)', icon: 'replay', disabled: !retryable || !!ui.replay, action: () => act.retryTask(retryable.id) },
    { label: 'Open files', icon: 'folder', action: () => { setMode('desktop'); wm.open('files'); } },
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
  const t = s.tasks[id];
  if (!t) return null;
  const off = !!ui.replay || t.status === 'done';
  return [
    { header: t.title },
    { label: 'Hand to', icon: 'hire', disabled: off, items: s.crew.filter((w) => w.id !== t.assignee).map((w) => ({ label: `${w.name} (${w.role || 'worker'})`, iconEl: beeAvatar(w, 18, { ring: false }), action: () => reassign(id, w.id) })) },
    { label: 'Retry', icon: 'replay', disabled: !!ui.replay || !['failed', 'blocked', 'done', 'skipped'].includes(t.status), action: () => act.retryTask(id) },
    { label: 'Cancel task', icon: 'x', danger: true, disabled: !!ui.replay || ['done', 'skipped'].includes(t.status), action: () => act.cancelTask(id) },
  ];
}

function reassign(taskId, workerId) {
  const t = S().tasks[taskId];
  if (!t || t.assignee === workerId) return;
  act.reassignTask(taskId, workerId);
}

function startDrag(e, el, id) {
  if (e.button !== 0 || ui.replay) return;
  const t = S().tasks[id];
  if (!t || t.status === 'done') return;
  const x0 = e.clientX; const y0 = e.clientY;
  let ghost = null;
  const move = (ev) => {
    if (!drag && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6) return;
    if (!drag) {
      drag = { taskId: id, el };
      scene.dragTask = id;
      ghost = h('div', { class: 'of-drag', 'aria-hidden': 'true' }, h('i', { style: `background:${worker(t.assignee).color}` }), h('span', { text: t.title }));
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
  const t = st.taskId && s.tasks[st.taskId];
  const m = a ? (a.seg ? 'fly' : a.mode) : 'idle';
  const lastTask = t || Object.values(s.tasks).filter((x) => x.assignee === id && x.status === 'running').pop();
  const done = Object.values(s.tasks).filter((x) => x.assignee === id && x.status === 'done').length;
  clear(tip);
  tip.append(
    h('div', { class: 'of-tip-h' }, beeAvatar(w, 30, { ring: true }), h('div', {}, h('strong', { text: w.name }), h('div', { class: 'of-faint', text: w.role || 'worker' })), h('span', { class: 'of-lv', text: `Lv ${levelOf(s, id)}` })),
    h('div', { class: 'of-tip-r' }, h('span', { class: 'of-faint', text: 'Status' }), h('span', { text: w.paused ? 'Paused' : MODE_LABEL[m] || STATUS_LABEL[st.status] || st.status })),
    h('div', { class: 'of-tip-r' }, h('span', { class: 'of-faint', text: 'Task' }), h('span', { text: lastTask ? lastTask.title : 'None right now' })),
    h('div', { class: 'of-tip-r' }, h('span', { class: 'of-faint', text: 'Done' }), h('span', { text: `${done} task${done === 1 ? '' : 's'}` })),
    h('div', { class: 'of-tip-f', text: 'Click to chat · right click for more' }));
  tip.dataset.for = `bee:${id}`;
  place(el);
}

function showNoteTip(el, id) {
  const s = S();
  const t = s.tasks[id];
  if (!t) return;
  clear(tip);
  tip.append(h('div', { class: 'of-tip-h' }, h('div', {}, h('strong', { text: t.title }), h('div', { class: 'of-faint', text: `${TASK_LABEL[t.status] || t.status} · ${worker(t.assignee).name}` }))),
    t.detail ? h('div', { class: 'of-tip-d', text: String(t.detail).slice(0, 180) }) : null,
    h('div', { class: 'of-tip-f', text: t.status === 'done' ? 'Done' : 'Drag onto a bee to hand it over · Enter for options' }));
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
const JAR_SVG = '<svg viewBox="0 0 24 24"><rect x="5" y="3.2" width="14" height="4" rx="1.4" fill="#7A4A1E" stroke="#24160C" stroke-width="1.2"/><rect x="5.6" y="6.4" width="12.8" height="14.4" rx="3.6" fill="#F3A42A" stroke="#24160C" stroke-width="1.2"/><rect x="7.6" y="9" width="2.2" height="8" rx="1.1" fill="#FFD072"/><path d="M13.6 11.4l2 1.15v2.3l-2 1.15-2-1.15v-2.3z" fill="#FFF1CF"/></svg>';
