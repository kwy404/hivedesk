// City mode: the default home. One canvas (ui/city/scene.js) under a light DOM layer for the
// HUD, the task board, the agent card, the machine and room panels and everyone's cursor.
// State: the engine's CityState reduced by the engine's own reducer (/lib/city.js), or the local
// mock (?city=mock, ui/city/mock.js), or, on an engine without a city, a city derived from the crew.

import { h, clear, append, reducedMotion } from '/js/dom.js';
import * as net from '/js/net.js';
import * as wm from '/js/wm.js';
import * as menu from '/js/menu.js';
import { S, ui, extra, onEvent } from '/js/store.js';
import { t, onLocale, fmtNumber } from '/js/i18n.js';
import { notify } from '/js/notify.js';
import { beeAvatar } from '/js/bees.js';
import * as audio from '/office/audio.js';
import { CityScene } from './scene.js';
import { viewOf, blankLive, noteEvent, applyLive, deriveCity, xpProgress, xpFor, fmtVram, borrowOf, pendingOf, ROOM_KINDS, ROOM_COLOR } from './model.js';
import { roomAt, ROOMS } from './layout.js';
import { wireCollab, onCityEvent as collabEvent } from './collab.js';

const st = { mode: 'none', lib: null, city: null, live: blankLive(), view: viewOf(null), mock: null };
let layer; let canvas; let scene; let hitLayer; let cursorLayer; let hud = {};
let active = false;
let office = null;
const bees = new Map();
const cursors = new Map();
let side = null; // { kind: 'agent' | 'machine' | 'room', id }
let drag = null;
let pending = false;
let lastPresence = 0;
let memoryEdit = null; // { agentId, entries }
let hourOverride = null;

const tr = (k, p) => t(k, p);
const roomName = (k) => (ROOMS[k] || ROOM_KINDS.includes(k) ? tr(`city.room.${k}`) : (st.view.rooms[k]?.name || k));
const agentName = (id) => st.view.agents[id]?.name || id || '';
const machineName = (id) => st.view.machines[id]?.name || id || '';

function linkCss() {
  if (document.querySelector('link[data-city]')) return;
  document.head.append(h('link', { rel: 'stylesheet', href: '/city/city.css', 'data-city': '' }));
}

function readHour() {
  const q = new URLSearchParams(location.search).get('hour');
  if (q != null && q !== '' && !Number.isNaN(Number(q))) hourOverride = Math.max(0, Math.min(23.99, Number(q)));
}
const hourNow = () => { if (hourOverride != null) return hourOverride; const d = new Date(); return d.getHours() + d.getMinutes() / 60; };

/* ---------- state ---------- */
function refresh() {
  st.view = viewOf(st.city, st.live);
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    scene?.sync();
    paintHud();
  });
}

function useDerived() {
  st.mode = 'derived';
  st.city = deriveCity(S(), { hardware: extra.hardware, label: tr('city.machine.thisPc') });
  refresh();
}

async function loadLib() {
  try { st.lib = await import('/lib/city.js'); } catch { st.lib = null; }
  return st.lib;
}

async function startMock() {
  const { MockCity } = await import('./mock.js');
  if (!st.lib) await loadLib();
  st.mode = 'mock';
  st.mock = new MockCity({
    emit: (ev) => onCityEvent(ev),
    live: (frame) => { if (applyLive(st.live, frame)) refresh(); },
    speed: Number(new URLSearchParams(location.search).get('cityspeed')) || 1,
  });
  st.city = st.mock.snapshot();
  refresh();
  st.mock.start();
}

function onCityEvent(ev) {
  if (!st.city) return;
  if (st.lib) st.lib.reduceCity(st.city, ev);
  else return;
  noteEvent(st.live, st.city, ev);
  collabEvent(ev, globalThis.hivedeskCollab);
  feed(ev);
  refresh();
}

/** Sends a city command to the engine (or the mock). Errors become a short notification. */
async function cmd(type, data = {}) {
  try {
    if (st.mode === 'mock') return await st.mock.command(type, data);
    if (st.mode !== 'engine') throw Object.assign(new Error(tr('city.err.noCity')), { code: 'no_city' });
    return await net.command(type, data);
  } catch (err) {
    if (type !== 'city.presence') notify({ title: tr('city.err.generic'), body: err.message, tone: 'bad', timeout: 5000 });
    throw err;
  }
}

async function resync() {
  const r = await net.command('city.sync', { since: st.city?.lastSeq || 0 });
  if (r.snapshot) st.city = JSON.parse(JSON.stringify(r.snapshot));
  for (const ev of r.tail || []) if (ev.seq > (st.city.lastSeq || 0) || r.snapshot) st.lib.reduceCity(st.city, ev);
  refresh();
}

/* ---------- mount ---------- */
/**
 * Mounts the City and registers it as a view next to Office and Desktop.
 * @param {{ desk: HTMLElement, addDockItem?: Function, office: { addView: Function, setMode: Function, getMode: Function } }} opts
 */
export async function initCity({ desk, addDockItem, office: off }) {
  office = off;
  linkCss();
  readHour();
  layer = h('section', { class: 'of-layer ct-layer', hidden: true, ta: 'city.aria.layer' });
  canvas = h('canvas', { class: 'of-canvas ct-canvas', 'aria-hidden': 'true' });
  hitLayer = h('div', { class: 'of-hits' });
  cursorLayer = h('div', { class: 'ct-cursors', 'aria-hidden': 'true' });
  layer.append(canvas, hitLayer, cursorLayer, buildHud());
  desk.append(layer);

  scene = new CityScene(canvas, {
    getCity: () => st.view,
    reduced: reducedMotion,
    hour: hourNow,
    t: tr,
    onSound: (n) => audio.fx(n),
    onFrame: (sc) => { syncHits(sc); syncCursors(sc); levels(sc); },
  });
  new ResizeObserver(() => { if (active) scene.resize(layer.clientWidth, layer.clientHeight); }).observe(layer);
  wireCanvas();

  office.addView({
    id: 'city', first: true, glyph: cityGlyph, labelKey: 'city.view', titleKey: 'tip.city.view',
    enter: (o) => enter(o), leave: (o) => leave(o),
  });

  addDockItem?.({
    id: 'city', label: tr('city.dock'), sub: tr('city.dock.sub'),
    content: h('span', { class: 'dk-hex' }, cityGlyph()),
    onClick: () => office.setMode(office.getMode() === 'city' ? 'desktop' : 'city'),
    menu: () => [
      { header: tr('city.title') },
      { label: tr('city.fit'), icon: 'hive', action: () => { office.setMode('city'); scene.fit(); closeSide(); } },
      { label: tr('city.machines'), icon: 'gpu', action: () => { office.setMode('city'); openSide({ kind: 'machine' }); } },
      { label: tr('city.invite'), icon: 'lend', action: () => invite() },
    ],
  });

  // engine wiring
  const q = new URLSearchParams(location.search).get('city');
  if (q === 'mock') startMock();
  net.on('hello', async (f) => {
    if (st.mode === 'mock') return;
    const city = f.state?.city;
    if ((f.city === 1 || city) && (st.lib || await loadLib())) {
      st.mode = 'engine';
      st.city = city ? JSON.parse(JSON.stringify(city)) : st.lib.initialCity();
      st.live = blankLive();
      refresh();
    } else useDerived();
  });
  net.on('event', (f) => {
    const ev = f.event;
    if (!ev || st.mode !== 'engine') return;
    if (!(st.lib.isCityEvent ? st.lib.isCityEvent(ev) : /^(city\.|worker\.status$|turn\.started$)/.test(ev.type))) return;
    onCityEvent(ev);
  });
  net.on('live', (f) => {
    if (st.mode !== 'engine' || !String(f.type || '').startsWith('city.')) return;
    if (applyLive(st.live, f)) refresh();
  });
  // a dropped link: catch up with city.sync and the tail of events
  let lost = false;
  net.on('connection', (c) => {
    if (c.state !== 'open') { lost = true; return; }
    if (!lost || st.mode !== 'engine') return;
    lost = false;
    resync().catch(() => {});
  });
  const tryWire = () => { if (!wireCollab(() => st.city)) setTimeout(tryWire, 2000); };
  tryWire();
  onEvent((ev) => { if (st.mode === 'derived' && /^(crew|task|job|worker)\./.test(ev.type)) useDerived(); });
  onLocale(() => { scene.palAt = -1; paintHud(); if (side) paintSide(); });
  document.addEventListener('visibilitychange', () => { if (!active) return; if (document.hidden) scene.stop(); else scene.start(); });
  document.addEventListener('keydown', onKey);
  setInterval(() => { if (active) { paintClock(); pruneCursors(); } }, 15000);
}

function enter({ quiet } = {}) {
  active = true;
  layer.hidden = false;
  scene.resize(layer.clientWidth, layer.clientHeight);
  scene.sync();
  scene.start();
  audio.setActive(true);
  paintHud();
  if (!quiet && !reducedMotion()) layer.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, easing: 'ease-out' });
}

function leave({ quiet, done } = {}) {
  active = false;
  scene.stop();
  audio.setActive(false);
  cancelDrag();
  const end = () => { layer.hidden = true; done?.(); };
  if (reducedMotion() || quiet) end();
  else layer.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180, easing: 'ease-in' }).onfinish = end;
}

function levels(sc) {
  let working = 0; let walking = 0;
  for (const a of sc.actors.values()) { if (a.path.length) walking++; else if (a.mode === 'working') working++; }
  audio.setLevels(working, walking);
}

/* ---------- HUD ---------- */
function buildHud() {
  hud.title = h('div', { class: 'ct-title' }, h('span', { class: 'ct-logo', html: CITY_SVG, 'aria-hidden': 'true' }), h('strong', { tx: 'city.title' }));
  hud.demo = h('span', { class: 'ct-chip ct-demo', hidden: true });
  hud.stats = h('div', { class: 'ct-stats' });
  hud.caption = h('div', { class: 'ct-caption', hidden: true, role: 'status' });
  const inviteBtn = h('button', { type: 'button', class: 'btn btn-xs ct-invite', on: { click: () => invite() } }, h('span', { class: 'ct-gl', html: '<svg viewBox="0 0 24 24" class="ico ico-sm"><circle cx="9" cy="8" r="3.4"/><path d="M3 19c.6-3.3 3-5.2 6-5.2s5.4 1.9 6 5.2M18 7v6M15 10h6"/></svg>' }), h('span', { tx: 'city.invite' }));
  const cityCard = h('div', { class: 'of-card ct-card' }, h('div', { class: 'of-row' }, hud.title, hud.demo), hud.stats, hud.caption, inviteBtn);

  // the task board (the Lobby board, mirrored here so notes can be dragged anywhere)
  hud.input = h('input', { class: 'ct-input', type: 'text', maxLength: 200, tp: 'city.board.placeholder', ta: 'city.board.placeholder', on: { keydown: (e) => { if (e.key === 'Enter') addTask(); }, input: () => paintDraft() } });
  hud.draft = h('div', { class: 'ct-note ct-draft', hidden: true, tabindex: '0', role: 'button' });
  hud.draft.addEventListener('pointerdown', (e) => startDrag(e, hud.draft, { draft: true }));
  const addBtn = h('button', { type: 'button', class: 'btn btn-xs btn-primary', tx: 'city.board.add', on: { click: () => addTask() } });
  hud.notes = h('div', { class: 'ct-notes' });
  hud.boardCount = h('span', { class: 'ct-count' });
  hud.board = h('section', { class: 'of-card ct-board', 'aria-labelledby': 'ct-board-h' },
    h('div', { class: 'of-row' }, h('span', { class: 'of-k', id: 'ct-board-h', tx: 'city.board.title' }), hud.boardCount),
    h('div', { class: 'ct-faint', tx: 'city.board.sub' }),
    h('div', { class: 'ct-add' }, hud.input, addBtn),
    hud.draft,
    hud.notes);

  // top right: people, clock, machines
  hud.people = h('div', { class: 'ct-people' });
  hud.clock = h('div', { class: 'of-pill ct-clock' });
  const machinesBtn = h('button', { type: 'button', class: 'of-pill ct-pill-btn', on: { click: () => toggleSide({ kind: 'machine' }) } }, h('span', { class: 'ct-gl', html: '<svg viewBox="0 0 24 24" class="ico ico-sm"><rect x="4" y="6" width="16" height="12" rx="2"/><path d="M8 10h3v4H8zM14 10h2M14 13h2M8 3v3M12 3v3M16 3v3M8 18v3M12 18v3M16 18v3"/></svg>' }), h('span', { tx: 'city.machines' }));
  hud.top = h('div', { class: 'ct-top' }, hud.people, hud.clock, machinesBtn);

  // bottom: room bar, zoom, feed
  hud.rooms = h('nav', { class: 'ct-rooms', ta: 'city.rooms' });
  const zb = (txt, key, fn) => h('button', { type: 'button', class: 'of-ib', ta: key, title: tr(key), on: { click: fn } }, h('span', { class: 'ct-gl', html: txt }));
  hud.zoom = h('div', { class: 'of-pill ct-zoom' },
    zb('<svg viewBox="0 0 24 24" class="ico"><path d="M12 6v12M6 12h12"/></svg>', 'city.zoomIn', () => scene.zoomAt(1.35, layer.clientWidth / 2, layer.clientHeight / 2)),
    zb('<svg viewBox="0 0 24 24" class="ico"><path d="M6 12h12"/></svg>', 'city.zoomOut', () => scene.zoomAt(1 / 1.35, layer.clientWidth / 2, layer.clientHeight / 2)),
    zb('<svg viewBox="0 0 24 24" class="ico"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>', 'city.fit', () => { closeSide(); scene.fit(); }));
  hud.feed = h('ol', { class: 'of-card of-feed ct-feed', 'aria-live': 'polite', ta: 'city.feed' });
  hud.side = h('aside', { class: 'of-card ct-side', hidden: true });
  hud.tip = h('div', { class: 'ct-droptip', hidden: true });
  return h('div', { class: 'of-hud ct-hud' }, cityCard, hud.board, hud.top, hud.side, hud.rooms, hud.zoom, hud.feed, hud.tip);
}

function paintHud() {
  if (!hud.stats || !active) return;
  const v = st.view;
  const machines = Object.values(v.machines);
  const agents = Object.values(v.agents);
  const moving = Object.values(v.tasks).filter((x) => !['open', 'done', 'blocked'].includes(x.status)).length;
  clear(hud.stats);
  hud.stats.append(
    stat(fmtNumber(machines.length), tr('city.stat.machines', { n: machines.length })),
    stat(fmtNumber(agents.length), tr('city.stat.agents', { n: agents.length })),
    stat(fmtNumber(moving), tr('city.stat.moving', { n: moving })));
  const isDemo = st.mode === 'mock' || ui.demo;
  hud.demo.hidden = !isDemo;
  hud.demo.textContent = st.mode === 'mock' ? tr('city.mock') : tr('city.demo');
  // demo captions
  const cap = v.caption;
  if (cap && Date.now() - cap.at < 9000) {
    hud.caption.hidden = false;
    hud.caption.textContent = DEMO_STEPS.includes(cap.step) ? tr(`city.demo.${cap.step}`) : cap.text;
    clearTimeout(hud.caption._t);
    hud.caption._t = setTimeout(() => { hud.caption.hidden = true; }, 9000 - (Date.now() - cap.at));
  }
  paintBoard();
  paintPeople();
  paintClock();
  paintRooms();
  if (side) paintSide();
}

function stat(n, label) { return h('div', { class: 'ct-stat' }, h('b', { text: n }), h('span', { text: label })); }

function paintClock() {
  const hr = hourNow();
  const hh = Math.floor(hr); const mm = Math.floor((hr % 1) * 60);
  const phase = hr >= 5 && hr < 8 ? 'morning' : hr < 12 && hr >= 8 ? 'day' : hr >= 12 && hr < 17 ? 'afternoon' : hr >= 17 && hr < 20 ? 'evening' : 'night';
  clear(hud.clock);
  hud.clock.append(h('span', { class: 'ct-gl', html: phase === 'night' || phase === 'evening' ? '<svg viewBox="0 0 24 24" class="ico ico-sm"><path d="M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5z"/></svg>' : '<svg viewBox="0 0 24 24" class="ico ico-sm"><circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4"/></svg>' }),
    h('span', { text: tr(`city.phase.${phase}`) }), h('b', { text: `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}` }));
}

function paintPeople() {
  const people = Object.values(st.view.people || {}).filter((p) => !isMe(p) && Date.now() - (p.seen || 0) < 20000);
  clear(hud.people);
  hud.people.hidden = !people.length;
  const me = h('span', { class: 'ct-person ct-me', title: tr('city.you') }, h('i', { style: 'background:#FFB531' }), h('span', { tx: 'city.you' }));
  hud.people.append(me);
  for (const p of people.slice(0, 5)) hud.people.append(h('span', { class: 'ct-person', title: p.name }, h('i', { style: `background:${safeColor(p.color)}` }), h('span', { text: String(p.name || '').slice(0, 20) })));
}

function isMe(p) { return !net.isRemote() && p.id === 'h'; }
const safeColor = (c) => (/^#[0-9a-f]{6}$/i.test(c || '') ? c : '#86A9D6');

function paintRooms() {
  const counts = {};
  for (const x of Object.values(st.view.tasks)) if (x.status !== 'done') counts[x.room] = (counts[x.room] || 0) + 1;
  const focus = scene.focus?.kind === 'room' ? scene.focus.id : null;
  const items = [{ id: '', city: true }, ...Object.keys(st.view.rooms).filter((k) => ROOMS[k]).map((id) => ({ id }))];
  clear(hud.rooms);
  for (const it of items) {
    const on = it.city ? !focus : focus === it.id;
    const b = h('button', { type: 'button', class: 'ct-room', 'aria-pressed': String(on), on: { click: () => (it.city ? (closeSide(), scene.fit()) : openRoom(it.id)) } },
      it.city ? h('span', { class: 'ct-gl', html: CITY_SVG }) : h('i', { style: `background:${ROOM_COLOR[it.id] || '#FFB531'}` }),
      h('span', { text: it.city ? tr('city.fit') : roomName(it.id) }),
      !it.city && counts[it.id] ? h('b', { text: String(counts[it.id]) }) : null);
    if (!it.city) { b.dataset.room = it.id; b.addEventListener('pointerenter', () => { scene.highlight = { kind: 'room', id: it.id }; }); b.addEventListener('pointerleave', () => { scene.highlight = null; }); }
    hud.rooms.append(b);
  }
}

/* ---------- the task board ---------- */
const DEMO_STEPS = ['friend', 'borrow', 'lent', 'task', 'done'];
const STATUS_ORDER = { in_progress: 0, in_review: 0, in_test: 0, claimed: 0, open: 1, blocked: 2, done: 3 };

function paintBoard() {
  const tasks = Object.values(st.view.tasks).sort((a, b) => (STATUS_ORDER[a.status] ?? 1) - (STATUS_ORDER[b.status] ?? 1) || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')) || a.id.localeCompare(b.id));
  const done = tasks.filter((x) => x.status === 'done');
  const list = [...tasks.filter((x) => x.status !== 'done'), ...done.slice(0, 3)];
  hud.boardCount.textContent = tr('city.board.count', { n: tasks.length - done.length });
  const keep = new Set();
  const frag = [];
  for (const x of list) {
    keep.add(x.id);
    let n = hud.notes.querySelector(`[data-id="${CSS.escape(x.id)}"]`);
    if (!n) n = makeNote(x.id);
    paintNote(n, x);
    frag.push(n);
  }
  for (const n of [...hud.notes.children]) if (!keep.has(n.dataset.id)) n.remove();
  frag.forEach((n, i) => { if (hud.notes.children[i] !== n) hud.notes.insertBefore(n, hud.notes.children[i] || null); });
  if (!list.length && !hud.notes.querySelector('.ct-empty')) hud.notes.append(h('div', { class: 'ct-empty', tx: 'city.board.empty' }));
  else if (list.length) hud.notes.querySelector('.ct-empty')?.remove();
}

function makeNote(id) {
  const n = h('div', { class: 'ct-note', tabindex: '0', role: 'button', dataset: { id } });
  n.addEventListener('pointerdown', (e) => startDrag(e, n, { taskId: id }));
  n.addEventListener('click', () => { if (n._dragged) { n._dragged = false; return; } const x = st.view.tasks[id]; if (x && ROOMS[x.room]) openRoom(x.room); });
  n.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); const r = n.getBoundingClientRect(); menu.open({ x: r.left + 12, y: r.bottom, items: noteMenu(id) }); } });
  menu.provide(n, () => noteMenu(id));
  return n;
}

function paintNote(n, x) {
  const a = x.assignee && st.view.agents[x.assignee];
  const key = `${x.title}|${x.status}|${x.room}|${x.assignee}|${x.loops}|${x.awaiting}`;
  if (n._key === key) return;
  n._key = key;
  n.dataset.s = x.status;
  n.style.setProperty('--strip', a?.color || ROOM_COLOR[x.room] || '#FFB531');
  clear(n);
  n.append(
    h('div', { class: 'ct-note-t', text: x.title }),
    h('div', { class: 'ct-note-m' },
      h('span', { class: 'ct-tag', style: `--c:${ROOM_COLOR[x.room] || '#FFB531'}`, text: roomName(x.room) }),
      h('span', { class: 'ct-faint', text: tr(`city.task.status.${x.status}`) }),
      a ? h('span', { class: 'ct-who' }, beeAvatar(avatarOf(a), 16, { ring: false }), h('span', { text: a.name })) : null,
      x.awaiting ? h('span', { class: 'ct-tag ct-warn', tx: 'city.task.awaiting' }) : null,
      x.loops ? h('span', { class: 'ct-faint', text: tr('city.task.loops', { n: x.loops, max: x.maxLoops }) }) : null));
  n.setAttribute('aria-label', `${x.title}. ${tr(`city.task.status.${x.status}`)}. ${roomName(x.room)}${a ? `. ${a.name}` : ''}. ${tr('city.board.sub')}`);
}

function noteMenu(id) {
  const x = st.view.tasks[id];
  if (!x) return null;
  const off = x.status === 'done';
  return [
    { header: x.title },
    { label: tr('city.menu.handTo'), icon: 'hire', disabled: off, items: Object.values(st.view.agents).map((a) => ({ label: `${a.name} (${a.role})`, iconEl: beeAvatar(avatarOf(a), 18, { ring: false }), action: () => cmd('city.task.assign', { taskId: id, agentId: a.id }).catch(() => {}) })) },
    { label: tr('city.menu.sendTo'), icon: 'arrow', disabled: off, items: Object.keys(st.view.rooms).map((k) => ({ label: roomName(k), action: () => cmd('city.task.move', { taskId: id, room: k }).catch(() => {}) })) },
    { sep: true },
    { label: tr('city.task.approve'), icon: 'check', disabled: !x.awaiting, action: () => cmd('city.task.approve', { taskId: id }).catch(() => {}) },
    { label: tr('city.task.retry'), icon: 'replay', disabled: x.status !== 'blocked', action: () => cmd('city.task.retry', { taskId: id }).catch(() => {}) },
    { label: tr('city.task.cancel'), icon: 'x', danger: true, disabled: off, action: () => cmd('city.task.cancel', { taskId: id }).catch(() => {}) },
  ];
}

function paintDraft() {
  const text = hud.input.value.trim();
  hud.draft.hidden = !text;
  clear(hud.draft);
  if (text) hud.draft.append(h('div', { class: 'ct-note-t', text }), h('div', { class: 'ct-faint', tx: 'city.board.draft' }));
}

async function addTask(target = {}) {
  const title = hud.input.value.trim();
  if (!title) { hud.input.focus(); return; }
  hud.input.value = '';
  paintDraft();
  await cmd('city.task.create', { title, ...(target.agentId ? { agentId: target.agentId } : { room: target.room || 'lobby' }) }).catch(() => { hud.input.value = title; paintDraft(); });
}

/* ---------- drag a note onto a bee or a room ---------- */
function startDrag(e, el, what) {
  if (e.button !== 0 || ui.replay) return;
  if (what.taskId && st.view.tasks[what.taskId]?.status === 'done') return;
  const x0 = e.clientX; const y0 = e.clientY;
  let ghost = null;
  const move = (ev) => {
    if (!drag && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6) return;
    if (!drag) {
      drag = { ...what, el };
      scene.dragTask = what.taskId || null;
      const title = what.draft ? hud.input.value.trim() : st.view.tasks[what.taskId]?.title;
      ghost = h('div', { class: 'of-drag ct-ghost', 'aria-hidden': 'true' }, h('i', { style: `background:${getComputedStyle(el).getPropertyValue('--strip') || '#FFB531'}` }), h('span', { text: title || '' }));
      layer.append(ghost);
      layer.classList.add('of-dragging');
      el.classList.add('ct-lifted');
    }
    const lr = layer.getBoundingClientRect();
    ghost.style.transform = `translate(${ev.clientX - lr.left + 10}px, ${ev.clientY - lr.top + 10}px) rotate(-4deg)`;
    const target = targetAt(ev.clientX, ev.clientY);
    drag.target = target;
    scene.dropTarget = target;
    if (target) {
      hud.tip.hidden = false;
      hud.tip.textContent = target.kind === 'agent' ? tr('city.drop.agent', { name: agentName(target.id) }) : tr('city.drop.room', { room: roomName(target.id) });
      hud.tip.style.transform = `translate(${ev.clientX - lr.left + 14}px, ${ev.clientY - lr.top - 34}px)`;
    } else hud.tip.hidden = true;
  };
  const up = () => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    removeEventListener('pointercancel', up);
    if (!drag) return;
    el._dragged = true;
    const { target } = drag;
    const w = drag;
    ghost?.remove();
    cancelDrag();
    if (!target) return;
    audio.fx('stick');
    if (w.draft) addTask(target.kind === 'agent' ? { agentId: target.id } : { room: target.id });
    else if (target.kind === 'agent') cmd('city.task.assign', { taskId: w.taskId, agentId: target.id }).catch(() => {});
    else cmd('city.task.move', { taskId: w.taskId, room: target.id }).catch(() => {});
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
  addEventListener('pointercancel', up);
}

function cancelDrag() {
  layer?.querySelector('.ct-ghost')?.remove();
  layer?.classList.remove('of-dragging');
  for (const n of layer?.querySelectorAll('.ct-lifted') || []) n.classList.remove('ct-lifted');
  if (hud.tip) hud.tip.hidden = true;
  if (scene) { scene.dragTask = null; scene.dropTarget = null; }
  drag = null;
}

function targetAt(x, y) {
  for (const [id, b] of bees) {
    const r = b.getBoundingClientRect();
    if (x >= r.left - 4 && x <= r.right + 4 && y >= r.top - 4 && y <= r.bottom + 4) return { kind: 'agent', id };
  }
  const chip = document.elementFromPoint(x, y)?.closest?.('.ct-room[data-room]');
  if (chip) return { kind: 'room', id: chip.dataset.room };
  const lr = canvas.getBoundingClientRect();
  if (x < lr.left || y < lr.top || x > lr.right || y > lr.bottom) return null;
  const w = scene.unproject(x - lr.left, y - lr.top + scene.cam.A * 0.3 * 1.12);
  const k = roomAt(w.x, w.y);
  return k && st.view.rooms[k] ? { kind: 'room', id: k } : null;
}

/* ---------- canvas: pan, zoom, click, presence ---------- */
function wireCanvas() {
  let down = null;
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    down = { x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, moved: false, id: e.pointerId };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    const lr = canvas.getBoundingClientRect();
    const sx = e.clientX - lr.left; const sy = e.clientY - lr.top;
    if (down) {
      if (!down.moved && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) { down.moved = true; layer.classList.add('ct-panning'); }
      if (down.moved) { scene.panBy(e.clientX - down.lx, e.clientY - down.ly); down.lx = e.clientX; down.ly = e.clientY; if (scene.focus && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 120) scene.focus = null; }
      return;
    }
    // hover: rooms and buildings light up
    const m = scene.machineHits.find((r) => sx >= r.x && sx <= r.x + r.w && sy >= r.y && sy <= r.y + r.h);
    const w = scene.unproject(sx, sy + scene.cam.A * 0.3 * 1.12);
    const room = roomAt(w.x, w.y);
    const hl = m ? { kind: 'machine', id: m.id } : room ? { kind: 'room', id: room } : null;
    if (!drag && (scene.highlight?.kind !== 'agent')) scene.highlight = hl;
    canvas.style.cursor = hl ? 'pointer' : 'grab';
    presence(w, room);
  });
  const end = (e) => {
    if (!down) return;
    const wasMove = down.moved;
    down = null;
    layer.classList.remove('ct-panning');
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    if (wasMove) return;
    const lr = canvas.getBoundingClientRect();
    const sx = e.clientX - lr.left; const sy = e.clientY - lr.top;
    const m = scene.machineHits.find((r) => sx >= r.x && sx <= r.x + r.w && sy >= r.y && sy <= r.y + r.h);
    if (m) { openSide({ kind: 'machine', id: m.id }); scene.focusMachine(m.id); paintRooms(); return; }
    const w = scene.unproject(sx, sy + scene.cam.A * 0.3 * 1.12);
    const room = roomAt(w.x, w.y);
    if (room) openRoom(room);
    else if (Math.hypot(w.x + 1.6, w.y + 1.4) < 2.4) openSide({ kind: 'machine', id: st.view.selfId });
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', () => { down = null; layer.classList.remove('ct-panning'); });
  canvas.addEventListener('dblclick', () => { closeSide(); scene.fit(); paintRooms(); });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const lr = canvas.getBoundingClientRect();
    scene.zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - lr.left, e.clientY - lr.top);
    paintRooms();
  }, { passive: false });
  canvas.addEventListener('pointerleave', () => { if (!drag) scene.highlight = null; });
}

function presence(w, room) {
  const now = performance.now();
  if (now - lastPresence < 100 || st.mode !== 'engine') return;
  const others = Object.values(st.view.people || {}).some((p) => !isMe(p));
  if (!others && !net.isRemote()) return;
  lastPresence = now;
  cmd('city.presence', { x: Math.round(w.x * 100) / 100, y: Math.round(w.y * 100) / 100, room: room || undefined }).catch(() => {});
}

function syncCursors(sc) {
  const seen = new Set();
  for (const p of Object.values(st.view.people || {})) {
    if (isMe(p) || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    if (Date.now() - (p.seen || 0) > 20000) continue;
    seen.add(p.id);
    let c = cursors.get(p.id);
    if (!c) {
      c = h('div', { class: 'ct-cursor' }, h('span', { class: 'ct-arrow', html: '<svg viewBox="0 0 20 22"><path d="M2 2l15 8.2-6.4 1.6-3.2 6.4z"/></svg>' }), h('span', { class: 'ct-cname' }));
      cursorLayer.append(c);
      cursors.set(p.id, c);
      c._x = null;
    }
    const col = safeColor(p.color);
    if (c._col !== col) { c._col = col; c.style.setProperty('--c', col); }
    if (c._name !== p.name) { c._name = p.name; c.querySelector('.ct-cname').textContent = String(p.name || '').slice(0, 24); }
    const [x, y] = sc.P(p.x, p.y, 0.3);
    // ease toward the reported point so 10 updates a second still glide
    const k = reducedMotion() || c._x == null ? 1 : 0.35;
    c._x = c._x == null ? x : c._x + (x - c._x) * k;
    c._y = c._y == null ? y : c._y + (y - c._y) * k;
    c.style.transform = `translate(${Math.round(c._x)}px, ${Math.round(c._y)}px)`;
    c.classList.toggle('ct-stale', Date.now() - (p.seen || 0) > 6000);
  }
  for (const [id, c] of cursors) if (!seen.has(id)) { c.remove(); cursors.delete(id); }
}

function pruneCursors() {
  for (const [id, p] of Object.entries(st.live.people)) if (Date.now() - (p.seen || 0) > 60000) delete st.live.people[id];
  paintPeople();
}

/* ---------- bees: the DOM layer over the canvas for focus, click and drop ---------- */
function syncHits(sc) {
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
    const a = st.view.agents[hit.id];
    const label = a ? `${a.name}, ${a.role}, ${tr('city.card.level', { n: a.level })}. ${tr(`city.agent.status.${a.status}`)}. ${roomName(a.room)}.` : hit.id;
    if (b._label !== label) { b._label = label; b.setAttribute('aria-label', label); }
  }
  for (const [id, b] of bees) if (!seen.has(id)) { b.remove(); bees.delete(id); }
}

function makeBee(id) {
  const b = h('button', { type: 'button', class: 'of-bee', dataset: { id } });
  b.addEventListener('click', () => { if (!drag) openSide({ kind: 'agent', id }); });
  b.addEventListener('pointerenter', () => { scene.highlight = { kind: 'agent', id }; });
  b.addEventListener('pointerleave', () => { if (scene.highlight?.id === id) scene.highlight = null; });
  b.addEventListener('focus', () => { scene.highlight = { kind: 'agent', id }; });
  b.addEventListener('blur', () => { if (scene.highlight?.id === id) scene.highlight = null; });
  b.addEventListener('wheel', (e) => { e.preventDefault(); const lr = canvas.getBoundingClientRect(); scene.zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - lr.left, e.clientY - lr.top); }, { passive: false });
  menu.provide(b, () => agentMenu(id));
  hitLayer.append(b);
  bees.set(id, b);
  return b;
}

function agentMenu(id) {
  const a = st.view.agents[id];
  if (!a) return null;
  return [
    { header: `${a.name} · ${a.role} · ${tr('city.card.level', { n: a.level })}` },
    { label: tr('city.card.open'), icon: 'hire', action: () => openSide({ kind: 'agent', id }) },
    { label: tr('city.card.moveTo'), icon: 'arrow', items: Object.keys(st.view.rooms).map((k) => ({ label: roomName(k), checked: a.room === k, action: () => cmd('city.agent.move', { agentId: id, room: k }).catch(() => {}) })) },
    { label: tr('city.card.chat'), icon: 'chat', action: () => chatWith(a) },
  ];
}

const avatarOf = (a) => ({ id: a.workerId || a.id, name: a.name, role: a.role, color: a.color });

/* ---------- side panel: agent card, machines, room ---------- */
function openSide(s) {
  side = s;
  memoryEdit = null;
  hud.side.hidden = false;
  paintSide();
  scene.panelRight = true;
  if (!scene.focus && !scene.userMoved) scene.fit();
  if (!reducedMotion()) hud.side.animate([{ opacity: 0, transform: 'translateX(14px)' }, { opacity: 1, transform: 'none' }], { duration: 220, easing: 'cubic-bezier(.16,1,.3,1)' });
  if (s.kind === 'agent') scene.highlight = { kind: 'agent', id: s.id };
}
function toggleSide(s) { if (side && side.kind === s.kind && side.id === s.id) closeSide(); else openSide(s); }
function closeSide() {
  side = null; memoryEdit = null;
  if (hud.side) hud.side.hidden = true;
  if (scene) { scene.panelRight = false; if (!scene.focus && !scene.userMoved) scene.fit(); }
  if (scene?.focus?.kind === 'room' || scene?.focus?.kind === 'machine') scene.fit();
  paintRooms();
}

function openRoom(id) {
  scene.focusRoom(id);
  openSide({ kind: 'room', id });
  paintRooms();
  audio.fx('whoosh');
}

function paintSide() {
  if (!side || !hud.side) return;
  clear(hud.side);
  const close = h('button', { type: 'button', class: 'of-ib ct-close', ta: 'city.card.close', title: tr('city.card.close'), on: { click: () => closeSide() } }, h('span', { class: 'ct-gl', html: '<svg viewBox="0 0 24 24" class="ico"><path d="M6 6l12 12M18 6 6 18"/></svg>' }));
  let body = null;
  if (side.kind === 'agent') body = agentCard(side.id);
  else if (side.kind === 'machine') body = machinePanel(side.id);
  else if (side.kind === 'room') body = roomPanel(side.id);
  if (!body) { closeSide(); return; }
  hud.side.dataset.kind = side.kind;
  hud.side.append(close, body);
}

function agentCard(id) {
  const a = st.view.agents[id];
  if (!a) return null;
  const v = st.view;
  const task = a.taskId && v.tasks[a.taskId];
  const home = v.machines[a.home];
  const mine = !home || home.self || st.mode === 'mock';
  const lv = a.level;
  const next = xpFor(lv + 1);
  const borrow = borrowOf(v, a.id);
  const ask = pendingOf(v, a.id);
  const brain = borrow ? { kind: 'lent', label: machineName(borrow.to) } : a.brain || { kind: 'local' };
  const card = h('div', { class: 'ct-agent' });
  card.append(
    h('div', { class: 'ct-agent-h' },
      h('div', { class: 'ct-av', style: `--c:${a.color}` }, beeAvatar(avatarOf(a), 58, { ring: true, status: a.status === 'working' ? 'thinking' : undefined })),
      h('div', { class: 'ct-agent-n' },
        h('strong', { text: a.name }),
        h('div', { class: 'ct-faint', text: a.role }),
        h('div', { class: 'ct-lvrow' }, h('span', { class: 'ct-lv', text: tr('city.card.level', { n: lv }) }),
          h('div', { class: 'of-xp ct-xp', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(xpProgress(a) * 100)) }, h('i', { style: `width:${Math.round(xpProgress(a) * 100)}%` }), h('b'))),
        h('div', { class: 'ct-faint tiny', text: tr('city.card.xp', { xp: fmtNumber(a.xp), left: fmtNumber(Math.max(0, next - a.xp)), next: lv + 1 }) }))),
    h('div', { class: 'ct-status', dataset: { s: a.status } }, h('i'), h('span', { text: tr(`city.agent.status.${a.status}`) }), ask ? h('span', { class: 'ct-tag ct-info', tx: 'city.borrow.asking' }) : null),
  );
  const grid = h('dl', { class: 'ct-grid' });
  const roomSel = h('select', { class: 'ct-select', ta: 'city.card.moveTo', on: { change: (e) => cmd('city.agent.move', { agentId: id, room: e.target.value }).catch(() => paintSide()) } },
    ...Object.keys(v.rooms).map((k) => h('option', { value: k, text: roomName(k), selected: a.room === k })));
  grid.append(
    h('dt', { tx: 'city.card.room' }), h('dd', {}, roomSel),
    h('dt', { tx: 'city.card.task' }), h('dd', { text: task ? task.title : tr('city.card.none') }),
    h('dt', { tx: 'city.card.brain' }), h('dd', {}, h('span', { class: `ct-brain ct-brain-${brain.kind}`, text: tr(`city.brain.${brain.kind}`) || brain.kind }), brain.label ? h('span', { class: 'ct-faint', text: ` ${brain.label}` }) : null),
    h('dt', { tx: 'city.card.home' }), h('dd', {}, h('i', { class: 'ct-dot', style: `background:${home?.color || '#FFB531'}` }), h('span', { text: home ? home.name : '' })),
    h('dt', { tx: 'city.card.spec' }), h('dd', {}, ...(a.specialization || []).map((k) => h('span', { class: 'ct-tag', style: `--c:${ROOM_COLOR[k] || '#FFB531'}`, text: roomName(k) }))));
  card.append(grid);
  if (a.stats && (a.stats.done || a.stats.reviews || a.stats.tests)) card.append(h('div', { class: 'ct-faint small', text: tr('city.card.stats', { done: a.stats.done || 0, reviews: a.stats.reviews || 0, tests: a.stats.tests || 0 }) }));

  // memory
  const memBox = h('section', { class: 'ct-sec' }, h('div', { class: 'of-row' }, h('span', { class: 'of-k', tx: 'city.card.memory' }), h('span', { class: 'ct-faint small', text: tr('city.card.memoryCount', { n: a.memoryCount }) })));
  if (memoryEdit?.agentId === id) memBox.append(memoryEditor(a));
  else {
    const ul = h('ul', { class: 'ct-mem' });
    for (const m of a.memory.slice(0, 4)) ul.append(h('li', { dataset: { k: m.kind } }, h('span', { class: 'ct-mk', text: tr(`city.memory.kind.${m.kind}`) || m.kind }), h('span', { text: m.text })));
    if (!a.memory.length) ul.append(h('li', { class: 'ct-faint', tx: 'city.card.memoryEmpty' }));
    memBox.append(ul);
    if (mine) memBox.append(h('button', { type: 'button', class: 'btn btn-xs btn-quiet', tx: 'city.card.editMemory', on: { click: () => loadMemory(id) } }));
  }
  card.append(memBox);

  // tools
  const all = new Set([...(a.tools || []), ...Object.values(v.rooms).flatMap((r) => r.tools || [])]);
  const tools = h('div', { class: 'ct-tools' });
  for (const tool of [...all].sort()) {
    const on = (a.tools || []).includes(tool);
    tools.append(h('button', { type: 'button', class: 'ct-tool', 'aria-pressed': String(on), disabled: !mine, text: tool, on: { click: () => { const next = on ? a.tools.filter((x) => x !== tool) : [...a.tools, tool]; cmd('city.agent.update', { agentId: id, tools: next }).catch(() => {}); } } }));
  }
  card.append(h('section', { class: 'ct-sec' }, h('span', { class: 'of-k', tx: 'city.card.tools' }), h('div', { class: 'ct-faint small', tx: mine ? 'city.card.toolsHelp' : 'city.card.friendAgent' }), tools));

  // actions
  const acts = h('div', { class: 'ct-acts' });
  acts.append(h('button', { type: 'button', class: 'btn btn-xs', tx: 'city.card.chat', on: { click: () => chatWith(a) } }));
  const lenders = Object.values(v.machines).filter((m) => m.id !== a.home && m.online);
  if (borrow) acts.append(h('button', { type: 'button', class: 'btn btn-xs', tx: 'city.borrow.stop', on: { click: () => cmd('city.borrow.stop', { borrowId: borrow.id }).catch(() => {}) } }));
  else if (lenders.length && !ask) acts.append(h('button', { type: 'button', class: 'btn btn-xs', text: tr('city.card.borrow', { name: lenders[0].name }), on: { click: () => cmd('city.borrow.request', { agentId: id, machineId: lenders[0].id }).catch(() => {}) } }));
  if (mine) {
    if (a.status === 'sleeping') acts.append(h('button', { type: 'button', class: 'btn btn-xs', tx: 'city.card.wake', on: { click: () => cmd('city.agent.wake', { agentId: id }).catch(() => {}) } }));
    else acts.append(h('button', { type: 'button', class: 'btn btn-xs btn-quiet', tx: a.builtin ? 'city.card.sleep' : 'city.card.retire', on: { click: () => cmd('city.agent.retire', { agentId: id }).then(() => { if (!a.builtin) closeSide(); }).catch(() => {}) } }));
  }
  card.append(acts);
  return card;
}

async function loadMemory(agentId) {
  try {
    const r = await cmd('city.agent.memory.list', { agentId });
    memoryEdit = { agentId, entries: r.entries || [] };
  } catch { memoryEdit = null; }
  paintSide();
}

function memoryEditor(a) {
  const box = h('div', { class: 'ct-memedit' });
  const reload = () => loadMemory(a.id);
  for (const m of memoryEdit.entries) {
    const input = h('input', { class: 'ct-input', type: 'text', value: m.text, maxLength: 300, 'aria-label': tr('city.card.memory') });
    input.addEventListener('change', () => cmd('city.agent.memory.update', { agentId: a.id, id: m.id, text: input.value }).then(reload).catch(() => {}));
    box.append(h('div', { class: 'ct-memrow' },
      h('button', { type: 'button', class: 'ct-pin', 'aria-pressed': String(!!m.pinned), title: tr(m.pinned ? 'city.card.unpin' : 'city.card.pin'), ta: m.pinned ? 'city.card.unpin' : 'city.card.pin', on: { click: () => cmd('city.agent.memory.update', { agentId: a.id, id: m.id, pinned: !m.pinned }).then(reload).catch(() => {}) } }, h('span', { class: 'ct-gl', html: '<svg viewBox="0 0 24 24" class="ico ico-sm"><path d="M9 4h6l-1 6 3 3H7l3-3zM12 13v7"/></svg>' })),
      input,
      h('button', { type: 'button', class: 'of-ib', title: tr('city.card.delete'), ta: 'city.card.delete', on: { click: () => cmd('city.agent.memory.delete', { agentId: a.id, id: m.id }).then(reload).catch(() => {}) } }, h('span', { class: 'ct-gl', html: '<svg viewBox="0 0 24 24" class="ico ico-sm"><path d="M6 6l12 12M18 6 6 18"/></svg>' }))));
  }
  const add = h('input', { class: 'ct-input', type: 'text', maxLength: 300, tp: 'city.card.addMemory', ta: 'city.card.addMemory' });
  const save = () => { const text = add.value.trim(); if (!text) return; cmd('city.agent.memory.add', { agentId: a.id, text }).then(reload).catch(() => {}); };
  add.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
  box.append(h('div', { class: 'ct-memrow' }, add, h('button', { type: 'button', class: 'btn btn-xs btn-primary', tx: 'city.card.save', on: { click: save } })),
    h('button', { type: 'button', class: 'btn btn-xs btn-quiet', tx: 'city.card.doneEditing', on: { click: () => { memoryEdit = null; paintSide(); } } }));
  return box;
}

function machinePanel(focusId) {
  const v = st.view;
  const box = h('div', { class: 'ct-machines' }, h('div', { class: 'ct-panel-h' }, h('strong', { tx: 'city.machine.title' }), h('span', { class: 'ct-faint small', tx: 'city.machine.limits' })));
  const list = Object.values(v.machines).sort((a, b) => (b.self - a.self) || String(a.joinedAt || '').localeCompare(String(b.joinedAt || '')));
  for (const m of list) {
    const agents = Object.values(v.agents).filter((x) => x.home === m.id);
    const borrowsHere = Object.values(v.borrows).filter((b) => b.to === m.id || b.from === m.id);
    const asks = v.pending.filter((b) => b.to === m.id);
    const card = h('section', { class: 'ct-mcard', dataset: { focus: String(m.id === focusId) }, style: `--c:${m.color}` });
    append(card, [
      h('div', { class: 'ct-mhead' }, h('i', { class: 'ct-hexdot' }), h('strong', { text: m.name }),
        h('span', { class: 'ct-tag', style: `--c:${m.self ? '#FFB531' : m.color}`, text: tr(m.self ? 'city.machine.host' : 'city.machine.friend') }),
        h('span', { class: `ct-online ${m.online ? 'on' : ''}`, text: tr(m.online ? 'city.machine.online' : 'city.machine.offline') })),
      m.via && m.via !== 'local' ? h('div', { class: 'ct-faint small', text: tr(`city.machine.via.${m.via}`) }) : null]);
    const grid = h('dl', { class: 'ct-grid' });
    grid.append(
      h('dt', { tx: 'city.machine.gpu' }), h('dd', { text: m.gpu?.name || tr('city.machine.noGpu') }),
      h('dt', { tx: 'city.machine.vram' }), h('dd', { text: fmtVram(m.gpu?.vramBytes) || '-' }),
      h('dt', { tx: 'city.machine.model' }), h('dd', { text: m.model || '-' }),
      h('dt', { tx: 'city.machine.load' }), h('dd', {}, h('div', { class: 'ct-bar', style: `--v:${Math.round(m.load * 100)}%` }, h('i')), h('span', { class: 'ct-faint small', text: `${Math.round(m.load * 100)}%${m.tps ? ` · ${m.tps} tok/s` : ''}` })),
      h('dt', { tx: 'city.machine.lent' }), h('dd', { text: tr('city.machine.lentValue', { turns: m.lending.turns, active: m.lending.active }) }));
    card.append(grid);
    for (const b of borrowsHere) {
      card.append(h('div', { class: 'ct-borrow' }, h('span', { class: 'ct-gl ct-cable', html: '<svg viewBox="0 0 24 24" class="ico ico-sm"><path d="M4 12h5l2-4 3 8 2-4h4"/></svg>' }),
        h('span', { text: tr('city.borrow.active', { agent: agentName(b.agentId), machine: machineName(b.to) }) }),
        h('span', { class: 'ct-faint small', text: tr('city.borrow.turns', { used: b.used?.turns || 0, limit: b.limit?.turns || '?' }) }),
        h('button', { type: 'button', class: 'btn btn-xs btn-quiet', tx: 'city.borrow.stop', on: { click: () => cmd('city.borrow.stop', { borrowId: b.id }).catch(() => {}) } })));
    }
    for (const b of asks) {
      const mineLender = m.self || st.mode === 'mock';
      card.append(h('div', { class: 'ct-borrow ct-ask' }, h('span', { text: tr('city.borrow.request', { agent: agentName(b.agentId), machine: m.name }) }),
        mineLender ? h('button', { type: 'button', class: 'btn btn-xs btn-primary', tx: 'city.borrow.accept', on: { click: () => cmd('city.borrow.answer', { borrowId: b.id, accept: true }).catch(() => {}) } }) : null,
        mineLender ? h('button', { type: 'button', class: 'btn btn-xs btn-quiet', tx: 'city.borrow.refuse', on: { click: () => cmd('city.borrow.answer', { borrowId: b.id, accept: false }).catch(() => {}) } }) : null));
    }
    const row = h('div', { class: 'ct-avs' });
    for (const a of agents) row.append(h('button', { type: 'button', class: 'ct-avbtn', title: a.name, 'aria-label': a.name, on: { click: () => openSide({ kind: 'agent', id: a.id }) } }, beeAvatar(avatarOf(a), 28, { ring: true })));
    card.append(h('div', { class: 'ct-faint small', tx: 'city.machine.agents' }), row);
    box.append(card);
  }
  box.append(h('button', { type: 'button', class: 'btn btn-xs', tx: 'city.invite', on: { click: () => invite() } }));
  requestAnimationFrame(() => box.querySelector('[data-focus="true"]')?.scrollIntoView({ block: 'nearest' }));
  return box;
}

function roomPanel(id) {
  const v = st.view;
  const r = v.rooms[id] || { id, tools: [], accepts: [] };
  const agents = Object.values(v.agents).filter((a) => a.room === id && (a.home === v.selfId || a.taskId));
  const tasks = Object.values(v.tasks).filter((x) => x.room === id && x.status !== 'done');
  const box = h('div', { class: 'ct-roompanel', style: `--c:${ROOM_COLOR[id] || r.color || '#FFB531'}` });
  box.append(
    h('div', { class: 'ct-panel-h' }, h('i', { class: 'ct-hexdot' }), h('strong', { text: roomName(id) })),
    h('p', { class: 'ct-about', text: ROOMS[id] ? tr(`city.room.about.${id}`) : '' }),
    h('div', { class: 'of-k', tx: 'city.roomPanel.rules' }),
    h('div', { class: 'ct-rules' },
      r.requireApproval ? h('span', { class: 'ct-tag ct-warn', tx: 'city.roomPanel.approval' }) : null,
      r.hostOnly ? h('span', { class: 'ct-tag ct-info', tx: 'city.roomPanel.hostOnly' }) : null,
      r.mode ? h('span', { class: 'ct-tag', text: tr(`city.roomPanel.mode.${r.mode}`) }) : null),
    h('div', { class: 'ct-faint small', tx: 'city.roomPanel.tools' }),
    r.tools.length ? h('div', { class: 'ct-tools' }, ...r.tools.map((x) => h('span', { class: 'ct-tool', 'aria-pressed': 'true', text: x }))) : h('div', { class: 'ct-faint small', tx: 'city.roomPanel.noTools' }),
    h('div', { class: 'of-k', tx: 'city.roomPanel.agents' }));
  const row = h('div', { class: 'ct-avs' });
  for (const a of agents) row.append(h('button', { type: 'button', class: 'ct-avbtn ct-avname', on: { click: () => openSide({ kind: 'agent', id: a.id }) } }, beeAvatar(avatarOf(a), 26, { ring: true }), h('span', {}, h('b', { text: a.name }), h('span', { class: 'ct-faint', text: tr(`city.agent.status.${a.status}`) }))));
  if (!agents.length) row.append(h('span', { class: 'ct-faint small', tx: 'city.roomPanel.empty' }));
  box.append(row, h('div', { class: 'of-k', tx: 'city.roomPanel.tasks' }));
  const tl = h('div', { class: 'ct-rtasks' });
  for (const x of tasks) {
    const a = x.assignee && v.agents[x.assignee];
    tl.append(h('div', { class: 'ct-rtask', dataset: { s: x.status } },
      h('div', { class: 'ct-note-t', text: x.title }),
      h('div', { class: 'ct-note-m' }, h('span', { class: 'ct-faint', text: tr(`city.task.status.${x.status}`) }), a ? h('span', { class: 'ct-who' }, beeAvatar(avatarOf(a), 16, { ring: false }), h('span', { text: a.name })) : null,
        x.loops ? h('span', { class: 'ct-faint', text: tr('city.task.loops', { n: x.loops, max: x.maxLoops }) }) : null),
      x.issues?.length ? h('div', { class: 'ct-issues', text: x.issues.slice(0, 2).join(' · ') }) : null,
      h('div', { class: 'ct-acts' },
        x.awaiting ? h('button', { type: 'button', class: 'btn btn-xs btn-primary', tx: 'city.task.approve', on: { click: () => cmd('city.task.approve', { taskId: x.id }).catch(() => {}) } }) : null,
        x.awaiting ? h('button', { type: 'button', class: 'btn btn-xs', tx: 'city.task.reject', on: { click: () => cmd('city.task.reject', { taskId: x.id, note: tr('city.task.rejectNote') }).catch(() => {}) } }) : null,
        x.status === 'blocked' ? h('button', { type: 'button', class: 'btn btn-xs', tx: 'city.task.retry', on: { click: () => cmd('city.task.retry', { taskId: x.id }).catch(() => {}) } }) : null)));
  }
  if (!tasks.length) tl.append(h('span', { class: 'ct-faint small', tx: 'city.roomPanel.noTasks' }));
  box.append(tl, h('button', { type: 'button', class: 'btn btn-xs', tx: 'city.roomPanel.back', on: { click: () => closeSide() } }));
  return box;
}

function chatWith(a) {
  office.setMode('desktop');
  wm.open('worker', a.workerId || a.id);
}

function invite() {
  office.setMode('desktop');
  wm.open('lend');
}

/* ---------- activity feed: short lines from real events ---------- */
function feed(ev) {
  if (!hud.feed) return;
  const d = ev.data || {};
  const v = viewOf(st.city, st.live);
  const title = (id) => v.tasks[id]?.title || st.city.tasks?.[id]?.title || '';
  let line = null; let tone = '';
  switch (ev.type) {
    case 'city.machine.joined': if (!d.machine?.host) { line = tr('city.feed.machineJoined', { name: d.machine?.name || '' }); tone = 'honey'; } break;
    case 'city.machine.left': line = tr('city.feed.machineLeft', { name: machineName(d.machineId) }); break;
    case 'city.agent.joined': line = tr('city.feed.agentJoined', { name: d.agent?.name || '' }); tone = 'honey'; break;
    case 'city.task.created': line = tr('city.feed.taskCreated', { title: d.task?.title || '' }); break;
    case 'city.task.claimed': line = tr('city.feed.claimed', { agent: v.agents[d.agentId]?.name || d.agentId, title: title(d.taskId) }); break;
    case 'city.task.hop': if (d.hop && d.hop.from !== d.hop.to && d.hop.from) line = tr('city.feed.hop', { title: title(d.task?.id), room: roomName(d.hop.to) }); break;
    case 'city.task.verdict': line = tr(d.passed ? 'city.feed.verdictOk' : 'city.feed.verdictBad', { agent: v.agents[d.agentId]?.name || '', title: title(d.taskId) }); tone = d.passed ? 'ok' : 'bad'; break;
    case 'city.task.done': line = tr('city.feed.done', { title: title(d.taskId) }); tone = 'ok'; break;
    case 'city.task.blocked': line = tr('city.feed.blocked', { title: title(d.taskId) }); tone = 'bad'; break;
    case 'city.borrow.requested': line = tr('city.feed.borrowAsk', { agent: v.agents[d.borrow?.agentId]?.name || '', machine: machineName(d.borrow?.to) }); tone = 'info'; break;
    case 'city.borrow.answered': if (d.accepted) { const b = st.city.borrows?.[d.borrowId]; line = tr('city.feed.borrowStart', { agent: v.agents[b?.agentId]?.name || '', machine: machineName(b?.to) }); tone = 'info'; } break;
    case 'city.borrow.ended': { const b = st.city.borrows?.[d.borrowId]; line = tr('city.feed.borrowEnd', { agent: v.agents[b?.agentId]?.name || '' }); break; }
    case 'city.agent.leveled': line = tr('city.feed.leveled', { agent: v.agents[d.agentId]?.name || '', n: d.level }); tone = 'honey'; break;
    default: break;
  }
  if (!line) return;
  const li = h('li', { dataset: { tone } }, h('span', { class: 'of-dot' }), h('span', { text: line }));
  hud.feed.prepend(li);
  while (hud.feed.children.length > 5) hud.feed.lastChild.remove();
  if (!reducedMotion() && active) li.animate([{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: 'ease-out' });
}

/* ---------- keyboard ---------- */
function onKey(e) {
  if (!active) return;
  if (e.key === 'Escape') {
    if (drag) { cancelDrag(); return; }
    if (side || scene.focus) { closeSide(); scene.fit(); paintRooms(); }
    return;
  }
  const tag = (e.target?.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === '+' || e.key === '=') scene.zoomAt(1.25, layer.clientWidth / 2, layer.clientHeight / 2);
  else if (e.key === '-') scene.zoomAt(0.8, layer.clientWidth / 2, layer.clientHeight / 2);
  else if (e.key === '0') { closeSide(); scene.fit(); }
}

/* ---------- debug and test hooks ---------- */
window.hivedeskCity = {
  get mode() { return st.mode; },
  view: () => st.view,
  scene: () => scene,
  openAgent: (id) => openSide({ kind: 'agent', id }),
  openRoom: (id) => openRoom(id),
  openMachines: (id) => { openSide({ kind: 'machine', id }); if (id) scene.focusMachine(id); },
  fit: () => { closeSide(); scene.fit(); },
  focusMachine: (id) => scene.focusMachine(id),
};

/* ---------- glyphs ---------- */
const CITY_SVG = '<svg viewBox="0 0 24 24" class="ico ico-sm"><path d="M3 20h18"/><path d="M5 20V10l4-2.5V20M9 20V5l5 3v12M14 20v-8l5-2.5V20"/><path d="M11 9.5h1M11 12.5h1M16 13h1M16 16h1M6.6 13h1M6.6 16h1"/></svg>';
function cityGlyph() { return h('span', { class: 'of-gl', html: CITY_SVG }); }
