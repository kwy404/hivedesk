// Hive City: an isometric little city of floating honeycomb islands, drawn on one canvas with
// the Office art. Your building shows its rooms as an open dollhouse, friend machines rise as
// towers on their own islands, and bridges light up when tasks or GPU turns travel.
// Nothing here moves by itself: every walk, construction and glow follows a change in the city
// state (ui/city/model.js), which only changes from engine events.

import { beeSvg } from '/js/bees.js';
import {
  nightFactor, goldenFactor, iconJar, roundRect, hexPath, hexScreen, wrap, drawNameTag, drawBubble, drawPill,
  iconClock, iconCheck, iconX, iconDots, iconMag, iconFlask, iconPause, drawNoteIcon, drawParcel, mixHex, shade, alpha, rgb,
} from '/office/scene.js';
import {
  HOME, FRIEND_R, ROOMS, BUILDING, ENTRANCE, PLAZA, WALK_Z, SEAT_Z, roomCenter, spotFor, hexCorners, friendCenter, bridgeTo,
  bridgePoint, towerOf, roomPath, exitPath, roomAt, CORRIDOR_Y,
} from './layout.js';
import { ROOM_COLOR, ROOM_KINDS, borrowOf } from './model.js';

const FONT = '"Segoe UI Variable Text","Segoe UI",system-ui,-apple-system,sans-serif';
const MONO = 'ui-monospace,"Cascadia Code",Consolas,monospace';
const OUT = '#24160C';
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
const easeOutBack = (t) => { const c1 = 1.70158; const c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[(Math.random() * arr.length) | 0];
const hash = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); };

const GLYPHS = {
  design: ['#', 'px', 'rem', 'rgb', 'em', ':root'],
  code: ['{ }', '</>', '=>', '( )', ';', 'fn', '++'],
  review: ['+', '-', 'diff', '?', 'ok'],
  test: ['ok?', 'assert', '==', 'test'],
  ops: ['git', 'push', 'tag', 'v1'],
  library: ['Aa', 'md', 'mem', '...'],
  lobby: ['plan', '1.', '2.', '3.'],
};

/* ---------- day and night ---------- */
const DAY = {
  grassA: '#A3C463', grassB: '#93B758', grassC: '#B0CD6E', grout: '#7E9E48', lip: '#6F8F3E',
  path: '#EBD5A6', pathEdge: '#C4A675',
  soil: '#7A5636', rockA: '#9A7656', rockB: '#7A5C44', rockC: '#57412F', rockD: '#3E2E22',
  plinthTop: '#DCCAA6', plinthL: '#B69E78', plinthR: '#9D8562',
  wallL: '#F0E3C9', wallR: '#E6D6B8', trim: '#7A5636', comb: '#C9A979',
  floorA: '#8C6743', floorB: '#835F3D', floorC: '#946E48', grout2: '#634629', corridor: '#A88456',
  deskTop: '#ECD6AA', deskL: '#D2B07A', deskR: '#B99560', panel: '#94724A',
  part: '#EADBBF', partL: '#CDB993', partR: '#B8A37C',
  deck: '#C79A62', deckB: '#B88B55', deckSide: '#7E5A36', rail: '#6B4A2C',
  tree: '#6FA65A', treeB: '#5A8F4A', treeC: '#83B866', trunk: '#7A5636',
  tower: '#E9DCC2', towerL: '#CDBB98', towerR: '#B6A27E',
};
const NIGHT_TINT = '#131A2E';
const DUSK_TINT = '#FF9A55';

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
    this.stars = Array.from({ length: 90 }, (_, i) => ({ x: ((i * 7919) % 1000) / 1000, y: ((i * 4157) % 1000) / 1000, r: 0.5 + ((i * 13) % 7) / 6, ph: i * 1.7 }));
    this.clouds = Array.from({ length: 14 }, (_, i) => ({ x: ((i * 397) % 1000) / 1000, y: 0.08 + ((i * 211) % 1000) / 1000 * 0.5, s: 0.6 + ((i * 53) % 10) / 12, v: 0.004 + ((i * 17) % 7) / 1400 }));
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
    const dt = Math.min(0.05, (ts - this.last) / 1000);
    this.last = ts;
    this.lastDraw = ts;
    this.now += dt;
    this.update(dt);
    this.draw();
    this.opts.onFrame?.(this);
  }

  isCalm() {
    if (this.parts.length || this.couriers.length) return false;
    if (Math.abs(this.cam.A - this.camT.A) > 0.05 || Math.abs(this.cam.x - this.camT.x) > 0.01 || Math.abs(this.cam.y - this.camT.y) > 0.01) return false;
    for (const a of this.actors.values()) if (a.path.length || a.mode === 'working') return false;
    for (const m of this.machines.values()) if (this.now - m.born < 6) return false;
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
    const narrow = this.w < 900;
    this.frame(pts, narrow ? { l: 16, r: 16, t: 120, b: 150 } : { l: this.w < 1100 ? 30 : 330, r: this.panelRight ? 410 : 40, t: 100, b: 110 }, instant, 46);
  }

  focusRoom(id, instant = false) {
    const r = ROOMS[id];
    if (!r) return;
    this.focus = { kind: 'room', id };
    const pts = [[r.x0, r.y0, 0], [r.x1, r.y0, 0], [r.x1, r.y1, 0], [r.x0, r.y1, 0], [r.x0, r.y0, r.row === 'back' ? WALL + 0.4 : 2.2], [r.x1, r.y0, r.row === 'back' ? WALL + 0.4 : 2.2]];
    const narrow = this.w < 900;
    this.frame(pts, narrow ? { l: 16, r: 16, t: 140, b: 260 } : { l: 340, r: 420, t: 110, b: 150 }, instant, 170);
  }

  focusMachine(id, instant = false) {
    const m = this.machines.get(id);
    const city = this.getCity();
    if (!m || id === city.selfId) { this.fit(instant); return; }
    this.focus = { kind: 'machine', id };
    const pts = [];
    for (const [x, y] of hexCorners(m.center.x, m.center.y, FRIEND_R)) pts.push([x, y, 0]);
    pts.push([m.center.x, m.center.y, this.towerHeight(m) + 3], [m.bridge.a.x, m.bridge.a.y, 0], [PLAZA.x, PLAZA.y, 0]);
    this.frame(pts, { l: 330, r: 420, t: 110, b: 150 }, instant, 60);
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
        if (!first) { this.sound('build'); this.dust(s); if (!this.userMoved && !this.focus) this.later(0.05, () => this.fit()); }
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
        if (a.placeKey !== place.key) this.walk(a, place);
        if (ag.level > a.level) { this.label(a, this.t('city.fx.level', { n: ag.level }), '#FFD072', 1.6); this.sparkle(a, 16); this.sound('level'); }
        else if (ag.xp > a.xp && ag.level === a.level) this.label(a, this.t('city.fx.xp', { n: ag.xp - a.xp }), '#BFE3C6', 1.1);
        if (a.status !== ag.status && ag.status === 'idle' && a.status !== 'idle') a.idleSince = this.now;
      }
      a.level = ag.level; a.xp = ag.xp; a.status = ag.status;
    }
    for (const [id, a] of this.actors) if (!seenA.has(id) && !a.leaving) this.retire(a);
    // tasks: notes on the room boards, flying when they change room
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
        if (t.status === 'done') { const a = t.assignee && this.actors.get(t.assignee); if (a) { this.sparkle(a, 12); this.jar(a); } this.sound('pass'); }
      }
      if (n.t.status !== t.status && t.status === 'done' && n.room === room) { const a = this.actors.get(t.assignee); if (a) this.sparkle(a, 10); }
      n.t = t;
    }
    for (const [id, n] of this.notes) if (!seenT.has(id)) { if (!n.gone) n.gone = this.now; if (this.now - n.gone > 0.6) this.notes.delete(id); }
    this.layoutBoards();
    // bridge traffic: tasks and GPU turns travel as glowing couriers
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
      this.couriers.push({ m, kind: tr.kind, dir: tr.from === c.selfId ? 1 : -1, t0: this.now, dur: tr.kind === 'turn' ? 1.1 : 1.6, color: tr.kind === 'turn' ? '#7FE3FF' : '#FFD072' });
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
      ph: Math.random() * 6.28, blinkAt: this.now + rnd(1, 4), level: ag.level, xp: ag.xp, status: ag.status, idleSince: this.now - 30,
      nextGlyph: 0, nextZ: 0, squashAt: -9, hopAt: -9, bubble: null, sx: 0, sy: 0, facing: 1,
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
    a.squashAt = this.now;
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
      return { kind: 'stand', x0: tw.x1 + 0.35, x1: tw.x1 + 2.25, y: tw.y1 + 0.8, z0: 0.5, z1: 1.75, cols: 2, color: m.m?.color || '#7DC49B' };
    }
    if (!r) return null;
    if (r.row === 'back') return { kind: 'wallR', x0: r.x0 + 0.35, x1: r.x0 + 2.05, y: 0, z0: 0.62, z1: 1.72, cols: 2, color: ROOM_COLOR[room] };
    if (room === 'library') return { kind: 'wallL', y0: 5.75, y1: 7.5, x: 0, z0: 0.62, z1: 1.72, cols: 2, color: ROOM_COLOR[room] };
    if (room === 'lobby') return { kind: 'stand', x0: 9.2, x1: 11.7, y: 5.9, z0: 0.48, z1: 1.9, cols: 3, color: ROOM_COLOR[room] };
    return { kind: 'stand', x0: 12.4, x1: 13.9, y: 5.85, z0: 0.48, z1: 1.55, cols: 2, color: ROOM_COLOR[room] };
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

  /* ---------- effects ---------- */
  spawn(p) {
    if (this.reduced() && p.kind !== 'jar') return;
    if (this.parts.length > 360) this.parts.shift();
    p.age = 0;
    if (p.max == null) p.max = p.life;
    this.parts.push(p);
  }
  sparkle(a, n) {
    const k = this.k;
    for (let i = 0; i < n; i++) this.spawn({ kind: 'spark', x: a.sx + rnd(-26, 26) * k, y: a.sy + rnd(-34, 8) * k, vx: rnd(-30, 30), vy: rnd(-60, -10), g: 40, life: rnd(0.5, 1.1), size: rnd(2, 4.5), color: pick(['#FFD072', '#FFFFFF', a.ag.color]) });
  }
  label(a, text, color, life = 1.4) {
    this.spawn({ kind: 'label', x: a.sx + rnd(-6, 6), y: a.sy - 52 * this.k, vy: -22, text, color, life, max: life });
  }
  jar(a) { this.spawn({ kind: 'jarpop', x: a.sx, y: a.sy - 40 * this.k, vy: -30, life: 1.3 }); }
  dust(m) {
    for (let i = 0; i < 26; i++) this.later(rnd(0, 2.8), () => {
      const an = rnd(0, 6.28); const r = rnd(1, FRIEND_R * 0.8);
      const p = this.P(m.center.x + Math.cos(an) * r, m.center.y + Math.sin(an) * r, 0);
      this.spawn({ kind: 'puff', x: p[0], y: p[1], vx: rnd(-20, 20), vy: rnd(-24, -6), life: rnd(0.8, 1.5), size: rnd(6, 14) * this.cam.A / 30 });
    });
  }
  later(sec, fn) { (this.timers ||= []).push({ at: this.now + sec, fn }); }

  get k() { return (this.cam.A * 1.32) / 64; }

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
        const step = WALK_SPEED * (a.path.length > 14 ? 1.7 : a.path.length > 6 ? 1.25 : 1) * dt;
        if (Math.abs(dx - dy) > 0.01) a.facing = dx - dy > 0 ? 1 : -1;
        if (dist <= step) {
          a.pos = { x: to.x, y: to.y, z: to.z };
          a.path.shift();
          if (!a.path.length) { a.squashAt = this.now; a.onDone?.(); a.onDone = null; }
        } else {
          a.pos.x += (dx / dist) * step; a.pos.y += (dy / dist) * step; a.pos.z += (dz / dist) * step;
        }
      }
      if (a.born > 0) a.alpha = clamp((this.now - a.born) / 0.6);
      if (a.leaving) a.alpha = 1 - clamp((this.now - a.leaving - 1.2) / 1.2);
      const st = a.ag.status;
      a.mode = a.path.length ? 'walk' : st === 'working' ? 'working' : st === 'thinking' ? 'thinking' : st === 'waiting' ? 'waiting' : st === 'reviewing' ? 'reviewing' : st === 'testing' ? 'testing' : st === 'sleeping' || st === 'offline' ? 'sleep' : (this.now - a.idleSince > 14 ? 'sleep' : 'idle');
      if (a.place.kind === 'roof' && !a.path.length) a.mode = 'borrow';
      if (!reduced && !a.path.length) {
        if (a.mode === 'working' && this.now > a.nextGlyph && this.cam.A > 16) { this.glyph(a); a.nextGlyph = this.now + rnd(0.18, 0.34); }
        else if (a.mode === 'sleep' && this.now > a.nextZ && this.cam.A > 16) { this.spawn({ kind: 'z', x: a.sx + 10 * this.k, y: a.sy - 20 * this.k, vx: rnd(6, 14), vy: -14, life: 2.2, size: clamp(this.cam.A * 0.32, 9, 17) }); a.nextZ = this.now + 1.2; }
        else if (a.mode === 'testing' && this.now > a.nextGlyph && this.cam.A > 16) { this.spawn({ kind: 'bubble', x: a.sx + rnd(-8, 8) + 26 * this.k, y: a.sy - 46 * this.k, vx: rnd(-6, 6), vy: rnd(-34, -20), life: rnd(0.7, 1.2), size: rnd(1.5, 3.2), color: '#7DC49B' }); a.nextGlyph = this.now + rnd(0.1, 0.22); }
        else if (a.mode === 'borrow' && this.now > a.nextGlyph) { this.spawn({ kind: 'dot', x: a.sx + rnd(-12, 12) * this.k, y: a.sy + rnd(-10, 10) * this.k, vx: rnd(-10, 10), vy: rnd(-40, -20), life: rnd(0.6, 1), size: rnd(1.5, 3), color: '#7FE3FF' }); a.nextGlyph = this.now + 0.12; }
      }
      if (this.now > a.blinkAt + 0.14) a.blinkAt = this.now + rnd(2.2, 5.5);
      if (a.bubble && this.now > a.bubble.until) a.bubble = null;
    }
    for (const m of this.machines.values()) m.glow = Math.max(borrowTo(c, m.id) ? 0.6 : 0, m.glow - dt * 0.35);
    if (this.hostGlow) this.hostGlow.glow = Math.max(0, this.hostGlow.glow - dt * 0.35);
    for (let i = this.couriers.length - 1; i >= 0; i--) if (this.now - this.couriers[i].t0 > this.couriers[i].dur) this.couriers.splice(i, 1);
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const p = this.parts[i];
      p.age += dt;
      if (p.age >= p.max) { this.parts.splice(i, 1); continue; }
      p.vy = (p.vy || 0) + (p.g || 0) * dt;
      p.x += (p.vx || 0) * dt;
      p.y += (p.vy || 0) * dt;
    }
  }

  glyph(a) {
    const room = a.place.kind === 'room' ? a.place.room : 'code';
    const base = [a.sx, a.sy - 6 * this.k];
    this.spawn({ kind: 'glyph', x: base[0] + rnd(-16, 16) * this.k, y: base[1] - rnd(0, 6), vx: rnd(-10, 10), vy: rnd(-46, -30), life: rnd(1.1, 1.6), text: pick(GLYPHS[room] || GLYPHS.code), color: a.ag.color, size: clamp(this.cam.A * 0.3, 9, 20) });
  }

  /* ---------- palette ---------- */
  palette() {
    const h = this.hourFn();
    const key = Math.round(h * 12);
    if (key === this.palAt && this.pal) return this.pal;
    this.palAt = key;
    const night = nightFactor(h);
    const gold = goldenFactor(h) * (1 - night * 0.6);
    const out = { night, gold, hour: h };
    for (const [k, v] of Object.entries(DAY)) {
      let c = mixHex(v, NIGHT_TINT, night * 0.55);
      if (gold) c = mixHex(c, DUSK_TINT, gold * 0.12);
      out[k] = c;
    }
    const skyTop = mixHex(mixHex('#6FA6D8', '#06091A', night), '#3E3470', gold * 0.75);
    const skyMid = mixHex(mixHex('#A9CDE8', '#121836', night), '#C0627A', gold * 0.6);
    const skyBot = mixHex(mixHex('#E9E6D6', '#1C2245', night), '#F7A65E', gold * 0.85);
    Object.assign(out, { skyTop, skyMid, skyBot });
    this.pal = out;
    this.skyGrad = null;
    return out;
  }

  buildPaths() {
    // hexagon ground tiles around the origin, three shades
    const mk = (r, span) => {
      const hw = Math.sqrt(3) * r; const vh = 1.5 * r;
      const fill = [new Path2D(), new Path2D(), new Path2D()];
      const grout = new Path2D();
      for (let row = -Math.ceil(span / vh) - 1; row * vh < span + r; row++) {
        for (let col = -Math.ceil(span / hw) - 1; col * hw < span + hw; col++) {
          const cx = col * hw + (row & 1 ? hw / 2 : 0); const cy = row * vh;
          const q = col - (row - (row & 1)) / 2;
          const idx = (((q - row) % 3) + 3) % 3;
          const p = new Path2D();
          for (let i = 0; i < 6; i++) { const an = (Math.PI / 180) * (60 * i - 30); const px = cx + r * Math.cos(an); const py = cy + r * Math.sin(an); if (i === 0) p.moveTo(px, py); else p.lineTo(px, py); }
          p.closePath();
          fill[idx].addPath(p); grout.addPath(p);
        }
      }
      return { fill, grout };
    };
    this.grassTiles = mk(0.95, 16);
    this.floorTiles = mk(0.42, 18);
    const comb = new Path2D(); const wr = 0.2; const whw = Math.sqrt(3) * wr;
    for (let row = 0; row * 1.5 * wr < WALL + 0.3; row++) {
      for (let col = -1; col * whw < 18; col++) {
        const cx = col * whw + (row & 1 ? whw / 2 : 0); const cy = row * 1.5 * wr;
        for (let i = 0; i < 6; i++) { const an = (Math.PI / 180) * (60 * i - 30); const px = cx + wr * 0.9 * Math.cos(an); const py = cy + wr * 0.9 * Math.sin(an); if (i === 0) comb.moveTo(px, py); else comb.lineTo(px, py); }
        comb.closePath();
      }
    }
    this.comb = comb;
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

  box(x, y, z, dx, dy, dz, top, left, right, edge = 'rgba(36,22,12,.3)') {
    const P = (X, Y, Z) => this.P(X, Y, Z);
    this.poly([P(x, y + dy, z), P(x + dx, y + dy, z), P(x + dx, y + dy, z + dz), P(x, y + dy, z + dz)], left, edge);
    this.poly([P(x + dx, y, z), P(x + dx, y + dy, z), P(x + dx, y + dy, z + dz), P(x + dx, y, z + dz)], right, edge);
    this.poly([P(x, y, z + dz), P(x + dx, y, z + dz), P(x + dx, y + dy, z + dz), P(x, y + dy, z + dz)], top, edge);
  }

  cyl(x, y, z, r, hgt, body, top) {
    const ctx = this.ctx;
    const [bx, by] = this.P(x, y, z);
    const [, ty] = this.P(x, y, z + hgt);
    const rx = r * this.cam.A * 1.414; const ry = rx / 2;
    ctx.fillStyle = body;
    ctx.beginPath(); ctx.ellipse(bx, by, rx, ry, 0, 0, Math.PI); ctx.lineTo(bx - rx, ty); ctx.ellipse(bx, ty, rx, ry, 0, Math.PI, 0, true); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(36,22,12,.32)'; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = top; ctx.beginPath(); ctx.ellipse(bx, ty, rx, ry, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
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
    const ctx = this.ctx;
    const pal = this.palette();
    this.computeOrigin();
    this.anchorParticles();
    this.base();
    this.hits = [];
    this.machineHits = [];
    this.drawSky(pal);
    const c = this.getCity();
    const islands = [{ home: true, cx: HOME.cx, cy: HOME.cy, r: HOME.r }];
    for (const m of this.machines.values()) islands.push({ m, cx: m.center.x, cy: m.center.y, r: FRIEND_R });
    islands.sort((p, q) => (p.cx + p.cy) - (q.cx + q.cy));
    for (const is of islands) this.drawIsland(is, pal);
    // bridges and the tank behind the building go first, so its walls hide them
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
    this.drawLights(pal);
    this.drawFocus();
    this.drawOverlay(pal, c);
    this.drawParticles();
    this.base();
  }

  /** Particles live in screen space: when the camera moves, move them with the world. */
  anchorParticles() {
    const o = this.lastO;
    this.lastO = { x: this.ox, y: this.oy, A: this.cam.A };
    if (!o || (o.x === this.ox && o.y === this.oy && o.A === this.cam.A)) return;
    const k = this.cam.A / o.A;
    const mx = (x) => this.ox + (x - o.x) * k;
    const my = (y) => this.oy + (y - o.y) * k;
    for (const p of this.parts) {
      p.x = mx(p.x); p.y = my(p.y);
      if (k !== 1) { p.vx = (p.vx || 0) * k; p.vy = (p.vy || 0) * k; }
    }
  }

  drawSky(pal) {
    const ctx = this.ctx;
    if (!this.skyGrad) {
      const g = ctx.createLinearGradient(0, 0, 0, this.h);
      g.addColorStop(0, pal.skyTop); g.addColorStop(0.55, pal.skyMid); g.addColorStop(1, pal.skyBot);
      this.skyGrad = g;
    }
    ctx.fillStyle = this.skyGrad;
    ctx.fillRect(0, 0, this.w, this.h);
    // stars
    if (pal.night > 0.3) {
      ctx.fillStyle = '#FFF8E6';
      for (const s of this.stars) {
        const tw = this.reduced() ? 0.8 : 0.55 + 0.45 * Math.sin(this.now * 1.4 + s.ph);
        ctx.globalAlpha = (pal.night - 0.3) * 1.4 * tw;
        ctx.beginPath(); ctx.arc(s.x * this.w, s.y * this.h * 0.7, s.r, 0, 6.28); ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
    // sun or moon, the height follows the clock
    const h = pal.hour;
    const day = h >= 6 && h < 19.5;
    const arc = day ? clamp((h - 6) / 13.5) : (((h + 24 - 19.5) % 24) / 10.5);
    const sx = this.w * (0.12 + arc * 0.76);
    const sy = this.h * (0.1 + Math.pow(Math.abs(arc - 0.5) * 2, 2) * 0.26);
    if (day) {
      const g = ctx.createRadialGradient(sx, sy, 4, sx, sy, 150);
      g.addColorStop(0, pal.gold > 0.3 ? 'rgba(255,200,120,.55)' : 'rgba(255,246,210,.55)'); g.addColorStop(1, 'rgba(255,230,180,0)');
      ctx.fillStyle = g; ctx.fillRect(sx - 150, sy - 150, 300, 300);
      ctx.fillStyle = pal.gold > 0.3 ? '#FFC27A' : '#FFF4C8'; ctx.beginPath(); ctx.arc(sx, sy, 26, 0, 6.28); ctx.fill();
    } else {
      const g = ctx.createRadialGradient(sx, sy, 4, sx, sy, 110);
      g.addColorStop(0, 'rgba(220,230,255,.22)'); g.addColorStop(1, 'rgba(220,230,255,0)');
      ctx.fillStyle = g; ctx.fillRect(sx - 110, sy - 110, 220, 220);
      ctx.fillStyle = '#F4EBCF'; ctx.beginPath(); ctx.arc(sx, sy, 20, 0, 6.28); ctx.fill();
      ctx.fillStyle = pal.skyTop; ctx.beginPath(); ctx.arc(sx + 9, sy - 5, 17, 0, 6.28); ctx.fill();
    }
    // far islands, a soft silhouette layer that drifts with the camera
    const par = 0.18;
    const bx = -((this.cam.x - this.cam.y) * this.cam.A * par) % (this.w * 1.4);
    ctx.fillStyle = mixHex(pal.skyMid, pal.skyTop, 0.35);
    ctx.globalAlpha = 0.55;
    for (let i = 0; i < 5; i++) {
      const x = ((bx + i * this.w * 0.33 + this.w * 2.8) % (this.w * 1.4)) - this.w * 0.2;
      const y = this.h * (0.3 + ((i * 37) % 10) / 40);
      const s = 40 + ((i * 53) % 5) * 14;
      ctx.beginPath(); ctx.ellipse(x, y, s, s * 0.22, 0, Math.PI, 0); ctx.lineTo(x + s * 0.4, y + s * 0.5); ctx.lineTo(x - s * 0.3, y + s * 0.45); ctx.closePath(); ctx.fill();
    }
    ctx.globalAlpha = 1;
    // clouds
    const drift = this.reduced() ? 0 : this.now;
    for (const cl of this.clouds) {
      const x = (((cl.x + drift * cl.v) % 1.3) - 0.15) * this.w;
      const y = cl.y * this.h + 40;
      const s = cl.s * Math.min(this.w, 1400) * 0.07;
      ctx.fillStyle = pal.night > 0.5 ? `rgba(150,160,200,${0.08 + (1 - pal.night) * 0.2})` : `rgba(255,255,255,${0.42 + pal.gold * 0.1})`;
      if (pal.gold > 0.3) ctx.fillStyle = `rgba(255,214,190,${0.45})`;
      ctx.beginPath();
      ctx.ellipse(x, y, s, s * 0.32, 0, 0, 6.28);
      ctx.ellipse(x + s * 0.5, y - s * 0.14, s * 0.55, s * 0.3, 0, 0, 6.28);
      ctx.ellipse(x - s * 0.45, y + s * 0.02, s * 0.45, s * 0.22, 0, 0, 6.28);
      ctx.fill();
    }
    // a sea of clouds below the islands
    const seaY = this.h * 0.86;
    const g2 = ctx.createLinearGradient(0, seaY - 60, 0, this.h);
    g2.addColorStop(0, 'rgba(255,255,255,0)');
    g2.addColorStop(1, pal.night > 0.5 ? 'rgba(60,70,110,.5)' : pal.gold > 0.3 ? 'rgba(255,200,170,.55)' : 'rgba(255,255,255,.6)');
    ctx.fillStyle = g2; ctx.fillRect(0, seaY - 60, this.w, this.h - seaY + 60);
  }

  drawIsland(is, pal) {
    const r = is.r; const cx = is.cx; const cy = is.cy;
    let rise = 0; let al = 1;
    if (is.m) {
      const t = this.now - is.m.born;
      if (t < 1.4) { const u = easeOut(clamp(t / 1.4)); rise = (1 - u) * -9; al = clamp(t / 0.5); }
      if (is.m.leaving) al = 1 - clamp((this.now - is.m.leaving) / 1.2);
    }
    if (!this.visible(cx - r, cy - r, cx + r, cy + r, 1, -r * 1.2 + rise)) return;
    const ctx = this.ctx;
    ctx.globalAlpha = al;
    const corners = hexCorners(cx, cy, r);
    const depth = is.home ? 2.3 : 1.7;
    const P = (x, y, z) => this.P(x, y, z + rise);
    // underside: a rocky cone under the island
    const tip = P(cx + 0.6, cy + 0.6, -r * 0.95);
    const bottom = corners.map(([x, y]) => P(x, y, -depth));
    for (let i = 0; i < 6; i++) {
      const p = bottom[i]; const q = bottom[(i + 1) % 6];
      this.poly([p, q, tip], [pal.rockC, pal.rockD, pal.rockD, pal.rockD, pal.rockC, pal.rockB][i], 'rgba(20,12,6,.35)');
    }
    // hanging rocks
    for (let i = 0; i < (is.home ? 5 : 3); i++) {
      const an = 0.3 + i * 1.1; const rr = r * (0.35 + (i % 3) * 0.15);
      const x = cx + Math.cos(an) * rr; const y = cy + Math.sin(an) * rr;
      const top = P(x, y, -depth - r * 0.25); const tp = P(x + 0.2, y + 0.2, -depth - r * (0.55 + (i % 2) * 0.2));
      this.poly([[top[0] - this.cam.A * 0.9, top[1]], [top[0] + this.cam.A * 0.9, top[1]], tp], pal.rockC, 'rgba(20,12,6,.3)');
    }
    // sides of the island that face the viewer: edges 0, 1 and 5
    for (const i of [5, 0, 1]) {
      const [x0, y0] = corners[i]; const [x1, y1] = corners[(i + 1) % 6];
      const tone = i === 1 ? 0 : i === 0 ? -0.08 : -0.18;
      this.poly([P(x0, y0, 0), P(x1, y1, 0), P(x1, y1, -depth), P(x0, y0, -depth)], shade(pal.rockA, tone), 'rgba(20,12,6,.35)');
      this.poly([P(x0, y0, 0), P(x1, y1, 0), P(x1, y1, -0.42), P(x0, y0, -0.42)], shade(pal.soil, tone));
      // strata
      ctx.strokeStyle = 'rgba(20,12,6,.18)'; ctx.lineWidth = Math.max(1, this.cam.A * 0.04);
      for (const zz of [-0.95, -1.5]) {
        if (-zz > depth) continue;
        const a = P(x0, y0, zz); const b = P(x1, y1, zz + 0.12);
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      }
      // grass lip
      this.poly([P(x0, y0, 0), P(x1, y1, 0), P(x1, y1, -0.14), P(x0, y0, -0.14)], pal.lip);
    }
    // top: honeycomb meadow tiles, clipped to the hexagon
    const d = this.dpr; const A = this.cam.A;
    const o = this.P(cx, cy, rise);
    ctx.setTransform(d * A, d * A / 2, -d * A, d * A / 2, d * o[0], d * o[1]);
    ctx.save();
    ctx.beginPath();
    hexCorners(0, 0, r).forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath(); ctx.clip();
    ctx.fillStyle = pal.grassA; ctx.fill(this.grassTiles.fill[0]);
    ctx.fillStyle = pal.grassB; ctx.fill(this.grassTiles.fill[1]);
    ctx.fillStyle = pal.grassC; ctx.fill(this.grassTiles.fill[2]);
    ctx.strokeStyle = alpha(pal.grout, 0.75); ctx.lineWidth = 0.05; ctx.stroke(this.grassTiles.grout);
    // stone paths: home plaza to every bridge, friend tower to its bridge
    ctx.lineCap = 'round';
    const paths = [];
    if (is.home) { for (const m of this.machines.values()) paths.push([[PLAZA.x - cx, PLAZA.y - cy], [m.bridge.a.x - cx, m.bridge.a.y - cy]]); paths.push([[PLAZA.x - cx, PLAZA.y - cy], [ENTRANCE.x - cx, ENTRANCE.y - cy]]); }
    else { paths.push([[0, 0], [is.m.bridge.b.x - cx, is.m.bridge.b.y - cy]]); paths.push([[0, 0], [3.7, 3.7]]); }
    for (const [w, col] of [[1.55, pal.pathEdge], [1.25, pal.path]]) {
      ctx.strokeStyle = col; ctx.lineWidth = w;
      for (const [p0, p1] of paths) { ctx.beginPath(); ctx.moveTo(p0[0], p0[1]); ctx.lineTo(p1[0], p1[1]); ctx.stroke(); }
    }
    if (is.home) {
      // the plaza: a honey hexagon
      ctx.fillStyle = pal.pathEdge; ctx.beginPath(); hexPath(ctx, PLAZA.x - cx, PLAZA.y - cy + 0.4, 2.6); ctx.fill();
      ctx.fillStyle = pal.path; ctx.beginPath(); hexPath(ctx, PLAZA.x - cx, PLAZA.y - cy + 0.4, 2.35); ctx.fill();
      ctx.strokeStyle = alpha('#E8A93A', 0.45); ctx.lineWidth = 0.06; ctx.beginPath(); hexPath(ctx, PLAZA.x - cx, PLAZA.y - cy + 0.4, 1.4); ctx.stroke();
    } else {
      ctx.fillStyle = pal.pathEdge; ctx.beginPath(); hexPath(ctx, 0, 0, 3.6); ctx.fill();
      ctx.fillStyle = pal.path; ctx.beginPath(); hexPath(ctx, 0, 0, 3.35); ctx.fill();
    }
    ctx.lineCap = 'butt';
    ctx.restore();
    this.base();
    ctx.globalAlpha = 1;
  }

  /** Plinth, floors, corridor and the two tall back walls of your building. */
  drawBuildingGround(pal) {
    if (!this.visible(-1, -1, 17, 11, WALL + 3, -1)) return;
    const ctx = this.ctx;
    const P = (x, y, z) => this.P(x, y, z);
    const { x0, x1, y0, y1 } = BUILDING;
    const pz = 0.3;
    // plinth
    this.poly([P(x0 - 0.3, y1 + 0.3, 0), P(x1 + 0.3, y1 + 0.3, 0), P(x1 + 0.3, y1 + 0.3, pz), P(x0 - 0.3, y1 + 0.3, pz)], pal.plinthL, 'rgba(36,22,12,.35)');
    this.poly([P(x1 + 0.3, y0 - 0.3, 0), P(x1 + 0.3, y1 + 0.3, 0), P(x1 + 0.3, y1 + 0.3, pz), P(x1 + 0.3, y0 - 0.3, pz)], pal.plinthR, 'rgba(36,22,12,.35)');
    this.poly([P(x0 - 0.3, y0 - 0.3, pz), P(x1 + 0.3, y0 - 0.3, pz), P(x1 + 0.3, y1 + 0.3, pz), P(x0 - 0.3, y1 + 0.3, pz)], pal.plinthTop, 'rgba(36,22,12,.35)');
    // entrance steps
    for (let i = 0; i < 2; i++) this.box(ENTRANCE.x - 1.1 + i * 0.15, y1 + 0.3 + (1 - i) * 0.35, 0, 2.2 - i * 0.3, 0.35, pz * (i + 1) / 2, pal.plinthTop, pal.plinthL, pal.plinthR);
    // floors per room, tinted by the room color
    const d = this.dpr; const A = this.cam.A;
    for (const [k, r] of Object.entries(ROOMS)) {
      const o = this.P(0, 0, pz);
      ctx.setTransform(d * A, d * A / 2, -d * A, d * A / 2, d * o[0], d * o[1]);
      ctx.save();
      ctx.beginPath(); ctx.rect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0); ctx.clip();
      const tint = (c) => mixHex(c, ROOM_COLOR[k], 0.13);
      ctx.fillStyle = tint(pal.floorA); ctx.fill(this.floorTiles.fill[0]);
      ctx.fillStyle = tint(pal.floorB); ctx.fill(this.floorTiles.fill[1]);
      ctx.fillStyle = tint(pal.floorC); ctx.fill(this.floorTiles.fill[2]);
      ctx.strokeStyle = pal.grout2; ctx.lineWidth = 0.03; ctx.stroke(this.floorTiles.grout);
      // a rug in the room color
      ctx.fillStyle = alpha(ROOM_COLOR[k], this.highlightRoom(k) ? 0.34 : 0.14);
      ctx.beginPath(); hexPath(ctx, (r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2 + 0.25, Math.min(r.x1 - r.x0, r.y1 - r.y0) * 0.36); ctx.fill();
      ctx.strokeStyle = alpha(ROOM_COLOR[k], 0.45); ctx.lineWidth = 0.035; ctx.setLineDash([0.1, 0.08]); ctx.stroke(); ctx.setLineDash([]);
      if (this.highlightRoom(k)) { ctx.strokeStyle = alpha('#FFD072', 0.9); ctx.lineWidth = 0.08; ctx.strokeRect(r.x0 + 0.08, r.y0 + 0.08, r.x1 - r.x0 - 0.16, r.y1 - r.y0 - 0.16); }
      ctx.restore();
    }
    // corridor runner
    const o = this.P(0, 0, pz);
    ctx.setTransform(d * A, d * A / 2, -d * A, d * A / 2, d * o[0], d * o[1]);
    ctx.fillStyle = pal.corridor; ctx.fillRect(0, 4.6, 16, 0.8);
    ctx.fillStyle = alpha('#E8A93A', 0.5); ctx.fillRect(0.3, 4.92, 15.4, 0.16);
    this.base();
    // the two tall back walls with windows, wallpaper in each room color, signs and boards
    this.drawBackWalls(pal);
  }

  drawBackWalls(pal) {
    const ctx = this.ctx;
    const P = (x, y, z) => this.P(x, y, z);
    const zb = 0.3; const zt = WALL + 0.3;
    // left wall x = 0 (Design and Library), right wall y = 0 (the four pipeline rooms)
    this.poly([P(0, 0, zb), P(0, 10, zb), P(0, 10, zt), P(0, 0, zt)], pal.wallL);
    this.poly([P(0, 0, zb), P(16, 0, zb), P(16, 0, zt), P(0, 0, zt)], pal.wallR);
    for (const side of ['L', 'R']) {
      const len = side === 'L' ? 10 : 16;
      if (side === 'L') this.wallLT(0, 10, zt); else this.wallRT(0, zt);
      ctx.save();
      ctx.beginPath(); ctx.rect(0, 0, len, WALL - 0.65); ctx.clip();
      // wallpaper tinted per room
      for (const [k, r] of Object.entries(ROOMS)) {
        let u0; let u1;
        if (side === 'R') { if (r.row !== 'back') continue; u0 = r.x0; u1 = r.x1; } else { if (r.x0 !== 0) continue; u0 = 10 - r.y1; u1 = 10 - r.y0; }
        ctx.fillStyle = alpha(ROOM_COLOR[k], 0.1); ctx.fillRect(u0, 0, u1 - u0, WALL);
      }
      ctx.strokeStyle = alpha(pal.comb, 0.55); ctx.lineWidth = 0.012; ctx.stroke(this.comb);
      ctx.restore();
      ctx.fillStyle = side === 'L' ? mixHex(pal.trim, '#ffffff', 0.35) : mixHex(pal.trim, '#ffffff', 0.25);
      ctx.fillRect(0, WALL - 0.65, len, 0.65);
      ctx.fillStyle = pal.trim; ctx.fillRect(0, WALL - 0.69, len, 0.05); ctx.fillRect(0, WALL - 0.08, len, 0.08);
      ctx.strokeStyle = 'rgba(36,22,12,.12)'; ctx.lineWidth = 0.02; ctx.beginPath();
      for (let u = 0.5; u < len; u += 0.5) { ctx.moveTo(u, WALL - 0.63); ctx.lineTo(u, WALL - 0.08); }
      ctx.stroke();
      // the corridor gap on the left wall
      if (side === 'L') { ctx.fillStyle = 'rgba(36,22,12,.22)'; ctx.fillRect(10 - 5.4, 0, 0.8, WALL); }
      const g = ctx.createLinearGradient(side === 'L' ? len : 0, 0, side === 'L' ? len - 3 : 3, 0);
      g.addColorStop(0, 'rgba(36,22,12,.2)'); g.addColorStop(1, 'rgba(36,22,12,0)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, len, WALL);
    }
    this.base();
    // windows: one per back room, the sky outside follows the clock
    const night = this.pal.night;
    const top = mixHex(mixHex('#78B9E6', '#0B1430', night), '#4A3F7E', this.pal.gold * 0.7);
    const bot = mixHex(mixHex('#D6EEF8', '#1E2B4E', night), '#F5A766', this.pal.gold * 0.85);
    const win = (u0, u1, side) => {
      if (side === 'L') this.wallLT(0, 10, zt); else this.wallRT(0, zt);
      const t0 = 0.28; const t1 = 1.08;
      const g = ctx.createLinearGradient(0, t0, 0, t1); g.addColorStop(0, top); g.addColorStop(1, bot);
      ctx.fillStyle = g; ctx.fillRect(u0, t0, u1 - u0, t1 - t0);
      if (night > 0.5) { ctx.fillStyle = 'rgba(255,248,220,.8)'; for (let i = 0; i < 4; i++) ctx.fillRect(u0 + 0.1 + ((i * 37) % 9) / 10 * (u1 - u0 - 0.2), t0 + 0.1 + ((i * 23) % 5) / 12, 0.025, 0.025); }
      ctx.strokeStyle = shade(this.pal.trim, 0.1); ctx.lineWidth = 0.06; ctx.strokeRect(u0, t0, u1 - u0, t1 - t0);
      ctx.lineWidth = 0.035; ctx.beginPath(); ctx.moveTo((u0 + u1) / 2, t0); ctx.lineTo((u0 + u1) / 2, t1); ctx.stroke();
      ctx.fillStyle = shade(this.pal.trim, 0.2); ctx.fillRect(u0 - 0.06, t1, u1 - u0 + 0.12, 0.06);
    };
    for (const k of ['design', 'code', 'review', 'test']) { const r = ROOMS[k]; win(r.x1 - 1.6, r.x1 - 0.45, 'R'); }
    win(10 - 3.4, 10 - 1.9, 'L');
    win(10 - 9.1, 10 - 7.6, 'L');
    this.base();
    // wall caps
    const T = 0.16;
    this.poly([P(0, 0, zt), P(0, 10, zt), P(-T, 10, zt), P(-T, -T, zt), P(16, -T, zt), P(16, 0, zt)], shade(pal.trim, 0.25), 'rgba(36,22,12,.5)');
    this.poly([P(-T, 10, zb), P(0, 10, zb), P(0, 10, zt), P(-T, 10, zt)], shade(pal.trim, -0.1), 'rgba(36,22,12,.5)');
    this.poly([P(16, -T, zb), P(16, 0, zb), P(16, 0, zt), P(16, -T, zt)], shade(pal.trim, -0.25), 'rgba(36,22,12,.5)');
    // room plaques on the back walls
    for (const k of ['design', 'code', 'review', 'test']) { const r = ROOMS[k]; this.plaque(k, 'R', r.x0 + 1.2, pal); }
    this.plaque('library', 'L', 10 - 9.4 + 0.9, pal);
    // room boards on the walls
    for (const k of ['design', 'code', 'review', 'test', 'library']) this.drawBoard(k, pal);
    // wall decor per room (drawn flat on the walls)
    this.wallDecor(pal);
  }

  plaque(k, side, u, pal) {
    if (this.cam.A < 44) return;
    const ctx = this.ctx;
    const zt = WALL + 0.3;
    if (side === 'L') this.wallLT(0, 10, zt, 100); else this.wallRT(0, zt, 100);
    const name = this.t(`city.room.${k}`).toUpperCase();
    ctx.font = `800 15px ${FONT}`;
    const tw = ctx.measureText(name).width;
    const x = u * 100; const y = 14;
    ctx.fillStyle = 'rgba(36,22,12,.25)'; roundRect(ctx, x - 10 + 2, y + 3, tw + 34, 26, 6); ctx.fill();
    ctx.fillStyle = mixHex('#3A2A1C', NIGHT_TINT, pal.night * 0.3); roundRect(ctx, x - 10, y, tw + 34, 26, 6); ctx.fill();
    ctx.fillStyle = ROOM_COLOR[k]; ctx.beginPath(); hexScreen(ctx, x + 2, y + 13, 6); ctx.fill();
    ctx.fillStyle = '#F7EAD3'; ctx.fillText(name, x + 14, y + 18.5);
    this.base();
  }

  wallDecor(pal) {
    const ctx = this.ctx;
    const zt = WALL + 0.3;
    this.wallRT(0, zt);
    // Design: color swatches
    ['#FF7AB6', '#6CC4FF', '#FFD072', '#7DC49B', '#C9A0E8'].forEach((c, i) => { ctx.fillStyle = c; ctx.fillRect(2.25 + i * 0.13, 0.62, 0.1, 0.32); });
    // Review: a wall screen with a diff
    ctx.fillStyle = '#1D2230'; ctx.fillRect(10.1, 0.25, 0.0, 0);
    // Test: a status light
    const ok = (Math.floor(this.now * 0.5) % 4) !== 3;
    ctx.fillStyle = '#2A2420'; ctx.fillRect(14.1, 0.5, 0.22, 0.5);
    ctx.fillStyle = ok ? '#5DB27E' : '#3C6B4E'; ctx.beginPath(); ctx.arc(14.21, 0.62, 0.06, 0, 6.28); ctx.fill();
    ctx.fillStyle = ok ? '#4A3A2B' : '#E8B45C'; ctx.beginPath(); ctx.arc(14.21, 0.8, 0.06, 0, 6.28); ctx.fill();
    ctx.fillStyle = '#4A3A2B'; ctx.beginPath(); ctx.arc(14.21, 0.96, 0.05, 0, 6.28); ctx.fill();
    this.base();
    void pal;
  }

  /** A task board with its notes, on a wall or standing. */
  drawBoard(room, pal) {
    const bd = this.boardOf(room);
    if (!bd || this.cam.A < 9) return;
    const ctx = this.ctx;
    let u0; let u1;
    if (bd.kind === 'wallR') { this.wallRT(0, bd.z1 + 0.3 - 0.3); u0 = bd.x0; u1 = bd.x1; }
    else if (bd.kind === 'wallL') { this.wallLT(0, 10, bd.z1); u0 = 10 - bd.y1; u1 = 10 - bd.y0; }
    else { this.wallRT(bd.y, bd.z1); u0 = bd.x0; u1 = bd.x1; }
    const hgt = bd.z1 - bd.z0;
    ctx.fillStyle = 'rgba(36,22,12,.25)'; ctx.fillRect(u0 + 0.05, 0.06, u1 - u0, hgt);
    ctx.fillStyle = pal.trim; ctx.fillRect(u0 - 0.06, -0.06, u1 - u0 + 0.12, hgt + 0.12);
    ctx.fillStyle = mixHex('#FBF6EA', NIGHT_TINT, pal.night * 0.35); ctx.fillRect(u0, 0, u1 - u0, hgt);
    ctx.fillStyle = bd.color; ctx.fillRect(u0, 0, u1 - u0, 0.07);
    // notes
    const list = [...this.notes.values()].filter((n) => n.room === room && !n.gone && !n.hidden && !(n.fly && this.now - n.fly.t0 < 0.9));
    for (const n of list) {
      const col = n.slot % bd.cols; const row = Math.floor(n.slot / bd.cols);
      const w = (u1 - u0) / bd.cols;
      const x = bd.kind === 'wallL' ? u1 - (col + 1) * w : u0 + col * w;
      const y = 0.16 + row * 0.34;
      const pop = this.reduced() ? 1 : easeOutBack(clamp((this.now - Math.max(n.born, n.fly ? n.fly.t0 + 0.9 : -99)) / 0.35));
      const t = n.t;
      const color = t.status === 'blocked' ? '#F6B3A8' : t.status === 'done' ? '#C6E8CD' : ['in_progress', 'in_review', 'in_test', 'claimed'].includes(t.status) ? '#FFD488' : '#FFEB9C';
      ctx.save();
      ctx.translate(x + w / 2, y + 0.14);
      ctx.scale(pop, pop);
      ctx.rotate(((hash(n.id) % 7) - 3) * 0.015);
      ctx.fillStyle = 'rgba(36,22,12,.18)'; ctx.fillRect(-w / 2 + 0.07, -0.12, w - 0.1, 0.27);
      ctx.fillStyle = color; ctx.fillRect(-w / 2 + 0.05, -0.14, w - 0.1, 0.27);
      const a = t.assignee && this.actors.get(t.assignee);
      ctx.fillStyle = a?.ag.color || '#FFB531'; ctx.fillRect(-w / 2 + 0.05, -0.14, 0.04, 0.27);
      if (this.dragTask === n.id || this.highlight?.id === n.id) { ctx.strokeStyle = '#E8951E'; ctx.lineWidth = 0.03; ctx.strokeRect(-w / 2 + 0.03, -0.16, w - 0.06, 0.31); }
      if (this.cam.A > 34) {
        ctx.scale(0.01, 0.01);
        ctx.fillStyle = '#2B1D12';
        ctx.font = `650 ${this.cam.A > 80 ? 9.5 : 11}px ${FONT}`;
        const line = wrap(ctx, t.title || '', (w - 0.24) * 100, 1)[0] || '';
        ctx.fillText(line, (-w / 2 + 0.13) * 100, 0.04 * 100);
        if (t.status === 'done') { ctx.fillStyle = '#3F8A5E'; ctx.font = `800 11px ${FONT}`; ctx.fillText('✓', (w / 2 - 0.2) * 100, 0.04 * 100); }
      } else {
        ctx.fillStyle = 'rgba(43,29,18,.4)'; ctx.fillRect(-w / 2 + 0.14, -0.06, w * 0.5, 0.04); ctx.fillRect(-w / 2 + 0.14, 0.02, w * 0.32, 0.04);
      }
      ctx.restore();
    }
    const more = (this.boardCounts?.get(room)?.length || 0) - bd.cols * 3;
    if (more > 0 && this.cam.A > 24) {
      ctx.save(); ctx.scale(0.01, 0.01);
      ctx.fillStyle = 'rgba(43,29,18,.6)'; ctx.font = `700 10px ${FONT}`;
      ctx.fillText(`+${more}`, (u1 - 0.3) * 100, (hgt - 0.06) * 100);
      ctx.restore();
    }
    this.base();
  }

  drawBoardItem(room, pal) {
    const bd = this.boardOf(room);
    if (!bd) return;
    // legs of a standing board
    const ctx = this.ctx;
    for (const x of [bd.x0 + 0.12, bd.x1 - 0.12]) {
      const a = this.P(x, bd.y + 0.02, 0.3 * (room.startsWith('m:') ? 0 : 1)); const b = this.P(x, bd.y + 0.02, bd.z0 + 0.05);
      ctx.strokeStyle = pal.trim; ctx.lineWidth = Math.max(1.5, this.cam.A * 0.06);
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    }
    this.drawBoard(room, pal);
  }

  /** Every piece of your building that needs depth sorting: partitions, furniture, the gate. */
  buildingItems(list, pal) {
    if (!this.visible(-1, -1, 17, 11, WALL + 3, -1)) return;
    const pz = 0.3;
    // low partitions with door gaps, split into short pieces so bees sort well against them
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
    along(4.6, 0, 16, ['design', 'code', 'review', 'test'].map((k) => gap(ROOMS[k].x0 + 2)));
    along(5.4, 0, 16, [gap(2), gap(6.4), gap(14)]);
    for (const x of [4, 8, 12]) across(x, 0, 4.6);
    for (const x of [4, 12]) across(x, 5.4, 10);
    // the front parapet and the right side, with the entrance gap
    along(10, 0, 16, [[6.9, 9.1]]);
    across(16, 0, 4.6); across(16, 5.4, 10);
    for (const wpc of walls) {
      const hgt = wpc.kind === 'x' && (wpc.y === 10) ? 0.26 : wpc.kind === 'y' && wpc.x === 16 ? 0.26 : PART;
      if (wpc.kind === 'x') list.push({ k: (wpc.x0 + wpc.x1) / 2 + wpc.y + 0.08, f: () => this.box(wpc.x0, wpc.y - 0.05, pz, wpc.x1 - wpc.x0, 0.1, hgt, pal.part, pal.partL, pal.partR, 'rgba(36,22,12,.22)') });
      else list.push({ k: wpc.x + (wpc.y0 + wpc.y1) / 2 + 0.08, f: () => this.box(wpc.x - 0.05, wpc.y0, pz, 0.1, wpc.y1 - wpc.y0, hgt, pal.part, pal.partL, pal.partR, 'rgba(36,22,12,.22)') });
    }
    // desks and chairs at the seats
    for (const k of Object.keys(ROOMS)) {
      for (let i = 0; i < 4; i++) {
        const s = spotFor(k, i);
        if (!s.desk) continue;
        list.push({ k: s.x + s.y + 0.55, f: () => this.drawDesk(k, s, pal) });
        list.push({ k: s.x + s.y - 0.3, f: () => this.drawChair(k, s, pal) });
      }
    }
    // room props
    const add = (x, y, f) => list.push({ k: x + y, f });
    // Design: an easel and a plant
    add(3.3, 1.2, () => this.drawEasel(3.3, 1.2, pal));
    add(0.6, 4.0, () => this.drawPlant(0.6, 4.0, 0.8, pz));
    // Code: a coffee bar and a small server
    add(7.55, 0.55, () => { this.box(6.9, 0.25, pz, 1.0, 0.55, 0.62, pal.deskTop, pal.deskL, pal.deskR); this.cyl(7.15, 0.5, pz + 0.62, 0.12, 0.26, '#5A4836', '#3B2414'); this.cyl(7.6, 0.55, pz + 0.62, 0.07, 0.12, '#F2E9DA', '#3B2414'); });
    // Review: a sofa and a tall wall screen
    add(10, 0.5, () => this.drawScreen(8.7, 11.3, pal));
    add(11.4, 3.95, () => this.drawPlant(11.5, 4.0, 0.7, pz));
    // Test: a lab bench with flasks
    add(14, 0.6, () => { this.box(12.3, 0.25, pz, 3.3, 0.6, 0.58, pal.deskTop, pal.deskL, pal.deskR); ['#7DC49B', '#FFB531', '#86A9D6', '#FF7AB6', '#7DC49B'].forEach((c, i) => this.cyl(12.6 + i * 0.32, 0.55, pz + 0.58, 0.06, 0.3 + (i % 2) * 0.08, alpha(c, 0.85), '#F2E9DA')); });
    // Library: shelves along the left wall, an armchair, memory jars
    add(0.3, 6.8, () => this.drawShelves(0.05, 5.6, 1.5, pal));
    add(0.3, 9.1, () => this.drawShelves(0.05, 8.2, 1.6, pal));
    add(2.0, 8.2, () => this.drawArmchair(2.0, 7.95, pal));
    // Lobby: Mel's desk, benches, the honey fountain, plants
    add(8, 7.6, () => this.drawReception(8, 7.6, pal));
    add(8, 9.0, () => this.drawFountain(8.0, 8.95, pal));
    add(4.6, 9.5, () => this.drawPlant(4.6, 9.5, 0.9, pz));
    add(11.4, 9.5, () => this.drawPlant(11.4, 9.5, 0.9, pz));
    add(5.6, 6.15, () => this.drawBench(5.0, 6.0, pal));
    add(10.45, 5.95, () => this.drawBoardItem('lobby', pal));
    // Ops: server racks and a little rocket
    add(15.4, 6.0, () => this.drawRack(15.15, 5.7, pal));
    add(15.4, 7.1, () => this.drawRack(15.15, 6.8, pal));
    add(13.1, 6.0, () => this.drawBoardItem('ops', pal));
    add(12.8, 9.3, () => this.drawRocket(12.8, 9.3, pal));
    // the entrance gate over the Lobby
    add(9.2, 10.05, () => this.drawGate(pal));
  }

  highlightRoom(k) { return (this.highlight?.kind === 'room' && this.highlight.id === k) || (this.dropTarget?.kind === 'room' && this.dropTarget.id === k); }

  drawDesk(room, s, pal) {
    const ctx = this.ctx;
    const pz = 0.3;
    const x = s.x - DW / 2; const y = s.y + 0.18;
    this.box(x + 0.05, y + 0.06, pz, 0.08, DD - 0.12, DH - 0.06, pal.panel, shade(pal.panel, -0.1), shade(pal.panel, -0.2));
    this.box(x + DW - 0.13, y + 0.06, pz, 0.08, DD - 0.12, DH - 0.06, pal.panel, shade(pal.panel, -0.1), shade(pal.panel, -0.2));
    this.box(x + 0.13, y + DD - 0.12, pz + 0.12, DW - 0.26, 0.05, DH - 0.2, pal.panel, shade(pal.panel, -0.18), shade(pal.panel, -0.25));
    this.box(x, y, pz + DH - 0.06, DW, DD, 0.07, pal.deskTop, pal.deskL, pal.deskR);
    const z = pz + DH + 0.01;
    const col = ROOM_COLOR[room];
    const sitter = [...this.actors.values()].find((a) => !a.path.length && a.place.kind === 'room' && a.place.room === room && Math.abs(a.pos.x - s.x) < 0.2 && Math.abs(a.pos.y - s.y) < 0.2);
    const active = sitter && ['working', 'thinking', 'reviewing', 'testing'].includes(sitter.mode);
    // laptop facing the bee (the bee sits behind the desk)
    const lx = s.x - 0.35; const ly = y + 0.22;
    this.box(lx, ly, z, 0.7, 0.42, 0.035, '#D8D2C6', '#B9B2A5', '#A39C90');
    this.box(lx, ly - 0.02, z + 0.035, 0.7, 0.04, 0.42, '#C9C2B6', '#CFC8BC', '#9F988C');
    const lc = this.P(lx + 0.35, ly + 0.02, z + 0.25);
    ctx.save();
    ctx.beginPath(); hexScreen(ctx, lc[0], lc[1], this.cam.A * 0.09);
    ctx.fillStyle = active ? (sitter.ag.color || col) : shade(col, -0.4);
    if (active) { ctx.shadowColor = sitter.ag.color; ctx.shadowBlur = 8; }
    ctx.fill();
    ctx.restore();
    // a lamp at the corner
    const lpx = x + 0.18; const lpy = y + 0.2;
    this.cyl(lpx, lpy, z, 0.06, 0.03, '#4A3A2B', '#5A4836');
    const s0 = this.P(lpx, lpy, z + 0.03); const s1 = this.P(lpx, lpy, z + 0.48);
    ctx.strokeStyle = '#4A3A2B'; ctx.lineWidth = Math.max(1, this.cam.A * 0.03); ctx.beginPath(); ctx.moveTo(s0[0], s0[1]); ctx.lineTo(s1[0], s1[1]); ctx.stroke();
    const sw = this.cam.A * 0.17;
    ctx.fillStyle = this.pal.night > 0.3 ? '#FFE3A1' : '#F0B54A';
    ctx.beginPath(); ctx.moveTo(s1[0] - sw * 0.45, s1[1] - this.cam.A * 0.1); ctx.lineTo(s1[0] + sw * 0.45, s1[1] - this.cam.A * 0.1); ctx.lineTo(s1[0] + sw, s1[1] + this.cam.A * 0.035); ctx.lineTo(s1[0] - sw, s1[1] + this.cam.A * 0.035); ctx.closePath(); ctx.fill();
    (this.lamps ||= []).push([s1[0], s1[1] + this.cam.A * 0.04]);
    // a room prop on the desk
    const px = x + DW - 0.3; const py = y + DD - 0.25;
    if (room === 'design') ['#FF7AB6', '#6CC4FF', '#FFD072'].forEach((c, i) => { const p = this.P(px - 0.25 + i * 0.1, py, z + 0.01); ctx.fillStyle = c; ctx.beginPath(); ctx.ellipse(p[0], p[1], this.cam.A * 0.04, this.cam.A * 0.022, 0, 0, 6.28); ctx.fill(); });
    else if (room === 'test') this.cyl(px, py - 0.05, z, 0.05, 0.24, alpha('#7DC49B', 0.85), '#F2E9DA');
    else if (room === 'review') { const p = this.P(px - 0.1, py, z + 0.08); ctx.strokeStyle = '#4A3A2B'; ctx.lineWidth = Math.max(1, this.cam.A * 0.025); ctx.beginPath(); ctx.arc(p[0], p[1], this.cam.A * 0.07, 0, 6.28); ctx.stroke(); }
    else this.cyl(px, py, z, 0.08, 0.15, '#F2E9DA', '#3B2414');
  }

  drawChair(room, s, pal) {
    const x = s.x - 0.25; const y = s.y - 0.3; const pz = 0.3;
    const c = ROOM_COLOR[room];
    this.cyl(x + 0.25, y + 0.22, pz + 0.02, 0.05, 0.36, '#3A2F25', '#3A2F25');
    this.box(x, y - 0.03, pz + 0.38, 0.5, 0.5, 0.08, shade(c, -0.2), shade(c, -0.4), shade(c, -0.5));
    this.box(x, y - 0.08, pz + 0.46, 0.5, 0.07, 0.56, shade(c, -0.25), shade(c, -0.35), shade(c, -0.5));
    void pal;
  }

  drawEasel(x, y, pal) {
    const ctx = this.ctx; const pz = 0.3;
    const a = this.P(x - 0.3, y + 0.15, pz); const b = this.P(x, y, pz + 1.5); const c = this.P(x + 0.3, y - 0.15, pz);
    ctx.strokeStyle = pal.trim; ctx.lineWidth = Math.max(1.4, this.cam.A * 0.05);
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.lineTo(c[0], c[1]); ctx.stroke();
    this.poly([this.P(x - 0.45, y + 0.12, pz + 0.55), this.P(x + 0.45, y + 0.12, pz + 0.55), this.P(x + 0.45, y + 0.12, pz + 1.3), this.P(x - 0.45, y + 0.12, pz + 1.3)], '#FFFDF6', 'rgba(36,22,12,.4)');
    const m = this.P(x, y + 0.12, pz + 0.92);
    ctx.fillStyle = '#FF7AB6'; ctx.beginPath(); ctx.arc(m[0] - this.cam.A * 0.1, m[1] - this.cam.A * 0.05, this.cam.A * 0.12, 0, 6.28); ctx.fill();
    ctx.fillStyle = '#6CC4FF'; ctx.fillRect(m[0], m[1] - this.cam.A * 0.02, this.cam.A * 0.2, this.cam.A * 0.14);
  }

  drawScreen(u0, u1, pal) {
    // a big screen on the Review wall with a diff that scrolls
    const ctx = this.ctx;
    this.wallRT(0.02, WALL + 0.3);
    const t0 = 0.35; const t1 = 1.25;
    ctx.fillStyle = '#2A2420'; ctx.fillRect(u0 + 0.85, t0 - 0.05, u1 - u0 - 1.65, t1 - t0 + 0.1);
    ctx.fillStyle = '#171B26'; ctx.fillRect(u0 + 0.9, t0, u1 - u0 - 1.75, t1 - t0);
    const off = this.reduced() ? 0 : Math.floor(this.now * 1.5);
    for (let i = 0; i < 8; i++) {
      const k = (i + off) % 11;
      const add = k % 4 === 1; const del = k % 5 === 3;
      ctx.fillStyle = add ? 'rgba(93,178,126,.85)' : del ? 'rgba(229,123,110,.85)' : 'rgba(200,190,170,.4)';
      ctx.fillRect(u0 + 1.0, t0 + 0.07 + i * 0.1, 0.25 + ((k * 7) % 5) * 0.12, 0.05);
    }
    this.base();
    void pal;
  }

  drawShelves(x, y, len, pal) {
    const ctx = this.ctx; const pz = 0.3;
    this.box(x, y, pz, 0.45, len, 1.6, pal.deskTop, pal.panel, shade(pal.panel, -0.2));
    const colors = ['#E57B6E', '#86A9D6', '#FFD072', '#7DC49B', '#C9A0E8', '#F2E9DA'];
    for (let row = 0; row < 3; row++) {
      const zz = pz + 0.12 + row * 0.5;
      for (let i = 0; i < Math.floor(len / 0.22) - 1; i++) {
        const yy = y + 0.1 + i * 0.22;
        const glow = (i + row) % 4 === 1;
        if (glow) {
          // a glowing memory jar
          const p = this.P(x + 0.45, yy + 0.08, zz + 0.14);
          ctx.fillStyle = '#FFB531'; ctx.globalAlpha = 0.9;
          roundRect(ctx, p[0] - this.cam.A * 0.07, p[1] - this.cam.A * 0.12, this.cam.A * 0.14, this.cam.A * 0.2, this.cam.A * 0.04); ctx.fill();
          ctx.globalAlpha = 1;
          (this.jarLights ||= []).push(p);
        } else this.poly([this.P(x + 0.45, yy, zz), this.P(x + 0.45, yy + 0.16, zz), this.P(x + 0.45, yy + 0.16, zz + 0.3 + ((i + row) % 3) * 0.05), this.P(x + 0.45, yy, zz + 0.3 + ((i + row) % 3) * 0.05)], colors[(i * 2 + row) % colors.length], 'rgba(36,22,12,.3)');
      }
    }
  }

  drawArmchair(x, y, pal) {
    const pz = 0.3; const c = '#B5654A';
    this.box(x - 0.45, y - 0.35, pz, 0.9, 0.75, 0.32, shade(c, 0.1), shade(c, -0.15), shade(c, -0.3));
    this.box(x - 0.45, y - 0.42, pz + 0.32, 0.9, 0.16, 0.55, shade(c, 0.05), shade(c, -0.2), shade(c, -0.35));
    this.box(x - 0.55, y - 0.35, pz + 0.2, 0.12, 0.75, 0.35, shade(c, 0), shade(c, -0.2), shade(c, -0.35));
    this.box(x + 0.45, y - 0.35, pz + 0.2, 0.12, 0.75, 0.35, shade(c, 0), shade(c, -0.2), shade(c, -0.35));
    void pal;
  }

  drawReception(x, y, pal) {
    // a hexagonal desk for Mel
    const ctx = this.ctx; const pz = 0.3; const r = 0.7; const hgt = 0.62;
    const ring = [];
    for (let i = 0; i < 6; i++) { const an = (Math.PI / 3) * i + Math.PI / 6; ring.push([x + r * Math.cos(an), y + r * Math.sin(an)]); }
    for (let i = 0; i < 6; i++) {
      const p = ring[i]; const q = ring[(i + 1) % 6];
      const nx = (p[0] + q[0]) / 2 - x; const ny = (p[1] + q[1]) / 2 - y;
      if (nx + ny <= 0.01) continue;
      this.poly([this.P(p[0], p[1], pz), this.P(q[0], q[1], pz), this.P(q[0], q[1], pz + hgt), this.P(p[0], p[1], pz + hgt)], nx > ny ? pal.deskR : pal.deskL, 'rgba(36,22,12,.35)');
    }
    this.poly(ring.map((p) => this.P(p[0], p[1], pz + hgt)), pal.deskTop, 'rgba(36,22,12,.35)');
    const c = this.P(x, y, pz + hgt);
    ctx.fillStyle = '#E8951E'; ctx.beginPath(); ctx.ellipse(c[0], c[1], this.cam.A * 0.32, this.cam.A * 0.16, 0, 0, 6.28); ctx.fill();
    ctx.fillStyle = '#FFD072'; ctx.beginPath(); hexScreen(ctx, c[0], c[1] - this.cam.A * 0.02, this.cam.A * 0.1); ctx.fill();
  }

  drawFountain(x, y, pal) {
    const ctx = this.ctx; const pz = 0.3;
    this.cyl(x, y, pz, 0.62, 0.26, pal.plinthL, pal.plinthTop);
    const t = this.P(x, y, pz + 0.26);
    ctx.fillStyle = '#F3A42A'; ctx.beginPath(); ctx.ellipse(t[0], t[1], this.cam.A * 0.72, this.cam.A * 0.36, 0, 0, 6.28); ctx.fill();
    ctx.fillStyle = 'rgba(255,240,190,.5)';
    const w = this.reduced() ? 0 : this.now;
    for (let i = 0; i < 3; i++) { const ph = ((w * 0.6 + i / 3) % 1); ctx.globalAlpha = 1 - ph; ctx.strokeStyle = '#FFE7A8'; ctx.lineWidth = 1; ctx.beginPath(); ctx.ellipse(t[0], t[1], this.cam.A * 0.7 * ph, this.cam.A * 0.35 * ph, 0, 0, 6.28); ctx.stroke(); }
    ctx.globalAlpha = 1;
    this.cyl(x, y, pz + 0.26, 0.1, 0.45, pal.plinthL, pal.plinthTop);
    const s = this.P(x, y, pz + 0.75);
    if (!this.reduced()) for (let i = 0; i < 2; i++) { const ph = ((w * 1.4 + i * 0.5) % 1); ctx.fillStyle = `rgba(255,200,90,${1 - ph})`; ctx.beginPath(); ctx.arc(s[0], s[1] - ph * this.cam.A * 0.3, this.cam.A * 0.05, 0, 6.28); ctx.fill(); }
  }

  drawBench(x, y, pal) {
    const pz = 0.3;
    this.box(x, y, pz + 0.3, 1.3, 0.42, 0.08, pal.deskTop, pal.deskL, pal.deskR);
    this.box(x + 0.08, y + 0.08, pz, 0.08, 0.3, 0.3, pal.panel, pal.panel, shade(pal.panel, -0.2));
    this.box(x + 1.14, y + 0.08, pz, 0.08, 0.3, 0.3, pal.panel, pal.panel, shade(pal.panel, -0.2));
  }

  drawRack(x, y, pal) {
    const ctx = this.ctx; const pz = 0.3;
    this.box(x, y, pz, 0.62, 0.85, 1.55, '#3A332D', '#2A2420', '#221D19');
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        const on = this.reduced() ? (i + j) % 2 : (Math.sin(this.now * (3 + j) + i * 1.7 + x) > 0.2);
        const p = this.P(x + 0.62, y + 0.18 + j * 0.24, pz + 0.25 + i * 0.22);
        ctx.fillStyle = on ? ['#7DC49B', '#FFB531', '#6CC4FF'][j] : '#3C3530';
        ctx.fillRect(p[0] - 1, p[1] - 1, Math.max(2, this.cam.A * 0.05), Math.max(1.5, this.cam.A * 0.03));
      }
    }
    void pal;
  }

  drawRocket(x, y, pal) {
    const ctx = this.ctx; const pz = 0.3;
    this.cyl(x, y, pz, 0.32, 0.08, '#4A3A2B', '#5A4836');
    const b = this.P(x, y, pz + 0.1); const t = this.P(x, y, pz + 1.1);
    const w = this.cam.A * 0.2;
    ctx.fillStyle = '#F2E9DA'; ctx.beginPath(); ctx.moveTo(b[0] - w, b[1]); ctx.lineTo(b[0] - w, t[1] + w); ctx.quadraticCurveTo(t[0], t[1] - w * 0.8, b[0] + w, t[1] + w); ctx.lineTo(b[0] + w, b[1]); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(36,22,12,.5)'; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = '#F08A5D'; ctx.beginPath(); ctx.moveTo(b[0] - w, b[1]); ctx.lineTo(b[0] - w * 1.7, b[1] + w * 0.3); ctx.lineTo(b[0] - w, b[1] - w * 1.2); ctx.fill();
    ctx.beginPath(); ctx.moveTo(b[0] + w, b[1]); ctx.lineTo(b[0] + w * 1.7, b[1] + w * 0.3); ctx.lineTo(b[0] + w, b[1] - w * 1.2); ctx.fill();
    ctx.fillStyle = '#6CC4FF'; ctx.beginPath(); ctx.arc(b[0], (b[1] + t[1]) / 2, w * 0.45, 0, 6.28); ctx.fill();
    void pal;
  }

  drawGate(pal) {
    const ctx = this.ctx; const pz = 0.3; const y = 10.05;
    // see through the gate when the Lobby is zoomed in
    const fade = this.focus?.kind === 'room' && ROOMS[this.focus.id]?.row === 'front';
    if (fade) { ctx.save(); ctx.globalAlpha = 0.28; }
    this.drawGateBody(pal, pz, y);
    if (fade) ctx.restore();
  }

  drawGateBody(pal, pz, y) {
    const ctx = this.ctx;
    this.box(6.75, y - 0.12, pz, 0.26, 0.26, 2.0, pal.trim, shade(pal.trim, -0.1), shade(pal.trim, -0.25));
    this.box(9.0, y - 0.12, pz, 0.26, 0.26, 2.0, pal.trim, shade(pal.trim, -0.1), shade(pal.trim, -0.25));
    this.box(6.55, y - 0.15, pz + 2.0, 2.9, 0.3, 0.42, shade(pal.trim, 0.2), shade(pal.trim, 0.05), shade(pal.trim, -0.2));
    if (this.cam.A < 12) return;
    this.wallRT(y + 0.16, pz + 2.42, 100);
    ctx.fillStyle = '#FFD072'; ctx.font = `800 26px ${FONT}`;
    ctx.textAlign = 'center'; ctx.fillText('hivedesk', 8.0 * 100, 0.31 * 100); ctx.textAlign = 'left';
    this.base();
  }

  drawTank(x, y, pal) {
    // a honey water tower that gives the building its silhouette, with your GPU core on top
    const ctx = this.ctx;
    for (const [dx, dy] of [[-0.6, -0.6], [0.6, -0.6], [-0.6, 0.6], [0.6, 0.6]]) {
      const a = this.P(x + dx, y + dy, 0); const b = this.P(x + dx * 0.6, y + dy * 0.6, TANK.z);
      ctx.strokeStyle = pal.rail; ctx.lineWidth = Math.max(1.5, this.cam.A * 0.07); ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    }
    this.cyl(x, y, TANK.z, 0.95, 1.4, '#E79A2A', '#C9862A');
    const p = this.P(x, y, TANK.z + 0.75);
    ctx.fillStyle = 'rgba(255,240,200,.45)'; ctx.fillRect(p[0] - this.cam.A * 0.95, p[1] - this.cam.A * 0.35, this.cam.A * 0.22, this.cam.A * 0.95);
    ctx.fillStyle = '#FFF1CF'; ctx.beginPath(); hexScreen(ctx, p[0] + this.cam.A * 0.2, p[1], this.cam.A * 0.3); ctx.fill();
    const c = this.getCity();
    const self = c.machines?.[c.selfId] || {};
    const hostGlow = this.hostGlow || (this.hostGlow = { glow: 0 });
    this.drawCore(hostGlow, x, y, TANK.z + 1.45, self, '#FFB531', false);
  }

  drawPlant(x, y, s, z = 0) {
    const ctx = this.ctx;
    this.cyl(x, y, z, 0.2 * s, 0.32 * s, '#C46A3A', '#4A2E1A');
    const c = this.P(x, y, z + 0.32 * s);
    const t = this.reduced() ? 0 : Math.sin(this.now * 0.8 + x) * 0.04;
    for (let i = 0; i < 7; i++) {
      const an = -Math.PI / 2 + (i - 3) * 0.42 + t;
      const len = this.cam.A * (0.42 + (i % 3) * 0.1) * s;
      ctx.fillStyle = i % 2 ? '#4E8F5E' : '#63A874';
      ctx.beginPath(); ctx.ellipse(c[0] + Math.cos(an) * len * 0.5, c[1] + Math.sin(an) * len * 0.5, len * 0.5, len * 0.16, an, 0, 6.28); ctx.fill();
    }
  }

  drawTree(x, y, s, pal, z = 0) {
    const ctx = this.ctx;
    const b = this.P(x, y, z); const t = this.P(x, y, z + 1.1 * s);
    ctx.fillStyle = 'rgba(20,30,10,.25)'; ctx.beginPath(); ctx.ellipse(b[0] + this.cam.A * 0.3, b[1], this.cam.A * 0.9 * s, this.cam.A * 0.42 * s, 0, 0, 6.28); ctx.fill();
    ctx.strokeStyle = pal.trunk; ctx.lineWidth = Math.max(2, this.cam.A * 0.14 * s); ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(b[0], b[1]); ctx.lineTo(t[0], t[1]); ctx.stroke(); ctx.lineCap = 'butt';
    const sway = this.reduced() ? 0 : Math.sin(this.now * 0.7 + x * 0.3) * this.cam.A * 0.04;
    const r = this.cam.A * 0.78 * s;
    const cx = t[0] + sway; const cy = t[1] - r * 0.55;
    ctx.fillStyle = pal.treeB; ctx.beginPath(); ctx.arc(cx + r * 0.2, cy + r * 0.25, r * 0.85, 0, 6.28); ctx.fill();
    ctx.fillStyle = pal.tree; ctx.beginPath(); ctx.arc(cx - r * 0.12, cy, r * 0.8, 0, 6.28); ctx.fill();
    ctx.fillStyle = pal.treeC; ctx.beginPath(); ctx.arc(cx - r * 0.35, cy - r * 0.3, r * 0.4, 0, 6.28); ctx.fill();
    ctx.strokeStyle = 'rgba(30,40,10,.35)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(cx - r * 0.12, cy, r * 0.8, 0, 6.28); ctx.stroke();
  }

  drawLamp(x, y, pal) {
    const ctx = this.ctx;
    const b = this.P(x, y, 0); const t = this.P(x, y, 1.9);
    ctx.strokeStyle = '#3A2F25'; ctx.lineWidth = Math.max(1.5, this.cam.A * 0.07);
    ctx.beginPath(); ctx.moveTo(b[0], b[1]); ctx.lineTo(t[0], t[1]); ctx.stroke();
    const on = this.pal.night > 0.25;
    ctx.fillStyle = on ? '#FFE3A1' : '#C9B48A';
    ctx.beginPath(); hexScreen(ctx, t[0], t[1] - this.cam.A * 0.12, this.cam.A * 0.16); ctx.fill();
    ctx.strokeStyle = 'rgba(36,22,12,.6)'; ctx.lineWidth = 1; ctx.stroke();
    if (on) (this.lamps ||= []).push([t[0], t[1] - this.cam.A * 0.12, 2.4]);
    void pal;
  }

  /** Trees, lamps and flowers around your building, kept clear of the bridges. */
  homeDecor(pal) {
    const out = [];
    const spots = [[-3.4, 2.6, 1.1], [-2.8, 7.4, 1.0], [-0.8, 12.4, 0.9], [3.2, 14.2, 1.0], [12.8, 14.6, 1.05], [17.6, 11.6, 0.9], [19.4, 6.4, 1.15], [18.4, 1.0, 1.0], [14.6, -3.4, 0.95], [5.0, -3.6, 1.0], [9.8, -4.6, 0.85], [-1.4, -3.0, 0.8], [1.6, 11.6, 0.7], [15.2, 13.0, 0.75]];
    const clear = (x, y) => {
      for (const m of this.machines.values()) {
        const br = m.bridge;
        const vx = br.b.x - br.a.x; const vy = br.b.y - br.a.y; const L = vx * vx + vy * vy;
        // distance to the line from the plaza to the bridge start, and to the bridge
        for (const [ax, ay, bx, by] of [[PLAZA.x, PLAZA.y, br.a.x, br.a.y], [br.a.x, br.a.y, br.b.x, br.b.y]]) {
          const wx = bx - ax; const wy = by - ay; const LL = wx * wx + wy * wy || 1;
          const u = clamp(((x - ax) * wx + (y - ay) * wy) / LL);
          if (Math.hypot(ax + wx * u - x, ay + wy * u - y) < 2.4) return false;
        }
        void L;
      }
      return true;
    };
    for (const [x, y, s] of spots) if (clear(x, y)) out.push({ k: x + y, f: () => this.drawTree(x, y, s, pal) });
    for (const [x, y] of [[5.4, 12.0], [10.6, 12.0], [5.8, 15.0], [10.2, 14.8]]) if (clear(x, y) || y < 12.5) out.push({ k: x + y, f: () => this.drawLamp(x, y, pal) });
    // flower beds by the steps
    for (const [x, y] of [[5.9, 10.7], [10.1, 10.7]]) out.push({ k: x + y, f: () => this.drawFlowers(x, y) });
    return out;
  }

  drawFlowers(x, y) {
    const ctx = this.ctx;
    const colors = ['#FF7AB6', '#FFD072', '#FFFFFF', '#C9A0E8'];
    for (let i = 0; i < 9; i++) {
      const p = this.P(x + ((i * 37) % 10) / 10 - 0.5, y + ((i * 53) % 10) / 22 - 0.2, 0.05);
      ctx.fillStyle = '#4E8F5E'; ctx.fillRect(p[0] - 0.5, p[1] - this.cam.A * 0.12, 1, this.cam.A * 0.12);
      ctx.fillStyle = colors[i % 4]; ctx.beginPath(); ctx.arc(p[0], p[1] - this.cam.A * 0.14, Math.max(1.4, this.cam.A * 0.06), 0, 6.28); ctx.fill();
    }
  }

  friendDecor(m) {
    const out = [];
    const c = m.center;
    const pal = this.pal;
    const born = this.now - m.born;
    const show = born > 3.6 || born < -50;
    if (!show) return out;
    for (const [dx, dy, s] of [[-5.2, 1.2, 0.9], [1.6, -5.4, 0.85], [-3.2, -4.0, 0.8], [5.2, -1.4, 0.95]]) {
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
    const tw = towerOf(m.center);
    const H = this.towerHeight(m);
    const floors = Math.round((H - 0.4) / FLOOR_H);
    const born = this.now - m.born;
    const mm = m.m || {};
    const col = mm.color || '#7DC49B';
    const offline = mm.online === false;
    const build = born < -50 ? 1 : clamp((born - 1.0) / 2.6);
    const w = tw.x1 - tw.x0;
    // foundation
    this.box(tw.x0 - 0.3, tw.y0 - 0.3, 0, w + 0.6, w + 0.6, 0.3, pal.plinthTop, pal.plinthL, pal.plinthR);
    // floors stack up one by one while it is being built
    let topZ = 0.3;
    for (let i = 0; i < floors; i++) {
      const fs = clamp(build * floors - i);
      if (fs <= 0) break;
      const sc = this.reduced() ? 1 : easeOutBack(fs);
      const z0 = 0.3 + i * FLOOR_H;
      const hgt = FLOOR_H * Math.min(1, sc);
      const inset = i === floors - 1 ? 0.2 : 0;
      const wallL = offline ? '#9A938A' : mixHex(pal.towerL, col, 0.12);
      const wallR = offline ? '#837C74' : mixHex(pal.towerR, col, 0.12);
      this.box(tw.x0 + inset, tw.y0 + inset, z0, w - inset * 2, w - inset * 2, hgt, pal.tower, wallL, wallR);
      // a colored band per floor
      this.poly([this.P(tw.x0 + inset, tw.y1 - inset, z0 + hgt - 0.12), this.P(tw.x1 - inset, tw.y1 - inset, z0 + hgt - 0.12), this.P(tw.x1 - inset, tw.y1 - inset, z0 + hgt), this.P(tw.x0 + inset, tw.y1 - inset, z0 + hgt)], shade(col, -0.1));
      this.poly([this.P(tw.x1 - inset, tw.y0 + inset, z0 + hgt - 0.12), this.P(tw.x1 - inset, tw.y1 - inset, z0 + hgt - 0.12), this.P(tw.x1 - inset, tw.y1 - inset, z0 + hgt), this.P(tw.x1 - inset, tw.y0 + inset, z0 + hgt)], shade(col, -0.3));
      // windows with frames and a glint; warm light at night or when the GPU works hard
      if (fs >= 1) {
        const lit = !offline && (pal.night > 0.3 || (mm.load || 0) > 0.5);
        const glass = mixHex(mixHex('#7FA8C9', '#2B3A5C', pal.night * 0.7), DUSK_TINT, pal.gold * 0.25);
        const ww = (w - inset * 2 - 0.9) / 3;
        for (let j = 0; j < 3; j++) {
          for (const side of ['L', 'R']) {
            if (i === 0 && side === 'L' && j === 1) continue; // the door
            const on = lit && ((i * 3 + j + (side === 'L' ? 1 : 0)) % 3 !== 0);
            const zz = z0 + 0.34; const wh = 0.58;
            const u0 = (side === 'L' ? tw.x0 : tw.y0) + inset + 0.45 + j * ww + ww * 0.12; const u1 = u0 + ww * 0.76;
            const pt = (u, z) => (side === 'L' ? this.P(u, tw.y1 - inset, z) : this.P(tw.x1 - inset, u, z));
            this.poly([pt(u0 - 0.06, zz - 0.06), pt(u1 + 0.06, zz - 0.06), pt(u1 + 0.06, zz + wh + 0.06), pt(u0 - 0.06, zz + wh + 0.06)], shade(col, -0.25));
            this.poly([pt(u0, zz), pt(u1, zz), pt(u1, zz + wh), pt(u0, zz + wh)], on ? '#FFD98A' : glass);
            if (!on) this.poly([pt(u0 + (u1 - u0) * 0.15, zz + wh * 0.25), pt(u0 + (u1 - u0) * 0.35, zz + wh * 0.25), pt(u0 + (u1 - u0) * 0.6, zz + wh), pt(u0 + (u1 - u0) * 0.4, zz + wh)], 'rgba(255,255,255,.22)');
            const mid = (u0 + u1) / 2;
            const a = pt(mid, zz); const b = pt(mid, zz + wh);
            this.ctx.strokeStyle = shade(col, -0.25); this.ctx.lineWidth = Math.max(1, this.cam.A * 0.03);
            this.ctx.beginPath(); this.ctx.moveTo(a[0], a[1]); this.ctx.lineTo(b[0], b[1]); this.ctx.stroke();
            this.poly([pt(u0 - 0.1, zz - 0.06), pt(u1 + 0.1, zz - 0.06), pt(u1 + 0.1, zz - 0.13), pt(u0 - 0.1, zz - 0.13)], pal.tower);
            if (on) (this.windowLights ||= []).push(pt(mid, zz + wh / 2));
          }
        }
      }
      topZ = z0 + hgt;
    }
    // roof rim, a little garden and an antenna once it is built
    if (build >= 1 || born < -50) {
      const r0 = tw.x0 + 0.2; const r1 = tw.x1 - 0.2; const s0 = tw.y0 + 0.2; const s1 = tw.y1 - 0.2; const t = 0.14;
      this.box(r0, s0, topZ, r1 - r0, t, 0.22, pal.tower, pal.towerL, pal.towerR);
      this.box(r0, s0, topZ, t, s1 - s0, 0.22, pal.tower, pal.towerL, pal.towerR);
      this.box(r0, s1 - t, topZ, r1 - r0, t, 0.22, shade(pal.tower, 0.05), mixHex(pal.towerL, col, 0.25), pal.towerR);
      this.box(r1 - t, s0, topZ, t, s1 - s0, 0.22, shade(pal.tower, 0.05), pal.towerL, mixHex(pal.towerR, col, 0.25));
      this.drawPlant(r0 + 0.55, s1 - 0.55, 0.55, topZ);
      const an0 = this.P(r0 + 0.5, s0 + 0.5, topZ); const an1 = this.P(r0 + 0.5, s0 + 0.5, topZ + 1.5);
      this.ctx.strokeStyle = '#5A4836'; this.ctx.lineWidth = Math.max(1, this.cam.A * 0.04);
      this.ctx.beginPath(); this.ctx.moveTo(an0[0], an0[1]); this.ctx.lineTo(an1[0], an1[1]); this.ctx.stroke();
      const blink = this.reduced() || Math.sin(this.now * 3 + m.slot) > 0;
      this.ctx.fillStyle = blink ? '#FF6B5A' : '#7A3A30'; this.ctx.beginPath(); this.ctx.arc(an1[0], an1[1], Math.max(2, this.cam.A * 0.07), 0, 6.28); this.ctx.fill();
    }
    // the door with an awning in the owner's color
    if (build > 0.2) {
      const d0 = tw.x0 + (w - 1) / 2; const d1 = d0 + 1;
      this.poly([this.P(d0 - 0.08, tw.y1, 0.3), this.P(d1 + 0.08, tw.y1, 0.3), this.P(d1 + 0.08, tw.y1, 1.36), this.P(d0 - 0.08, tw.y1, 1.36)], shade(col, -0.3));
      this.poly([this.P(d0, tw.y1, 0.3), this.P(d1, tw.y1, 0.3), this.P(d1, tw.y1, 1.28), this.P(d0, tw.y1, 1.28)], '#8A5A2E', 'rgba(36,22,12,.5)');
      this.poly([this.P(d0 - 0.25, tw.y1, 1.5), this.P(d1 + 0.25, tw.y1, 1.5), this.P(d1 + 0.25, tw.y1 + 0.55, 1.28), this.P(d0 - 0.25, tw.y1 + 0.55, 1.28)], col, 'rgba(36,22,12,.4)');
    }
    // scaffolding and a crane while it is being built
    if (build < 1 && !this.reduced()) {
      ctx.strokeStyle = 'rgba(122,86,54,.85)'; ctx.lineWidth = Math.max(1, this.cam.A * 0.04);
      const top = 0.3 + floors * FLOOR_H;
      for (const [x, y] of [[tw.x0 - 0.2, tw.y1 + 0.2], [tw.x1 + 0.2, tw.y1 + 0.2], [tw.x1 + 0.2, tw.y0 - 0.2]]) {
        const a = this.P(x, y, 0.3); const b = this.P(x, y, top);
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      }
      for (let z = 0.3; z <= top; z += FLOOR_H / 2) {
        const p = [this.P(tw.x0 - 0.2, tw.y1 + 0.2, z), this.P(tw.x1 + 0.2, tw.y1 + 0.2, z), this.P(tw.x1 + 0.2, tw.y0 - 0.2, z)];
        ctx.beginPath(); ctx.moveTo(p[0][0], p[0][1]); ctx.lineTo(p[1][0], p[1][1]); ctx.lineTo(p[2][0], p[2][1]); ctx.stroke();
      }
      // the crane
      const cz = top + 1.4;
      const mast0 = this.P(tw.x0 + 0.4, tw.y0 + 0.4, topZ); const mast1 = this.P(tw.x0 + 0.4, tw.y0 + 0.4, cz);
      ctx.strokeStyle = '#E8A93A'; ctx.lineWidth = Math.max(1.5, this.cam.A * 0.07);
      ctx.beginPath(); ctx.moveTo(mast0[0], mast0[1]); ctx.lineTo(mast1[0], mast1[1]); ctx.stroke();
      const swing = Math.sin(this.now * 1.6) * 0.6;
      const jib = this.P(tw.x0 + 0.4 + Math.cos(swing) * 4, tw.y0 + 0.4 + Math.sin(swing) * 4, cz);
      ctx.beginPath(); ctx.moveTo(mast1[0], mast1[1]); ctx.lineTo(jib[0], jib[1]); ctx.stroke();
      ctx.strokeStyle = 'rgba(36,22,12,.7)'; ctx.lineWidth = 1;
      const hook = [jib[0], jib[1] + this.cam.A * 1.4];
      ctx.beginPath(); ctx.moveTo(jib[0], jib[1]); ctx.lineTo(hook[0], hook[1]); ctx.stroke();
      ctx.fillStyle = '#FFD072'; ctx.fillRect(hook[0] - this.cam.A * 0.2, hook[1], this.cam.A * 0.4, this.cam.A * 0.25);
      if (Math.random() < 0.25) { const p = this.P(rnd(tw.x0, tw.x1), tw.y1 + 0.2, topZ); this.spawn({ kind: 'puff', x: p[0], y: p[1], vx: rnd(-14, 14), vy: rnd(-20, -6), life: rnd(0.6, 1), size: rnd(4, 9) * this.cam.A / 30 }); }
    }
    // the GPU core on the roof: a glowing hexagon crystal that spins with the load
    const coreOn = build >= 1 || born < -50;
    if (coreOn) {
      this.box((tw.x0 + tw.x1) / 2 - 0.7, (tw.y0 + tw.y1) / 2 - 0.7, topZ, 1.4, 1.4, 0.25, '#4A3A2B', '#3A2F25', '#2A2420');
      this.drawCore(m, (tw.x0 + tw.x1) / 2, (tw.y0 + tw.y1) / 2, topZ + 0.05, mm, col, offline);
      if (born > 3.5 && born < 3.9 && !m.flashed && !this.reduced()) { m.flashed = true; const [cx, cy] = m.coreAt; for (let i = 0; i < 18; i++) this.spawn({ kind: 'spark', x: cx + rnd(-30, 30), y: cy + rnd(-30, 20), vx: rnd(-50, 50), vy: rnd(-70, -10), g: 40, life: rnd(0.6, 1.2), size: rnd(2, 4.5), color: pick(['#7FE3FF', '#FFFFFF', col]) }); this.sound('level'); }
    }
    // hit box for the machine panel
    const pts = [this.P(tw.x0 - 0.3, tw.y1 + 0.3, 0), this.P(tw.x1 + 0.3, tw.y1 + 0.3, 0), this.P(tw.x1 + 0.3, tw.y0 - 0.3, 0), this.P(tw.x0, tw.y0, H + 1.6)];
    const xs = pts.map((p) => p[0]); const ys = pts.map((p) => p[1]);
    this.machineHits.push({ id: m.id, x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) });
    void city;
  }


  /** A glowing hexagon crystal: the GPU of a machine. It spins faster with the load and flares with traffic. */
  drawCore(holder, x, y, z, mm, col, offline) {
    const ctx = this.ctx;
    const c = this.P(x, y, z);
    const load = clamp(mm.load || 0);
    const lit = offline ? 0 : 0.35 + load * 0.65 + clamp(holder.glow || 0) * 0.4;
    const spin = this.reduced() ? 0 : this.now * (0.6 + load * 3.2);
    const R = this.cam.A * 0.62;
    const cy = c[1] - this.cam.A * 0.9 - (this.reduced() ? 0 : Math.sin(this.now * 2) * this.cam.A * 0.06);
    const g = ctx.createRadialGradient(c[0], cy, 2, c[0], cy, R * 3.2);
    g.addColorStop(0, `rgba(127,227,255,${0.5 * lit})`); g.addColorStop(1, 'rgba(127,227,255,0)');
    ctx.fillStyle = g; ctx.fillRect(c[0] - R * 3.2, cy - R * 3.2, R * 6.4, R * 6.4);
    ctx.save(); ctx.translate(c[0], cy);
    ctx.scale(0.55 + 0.45 * Math.abs(Math.cos(spin)), 1);
    ctx.beginPath(); hexScreen(ctx, 0, 0, R);
    const cg = ctx.createLinearGradient(0, -R, 0, R);
    cg.addColorStop(0, offline ? '#8A8A8A' : '#CFF6FF'); cg.addColorStop(1, offline ? '#555555' : mixHex('#4FB6E0', col, 0.25));
    ctx.fillStyle = cg; ctx.fill();
    ctx.strokeStyle = 'rgba(20,40,60,.7)'; ctx.lineWidth = 1.2; ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,.55)'; ctx.beginPath(); hexScreen(ctx, -R * 0.2, -R * 0.25, R * 0.3); ctx.fill();
    ctx.restore();
    ctx.strokeStyle = `rgba(127,227,255,${0.35 + lit * 0.5})`; ctx.lineWidth = Math.max(1.5, this.cam.A * 0.06);
    ctx.beginPath(); ctx.ellipse(c[0], c[1] - this.cam.A * 0.05, R * 1.5, R * 0.75, 0, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0.02, load)); ctx.stroke();
    holder.coreAt = [c[0], cy, R];
  }

  /* ---------- bridges ---------- */
  drawBridge(m, pal, city) {
    const br = m.bridge;
    const born = this.now - m.born;
    const ext = born < -50 ? 1 : clamp((born - 1.8) / 2.0);
    if (ext <= 0) return;
    if (!this.visible(Math.min(br.a.x, br.b.x) - 1, Math.min(br.a.y, br.b.y) - 1, Math.max(br.a.x, br.b.x) + 1, Math.max(br.a.y, br.b.y) + 1, 4, -1)) return;
    const ctx = this.ctx;
    const n = 26;
    const px = -br.uy * 0.75; const py = br.ux * 0.75;
    const segs = Math.max(1, Math.round(n * ext));
    const pt = (u, side, dz = 0) => { const p = bridgePoint(br, u); return this.P(p.x + px * side, p.y + py * side, p.z + dz); };
    // the side of the deck that faces the viewer
    const front = (px + py) > 0 ? 1 : -1;
    for (let i = 0; i < segs; i++) {
      const u0 = i / n; const u1 = (i + 1) / n;
      this.poly([pt(u0, front, 0), pt(u1, front, 0), pt(u1, front, -0.28), pt(u0, front, -0.28)], pal.deckSide);
      this.poly([pt(u0, -1), pt(u1, -1), pt(u1, 1), pt(u0, 1)], i % 2 ? pal.deck : pal.deckB, 'rgba(36,22,12,.25)');
    }
    // under arch supports
    ctx.strokeStyle = pal.rail; ctx.lineWidth = Math.max(1, this.cam.A * 0.05);
    ctx.beginPath();
    for (let i = 0; i <= segs; i++) { const p = pt(i / n, front, -0.28 - Math.sin(Math.PI * i / n) * 0.6); if (i) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); }
    ctx.stroke();
    // railings and posts
    const glow = clamp(m.glow);
    const borrowing = borrowTo(city, m.id);
    for (const side of [-1, 1]) {
      ctx.strokeStyle = pal.rail; ctx.lineWidth = Math.max(1, this.cam.A * 0.05);
      for (let i = 0; i <= segs; i += 2) { const a = pt(i / n, side); const b = pt(i / n, side, 0.55); ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); }
      ctx.beginPath();
      for (let i = 0; i <= segs; i++) { const p = pt(i / n, side, 0.55); if (i) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); }
      ctx.stroke();
    }
    // the light cable along the deck: it glows when tasks or GPU turns travel
    const cablePts = [];
    for (let i = 0; i <= segs; i++) cablePts.push(pt(i / n, 0, 0.04));
    ctx.lineCap = 'round';
    ctx.strokeStyle = alpha('#FFD072', 0.25 + 0.15 * (1 - this.pal.night));
    ctx.lineWidth = Math.max(1.2, this.cam.A * 0.06);
    ctx.beginPath(); cablePts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.stroke();
    if (glow > 0.02 || borrowing) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const g = Math.max(glow, borrowing ? 0.55 : 0);
      ctx.strokeStyle = borrowing ? `rgba(127,227,255,${0.55 * g})` : `rgba(255,200,90,${0.6 * g})`;
      ctx.lineWidth = Math.max(3, this.cam.A * 0.24);
      ctx.shadowColor = borrowing ? '#7FE3FF' : '#FFC24A'; ctx.shadowBlur = 16 * g;
      ctx.beginPath(); cablePts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.stroke();
      if (borrowing && !this.reduced()) {
        ctx.setLineDash([this.cam.A * 0.4, this.cam.A * 0.6]);
        ctx.lineDashOffset = -this.now * this.cam.A * 3;
        ctx.strokeStyle = 'rgba(220,250,255,.9)'; ctx.lineWidth = Math.max(1.5, this.cam.A * 0.08); ctx.shadowBlur = 0;
        ctx.beginPath(); cablePts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.restore();
    }
    ctx.lineCap = 'butt';
    // lanterns
    for (const u of [0.15, 0.5, 0.85]) {
      if (u > ext) continue;
      const p = pt(u, front, 0.8);
      const on = this.pal.night > 0.25 || glow > 0.1 || borrowing;
      ctx.fillStyle = on ? (borrowing ? '#BFF3FF' : '#FFE3A1') : '#C9B48A';
      ctx.beginPath(); hexScreen(ctx, p[0], p[1], Math.max(2.5, this.cam.A * 0.13)); ctx.fill();
      ctx.strokeStyle = 'rgba(36,22,12,.6)'; ctx.lineWidth = 1; ctx.stroke();
      if (on) (this.lamps ||= []).push([p[0], p[1], borrowing ? 1.6 : 1.3, borrowing ? '127,227,255' : null]);
    }
    m.cable = cablePts;
  }

  drawCouriers() {
    const ctx = this.ctx;
    for (const cr of this.couriers) {
      const br = cr.m.bridge;
      const u0 = clamp((this.now - cr.t0) / cr.dur);
      const e = easeInOut(u0);
      // home side: from the plaza onto the bridge; friend side: from the tower
      const u = cr.dir > 0 ? e : 1 - e;
      const p0 = bridgePoint(br, u);
      const p = this.P(p0.x, p0.y, p0.z + 0.6);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 1; i <= 6; i++) {
        const uu = clamp(u - cr.dir * i * 0.018);
        const q0 = bridgePoint(br, uu); const q = this.P(q0.x, q0.y, q0.z + 0.6);
        ctx.fillStyle = alpha(cr.color, 0.28 * (1 - i / 7));
        ctx.beginPath(); ctx.arc(q[0], q[1], Math.max(2, this.cam.A * 0.16) * (1 - i / 9), 0, 6.28); ctx.fill();
      }
      const g = ctx.createRadialGradient(p[0], p[1], 1, p[0], p[1], this.cam.A * 0.8);
      g.addColorStop(0, alpha(cr.color, 0.9)); g.addColorStop(1, alpha(cr.color, 0));
      ctx.fillStyle = g; ctx.fillRect(p[0] - this.cam.A, p[1] - this.cam.A, this.cam.A * 2, this.cam.A * 2);
      ctx.restore();
      if (cr.kind === 'task') drawNoteIcon(ctx, p[0], p[1] - this.cam.A * 0.25, Math.max(10, this.cam.A * 0.5), '#FFE08A', '#FFB531');
      else { ctx.fillStyle = '#E8FBFF'; ctx.beginPath(); hexScreen(ctx, p[0], p[1], Math.max(3, this.cam.A * 0.14)); ctx.fill(); }
    }
  }

  /* ---------- bees ---------- */
  drawBee(a) {
    const ctx = this.ctx;
    const now = this.now;
    const reduced = this.reduced();
    const k = this.k;
    let bob = 0; let tilt = 0; let sx = 1; let sy = 1; let wingRate = 22; let wingAmp = 0.28; let eyes = false;
    const m = a.mode;
    if (!reduced) {
      switch (m) {
        case 'walk': {
          wingRate = 40; wingAmp = 0.5;
          bob = Math.abs(Math.sin(now * 9 + a.ph)) * 0.12;
          tilt = 0.1 * a.facing;
          break;
        }
        case 'working': bob = Math.sin(now * 16 + a.ph) * 0.018; wingRate = 26; break;
        case 'thinking': bob = Math.sin(now * 3 + a.ph) * 0.05; break;
        case 'waiting': { const beat = (now * 2.2 + a.ph) % 1; bob = beat < 0.2 ? -Math.sin((beat / 0.2) * Math.PI) * 0.05 : 0; wingRate = 14; wingAmp = 0.18; break; }
        case 'reviewing': bob = Math.sin(now * 2 + a.ph) * 0.03; tilt = Math.sin(now * 1.2) * 0.05; break;
        case 'testing': bob = Math.sin(now * 5 + a.ph) * 0.03; break;
        case 'borrow': bob = Math.sin(now * 3 + a.ph) * 0.08; wingRate = 34; wingAmp = 0.42; break;
        case 'sleep': bob = Math.sin(now * 1.1 + a.ph) * 0.012; tilt = 0.24; eyes = true; wingRate = 0; wingAmp = 0; break;
        default: bob = Math.sin(now * 2.2 + a.ph) * 0.05;
      }
      const sq = now - a.squashAt;
      if (sq < 0.5) { const d = Math.exp(-sq * 9) * Math.cos(sq * 22) * 0.16; sy *= 1 - d; sx *= 1 + d * 0.8; }
    } else if (m === 'sleep') { tilt = 0.18; eyes = true; wingAmp = 0; } else { wingRate = 0; wingAmp = 0.2; }
    if (now >= a.blinkAt && now < a.blinkAt + 0.13) eyes = true;
    const p = this.P(a.pos.x, a.pos.y, a.pos.z + (a.place.kind === 'room' && !a.path.length ? 0.3 : 0) + bob);
    a.sx = p[0]; a.sy = p[1];
    // shadow on the ground
    const groundZ = a.path.length && a.path[0].bridge ? bridgeGroundZ(a) : (a.place.kind === 'room' && roomAt(a.pos.x, a.pos.y) ? 0.3 : a.pos.z > 2 ? this.towerHeight(this.machines.get(a.place.machine) || {}) : 0);
    const sp = this.P(a.pos.x, a.pos.y, Math.min(groundZ, a.pos.z));
    ctx.fillStyle = `rgba(20,12,6,${0.26 * a.alpha})`;
    ctx.beginPath(); ctx.ellipse(sp[0], sp[1], 15 * k, 7 * k, 0, 0, 6.28); ctx.fill();
    const img = this.sprite(a.ag);
    ctx.save();
    ctx.globalAlpha = a.alpha;
    ctx.translate(p[0], p[1]);
    ctx.translate(0, 28 * k);
    ctx.rotate(tilt);
    ctx.scale(sx, sy);
    ctx.translate(-32 * k, -72 * k);
    const flap = wingRate ? Math.sin(now * wingRate + a.ph) * wingAmp : -0.25;
    ctx.fillStyle = 'rgba(255,253,245,.62)'; ctx.strokeStyle = 'rgba(36,22,12,.5)'; ctx.lineWidth = Math.max(0.6, k);
    for (const [wx, dir] of [[13.5, -1], [50.5, 1]]) {
      ctx.save(); ctx.translate((wx + dir * -6) * k, 30 * k); ctx.rotate(dir * (0.56 - flap));
      ctx.beginPath(); ctx.ellipse(dir * 7 * k, -4 * k, 10.5 * k, 6 * k * (1 - Math.abs(flap) * 0.35), 0, 0, 6.28); ctx.fill(); ctx.stroke();
      ctx.restore();
    }
    if (img) ctx.drawImage(img, -4 * k, -2 * k, 72 * k, 76 * k);
    else { ctx.fillStyle = a.ag.color; ctx.beginPath(); ctx.arc(32 * k, 32 * k, 17 * k, 0, 6.28); ctx.fill(); }
    if (eyes) {
      ctx.fillStyle = '#FCC041'; ctx.strokeStyle = OUT; ctx.lineWidth = Math.max(0.8, 1.3 * k); ctx.lineCap = 'round';
      for (const ex of [25.6, 38.4]) { ctx.beginPath(); ctx.ellipse(ex * k, 31.6 * k, 4.3 * k, 5.1 * k, 0, 0, 6.28); ctx.fill(); ctx.beginPath(); ctx.moveTo((ex - 3) * k, 32 * k); ctx.quadraticCurveTo(ex * k, 34.8 * k, (ex + 3) * k, 32 * k); ctx.stroke(); }
      ctx.lineCap = 'butt';
    }
    ctx.restore();
    // a task note in its hands while it walks to a new room
    const task = a.ag.taskId && this.getCity().tasks[a.ag.taskId];
    if (a.mode === 'walk' && task && a.place.kind === 'room') drawNoteIcon(ctx, p[0], p[1] + 24 * k, 15 * k * 1.2, '#FFE08A', a.ag.color);
    else if (a.mode === 'walk' && a.place.kind === 'roof') drawParcel(ctx, p[0], p[1] + 24 * k, 14 * k, '#7FE3FF');
    this.hits.push({ id: a.id, x: p[0] - 26 * k, y: p[1] - 38 * k, w: 52 * k, h: 66 * k });
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
    const jars = this.jarLights || []; this.jarLights = [];
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const al = clamp((pal.night - 0.2) * 0.5);
    if (al > 0) {
      for (const [x, y, s = 1, rgbs] of lamps) {
        const r = this.cam.A * 1.4 * s;
        const g = ctx.createRadialGradient(x, y + this.cam.A * 0.2, 1, x, y + this.cam.A * 0.2, r);
        g.addColorStop(0, `rgba(${rgbs || '255,190,90'},${al * 0.8})`); g.addColorStop(1, `rgba(${rgbs || '255,190,90'},0)`);
        ctx.fillStyle = g; ctx.fillRect(x - r, y - r, r * 2, r * 2.2);
      }
      for (const [x, y] of wins) {
        const r = this.cam.A * 0.8;
        const g = ctx.createRadialGradient(x, y, 1, x, y, r);
        g.addColorStop(0, `rgba(255,210,130,${al * 0.5})`); g.addColorStop(1, 'rgba(255,210,130,0)');
        ctx.fillStyle = g; ctx.fillRect(x - r, y - r, r * 2, r * 2);
      }
    }
    for (const [x, y] of jars) {
      const r = this.cam.A * 0.5;
      const g = ctx.createRadialGradient(x, y, 1, x, y, r);
      g.addColorStop(0, `rgba(255,190,80,${0.25 + al * 0.4})`); g.addColorStop(1, 'rgba(255,190,80,0)');
      ctx.fillStyle = g; ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
    // screens glow on busy bees
    for (const a of this.actors.values()) {
      if (!['working', 'testing', 'reviewing', 'thinking'].includes(a.mode) || a.sx < -100) continue;
      const r = this.cam.A * 0.7;
      const [r0, g0, b0] = rgb(a.ag.color);
      const g = ctx.createRadialGradient(a.sx, a.sy + this.cam.A * 0.3, 1, a.sx, a.sy + this.cam.A * 0.3, r);
      g.addColorStop(0, `rgba(${r0},${g0},${b0},${0.14 + pal.night * 0.14})`); g.addColorStop(1, `rgba(${r0},${g0},${b0},0)`);
      ctx.fillStyle = g; ctx.fillRect(a.sx - r, a.sy - r * 0.6, r * 2, r * 2);
    }
    ctx.restore();
    // a soft night wash over everything outside the light
    if (pal.night > 0.4) { ctx.fillStyle = `rgba(10,14,32,${(pal.night - 0.4) * 0.18})`; ctx.fillRect(0, 0, this.w, this.h); }
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
    ctx.fillStyle = 'rgba(12,10,8,.5)';
    ctx.fill('evenodd');
    ctx.restore();
  }

  drawOverlay(pal, c) {
    const ctx = this.ctx;
    const now = this.now;
    const k = this.k;
    const reduced = this.reduced();
    const A = this.cam.A;
    // room name pills over the front rooms and over every room when zoomed out
    if (A >= 10 && A < 44 && !(this.focus?.kind === 'room')) {
      for (const key of ROOM_KINDS) {
        const r = ROOMS[key];
        const cn = roomCenter(key);
        const z = r.row === 'back' ? WALL + 1.1 : 2.1;
        const p = this.P(cn.x, r.row === 'back' ? r.y0 + 0.4 : r.y0 + 0.6, z);
        const n = [...this.notes.values()].filter((x) => x.room === key && !x.gone && x.t.status !== 'done').length;
        const label = this.t(`city.room.${key}`);
        drawRoomPill(ctx, p[0], p[1], label, ROOM_COLOR[key], n, clamp(A * 0.42, 10, 13.5), this.highlightRoom(key));
      }
    }
    // machine signs
    for (const m of this.machines.values()) {
      const born = now - m.born;
      if (born < 3 && born > -50) continue;
      const tw = towerOf(m.center);
      const p = this.P((tw.x0 + tw.x1) / 2, (tw.y0 + tw.y1) / 2, this.towerHeight(m) + 2.4);
      const drop = reduced || born < -50 ? 1 : easeOutBack(clamp((born - 3) / 0.6));
      ctx.globalAlpha = clamp(drop);
      drawMachineSign(ctx, p[0], p[1] - (1 - drop) * 30, m.m?.name || m.id, m.m?.color || '#7DC49B', m.m?.online === false ? this.t('city.machine.offline') : null, clamp(A * 0.45, 11, 14), this.highlight?.kind === 'machine' && this.highlight.id === m.id);
      ctx.globalAlpha = 1;
    }
    // your building sign
    {
      const p = this.P(-1.6, -1.4, 5.9);
      drawMachineSign(ctx, p[0], p[1], c.machines[c.selfId]?.name || this.t('city.machine.you'), '#FFB531', null, clamp(A * 0.45, 11, 14), this.highlight?.kind === 'machine' && this.highlight.id === c.selfId);
    }
    // bees: name tags, status icons, bubbles
    for (const a of this.actors.values()) {
      if (a.sx < -100) continue;
      const headY = a.sy - 34 * k;
      const ix = a.sx + 22 * k; const iy = headY - 6 * k;
      const sz = clamp(A * 0.62, 12, 26);
      ctx.globalAlpha = a.alpha;
      if (A >= 15) {
        const wob = reduced ? 0 : Math.sin(now * 3 + a.ph) * 2;
        if (a.mode === 'waiting') iconClock(ctx, ix, iy + wob, sz, reduced ? 0 : now);
        else if (a.mode === 'thinking') iconDots(ctx, ix, iy + wob, sz, reduced ? 0 : now);
        else if (a.mode === 'reviewing') iconMag(ctx, ix, iy + wob, sz, reduced ? 0 : now);
        else if (a.mode === 'testing') iconFlask(ctx, ix, iy + wob, sz, reduced ? 0 : now);
        else if (a.ag.status === 'offline') iconPause(ctx, ix, iy, sz);
        else if (a.mode === 'borrow') drawPill(ctx, a.sx, headY - sz * 0.9 + wob, this.t('city.fx.borrowing'), '#7FE3FF', clamp(A * 0.4, 10, 12));
      }
      if (A >= 17 || this.highlight?.id === a.id) {
        const fs = clamp(A * 0.38, 9.5, 12.5);
        drawNameTag(ctx, a.sx, a.sy + 30 * k, a.ag.name, a.ag.level, a.ag.color, this.highlight?.id === a.id || this.dropTarget?.id === a.id, fs);
      }
      if (this.highlight?.id === a.id || this.dropTarget?.id === a.id) {
        ctx.strokeStyle = 'rgba(255,208,114,.95)'; ctx.lineWidth = 2; ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.ellipse(a.sx, a.sy + 28 * k, 26 * k, 10 * k, 0, 0, 6.28); ctx.stroke(); ctx.setLineDash([]);
      }
      if (a.bubble && A >= 20) {
        const age = now - a.bubble.at;
        ctx.globalAlpha = Math.min(clamp(age / 0.2), clamp((a.bubble.until - now) / 0.35)) * a.alpha;
        drawBubble(ctx, a.sx, headY - 10 * k, a.bubble.text, clamp(A * 0.4, 10.5, 13), this.w, a.ag.color);
      }
      ctx.globalAlpha = 1;
    }
    // flying notes between boards
    for (const n of this.notes.values()) {
      if (!n.fly) continue;
      const u = clamp((now - n.fly.t0) / 0.9);
      if (u >= 1) { n.fly = null; continue; }
      const to = this.notePos(n);
      const e = easeInOut(u);
      const x = lerp(n.fly.from.x, to.x, e); const y = lerp(n.fly.from.y, to.y, e); const z = lerp(n.fly.from.z, to.z, e) + Math.sin(Math.PI * u) * 2.2;
      const p = this.P(x, y, z);
      drawNoteIcon(ctx, p[0], p[1], Math.max(10, A * 0.55), n.t.status === 'done' ? '#C6E8CD' : '#FFE08A', this.actors.get(n.t.assignee)?.ag.color);
    }
    void pal;
  }

  drawParticles() {
    const ctx = this.ctx;
    for (const p of this.parts) {
      const life = 1 - p.age / p.max;
      ctx.globalAlpha = clamp(life * 1.6);
      switch (p.kind) {
        case 'glyph': ctx.font = `700 ${p.size}px ${MONO}`; ctx.fillStyle = p.color; ctx.fillText(p.text, p.x, p.y); break;
        case 'z': ctx.font = `800 ${Math.min(22, p.size * (1 + p.age * 0.3))}px ${FONT}`; ctx.fillStyle = '#E8DDF7'; ctx.fillText('z', p.x, p.y); break;
        case 'dot': case 'bubble':
          ctx.fillStyle = p.color; ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, 6.28); ctx.fill();
          if (p.kind === 'bubble') { ctx.strokeStyle = 'rgba(255,255,255,.6)'; ctx.lineWidth = 1; ctx.stroke(); }
          break;
        case 'spark': {
          ctx.fillStyle = p.color;
          const r = p.size * (0.6 + life * 0.6);
          ctx.beginPath(); ctx.moveTo(p.x, p.y - r * 2); ctx.lineTo(p.x + r * 0.5, p.y - r * 0.5); ctx.lineTo(p.x + r * 2, p.y); ctx.lineTo(p.x + r * 0.5, p.y + r * 0.5); ctx.lineTo(p.x, p.y + r * 2); ctx.lineTo(p.x - r * 0.5, p.y + r * 0.5); ctx.lineTo(p.x - r * 2, p.y); ctx.lineTo(p.x - r * 0.5, p.y - r * 0.5); ctx.closePath(); ctx.fill();
          break;
        }
        case 'puff': ctx.fillStyle = 'rgba(242,233,218,.55)'; ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (1 + p.age * 1.5), 0, 6.28); ctx.fill(); break;
        case 'label': {
          ctx.font = `700 ${clamp(this.cam.A * 0.42, 10, 13)}px ${FONT}`;
          const tw = ctx.measureText(p.text).width;
          ctx.fillStyle = 'rgba(20,16,12,.85)'; roundRect(ctx, p.x - tw / 2 - 7, p.y - 13, tw + 14, 20, 10); ctx.fill();
          ctx.fillStyle = p.color; ctx.textAlign = 'center'; ctx.fillText(p.text, p.x, p.y + 1.5); ctx.textAlign = 'left';
          break;
        }
        case 'jarpop': ctx.globalAlpha = clamp(life * 2); iconJar(ctx, p.x, p.y, clamp(this.cam.A * 0.6, 12, 22)); break;
        default: break;
      }
    }
    ctx.globalAlpha = 1;
  }
}

/* ---------- helpers ---------- */
function borrowTo(c, machineId) { return !!c && Object.values(c.borrows || {}).some((b) => b.to === machineId || b.from === machineId); }

function bridgeGroundZ(a) { return Math.max(0, a.pos.z - WALK_Z); }

function drawRoomPill(ctx, x, y, text, color, count, fs, on) {
  ctx.font = `750 ${fs}px ${FONT}`;
  const tw = ctx.measureText(text).width;
  const cw = count ? fs * 1.5 : 0;
  const w = tw + 26 + cw; const h = fs + 11;
  const x0 = x - w / 2;
  ctx.fillStyle = 'rgba(0,0,0,.25)'; roundRect(ctx, x0 + 1, y - h / 2 + 2, w, h, h / 2); ctx.fill();
  ctx.fillStyle = on ? 'rgba(52,40,26,.96)' : 'rgba(24,19,14,.86)'; roundRect(ctx, x0, y - h / 2, w, h, h / 2); ctx.fill();
  ctx.strokeStyle = on ? 'rgba(255,208,114,.9)' : alpha(color, 0.5); ctx.lineWidth = 1; ctx.stroke();
  ctx.fillStyle = color; ctx.beginPath(); hexScreen(ctx, x0 + 11, y, fs * 0.36); ctx.fill();
  ctx.fillStyle = '#F2E9DA'; ctx.fillText(text, x0 + 20, y + fs * 0.36);
  if (count) {
    ctx.fillStyle = alpha(color, 0.25); roundRect(ctx, x0 + w - cw - 5, y - fs * 0.55, cw, fs * 1.1, fs * 0.55); ctx.fill();
    ctx.fillStyle = color; ctx.font = `800 ${fs * 0.82}px ${FONT}`; ctx.textAlign = 'center';
    ctx.fillText(String(count), x0 + w - cw / 2 - 5, y + fs * 0.3); ctx.textAlign = 'left';
  }
}

function drawMachineSign(ctx, x, y, text, color, sub, fs, on) {
  ctx.font = `800 ${fs}px ${FONT}`;
  const tw = ctx.measureText(text).width;
  ctx.font = `600 ${fs * 0.8}px ${FONT}`;
  const sw = sub ? ctx.measureText(sub).width + 10 : 0;
  const w = tw + 34 + sw; const h = fs + 14;
  const x0 = x - w / 2;
  ctx.strokeStyle = 'rgba(36,22,12,.6)'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(x, y + h / 2); ctx.lineTo(x, y + h / 2 + 10); ctx.stroke();
  ctx.fillStyle = 'rgba(0,0,0,.3)'; roundRect(ctx, x0 + 2, y - h / 2 + 3, w, h, 8); ctx.fill();
  ctx.fillStyle = on ? '#3A2C1C' : '#241C14'; roundRect(ctx, x0, y - h / 2, w, h, 8); ctx.fill();
  ctx.strokeStyle = on ? '#FFD072' : alpha(color, 0.8); ctx.lineWidth = 1.5; ctx.stroke();
  ctx.fillStyle = color; ctx.beginPath(); hexScreen(ctx, x0 + 13, y, fs * 0.42); ctx.fill();
  ctx.fillStyle = '#FFF4DE'; ctx.font = `800 ${fs}px ${FONT}`; ctx.fillText(text, x0 + 24, y + fs * 0.36);
  if (sub) { ctx.fillStyle = '#E57B6E'; ctx.font = `600 ${fs * 0.8}px ${FONT}`; ctx.fillText(sub, x0 + 30 + tw, y + fs * 0.3); }
}

export { WALL, ROOMS, CORRIDOR_Y };
