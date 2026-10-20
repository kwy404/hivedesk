// Hive City: an isometric little world of floating islands, drawn on one canvas with the Office
// kit (docs/1.0/DESIGN.md, section 5). Your building shows its rooms as an open architectural
// model, friend machines rise as towers on their own islands, and bridges carry data between them.
// Nothing here moves by itself: every walk, construction and glow follows a change in the city
// state (ui/city/model.js), which only changes from engine events. The load ring on a roof core
// is the measured GPU use (no ring when nothing measured it), the VRAM bar is the measured or
// reported memory, a bridge streams particles only while a job streams tokens over it, a failed
// job breaks the deck, a check that sends a task back draws a loop arc, and the Test light shows
// the last QA verdict. Colors come from the theme tokens through ui/js/art.js.

import { beeSvg } from '/js/bees.js';
import { mdLine } from '/js/md.js';
import {
  nightFactor, goldenFactor, roundRect, hexPath, hexScreen, wrap, drawNameTag, drawBubble, drawPill,
  iconCheck, drawNoteIcon, drawParcel,
} from '/office/scene.js';
import { artTokens, worldPalette, statusColor, tone, mixHex, shade, alpha, rgb } from '/js/art.js';
import {
  HOME, FRIEND_R, ROOMS, BUILDING, ENTRANCE, PLAZA, WALK_Z, SEAT_Z, roomCenter, spotFor, hexCorners, friendCenter, bridgeTo,
  bridgePoint, towerOf, roomPath, exitPath, roomAt, CORRIDOR_Y,
} from './layout.js';
import { ROOM_COLOR, ROOM_KINDS, borrowOf } from './model.js';

const FRAME_LOG = 240;

const FONT = '"Inter","Segoe UI Variable Text","Segoe UI",system-ui,-apple-system,sans-serif';
const MONO = '"JetBrains Mono","Cascadia Mono","Cascadia Code",ui-monospace,Consolas,monospace';
const ZK = 1.12;
const WALL = 2.25;
const PART = 0.36;
const DW = 1.5;
const DD = 0.72;
const DH = 0.55;
const FLOOR_H = 1.25;
const TANK = { x: -1.6, y: -1.4, z: 3.2 };
const WALK_SPEED = 3.1;

const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const roomColor = (k) => tone(ROOM_COLOR[k] || '#8A919B', 0.28);

export class CityScene {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{ getCity: () => object, reduced?: () => boolean, hour?: () => number, t: (k: string, p?: object) => string,
   *   onFrame?: (scene: CityScene) => void, onSound?: (name: string) => void }} opts
   */
  constructor(canvas, opts) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.opts = opts;
    this.t = opts.t || ((k) => k);
    this.getCity = opts.getCity;
    this.reducedFn = opts.reduced || (() => false);
    this.hourFn = opts.hour || (() => { const d = new Date(); return d.getHours() + d.getMinutes() / 60; });
    this.sound = opts.onSound || (() => {});
    this.w = 0; this.h = 0; this.dpr = 1;
    this.now = 0;
    this.running = false;
    this.loop = this.loop.bind(this);
    this.cam = { x: HOME.cx + 2, y: HOME.cy + 1, z: 0.6, A: 26 };
    this.camT = { ...this.cam };
    this.camSet = false;
    this.focus = null; // { kind: 'room', id } | { kind: 'machine', id }
    this.highlight = null; // { kind, id }
    this.dropTarget = null;
    this.actors = new Map();
    this.machines = new Map(); // id -> { id, slot, center, bridge, born, glow }
    this.notes = new Map();
    this.parts = [];
    this.couriers = [];
    this.trafficSeen = new Set();
    this.sprites = new Map();
    this.hits = [];
    this.machineHits = [];
    this.synced = false;
    this.stars = Array.from({ length: 60 }, (_, i) => ({ x: ((i * 7919) % 1000) / 1000, y: ((i * 4157) % 1000) / 1000, r: 0.5 + ((i * 13) % 5) / 8 }));
    this.palAt = -1;
    this.buildPaths();
  }

  reduced() { return this.reducedFn(); }

  /* ---------- lifecycle ---------- */
  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    this.lastDraw = 0;
    this.raf = requestAnimationFrame(this.loop);
  }

  stop() { this.running = false; cancelAnimationFrame(this.raf); }

  resize(w, h) {
    if (!w || !h) return;
    this.w = w; this.h = h;
    let dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (w * h * dpr * dpr > 4.2e6) dpr = Math.max(1, Math.sqrt(4.2e6 / (w * h)));
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.skyGrad = null;
    if (!this.camSet) { this.fit(true); }
    else if (this.focus?.kind === 'room') this.focusRoom(this.focus.id, true);
    if (!this.running) this.draw();
  }

  loop(ts) {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.loop);
    const calm = this.isCalm();
    if (calm && ts - this.lastDraw < 1000 / 30 - 2) return;
    const dt = Math.min(0.1, (ts - this.last) / 1000);
    const gap = ts - this.last;
    this.last = ts;
    this.lastDraw = ts;
    this.now += dt;
    const t0 = performance.now();
    this.update(dt);
    this.draw();
    this.opts.onFrame?.(this);
    const log = this.frames || (this.frames = []);
    log.push({ gap, work: performance.now() - t0, calm });
    if (log.length > FRAME_LOG) log.splice(0, log.length - FRAME_LOG);
  }

  /** Frame statistics of the last frames: the interval between frames and the work of one frame, in ms. */
  perf() {
    const log = (this.frames || []).filter((f) => !f.calm);
    if (!log.length) return { frames: 0 };
    const q = (arr, k) => { const a = [...arr].sort((x, y) => x - y); return Math.round(a[Math.min(a.length - 1, Math.floor(a.length * k))] * 10) / 10; };
    const gaps = log.map((f) => f.gap); const work = log.map((f) => f.work);
    return { frames: log.length, fps: Math.round(1000 / (gaps.reduce((a, b) => a + b, 0) / gaps.length)), gapP50: q(gaps, 0.5), gapP95: q(gaps, 0.95), workP50: q(work, 0.5), workP95: q(work, 0.95), w: this.w, h: this.h, dpr: this.dpr };
  }

  /** Forgets the buildings, bees and notes on screen, for another city (a friend's, or back home). */
  reset() {
    this.actors.clear(); this.machines.clear(); this.notes.clear(); this.couriers = []; this.parts = [];
    this.trafficSeen = new Set(); this.synced = false; this.focus = null; this.highlight = null; this.camSet = false;
    if (this.w) this.fit(true);
  }

  isCalm() {
    if (this.parts.length || this.couriers.length) return false;
    if (Math.abs(this.cam.A - this.camT.A) > 0.05 || Math.abs(this.cam.x - this.camT.x) > 0.01 || Math.abs(this.cam.y - this.camT.y) > 0.01) return false;
    for (const a of this.actors.values()) if (a.path.length || a.mode === 'working' || a.mode === 'thinking') return false;
    for (const m of this.machines.values()) if (this.now - m.born < 6 || m.m?.bridge?.live || m.m?.bridge?.running) return false;
    const c = this.getCity();
    if (c?.loops?.length || c?.download || c?.qa?.running) return false;
    return true;
  }

  /* ---------- camera ---------- */
  get A() { return this.cam.A; }
  P(x, y, z = 0) {
    const A = this.cam.A; const B = A / 2; const C = A * ZK;
    return [this.ox + (x - y) * A, this.oy + (x + y) * B - z * C];
  }
  computeOrigin() {
    const A = this.cam.A; const B = A / 2; const C = A * ZK;
    this.ox = this.w / 2 - (this.cam.x - this.cam.y) * A;
    this.oy = this.h / 2 - (this.cam.x + this.cam.y) * B + this.cam.z * C;
  }
  /** World point on the ground (z = 0) under a screen point. */
  unproject(sx, sy) {
    const A = this.cam.A; const B = A / 2;
    const u = (sx - this.ox) / A; const v = (sy - this.oy) / B;
    return { x: (u + v) / 2, y: (v - u) / 2 };
  }

  /** Screen size needed for a world box (iso bounding box) at zoom 1. */
  isoBox(pts) {
    let x0 = Infinity; let x1 = -Infinity; let y0 = Infinity; let y1 = -Infinity;
    for (const [x, y, z = 0] of pts) {
      const sx = x - y; const sy = (x + y) / 2 - z * ZK;
      x0 = Math.min(x0, sx); x1 = Math.max(x1, sx); y0 = Math.min(y0, sy); y1 = Math.max(y1, sy);
    }
    return { x0, x1, y0, y1 };
  }

  /** Frames a set of world points. */
  frame(pts, margin = { l: 60, r: 60, t: 90, b: 120 }, instant = false, maxA = 140) {
    const b = this.isoBox(pts);
    const A = clamp(Math.min((this.w - margin.l - margin.r) / Math.max(1, b.x1 - b.x0), (this.h - margin.t - margin.b) / Math.max(1, b.y1 - b.y0)), 6, maxA);
    // center of the box in iso space, back to a ground point
    const cxs = (b.x0 + b.x1) / 2 + ((margin.l - margin.r) / 2) / -A;
    const cys = (b.y0 + b.y1) / 2 + ((margin.t - margin.b) / 2) / -A;
    // ground point (z = 0) whose iso is (cxs, cys): x - y = cxs, (x + y) / 2 = cys
    this.camT = { x: cys + cxs / 2, y: cys - cxs / 2, z: 0, A };
    this.camSet = true;
    if (instant || this.reduced()) this.cam = { ...this.camT };
  }

  fit(instant = false) {
    this.focus = null;
    this.userMoved = false;
    const pts = [];
    for (const [x, y] of hexCorners(HOME.cx, HOME.cy, HOME.r)) pts.push([x, y, 0], [x, y, -2]);
    pts.push([0, 0, WALL + 3.2]);
    for (const m of this.machines.values()) {
      for (const [x, y] of hexCorners(m.center.x, m.center.y, FRIEND_R)) pts.push([x, y, 0], [x, y, -1.5]);
      pts.push([m.center.x, m.center.y, 9]);
    }
    const narrow = this.w < 760;
    const ins = this.insets;
    this.frame(pts, narrow ? { l: 16, r: 16, t: 120, b: 150 } : ins ? { l: ins.l, r: ins.r, t: ins.t, b: ins.b } : { l: this.w < 1100 ? 30 : 330, r: this.panelRight ? 410 : 40, t: 100, b: 110 }, instant, 46);
  }

  focusRoom(id, instant = false) {
    const r = ROOMS[id];
    if (!r) return;
    this.focus = { kind: 'room', id };
    const pts = [[r.x0, r.y0, 0], [r.x1, r.y0, 0], [r.x1, r.y1, 0], [r.x0, r.y1, 0], [r.x0, r.y0, r.row === 'back' ? WALL + 0.4 : 2.2], [r.x1, r.y0, r.row === 'back' ? WALL + 0.4 : 2.2]];
    const narrow = this.w < 760;
    const ins = this.insets;
    this.frame(pts, narrow ? { l: 16, r: 16, t: 140, b: 260 } : ins ? { l: ins.l + 10, r: ins.r + 10, t: ins.t + 10, b: ins.b + 30 } : { l: 340, r: 420, t: 110, b: 150 }, instant, 170);
  }

  focusMachine(id, instant = false) {
    const m = this.machines.get(id);
    const city = this.getCity();
    if (!m || id === city.selfId) { this.fit(instant); return; }
    this.focus = { kind: 'machine', id };
    const pts = [];
    for (const [x, y] of hexCorners(m.center.x, m.center.y, FRIEND_R)) pts.push([x, y, 0]);
    pts.push([m.center.x, m.center.y, this.towerHeight(m) + 3], [m.bridge.a.x, m.bridge.a.y, 0], [PLAZA.x, PLAZA.y, 0]);
    const ins = this.insets;
    this.frame(pts, ins ? { l: ins.l + 10, r: ins.r + 10, t: ins.t + 10, b: ins.b + 30 } : { l: 330, r: 420, t: 110, b: 150 }, instant, 60);
  }

  zoomAt(factor, sx, sy) {
    const before = this.unproject(sx, sy);
    const A = clamp(this.camT.A * factor, 8, 190);
    // keep the point under the cursor fixed
    const cur = this.cam;
    this.cam = { ...this.camT, A };
    this.computeOrigin();
    const after = this.unproject(sx, sy);
    this.cam = cur;
    this.camT = { ...this.camT, A, x: this.camT.x + before.x - after.x, y: this.camT.y + before.y - after.y };
    this.userMoved = true;
    if (this.reduced()) this.cam = { ...this.camT };
    if (this.focus && A < 40) this.focus = null;
  }

  panBy(dx, dy) {
    this.userMoved = true;
    const A = this.camT.A; const B = A / 2;
    const u = -dx / A; const v = -dy / B;
    this.camT.x += (u + v) / 2; this.camT.y += (v - u) / 2;
    this.cam.x += (u + v) / 2; this.cam.y += (v - u) / 2;
  }

  /* ---------- state sync: diffs drive every animation ---------- */
  sync() {
    const c = this.getCity();
    if (!c?.ready) return;
    const first = !this.synced;
    // machines: a new friend raises a building
    const friendsList = Object.values(c.machines).filter((m) => m.id !== c.selfId).sort((a, b) => String(a.joinedAt || '').localeCompare(String(b.joinedAt || '')) || a.id.localeCompare(b.id));
    const seenM = new Set();
    for (const m of friendsList) {
      seenM.add(m.id);
      let s = this.machines.get(m.id);
      if (!s) {
        const used = new Set([...this.machines.values()].map((x) => x.slot));
        let slot = 0; while (used.has(slot)) slot++;
        const center = friendCenter(slot);
        s = { id: m.id, slot, center, bridge: bridgeTo(center), born: first || this.reduced() ? -99 : this.now, glow: 0, m };
        this.machines.set(m.id, s);
        if (!first) { this.sound('build'); if (!this.userMoved && !this.focus) this.later(0.05, () => this.fit()); }
      }
      s.m = m;
    }
    for (const [id, s] of this.machines) if (!seenM.has(id)) { if (!s.leaving) s.leaving = this.now; if (this.now - s.leaving > 1.5 || first) this.machines.delete(id); }
    // agents
    const byPlace = new Map();
    const agents = Object.values(c.agents).sort((a, b) => a.id.localeCompare(b.id));
    const seenA = new Set();
    for (const ag of agents) {
      seenA.add(ag.id);
      const place = this.placeOf(c, ag, byPlace);
      let a = this.actors.get(ag.id);
      if (!a) {
        a = this.addActor(ag, place, first);
      } else {
        a.ag = ag;
        // a walk is never cut short: the newest place waits until the bee arrives and has stayed a moment
        if (a.placeKey !== place.key) { if (a.path.length || this.now < (a.dwellUntil || 0)) a.next = place; else this.walk(a, place); }
        else a.next = null;
        // a new level is a quiet badge in the tag, never a burst
        if (a.status !== ag.status && ag.status === 'idle' && a.status !== 'idle') a.idleSince = this.now;
      }
      a.level = ag.level; a.xp = ag.xp; a.status = ag.status;
    }
    for (const [id, a] of this.actors) if (!seenA.has(id) && !a.leaving) this.retire(a);
    // tasks: cards on the room boards, flying when they change room
    const seenT = new Set();
    for (const t of Object.values(c.tasks)) {
      seenT.add(t.id);
      const room = t.status === 'done' || !ROOMS[t.room] ? 'lobby' : t.room;
      let n = this.notes.get(t.id);
      if (!n) { n = { id: t.id, room, t, born: first ? -99 : this.now, fly: null }; this.notes.set(t.id, n); if (!first) this.sound('stick'); }
      else if (n.room !== room) {
        const from = this.notePos(n);
        n.room = room;
        n.fly = { from, t0: this.now };
        if (t.status === 'done') { const a = t.assignee && this.actors.get(t.assignee); if (a) this.success(a); this.sound('pass'); }
      }
      if (n.t.status !== t.status && t.status === 'done' && n.room === room) { const a = this.actors.get(t.assignee); if (a) this.success(a); }
      n.t = t;
    }
    for (const [id, n] of this.notes) if (!seenT.has(id)) { if (!n.gone) n.gone = this.now; if (this.now - n.gone > 0.6) this.notes.delete(id); }
    this.layoutBoards();
    // bridge traffic: tasks and GPU turns travel as data packets
    for (const tr of c.traffic || []) {
      if (this.trafficSeen.has(tr.id)) continue;
      this.trafficSeen.add(tr.id);
      if (first) continue;
      const friend = tr.from === c.selfId ? tr.to : tr.from;
      const m = this.machines.get(friend);
      if (!m) continue;
      m.glow = Math.min(1.6, m.glow + 0.7);
      if (this.hostGlow) this.hostGlow.glow = Math.min(1.6, this.hostGlow.glow + 0.5);
      if (this.reduced()) continue;
      const T = artTokens();
      this.couriers.push({ m, kind: tr.kind, dir: tr.from === c.selfId ? 1 : -1, t0: this.now, dur: tr.kind === 'turn' ? 1.1 : 1.6, color: tr.kind === 'turn' ? T.link : T.accent });
      if (tr.kind === 'turn') this.sound('blip');
    }
    if (this.trafficSeen.size > 400) this.trafficSeen = new Set([...this.trafficSeen].slice(-200));
    this.synced = true;
  }

  /** Where an agent should be: a room spot, a friend's roof (borrowing a GPU) or a friend's terrace. */
  placeOf(c, ag, byPlace) {
    const b = borrowOf(c, ag.id);
    if (b && (b.to === c.selfId || this.machines.has(b.to))) return { key: `roof:${b.to}`, kind: 'roof', machine: b.to, host: b.to === c.selfId };
    const home = ag.home || c.selfId;
    // a friend's agent stays on its own island until it holds a task in your building
    if (home !== c.selfId && this.machines.has(home) && (!ag.taskId || c.machines[home]?.online === false)) {
      const k = `terrace:${home}`;
      const i = byPlace.get(k) || 0; byPlace.set(k, i + 1);
      return { key: `${k}:${i}`, kind: 'terrace', machine: home, i };
    }
    const room = ROOMS[ag.room] ? ag.room : 'lobby';
    const i = byPlace.get(room) || 0; byPlace.set(room, i + 1);
    return { key: `room:${room}:${i}`, kind: 'room', room, i };
  }

  placePoint(place) {
    if (place.kind === 'room') { const s = spotFor(place.room, place.i); return { x: s.x, y: s.y, z: s.desk ? SEAT_Z : WALK_Z, desk: s.desk }; }
    if (place.kind === 'roof' && place.host) return { x: TANK.x + 0.9, y: TANK.y + 0.9, z: TANK.z + 2.2 };
    const m = this.machines.get(place.machine);
    if (!m) return { x: ENTRANCE.x, y: ENTRANCE.y, z: WALK_Z };
    if (place.kind === 'roof') { const tw = towerOf(m.center); return { x: tw.x1 - 0.9, y: tw.y1 - 0.9, z: this.towerHeight(m) + 0.55 }; }
    const fx = m.center.x + 3.7; const fy = m.center.y + 3.7;
    const off = (place.i % 4) - 1.5;
    return { x: fx + off * 0.9, y: fy - off * 0.9, z: WALK_Z };
  }

  addActor(ag, place, first) {
    const p = this.placePoint(place);
    const a = {
      id: ag.id, ag, placeKey: place.key, place, pos: { x: p.x, y: p.y, z: p.z }, desk: p.desk, path: [], alpha: 1, born: first ? -99 : this.now,
      ph: Math.random() * 6.28, level: ag.level, xp: ag.xp, status: ag.status, idleSince: this.now - 30,
      bubble: null, sx: 0, sy: 0, facing: 1,
    };
    // a friend's agent steps out once its building is up
    const mb = place.machine && this.machines.get(place.machine);
    if (!first && mb && this.now - mb.born < 4) a.born = mb.born + 4;
    if (!first && !this.reduced() && place.kind === 'room') {
      a.pos = { x: PLAZA.x, y: PLAZA.y + 1.5, z: WALK_Z };
      a.alpha = 0;
      this.walk(a, place, true);
      this.sound('build');
    }
    this.actors.set(ag.id, a);
    return a;
  }

  retire(a) {
    if (this.reduced()) { this.actors.delete(a.id); return; }
    a.leaving = this.now;
    const from = a.place.kind === 'room' ? a.place.room : 'lobby';
    a.path = [...roomPath(from, a.pos, 'lobby', { x: 8, y: 8.6 }), { ...ENTRANCE, z: WALK_Z }, { ...PLAZA, z: WALK_Z }, { x: PLAZA.x, y: PLAZA.y + 2, z: 2.5 }].map((p) => ({ z: WALK_Z, ...p }));
    a.onDone = () => this.actors.delete(a.id);
  }

  /** Builds the walking path between two places and starts the walk. */
  walk(a, place, entering = false) {
    const to = this.placePoint(place);
    const prev = a.place;
    a.place = place;
    a.placeKey = place.key;
    a.desk = to.desk;
    if (this.reduced()) { a.pos = { ...to }; a.path = []; return; }
    let pts = [];
    const roomOfPos = roomAt(a.pos.x, a.pos.y) || (prev?.kind === 'room' ? prev.room : 'lobby');
    const up = WALL + 1.8;
    if (entering) pts = [{ ...ENTRANCE }, { x: 8, y: 8.6 }, ...roomPath('lobby', null, place.room, to)];
    else if (place.kind === 'roof' && place.host) pts = [{ x: a.pos.x, y: a.pos.y, z: up }, { x: TANK.x + 1.2, y: TANK.y + 1.2, z: TANK.z + 2.8 }, to];
    else if (prev?.kind === 'roof' && prev.host && place.kind === 'room') pts = [{ x: a.pos.x + 0.4, y: a.pos.y + 0.4, z: TANK.z + 2.8 }, { x: to.x, y: to.y, z: up }, to];
    else if (place.kind === 'room' && prev?.kind === 'room') pts = roomPath(roomOfPos, a.pos, place.room, to);
    else if (place.kind === 'room' && prev && prev.kind !== 'room') {
      // back over the bridge, in through the entrance
      const m = this.machines.get(prev.machine);
      pts = m ? [...this.friendLeave(m, a.pos), ...exitPath('lobby', m.bridge).reverse(), ...roomPath('lobby', null, place.room, to)] : roomPath('lobby', null, place.room, to);
    } else if (place.kind !== 'room') {
      const m = this.machines.get(place.machine);
      if (prev?.kind === 'room' || !prev) pts = [...exitPath(roomOfPos, m.bridge), ...this.friendArrive(m, place, to)];
      else pts = [to];
    }
    if (!pts.length) pts = [to];
    pts[pts.length - 1] = { ...to };
    a.path = pts.map((p) => ({ x: p.x, y: p.y, z: p.z != null ? p.z : WALK_Z, bridge: p.z != null && p !== to }));
    a.path[a.path.length - 1].final = true;
    this.sound('whoosh');
  }

  /** From the end of the bridge around the tower to its terrace, or up to the roof. */
  friendArrive(m, place, to) {
    const c = m.center;
    const end = m.bridge.b;
    const ang0 = Math.atan2(end.y - c.y, end.x - c.x);
    const ang1 = Math.PI / 4;
    const pts = [];
    let d = ang1 - ang0;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    const steps = Math.max(1, Math.round(Math.abs(d) / 0.5));
    for (let i = 1; i <= steps; i++) { const an = ang0 + (d * i) / steps; pts.push({ x: c.x + Math.cos(an) * 4.4, y: c.y + Math.sin(an) * 4.4, z: WALK_Z }); }
    if (place.kind === 'roof') {
      const h = this.towerHeight(m);
      pts.push({ x: to.x + 0.8, y: to.y + 0.8, z: h * 0.5 }, { x: to.x + 0.3, y: to.y + 0.3, z: h + 1.2 });
    }
    pts.push(to);
    return pts;
  }

  friendLeave(m, pos) {
    const c = m.center;
    const end = m.bridge.b;
    const pts = [];
    if (pos.z > 2) pts.push({ x: pos.x + 0.5, y: pos.y + 0.5, z: pos.z + 0.8 }, { x: c.x + 3.4, y: c.y + 3.4, z: 2 });
    const ang0 = Math.atan2(pos.y - c.y, pos.x - c.x);
    const ang1 = Math.atan2(end.y - c.y, end.x - c.x);
    let d = ang1 - ang0;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    const steps = Math.max(1, Math.round(Math.abs(d) / 0.5));
    for (let i = 1; i <= steps; i++) { const an = ang0 + (d * i) / steps; pts.push({ x: c.x + Math.cos(an) * 4.4, y: c.y + Math.sin(an) * 4.4, z: WALK_Z }); }
    return pts;
  }

  towerHeight(m) {
    const vram = m.m?.gpu?.vramBytes || 4 * 1024 ** 3;
    const floors = clamp(Math.round(vram / (4 * 1024 ** 3)) + 1, 2, 5);
    return floors * FLOOR_H + 0.4;
  }

  /* ---------- task boards ---------- */
  boardOf(room) {
    // back rooms: on the back wall; the Lobby and Ops: a standing board; the Library: the left wall
    const r = ROOMS[room];
    if (room.startsWith('m:')) {
      const m = this.machines.get(room.slice(2));
      if (!m) return null;
      const tw = towerOf(m.center);
      return { kind: 'stand', x0: tw.x1 + 0.35, x1: tw.x1 + 2.25, y: tw.y1 + 0.8, z0: 0.5, z1: 1.75, cols: 2, color: tone(m.m?.color || '#62B98C') };
    }
    if (!r) return null;
    if (r.row === 'back') return { kind: 'wallR', x0: r.x0 + 0.35, x1: r.x0 + 2.05, y: 0, z0: 0.62, z1: 1.72, cols: 2, color: roomColor(room) };
    if (room === 'library') return { kind: 'wallL', y0: 5.75, y1: 7.5, x: 0, z0: 0.62, z1: 1.72, cols: 2, color: roomColor(room) };
    if (room === 'lobby') return { kind: 'stand', x0: 9.2, x1: 11.7, y: 5.9, z0: 0.48, z1: 1.9, cols: 3, color: roomColor(room) };
    return { kind: 'stand', x0: 12.4, x1: 13.9, y: 5.85, z0: 0.48, z1: 1.55, cols: 2, color: roomColor(room) };
  }

  layoutBoards() {
    const by = new Map();
    for (const n of this.notes.values()) {
      if (n.gone) continue;
      if (!by.has(n.room)) by.set(n.room, []);
      by.get(n.room).push(n);
    }
    for (const [room, list] of by) {
      list.sort((a, b) => (a.t.status === 'done') - (b.t.status === 'done') || a.id.localeCompare(b.id));
      const bd = this.boardOf(room);
      if (!bd) continue;
      list.forEach((n, i) => { n.slot = i; n.board = bd; n.hidden = i >= bd.cols * 3; });
      by.get(room).count = list.length;
    }
    this.boardCounts = by;
  }

  /** World position of a note's center on its board. */
  notePos(n, slot = n.slot ?? 0, bd = n.board || this.boardOf(n.room)) {
    if (!bd) return { x: ENTRANCE.x, y: ENTRANCE.y, z: 1 };
    const col = slot % bd.cols; const row = Math.floor(slot / bd.cols) % 3;
    const zt = bd.z1 - 0.32 - row * 0.34;
    if (bd.kind === 'wallL') { const w = (bd.y1 - bd.y0) / bd.cols; return { x: 0.02, y: bd.y1 - (col + 0.5) * w, z: zt }; }
    const w = (bd.x1 - bd.x0) / bd.cols;
    return { x: bd.x0 + (col + 0.5) * w, y: bd.y + (bd.kind === 'stand' ? -0.06 : 0.02), z: zt };
  }

  /* ---------- effects: quiet, short, state driven ---------- */
  spawn(p) {
    if (this.reduced()) return;
    if (this.parts.length > 120) this.parts.shift();
    p.age = 0;
    if (p.max == null) p.max = p.life;
    this.parts.push(p);
  }
  /** A finished task: a check mark over the unit and one short pulse at its feet. */
  success(a) {
    this.spawn({ kind: 'pulse', id: a.id, life: 0.4, max: 0.4 });
    this.spawn({ kind: 'check', id: a.id, life: 1.4, max: 1.4 });
  }
  later(sec, fn) { (this.timers ||= []).push({ at: this.now + sec, fn }); }

  get k() { return (this.cam.A * 1.5) / 64; }

  /* ---------- per frame update ---------- */
  update(dt) {
    const reduced = this.reduced();
    // camera eases toward its target
    const kc = reduced ? 1 : 1 - Math.pow(0.0009, dt);
    this.cam.x = lerp(this.cam.x, this.camT.x, kc);
    this.cam.y = lerp(this.cam.y, this.camT.y, kc);
    this.cam.z = lerp(this.cam.z, this.camT.z, kc);
    this.cam.A = Math.exp(lerp(Math.log(this.cam.A), Math.log(this.camT.A), kc));
    if (this.timers?.length) {
      for (let i = this.timers.length - 1; i >= 0; i--) if (this.now >= this.timers[i].at) { const t = this.timers[i]; this.timers.splice(i, 1); t.fn(); }
    }
    const c = this.getCity();
    for (const a of this.actors.values()) {
      if (a.path.length) {
        const to = a.path[0];
        const dx = to.x - a.pos.x; const dy = to.y - a.pos.y; const dz = to.z - a.pos.z;
        const dist = Math.hypot(dx, dy, dz * 0.7);
        const step = WALK_SPEED * (a.path.length > 14 ? 2.6 : a.path.length > 6 ? 1.3 : 1) * dt;
        if (Math.abs(dx - dy) > 0.01) a.facing = dx - dy > 0 ? 1 : -1;
        if (dist <= step) {
          a.pos = { x: to.x, y: to.y, z: to.z };
          a.path.shift();
          if (!a.path.length) { a.onDone?.(); a.onDone = null; a.dwellUntil = this.now + (a.place.kind === 'room' && a.ag.taskId ? 2.5 : 0.6); }
        } else {
          a.pos.x += (dx / dist) * step; a.pos.y += (dy / dist) * step; a.pos.z += (dz / dist) * step;
        }
      }
      if (a.next && !a.path.length && this.now >= (a.dwellUntil || 0)) { const nx = a.next; a.next = null; if (nx.key !== a.placeKey) this.walk(a, nx); }
      if (a.born > 0) a.alpha = clamp((this.now - a.born) / 0.25);
      if (a.leaving) a.alpha = 1 - clamp((this.now - a.leaving - 1.2) / 0.6);
      const st = a.ag.status;
      a.mode = a.path.length ? 'walk' : st === 'working' ? 'working' : st === 'thinking' ? 'thinking' : st === 'waiting' ? 'waiting' : st === 'reviewing' ? 'reviewing' : st === 'testing' ? 'testing' : st === 'sleeping' || st === 'offline' ? 'sleep' : 'idle'; // only a sleeping or offline agent dozes: an idle one is awake and free
      if (a.place.kind === 'roof' && !a.path.length) a.mode = 'borrow';
      if (a.bubble && this.now > a.bubble.until) a.bubble = null;
    }
    for (const m of this.machines.values()) m.glow = Math.max(borrowTo(c, m.id) ? 0.6 : 0, m.glow - dt * 0.35);
    if (this.hostGlow) this.hostGlow.glow = Math.max(0, this.hostGlow.glow - dt * 0.35);
    for (let i = this.couriers.length - 1; i >= 0; i--) if (this.now - this.couriers[i].t0 > this.couriers[i].dur) this.couriers.splice(i, 1);
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const p = this.parts[i];
      p.age += dt;
      if (p.age >= p.max) { this.parts.splice(i, 1); continue; }
    }
  }

  /* ---------- palette ---------- */
  palette() {
    const h = this.hourFn();
    const T = artTokens();
    const key = `${Math.round(h * 12)}|${T.bg}|${T.accent}|${T.scheme}`;
    if (key === this.palAt && this.pal) return this.pal;
    this.palAt = key;
    const night = nightFactor(h);
    const gold = goldenFactor(h) * (1 - night * 0.6);
    this.pal = { ...worldPalette(night), gold, hour: h };
    this.skyGrad = null;
    return this.pal;
  }

  buildPaths() {
    // hexagon grids around the origin: hairlines only (the honeycomb stays, quietly)
    const mk = (r, span) => {
      const hw = Math.sqrt(3) * r; const vh = 1.5 * r;
      const grout = new Path2D();
      const alt = new Path2D();
      for (let row = -Math.ceil(span / vh) - 1; row * vh < span + r; row++) {
        for (let col = -Math.ceil(span / hw) - 1; col * hw < span + hw; col++) {
          const cx = col * hw + (row & 1 ? hw / 2 : 0); const cy = row * vh;
          const q = col - (row - (row & 1)) / 2;
          const p = new Path2D();
          for (let i = 0; i < 6; i++) { const an = (Math.PI / 180) * (60 * i - 30); const px = cx + r * Math.cos(an); const py = cy + r * Math.sin(an); if (i === 0) p.moveTo(px, py); else p.lineTo(px, py); }
          p.closePath();
          grout.addPath(p);
          if ((((q - row) % 3) + 3) % 3 === 0) alt.addPath(p);
        }
      }
      return { grout, alt };
    };
    this.grassTiles = mk(0.95, 16);
    this.floorTiles = mk(0.42, 18);
  }

  /* ---------- transforms ---------- */
  base() { this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); }
  floorT(z = 0) { const d = this.dpr; const A = this.cam.A; this.ctx.setTransform(d * A, d * A / 2, -d * A, d * A / 2, d * this.ox, d * (this.oy - z * A * ZK)); }
  /** A plane along x at y = y0 (a wall facing the lower left): u = x, t = down from zTop. */
  wallRT(y0, zTop, k = 1) { const d = this.dpr; const A = this.cam.A; const [px, py] = this.P(0, y0, zTop); this.ctx.setTransform((d * A) / k, (d * A / 2) / k, 0, (d * A * ZK) / k, d * px, d * py); }
  /** A plane along y at x = x0 (a wall facing the lower right): u = yEnd - y, t = down from zTop. */
  wallLT(x0, yEnd, zTop, k = 1) { const d = this.dpr; const A = this.cam.A; const [px, py] = this.P(x0, yEnd, zTop); this.ctx.setTransform((d * A) / k, (-d * A / 2) / k, 0, (d * A * ZK) / k, d * px, d * py); }

  poly(pts, fill, stroke, lw = 1) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke(); }
  }

  box(x, y, z, dx, dy, dz, top, left, right, edge = 'rgba(0,0,0,.22)') {
    const P = (X, Y, Z) => this.P(X, Y, Z);
    this.poly([P(x, y + dy, z), P(x + dx, y + dy, z), P(x + dx, y + dy, z + dz), P(x, y + dy, z + dz)], left, edge);
    this.poly([P(x + dx, y, z), P(x + dx, y + dy, z), P(x + dx, y + dy, z + dz), P(x + dx, y, z + dz)], right, edge);
    this.poly([P(x, y, z + dz), P(x + dx, y, z + dz), P(x + dx, y + dy, z + dz), P(x, y + dy, z + dz)], top, edge);
  }

  /** A hexagon prism (flat top in the world plane), drawn with its three faces toward the viewer. */
  hexPrism(x, y, z, r, hgt, top, left, right, edge = null) {
    const ring = [];
    for (let i = 0; i < 6; i++) { const an = (Math.PI / 3) * i + Math.PI / 6; ring.push([x + r * Math.cos(an), y + r * Math.sin(an)]); }
    for (let i = 0; i < 6; i++) {
      const p = ring[i]; const q = ring[(i + 1) % 6];
      const nx = (p[0] + q[0]) / 2 - x; const ny = (p[1] + q[1]) / 2 - y;
      if (nx + ny <= 0.01) continue;
      this.poly([this.P(p[0], p[1], z), this.P(q[0], q[1], z), this.P(q[0], q[1], z + hgt), this.P(p[0], p[1], z + hgt)], nx > ny ? right : left, edge);
    }
    this.poly(ring.map((p) => this.P(p[0], p[1], z + hgt)), top, edge);
  }

  /** True when a world box is (partly) on screen. */
  visible(x0, y0, x1, y1, zTop = 3, zBot = -3) {
    const b = this.isoBox([[x0, y0, zTop], [x1, y0, zTop], [x0, y1, zTop], [x1, y1, zTop], [x0, y0, zBot], [x1, y1, zBot], [x1, y0, zBot], [x0, y1, zBot]]);
    const A = this.cam.A;
    const sx0 = this.ox + b.x0 * A; const sx1 = this.ox + b.x1 * A; const sy0 = this.oy + b.y0 * A; const sy1 = this.oy + b.y1 * A;
    return sx1 > -40 && sx0 < this.w + 40 && sy1 > -40 && sy0 < this.h + 40;
  }

  /* ---------- drawing ---------- */
  draw() {
    if (!this.w) return;
    const pal = this.palette();
    this.computeOrigin();
    this.base();
    this.hits = [];
    this.machineHits = [];
    this.bridgeHits = [];
    this.noteHits = [];
    this.drawSky(pal);
    const c = this.getCity();
    const islands = [{ home: true, cx: HOME.cx, cy: HOME.cy, r: HOME.r }];
    for (const m of this.machines.values()) islands.push({ m, cx: m.center.x, cy: m.center.y, r: FRIEND_R });
    islands.sort((p, q) => (p.cx + p.cy) - (q.cx + q.cy));
    for (const is of islands) this.drawIsland(is, pal);
    // bridges and the core mast behind the building go first, so its walls hide them
    const behind = (m) => m.center.x + m.center.y < HOME.cx + HOME.cy - 4;
    for (const m of this.machines.values()) if (behind(m)) this.drawBridge(m, pal, c);
    if (this.visible(TANK.x - 2, TANK.y - 2, TANK.x + 2, TANK.y + 2, 8, 0)) this.drawTank(TANK.x, TANK.y, pal);
    this.drawBuildingGround(pal);
    for (const m of this.machines.values()) if (!behind(m)) this.drawBridge(m, pal, c);

    // depth sorted things
    const list = [];
    this.buildingItems(list, pal);
    for (const m of this.machines.values()) {
      if (!this.visible(m.center.x - FRIEND_R, m.center.y - FRIEND_R, m.center.x + FRIEND_R, m.center.y + FRIEND_R, 10, -1)) continue;
      list.push({ k: m.center.x + m.center.y, f: () => this.drawTower(m, pal, c) });
      for (const d of this.friendDecor(m)) list.push(d);
    }
    for (const d of this.homeDecor(pal)) list.push(d);
    for (const a of this.actors.values()) {
      if (!this.visible(a.pos.x - 1, a.pos.y - 1, a.pos.x + 1, a.pos.y + 1, a.pos.z + 2, a.pos.z - 1)) { a.sx = -999; continue; }
      list.push({ k: a.pos.x + a.pos.y + (a.desk && !a.path.length ? -0.05 : 0.02), f: () => this.drawBee(a) });
    }
    list.sort((p, q) => p.k - q.k);
    for (const it of list) it.f();

    this.drawCouriers(c);
    this.drawPipeline(c);
    this.drawLoops(c);
    this.drawLights(pal);
    this.drawFocus();
    this.drawOverlay(pal, c);
    this.drawParticles();
    this.base();
  }

  /** The graphite void: a faint vertical gradient, sparse dim stars at night, a low mist band. */
  drawSky(pal) {
    const ctx = this.ctx;
    if (!this.skyGrad) {
      const g = ctx.createLinearGradient(0, 0, 0, this.h);
      g.addColorStop(0, pal.void1); g.addColorStop(0.6, pal.void0); g.addColorStop(1, pal.void1);
      this.skyGrad = g;
    }
    ctx.fillStyle = this.skyGrad;
    ctx.fillRect(0, 0, this.w, this.h);
    if (pal.night > 0.3 && !pal.light) {
      ctx.fillStyle = pal.T.text;
      for (const s of this.stars) {
        ctx.globalAlpha = (pal.night - 0.3) * 0.32;
        ctx.fillRect(s.x * this.w, s.y * this.h * 0.6, s.r, s.r);
      }
      ctx.globalAlpha = 1;
    }
    // the key light: a very soft glow from the upper left
    const kl = ctx.createRadialGradient(this.w * 0.18, -this.h * 0.1, 10, this.w * 0.18, -this.h * 0.1, Math.max(this.w, this.h) * 0.8);
    kl.addColorStop(0, alpha(pal.T.info, 0.05 * (1 - pal.night * 0.6))); kl.addColorStop(1, alpha(pal.T.info, 0));
    ctx.fillStyle = kl; ctx.fillRect(0, 0, this.w, this.h);
    // a low mist band under the islands
    const seaY = this.h * 0.8;
    const g2 = ctx.createLinearGradient(0, seaY - 80, 0, this.h);
    g2.addColorStop(0, alpha(pal.T.text, 0)); g2.addColorStop(1, alpha(pal.T.text, 0.035));
    ctx.fillStyle = g2; ctx.fillRect(0, seaY - 80, this.w, this.h - seaY + 80);
  }

  drawIsland(is, pal) {
    const r = is.r; const cx = is.cx; const cy = is.cy;
    let rise = 0; let al = 1;
    if (is.m) {
      const t = this.now - is.m.born;
      if (t < 1.4) { const u = easeOut(clamp(t / 1.4)); rise = (1 - u) * -6; al = clamp(t / 0.5); }
      if (is.m.leaving) al = 1 - clamp((this.now - is.m.leaving) / 1.2);
    }
    if (!this.visible(cx - r, cy - r, cx + r, cy + r, 1, -r * 1.2 + rise)) return;
    const ctx = this.ctx;
    ctx.globalAlpha = al;
    const corners = hexCorners(cx, cy, r);
    const depth = is.home ? 1.6 : 1.2;
    const P = (x, y, z) => this.P(x, y, z + rise);
    // underside: a dark low poly cone
    const tip = P(cx + 0.6, cy + 0.6, -r * 0.75);
    const bottom = corners.map(([x, y]) => P(x, y, -depth));
    for (let i = 0; i < 6; i++) {
      const p = bottom[i]; const q = bottom[(i + 1) % 6];
      this.poly([p, q, tip], [pal.sideC, pal.under, pal.under, pal.under, pal.sideC, pal.sideB][i]);
    }
    // two shards
    for (let i = 0; i < 2; i++) {
      const an = 0.5 + i * 1.6; const rr = r * (0.35 + i * 0.18);
      const x = cx + Math.cos(an) * rr; const y = cy + Math.sin(an) * rr;
      const top = P(x, y, -depth - r * 0.2); const tp = P(x + 0.2, y + 0.2, -depth - r * (0.45 + i * 0.12));
      this.poly([[top[0] - this.cam.A * 0.7, top[1]], [top[0] + this.cam.A * 0.7, top[1]], tp], pal.under);
    }
    // the faces toward the viewer: crisp facets with two strata lines and a rim
    for (const i of [5, 0, 1]) {
      const [x0, y0] = corners[i]; const [x1, y1] = corners[(i + 1) % 6];
      const face = i === 1 ? pal.sideA : i === 0 ? pal.sideB : pal.sideC;
      this.poly([P(x0, y0, 0), P(x1, y1, 0), P(x1, y1, -depth), P(x0, y0, -depth)], face);
      ctx.strokeStyle = pal.strata; ctx.lineWidth = 1;
      for (const zz of [-0.55, -1.05]) {
        if (-zz > depth) continue;
        const a = P(x0, y0, zz); const b = P(x1, y1, zz);
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      }
      this.poly([P(x0, y0, 0), P(x1, y1, 0), P(x1, y1, -0.08), P(x0, y0, -0.08)], pal.rim);
    }
    // top: calm basalt with a hairline honeycomb grid, clipped to the hexagon
    const d = this.dpr; const A = this.cam.A;
    const o = this.P(cx, cy, rise);
    ctx.setTransform(d * A, d * A / 2, -d * A, d * A / 2, d * o[0], d * o[1]);
    ctx.save();
    ctx.beginPath();
    hexCorners(0, 0, r).forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath(); ctx.clip();
    ctx.fillStyle = pal.groundA; ctx.fill();
    ctx.fillStyle = pal.groundB; ctx.fill(this.grassTiles.alt);
    ctx.strokeStyle = pal.groundLine; ctx.lineWidth = 0.025; ctx.stroke(this.grassTiles.grout);
    // paved lanes: home plaza to every bridge, friend tower to its bridge
    ctx.lineCap = 'butt';
    const paths = [];
    if (is.home) { for (const m of this.machines.values()) paths.push([[PLAZA.x - cx, PLAZA.y - cy], [m.bridge.a.x - cx, m.bridge.a.y - cy]]); paths.push([[PLAZA.x - cx, PLAZA.y - cy], [ENTRANCE.x - cx, ENTRANCE.y - cy]]); }
    else { paths.push([[0, 0], [is.m.bridge.b.x - cx, is.m.bridge.b.y - cy]]); paths.push([[0, 0], [3.7, 3.7]]); }
    for (const [w, col] of [[1.2, pal.pathEdge], [1.1, pal.path]]) {
      ctx.strokeStyle = col; ctx.lineWidth = w;
      for (const [p0, p1] of paths) { ctx.beginPath(); ctx.moveTo(p0[0], p0[1]); ctx.lineTo(p1[0], p1[1]); ctx.stroke(); }
    }
    if (is.home) {
      // the plaza: a paved hexagon with a thin amber inlay
      ctx.fillStyle = pal.pathEdge; ctx.beginPath(); hexPath(ctx, PLAZA.x - cx, PLAZA.y - cy + 0.4, 2.5); ctx.fill();
      ctx.fillStyle = pal.path; ctx.beginPath(); hexPath(ctx, PLAZA.x - cx, PLAZA.y - cy + 0.4, 2.42); ctx.fill();
      ctx.strokeStyle = alpha(pal.T.accent, 0.4); ctx.lineWidth = 0.03; ctx.beginPath(); hexPath(ctx, PLAZA.x - cx, PLAZA.y - cy + 0.4, 1.3); ctx.stroke();
    } else {
      ctx.fillStyle = pal.pathEdge; ctx.beginPath(); hexPath(ctx, 0, 0, 3.6); ctx.fill();
      ctx.fillStyle = pal.path; ctx.beginPath(); hexPath(ctx, 0, 0, 3.52); ctx.fill();
    }
    ctx.restore();
    this.base();
    ctx.globalAlpha = 1;
  }

  /** Plinth, room floors as clean zones, corridor and the two tall back walls of your building. */
  drawBuildingGround(pal) {
    if (!this.visible(-1, -1, 17, 11, WALL + 3, -1)) return;
    const ctx = this.ctx;
    const T = pal.T;
    const P = (x, y, z) => this.P(x, y, z);
    const { x0, x1, y0, y1 } = BUILDING;
    const pz = 0.3;
    // plinth
    this.poly([P(x0 - 0.3, y1 + 0.3, 0), P(x1 + 0.3, y1 + 0.3, 0), P(x1 + 0.3, y1 + 0.3, pz), P(x0 - 0.3, y1 + 0.3, pz)], pal.plinthL);
    this.poly([P(x1 + 0.3, y0 - 0.3, 0), P(x1 + 0.3, y1 + 0.3, 0), P(x1 + 0.3, y1 + 0.3, pz), P(x1 + 0.3, y0 - 0.3, pz)], pal.plinthR);
    this.poly([P(x0 - 0.3, y0 - 0.3, pz), P(x1 + 0.3, y0 - 0.3, pz), P(x1 + 0.3, y1 + 0.3, pz), P(x0 - 0.3, y1 + 0.3, pz)], pal.plinthTop);
    // entrance steps
    for (let i = 0; i < 2; i++) this.box(ENTRANCE.x - 1.1 + i * 0.15, y1 + 0.3 + (1 - i) * 0.35, 0, 2.2 - i * 0.3, 0.35, pz * (i + 1) / 2, pal.plinthTop, pal.plinthL, pal.plinthR, null);
    // room floors: a flat zone, a hairline hex grid, a room color rule at the threshold, the name painted on the floor
    const d = this.dpr; const A = this.cam.A;
    for (const [k, r] of Object.entries(ROOMS)) {
      const o = this.P(0, 0, pz);
      ctx.setTransform(d * A, d * A / 2, -d * A, d * A / 2, d * o[0], d * o[1]);
      ctx.save();
      ctx.beginPath(); ctx.rect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0); ctx.clip();
      const hl = this.highlightRoom(k);
      const rc = roomColor(k);
      ctx.fillStyle = mixHex(pal.floor, rc, hl ? 0.07 : 0.025); ctx.fill();
      ctx.fillRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
      ctx.strokeStyle = pal.floorLine; ctx.lineWidth = 0.014; ctx.stroke(this.floorTiles.grout);
      // the threshold rule, on the corridor side
      ctx.fillStyle = alpha(rc, hl ? 0.95 : 0.7);
      if (r.row === 'back') ctx.fillRect(r.x0 + 0.12, r.y1 - 0.06, r.x1 - r.x0 - 0.24, 0.06);
      else ctx.fillRect(r.x0 + 0.12, r.y0, r.x1 - r.x0 - 0.24, 0.06);
      if (hl) { ctx.strokeStyle = alpha(T.accent, 0.75); ctx.lineWidth = 0.04; ctx.strokeRect(r.x0 + 0.06, r.y0 + 0.06, r.x1 - r.x0 - 0.12, r.y1 - r.y0 - 0.12); }
      ctx.restore();
      // the painted label, legible from mid zoom
      if (A >= 22) {
        ctx.save();
        const lx = r.row === 'back' ? r.x0 + 0.3 : r.x0 + 0.3; const ly = r.row === 'back' ? r.y1 - 0.42 : r.y0 + 0.62;
        ctx.translate(lx, ly); ctx.scale(0.01, 0.01);
        ctx.font = `600 ${clamp(26, 20, 34)}px ${FONT}`;
        ctx.fillStyle = alpha(T.text, 0.34);
        ctx.fillText(this.t(`city.room.${k}`).toUpperCase(), 0, 0);
        ctx.restore();
      }
    }
    // the corridor: a slightly lighter lane with a hairline center line
    const o = this.P(0, 0, pz);
    ctx.setTransform(d * A, d * A / 2, -d * A, d * A / 2, d * o[0], d * o[1]);
    ctx.fillStyle = mixHex(pal.floor, T.text, 0.025); ctx.fillRect(0, 4.6, 16, 0.8);
    ctx.fillStyle = alpha(T.text, 0.08); ctx.fillRect(0.3, 4.985, 15.4, 0.03);
    this.base();
    this.drawBackWalls(pal);
  }

  drawBackWalls(pal) {
    const ctx = this.ctx;
    const T = pal.T;
    const P = (x, y, z) => this.P(x, y, z);
    const zb = 0.3; const zt = WALL + 0.3;
    // left wall x = 0 (Design and Library), right wall y = 0 (the four pipeline rooms)
    this.poly([P(0, 0, zb), P(0, 10, zb), P(0, 10, zt), P(0, 0, zt)], pal.wallL);
    this.poly([P(0, 0, zb), P(16, 0, zb), P(16, 0, zt), P(0, 0, zt)], pal.wallR);
    for (const side of ['L', 'R']) {
      const len = side === 'L' ? 10 : 16;
      if (side === 'L') this.wallLT(0, 10, zt); else this.wallRT(0, zt);
      // a thin base rule and joints every two units, a soft shade toward the corner
      ctx.fillStyle = alpha(T.text, 0.04); ctx.fillRect(0, WALL - 0.1, len, 0.1);
      ctx.strokeStyle = alpha('#000000', 0.12); ctx.lineWidth = 0.012; ctx.beginPath();
      for (let u = 2; u < len; u += 2) { ctx.moveTo(u, 0); ctx.lineTo(u, WALL); }
      ctx.stroke();
      if (side === 'L') { ctx.fillStyle = 'rgba(0,0,0,.2)'; ctx.fillRect(10 - 5.4, 0, 0.8, WALL); }
      const g = ctx.createLinearGradient(side === 'L' ? len : 0, 0, side === 'L' ? len - 3 : 3, 0);
      g.addColorStop(0, 'rgba(0,0,0,.2)'); g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, len, WALL);
    }
    this.base();
    // windows: dark glass panes, one per back room, with a single reflection
    const win = (u0, u1, side) => {
      if (side === 'L') this.wallLT(0, 10, zt); else this.wallRT(0, zt);
      const t0 = 0.28; const t1 = 1.08;
      const g = ctx.createLinearGradient(0, t0, 0, t1); g.addColorStop(0, pal.glassTop); g.addColorStop(1, pal.glassBot);
      ctx.fillStyle = g; ctx.fillRect(u0, t0, u1 - u0, t1 - t0);
      ctx.fillStyle = pal.glassHi;
      ctx.beginPath(); ctx.moveTo(u0 + 0.1, t0); ctx.lineTo(u0 + 0.3, t0); ctx.lineTo(u0 + 0.12, t1); ctx.lineTo(u0 - 0.08, t1); ctx.closePath(); ctx.fill();
      if (pal.night > 0.5) { ctx.fillStyle = alpha(T.accent2, 0.5); for (let i = 0; i < 3; i++) ctx.fillRect(u0 + 0.1 + ((i * 37) % 9) / 10 * (u1 - u0 - 0.2), t0 + 0.12 + ((i * 23) % 5) / 12, 0.02, 0.02); }
      ctx.strokeStyle = pal.cap; ctx.lineWidth = 0.025; ctx.strokeRect(u0, t0, u1 - u0, t1 - t0);
    };
    for (const k of ['design', 'code', 'test', 'review']) { const r = ROOMS[k]; win(r.x1 - 1.6, r.x1 - 0.45, 'R'); }
    win(10 - 3.4, 10 - 1.9, 'L');
    win(10 - 9.1, 10 - 7.6, 'L');
    this.base();
    // wall caps
    const Tt = 0.12;
    this.poly([P(0, 0, zt), P(0, 10, zt), P(-Tt, 10, zt), P(-Tt, -Tt, zt), P(16, -Tt, zt), P(16, 0, zt)], pal.cap);
    this.poly([P(-Tt, 10, zb), P(0, 10, zb), P(0, 10, zt), P(-Tt, 10, zt)], pal.capSide);
    this.poly([P(16, -Tt, zb), P(16, 0, zb), P(16, 0, zt), P(16, -Tt, zt)], shade(pal.capSide, -0.15));
    // room plaques on the back walls
    for (const k of ['design', 'code', 'test', 'review']) { const r = ROOMS[k]; this.plaque(k, 'R', r.x0 + 1.2, pal); }
    this.plaque('library', 'L', 10 - 9.4 + 0.9, pal);
    for (const k of ['design', 'code', 'test', 'review', 'library']) this.drawBoard(k, pal);
    this.wallDecor(pal);
  }

  plaque(k, side, u, pal) {
    if (this.cam.A < 44) return;
    const ctx = this.ctx;
    const zt = WALL + 0.3;
    if (side === 'L') this.wallLT(0, 10, zt, 100); else this.wallRT(0, zt, 100);
    const name = this.t(`city.room.${k}`).toUpperCase();
    ctx.font = `600 13px ${FONT}`;
    const x = u * 100; const y = 16;
    ctx.fillStyle = roomColor(k); ctx.fillRect(x - 10, y + 2, 3, 16);
    ctx.fillStyle = alpha(pal.T.text, 0.72); ctx.fillText(name, x, y + 15);
    this.base();
  }

  wallDecor(pal) {
    const ctx = this.ctx;
    const T = pal.T;
    const zt = WALL + 0.3;
    this.wallRT(0, zt);
    // Test: a status light that shows the last QA verdict (green passed, red failed) and amber while a test runs
    const qa = this.getCity().qa || {};
    const blink = qa.running && (this.reduced() || Math.floor(this.now * 1.2) % 2 === 0);
    ctx.fillStyle = pal.screen; ctx.fillRect(10.1, 0.5, 0.22, 0.5);
    ctx.fillStyle = qa.last === true ? T.ok : alpha(T.ok, 0.18); ctx.beginPath(); ctx.arc(10.21, 0.62, 0.05, 0, 6.28); ctx.fill();
    ctx.fillStyle = blink ? T.accent : alpha(T.accent, 0.18); ctx.beginPath(); ctx.arc(10.21, 0.78, 0.05, 0, 6.28); ctx.fill();
    ctx.fillStyle = qa.last === false ? T.bad : alpha(T.bad, 0.18); ctx.beginPath(); ctx.arc(10.21, 0.94, 0.05, 0, 6.28); ctx.fill();
    this.base();
  }

  /** A task board with its cards, on a wall or standing: a dark display, cards with a status rule. */
  drawBoard(room, pal) {
    const bd = this.boardOf(room);
    if (!bd || this.cam.A < 9) return;
    const ctx = this.ctx;
    const T = pal.T;
    let u0; let u1;
    if (bd.kind === 'wallR') { this.wallRT(0, bd.z1); u0 = bd.x0; u1 = bd.x1; }
    else if (bd.kind === 'wallL') { this.wallLT(0, 10, bd.z1); u0 = 10 - bd.y1; u1 = 10 - bd.y0; }
    else { this.wallRT(bd.y, bd.z1); u0 = bd.x0; u1 = bd.x1; }
    const hgt = bd.z1 - bd.z0;
    ctx.fillStyle = pal.board; ctx.fillRect(u0, 0, u1 - u0, hgt);
    ctx.strokeStyle = alpha(T.text, 0.1); ctx.lineWidth = 0.012; ctx.strokeRect(u0, 0, u1 - u0, hgt);
    ctx.fillStyle = bd.color; ctx.fillRect(u0, 0, u1 - u0, 0.025);
    // cards
    const list = [...this.notes.values()].filter((n) => n.room === room && !n.gone && !n.hidden && !(n.fly && this.now - n.fly.t0 < 0.9));
    for (const n of list) {
      const col = n.slot % bd.cols; const row = Math.floor(n.slot / bd.cols);
      const w = (u1 - u0) / bd.cols;
      const x = bd.kind === 'wallL' ? u1 - (col + 1) * w : u0 + col * w;
      const y = 0.14 + row * 0.34;
      const appear = this.reduced() ? 1 : easeOut(clamp((this.now - Math.max(n.born, n.fly ? n.fly.t0 + 0.9 : -99)) / 0.2));
      const t = n.t;
      const rule = t.status === 'blocked' ? T.bad : t.status === 'done' ? T.ok : ['in_progress', 'in_review', 'in_test', 'claimed'].includes(t.status) ? T.accent : T.muted;
      ctx.save();
      ctx.globalAlpha = appear;
      ctx.translate(x + w / 2, y + 0.14);
      ctx.fillStyle = pal.card; ctx.fillRect(-w / 2 + 0.05, -0.13, w - 0.1, 0.26);
      ctx.fillStyle = rule; ctx.fillRect(-w / 2 + 0.05, -0.13, 0.025, 0.26);
      if (this.dragTask === n.id || this.highlight?.id === n.id) { ctx.strokeStyle = T.accent; ctx.lineWidth = 0.018; ctx.strokeRect(-w / 2 + 0.05, -0.13, w - 0.1, 0.26); }
      if (this.cam.A > 34) {
        ctx.scale(0.01, 0.01);
        ctx.fillStyle = t.status === 'done' ? alpha(T.text, 0.55) : T.text;
        ctx.font = `500 ${this.cam.A > 80 ? 9 : 10.5}px ${FONT}`;
        const line = wrap(ctx, t.title || '', (w - 0.26) * 100, 1)[0] || '';
        ctx.fillText(line, (-w / 2 + 0.12) * 100, 0.035 * 100);
      } else {
        ctx.fillStyle = alpha(T.text, 0.28); ctx.fillRect(-w / 2 + 0.13, -0.05, w * 0.5, 0.03); ctx.fillRect(-w / 2 + 0.13, 0.02, w * 0.32, 0.03);
      }
      ctx.restore();
    }
    if (this.cam.A >= 14) {
      this.base();
      for (const n of list) {
        const c = this.notePos(n);
        const [sx, sy] = this.P(c.x, c.y, c.z);
        const hw = Math.max(10, this.cam.A * ((bd.x1 - bd.x0 || bd.y1 - bd.y0) / bd.cols) * 0.5);
        this.noteHits.push({ id: n.id, x: sx - hw, y: sy - this.cam.A * 0.25, w: hw * 2, h: this.cam.A * 0.5 });
      }
      if (bd.kind === 'wallR') this.wallRT(0, bd.z1); else if (bd.kind === 'wallL') this.wallLT(0, 10, bd.z1); else this.wallRT(bd.y, bd.z1);
    }
    const more = (this.boardCounts?.get(room)?.length || 0) - bd.cols * 3;
    if (more > 0 && this.cam.A > 24) {
      ctx.save(); ctx.scale(0.01, 0.01);
      ctx.fillStyle = alpha(T.text, 0.5); ctx.font = `500 10px ${MONO}`;
      ctx.fillText(`+${more}`, (u1 - 0.3) * 100, (hgt - 0.05) * 100);
      ctx.restore();
    }
    this.base();
  }

  drawBoardItem(room, pal) {
    const bd = this.boardOf(room);
    if (!bd) return;
    // two slim legs of a standing board
    const ctx = this.ctx;
    for (const x of [bd.x0 + 0.12, bd.x1 - 0.12]) {
      const a = this.P(x, bd.y + 0.02, 0.3 * (room.startsWith('m:') ? 0 : 1)); const b = this.P(x, bd.y + 0.02, bd.z0 + 0.05);
      ctx.strokeStyle = pal.metal; ctx.lineWidth = Math.max(1, this.cam.A * 0.03);
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    }
    this.drawBoard(room, pal);
  }

  /** Every piece of your building that needs depth sorting: partitions, workstations, racks, the gate. */
  buildingItems(list, pal) {
    if (!this.visible(-1, -1, 17, 11, WALL + 3, -1)) return;
    const pz = 0.3;
    // low glass partitions with door gaps, split into short pieces so bees sort well against them
    const walls = [];
    const gap = (x) => [x - 0.65, x + 0.65];
    const along = (y, xa, xb, gaps) => { // wall along x at y
      let x = xa;
      const cuts = [...gaps].sort((p, q) => p[0] - q[0]);
      for (const [g0, g1] of [...cuts, [xb, xb]]) {
        for (let s = x; s < g0 - 0.01; s += 1) walls.push({ kind: 'x', y, x0: s, x1: Math.min(g0, s + 1) });
        x = g1;
      }
    };
    const across = (x, ya, yb) => { for (let s = ya; s < yb - 0.01; s += 1) walls.push({ kind: 'y', x, y0: s, y1: Math.min(yb, s + 1) }); };
    along(4.6, 0, 16, ['design', 'code', 'test', 'review'].map((k) => gap(ROOMS[k].x0 + 2)));
    along(5.4, 0, 16, [gap(2), gap(6.4), gap(14)]);
    for (const x of [4, 8, 12]) across(x, 0, 4.6);
    for (const x of [4, 12]) across(x, 5.4, 10);
    // the front parapet and the right side, with the entrance gap
    along(10, 0, 16, [[6.9, 9.1]]);
    across(16, 0, 4.6); across(16, 5.4, 10);
    const glassTop = alpha(pal.T.text, 0.22); const glassL = alpha(pal.part, 0.55); const glassR = alpha(pal.partR, 0.55);
    for (const wpc of walls) {
      const outer = (wpc.kind === 'x' && wpc.y === 10) || (wpc.kind === 'y' && wpc.x === 16);
      const hgt = outer ? 0.26 : PART;
      const top = outer ? pal.part : glassTop; const l = outer ? pal.partL : glassL; const r = outer ? pal.partR : glassR;
      if (wpc.kind === 'x') list.push({ k: (wpc.x0 + wpc.x1) / 2 + wpc.y + 0.08, f: () => this.box(wpc.x0, wpc.y - 0.03, pz, wpc.x1 - wpc.x0, 0.06, hgt, top, l, r, null) });
      else list.push({ k: wpc.x + (wpc.y0 + wpc.y1) / 2 + 0.08, f: () => this.box(wpc.x - 0.03, wpc.y0, pz, 0.06, wpc.y1 - wpc.y0, hgt, top, l, r, null) });
    }
    // workstations and chairs at the seats
    for (const k of Object.keys(ROOMS)) {
      for (let i = 0; i < 4; i++) {
        const s = spotFor(k, i);
        if (!s.desk) continue;
        list.push({ k: s.x + s.y + 0.55, f: () => this.drawDesk(k, s, pal) });
        list.push({ k: s.x + s.y - 0.3, f: () => this.drawChair(k, s, pal) });
      }
    }
    const add = (x, y, f) => list.push({ k: x + y, f });
    // Review: the wall display with the diff
    add(14, 0.5, () => this.drawScreen(12.7, 15.3, pal));
    // Library: storage racks along the left wall
    add(0.3, 6.8, () => this.drawShelves(0.05, 5.6, 1.5, pal));
    add(0.3, 9.1, () => this.drawShelves(0.05, 8.2, 1.6, pal));
    // Lobby: Mel's hexagon desk and the board
    add(8, 7.6, () => this.drawReception(8, 7.6, pal));
    add(10.45, 5.95, () => this.drawBoardItem('lobby', pal));
    // Ops: server racks with their activity lights, and the board
    add(15.4, 6.0, () => this.drawRack(15.15, 5.7, pal));
    add(15.4, 7.1, () => this.drawRack(15.15, 6.8, pal));
    add(13.1, 6.0, () => this.drawBoardItem('ops', pal));
    // the entrance frame over the Lobby
    add(9.2, 10.05, () => this.drawGate(pal));
  }

  highlightRoom(k) { return (this.highlight?.kind === 'room' && this.highlight.id === k) || (this.dropTarget?.kind === 'room' && this.dropTarget.id === k); }

  drawDesk(room, s, pal) {
    const ctx = this.ctx;
    const T = pal.T;
    const pz = 0.3;
    const x = s.x - DW / 2; const y = s.y + 0.18;
    // a clean workstation: two slim legs and a slab top
    this.box(x + 0.06, y + 0.08, pz, 0.05, DD - 0.16, DH - 0.05, pal.leg, pal.leg, shade(pal.leg, -0.2), null);
    this.box(x + DW - 0.11, y + 0.08, pz, 0.05, DD - 0.16, DH - 0.05, pal.leg, pal.leg, shade(pal.leg, -0.2), null);
    this.box(x, y, pz + DH - 0.05, DW, DD, 0.05, pal.deskTop, pal.deskL, pal.deskR, null);
    const z = pz + DH;
    const sitter = [...this.actors.values()].find((a) => !a.path.length && a.place.kind === 'room' && a.place.room === room && Math.abs(a.pos.x - s.x) < 0.2 && Math.abs(a.pos.y - s.y) < 0.2);
    const active = sitter && ['working', 'thinking', 'reviewing', 'testing'].includes(sitter.mode);
    // the monitor: a thin slab facing the bee, its screen line lit in the agent color while it works
    const mx = s.x - 0.38; const my = y + 0.26; const mw = 0.76; const mh = 0.42;
    this.box(mx + mw / 2 - 0.04, my + 0.04, z, 0.08, 0.08, 0.1, pal.metal, pal.leg, pal.leg, null);
    this.box(mx, my, z + 0.1, mw, 0.03, mh, pal.screen, pal.screen, shade(pal.screen, -0.2), null);
    const c = active ? statusColor(sitter.mode, T) : alpha(T.text, 0.1);
    const s0 = this.P(mx + 0.05, my, z + 0.15); const s1 = this.P(mx + mw - 0.05, my, z + 0.15);
    ctx.strokeStyle = c; ctx.lineWidth = Math.max(1, this.cam.A * 0.025);
    ctx.beginPath(); ctx.moveTo(s0[0], s0[1]); ctx.lineTo(s1[0], s1[1]); ctx.stroke();
    if (active && this.cam.A > 30) {
      const col = tone(sitter.ag.color || T.accent);
      for (const [k, len] of [[0.62, 0.55], [0.45, 0.38]]) {
        const p0 = this.P(mx + 0.08, my, z + 0.1 + mh * k); const p1 = this.P(mx + 0.08 + mw * len, my, z + 0.1 + mh * k);
        ctx.strokeStyle = alpha(col, 0.5); ctx.lineWidth = Math.max(0.8, this.cam.A * 0.014);
        ctx.beginPath(); ctx.moveTo(p0[0], p0[1]); ctx.lineTo(p1[0], p1[1]); ctx.stroke();
      }
    }
    if (active) (this.screens ||= []).push([...this.P(mx + mw / 2, my, z + 0.3), tone(sitter.ag.color || T.accent)]);
  }

  drawChair(room, s, pal) {
    const x = s.x - 0.22; const y = s.y - 0.28; const pz = 0.3;
    this.box(x + 0.19, y + 0.17, pz, 0.06, 0.06, 0.36, pal.leg, pal.leg, pal.leg, null);
    this.box(x, y - 0.02, pz + 0.36, 0.44, 0.44, 0.06, pal.partL, pal.partR, shade(pal.partR, -0.2), null);
    this.box(x, y - 0.06, pz + 0.42, 0.44, 0.05, 0.46, pal.partL, pal.partL, shade(pal.partR, -0.25), null);
    void room;
  }

  drawScreen(u0, u1, pal) {
    // the Review wall display with a diff
    const ctx = this.ctx;
    const T = pal.T;
    this.wallRT(0.02, WALL + 0.3);
    const t0 = 0.35; const t1 = 1.25;
    ctx.fillStyle = pal.screen; ctx.fillRect(u0 + 0.9, t0, u1 - u0 - 1.75, t1 - t0);
    ctx.strokeStyle = alpha(T.text, 0.14); ctx.lineWidth = 0.012; ctx.strokeRect(u0 + 0.9, t0, u1 - u0 - 1.75, t1 - t0);
    for (let i = 0; i < 8; i++) {
      const k = (i * 3) % 11;
      const add = k % 4 === 1; const del = k % 5 === 3;
      ctx.fillStyle = add ? alpha(T.ok, 0.7) : del ? alpha(T.bad, 0.7) : alpha(T.text, 0.25);
      ctx.fillRect(u0 + 1.0, t0 + 0.07 + i * 0.1, 0.25 + ((k * 7) % 5) * 0.12, 0.035);
    }
    this.base();
  }

  drawShelves(x, y, len, pal) {
    // a storage rack: a dark frame, neutral volumes, a few accented ones (the agents' memory)
    const T = pal.T;
    const pz = 0.3;
    this.box(x, y, pz, 0.45, len, 1.6, pal.capSide, pal.leg, shade(pal.leg, -0.2), null);
    const spines = [pal.partL, pal.part, mixHex(pal.partL, T.info, 0.22), pal.partR, mixHex(pal.partL, T.accent, 0.2)];
    for (let row = 0; row < 3; row++) {
      const zz = pz + 0.12 + row * 0.5;
      for (let i = 0; i < Math.floor(len / 0.22) - 1; i++) {
        const yy = y + 0.1 + i * 0.22;
        this.poly([this.P(x + 0.45, yy, zz), this.P(x + 0.45, yy + 0.16, zz), this.P(x + 0.45, yy + 0.16, zz + 0.3 + ((i + row) % 3) * 0.05), this.P(x + 0.45, yy, zz + 0.3 + ((i + row) % 3) * 0.05)], spines[(i * 2 + row) % spines.length]);
      }
    }
  }

  drawReception(x, y, pal) {
    // a hexagon desk for Mel, with an amber rim
    const pz = 0.3;
    this.hexPrism(x, y, pz, 0.7, 0.6, pal.deskTop, pal.deskL, pal.deskR);
    const ring = [];
    for (let i = 0; i < 6; i++) { const an = (Math.PI / 3) * i + Math.PI / 6; ring.push(this.P(x + 0.7 * Math.cos(an), y + 0.7 * Math.sin(an), pz + 0.6)); }
    this.poly(ring, null, alpha(pal.T.accent, 0.6), 1);
  }

  drawRack(x, y, pal) {
    const ctx = this.ctx;
    const T = pal.T;
    const pz = 0.3;
    this.box(x, y, pz, 0.62, 0.85, 1.55, pal.capSide, pal.leg, shade(pal.leg, -0.25), null);
    // activity lights: they blink only while the host runs a turn or a job
    const c = this.getCity();
    const self = c.machines?.[c.selfId] || {};
    const busy = ((self.live?.jobs || 0) + (self.live?.slotsBusy || 0)) > 0;
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        const on = busy && (this.reduced() ? (i + j) % 2 : Math.sin(this.now * (2 + j) + i * 1.7 + x) > 0.2);
        const p = this.P(x + 0.62, y + 0.18 + j * 0.24, pz + 0.25 + i * 0.22);
        ctx.fillStyle = on ? [T.ok, T.accent, T.info][j] : alpha(T.text, 0.1);
        ctx.fillRect(p[0] - 1, p[1] - 1, Math.max(2, this.cam.A * 0.04), Math.max(1, this.cam.A * 0.02));
      }
    }
  }

  drawGate(pal) {
    const ctx = this.ctx; const pz = 0.3; const y = 10.05;
    // see through the frame when the Lobby is zoomed in
    const fade = this.focus?.kind === 'room' && ROOMS[this.focus.id]?.row === 'front';
    if (fade) { ctx.save(); ctx.globalAlpha = 0.28; }
    this.drawGateBody(pal, pz, y);
    if (fade) ctx.restore();
  }

  drawGateBody(pal, pz, y) {
    const ctx = this.ctx;
    this.box(6.8, y - 0.08, pz, 0.14, 0.14, 2.0, pal.cap, pal.capSide, shade(pal.capSide, -0.2), null);
    this.box(9.06, y - 0.08, pz, 0.14, 0.14, 2.0, pal.cap, pal.capSide, shade(pal.capSide, -0.2), null);
    this.box(6.7, y - 0.1, pz + 2.0, 2.6, 0.2, 0.24, pal.cap, pal.capSide, shade(pal.capSide, -0.2), null);
    if (this.cam.A < 12) return;
    this.wallRT(y + 0.11, pz + 2.24, 100);
    ctx.fillStyle = alpha(pal.T.text, 0.85); ctx.font = `600 16px ${FONT}`;
    ctx.textAlign = 'center'; ctx.fillText('hivedesk', 8.0 * 100, 0.18 * 100); ctx.textAlign = 'left';
    ctx.fillStyle = pal.T.accent; ctx.fillRect(8.0 * 100 - 30, 0.21 * 100, 60, 1.5);
    this.base();
  }

  /** The core mast of your building: a slim hexagon column with the GPU core on top (it replaced the honey tank). */
  drawTank(x, y, pal) {
    const c = this.getCity();
    const self = c.machines?.[c.selfId] || {};
    // the column and a platform
    this.hexPrism(x, y, 0, 0.32, TANK.z, pal.tower, pal.towerL, pal.towerR);
    this.hexPrism(x, y, TANK.z, 0.95, 0.18, pal.cap, pal.capSide, shade(pal.capSide, -0.2));
    const hostGlow = this.hostGlow || (this.hostGlow = { glow: 0 });
    this.drawCore(hostGlow, x, y, TANK.z + 0.18, self, pal.T.accent, false);
    if (c.download) this.drawCrane(x, y, TANK.z + 0.3, c.download);
  }

  /** A crane over the host mast while the model downloads; the hook rises with the bytes received. */
  drawCrane(x, y, z, dl) {
    const ctx = this.ctx;
    const T = artTokens();
    const A = this.cam.A;
    const frac = dl.total ? clamp(dl.received / dl.total) : null;
    const mast0 = this.P(x + 1.1, y - 0.9, z); const mast1 = this.P(x + 1.1, y - 0.9, z + 3.2);
    ctx.strokeStyle = this.pal.metal; ctx.lineWidth = Math.max(1, A * 0.04);
    ctx.beginPath(); ctx.moveTo(mast0[0], mast0[1]); ctx.lineTo(mast1[0], mast1[1]); ctx.stroke();
    const jib = this.P(x - 1.6, y - 0.9, z + 3.2);
    ctx.beginPath(); ctx.moveTo(mast1[0], mast1[1]); ctx.lineTo(jib[0], jib[1]); ctx.stroke();
    const hookZ = z + 0.4 + (frac ?? 0.5) * 2.4;
    const hook = this.P(x - 1.2, y - 0.9, hookZ);
    ctx.strokeStyle = alpha(T.text, 0.4); ctx.lineWidth = 1;
    const top = this.P(x - 1.2, y - 0.9, z + 3.2);
    ctx.beginPath(); ctx.moveTo(top[0], top[1]); ctx.lineTo(hook[0], hook[1]); ctx.stroke();
    ctx.fillStyle = T.accent; ctx.fillRect(hook[0] - A * 0.18, hook[1], A * 0.36, A * 0.22);
    const label = frac == null ? this.t('city.fx.downloading') : this.t('city.fx.downloadPct', { n: Math.round(frac * 100) });
    drawPill(ctx, jib[0], jib[1] - A * 0.6, label, T.accent, clamp(A * 0.4, 10, 12));
  }

  /** A low poly tree: a thin trunk and a faceted cone in muted green gray. */
  drawTree(x, y, s, pal, z = 0) {
    const ctx = this.ctx;
    const b = this.P(x, y, z); const t = this.P(x, y, z + 0.45 * s); const top = this.P(x, y, z + 2.0 * s);
    ctx.fillStyle = 'rgba(0,0,0,.18)'; ctx.beginPath(); ctx.ellipse(b[0] + this.cam.A * 0.2, b[1], this.cam.A * 0.6 * s, this.cam.A * 0.28 * s, 0, 0, 6.28); ctx.fill();
    ctx.strokeStyle = pal.trunk; ctx.lineWidth = Math.max(1.5, this.cam.A * 0.08 * s);
    ctx.beginPath(); ctx.moveTo(b[0], b[1]); ctx.lineTo(t[0], t[1]); ctx.stroke();
    const w = this.cam.A * 0.62 * s;
    ctx.fillStyle = pal.tree;
    ctx.beginPath(); ctx.moveTo(top[0], top[1]); ctx.lineTo(t[0] - w, t[1] - w * 0.15); ctx.lineTo(t[0], t[1] + w * 0.3); ctx.closePath(); ctx.fill();
    ctx.fillStyle = pal.treeB;
    ctx.beginPath(); ctx.moveTo(top[0], top[1]); ctx.lineTo(t[0] + w, t[1] - w * 0.15); ctx.lineTo(t[0], t[1] + w * 0.3); ctx.closePath(); ctx.fill();
  }

  drawLamp(x, y, pal) {
    const ctx = this.ctx;
    const b = this.P(x, y, 0); const t = this.P(x, y, 1.9);
    ctx.strokeStyle = pal.metal; ctx.lineWidth = Math.max(1, this.cam.A * 0.04);
    ctx.beginPath(); ctx.moveTo(b[0], b[1]); ctx.lineTo(t[0], t[1]); ctx.stroke();
    const on = this.pal.night > 0.25;
    ctx.fillStyle = on ? pal.lamp : pal.capSide;
    const s = Math.max(2, this.cam.A * 0.09);
    ctx.fillRect(t[0] - s, t[1] - s * 0.6, s * 2, s * 1.2);
    if (on) (this.lamps ||= []).push([t[0], t[1], 1.6]);
  }

  /** A few trees and lamps around your building, kept clear of the bridges. */
  homeDecor(pal) {
    const out = [];
    const spots = [[-3.4, 2.6, 1.0], [-2.8, 7.4, 0.9], [3.2, 14.2, 0.95], [17.6, 11.6, 0.85], [19.4, 6.4, 1.05], [14.6, -3.4, 0.9], [5.0, -3.6, 0.95]];
    const clear = (x, y) => {
      for (const m of this.machines.values()) {
        const br = m.bridge;
        // distance to the line from the plaza to the bridge start, and to the bridge
        for (const [ax, ay, bx, by] of [[PLAZA.x, PLAZA.y, br.a.x, br.a.y], [br.a.x, br.a.y, br.b.x, br.b.y]]) {
          const wx = bx - ax; const wy = by - ay; const LL = wx * wx + wy * wy || 1;
          const u = clamp(((x - ax) * wx + (y - ay) * wy) / LL);
          if (Math.hypot(ax + wx * u - x, ay + wy * u - y) < 2.4) return false;
        }
      }
      return true;
    };
    for (const [x, y, s] of spots) if (clear(x, y)) out.push({ k: x + y, f: () => this.drawTree(x, y, s, pal) });
    for (const [x, y] of [[5.4, 12.0], [10.6, 12.0]]) out.push({ k: x + y, f: () => this.drawLamp(x, y, pal) });
    return out;
  }

  friendDecor(m) {
    const out = [];
    const c = m.center;
    const pal = this.pal;
    const born = this.now - m.born;
    const show = born > 3.6 || born < -50;
    if (!show) return out;
    for (const [dx, dy, s] of [[-5.2, 1.2, 0.85], [5.2, -1.4, 0.9]]) {
      const x = c.x + dx; const y = c.y + dy;
      const br = m.bridge;
      const vx = br.b.x - c.x; const vy = br.b.y - c.y; const L = Math.hypot(vx, vy) || 1;
      const u = clamp(((x - c.x) * vx + (y - c.y) * vy) / (L * L));
      if (Math.hypot(c.x + vx * u - x, c.y + vy * u - y) < 2.2) continue;
      out.push({ k: x + y, f: () => this.drawTree(x, y, s, pal) });
    }
    out.push({ k: c.x + c.y + 6.6, f: () => this.drawLamp(c.x + 3.0, c.y + 4.6, pal) });
    return out;
  }

  /* ---------- friend towers ---------- */
  drawTower(m, pal, city) {
    const ctx = this.ctx;
    const T = pal.T;
    const tw = towerOf(m.center);
    const H = this.towerHeight(m);
    const floors = Math.round((H - 0.4) / FLOOR_H);
    const born = this.now - m.born;
    const mm = m.m || {};
    const col = tone(mm.color || T.ok);
    const offline = mm.online === false;
    const build = born < -50 ? 1 : clamp((born - 1.0) / 2.6);
    const w = tw.x1 - tw.x0;
    // foundation
    this.box(tw.x0 - 0.3, tw.y0 - 0.3, 0, w + 0.6, w + 0.6, 0.3, pal.plinthTop, pal.plinthL, pal.plinthR, null);
    // floors stack up one by one while it is being built
    let topZ = 0.3;
    const lit = !offline && (pal.night > 0.3 || (mm.live?.util ?? 0) > 0.5 || (mm.live?.jobs || 0) > 0);
    for (let i = 0; i < floors; i++) {
      const fs = clamp(build * floors - i);
      if (fs <= 0) break;
      const sc = this.reduced() ? 1 : easeOut(fs);
      const z0 = 0.3 + i * FLOOR_H;
      const hgt = FLOOR_H * Math.min(1, sc);
      const inset = i === floors - 1 ? 0.15 : 0;
      const wallL = offline ? shade(pal.towerL, -0.3) : pal.towerL;
      const wallR = offline ? shade(pal.towerR, -0.3) : pal.towerR;
      this.box(tw.x0 + inset, tw.y0 + inset, z0, w - inset * 2, w - inset * 2, hgt, pal.tower, wallL, wallR, null);
      // a glass curtain band on each face, lit at night or when the GPU works
      if (fs >= 1) {
        const zz = z0 + 0.28; const wh = 0.66;
        const glass = lit && (i % 2 === 0 || pal.night > 0.5) ? mixHex(pal.glassTop, T.accent2, 0.35) : pal.glassTop;
        for (const side of ['L', 'R']) {
          const pt = (u, z) => (side === 'L' ? this.P(u, tw.y1 - inset, z) : this.P(tw.x1 - inset, u, z));
          const a0 = (side === 'L' ? tw.x0 : tw.y0) + inset + 0.3; const a1 = (side === 'L' ? tw.x1 : tw.y1) - inset - 0.3;
          if (i === 0 && side === 'L') continue; // the door face of the ground floor
          this.poly([pt(a0, zz), pt(a1, zz), pt(a1, zz + wh), pt(a0, zz + wh)], glass);
          // mullions
          ctx.strokeStyle = alpha('#000000', 0.25); ctx.lineWidth = 1;
          for (let u = a0 + 0.8; u < a1 - 0.1; u += 0.8) { const p = pt(u, zz); const q = pt(u, zz + wh); ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]); ctx.stroke(); }
          if (glass !== pal.glassTop) (this.windowLights ||= []).push(pt((a0 + a1) / 2, zz + wh / 2));
        }
      }
      topZ = z0 + hgt;
    }
    // the owner's color: a thin vertical accent on the front corner
    if (build > 0.2) {
      const p0 = this.P(tw.x1, tw.y1, 0.3); const p1 = this.P(tw.x1, tw.y1, topZ);
      ctx.strokeStyle = offline ? alpha(T.text, 0.2) : col; ctx.lineWidth = Math.max(1.5, this.cam.A * 0.05);
      ctx.beginPath(); ctx.moveTo(p0[0], p0[1]); ctx.lineTo(p1[0], p1[1]); ctx.stroke();
      // the door: a recessed dark panel
      const d0 = tw.x0 + (w - 1) / 2; const d1 = d0 + 1;
      this.poly([this.P(d0, tw.y1, 0.3), this.P(d1, tw.y1, 0.3), this.P(d1, tw.y1, 1.2), this.P(d0, tw.y1, 1.2)], pal.screen);
      this.poly([this.P(d0 - 0.1, tw.y1, 1.2), this.P(d1 + 0.1, tw.y1, 1.2), this.P(d1 + 0.1, tw.y1 + 0.3, 1.26), this.P(d0 - 0.1, tw.y1 + 0.3, 1.26)], pal.cap);
    }
    // the VRAM bar on the right face: used of total, only when measured or reported
    if (build >= 1 || born < -50) {
      const v = mm.live?.vram;
      if (v != null && this.cam.A >= 14) {
        const u = tw.y0 + 0.35; const z0b = 0.55; const z1b = topZ - 0.35;
        const p0 = this.P(tw.x1 + 0.02, u, z0b); const p1 = this.P(tw.x1 + 0.02, u, z1b); const pf = this.P(tw.x1 + 0.02, u, z0b + (z1b - z0b) * clamp(v));
        ctx.lineCap = 'round';
        ctx.strokeStyle = alpha('#000000', 0.45); ctx.lineWidth = Math.max(3, this.cam.A * 0.1);
        ctx.beginPath(); ctx.moveTo(p0[0], p0[1]); ctx.lineTo(p1[0], p1[1]); ctx.stroke();
        ctx.strokeStyle = v > 0.9 ? T.warn : T.link; ctx.lineWidth = Math.max(2, this.cam.A * 0.06);
        ctx.beginPath(); ctx.moveTo(p0[0], p0[1]); ctx.lineTo(pf[0], pf[1]); ctx.stroke();
        ctx.lineCap = 'butt';
      }
    }
    // the roof: a thin parapet
    if (build >= 1 || born < -50) {
      const r0 = tw.x0 + 0.15; const r1 = tw.x1 - 0.15; const s0 = tw.y0 + 0.15; const s1 = tw.y1 - 0.15; const t = 0.08;
      this.box(r0, s0, topZ, r1 - r0, t, 0.14, pal.cap, pal.capSide, pal.capSide, null);
      this.box(r0, s0, topZ, t, s1 - s0, 0.14, pal.cap, pal.capSide, pal.capSide, null);
      this.box(r0, s1 - t, topZ, r1 - r0, t, 0.14, pal.cap, pal.capSide, shade(pal.capSide, -0.15), null);
      this.box(r1 - t, s0, topZ, t, s1 - s0, 0.14, pal.cap, pal.capSide, shade(pal.capSide, -0.15), null);
    }
    // scaffolding and a crane while it is being built
    if (build < 1 && !this.reduced()) {
      ctx.strokeStyle = alpha(T.text, 0.25); ctx.lineWidth = 1;
      const top = 0.3 + floors * FLOOR_H;
      for (const [x, y] of [[tw.x0 - 0.2, tw.y1 + 0.2], [tw.x1 + 0.2, tw.y1 + 0.2], [tw.x1 + 0.2, tw.y0 - 0.2]]) {
        const a = this.P(x, y, 0.3); const b = this.P(x, y, top);
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      }
      for (let z = 0.3; z <= top; z += FLOOR_H / 2) {
        const p = [this.P(tw.x0 - 0.2, tw.y1 + 0.2, z), this.P(tw.x1 + 0.2, tw.y1 + 0.2, z), this.P(tw.x1 + 0.2, tw.y0 - 0.2, z)];
        ctx.beginPath(); ctx.moveTo(p[0][0], p[0][1]); ctx.lineTo(p[1][0], p[1][1]); ctx.lineTo(p[2][0], p[2][1]); ctx.stroke();
      }
      const cz = top + 1.4;
      const mast0 = this.P(tw.x0 + 0.4, tw.y0 + 0.4, topZ); const mast1 = this.P(tw.x0 + 0.4, tw.y0 + 0.4, cz);
      ctx.strokeStyle = pal.metal; ctx.lineWidth = Math.max(1, this.cam.A * 0.04);
      ctx.beginPath(); ctx.moveTo(mast0[0], mast0[1]); ctx.lineTo(mast1[0], mast1[1]); ctx.stroke();
      const jib = this.P(tw.x0 + 4.4, tw.y0 + 0.4, cz);
      ctx.beginPath(); ctx.moveTo(mast1[0], mast1[1]); ctx.lineTo(jib[0], jib[1]); ctx.stroke();
    }
    // the GPU core on the roof
    const coreOn = build >= 1 || born < -50;
    if (coreOn) this.drawCore(m, (tw.x0 + tw.x1) / 2, (tw.y0 + tw.y1) / 2, topZ, mm, col, offline);
    // hit box for the machine panel
    const pts = [this.P(tw.x0 - 0.3, tw.y1 + 0.3, 0), this.P(tw.x1 + 0.3, tw.y1 + 0.3, 0), this.P(tw.x1 + 0.3, tw.y0 - 0.3, 0), this.P(tw.x0, tw.y0, H + 1.6)];
    const xs = pts.map((p) => p[0]); const ys = pts.map((p) => p[1]);
    this.machineHits.push({ id: m.id, x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) });
    void city;
  }

  /**
   * The GPU core of a machine: a hexagon prism on the roof. Its top lights while a turn or a job
   * runs here, and the load ring around it is the measured GPU use (no measurement, no ring).
   */
  drawCore(holder, x, y, z, mm, col, offline) {
    const ctx = this.ctx;
    const T = artTokens();
    const pal = this.pal;
    const live = mm.live || {};
    const util = live.util == null ? null : clamp(live.util);
    const busy = (live.jobs || 0) + (live.slotsBusy || 0) > 0;
    const glow = clamp(holder.glow || 0);
    const top = offline ? pal.capSide : busy || glow > 0.05 ? mixHex(pal.cap, T.accent, 0.35 + glow * 0.3) : pal.cap;
    this.hexPrism(x, y, z, 0.62, 0.32, top, pal.capSide, shade(pal.capSide, -0.2));
    const c = this.P(x, y, z + 0.32);
    const R = this.cam.A * 0.62;
    // the hexagon inlay on top
    ctx.save();
    ctx.translate(c[0], c[1]); ctx.scale(1, 0.5);
    ctx.beginPath(); hexScreen(ctx, 0, 0, R * 0.55);
    ctx.strokeStyle = offline ? alpha(T.text, 0.15) : alpha(busy ? T.accent : T.text, busy ? 0.9 : 0.3); ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.restore();
    // the load ring: a track and the measured share, flat on the roof
    if (util != null && !offline) {
      ctx.lineCap = 'round';
      ctx.strokeStyle = alpha(T.text, 0.12); ctx.lineWidth = Math.max(1.5, this.cam.A * 0.05);
      ctx.beginPath(); ctx.ellipse(c[0], c[1], R * 1.35, R * 0.68, 0, 0, 6.28); ctx.stroke();
      ctx.strokeStyle = util > 0.9 ? T.warn : T.accent;
      ctx.beginPath(); ctx.ellipse(c[0], c[1], R * 1.35, R * 0.68, 0, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0.02, util)); ctx.stroke();
      ctx.lineCap = 'butt';
    }
    if (busy && !offline) (this.lamps ||= []).push([c[0], c[1], 1.2, rgb(T.accent).join(',')]);
    holder.coreAt = [c[0], c[1], R];
    void col;
  }

  /* ---------- bridges ---------- */
  drawBridge(m, pal, city) {
    const br = m.bridge;
    const born = this.now - m.born;
    const ext = born < -50 ? 1 : clamp((born - 1.8) / 2.0);
    if (ext <= 0) return;
    if (!this.visible(Math.min(br.a.x, br.b.x) - 1, Math.min(br.a.y, br.b.y) - 1, Math.max(br.a.x, br.b.x) + 1, Math.max(br.a.y, br.b.y) + 1, 4, -1)) return;
    const ctx = this.ctx;
    const T = pal.T;
    const n = 26;
    const px = -br.uy * 0.6; const py = br.ux * 0.6;
    const segs = Math.max(1, Math.round(n * ext));
    const pt = (u, side, dz = 0) => { const p = bridgePoint(br, u); return this.P(p.x + px * side, p.y + py * side, p.z + dz); };
    const front = (px + py) > 0 ? 1 : -1;
    // a precise steel deck: one fascia, one plate
    const fascia = []; const plate = [];
    for (let i = 0; i <= segs; i++) { fascia.push(pt(i / n, front, 0)); plate.push(pt(i / n, -front, 0)); }
    this.poly([...fascia, ...fascia.slice().reverse().map((p) => [p[0], p[1] + Math.max(2, this.cam.A * 0.16)])], pal.deckSide);
    this.poly([...fascia, ...plate.slice().reverse()], pal.deck);
    // hairline rails and sparse posts
    ctx.strokeStyle = pal.rail; ctx.lineWidth = 1;
    for (const side of [-1, 1]) {
      ctx.beginPath();
      for (let i = 0; i <= segs; i++) { const p = pt(i / n, side, 0.45); if (i) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); }
      ctx.stroke();
      for (let i = 0; i <= segs; i += 4) { const a = pt(i / n, side); const b = pt(i / n, side, 0.45); ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); }
    }
    // the data line along the deck
    const cablePts = [];
    for (let i = 0; i <= segs; i++) cablePts.push(pt(i / n, 0, 0.02));
    const glow = clamp(m.glow);
    const borrowing = borrowTo(city, m.id);
    ctx.lineCap = 'round';
    ctx.strokeStyle = alpha(T.text, 0.12); ctx.lineWidth = 1;
    ctx.beginPath(); cablePts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.stroke();
    // a borrowed GPU: a clean glowing link line
    if (borrowing || glow > 0.02) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const g = Math.max(glow, borrowing ? 0.6 : 0);
      ctx.strokeStyle = alpha(borrowing ? T.link : T.accent, 0.55 * g);
      ctx.lineWidth = Math.max(1.5, this.cam.A * 0.07);
      ctx.shadowColor = borrowing ? T.link : T.accent; ctx.shadowBlur = 8 * g;
      ctx.beginPath(); cablePts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.stroke();
      ctx.restore();
    }
    ctx.lineCap = 'butt';
    m.cable = cablePts;
    // a job streams tokens over this bridge: a steady stream of data particles (it stops when the tokens stop)
    const jb = m.m?.bridge;
    if (jb?.live && !this.reduced() && cablePts.length > 1) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const count = 9;
      for (let i = 0; i < count; i++) {
        const u = ((this.now * 0.35 + i / count) % 1);
        const q0 = bridgePoint(br, u * ext); const q = this.P(q0.x, q0.y, q0.z + 0.04);
        ctx.fillStyle = alpha(T.link, 0.9 * Math.sin(Math.PI * u));
        ctx.beginPath(); ctx.arc(q[0], q[1], Math.max(1.5, this.cam.A * 0.06), 0, 6.28); ctx.fill();
      }
      ctx.restore();
    }
    // a failed job: a broken segment in the middle of the deck, with the reason; a click opens the job
    if (jb?.failed && ext >= 1) {
      const a = pt(0.44, 0, 0.02); const b = pt(0.56, 0, 0.02);
      this.poly([pt(0.46, -1.05), pt(0.54, -1.05), pt(0.54, 1.05), pt(0.46, 1.05)], pal.void1);
      const c0 = pt(0.47, -1); const c1 = pt(0.53, 1); const c2 = pt(0.47, 1); const c3 = pt(0.53, -1);
      ctx.strokeStyle = T.bad; ctx.lineWidth = Math.max(1.2, this.cam.A * 0.04);
      ctx.beginPath(); ctx.moveTo(c0[0], c0[1]); ctx.lineTo(c1[0], c1[1]); ctx.moveTo(c2[0], c2[1]); ctx.lineTo(c3[0], c3[1]); ctx.stroke();
      const mid = pt(0.5, 0, 1.2);
      const text = this.t(`city.job.err.${jb.failed.code}`);
      drawPill(ctx, mid[0], mid[1], text, T.bad, clamp(this.cam.A * 0.4, 10, 12));
      const r = Math.max(26, this.cam.A * 1.2);
      (this.bridgeHits ||= []).push({ jobId: jb.failed.id, x: Math.min(a[0], b[0]) - r / 2, y: Math.min(a[1], b[1], mid[1]) - r / 2, w: Math.abs(a[0] - b[0]) + r, h: Math.abs(a[1] - mid[1]) + r });
    }
  }

  /** The pipeline order on the corridor floor: hairline chevrons from each back room to the next. */
  drawPipeline(c) {
    const A = this.cam.A;
    if (A < 13 || this.focus?.kind === 'machine') return;
    const order = (c.pipeline || []).filter((r) => ROOMS[r]?.row === 'back');
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = alpha(artTokens().text, 0.3); ctx.lineWidth = 1; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (let i = 0; i < order.length - 1; i++) {
      const a = ROOMS[order[i]]; const b = ROOMS[order[i + 1]];
      const x0 = a.x0 + 2; const x1 = b.x0 + 2;
      const dir = Math.sign(x1 - x0) || 1;
      const y = CORRIDOR_Y - 0.15;
      for (let x = x0 + dir * 0.9; dir > 0 ? x < x1 - 0.6 : x > x1 + 0.6; x += dir * 0.8) {
        const p = this.P(x, y, 0.31); const q = this.P(x - dir * 0.18, y - 0.14, 0.31); const r = this.P(x - dir * 0.18, y + 0.14, 0.31);
        ctx.beginPath(); ctx.moveTo(q[0], q[1]); ctx.lineTo(p[0], p[1]); ctx.lineTo(r[0], r[1]); ctx.stroke();
      }
    }
    ctx.restore();
  }

  /** A task that a check sent back: an arc from that room to the work room, while it waits or works there. */
  drawLoops(c) {
    const A = this.cam.A;
    if (A < 9 || !c.loops?.length) return;
    const ctx = this.ctx;
    const T = artTokens();
    const seen = new Map();
    for (const l of c.loops) {
      const a = ROOMS[l.from]; const b = ROOMS[l.to];
      if (!a || !b) continue;
      const k = `${l.from}>${l.to}`;
      const lane = seen.get(k) || 0; seen.set(k, lane + 1);
      const za = a.row === 'back' ? WALL + 0.9 : 2.2; const zb = b.row === 'back' ? WALL + 0.9 : 2.2;
      const ca = roomCenter(l.from); const cb = roomCenter(l.to);
      const p0 = this.P(ca.x, a.y0 + 1.2, za); const p1 = this.P(cb.x, b.y0 + 1.2, zb);
      const lift = A * (2.2 + lane * 0.7);
      const mx = (p0[0] + p1[0]) / 2; const my = Math.min(p0[1], p1[1]) - lift;
      ctx.save();
      ctx.strokeStyle = alpha(T.bad, 0.85); ctx.lineWidth = Math.max(1.2, A * 0.04); ctx.lineCap = 'round';
      if (!this.reduced()) { ctx.setLineDash([A * 0.3, A * 0.22]); ctx.lineDashOffset = this.now * A * 0.8; }
      ctx.beginPath(); ctx.moveTo(p0[0], p0[1]); ctx.quadraticCurveTo(mx, my, p1[0], p1[1]); ctx.stroke();
      ctx.setLineDash([]);
      // the arrow head at the work room
      const tx = p1[0] - mx; const ty = p1[1] - my; const len = Math.hypot(tx, ty) || 1;
      const ux = tx / len; const uy = ty / len; const s = Math.max(5, A * 0.24);
      ctx.fillStyle = T.bad;
      ctx.beginPath(); ctx.moveTo(p1[0], p1[1]); ctx.lineTo(p1[0] - ux * s - uy * s * 0.5, p1[1] - uy * s + ux * s * 0.5); ctx.lineTo(p1[0] - ux * s + uy * s * 0.5, p1[1] - uy * s - ux * s * 0.5); ctx.closePath(); ctx.fill();
      ctx.restore();
      if (A >= 12) drawPill(ctx, mx, (Math.min(p0[1], p1[1]) + my) / 2 + lift * 0.25, this.t('city.fx.loop', { n: l.n, max: l.max || 3 }), T.bad, clamp(A * 0.4, 10, 12));
    }
  }

  /** One data packet per task or GPU turn crossing a bridge, with a short trail. */
  drawCouriers() {
    const ctx = this.ctx;
    for (const cr of this.couriers) {
      const br = cr.m.bridge;
      const u0 = clamp((this.now - cr.t0) / cr.dur);
      const e = easeInOut(u0);
      const u = cr.dir > 0 ? e : 1 - e;
      const p0 = bridgePoint(br, u);
      const p = this.P(p0.x, p0.y, p0.z + 0.08);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 1; i <= 5; i++) {
        const uu = clamp(u - cr.dir * i * 0.012);
        const q0 = bridgePoint(br, uu); const q = this.P(q0.x, q0.y, q0.z + 0.08);
        ctx.fillStyle = alpha(cr.color, 0.4 * (1 - i / 6));
        ctx.beginPath(); ctx.arc(q[0], q[1], Math.max(1.2, this.cam.A * 0.05) * (1 - i / 8), 0, 6.28); ctx.fill();
      }
      ctx.restore();
      if (cr.kind === 'task') drawNoteIcon(ctx, p[0], p[1] - this.cam.A * 0.2, Math.max(10, this.cam.A * 0.42), null, cr.color);
      else { ctx.fillStyle = cr.color; ctx.beginPath(); hexScreen(ctx, p[0], p[1], Math.max(2.5, this.cam.A * 0.1)); ctx.fill(); }
    }
  }

  /* ---------- bees ---------- */
  drawBee(a) {
    const ctx = this.ctx;
    const now = this.now;
    const reduced = this.reduced();
    const k = this.k;
    const T = artTokens();
    const m = a.mode;
    let hover = 0; let wingAmp = 0.1; let wingRate = 16;
    if (!reduced) {
      if (m === 'walk') { wingAmp = 0.22; wingRate = 28; hover = 0.04; }
      else if (m === 'borrow') { wingAmp = 0.16; wingRate = 22; hover = Math.sin(now * 1.6 + a.ph) * 0.03; }
      else if (m === 'sleep') { wingAmp = 0; }
      else hover = Math.sin(now * 1.5 + a.ph) * 0.015;
    } else wingAmp = 0;
    const p = this.P(a.pos.x, a.pos.y, a.pos.z + (a.place.kind === 'room' && !a.path.length ? 0.3 : 0) + hover);
    a.sx = p[0]; a.sy = p[1];
    // the status ring on the ground under the unit
    const groundZ = a.path.length && a.path[0].bridge ? bridgeGroundZ(a) : (a.place.kind === 'room' && roomAt(a.pos.x, a.pos.y) ? 0.3 : a.pos.z > 2 ? this.towerHeight(this.machines.get(a.place.machine) || {}) : 0);
    const sp = this.P(a.pos.x, a.pos.y, Math.min(groundZ, a.pos.z));
    const sc = statusColor(m === 'walk' ? (a.ag.taskId ? 'working' : 'idle') : m, T);
    const sleep = m === 'sleep';
    const pulsing = m === 'thinking' && !reduced;
    ctx.save();
    ctx.globalAlpha = a.alpha * (sleep ? 0.5 : pulsing ? 0.55 + 0.35 * (0.5 + 0.5 * Math.sin(now * 3.4 + a.ph)) : 0.9);
    ctx.fillStyle = 'rgba(0,0,0,.25)';
    ctx.beginPath(); ctx.ellipse(sp[0], sp[1], 14 * k, 6 * k, 0, 0, 6.28); ctx.fill();
    ctx.strokeStyle = sc; ctx.lineWidth = Math.max(1, k * 1.8);
    if (sleep) ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.ellipse(sp[0], sp[1], 17 * k, 7.5 * k, 0, 0, 6.28); ctx.stroke();
    ctx.restore();
    const img = this.sprite(a.ag);
    ctx.save();
    ctx.globalAlpha = a.alpha;
    ctx.translate(p[0], p[1]);
    // anchor: SVG point (32, 44) sits on the world point
    ctx.translate(-32 * k, -44 * k);
    const flap = wingAmp ? Math.sin(now * wingRate + a.ph) * wingAmp : 0;
    ctx.fillStyle = alpha(T.text, 0.12); ctx.strokeStyle = alpha(T.text, 0.42); ctx.lineWidth = Math.max(0.6, k);
    for (const [wx, dir] of [[19, -1], [45, 1]]) {
      ctx.save(); ctx.translate(wx * k, 27 * k); ctx.rotate(dir * (0.42 - flap));
      ctx.beginPath(); ctx.ellipse(dir * 4 * k, -2 * k, 11 * k, 5.4 * k, 0, 0, 6.28); ctx.fill(); ctx.stroke();
      ctx.restore();
    }
    if (img) ctx.drawImage(img, -4 * k, -2 * k, 72 * k, 76 * k);
    else { ctx.fillStyle = tone(a.ag.color || T.accent); ctx.beginPath(); ctx.arc(32 * k, 40 * k, 14 * k, 0, 6.28); ctx.fill(); }
    ctx.restore();
    // a task card in its hands while it walks to a new room; a compute packet on the way to a roof
    const task = a.ag.taskId && this.getCity().tasks[a.ag.taskId];
    if (a.mode === 'walk' && task && a.place.kind === 'room') drawNoteIcon(ctx, p[0], p[1] + 18 * k, 15 * k * 1.2, null, tone(a.ag.color || T.accent));
    else if (a.mode === 'walk' && a.place.kind === 'roof') drawParcel(ctx, p[0], p[1] + 18 * k, 14 * k, T.link);
    this.hits.push({ id: a.id, x: p[0] - 26 * k, y: p[1] - 40 * k, w: 52 * k, h: 70 * k });
  }

  sprite(ag) {
    const raw = Math.max(16, this.k * 72 * this.dpr);
    const px = Math.round(Math.pow(2, Math.round(Math.log2(raw) * 3) / 3));
    const key = `${ag.color}|${ag.role}|${ag.name}|${px}`;
    const sp = this.sprites.get(ag.id);
    if (sp && sp.key === key) return sp.ready ? sp.img : sp.prev;
    const img = new Image();
    const svg = beeSvg({ id: ag.id, name: ag.name, role: ag.role, color: ag.color }, { title: '' })
      .replace(/<g opacity="\.95">[\s\S]*?<\/g>/, '')
      .replace('viewBox="0 0 64 64"', `viewBox="-4 -2 72 76" width="${px}" height="${Math.round((px * 76) / 72)}"`);
    const next = { key, img, ready: false, prev: sp ? (sp.ready ? sp.img : sp.prev) : null };
    img.onload = () => { next.ready = true; if (!this.running) this.draw(); };
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    this.sprites.set(ag.id, next);
    return next.prev;
  }

  /* ---------- lights, focus, overlay ---------- */
  drawLights(pal) {
    const ctx = this.ctx;
    const lamps = this.lamps || []; this.lamps = [];
    const wins = this.windowLights || []; this.windowLights = [];
    const screens = this.screens || []; this.screens = [];
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const al = clamp((pal.night - 0.2) * 0.5);
    for (const [x, y, s = 1, rgbs] of lamps) {
      const strength = rgbs ? 0.18 : al * 0.35;
      if (strength <= 0) continue;
      const r = this.cam.A * 1.1 * s;
      const c = rgbs || rgb(pal.T.accent2).join(',');
      const g = ctx.createRadialGradient(x, y, 1, x, y, r);
      g.addColorStop(0, `rgba(${c},${strength})`); g.addColorStop(1, `rgba(${c},0)`);
      ctx.fillStyle = g; ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
    if (al > 0) {
      for (const [x, y] of wins) {
        const r = this.cam.A * 0.7;
        const [r0, g0, b0] = rgb(pal.T.accent2);
        const g = ctx.createRadialGradient(x, y, 1, x, y, r);
        g.addColorStop(0, `rgba(${r0},${g0},${b0},${al * 0.18})`); g.addColorStop(1, `rgba(${r0},${g0},${b0},0)`);
        ctx.fillStyle = g; ctx.fillRect(x - r, y - r, r * 2, r * 2);
      }
    }
    // screens throw a faint light on busy units
    for (const [x, y, col] of screens) {
      const r = this.cam.A * 0.6;
      const [r0, g0, b0] = rgb(col);
      const g = ctx.createRadialGradient(x, y, 1, x, y, r);
      g.addColorStop(0, `rgba(${r0},${g0},${b0},${0.08 + pal.night * 0.06})`); g.addColorStop(1, `rgba(${r0},${g0},${b0},0)`);
      ctx.fillStyle = g; ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
    ctx.restore();
  }

  drawFocus() {
    const f = this.focus;
    if (!f || f.kind !== 'room') return;
    const r = ROOMS[f.id];
    if (!r) return;
    const ctx = this.ctx;
    const pz = 0.3;
    const h = r.row === 'back' ? WALL + 0.3 : 2.4;
    const pts = [this.P(r.x0 - 0.15, r.y0 - 0.15, pz), this.P(r.x0 - 0.15, r.y0 - 0.15, h + 0.6), this.P(r.x1 + 0.15, r.y0 - 0.15, h + 0.6), this.P(r.x1 + 0.15, r.y0 - 0.15, pz), this.P(r.x1 + 0.15, r.y1 + 0.15, pz), this.P(r.x0 - 0.15, r.y1 + 0.15, pz)];
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, this.w, this.h);
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = pts.length - 1; i > 0; i--) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
    ctx.fillStyle = alpha(this.pal.T.bg, 0.55);
    ctx.fill('evenodd');
    ctx.restore();
  }

  drawOverlay(pal, c) {
    const ctx = this.ctx;
    const now = this.now;
    const k = this.k;
    const A = this.cam.A;
    const T = pal.T;
    // room labels over the rooms when zoomed out
    if (A >= 10 && A < 44 && !(this.focus?.kind === 'room')) {
      for (const key of ROOM_KINDS) {
        const r = ROOMS[key];
        const cn = roomCenter(key);
        const z = r.row === 'back' ? WALL + 1.1 : 2.1;
        const p = this.P(cn.x, r.row === 'back' ? r.y0 + 0.4 : r.y0 + 0.6, z);
        const n = [...this.notes.values()].filter((x) => x.room === key && !x.gone && x.t.status !== 'done').length;
        drawRoomPill(ctx, p[0], p[1], this.t(`city.room.${key}`), roomColor(key), n, clamp(A * 0.42, 10, 12.5), this.highlightRoom(key));
      }
    }
    // machine signs, with the measured load when there is one
    for (const m of this.machines.values()) {
      const born = now - m.born;
      if (born < 3 && born > -50) continue;
      const tw = towerOf(m.center);
      const p = this.P((tw.x0 + tw.x1) / 2, (tw.y0 + tw.y1) / 2, this.towerHeight(m) + 2.0);
      const drop = this.reduced() || born < -50 ? 1 : easeOut(clamp((born - 3) / 0.25));
      ctx.globalAlpha = clamp(drop);
      const util = m.m?.live?.util;
      drawMachineSign(ctx, p[0], p[1] - (1 - drop) * 8, m.m?.name || m.id, tone(m.m?.color || T.ok), m.m?.online === false ? this.t('city.machine.offline') : util != null ? `${Math.round(util * 100)}%` : null, clamp(A * 0.45, 11, 13), this.highlight?.kind === 'machine' && this.highlight.id === m.id, m.m?.online === false);
      ctx.globalAlpha = 1;
    }
    // your building sign
    {
      const p = this.P(-1.6, -1.4, 5.0);
      const self = c.machines[c.selfId] || {};
      const util = self.live?.util;
      drawMachineSign(ctx, p[0], p[1], self.name || this.t('city.machine.you'), T.accent, util != null ? `${Math.round(util * 100)}%` : null, clamp(A * 0.45, 11, 13), this.highlight?.kind === 'machine' && this.highlight.id === c.selfId, false);
    }
    // agents: the compact info tag, expanded on hover or selection; bubbles
    for (const a of this.actors.values()) {
      if (a.sx < -100) continue;
      const headY = a.sy - 40 * k;
      ctx.globalAlpha = a.alpha;
      const on = this.highlight?.id === a.id || this.dropTarget?.id === a.id;
      if (A >= 15 && a.mode === 'borrow') drawPill(ctx, a.sx, headY - 2, this.t('city.fx.borrowing'), T.link, clamp(A * 0.4, 10, 12));
      if (A >= 17 || on) {
        const fs = clamp(A * 0.38, 10, 12);
        const task = a.ag.taskId && c.tasks?.[a.ag.taskId];
        drawNameTag(ctx, a.sx, a.sy + 24 * k, a.ag.name, a.ag.level, a.ag.color, on, fs,
          { status: statusColor(a.mode === 'walk' ? (a.ag.taskId ? 'working' : 'idle') : a.mode, T), role: a.ag.role, task: task?.title || '' });
      }
      if (a.bubble && A >= 20) {
        const age = now - a.bubble.at;
        ctx.globalAlpha = Math.min(clamp(age / 0.2), clamp((a.bubble.until - now) / 0.25)) * a.alpha;
        drawBubble(ctx, a.sx, headY, mdLine(a.bubble.text, 140), clamp(A * 0.4, 10.5, 12.5), this.w, a.ag.color);
      }
      ctx.globalAlpha = 1;
    }
    // cards flying between boards
    for (const n of this.notes.values()) {
      if (!n.fly) continue;
      const u = clamp((now - n.fly.t0) / 0.9);
      if (u >= 1) { n.fly = null; continue; }
      const to = this.notePos(n);
      const e = easeInOut(u);
      const x = lerp(n.fly.from.x, to.x, e); const y = lerp(n.fly.from.y, to.y, e); const z = lerp(n.fly.from.z, to.z, e) + Math.sin(Math.PI * u) * 1.6;
      const p = this.P(x, y, z);
      drawNoteIcon(ctx, p[0], p[1], Math.max(10, A * 0.5), null, n.t.status === 'done' ? T.ok : tone(this.actors.get(n.t.assignee)?.ag.color || T.accent));
    }
  }

  drawParticles() {
    const ctx = this.ctx;
    const T = artTokens();
    for (const p of this.parts) {
      const a = this.actors.get(p.id);
      if (!a || a.sx < -100) continue;
      const u = p.age / p.max;
      if (p.kind === 'pulse') {
        const e = easeOut(u);
        const groundY = a.sy + 24 * this.k;
        ctx.globalAlpha = (1 - e) * 0.85 * a.alpha;
        ctx.strokeStyle = T.ok; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.ellipse(a.sx, groundY, (17 + e * 12) * this.k, (7.5 + e * 5) * this.k, 0, 0, 6.28); ctx.stroke();
      } else if (p.kind === 'check') {
        const fade = u < 0.15 ? u / 0.15 : u > 0.8 ? (1 - u) / 0.2 : 1;
        ctx.globalAlpha = clamp(fade) * a.alpha;
        iconCheck(ctx, a.sx + 20 * this.k, a.sy - 34 * this.k - Math.min(u, 0.3) * 8, clamp(this.cam.A * 0.42, 12, 18));
      }
    }
    ctx.globalAlpha = 1;
  }
}

/* ---------- helpers ---------- */
function borrowTo(c, machineId) { return !!c && Object.values(c.borrows || {}).some((b) => b.to === machineId || b.from === machineId); }

function bridgeGroundZ(a) { return Math.max(0, a.pos.z - WALK_Z); }

/** A room label chip: a hexagon dot in the room color, the name, the open count in mono. */
function drawRoomPill(ctx, x, y, text, color, count, fs, on) {
  const T = artTokens();
  ctx.font = `500 ${fs}px ${FONT}`;
  const tw = ctx.measureText(text).width;
  ctx.font = `500 ${fs * 0.88}px ${MONO}`;
  const cw = count ? ctx.measureText(String(count)).width + 10 : 0;
  const w = tw + 24 + cw; const h = fs + 9;
  const x0 = Math.round(x - w / 2); const y0 = Math.round(y - h / 2);
  ctx.fillStyle = alpha(T.panel, on ? 0.96 : 0.84); roundRect(ctx, x0, y0, w, h, 4); ctx.fill();
  ctx.strokeStyle = on ? alpha(T.accent, 0.8) : alpha(T.text, 0.1); ctx.lineWidth = 1; ctx.stroke();
  ctx.fillStyle = color; ctx.beginPath(); hexScreen(ctx, x0 + 10, y, fs * 0.3); ctx.fill();
  ctx.font = `500 ${fs}px ${FONT}`;
  ctx.fillStyle = T.text; ctx.fillText(text, x0 + 18, y + fs * 0.36);
  if (count) {
    ctx.font = `500 ${fs * 0.88}px ${MONO}`;
    ctx.fillStyle = T.accent; ctx.textAlign = 'right';
    ctx.fillText(String(count), x0 + w - 7, y + fs * 0.34); ctx.textAlign = 'left';
  }
}

/** A machine name sign: a status dot, the name and one small metric (the measured load) or the offline state. */
function drawMachineSign(ctx, x, y, text, color, sub, fs, on, offline) {
  const T = artTokens();
  ctx.font = `600 ${fs}px ${FONT}`;
  const tw = ctx.measureText(text).width;
  ctx.font = `500 ${fs * 0.86}px ${MONO}`;
  const sw = sub ? ctx.measureText(sub).width + 10 : 0;
  const w = tw + 26 + sw; const h = fs + 11;
  const x0 = Math.round(x - w / 2); const y0 = Math.round(y - h / 2);
  ctx.strokeStyle = alpha(T.text, 0.18); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x, y0 + h); ctx.lineTo(x, y0 + h + 8); ctx.stroke();
  ctx.fillStyle = alpha(T.panel, on ? 0.97 : 0.88); roundRect(ctx, x0, y0, w, h, 4); ctx.fill();
  ctx.strokeStyle = on ? alpha(T.accent, 0.8) : alpha(T.text, 0.12); ctx.stroke();
  ctx.fillStyle = offline ? T.faint : color; ctx.beginPath(); ctx.arc(x0 + 10, y, 3, 0, 6.28); ctx.fill();
  ctx.fillStyle = T.text; ctx.font = `600 ${fs}px ${FONT}`; ctx.fillText(text, x0 + 18, y + fs * 0.36);
  if (sub) { ctx.fillStyle = offline ? T.bad : T.muted; ctx.font = `500 ${fs * 0.86}px ${MONO}`; ctx.fillText(sub, x0 + 26 + tw, y + fs * 0.32); }
}

export { WALL, ROOMS, CORRIDOR_Y };
