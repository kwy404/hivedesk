// Window manager: drag, resize, snap to halves and quarters, maximize, minimize to the
// dock, z order, keyboard control and a saved layout. On phones the same windows become
// stacked cards (CSS does the layout, see hive.css).

import { h, reducedMotion, debounce } from './dom.js';
import { ui } from './store.js';
import { t, onLocale } from './i18n.js';

const V = window.V;
const LAYOUT_KEY = 'hivedesk.layout.v2';
const GAP = 10;
const EDGE = 16;

const types = new Map();
const wins = new Map(); // id -> win
const changeFns = new Set();
let desk;
let ghost;
let zTop = 10;
let openSeq = 0;
let restoring = false;

export const isPhone = () => matchMedia('(max-width: 760px)').matches;

export function onChange(fn) { changeFns.add(fn); return () => changeFns.delete(fn); }
function changed() { for (const fn of changeFns) fn(); save(); }

/**
 * @param {string} type
 * @param {{ title: string|((arg)=>string), glyph?: (arg)=>Node, icon?: string, create: (ctx)=>void,
 *   size?: [number, number], min?: [number, number], cardH?: number, multi?: boolean }} def
 */
export function register(type, def) { types.set(type, def); }
export const typeDef = (t) => types.get(t);

export function init(el) {
  desk = el;
  ghost = h('div', { class: 'snap-ghost' });
  desk.append(ghost);
  new ResizeObserver(() => { for (const w of wins.values()) place(w); }).observe(desk);
  document.addEventListener('keydown', onKey, true);
}

const deskRect = () => ({ W: desk.clientWidth, H: desk.clientHeight });

function zoneRect(zone) {
  const { W, H } = deskRect();
  const hw = (W - GAP * 3) / 2;
  const hh = (H - GAP * 3) / 2;
  switch (zone) {
    case 'max': return { x: GAP, y: GAP, w: W - GAP * 2, h: H - GAP * 2 };
    case 'left': return { x: GAP, y: GAP, w: hw, h: H - GAP * 2 };
    case 'right': return { x: GAP * 2 + hw, y: GAP, w: hw, h: H - GAP * 2 };
    case 'tl': return { x: GAP, y: GAP, w: hw, h: hh };
    case 'tr': return { x: GAP * 2 + hw, y: GAP, w: hw, h: hh };
    case 'bl': return { x: GAP, y: GAP * 2 + hh, w: hw, h: hh };
    case 'br': return { x: GAP * 2 + hw, y: GAP * 2 + hh, w: hw, h: hh };
    default: return null;
  }
}

/** Pixel rect of a window from its fractional geometry or snap zone. */
function rectOf(w) {
  const z = w.snap && zoneRect(w.snap);
  if (z) return z;
  const { W, H } = deskRect();
  const r = { x: w.g.x * W, y: w.g.y * H, w: w.g.w * W, h: w.g.h * H };
  const [mw, mh] = w.def.min || [280, 180];
  r.w = Math.max(Math.min(mw, W - 8), Math.min(r.w, W));
  r.h = Math.max(Math.min(mh, H - 8), Math.min(r.h, H));
  r.x = Math.max(-r.w + 120, Math.min(r.x, W - 120));
  r.y = Math.max(0, Math.min(r.y, H - 40));
  return r;
}

function place(w) {
  const r = rectOf(w);
  Object.assign(w.el.style, { left: `${Math.round(r.x)}px`, top: `${Math.round(r.y)}px`, width: `${Math.round(r.w)}px`, height: `${Math.round(r.h)}px`, zIndex: w.z });
  w.el.classList.toggle('maxed', w.snap === 'max');
  w.el.style.setProperty('--card-h', `${w.def.cardH || 420}px`);
}

function setG(w, r) {
  const { W, H } = deskRect();
  w.g = { x: r.x / W, y: r.y / H, w: r.w / W, h: r.h / H };
}

const ctlSvg = {
  min: '<svg viewBox="0 0 12 12"><path d="M2.5 6.5h7"/></svg>',
  max: '<svg viewBox="0 0 12 12"><rect x="2.5" y="2.5" width="7" height="7" rx="1.5"/></svg>',
  restore: '<svg viewBox="0 0 12 12"><rect x="2.2" y="4" width="5.8" height="5.8" rx="1.3"/><path d="M4.2 2.4h4a1.4 1.4 0 0 1 1.4 1.4v4"/></svg>',
  x: '<svg viewBox="0 0 12 12"><path d="M3 3l6 6M9 3L3 9"/></svg>',
};

function defaultGeom(def) {
  const { W, H } = deskRect();
  const [w, hgt] = def.size || [520, 420];
  const n = openSeq++ % 8;
  const x = Math.max(GAP, (W - w) / 2 + (n - 3) * 28);
  const y = Math.max(GAP, (H - hgt) / 2 + (n - 3) * 24);
  return { x: x / W, y: y / H, w: Math.min(w, W - 2 * GAP) / W, h: Math.min(hgt, H - 2 * GAP) / H };
}

export const idOf = (type, arg) => (arg != null && arg !== '' ? `${type}:${arg}` : type);
export const get = (id) => wins.get(id);
export const list = () => [...wins.values()];
export const focusedId = () => ui.focused;

/**
 * Opens (or focuses) a window.
 * @param {string} type
 * @param {string} [arg]
 * @param {{ g?: object, snap?: string, min?: boolean, focus?: boolean, z?: number }} [opts]
 */
export function open(type, arg, opts = {}) {
  const def = types.get(type);
  if (!def) return null;
  const id = idOf(type, arg);
  const existing = wins.get(id);
  if (existing) {
    if (existing.min) restore(id);
    else focus(id);
    return existing;
  }
  const title = titleOf(def, arg);
  const titleEl = h('div', { class: 'win-title', text: title });
  const subEl = h('div', { class: 'win-sub' });
  const glyph = h('div', { class: 'win-glyph' }, def.glyph ? def.glyph(arg) : null);
  const bMin = h('button', { class: 'mn', type: 'button', html: ctlSvg.min, ta: 'win.minimize', tip: 'tip.win.minimize', kb: 'Ctrl Alt Down' });
  const bMax = h('button', { class: 'mx', type: 'button', html: ctlSvg.max, ta: 'win.maximize', tip: 'tip.win.maximize', kb: 'Ctrl Alt Up' });
  const bX = h('button', { class: 'x', type: 'button', html: ctlSvg.x, ta: 'win.close', tip: 'tip.win.close', kb: 'Ctrl Alt W' });
  const bar = h('div', { class: 'win-bar', tabindex: '0', role: 'group', 'aria-label': t('win.barLabel', { title }) },
    glyph, titleEl, subEl, h('div', { class: 'win-sp' }), h('div', { class: 'win-ctl' }, bMin, bMax, bX));
  const body = h('div', { class: 'win-body' });
  const el = h('section', { class: 'win', 'aria-label': title, dataset: { id, type } }, bar, body,
    ...['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map((d) => h('div', { class: 'win-rz', dataset: { d }, 'aria-hidden': 'true' })));

  const w = {
    id, type, arg, def, el, bar, body, titleEl, subEl, glyph, bMax,
    g: opts.g || defaultGeom(def), snap: opts.snap || null, min: false, z: opts.z || ++zTop,
    order: openSeq, scope: V.effectScope(true), disposers: [],
  };
  zTop = Math.max(zTop, w.z);
  wins.set(id, w);
  desk.append(el);
  place(w);

  bMin.addEventListener('click', (e) => { e.stopPropagation(); minimize(id); });
  bMax.addEventListener('click', (e) => { e.stopPropagation(); toggleMax(id); });
  bX.addEventListener('click', (e) => { e.stopPropagation(); close(id); });
  el.addEventListener('pointerdown', () => focus(id, { quiet: true }), true);
  bar.addEventListener('dblclick', (e) => { if (!e.target.closest('.win-ctl') && !isPhone()) toggleMax(id); });
  bar.addEventListener('pointerdown', (e) => startDrag(e, w));
  bar.addEventListener('keydown', (e) => barKey(e, w));
  for (const rz of el.querySelectorAll('.win-rz')) rz.addEventListener('pointerdown', (e) => startResize(e, w, rz.dataset.d));

  const ctx = {
    win: w, body, el,
    setTitle: (text) => { w.fixedTitle = text; paintTitle(w, text); },
    setSub: (t) => { subEl.textContent = t || ''; },
    setGlyph: (node) => { glyph.replaceChildren(node); },
    onDispose: (fn) => w.disposers.push(fn),
    close: () => close(id),
  };
  w.scope.run(() => def.create(ctx, arg));
  updateMaxBtn(w);

  if (opts.min) { w.min = true; el.classList.add('minimized'); }
  else if (opts.focus !== false) focus(id);
  if (!restoring && !opts.min && !reducedMotion()) {
    el.animate([{ opacity: 0, transform: 'translateY(8px) scale(.985)' }, { opacity: 1, transform: 'none' }], { duration: 240, easing: 'cubic-bezier(.16,1,.3,1)' });
  }
  if (isPhone() && !restoring && opts.focus !== false) el.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
  changed();
  return w;
}

function updateMaxBtn(w) {
  const maxed = w.snap === 'max';
  w.bMax.innerHTML = maxed ? ctlSvg.restore : ctlSvg.max;
  w.bMax.dataset.ta = maxed ? 'win.restore' : 'win.maximize';
  w.bMax.setAttribute('aria-label', t(w.bMax.dataset.ta));
  w.bMax.dataset.tip = maxed ? 'tip.win.restore' : 'tip.win.maximize';
}

function titleOf(def, arg) {
  return typeof def.title === 'function' ? def.title(arg) : def.title;
}

function paintTitle(w, text) {
  w.titleEl.textContent = text;
  w.el.setAttribute('aria-label', text);
  w.bar.setAttribute('aria-label', t('win.barLabel', { title: text }));
}

// A language switch renames every window whose title comes from its type.
onLocale(() => {
  for (const w of wins.values()) if (w.fixedTitle == null) paintTitle(w, titleOf(w.def, w.arg));
  changed();
});

export function focus(id, { quiet = false } = {}) {
  const w = wins.get(id);
  if (!w) return;
  if (w.min) { restore(id); return; }
  if (ui.focused !== id) {
    w.z = ++zTop;
    w.el.style.zIndex = w.z;
    for (const o of wins.values()) o.el.classList.toggle('focused', o === w);
    ui.focused = id;
    changed();
  }
  if (!quiet) {
    const target = w.body.querySelector('[data-autofocus]') || w.bar;
    target.focus({ preventScroll: isPhone() ? false : true });
    if (isPhone()) w.el.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
  }
}

export function close(id) {
  const w = wins.get(id);
  if (!w) return;
  const done = () => {
    w.scope.stop();
    for (const fn of w.disposers) { try { fn(); } catch (err) { console.error(err); } }
    w.el.remove();
    wins.delete(id);
    if (ui.focused === id) { ui.focused = null; focusTop(); }
    changed();
  };
  if (reducedMotion() || isPhone()) done();
  else {
    w.el.style.pointerEvents = 'none';
    w.el.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(6px) scale(.965)' }], { duration: 170, easing: 'cubic-bezier(.4,0,1,1)' }).onfinish = done;
  }
}

function focusTop() {
  const top = [...wins.values()].filter((w) => !w.min).sort((a, b) => b.z - a.z)[0];
  if (top) focus(top.id, { quiet: true });
}

let dockTarget = () => null;
export function setDockTarget(fn) { dockTarget = fn; }

export function minimize(id) {
  const w = wins.get(id);
  if (!w || w.min) return;
  const target = dockTarget(id);
  const finish = () => {
    w.min = true;
    w.el.classList.add('minimized');
    w.el.style.transform = '';
    if (ui.focused === id) { ui.focused = null; focusTop(); }
    changed();
  };
  if (target && !reducedMotion() && !isPhone()) {
    const a = w.el.getBoundingClientRect();
    const b = target.getBoundingClientRect();
    const dx = b.left + b.width / 2 - (a.left + a.width / 2);
    const dy = b.top + b.height / 2 - (a.top + a.height / 2);
    const s = Math.max(0.06, b.width / a.width);
    w.el.animate([{ transform: 'none', opacity: 1 }, { transform: `translate(${dx}px, ${dy}px) scale(${s})`, opacity: 0 }], { duration: 260, easing: 'cubic-bezier(.5,0,.75,0)' }).onfinish = finish;
  } else finish();
}

export function restore(id) {
  const w = wins.get(id);
  if (!w) return;
  if (!w.min) { focus(id); return; }
  w.min = false;
  w.el.classList.remove('minimized');
  place(w);
  const target = dockTarget(id);
  if (target && !reducedMotion() && !isPhone()) {
    const a = w.el.getBoundingClientRect();
    const b = target.getBoundingClientRect();
    const dx = b.left + b.width / 2 - (a.left + a.width / 2);
    const dy = b.top + b.height / 2 - (a.top + a.height / 2);
    const s = Math.max(0.06, b.width / a.width);
    w.el.animate([{ transform: `translate(${dx}px, ${dy}px) scale(${s})`, opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 280, easing: 'cubic-bezier(.16,1,.3,1)' });
  }
  ui.focused = null;
  focus(id);
}

/** Toggle helper for the dock: open, focus, or minimize when it is already on top. */
export function toggleFromDock(type, arg) {
  const id = idOf(type, arg);
  const w = wins.get(id);
  if (!w) return open(type, arg);
  if (w.min) return restore(id);
  if (ui.focused === id && !isPhone()) return minimize(id);
  return focus(id);
}

function animateTo(w, fn) {
  if (reducedMotion()) { fn(); place(w); return; }
  w.el.classList.add('anim');
  fn();
  place(w);
  setTimeout(() => w.el.classList.remove('anim'), 340);
}

export function snap(id, zone) {
  const w = wins.get(id);
  if (!w || isPhone()) return;
  if (w.min) restore(id);
  animateTo(w, () => { w.snap = zone || null; });
  updateMaxBtn(w);
  focus(id, { quiet: true });
  changed();
}

export function toggleMax(id) {
  const w = wins.get(id);
  if (!w) return;
  if (isPhone()) { w.snap = w.snap === 'max' ? null : 'max'; place(w); updateMaxBtn(w); w.el.scrollIntoView({ block: 'start' }); changed(); return; }
  snap(id, w.snap === 'max' ? null : 'max');
}

/* ---------- pointer: drag and resize ---------- */

function zoneAt(px, py) {
  const { W, H } = deskRect();
  const corner = Math.min(120, H / 4);
  if (py <= EDGE / 2 && px > corner && px < W - corner) return 'max';
  if (px <= EDGE) return py < corner ? 'tl' : py > H - corner ? 'bl' : 'left';
  if (px >= W - EDGE) return py < corner ? 'tr' : py > H - corner ? 'br' : 'right';
  return null;
}

function showGhost(zone) {
  const r = zone && zoneRect(zone);
  if (!r) { ghost.classList.remove('on'); return; }
  Object.assign(ghost.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
  ghost.classList.add('on');
}

function startDrag(e, w) {
  if (e.button !== 0 || e.target.closest('.win-ctl') || isPhone()) return;
  const start = { x: e.clientX, y: e.clientY };
  const dr = desk.getBoundingClientRect();
  let r = rectOf(w);
  let moved = false;
  let zone = null;
  const bar = w.bar;
  bar.setPointerCapture(e.pointerId);
  const move = (ev) => {
    const dx = ev.clientX - start.x;
    const dy = ev.clientY - start.y;
    if (!moved && Math.hypot(dx, dy) < 4) return;
    if (!moved) {
      moved = true;
      w.el.classList.add('dragging');
      if (w.snap) {
        // Leaving a snapped or maximized state: keep the pointer at the same spot of the title bar.
        const free = { ...rectOf({ ...w, snap: null }) };
        const ratio = (start.x - dr.left - r.x) / r.w;
        free.x = start.x - dr.left - ratio * free.w;
        free.y = Math.max(0, start.y - dr.top - 18);
        r = free;
        w.snap = null;
        updateMaxBtn(w);
      }
    }
    const nx = r.x + dx;
    const ny = Math.max(0, r.y + dy);
    w.el.style.left = `${Math.round(nx)}px`;
    w.el.style.top = `${Math.round(ny)}px`;
    w.el.style.width = `${Math.round(r.w)}px`;
    w.el.style.height = `${Math.round(r.h)}px`;
    w.el.classList.remove('maxed');
    w._live = { x: nx, y: ny, w: r.w, h: r.h };
    zone = zoneAt(ev.clientX - dr.left, ev.clientY - dr.top);
    showGhost(zone);
  };
  const up = () => {
    bar.removeEventListener('pointermove', move);
    bar.removeEventListener('pointerup', up);
    bar.removeEventListener('pointercancel', up);
    w.el.classList.remove('dragging');
    showGhost(null);
    if (!moved) return;
    if (w._live) setG(w, w._live);
    w._live = null;
    if (zone) { snap(w.id, zone); return; }
    place(w);
    changed();
  };
  bar.addEventListener('pointermove', move);
  bar.addEventListener('pointerup', up);
  bar.addEventListener('pointercancel', up);
}

function startResize(e, w, d) {
  if (e.button !== 0 || isPhone()) return;
  e.preventDefault();
  e.stopPropagation();
  const handle = e.currentTarget;
  handle.setPointerCapture(e.pointerId);
  const start = { x: e.clientX, y: e.clientY };
  const r0 = rectOf(w);
  if (w.snap) { w.snap = null; updateMaxBtn(w); }
  const [mw, mh] = w.def.min || [280, 180];
  w.el.classList.add('resizing');
  const move = (ev) => {
    const dx = ev.clientX - start.x;
    const dy = ev.clientY - start.y;
    const r = { ...r0 };
    if (d.includes('e')) r.w = Math.max(mw, r0.w + dx);
    if (d.includes('s')) r.h = Math.max(mh, r0.h + dy);
    if (d.includes('w')) { r.w = Math.max(mw, r0.w - dx); r.x = r0.x + r0.w - r.w; }
    if (d.includes('n')) { r.h = Math.max(mh, r0.h - dy); r.y = Math.max(0, r0.y + r0.h - r.h); }
    Object.assign(w.el.style, { left: `${Math.round(r.x)}px`, top: `${Math.round(r.y)}px`, width: `${Math.round(r.w)}px`, height: `${Math.round(r.h)}px` });
    w._live = r;
  };
  const up = () => {
    handle.removeEventListener('pointermove', move);
    handle.removeEventListener('pointerup', up);
    handle.removeEventListener('pointercancel', up);
    w.el.classList.remove('resizing');
    if (w._live) setG(w, w._live);
    w._live = null;
    place(w);
    changed();
  };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', up);
  handle.addEventListener('pointercancel', up);
}

/* ---------- keyboard ---------- */

function barKey(e, w) {
  if (e.target !== w.bar || isPhone()) return;
  const step = e.altKey ? 4 : 24;
  const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  if (arrows[e.key] && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    const r = rectOf(w);
    w.snap = null;
    updateMaxBtn(w);
    const [dx, dy] = arrows[e.key];
    if (e.shiftKey) { r.w = Math.max((w.def.min || [280])[0], r.w + dx * step); r.h = Math.max((w.def.min || [0, 180])[1], r.h + dy * step); }
    else { r.x += dx * step; r.y = Math.max(0, r.y + dy * step); }
    setG(w, r);
    place(w);
    changed();
  } else if (e.key === 'Enter') { e.preventDefault(); toggleMax(w.id); }
}

function visibleOrder() {
  return [...wins.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

/** Ctrl+` cycles windows (Shift goes back). Minimized windows come back in the cycle too. */
export function cycle(dir = 1) {
  const all = visibleOrder();
  if (!all.length) return;
  const i = all.findIndex((w) => w.id === ui.focused);
  const next = all[(i + dir + all.length) % all.length];
  if (next.min) restore(next.id); else focus(next.id);
}

function onKey(e) {
  if (e.ctrlKey && (e.key === '`' || e.code === 'Backquote')) { e.preventDefault(); cycle(e.shiftKey ? -1 : 1); return; }
  if (e.ctrlKey && e.altKey && ui.focused) {
    const id = ui.focused;
    const w = wins.get(id);
    const map = { ArrowLeft: w?.snap === 'right' ? null : 'left', ArrowRight: w?.snap === 'left' ? null : 'right', ArrowUp: 'max' };
    if (e.key in map) { e.preventDefault(); snap(id, map[e.key]); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); if (w?.snap) snap(id, null); else minimize(id); return; }
    if (e.key.toLowerCase() === 'w') { e.preventDefault(); close(id); return; }
    const quarter = { '1': 'tl', '2': 'tr', '3': 'bl', '4': 'br' }[e.key];
    if (quarter) { e.preventDefault(); snap(id, quarter); }
  }
}

/* ---------- layout ---------- */

const save = debounce(() => {
  if (restoring) return;
  try {
    const data = {
      wins: visibleOrder().map((w) => ({ type: w.type, arg: w.arg ?? null, g: w.g, snap: w.snap, min: w.min, z: w.z })),
      focused: ui.focused,
    };
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(data));
  } catch {}
}, 250);

export function savedLayout() {
  try { return JSON.parse(localStorage.getItem(LAYOUT_KEY) || 'null'); } catch { return null; }
}

export function applyLayout(layout) {
  restoring = true;
  for (const id of [...wins.keys()]) { const w = wins.get(id); w.scope.stop(); for (const fn of w.disposers) fn(); w.el.remove(); wins.delete(id); }
  ui.focused = null;
  const items = (layout?.wins || []).filter((x) => types.has(x.type));
  for (const x of items) open(x.type, x.arg ?? undefined, { g: x.g, snap: x.snap, min: x.min, z: x.z, focus: false });
  restoring = false;
  const f = layout?.focused && wins.get(layout.focused) && !wins.get(layout.focused).min ? layout.focused : null;
  if (f) focus(f, { quiet: true }); else focusTop();
  changed();
}

/** Arranges every open window in a tidy grid (desktop context menu: Arrange). */
export function arrange(mode = 'grid') {
  const open = visibleOrder().filter((w) => !w.min);
  if (!open.length) return;
  const { W, H } = deskRect();
  if (mode === 'cascade') {
    open.forEach((w, i) => animateTo(w, () => {
      w.snap = null;
      const ww = Math.min(W * 0.55, 900);
      const hh = Math.min(H * 0.7, 680);
      setG(w, { x: GAP + 40 + i * 30, y: GAP + 10 + i * 28, w: ww, h: hh });
      w.z = ++zTop;
    }));
  } else {
    const n = open.length;
    const cols = Math.ceil(Math.sqrt(n * (W / H) / 1.4));
    const rows = Math.ceil(n / cols);
    const cw = (W - GAP * (cols + 1)) / cols;
    const ch = (H - GAP * (rows + 1)) / rows;
    open.forEach((w, i) => animateTo(w, () => {
      w.snap = null;
      const c = i % cols;
      const r = Math.floor(i / cols);
      setG(w, { x: GAP + c * (cw + GAP), y: GAP + r * (ch + GAP), w: cw, h: ch });
    }));
  }
  open.forEach(updateMaxBtn);
  changed();
}

export function minimizeAll() { for (const w of wins.values()) if (!w.min) minimize(w.id); }
