// The Office: an isometric honeycomb office floor drawn on one canvas.
// Every pose comes from the engine state (worker.status, tasks, queue) and every effect
// (hand offs, speech bubbles, test results, confetti) from a real engine event.
// Shared by the full Office mode and the mini widget.

import { beeSvg } from '/js/bees.js';

const FONT = '"Segoe UI Variable Text","Segoe UI",system-ui,-apple-system,sans-serif';
const MONO = 'ui-monospace,"Cascadia Code",Consolas,monospace';
const OUT = '#24160C';

// World: x runs to the lower right, y to the lower left, z is up. One unit is one floor tile.
const RX = 14;
const RY = 10;
const WALL = 2.7;
const SLAB = 0.34;
const ZK = 1.12; // z scale against the tile half width
const DW = 1.8; // desk size
const DD = 1.0;
const DH = 0.6;
const SEAT_Z = 1.34;
const SLOTS = [[3.4, 3.4], [7.7, 3.4], [3.4, 6.4], [7.7, 6.4], [11.6, 3.4], [11.6, 6.4], [1.0, 8.6], [5.2, 8.6], [9.4, 8.6]];
const MEL_HOME = { x: 4.05, y: 1.35, z: 1.5 };
const DOOR = { x: 12.45, y: 0.35, z: 1.0 };
const BOARD = { u0: 0.9, u1: 6.9, t0: 0.2, t1: 2.32 };
const NOTE_H = 0.3;
const COLS = ['To do', 'Doing', 'Done'];
const COL_OF = { pending: 0, ready: 0, blocked: 0, running: 1, review: 1, failed: 1, done: 2, skipped: 2 };
const ACTIVE = new Set(['refining', 'awaiting_brief', 'planning', 'running']);
const KIND = { mel: 'mel', dev: 'dev', designer: 'designer', qa: 'qa', writer: 'writer' };

const GLYPHS = {
  dev: ['{ }', '</>', '=>', '( )', ';', '01', 'fn', '[ ]', '++', '&&'],
  designer: ['#', 'px', 'rem', ':root', 'rgb', 'em'],
  writer: ['Aa', '##', 'md', 'abc', '...', 'txt'],
  qa: ['ok?', 'assert', '==', '!', 'test'],
  mel: ['plan', '1.', '2.', '3.'],
  hired: ['{ }', 'Aa', '01', '=>'],
};

/* ---------- small math and color helpers ---------- */
const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const easeOutBack = (t) => { const c1 = 1.70158; const c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[(Math.random() * arr.length) | 0];

function rgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  const v = m ? parseInt(m[1], 16) : 0xffb531;
  return [v >> 16, (v >> 8) & 255, v & 255];
}
function mixHex(a, b, t) {
  const A = rgb(a); const B = rgb(b);
  const c = A.map((x, i) => Math.round(lerp(x, B[i], t)));
  return `#${((1 << 24) | (c[0] << 16) | (c[1] << 8) | c[2]).toString(16).slice(1)}`;
}
function alpha(hex, a) { const [r, g, b] = rgb(hex); return `rgba(${r},${g},${b},${a})`; }
const shade = (hex, t) => (t < 0 ? mixHex(hex, '#000000', -t) : mixHex(hex, '#ffffff', t));

/* ---------- day and night ---------- */
const DAY = {
  floorA: '#8C6743', floorB: '#835F3D', floorC: '#946E48', grout: '#634629', rug: '#E8A93A',
  slabL: '#4B3625', slabR: '#3A2A1C', wallL: '#F0E3C9', wallR: '#E2D1B2', wainL: '#B98A5B', wainR: '#A67A4E',
  trim: '#7A5636', comb: '#C9A979', deskTop: '#ECD6AA', deskL: '#D2B07A', deskR: '#B99560', panel: '#94724A',
  board: '#FBF6EA', frame: '#7A5636', bg0: '#1A1511', bg1: '#0E0C0A',
};
const NIGHT_TINT = '#141A2B';
const DUSK_TINT = '#FF9A55';

/** 0 at noon, 1 at night. */
export function nightFactor(h) {
  if (h >= 8 && h <= 16.5) return 0;
  if (h > 16.5 && h < 20) return easeInOut((h - 16.5) / 3.5);
  if (h >= 20 || h < 5) return 1;
  return 1 - easeInOut((h - 5) / 3);
}
function goldenFactor(h) {
  const d = Math.min(Math.abs(h - 18.3), Math.abs(h - 6.4));
  return clamp(1 - d / 1.6);
}
export function dayPhase(h) {
  if (h >= 5 && h < 8) return 'Morning shift';
  if (h >= 8 && h < 12) return 'Day shift';
  if (h >= 12 && h < 17) return 'Afternoon shift';
  if (h >= 17 && h < 20) return 'Evening shift';
  return 'Night shift';
}

export class OfficeScene {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{ getState: () => any, mini?: boolean, reduced?: () => boolean, hour?: () => number,
   *   onSound?: (name: string, n?: number) => void, honeyTarget?: () => ({x:number,y:number}|null),
   *   onHoney?: () => void, pad?: {l:number,r:number,t:number,b:number}, isTyping?: () => void }} opts
   */
  constructor(canvas, opts) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.opts = opts;
    this.mini = !!opts.mini;
    this.getState = opts.getState;
    this.reducedFn = opts.reduced || (() => false);
    this.hourFn = opts.hour || (() => { const d = new Date(); return d.getHours() + d.getMinutes() / 60; });
    this.sound = opts.onSound || (() => {});
    this.actors = new Map();
    this.slotOf = new Map();
    this.notes = new Map();
    this.melQueue = [];
    this.parts = [];
    this.sprites = new Map();
    this.jobId = null;
    this.celebrateUntil = 0;
    this.celebrateAt = 0;
    this.running = false;
    this.visible = true;
    this.last = 0;
    this.lastDraw = 0;
    this.now = 0;
    this.w = 0; this.h = 0; this.dpr = 1;
    this.levelSeen = new Map();
    this.calls = new Map();
    this.initialized = false;
    this.loop = this.loop.bind(this);
    this.hits = [];
    this.noteHits = [];
    this.highlight = null;
    this.dragTask = null;
    this.stars = Array.from({ length: 26 }, (_, i) => ({ u: ((i * 73) % 97) / 97, t: ((i * 41) % 61) / 61, r: 0.6 + ((i * 7) % 5) / 5, ph: i }));
    this.palAt = -1;
  }

  /* ---------- lifecycle ---------- */
  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.loop);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  resize(w, h) {
    if (!w || !h) return;
    this.w = w; this.h = h;
    let dpr = Math.min(window.devicePixelRatio || 1, this.mini ? 1.5 : 2);
    if (w * h * dpr * dpr > 3.4e6) dpr = Math.max(1, Math.sqrt(3.4e6 / (w * h)));
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    const pad = this.opts.pad || (this.mini ? { l: 4, r: 4, t: 6, b: 4 } : { l: 24, r: 24, t: 26, b: 20 });
    const span = RX + RY;
    const a = Math.min((w - pad.l - pad.r) / span, (h - pad.t - pad.b) / (span / 2 + (WALL + SLAB) * ZK));
    this.a = a; this.b = a / 2; this.c = a * ZK;
    const width = span * a;
    const height = span * this.b + (WALL + SLAB) * this.c;
    this.ox = pad.l + (w - pad.l - pad.r - width) / 2 + RY * a;
    this.oy = pad.t + (h - pad.t - pad.b - height) / 2 + WALL * this.c;
    this.k = (a * 1.45) / 64; // bee sprite scale: px per SVG unit
    this.buildPaths();
    this.bgGrad = null;
    if (!this.running) this.draw();
  }

  /** Screen point (CSS px) of a world point. */
  P(x, y, z = 0) { return [this.ox + (x - y) * this.a, this.oy + (x + y) * this.b - z * this.c]; }

  /* ---------- state sync ---------- */
  reduced() { return this.reducedFn(); }

  /** Creates and removes actors to match the crew. `animate` builds new desks with a little show. */
  syncCrew(animate = false) {
    const s = this.getState();
    const seen = new Set();
    for (const w of s.crew || []) {
      seen.add(w.id);
      let a = this.actors.get(w.id);
      if (!a) {
        a = this.addActor(w, animate && this.initialized);
      } else a.w = w;
    }
    for (const [id, a] of this.actors) {
      if (!seen.has(id) && !a.leaving) this.removeActor(a, this.initialized);
    }
    this.initialized = true;
  }

  addActor(w, animate) {
    const isMel = w.id === 'mel';
    let slot = -1;
    if (!isMel) {
      const used = new Set([...this.slotOf.values()]);
      slot = this.slotOf.get(w.id) ?? SLOTS.findIndex((_, i) => !used.has(i));
      if (slot < 0) slot = this.slotOf.size % SLOTS.length;
      this.slotOf.set(w.id, slot);
    }
    const desk = isMel ? null : { x: SLOTS[slot][0], y: SLOTS[slot][1] };
    const home = isMel ? { ...MEL_HOME } : { x: desk.x + DW / 2 + 0.05, y: desk.y - 0.42, z: SEAT_Z };
    const a = {
      id: w.id, w, isMel, slot, desk, home,
      pos: { ...home }, mode: 'idle', modeSince: this.now, pending: null, pendingSince: 0,
      status: 'idle', idleSince: this.now - 60000, route: [], seg: null, item: null,
      bubble: null, badge: null, hopAt: -9, squashAt: -9, blinkAt: this.now + rnd(1, 4), ph: Math.random() * 6.28,
      nextGlyph: 0, nextZ: 0, nextBubble: 0, alpha: 1, fadeAt: -9, build: animate ? this.now : -9, leaving: false,
      level: 1, sx: 0, sy: 0,
    };
    if (animate && !this.reduced()) {
      a.pos = { ...DOOR };
      a.alpha = 0;
      a.fadeAt = this.now + 1.4;
      a.route.push({ to: { ...home }, dur: 1.6, lift: 0.9, delay: 1.5 });
      this.sound('build');
    }
    this.actors.set(w.id, a);
    return a;
  }

  removeActor(a, animate) {
    if (!animate || this.reduced()) { this.actors.delete(a.id); this.slotOf.delete(a.id); return; }
    a.leaving = true;
    a.route = [{ to: { ...DOOR }, dur: 1.4, lift: 0.8, after: () => { this.actors.delete(a.id); this.slotOf.delete(a.id); } }];
    a.seg = null;
  }

  /** Full refresh after hello or a replay jump: no effects, just the right poses. */
  reset() {
    this.syncCrew(false);
    const s = this.getState();
    for (const a of this.actors.values()) {
      a.level = levelOf(s, a.id);
      this.levelSeen.set(a.id, a.level);
    }
    this.notes.clear();
    this.melQueue.length = 0;
    this.layoutNotes(true);
  }

  /* ---------- engine events ---------- */
  handle(ev) {
    const d = ev.data || {};
    const s = this.getState();
    const reduced = this.reduced();
    switch (ev.type) {
      case 'crew.hired': case 'crew.updated': case 'crew.fired':
        this.syncCrew(true);
        break;
      case 'chat.message': {
        if (!d.from || d.from === 'user' || d.from === 'system') break;
        const a = this.actors.get(d.from);
        if (!a) break;
        const text = cleanText(d.text);
        if (!text) break;
        a.bubble = { text, at: this.now, until: this.now + clamp(2.8 + text.length * 0.045, 3, 7) };
        this.sound('blip');
        break;
      }
      case 'job.refining': this.briefWrite = ev.jobId || true; break;
      case 'job.cancelled': case 'job.failed': this.briefWait = null; this.briefWrite = null; this.layoutNotes(false); break;
      case 'brief.proposed': {
        this.briefWrite = null;
        this.briefWait = ev.jobId || true;
        const mel = this.actors.get('mel');
        if (mel) { mel.bubble = { text: 'The brief is ready. Use it, edit it, or keep your words?', at: this.now, until: this.now + 6 }; this.sound('stuck'); }
        break;
      }
      case 'brief.approved': {
        this.briefWait = null; this.briefWrite = null;
        const mel = this.actors.get('mel');
        if (mel) { this.sparkle(mel, 8); this.sound('pop'); }
        if (d.by !== 'auto') this.melReact('nod');
        break;
      }
      case 'job.planning': {
        this.briefWait = null; this.briefWrite = null;
        const mel = this.actors.get('mel');
        if (mel) mel.bubble = { text: 'Planning...', at: this.now, until: this.now + 2.5 };
        break;
      }
      case 'job.planned':
      case 'task.added':
        this.layoutNotes(false);
        if (ev.type === 'task.added' && d.task?.kind === 'fix') {
          // QA walks the issue over to whoever fixes it.
          const t = s.tasks[d.task.id];
          if (t) this.handoff('qa', t.assignee, 'bad');
        }
        break;
      case 'task.status': {
        this.layoutNotes(false);
        const t = s.tasks[d.taskId];
        if (!t) break;
        const a = this.actors.get(t.assignee);
        if (d.status === 'done' && a) {
          this.honeyJar(a);
          this.sparkle(a, 10);
          a.hopAt = this.now;
          const next = Object.values(s.tasks).filter((x) => x.jobId === t.jobId && (x.dependsOn || []).includes(t.id) && x.assignee !== t.assignee && !['done', 'skipped'].includes(x.status));
          const to = [...new Set(next.map((x) => x.assignee))].slice(0, 2);
          for (const id of to) this.handoff(t.assignee, id, 'parcel');
          const lv = levelOf(s, t.assignee);
          if (lv > (this.levelSeen.get(t.assignee) || 1)) {
            this.levelSeen.set(t.assignee, lv);
            a.level = lv;
            this.label(a, `Level ${lv}!`, '#FFD072', 1.2);
            this.sparkle(a, 14);
            this.sound('level');
          }
        }
        if (d.status === 'failed' && a) { a.badge = { kind: 'bad', at: this.now, until: this.now + 3 }; this.sound('fail'); }
        break;
      }
      case 'task.updated':
        if (d.task?.assignee) {
          this.layoutNotes(false);
          this.handoff('mel', d.task.assignee, 'note');
        }
        break;
      case 'tool.called': {
        this.calls.set(d.callId, { workerId: d.workerId, tool: d.tool });
        const a = this.actors.get(d.workerId);
        if (!a) break;
        if (d.tool === 'write_file' || d.tool === 'edit_file') {
          for (let i = 0; i < (reduced ? 0 : 6); i++) this.glyph(a, true);
          this.sound('type');
        }
        break;
      }
      case 'tool.result': {
        const c = this.calls.get(d.callId);
        this.calls.delete(d.callId);
        if (!c) break;
        const a = this.actors.get(c.workerId);
        if (!a) break;
        if (c.tool === 'check') {
          const txt = typeof d.result === 'string' ? d.result : JSON.stringify(d.result || '');
          const ok = d.ok && !/issues found/i.test(txt);
          a.badge = { kind: ok ? 'ok' : 'bad', at: this.now, until: this.now + 2.6 };
          this.sound(ok ? 'pass' : 'fail');
        }
        break;
      }
      case 'run.finished': {
        const c = this.calls.get(d.callId);
        const a = this.actors.get(c?.workerId) || [...this.actors.values()].find((x) => x.status === 'tool');
        if (a) { a.badge = { kind: d.exitCode === 0 && !d.timedOut ? 'ok' : 'bad', at: this.now, until: this.now + 2.6 }; this.sound(d.exitCode === 0 ? 'pass' : 'fail'); }
        break;
      }
      case 'qa.report': {
        const a = this.actors.get('qa') || this.actors.get(s.tasks[d.taskId]?.assignee);
        if (a) {
          a.badge = { kind: d.passed ? 'ok' : 'bad', at: this.now, until: this.now + 3.4, big: true };
          if (d.passed) this.sparkle(a, 10);
          this.sound(d.passed ? 'pass' : 'fail');
        }
        break;
      }
      case 'file.changed': {
        const a = this.actors.get(d.workerId);
        if (a) this.label(a, `${d.op === 'create' ? '+ ' : ''}${String(d.path || '').split('/').pop()}`, '#BFE3C6', 0.8);
        break;
      }
      case 'approval.requested': {
        const a = this.actors.get(d.approval?.workerId);
        if (a) this.sound('stuck');
        break;
      }
      case 'approval.resolved':
        if (d.by === 'user') this.melReact(d.approved ? 'nod' : 'shake');
        break;
      case 'job.done':
        this.celebrate();
        break;
      case 'job.created':
        if (ev.type === 'job.created') this.melReact('curious');
        // falls through
      case 'job.resumed-noop':
      case 'job.resumed':
        this.layoutNotes(false);
        break;
      default: break;
    }
  }

  /* ---------- effects ---------- */
  celebrate() {
    this.celebrateAt = this.now;
    this.celebrateUntil = this.now + 6.5;
    this.sound('confetti');
    if (this.reduced()) return;
    const n = this.mini ? 40 : 150;
    const colors = ['#FFB531', '#FFD072', '#7DC49B', '#86A9D6', '#FF7AB6', '#F2E9DA', '#E57B6E'];
    for (let i = 0; i < n; i++) {
      this.spawn({ kind: 'confetti', x: rnd(this.w * 0.1, this.w * 0.9), y: rnd(-80, this.h * 0.15), vx: rnd(-40, 40), vy: rnd(10, 120), g: 140, life: rnd(3.2, 5.5), rot: rnd(0, 6.28), vr: rnd(-6, 6), size: rnd(5, 9), color: pick(colors), hex: Math.random() < 0.5 });
    }
    for (const a of this.actors.values()) this.sparkle(a, 8);
  }

  /** Mel answers what the user does: a nod on approve, a curious tilt on a new request. */
  melReact(kind) {
    const mel = this.actors.get('mel');
    if (!mel) return;
    mel.react = { kind, at: this.now };
    if (kind === 'nod') { this.sparkle(mel, 6); mel.bubble = { text: pick(['Thanks! On it.', 'Approved. Back to work.', 'Great, moving on.']), at: this.now, until: this.now + 2.6 }; }
    if (kind === 'curious') mel.bubble = { text: pick(['Ooh, a new request!', 'Interesting. Let me look.', 'A new job? Let me read it.']), at: this.now, until: this.now + 2.8 };
    if (kind === 'shake') mel.bubble = { text: 'Okay, we will skip that.', at: this.now, until: this.now + 2.6 };
    mel.idleSince = this.now;
  }

  handoff(fromId, toId, item) {
    const a = this.actors.get(fromId);
    const b = this.actors.get(toId);
    if (!a || !b || a === b || a.leaving) return;
    const spot = this.visitSpot(b);
    const color = item === 'bad' ? '#E57B6E' : a.w.color;
    a.route.push(
      { to: spot, dur: null, lift: 0.9, item, color, hold: 0.75, onArrive: () => { b.hopAt = this.now; this.sparkle(b, 6); this.sound('pop'); }, dropItem: true },
      { to: 'home', dur: null, lift: 0.7 },
    );
  }

  visitSpot(b) {
    if (b.isMel) return { x: MEL_HOME.x + 0.95, y: MEL_HOME.y + 0.9, z: 1.2 };
    return { x: b.desk.x + DW / 2 + 0.15, y: b.desk.y + DD + 0.55, z: 1.0 };
  }

  honeyJar(a) {
    const target = this.opts.honeyTarget?.();
    if (this.reduced() || !target) { this.opts.onHoney?.(); return; }
    this.spawn({ kind: 'jar', x0: a.sx, y0: a.sy - 30, x1: target.x, y1: target.y, t: 0, life: 1.25, max: 1.25, done: () => this.opts.onHoney?.() });
  }

  label(a, text, color, life = 1.4) {
    if (this.mini) return;
    this.spawn({ kind: 'label', x: a.sx + rnd(-6, 6), y: a.sy - 52 * this.k * 0.9, vy: -22, text, color, life, max: life });
  }

  sparkle(a, n) {
    for (let i = 0; i < n; i++) this.spawn({ kind: 'spark', x: a.sx + rnd(-26, 26) * this.k * 1.4, y: a.sy + rnd(-30, 10) * this.k * 1.4, vx: rnd(-30, 30), vy: rnd(-60, -10), g: 40, life: rnd(0.5, 1.1), size: rnd(2, 4.5), color: pick(['#FFD072', '#FFFFFF', a.w.color]) });
  }

  glyph(a, burst = false) {
    const kind = KIND[a.id] || 'hired';
    const base = this.P(a.desk ? a.desk.x + 0.75 : a.pos.x, a.desk ? a.desk.y + 0.3 : a.pos.y, a.desk ? DH + 0.55 : a.pos.z);
    if (kind === 'designer' && Math.random() < 0.5) {
      this.spawn({ kind: 'dot', x: base[0] + rnd(-14, 14), y: base[1], vx: rnd(-14, 14), vy: rnd(-48, -28), life: rnd(1, 1.6), size: rnd(2.5, 4.5), color: pick(['#FF7AB6', '#6CC4FF', '#FFD072', '#7DC49B']) });
      return;
    }
    this.spawn({ kind: 'glyph', x: base[0] + rnd(-16, 16), y: base[1] - rnd(0, 6), vx: rnd(-10, 10), vy: burst ? rnd(-70, -40) : rnd(-46, -30), life: rnd(1.1, 1.7), text: pick(GLYPHS[kind]), color: a.w.color || '#FFD072', size: this.mini ? 6 : Math.max(9, this.a * 0.2) });
  }

  spawn(p) {
    if (this.reduced() && p.kind !== 'jar') return;
    if (this.parts.length > 320) this.parts.shift();
    p.age = 0;
    if (p.max == null) p.max = p.life;
    this.parts.push(p);
  }

  /* ---------- kanban notes ---------- */
  currentJob() {
    const jobs = this.getState().jobs || [];
    for (let i = jobs.length - 1; i >= 0; i--) if (ACTIVE.has(jobs[i].status)) return jobs[i];
    return jobs[jobs.length - 1] || null;
  }

  noteSlot(col, i, n) {
    const cw = (BOARD.u1 - BOARD.u0 - 0.16) / 3;
    const top = BOARD.t0 + 0.44;
    const avail = BOARD.t1 - 0.1 - top - NOTE_H;
    const step = n > 1 ? Math.min(NOTE_H + 0.08, avail / (n - 1)) : 0;
    return { u: BOARD.u0 + 0.08 + col * cw + 0.1, t: top + i * step, w: cw - 0.2 };
  }

  /** Puts every task of the current job on the board. Column changes queue a move for Mel. */
  layoutNotes(instant) {
    const s = this.getState();
    const j = this.currentJob();
    const fast = instant || this.reduced() || !this.actors.get('mel');
    if (!j) { this.notes.clear(); return; }
    if (this.jobId !== j.id) {
      this.jobId = j.id;
      for (const n of this.notes.values()) n.gone = this.now;
      if (!instant) this.melQueue.length = 0;
    }
    const tasks = (j.taskIds || []).map((id) => s.tasks[id]).filter(Boolean);
    const byCol = [[], [], []];
    for (const t of tasks) byCol[COL_OF[t.status] ?? 0].push(t);
    for (let c = 0; c < 3; c++) {
      byCol[c].forEach((t, i) => {
        const slot = this.noteSlot(c, i, byCol[c].length);
        let n = this.notes.get(t.id);
        if (!n) {
          n = { id: t.id, col: c, u: slot.u, t: slot.t, w: slot.w, tu: slot.u, tt: slot.t, state: fast ? 'free' : 'hidden', pop: this.now, alpha: fast ? 1 : 0 };
          this.notes.set(t.id, n);
          if (!fast) this.melQueue.push({ type: 'place', note: n });
        }
        n.task = t;
        n.tu = slot.u; n.tt = slot.t; n.w = slot.w;
        if (n.col !== c) {
          n.col = c;
          if (fast) { n.pop = this.now; }
          else if (n.state === 'free') { n.state = 'held'; this.melQueue.push({ type: 'move', note: n }); }
        }
      });
    }
    for (const [id, n] of this.notes) {
      if (!tasks.some((t) => t.id === id) && !n.gone) n.gone = this.now;
      if (n.gone && this.now - n.gone > 0.6) this.notes.delete(id);
    }
  }

  notePoint(n, u = n.u, t = n.t) {
    return { x: u + n.w / 2 + 0.3, y: 0.62, z: WALL - t - NOTE_H - 0.18 };
  }

  pumpMel() {
    const mel = this.actors.get('mel');
    if (!mel) {
      for (const job of this.melQueue) { job.note.state = 'free'; job.note.alpha = 1; }
      this.melQueue.length = 0;
      return;
    }
    if (mel.seg || mel.route.length || !this.melQueue.length) return;
    const backlog = this.melQueue.length;
    const speed = backlog > 6 ? 0.45 : backlog > 3 ? 0.7 : 1;
    const job = this.melQueue.shift();
    const n = job.note;
    if (this.reduced()) { n.state = 'free'; n.alpha = 1; n.pop = this.now; n.u = n.tu; n.t = n.tt; return; }
    if (job.type === 'place') {
      mel.route.push({ to: this.notePoint(n, n.tu, n.tt), dur: 0.45 * speed, lift: 0.12, item: 'note', color: n.task?.assignee ? this.actors.get(n.task.assignee)?.w.color : '#FFB531', hold: 0.12 * speed,
        onArrive: () => { n.state = 'free'; n.u = n.tu; n.t = n.tt; n.alpha = 1; n.pop = this.now; this.sound('stick'); }, dropItem: true });
    } else {
      mel.route.push(
        { to: this.notePoint(n), dur: 0.5 * speed, lift: 0.15, hold: 0.12 * speed, onArrive: () => { n.state = 'carried'; this.sound('peel'); } },
        { to: () => this.notePoint(n, n.tu, n.tt), dur: 0.7 * speed, lift: 0.3, item: 'note', color: '#FFE08A', hold: 0.15 * speed,
          onArrive: () => { n.state = 'free'; n.u = n.tu; n.t = n.tt; n.pop = this.now; this.sound('stick'); }, dropItem: true },
      );
    }
    if (!this.melQueue.length) mel.route.push({ to: 'home', dur: null, lift: 0.25, delay: 0.3 });
  }

  /* ---------- per frame update ---------- */
  loop(ts) {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.loop);
    const calm = this.isCalm();
    const minGap = this.mini || calm ? 1000 / 30 - 2 : 0;
    if (ts - this.lastDraw < minGap) return;
    const dt = Math.min(0.05, (ts - this.last) / 1000);
    this.last = ts;
    this.lastDraw = ts;
    this.now += dt;
    this.update(dt);
    this.draw();
    this.opts.onFrame?.(this);
  }

  isCalm() {
    if (this.parts.length || this.melQueue.length || this.now < this.celebrateUntil) return false;
    for (const a of this.actors.values()) if (a.seg || a.route.length || (a.mode !== 'sleep' && a.mode !== 'idle' && a.mode !== 'paused')) return false;
    return true;
  }

  update(dt) {
    const s = this.getState();
    const reduced = this.reduced();
    const now = this.now;
    const jobRunning = (s.jobs || []).some((j) => ACTIVE.has(j.status));
    this.briefWaiting = !!this.briefWait || (s.jobs || []).some((j) => j.status === 'awaiting_brief');
    this.briefWriting = !!this.briefWrite || (s.jobs || []).some((j) => j.status === 'refining');
    this.pumpMel();
    // with nothing to do, Mel chats now and then so the office never feels frozen
    const mel = this.actors.get('mel');
    if (mel && !jobRunning && !this.mini && !mel.seg && !mel.bubble) {
      if (!this.nextIdleTalk) this.nextIdleTalk = now + 6;
      if (now > this.nextIdleTalk) {
        const lines = (s.jobs || []).length
          ? ['Nice work today, crew.', 'Board is clear. What is next?', 'I could use another job.', 'Honey stocks look good.']
          : ['Quiet day. Want to build something?', 'Type a request in the box above.', 'The crew is ready when you are.', 'A landing page? A small app? Just ask.'];
        mel.bubble = { text: pick(lines), at: now, until: now + 4 };
        mel.idleSince = now;
        mel.react = { kind: 'curious', at: now };
        this.nextIdleTalk = now + rnd(24, 34);
      }
    }
    let typing = 0;
    let flying = 0;
    for (const a of this.actors.values()) {
      const st = s.workers?.[a.id] || { status: 'idle' };
      if (st.status !== a.status) {
        if (st.status === 'idle') a.idleSince = now;
        a.status = st.status;
      }
      a.detail = st.detail;
      a.taskId = st.taskId;
      // mode with a little hysteresis so one turn ending does not flicker the pose
      const target = this.targetMode(a, st, jobRunning);
      if (target !== a.mode) {
        const soft = target === 'wait' || target === 'idle' || target === 'sleep';
        if (a.pending !== target) { a.pending = target; a.pendingSince = now; }
        if (!soft || now - a.pendingSince > 0.45 || reduced) { a.mode = target; a.modeSince = now; a.pending = null; }
      } else a.pending = null;

      // movement along the route
      if (!a.seg && a.route.length) {
        const next = a.route[0];
        if (next.delay && !next.waited) { next.waited = now + next.delay; }
        if (!next.waited || now >= next.waited) {
          a.route.shift();
          const to = typeof next.to === 'function' ? next.to() : next.to === 'home' ? { ...a.home } : next.to;
          const dist = Math.hypot(to.x - a.pos.x, to.y - a.pos.y);
          const dur = reduced ? 0 : next.dur ?? clamp(0.55 + dist * 0.12, 0.6, 2.2);
          a.seg = { ...next, from: { ...a.pos }, to, t0: now, dur, lift: (next.lift ?? 0.8) + dist * 0.05 };
          a.item = next.item || null;
          a.itemColor = next.color;
          if (dur > 0) { a.squashAt = now; this.sound('whoosh'); }
          else a.fadeAt = now;
        }
      }
      if (a.seg) {
        const g = a.seg;
        const u = g.dur ? clamp((now - g.t0) / g.dur) : 1;
        const e = easeInOut(u);
        a.pos.x = lerp(g.from.x, g.to.x, e);
        a.pos.y = lerp(g.from.y, g.to.y, e);
        a.pos.z = lerp(g.from.z, g.to.z, e) + Math.sin(Math.PI * u) * g.lift;
        a.flyU = u;
        if (u >= 1 && !g.arrived) {
          g.arrived = now;
          a.squashAt = now;
          g.onArrive?.();
          if (g.dropItem) a.item = null;
        }
        if (g.arrived && now - g.arrived >= (g.hold || 0)) {
          a.seg = null;
          g.after?.();
          if (!a.route.length) a.item = null;
        }
        if (a.seg && a.seg.dur && !a.seg.arrived) flying++;
      } else {
        // drift home smoothly
        const hx = a.mode === 'plan' && a.isMel ? a.home.x + Math.sin(now * 0.7) * 1.3 : a.home.x;
        const k = 1 - Math.pow(0.002, dt);
        a.pos.x = lerp(a.pos.x, hx, k);
        a.pos.y = lerp(a.pos.y, a.home.y, k);
        a.pos.z = lerp(a.pos.z, a.home.z + (a.mode === 'sleep' || a.mode === 'paused' ? -0.2 : 0), k);
        a.flyU = null;
      }

      if (a.fadeAt > 0) a.alpha = clamp((now - a.fadeAt) / 0.35);
      if (a.leaving && a.seg) a.alpha = 1 - clamp((now - a.seg.t0) / (a.seg.dur || 0.3));

      // ambient effects by mode
      if (!reduced && !a.seg) {
        if (a.mode === 'type') {
          typing++;
          if (now > a.nextGlyph) { this.glyph(a); a.nextGlyph = now + rnd(0.12, 0.26); }
        } else if (a.mode === 'sleep' || a.mode === 'paused') {
          if (now > a.nextZ) { this.spawn({ kind: 'z', x: a.sx + 10 * this.k * 1.3, y: a.sy - 18 * this.k * 1.3, vx: rnd(8, 16), vy: -16, life: 2.2, size: this.mini ? 6 : Math.max(9, this.a * 0.2) }); a.nextZ = now + 1.1; }
        } else if (a.mode === 'test') {
          if (now > a.nextGlyph) { this.spawn({ kind: 'bubble', x: a.sx + rnd(-8, 8) + 30 * this.k, y: a.sy - 52 * this.k, vx: rnd(-6, 6), vy: rnd(-34, -20), life: rnd(0.7, 1.2), size: rnd(1.5, 3.2), color: '#7DC49B' }); a.nextGlyph = now + rnd(0.08, 0.2); }
        } else if (a.mode === 'plan') {
          if (now > a.nextGlyph) { this.glyph(a); a.nextGlyph = now + rnd(0.3, 0.5); }
        } else if (a.mode === 'celebrate' && Math.random() < dt * 3) this.sparkle(a, 1);
      }
      if (now > a.blinkAt + 0.14) a.blinkAt = now + rnd(2.2, 5.5);
      if (a.bubble && now > a.bubble.until) a.bubble = null;
      if (a.badge && now > a.badge.until) a.badge = null;
    }
    this.typingCount = typing;
    this.flyingCount = flying;

    // notes ease toward their slots
    for (const n of this.notes.values()) {
      if (n.state === 'free') {
        const k = reduced ? 1 : 1 - Math.pow(0.0005, dt);
        n.u = lerp(n.u, n.tu, k);
        n.t = lerp(n.t, n.tt, k);
      }
    }

    // particles
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const p = this.parts[i];
      p.age += dt;
      if (p.age >= p.max) { this.parts.splice(i, 1); p.done?.(); continue; }
      if (p.kind === 'jar') continue;
      p.vy += (p.g || 0) * dt;
      if (p.kind === 'confetti') { p.vx *= 1 - dt * 0.6; p.vy = Math.min(p.vy, 150); p.rot += p.vr * dt; p.x += Math.sin(p.age * 3 + p.rot) * 12 * dt; }
      p.x += (p.vx || 0) * dt;
      p.y += (p.vy || 0) * dt;
    }
  }

  targetMode(a, st, jobRunning) {
    if (a.leaving) return 'fly';
    if (this.now < this.celebrateUntil) return 'celebrate';
    if (a.w.paused) return 'paused';
    if (a.isMel && st.status === 'idle') {
      if (this.briefWaiting) return 'stuck';
      if (this.briefWriting) return 'plan';
    }
    switch (st.status) {
      case 'waiting_approval': return 'stuck';
      case 'queued': return 'wait';
      case 'thinking': return a.isMel ? 'plan' : 'type';
      case 'tool': {
        const tool = String(st.detail || '').split(' ')[0];
        if (tool === 'run' || tool === 'check' || tool === 'report') return 'test';
        if (tool === 'read_file' || tool === 'list_files' || tool === 'preview') return 'read';
        return 'type';
      }
      case 'error': return 'error';
      default: {
        const since = this.now - a.idleSince;
        return since > (jobRunning ? 8 : 2.5) ? 'sleep' : 'idle';
      }
    }
  }

  /* ---------- drawing ---------- */
  palette() {
    const h = this.hourFn();
    const key = Math.round(h * 12);
    if (key === this.palAt && this.pal) return this.pal;
    this.palAt = key;
    const night = nightFactor(h);
    const gold = goldenFactor(h) * (1 - night * 0.6);
    const out = { night, gold, hour: h };
    for (const [k, v] of Object.entries(DAY)) {
      if (k === 'bg0' || k === 'bg1') { out[k] = v; continue; }
      let c = mixHex(v, NIGHT_TINT, night * 0.52);
      if (gold) c = mixHex(c, DUSK_TINT, gold * 0.1);
      out[k] = c;
    }
    this.pal = out;
    this.combLeft = null;
    return out;
  }

  buildPaths() {
    // hexagon floor tiles, three soft shades, in floor units
    const r = 0.44;
    const hw = Math.sqrt(3) * r;
    const vh = 1.5 * r;
    const fill = [new Path2D(), new Path2D(), new Path2D()];
    const grout = new Path2D();
    for (let row = -1; row * vh < RY + r; row++) {
      for (let col = -1; col * hw < RX + hw; col++) {
        const cx = col * hw + (row & 1 ? hw / 2 : 0);
        const cy = row * vh;
        const q = col - (row - (row & 1)) / 2;
        const shadeIdx = (((q - row) % 3) + 3) % 3;
        const path = new Path2D();
        for (let i = 0; i < 6; i++) {
          const ang = (Math.PI / 180) * (60 * i - 30);
          const px = cx + r * Math.cos(ang);
          const py = cy + r * Math.sin(ang);
          if (i === 0) path.moveTo(px, py); else path.lineTo(px, py);
        }
        path.closePath();
        fill[shadeIdx].addPath(path);
        grout.addPath(path);
      }
    }
    this.floorFill = fill;
    this.floorGrout = grout;
    // honeycomb wallpaper (wall units, t grows downward)
    const wr = 0.2;
    const comb = new Path2D();
    const whw = Math.sqrt(3) * wr;
    for (let row = 0; row * 1.5 * wr < WALL; row++) {
      for (let col = -1; col * whw < Math.max(RX, RY) + 1; col++) {
        const cx = col * whw + (row & 1 ? whw / 2 : 0);
        const cy = row * 1.5 * wr;
        for (let i = 0; i < 6; i++) {
          const ang = (Math.PI / 180) * (60 * i - 30);
          const px = cx + wr * 0.9 * Math.cos(ang);
          const py = cy + wr * 0.9 * Math.sin(ang);
          if (i === 0) comb.moveTo(px, py); else comb.lineTo(px, py);
        }
        comb.closePath();
      }
    }
    this.comb = comb;
  }

  base() { this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); }
  floorT() { const d = this.dpr; this.ctx.setTransform(d * this.a, d * this.b, -d * this.a, d * this.b, d * this.ox, d * this.oy); }
  /** Right wall (y = 0): u along x, t down from the top of the wall. */
  rightT(k = 1) { const d = this.dpr; this.ctx.setTransform((d * this.a) / k, (d * this.b) / k, 0, (d * this.c) / k, d * this.ox, d * (this.oy - WALL * this.c)); }
  /** Left wall (x = 0): u = RY - y so text reads left to right, t down from the top. */
  leftT(k = 1) { const d = this.dpr; this.ctx.setTransform((d * this.a) / k, (-d * this.b) / k, 0, (d * this.c) / k, d * (this.ox - RY * this.a), d * (this.oy + RY * this.b - WALL * this.c)); }

  poly(pts, fill, stroke, lw = 1) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke(); }
  }

  box(x, y, z, dx, dy, dz, top, left, right, edge = 'rgba(36,22,12,.32)') {
    const P = (X, Y, Z) => this.P(X, Y, Z);
    this.poly([P(x, y + dy, z), P(x + dx, y + dy, z), P(x + dx, y + dy, z + dz), P(x, y + dy, z + dz)], left, edge);
    this.poly([P(x + dx, y, z), P(x + dx, y + dy, z), P(x + dx, y + dy, z + dz), P(x + dx, y, z + dz)], right, edge);
    this.poly([P(x, y, z + dz), P(x + dx, y, z + dz), P(x + dx, y + dy, z + dz), P(x, y + dy, z + dz)], top, edge);
  }

  cyl(x, y, z, r, hgt, body, top) {
    const ctx = this.ctx;
    const [bx, by] = this.P(x, y, z);
    const [, ty] = this.P(x, y, z + hgt);
    const rx = r * this.a * 1.414;
    const ry = rx / 2;
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.ellipse(bx, by, rx, ry, 0, 0, Math.PI);
    ctx.lineTo(bx - rx, ty);
    ctx.ellipse(bx, ty, rx, ry, 0, Math.PI, 0, true);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(36,22,12,.35)'; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = top;
    ctx.beginPath(); ctx.ellipse(bx, ty, rx, ry, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }

  draw() {
    if (!this.w) return;
    this.hits = [];
    const ctx = this.ctx;
    const pal = this.palette();
    this.base();
    // backdrop
    if (!this.bgGrad) {
      const g = ctx.createRadialGradient(this.w * 0.5, this.h * 0.42, 10, this.w * 0.5, this.h * 0.5, Math.max(this.w, this.h) * 0.75);
      g.addColorStop(0, '#221B15'); g.addColorStop(1, '#0C0A08');
      this.bgGrad = g;
    }
    ctx.fillStyle = this.bgGrad;
    ctx.fillRect(0, 0, this.w, this.h);

    this.drawRoom(pal);
    this.drawShadows();
    this.drawBoard(pal);

    // depth sorted things
    const list = [];
    for (const a of this.actors.values()) {
      if (a.desk) list.push({ k: a.desk.x + DW / 2 + a.desk.y + DD / 2, f: () => this.drawDesk(a, pal) });
      if (a.desk) list.push({ k: a.home.x + a.home.y - 0.35, f: () => this.drawChair(a, pal) });
      list.push({ k: a.pos.x + a.pos.y + (a.seg ? 0.2 : 0), f: () => this.drawBee(a) });
    }
    list.push({ k: MEL_HOME.x + MEL_HOME.y - 0.05, f: () => this.drawPodium(pal) });
    list.push({ k: 0.6 + 9.3, f: () => this.drawPlant(0.6, 9.3, 1.0) });
    list.push({ k: 13.4 + 0.65, f: () => this.drawPlant(13.4, 0.65, 0.9) });
    list.push({ k: 13.3 + 4.9, f: () => this.drawPlant(13.3, 4.9, 1.15) });
    list.push({ k: 13.1 + 9.1, f: () => this.drawCooler(13.1, 9.1, pal) });
    list.push({ k: 0.4 + 1.2, f: () => this.drawShelfUnit(pal) });
    list.sort((p, q) => p.k - q.k);
    for (const it of list) it.f();

    this.drawLights(pal);
    this.drawOverlay(pal);
    this.drawParticles();
  }

  drawRoom(pal) {
    const ctx = this.ctx;
    const P = (x, y, z) => this.P(x, y, z);
    // floor slab
    this.poly([P(-0.16, RY, 0), P(RX, RY, 0), P(RX, RY, -SLAB), P(-0.16, RY, -SLAB)], pal.slabL, 'rgba(0,0,0,.35)');
    this.poly([P(RX, -0.16, 0), P(RX, RY, 0), P(RX, RY, -SLAB), P(RX, -0.16, -SLAB)], pal.slabR, 'rgba(0,0,0,.35)');
    // floor tiles
    this.floorT();
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, RX, RY); ctx.clip();
    ctx.fillStyle = pal.floorA; ctx.fill(this.floorFill[0]);
    ctx.fillStyle = pal.floorB; ctx.fill(this.floorFill[1]);
    ctx.fillStyle = pal.floorC; ctx.fill(this.floorFill[2]);
    ctx.strokeStyle = pal.grout; ctx.lineWidth = 0.035; ctx.stroke(this.floorGrout);
    // honey rug under the crew
    ctx.beginPath();
    hexPath(ctx, 6.6, 5.5, 4.2);
    ctx.fillStyle = alpha(pal.rug, 0.16); ctx.fill();
    ctx.lineWidth = 0.06; ctx.strokeStyle = alpha(pal.rug, 0.38); ctx.stroke();
    ctx.beginPath(); hexPath(ctx, 6.6, 5.5, 3.85);
    ctx.lineWidth = 0.025; ctx.setLineDash([0.12, 0.1]); ctx.stroke(); ctx.setLineDash([]);
    // daylight from the windows
    if (pal.night < 0.85) {
      const al = (1 - pal.night) * 0.13 + pal.gold * 0.05;
      ctx.fillStyle = pal.gold > 0.3 ? `rgba(255,190,120,${al})` : `rgba(255,240,200,${al})`;
      for (const [y0, y1] of [[2.2, 4.0], [5.6, 7.4]]) {
        ctx.beginPath(); ctx.moveTo(0, y0); ctx.lineTo(0, y1); ctx.lineTo(2.6, y1 + 1.5); ctx.lineTo(2.6, y0 + 1.5); ctx.closePath(); ctx.fill();
      }
    }
    ctx.restore();
    this.base();
    // walls
    this.poly([P(0, 0, 0), P(0, RY, 0), P(0, RY, WALL), P(0, 0, WALL)], pal.wallL);
    this.poly([P(0, 0, 0), P(RX, 0, 0), P(RX, 0, WALL), P(0, 0, WALL)], pal.wallR);
    // honeycomb wallpaper, a soft wainscot and the trim
    for (const side of ['L', 'R']) {
      if (side === 'L') this.leftT(); else this.rightT();
      ctx.save();
      ctx.beginPath(); ctx.rect(0, 0, side === 'L' ? RY : RX, WALL - 0.8); ctx.clip();
      ctx.strokeStyle = alpha(pal.comb, 0.55); ctx.lineWidth = 0.012; ctx.stroke(this.comb);
      ctx.restore();
      ctx.fillStyle = side === 'L' ? pal.wainL : pal.wainR;
      ctx.fillRect(0, WALL - 0.8, side === 'L' ? RY : RX, 0.8);
      ctx.fillStyle = pal.trim;
      ctx.fillRect(0, WALL - 0.84, side === 'L' ? RY : RX, 0.06);
      ctx.fillRect(0, WALL - 0.1, side === 'L' ? RY : RX, 0.1);
      // vertical wainscot boards
      ctx.strokeStyle = 'rgba(36,22,12,.13)'; ctx.lineWidth = 0.02;
      ctx.beginPath();
      for (let u = 0.5; u < (side === 'L' ? RY : RX); u += 0.5) { ctx.moveTo(u, WALL - 0.78); ctx.lineTo(u, WALL - 0.1); }
      ctx.stroke();
      // a soft shade toward the corner
      const g = ctx.createLinearGradient(side === 'L' ? RY : 0, 0, side === 'L' ? RY - 2.5 : 2.5, 0);
      g.addColorStop(0, 'rgba(36,22,12,.22)'); g.addColorStop(1, 'rgba(36,22,12,0)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, side === 'L' ? RY : RX, WALL);
    }
    this.base();
    // wall caps and ends, so the room reads as a little diorama
    const T = 0.16;
    this.poly([P(0, 0, WALL), P(0, RY, WALL), P(-T, RY, WALL), P(-T, -T, WALL), P(RX, -T, WALL), P(RX, 0, WALL)], shade(pal.trim, 0.25), 'rgba(36,22,12,.5)');
    this.poly([P(-T, RY, 0), P(0, RY, 0), P(0, RY, WALL), P(-T, RY, WALL)], shade(pal.trim, -0.1), 'rgba(36,22,12,.5)');
    this.poly([P(RX, -T, 0), P(RX, 0, 0), P(RX, 0, WALL), P(RX, -T, WALL)], shade(pal.trim, -0.25), 'rgba(36,22,12,.5)');
    this.poly([P(0, 0, 0), P(0, 0, WALL)], null, 'rgba(36,22,12,.25)');

    this.drawWindows(pal);
    this.drawDoor(pal);
    this.drawClock(pal);
    this.drawHoneyShelf(pal);
  }

  drawWindows(pal) {
    const ctx = this.ctx;
    const h = pal.hour;
    const night = pal.night;
    const top = mixHex(mixHex('#78B9E6', '#0B1430', night), '#4A3F7E', pal.gold * 0.7);
    const bot = mixHex(mixHex('#D6EEF8', '#1E2B4E', night), '#F5A766', pal.gold * 0.85);
    this.leftT();
    for (const [u0, u1] of [[2.6, 4.4], [6.0, 7.8]]) {
      const t0 = WALL - 2.28; const t1 = WALL - 0.98;
      ctx.save();
      ctx.beginPath(); ctx.rect(u0, t0, u1 - u0, t1 - t0); ctx.clip();
      const g = ctx.createLinearGradient(0, t0, 0, t1);
      g.addColorStop(0, top); g.addColorStop(1, bot);
      ctx.fillStyle = g; ctx.fillRect(u0, t0, u1 - u0, t1 - t0);
      if (night > 0.4) {
        ctx.fillStyle = `rgba(255,255,240,${(night - 0.4) * 1.4})`;
        for (const s of this.stars) {
          const tw = 0.6 + 0.4 * Math.sin(this.now * 1.5 + s.ph);
          ctx.globalAlpha = tw;
          ctx.fillRect(u0 + s.u * (u1 - u0), t0 + s.t * (t1 - t0) * 0.75, 0.025 * s.r, 0.025 * s.r);
        }
        ctx.globalAlpha = 1;
      }
      if (u0 > 5) {
        // sun or moon, its height follows the clock
        const arc = night > 0.5 ? (((h + 24 - 19) % 24) / 11) : clamp((h - 6) / 13);
        const cy = t0 + 0.3 + Math.abs(arc - 0.5) * 1.6;
        const cx = u0 + 0.5 + arc * 0.8;
        if (night > 0.5) {
          ctx.fillStyle = '#F4EBCF'; ctx.beginPath(); ctx.arc(cx, cy, 0.17, 0, 6.28); ctx.fill();
          ctx.fillStyle = top; ctx.beginPath(); ctx.arc(cx + 0.07, cy - 0.04, 0.15, 0, 6.28); ctx.fill();
        } else {
          ctx.fillStyle = 'rgba(255,236,170,.35)'; ctx.beginPath(); ctx.arc(cx, cy, 0.32, 0, 6.28); ctx.fill();
          ctx.fillStyle = pal.gold > 0.3 ? '#FFC072' : '#FFF1B8'; ctx.beginPath(); ctx.arc(cx, cy, 0.19, 0, 6.28); ctx.fill();
        }
      }
      // drifting clouds (or a faint mist at night)
      ctx.fillStyle = night > 0.5 ? 'rgba(160,170,210,.12)' : 'rgba(255,255,255,.75)';
      const span = u1 - u0 + 1.2;
      for (let i = 0; i < 2; i++) {
        const cx = u0 - 0.6 + ((this.now * 0.03 + i * 0.55 + u0) % 1) * span;
        const cy = t0 + 0.45 + i * 0.38;
        ctx.beginPath(); ctx.ellipse(cx, cy, 0.3, 0.08, 0, 0, 6.28); ctx.ellipse(cx + 0.18, cy - 0.06, 0.16, 0.09, 0, 0, 6.28); ctx.fill();
      }
      // a hint of the city skyline
      ctx.fillStyle = mixHex('#5E6B86', '#0A0F1E', night);
      for (let i = 0; i < 7; i++) { const bw = 0.22 + ((i * 37) % 5) * 0.03; const bh = 0.12 + ((i * 53) % 7) * 0.05; ctx.fillRect(u0 + i * 0.27, t1 - bh, bw, bh); }
      if (night > 0.5) {
        ctx.fillStyle = 'rgba(255,208,114,.8)';
        for (let i = 0; i < 9; i++) ctx.fillRect(u0 + 0.06 + ((i * 29) % 17) * 0.1, t1 - 0.05 - ((i * 13) % 5) * 0.05, 0.03, 0.025);
      }
      ctx.restore();
      // frame and mullions
      ctx.strokeStyle = shade(pal.trim, 0.1); ctx.lineWidth = 0.07;
      ctx.strokeRect(u0, t0, u1 - u0, t1 - t0);
      ctx.lineWidth = 0.04;
      ctx.beginPath(); ctx.moveTo((u0 + u1) / 2, t0); ctx.lineTo((u0 + u1) / 2, t1); ctx.moveTo(u0, (t0 + t1) / 2); ctx.lineTo(u1, (t0 + t1) / 2); ctx.stroke();
      ctx.fillStyle = shade(pal.trim, 0.2); ctx.fillRect(u0 - 0.08, t1, u1 - u0 + 0.16, 0.07);
    }
    this.base();
  }

  drawDoor(pal) {
    const ctx = this.ctx;
    this.rightT();
    const u0 = 11.9; const u1 = 13.0; const t0 = WALL - 2.05;
    ctx.fillStyle = shade(pal.trim, 0.05); ctx.fillRect(u0 - 0.06, t0 - 0.06, u1 - u0 + 0.12, WALL - t0 + 0.06);
    ctx.fillStyle = mixHex('#C98F4E', NIGHT_TINT, pal.night * 0.45); ctx.fillRect(u0, t0, u1 - u0, WALL - t0);
    // a hexagon window in the door
    ctx.fillStyle = mixHex('#FFE7A8', '#2B3352', pal.night);
    ctx.beginPath(); hexPath(ctx, (u0 + u1) / 2, t0 + 0.5, 0.22); ctx.fill();
    ctx.strokeStyle = OUT; ctx.lineWidth = 0.025; ctx.stroke();
    ctx.fillStyle = '#FFD072'; ctx.beginPath(); ctx.arc(u1 - 0.14, t0 + 1.1, 0.04, 0, 6.28); ctx.fill();
    ctx.strokeStyle = 'rgba(36,22,12,.25)'; ctx.lineWidth = 0.02; ctx.strokeRect(u0 + 0.12, t0 + 0.9, u1 - u0 - 0.24, 0.9);
    this.base();
  }

  drawClock(pal) {
    const ctx = this.ctx;
    this.rightT();
    const cu = 8.25; const ct = 0.78; const r = 0.34;
    ctx.fillStyle = shade(pal.trim, -0.1); ctx.beginPath(); ctx.arc(cu, ct, r + 0.05, 0, 6.28); ctx.fill();
    ctx.fillStyle = '#FFF8EA'; ctx.beginPath(); ctx.arc(cu, ct, r, 0, 6.28); ctx.fill();
    ctx.strokeStyle = OUT; ctx.lineWidth = 0.02;
    for (let i = 0; i < 12; i++) {
      const an = (i / 12) * 6.283;
      ctx.beginPath(); ctx.moveTo(cu + Math.sin(an) * r * 0.82, ct - Math.cos(an) * r * 0.82); ctx.lineTo(cu + Math.sin(an) * r * 0.92, ct - Math.cos(an) * r * 0.92); ctx.stroke();
    }
    const h = pal.hour;
    const mins = (h % 1) * 60;
    const ha = ((h % 12) / 12) * 6.283;
    const ma = (mins / 60) * 6.283;
    ctx.lineCap = 'round';
    ctx.lineWidth = 0.045; ctx.beginPath(); ctx.moveTo(cu, ct); ctx.lineTo(cu + Math.sin(ha) * r * 0.5, ct - Math.cos(ha) * r * 0.5); ctx.stroke();
    ctx.lineWidth = 0.03; ctx.beginPath(); ctx.moveTo(cu, ct); ctx.lineTo(cu + Math.sin(ma) * r * 0.75, ct - Math.cos(ma) * r * 0.75); ctx.stroke();
    ctx.lineCap = 'butt';
    ctx.fillStyle = '#E8951E'; ctx.beginPath(); ctx.arc(cu, ct, 0.035, 0, 6.28); ctx.fill();
    this.base();
  }

  /** A wall shelf that fills with honey jars as tasks get done. */
  drawHoneyShelf(pal) {
    const ctx = this.ctx;
    const s = this.getState();
    const done = Object.values(s.tasks || {}).filter((t) => t.status === 'done').length;
    this.rightT();
    const u0 = 9.15; const u1 = 11.45; const t = 1.42;
    for (let row = 0; row < 2; row++) {
      const ty = t + row * 0.5;
      ctx.fillStyle = shade(pal.trim, 0.1); ctx.fillRect(u0, ty, u1 - u0, 0.06);
      ctx.fillStyle = 'rgba(36,22,12,.2)'; ctx.fillRect(u0, ty + 0.06, u1 - u0, 0.04);
      const n = clamp(done - row * 8, 0, 8);
      for (let i = 0; i < n; i++) {
        const cx = u0 + 0.16 + i * 0.27;
        ctx.fillStyle = '#F3A42A'; roundRect(ctx, cx - 0.09, ty - 0.24, 0.18, 0.24, 0.05); ctx.fill();
        ctx.fillStyle = '#FFD072'; ctx.fillRect(cx - 0.06, ty - 0.17, 0.04, 0.12);
        ctx.fillStyle = '#7A4A1E'; ctx.fillRect(cx - 0.1, ty - 0.29, 0.2, 0.06);
      }
    }
    ctx.fillStyle = alpha(pal.trim, 0.9);
    ctx.font = `700 13px ${FONT}`;
    this.rightT(100);
    ctx.fillStyle = 'rgba(36,22,12,.55)';
    ctx.font = `700 12px ${FONT}`;
    ctx.fillText(done > 16 ? `HONEY  ${done}` : 'HONEY', u0 * 100, (t - 0.42) * 100);
    this.base();
  }

  drawBoard(pal) {
    const ctx = this.ctx;
    const { u0, u1, t0, t1 } = BOARD;
    this.rightT();
    // frame and cork
    ctx.fillStyle = 'rgba(36,22,12,.25)'; ctx.fillRect(u0 + 0.06, t0 + 0.08, u1 - u0, t1 - t0);
    ctx.fillStyle = pal.frame; ctx.fillRect(u0 - 0.07, t0 - 0.07, u1 - u0 + 0.14, t1 - t0 + 0.14);
    ctx.fillStyle = pal.board; ctx.fillRect(u0, t0, u1 - u0, t1 - t0);
    const cw = (u1 - u0 - 0.16) / 3;
    ctx.strokeStyle = 'rgba(36,22,12,.14)'; ctx.lineWidth = 0.02;
    ctx.beginPath();
    for (let c = 1; c < 3; c++) { const x = u0 + 0.08 + c * cw; ctx.moveTo(x, t0 + 0.08); ctx.lineTo(x, t1 - 0.06); }
    ctx.moveTo(u0 + 0.08, t0 + 0.36); ctx.lineTo(u1 - 0.08, t0 + 0.36);
    ctx.stroke();
    // marker tray
    ctx.fillStyle = shade(pal.frame, 0.15); ctx.fillRect(u0 + 0.5, t1 + 0.06, 1.4, 0.07);
    ctx.fillStyle = '#E57B6E'; ctx.fillRect(u0 + 0.62, t1 + 0.02, 0.28, 0.05);
    ctx.fillStyle = '#86A9D6'; ctx.fillRect(u0 + 1.0, t1 + 0.02, 0.28, 0.05);
    // column titles
    this.rightT(100);
    ctx.font = `750 ${this.mini ? 20 : 16}px ${FONT}`;
    ctx.textBaseline = 'middle';
    const counts = [0, 0, 0];
    for (const n of this.notes.values()) if (!n.gone) counts[n.col]++;
    COLS.forEach((name, c) => {
      const x = (u0 + 0.08 + c * cw + 0.1) * 100;
      ctx.fillStyle = ['#8C6A3E', '#C77A14', '#3F8A5E'][c];
      ctx.fillText(name.toUpperCase(), x, (t0 + 0.2) * 100);
      ctx.fillStyle = 'rgba(36,22,12,.4)';
      ctx.fillText(String(counts[c]), (u0 + 0.08 + (c + 1) * cw - 0.2) * 100, (t0 + 0.2) * 100);
    });
    ctx.textBaseline = 'alphabetic';
    // an empty board says so, with a little doodle
    let live = 0;
    for (const n of this.notes.values()) if (!n.gone) live++;
    if (!live && !this.mini) {
      const cu = (u0 + u1) / 2; const ct = (t0 + t1) / 2 + 0.15;
      this.rightT();
      ctx.strokeStyle = 'rgba(122,86,54,.45)'; ctx.lineWidth = 0.025; ctx.setLineDash([0.08, 0.06]);
      ctx.beginPath(); hexPath(ctx, cu - 1.25, ct - 0.05, 0.28); ctx.stroke(); ctx.setLineDash([]);
      // a doodled bee on a loop
      const bx = cu - 1.25 + Math.cos(this.now * 0.9) * 0.05; const by = ct - 0.05 + Math.sin(this.now * 1.3) * 0.03;
      ctx.fillStyle = '#F3A42A'; ctx.beginPath(); ctx.ellipse(bx, by, 0.11, 0.08, 0, 0, 6.28); ctx.fill();
      ctx.fillStyle = '#2B1D12'; ctx.fillRect(bx - 0.02, by - 0.08, 0.03, 0.16);
      ctx.fillStyle = 'rgba(255,255,255,.85)'; ctx.beginPath(); ctx.ellipse(bx - 0.03, by - 0.11, 0.06, 0.035, -0.5, 0, 6.28); ctx.fill();
      this.rightT(100);
      ctx.fillStyle = 'rgba(43,29,18,.62)'; ctx.font = `700 19px ${FONT}`;
      ctx.fillText('Nothing on the board yet', (cu - 0.8) * 100, (ct - 0.08) * 100);
      ctx.fillStyle = 'rgba(43,29,18,.42)'; ctx.font = `600 14px ${FONT}`;
      ctx.fillText('Ask the crew in the box above', (cu - 0.8) * 100, (ct + 0.16) * 100);
    }
    // the notes
    this.noteHits = [];
    for (const n of this.notes.values()) {
      if (n.state === 'hidden' || n.state === 'carried') continue;
      const fade = n.gone ? 1 - clamp((this.now - n.gone) / 0.5) : 1;
      if (fade <= 0) continue;
      this.drawNote(n, fade);
    }
    this.base();
  }

  drawNote(n, fade) {
    const ctx = this.ctx;
    const t = n.task || {};
    const pop = this.reduced() ? 1 : easeOutBack(clamp((this.now - n.pop) / 0.35));
    const sc = 0.6 + 0.4 * pop;
    const w = n.w; const hgt = NOTE_H;
    const cx = n.u + w / 2; const cy = n.t + hgt / 2;
    this.rightT();
    ctx.save();
    ctx.globalAlpha = fade * (this.reduced() ? clamp((this.now - n.pop) / 0.3, 0.2, 1) : 1);
    ctx.translate(cx, cy);
    ctx.scale(sc, sc);
    ctx.rotate(((hash(n.id) % 7) - 3) * 0.012);
    const failed = t.status === 'failed' || t.status === 'blocked';
    const color = failed ? '#F6B3A8' : t.status === 'done' ? '#C6E8CD' : t.status === 'skipped' ? '#DDD5C8' : n.col === 1 ? '#FFD488' : '#FFEB9C';
    ctx.fillStyle = 'rgba(36,22,12,.18)'; ctx.fillRect(-w / 2 + 0.03, -hgt / 2 + 0.04, w, hgt);
    ctx.fillStyle = color; ctx.fillRect(-w / 2, -hgt / 2, w, hgt);
    const a = this.actors.get(t.assignee);
    ctx.fillStyle = a?.w.color || '#FFB531'; ctx.fillRect(-w / 2, -hgt / 2, 0.05, hgt);
    if (this.highlight === n.id || this.dragTask === n.id) { ctx.strokeStyle = '#E8951E'; ctx.lineWidth = 0.035; ctx.strokeRect(-w / 2 - 0.02, -hgt / 2 - 0.02, w + 0.04, hgt + 0.04); }
    ctx.scale(0.01, 0.01);
    if (!this.mini) {
      ctx.fillStyle = '#2B1D12';
      ctx.font = `650 16px ${FONT}`;
      const right = t.status === 'done' || failed ? 0.2 : 0.06;
      const line = wrap(ctx, t.title || '', (w - 0.12 - right) * 100, 1)[0] || '';
      ctx.fillText(line, (-w / 2 + 0.07) * 100, 0.07 * 100);
      if (t.status === 'done') { ctx.fillStyle = '#3F8A5E'; ctx.font = `800 17px ${FONT}`; ctx.fillText('✓', (w / 2 - 0.17) * 100, 0.07 * 100); }
      if (failed) { ctx.fillStyle = '#B4473A'; ctx.font = `800 17px ${FONT}`; ctx.fillText('!', (w / 2 - 0.12) * 100, 0.07 * 100); }
    }
    ctx.restore();
    // hit box in screen space for the DOM layer
    const pts = [this.P(n.u, 0, WALL - n.t), this.P(n.u + w, 0, WALL - n.t), this.P(n.u + w, 0, WALL - n.t - hgt), this.P(n.u, 0, WALL - n.t - hgt)];
    const xs = pts.map((p) => p[0]); const ys = pts.map((p) => p[1]);
    this.noteHits.push({ id: n.id, x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) });
  }

  drawShadows() {
    const ctx = this.ctx;
    this.floorT();
    for (const a of this.actors.values()) {
      const z = Math.max(0, a.pos.z);
      const r = clamp(0.36 - z * 0.06, 0.14, 0.34);
      ctx.fillStyle = `rgba(20,12,6,${0.32 * a.alpha * clamp(1.4 - z * 0.25, 0.25, 1)})`;
      ctx.beginPath(); ctx.ellipse(a.pos.x, a.pos.y, r, r, 0, 0, 6.28); ctx.fill();
    }
    // desk shadows
    for (const a of this.actors.values()) {
      if (!a.desk) continue;
      ctx.fillStyle = 'rgba(20,12,6,.22)';
      ctx.fillRect(a.desk.x + 0.12, a.desk.y + 0.12, DW, DD);
    }
    this.base();
  }

  drawPodium(pal) {
    const ctx = this.ctx;
    const x = MEL_HOME.x; const y = MEL_HOME.y;
    // a hexagon prism with a little lectern top
    const r = 0.42; const hgt = 0.62;
    const ring = [];
    for (let i = 0; i < 6; i++) { const an = (Math.PI / 3) * i + Math.PI / 6; ring.push([x + r * Math.cos(an), y + r * Math.sin(an)]); }
    for (let i = 0; i < 6; i++) {
      const p = ring[i]; const q = ring[(i + 1) % 6];
      const nx = (p[0] + q[0]) / 2 - x; const ny = (p[1] + q[1]) / 2 - y;
      if (nx + ny <= 0.01) continue;
      this.poly([this.P(p[0], p[1], 0), this.P(q[0], q[1], 0), this.P(q[0], q[1], hgt), this.P(p[0], p[1], hgt)], nx > ny ? pal.deskR : pal.deskL, 'rgba(36,22,12,.35)');
    }
    this.poly(ring.map((p) => this.P(p[0], p[1], hgt)), pal.deskTop, 'rgba(36,22,12,.35)');
    ctx.fillStyle = '#E8951E';
    const c = this.P(x, y, hgt);
    ctx.beginPath(); ctx.ellipse(c[0], c[1], this.a * 0.22, this.a * 0.11, 0, 0, 6.28); ctx.fill();
  }

  drawDesk(a, pal) {
    const ctx = this.ctx;
    const { x, y } = a.desk;
    let sc = 1;
    if (a.build > 0) {
      const u = clamp((this.now - a.build) / 1.3);
      sc = u < 0.25 ? 0 : easeOutBack((u - 0.25) / 0.75);
      if (u < 1 && Math.random() < 0.5 && !this.reduced()) {
        const c = this.P(x + DW / 2, y + DD / 2, 0.2);
        this.spawn({ kind: 'puff', x: c[0] + rnd(-40, 40) * this.a / 60, y: c[1] + rnd(-6, 10), vx: rnd(-20, 20), vy: rnd(-20, -4), life: rnd(0.6, 1), size: rnd(6, 14) * this.a / 60 });
      }
      if (u >= 1) a.build = -9;
      if (sc <= 0) return;
    }
    const fade = a.leaving ? clamp(1 - (a.seg ? (this.now - a.seg.t0) / 1.2 : 1)) : 1;
    const base = this.P(x + DW / 2, y + DD, 0);
    ctx.save();
    ctx.globalAlpha = fade;
    if (sc !== 1) { ctx.translate(base[0], base[1]); ctx.scale(1 / Math.max(0.4, sc) * Math.min(1, sc + 0.3), sc); ctx.translate(-base[0], -base[1]); }
    // legs and modesty panel
    this.box(x + 0.05, y + 0.08, 0, 0.08, DD - 0.16, DH - 0.06, pal.panel, shade(pal.panel, -0.1), shade(pal.panel, -0.2));
    this.box(x + DW - 0.13, y + 0.08, 0, 0.08, DD - 0.16, DH - 0.06, pal.panel, shade(pal.panel, -0.1), shade(pal.panel, -0.2));
    this.box(x + 0.13, y + 0.1, 0.12, DW - 0.26, 0.05, DH - 0.2, pal.panel, shade(pal.panel, -0.18), shade(pal.panel, -0.25));
    // top
    this.box(x, y, DH - 0.06, DW, DD, 0.07, pal.deskTop, pal.deskL, pal.deskR);
    const z = DH + 0.01;
    const kind = KIND[a.id] || 'hired';
    const col = a.w.color || '#FFB531';
    const active = ['type', 'test', 'read', 'wait', 'stuck'].includes(a.mode);
    // laptop: base, then the lid that faces the bee
    const lx = x + 0.42; const ly = y + 0.24;
    this.box(lx, ly, z, 0.74, 0.46, 0.035, '#D8D2C6', '#B9B2A5', '#A39C90');
    this.box(lx, ly - 0.02, z + 0.035, 0.74, 0.04, 0.46, '#C9C2B6', '#CFC8BC', '#9F988C');
    const lid = [this.P(lx, ly + 0.02, z + 0.035), this.P(lx + 0.74, ly + 0.02, z + 0.035), this.P(lx + 0.74, ly + 0.02, z + 0.495), this.P(lx, ly + 0.02, z + 0.495)];
    const lc = this.P(lx + 0.37, ly + 0.02, z + 0.27);
    ctx.save();
    ctx.beginPath();
    hexScreen(ctx, lc[0], lc[1], this.a * 0.09);
    ctx.fillStyle = active ? col : shade(col, -0.35);
    if (active && !this.mini) { ctx.shadowColor = col; ctx.shadowBlur = 10; }
    ctx.fill();
    ctx.restore();
    void lid;
    // the lamp
    const lpx = x + 0.2; const lpy = y + 0.25;
    this.cyl(lpx, lpy, z, 0.07, 0.03, '#4A3A2B', '#5A4836');
    const s0 = this.P(lpx, lpy, z + 0.03); const s1 = this.P(lpx, lpy, z + 0.55);
    ctx.strokeStyle = '#4A3A2B'; ctx.lineWidth = Math.max(1, this.a * 0.03); ctx.beginPath(); ctx.moveTo(s0[0], s0[1]); ctx.lineTo(s1[0], s1[1]); ctx.stroke();
    const shadeW = this.a * 0.2;
    ctx.fillStyle = pal.night > 0.3 ? '#FFE3A1' : '#F0B54A';
    ctx.beginPath(); ctx.moveTo(s1[0] - shadeW * 0.45, s1[1] - this.a * 0.12); ctx.lineTo(s1[0] + shadeW * 0.45, s1[1] - this.a * 0.12); ctx.lineTo(s1[0] + shadeW, s1[1] + this.a * 0.04); ctx.lineTo(s1[0] - shadeW, s1[1] + this.a * 0.04); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(36,22,12,.5)'; ctx.lineWidth = 1; ctx.stroke();
    a.lampAt = [s1[0], s1[1] + this.a * 0.04];
    // role props at the front corner
    const px = x + DW - 0.42; const py = y + DD - 0.3;
    if (kind === 'dev') {
      this.cyl(px, py, z, 0.1, 0.18, '#F2E9DA', '#3B2414');
      const d = this.P(px - 0.55, py + 0.06, z + 0.08);
      ctx.fillStyle = '#FFD23F'; ctx.beginPath(); ctx.ellipse(d[0], d[1], this.a * 0.1, this.a * 0.07, 0, 0, 6.28); ctx.fill();
      ctx.beginPath(); ctx.arc(d[0] - this.a * 0.05, d[1] - this.a * 0.08, this.a * 0.055, 0, 6.28); ctx.fill();
      ctx.fillStyle = '#F08A24'; ctx.beginPath(); ctx.moveTo(d[0] - this.a * 0.1, d[1] - this.a * 0.09); ctx.lineTo(d[0] - this.a * 0.16, d[1] - this.a * 0.07); ctx.lineTo(d[0] - this.a * 0.1, d[1] - this.a * 0.05); ctx.fill();
    } else if (kind === 'designer') {
      this.box(px - 0.45, py - 0.12, z, 0.5, 0.34, 0.02, '#2C2620', '#221D18', '#1A1612');
      ['#FF7AB6', '#6CC4FF', '#FFD072', '#7DC49B'].forEach((c, i) => { const p = this.P(px - 0.38 + i * 0.11, py + 0.05, z + 0.025); ctx.fillStyle = c; ctx.beginPath(); ctx.ellipse(p[0], p[1], this.a * 0.04, this.a * 0.022, 0, 0, 6.28); ctx.fill(); });
      this.cyl(px + 0.18, py - 0.05, z, 0.09, 0.2, '#86A9D6', '#3E5E86');
    } else if (kind === 'qa') {
      this.box(px - 0.5, py - 0.08, z, 0.55, 0.16, 0.08, '#8C6A3E', '#7A5A33', '#6B4E2C');
      ['#7DC49B', '#FFB531', '#86A9D6'].forEach((c, i) => this.cyl(px - 0.42 + i * 0.17, py, z + 0.08, 0.045, 0.26, alpha(c, 0.85), '#F2E9DA'));
    } else if (kind === 'writer') {
      for (let i = 0; i < 4; i++) this.box(px - 0.5 + i * 0.015, py - 0.16 - i * 0.01, z + i * 0.03, 0.42, 0.3, 0.03, '#FFFDF6', '#E9E1D2', '#D9D0C0');
      this.cyl(px + 0.15, py - 0.05, z, 0.08, 0.2, '#B9895A', '#3B2414');
    } else {
      this.cyl(px, py - 0.04, z, 0.11, 0.17, '#C46A3A', '#4A2E1A');
      const leaf = this.P(px, py - 0.04, z + 0.28);
      ctx.fillStyle = '#5FA36F';
      for (let i = 0; i < 5; i++) { ctx.beginPath(); ctx.ellipse(leaf[0] + Math.cos(i * 1.3) * this.a * 0.07, leaf[1] - Math.abs(Math.sin(i * 1.3)) * this.a * 0.06, this.a * 0.06, this.a * 0.025, i * 1.3, 0, 6.28); ctx.fill(); }
    }
    ctx.restore();
  }

  drawChair(a, pal) {
    if (!a.desk) return;
    const x = a.home.x - 0.25; const y = a.home.y - 0.32;
    this.cyl(x + 0.25, y + 0.2, 0.02, 0.05, 0.42, '#3A2F25', '#3A2F25');
    this.box(x, y - 0.05, 0.42, 0.5, 0.5, 0.08, shade(a.w.color, -0.2), shade(a.w.color, -0.4), shade(a.w.color, -0.5));
    this.box(x, y - 0.1, 0.5, 0.5, 0.07, 0.62, shade(a.w.color, -0.25), shade(a.w.color, -0.35), shade(a.w.color, -0.5));
    void pal;
  }

  drawPlant(x, y, s) {
    const ctx = this.ctx;
    this.cyl(x, y, 0, 0.2 * s, 0.32 * s, '#C46A3A', '#4A2E1A');
    const c = this.P(x, y, 0.32 * s);
    const t = this.reduced() ? 0 : Math.sin(this.now * 0.8 + x) * 0.04;
    for (let i = 0; i < 7; i++) {
      const an = -Math.PI / 2 + (i - 3) * 0.42 + t;
      const len = this.a * (0.42 + (i % 3) * 0.1) * s;
      ctx.fillStyle = i % 2 ? '#4E8F5E' : '#63A874';
      ctx.beginPath();
      ctx.ellipse(c[0] + Math.cos(an) * len * 0.5, c[1] + Math.sin(an) * len * 0.5, len * 0.5, len * 0.16, an, 0, 6.28);
      ctx.fill();
    }
  }

  drawCooler(x, y, pal) {
    const ctx = this.ctx;
    this.box(x - 0.22, y - 0.22, 0, 0.44, 0.44, 0.9, pal.wallL, shade(pal.wallL, -0.1), shade(pal.wallL, -0.22));
    this.cyl(x, y, 0.9, 0.17, 0.42, 'rgba(255,190,70,.85)', '#FFD072');
    const s = this.P(x + 0.22, y + 0.05, 0.6);
    ctx.fillStyle = '#7A4A1E'; ctx.fillRect(s[0] - 2, s[1] - 2, 5, 4);
  }

  drawShelfUnit(pal) {
    // a bookshelf against the left wall near the back
    const x = 0.02; const y = 0.55;
    this.box(x, y, 0, 0.42, 1.3, 1.75, pal.deskTop, pal.panel, shade(pal.panel, -0.2));
    const colors = ['#E57B6E', '#86A9D6', '#FFD072', '#7DC49B', '#C9A0E8', '#F2E9DA'];
    for (let row = 0; row < 3; row++) {
      const zz = 0.12 + row * 0.55;
      for (let i = 0; i < 5; i++) {
        const yy = y + 0.12 + i * 0.22;
        this.poly([this.P(x + 0.42, yy, zz), this.P(x + 0.42, yy + 0.16, zz), this.P(x + 0.42, yy + 0.16, zz + 0.32 + ((i + row) % 3) * 0.05), this.P(x + 0.42, yy, zz + 0.32 + ((i + row) % 3) * 0.05)], colors[(i * 2 + row) % colors.length], 'rgba(36,22,12,.3)');
      }
    }
  }

  drawBee(a) {
    const ctx = this.ctx;
    const now = this.now;
    const reduced = this.reduced();
    const k = this.k;
    let bob = 0; let tilt = 0; let sx = 1; let sy = 1; let wingRate = 22; let wingAmp = 0.28; let eyes = false; let jx = 0;
    const m = a.seg ? 'fly' : a.mode;
    if (!reduced) {
      switch (m) {
        case 'fly': {
          wingRate = 46; wingAmp = 0.55;
          const u = a.flyU ?? 0;
          const st = Math.sin(Math.PI * u) * 0.1;
          sy = 1 + st; sx = 1 - st * 0.6;
          tilt = (a.seg && a.seg.to.x - a.seg.from.x - (a.seg.to.y - a.seg.from.y) > 0 ? 0.12 : -0.12) * Math.sin(Math.PI * u);
          break;
        }
        case 'type': bob = Math.sin(now * 16 + a.ph) * 0.018; wingRate = 26; break;
        case 'plan': bob = Math.sin(now * 3 + a.ph) * 0.05; break;
        case 'wait': {
          // foot tapping: a short dip on every beat
          const beat = (now * 2.2 + a.ph) % 1;
          bob = beat < 0.2 ? -Math.sin((beat / 0.2) * Math.PI) * 0.05 : 0;
          if (beat < 0.2) { sy = 0.96; sx = 1.03; }
          wingRate = 14; wingAmp = 0.18;
          break;
        }
        case 'stuck': bob = -0.04 + Math.sin(now * 1.4 + a.ph) * 0.02; tilt = Math.sin(now * 1.3) * 0.07; wingRate = 8; wingAmp = 0.12; break;
        case 'sleep': case 'paused': bob = Math.sin(now * 1.1 + a.ph) * 0.012; tilt = 0.24; eyes = true; wingRate = 0; wingAmp = 0; sy = 1 + Math.sin(now * 1.1 + a.ph) * 0.015; break;
        case 'error': jx = (now % 2 < 0.4) ? Math.sin(now * 60) * 1.6 : 0; bob = Math.sin(now * 2) * 0.02; break;
        case 'celebrate': {
          const hop = Math.abs(Math.sin((now - this.celebrateAt) * 5.5 + a.ph));
          bob = hop * 0.42;
          if (hop < 0.2) { sy = 0.86; sx = 1.12; } else { sy = 1.06; sx = 0.96; }
          sx *= Math.cos((now - this.celebrateAt) * 3 + a.ph) > -0.2 ? 1 : -1;
          wingRate = 40; wingAmp = 0.5;
          break;
        }
        case 'test': bob = Math.sin(now * 5 + a.ph) * 0.03; break;
        case 'read': bob = Math.sin(now * 2 + a.ph) * 0.03; tilt = Math.sin(now * 1.2) * 0.05; break;
        default: bob = Math.sin(now * 2.2 + a.ph) * 0.05;
      }
      // landing and take off squash, a hop when someone hands over a task
      const sq = now - a.squashAt;
      if (sq < 0.5) { const d = Math.exp(-sq * 9) * Math.cos(sq * 22) * 0.16; sy *= 1 - d; sx *= 1 + d * 0.8; }
      const hp = now - a.hopAt;
      if (hp < 0.6) { bob += Math.sin((hp / 0.6) * Math.PI) * 0.3; }
    } else if (m === 'sleep' || m === 'paused') { tilt = 0.18; eyes = true; wingAmp = 0; }
    else { wingAmp = 0.2; wingRate = 0; }
    if (now >= a.blinkAt && now < a.blinkAt + 0.13) eyes = true;
    // Mel's reactions to what the user does
    if (a.react && !reduced) {
      const rt = now - a.react.at;
      if (rt > 1.4) a.react = null;
      else if (a.react.kind === 'nod') { const n = Math.sin(rt * 14) * Math.exp(-rt * 2.2); bob += n * 0.05; sy *= 1 - Math.max(0, n) * 0.06; tilt += 0; }
      else if (a.react.kind === 'curious') { tilt += Math.sin(Math.min(1, rt * 3) * Math.PI / 2) * 0.22 * (1 - clamp((rt - 1) / 0.4)); bob += 0.06 * Math.sin(Math.min(1, rt * 4) * Math.PI); }
      else if (a.react.kind === 'shake') { tilt += Math.sin(rt * 16) * 0.12 * Math.exp(-rt * 2.5); }
    } else if (a.react && reduced && now - a.react.at > 1.4) a.react = null;
    // ease between poses so a change of state never snaps
    if (!reduced) {
      const kk = 1 - Math.pow(0.0004, Math.min(0.05, now - (a.lastPoseAt || now)));
      a.tiltS = lerp(a.tiltS ?? tilt, tilt, a.seg ? 1 : kk);
      a.bobS = lerp(a.bobS ?? bob, bob, Math.abs(bob - (a.bobS ?? bob)) > 0.12 ? kk : 1);
      tilt = a.tiltS; bob = a.bobS;
    }
    a.lastPoseAt = now;

    const p = this.P(a.pos.x, a.pos.y, a.pos.z + bob);
    a.sx = p[0]; a.sy = p[1];
    const img = this.sprite(a.w);
    ctx.save();
    ctx.globalAlpha = a.alpha * (m === 'paused' ? 0.7 : 1);
    ctx.translate(p[0] + jx, p[1]);
    // anchor: SVG point (32, 44) sits on the world point; squash around the bottom (32, 72)
    ctx.translate(0, 28 * k);
    ctx.rotate(tilt);
    ctx.scale(sx, sy);
    ctx.translate(-32 * k, -72 * k);
    // wings behind the body
    const flap = wingRate ? Math.sin(now * wingRate + a.ph) * wingAmp : -0.25;
    ctx.fillStyle = 'rgba(255,253,245,.62)';
    ctx.strokeStyle = 'rgba(36,22,12,.5)';
    ctx.lineWidth = Math.max(0.6, k * 1);
    for (const [wx, dir] of [[13.5, -1], [50.5, 1]]) {
      ctx.save();
      ctx.translate((wx + dir * -6) * k, 30 * k);
      ctx.rotate(dir * (0.56 - flap));
      ctx.beginPath(); ctx.ellipse(dir * 7 * k, -4 * k, 10.5 * k, 6 * k * (1 - Math.abs(flap) * 0.35), 0, 0, 6.28);
      ctx.fill(); ctx.stroke();
      ctx.restore();
    }
    if (img) ctx.drawImage(img, -4 * k, -2 * k, 72 * k, 76 * k);
    else { ctx.fillStyle = a.w.color || '#FFB531'; ctx.beginPath(); ctx.arc(32 * k, 32 * k, 17 * k, 0, 6.28); ctx.fill(); }
    if (eyes) {
      ctx.fillStyle = '#FCC041';
      ctx.strokeStyle = OUT; ctx.lineWidth = Math.max(0.8, 1.3 * k); ctx.lineCap = 'round';
      for (const ex of [25.6, 38.4]) {
        ctx.beginPath(); ctx.ellipse(ex * k, 31.6 * k, 4.3 * k, 5.1 * k, 0, 0, 6.28); ctx.fill();
        ctx.beginPath(); ctx.moveTo((ex - 3) * k, 32 * k); ctx.quadraticCurveTo(ex * k, 34.8 * k, (ex + 3) * k, 32 * k); ctx.stroke();
      }
      ctx.lineCap = 'butt';
    }
    if (m === 'stuck' && !this.mini) {
      // worried brows
      ctx.strokeStyle = OUT; ctx.lineWidth = Math.max(0.8, 1.2 * k);
      ctx.beginPath(); ctx.moveTo(22 * k, 24 * k); ctx.lineTo(28 * k, 26 * k); ctx.moveTo(42 * k, 24 * k); ctx.lineTo(36 * k, 26 * k); ctx.stroke();
    }
    ctx.restore();
    // the thing in its hands
    if (a.item) {
      const hx = p[0]; const hy = p[1] + 26 * k;
      if (a.item === 'note' || a.item === 'bad') drawNoteIcon(ctx, hx, hy, 15 * k * 1.25, a.item === 'bad' ? '#F6B3A8' : '#FFE08A', a.itemColor);
      else drawParcel(ctx, hx, hy, 15 * k * 1.25, a.itemColor || '#FFB531');
    }
    // the hit box for the DOM layer
    this.hits.push({ id: a.id, x: p[0] - 26 * k, y: p[1] - 38 * k, w: 52 * k, h: 66 * k });
  }

  sprite(w) {
    const px = Math.max(16, Math.round(this.k * 72 * this.dpr));
    const key = `${w.color}|${w.role}|${w.name}|${px}`;
    let sp = this.sprites.get(w.id);
    if (sp && sp.key === key) return sp.ready ? sp.img : sp.prev;
    const img = new Image();
    const svg = beeSvg(w, { title: '' })
      .replace(/<g opacity="\.95">[\s\S]*?<\/g>/, '')
      .replace('viewBox="0 0 64 64"', `viewBox="-4 -2 72 76" width="${px}" height="${Math.round((px * 76) / 72)}"`);
    const next = { key, img, ready: false, prev: sp ? (sp.ready ? sp.img : sp.prev) : null };
    img.onload = () => { next.ready = true; if (!this.running) this.draw(); };
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    this.sprites.set(w.id, next);
    return next.prev;
  }

  drawLights(pal) {
    if (pal.night < 0.25) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const al = (pal.night - 0.2) * 0.32;
    for (const a of this.actors.values()) {
      if (!a.lampAt) continue;
      const [x, y] = a.lampAt;
      const r = this.a * 1.5;
      const g = ctx.createRadialGradient(x, y + this.a * 0.25, 2, x, y + this.a * 0.25, r);
      g.addColorStop(0, `rgba(255,190,90,${al})`); g.addColorStop(1, 'rgba(255,190,90,0)');
      ctx.fillStyle = g; ctx.fillRect(x - r, y - r, r * 2, r * 2.2);
    }
    // screens glow on the faces of busy bees
    for (const a of this.actors.values()) {
      if (!['type', 'test', 'read'].includes(a.mode) || a.seg) continue;
      const r = this.a * 0.6;
      const [r0, g0, b0] = rgb(a.w.color);
      const g = ctx.createRadialGradient(a.sx, a.sy + this.a * 0.2, 1, a.sx, a.sy + this.a * 0.2, r);
      g.addColorStop(0, `rgba(${r0},${g0},${b0},${0.12 + pal.night * 0.1})`); g.addColorStop(1, `rgba(${r0},${g0},${b0},0)`);
      ctx.fillStyle = g; ctx.fillRect(a.sx - r, a.sy - r * 0.8, r * 2, r * 2);
    }
    ctx.restore();
  }

  /** Bubbles, status icons, badges and name tags: always on top, never darkened. */
  drawOverlay() {
    const ctx = this.ctx;
    const now = this.now;
    const k = this.k;
    const reduced = this.reduced();
    const s = this.getState();
    // name tags first, so bubbles sit on top of them
    if (!this.mini) {
      for (const a of this.actors.values()) {
        const at = a.desk ? this.P(a.desk.x + DW, a.desk.y + DD, 0) : this.P(MEL_HOME.x + 0.42, MEL_HOME.y + 0.42, 0);
        drawNameTag(ctx, at[0], at[1] + 6, a.w.name, levelOf(s, a.id), a.w.color, this.highlight === a.id, Math.max(10, Math.min(12.5, this.a * 0.2)));
      }
    }
    for (const a of this.actors.values()) {
      const headY = a.sy - 34 * k;
      const ix = a.sx + 22 * k;
      const iy = headY - 6 * k;
      const pop = reduced ? clamp((now - a.modeSince) / 0.25) : easeOutBack(clamp((now - a.modeSince) / 0.35));
      const sz = (this.mini ? 9 : Math.max(14, Math.min(27, this.a * 0.42))) * (reduced ? 1 : Math.max(0.01, pop));
      ctx.globalAlpha = a.alpha * (reduced ? pop : 1);
      const m = a.seg ? 'fly' : a.mode;
      const wob = reduced ? 0 : Math.sin(now * 3 + a.ph) * 2;
      if (a.react && a.react.kind === 'curious' && now - a.react.at < 1.4) iconQuestion(ctx, ix, iy + wob, Math.max(13, Math.min(22, this.a * 0.34)));
      else if (m === 'wait') iconClock(ctx, ix, iy + wob, sz, reduced ? 0 : now);
      else if (m === 'stuck') {
        // waiting for the user: a big grey cloud and a soft amber pulse around the bee
        const pulse = reduced ? 0.5 : (Math.sin(now * 4) + 1) / 2;
        ctx.strokeStyle = `rgba(232,180,92,${0.35 + pulse * 0.4})`; ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.ellipse(a.sx, a.sy + 30 * k, (30 + pulse * 5) * k, (12 + pulse * 2) * k, 0, 0, 6.28); ctx.stroke();
        iconCloud(ctx, a.sx, headY - sz * 1.3 + wob, sz * 1.9, reduced ? 0 : now);
        if (!this.mini) drawPill(ctx, a.sx, headY - sz * 2.75 + wob, a.isMel ? 'Check the brief' : 'Needs your OK', '#E8B45C', Math.max(10, Math.min(12, this.a * 0.19)));
      }
      else if (m === 'paused') iconPause(ctx, ix, iy, sz);
      else if (m === 'error') iconBang(ctx, ix, iy + wob, sz);
      else if (m === 'test') iconFlask(ctx, ix, iy + wob, sz, reduced ? 0 : now);
      else if (m === 'read') iconMag(ctx, ix, iy + wob, sz, reduced ? 0 : now);
      else if (m === 'celebrate') iconJar(ctx, a.sx, headY - sz * 0.8 - (reduced ? 0 : Math.abs(Math.sin(now * 4 + a.ph)) * 6), sz * 1.1);
      else if (m === 'plan') iconDots(ctx, ix, iy + wob, sz, reduced ? 0 : now);
      if (a.badge) {
        const age = now - a.badge.at;
        const pop = reduced ? 1 : easeOutBack(clamp(age / 0.3));
        const fade = clamp((a.badge.until - now) / 0.4);
        const bs = sz * (a.badge.big ? 1.5 : 1.15) * pop;
        ctx.globalAlpha = fade * a.alpha;
        (a.badge.kind === 'ok' ? iconCheck : iconX)(ctx, a.sx - 22 * k, headY - 4 * k - (reduced ? 0 : age * 4), bs);
      }
      ctx.globalAlpha = 1;
      if (a.bubble && !this.mini) {
        const age = now - a.bubble.at;
        const fade = Math.min(clamp(age / 0.2), clamp((a.bubble.until - now) / 0.35));
        ctx.globalAlpha = fade;
        drawBubble(ctx, a.sx, headY - 10 * k - (m === 'stuck' ? sz * 3.3 : 0), a.bubble.text, Math.max(11, Math.min(13, this.a * 0.21)), this.w, a.w.color);
        ctx.globalAlpha = 1;
      }
      if (this.highlight === a.id && !this.mini) {
        ctx.strokeStyle = 'rgba(255,208,114,.9)'; ctx.lineWidth = 2; ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.ellipse(a.sx, a.sy + 30 * k, 26 * k, 10 * k, 0, 0, 6.28); ctx.stroke(); ctx.setLineDash([]);
      }
    }
    // carried notes ride with Mel
    const mel = this.actors.get('mel');
    if (mel) for (const n of this.notes.values()) if (n.state === 'carried') drawNoteIcon(ctx, mel.sx - 4, mel.sy + 22 * k, 16 * k * 1.3, '#FFE08A', this.actors.get(n.task?.assignee)?.w.color);
  }

  drawParticles() {
    const ctx = this.ctx;
    for (const p of this.parts) {
      const life = 1 - p.age / p.max;
      ctx.globalAlpha = clamp(life * 1.6);
      switch (p.kind) {
        case 'glyph':
          ctx.font = `700 ${p.size}px ${MONO}`;
          ctx.fillStyle = p.color;
          ctx.fillText(p.text, p.x, p.y);
          break;
        case 'z':
          ctx.font = `800 ${p.size * (1 + p.age * 0.3)}px ${FONT}`;
          ctx.fillStyle = '#E8DDF7';
          ctx.fillText('z', p.x, p.y);
          break;
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
        case 'puff':
          ctx.fillStyle = 'rgba(242,233,218,.5)'; ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (1 + p.age * 1.5), 0, 6.28); ctx.fill();
          break;
        case 'confetti':
          ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.scale(1, Math.abs(Math.cos(p.rot * 1.3)) * 0.8 + 0.2);
          ctx.fillStyle = p.color;
          if (p.hex) { ctx.beginPath(); hexScreen(ctx, 0, 0, p.size * 0.55); ctx.fill(); } else ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
          ctx.restore();
          break;
        case 'label': {
          ctx.font = `700 ${Math.max(10, this.a * 0.19)}px ${FONT}`;
          const tw = ctx.measureText(p.text).width;
          ctx.fillStyle = 'rgba(20,16,12,.82)';
          roundRect(ctx, p.x - tw / 2 - 6, p.y - 12, tw + 12, 18, 9); ctx.fill();
          ctx.fillStyle = p.color; ctx.textAlign = 'center'; ctx.fillText(p.text, p.x, p.y + 1); ctx.textAlign = 'left';
          break;
        }
        case 'jar': {
          const u = easeInOut(clamp(p.age / p.max));
          const cx = (p.x0 + p.x1) / 2; const cy = Math.min(p.y0, p.y1) - 120;
          const x = (1 - u) * (1 - u) * p.x0 + 2 * (1 - u) * u * cx + u * u * p.x1;
          const y = (1 - u) * (1 - u) * p.y0 + 2 * (1 - u) * u * cy + u * u * p.y1;
          ctx.globalAlpha = 1;
          iconJar(ctx, x, y, 18 - u * 6);
          break;
        }
        default: break;
      }
    }
    ctx.globalAlpha = 1;
  }

}

/* ---------- state helpers ---------- */
export function levelOf(s, id) {
  let n = 0;
  for (const t of Object.values(s.tasks || {})) if (t.assignee === id && t.status === 'done') n++;
  return 1 + Math.floor(Math.sqrt(n));
}

export function doneCount(s) {
  let n = 0;
  for (const t of Object.values(s.tasks || {})) if (t.status === 'done') n++;
  return n;
}

function cleanText(text) {
  let t = String(text || '').replace(/\s+/g, ' ').trim();
  t = t.replace(/^Plan: /, '');
  if (t.length > 88) t = `${t.slice(0, 85).replace(/\s+\S*$/, '')}...`;
  return t;
}

function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }

function wrap(ctx, text, maxW, maxLines) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(next).width > maxW && cur) {
      lines.push(cur);
      cur = w;
      if (lines.length === maxLines) break;
    } else cur = next;
  }
  if (lines.length < maxLines && cur) lines.push(cur);
  else if (lines.length === maxLines && cur && lines[maxLines - 1] !== cur) {
    let last = lines[maxLines - 1];
    while (last && ctx.measureText(`${last}...`).width > maxW) last = last.slice(0, -1);
    lines[maxLines - 1] = `${last.trimEnd()}...`;
  }
  return lines;
}

/* ---------- drawing helpers (screen space) ---------- */
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function hexPath(ctx, cx, cy, r) {
  for (let i = 0; i < 6; i++) {
    const an = (Math.PI / 3) * i + Math.PI / 6;
    const x = cx + r * Math.cos(an); const y = cy + r * Math.sin(an);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
}
function hexScreen(ctx, cx, cy, r) {
  for (let i = 0; i < 6; i++) {
    const an = (Math.PI / 3) * i - Math.PI / 2;
    const x = cx + r * Math.cos(an); const y = cy + r * Math.sin(an);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function drawNameTag(ctx, x, y, name, level, color, on, fs) {
  ctx.font = `650 ${fs}px ${FONT}`;
  const tw = ctx.measureText(name).width;
  const bw = fs * 1.9;
  const w = tw + bw + 14;
  const h = fs + 9;
  const x0 = x - w / 2;
  ctx.fillStyle = on ? 'rgba(48,38,28,.95)' : 'rgba(20,16,12,.78)';
  roundRect(ctx, x0, y, w, h, h / 2); ctx.fill();
  ctx.strokeStyle = on ? 'rgba(255,208,114,.8)' : 'rgba(242,233,218,.12)'; ctx.lineWidth = 1; ctx.stroke();
  // level hex
  ctx.fillStyle = color || '#FFB531';
  ctx.beginPath(); hexScreen(ctx, x0 + h / 2 + 1, y + h / 2, h / 2 - 2); ctx.fill();
  ctx.fillStyle = '#1A1206';
  ctx.font = `800 ${fs * 0.78}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.fillText(String(level), x0 + h / 2 + 1, y + h / 2 + fs * 0.28);
  ctx.textAlign = 'left';
  ctx.font = `650 ${fs}px ${FONT}`;
  ctx.fillStyle = '#F2E9DA';
  ctx.fillText(name, x0 + h + 4, y + h / 2 + fs * 0.36);
}

function drawBubble(ctx, x, y, text, fs, W, color) {
  ctx.font = `500 ${fs}px ${FONT}`;
  const maxW = Math.min(230, W * 0.3);
  const lines = wrap(ctx, text, maxW, 2);
  const tw = Math.max(...lines.map((l) => ctx.measureText(l).width));
  const pw = tw + 20; const ph = lines.length * (fs + 4) + 12;
  let bx = x - pw / 2;
  bx = Math.max(6, Math.min(W - pw - 6, bx));
  const by = y - ph - 10;
  ctx.fillStyle = 'rgba(0,0,0,.25)';
  roundRect(ctx, bx + 1, by + 3, pw, ph, 10); ctx.fill();
  ctx.fillStyle = '#FFF8EA';
  roundRect(ctx, bx, by, pw, ph, 10); ctx.fill();
  ctx.beginPath(); ctx.moveTo(x - 7, by + ph - 1); ctx.lineTo(x, by + ph + 9); ctx.lineTo(x + 5, by + ph - 1); ctx.closePath(); ctx.fill();
  ctx.fillStyle = color || '#FFB531';
  ctx.fillRect(bx + 8, by, Math.min(pw - 16, 28), 2.5);
  ctx.fillStyle = '#2A1D12';
  lines.forEach((l, i) => ctx.fillText(l, bx + 10, by + 8 + fs * 0.9 + i * (fs + 4)));
}

function circleIcon(ctx, x, y, s, fill) {
  ctx.fillStyle = 'rgba(0,0,0,.25)'; ctx.beginPath(); ctx.arc(x + 1, y + 2, s / 2, 0, 6.28); ctx.fill();
  ctx.fillStyle = fill; ctx.beginPath(); ctx.arc(x, y, s / 2, 0, 6.28); ctx.fill();
  ctx.strokeStyle = OUT; ctx.lineWidth = Math.max(1, s * 0.07); ctx.stroke();
}
function iconClock(ctx, x, y, s, t) {
  circleIcon(ctx, x, y, s, '#FFF8EA');
  ctx.strokeStyle = OUT; ctx.lineCap = 'round'; ctx.lineWidth = Math.max(1.2, s * 0.09);
  const a1 = t * 6; const a2 = t * 0.5;
  ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.sin(a1) * s * 0.33, y - Math.cos(a1) * s * 0.33); ctx.moveTo(x, y); ctx.lineTo(x + Math.sin(a2) * s * 0.22, y - Math.cos(a2) * s * 0.22); ctx.stroke();
  ctx.lineCap = 'butt';
  ctx.fillStyle = '#E8951E'; ctx.fillRect(x - s * 0.12, y - s * 0.66, s * 0.24, s * 0.12);
}
function iconCloud(ctx, x, y, s, t) {
  ctx.fillStyle = '#9AA3B5';
  ctx.strokeStyle = OUT; ctx.lineWidth = Math.max(1, s * 0.06);
  ctx.beginPath();
  ctx.arc(x - s * 0.3, y, s * 0.26, Math.PI * 0.5, Math.PI * 1.5);
  ctx.arc(x - s * 0.05, y - s * 0.2, s * 0.3, Math.PI * 1.05, Math.PI * 1.9);
  ctx.arc(x + s * 0.3, y - s * 0.02, s * 0.24, Math.PI * 1.3, Math.PI * 0.5);
  ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#F2E9DA'; ctx.font = `800 ${s * 0.42}px ${FONT}`; ctx.textAlign = 'center'; ctx.fillText('?', x, y + s * 0.08); ctx.textAlign = 'left';
  ctx.strokeStyle = '#86A9D6'; ctx.lineWidth = Math.max(1, s * 0.06); ctx.lineCap = 'round';
  for (let i = 0; i < 3; i++) {
    const ph = ((t * 1.6 + i / 3) % 1);
    const dx = x - s * 0.25 + i * s * 0.25; const dy = y + s * 0.3 + ph * s * 0.45;
    ctx.globalAlpha = 1 - ph;
    ctx.beginPath(); ctx.moveTo(dx, dy); ctx.lineTo(dx - s * 0.04, dy + s * 0.1); ctx.stroke();
  }
  ctx.globalAlpha = 1; ctx.lineCap = 'butt';
}
function iconCheck(ctx, x, y, s) {
  circleIcon(ctx, x, y, s, '#5DB27E');
  ctx.strokeStyle = '#fff'; ctx.lineWidth = Math.max(1.6, s * 0.13); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath(); ctx.moveTo(x - s * 0.22, y); ctx.lineTo(x - s * 0.05, y + s * 0.17); ctx.lineTo(x + s * 0.24, y - s * 0.16); ctx.stroke();
  ctx.lineCap = 'butt'; ctx.lineJoin = 'miter';
}
function iconX(ctx, x, y, s) {
  circleIcon(ctx, x, y, s, '#D9614F');
  ctx.strokeStyle = '#fff'; ctx.lineWidth = Math.max(1.6, s * 0.13); ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(x - s * 0.17, y - s * 0.17); ctx.lineTo(x + s * 0.17, y + s * 0.17); ctx.moveTo(x + s * 0.17, y - s * 0.17); ctx.lineTo(x - s * 0.17, y + s * 0.17); ctx.stroke();
  ctx.lineCap = 'butt';
}
function drawPill(ctx, x, y, text, color, fs) {
  ctx.font = `750 ${fs}px ${FONT}`;
  const tw = ctx.measureText(text).width;
  ctx.fillStyle = 'rgba(20,16,12,.88)';
  roundRect(ctx, x - tw / 2 - 8, y - fs - 2, tw + 16, fs + 9, (fs + 9) / 2); ctx.fill();
  ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.stroke();
  ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.fillText(text, x, y + 1); ctx.textAlign = 'left';
}
function iconQuestion(ctx, x, y, s) {
  circleIcon(ctx, x, y, s, '#86A9D6');
  ctx.fillStyle = '#fff'; ctx.font = `900 ${s * 0.62}px ${FONT}`; ctx.textAlign = 'center'; ctx.fillText('?', x, y + s * 0.22); ctx.textAlign = 'left';
}
function iconPause(ctx, x, y, s) {
  circleIcon(ctx, x, y, s, '#CFC4B3');
  ctx.fillStyle = OUT; ctx.fillRect(x - s * 0.17, y - s * 0.2, s * 0.12, s * 0.4); ctx.fillRect(x + s * 0.05, y - s * 0.2, s * 0.12, s * 0.4);
}
function iconBang(ctx, x, y, s) {
  circleIcon(ctx, x, y, s, '#E57B6E');
  ctx.fillStyle = '#fff'; ctx.font = `900 ${s * 0.62}px ${FONT}`; ctx.textAlign = 'center'; ctx.fillText('!', x, y + s * 0.22); ctx.textAlign = 'left';
}
function iconFlask(ctx, x, y, s, t) {
  circleIcon(ctx, x, y, s, '#F2E9DA');
  ctx.fillStyle = '#7DC49B';
  ctx.beginPath(); ctx.moveTo(x - s * 0.08, y - s * 0.24); ctx.lineTo(x + s * 0.08, y - s * 0.24); ctx.lineTo(x + s * 0.08, y - s * 0.05); ctx.lineTo(x + s * 0.24, y + s * 0.22); ctx.lineTo(x - s * 0.24, y + s * 0.22); ctx.lineTo(x - s * 0.08, y - s * 0.05); ctx.closePath();
  ctx.strokeStyle = OUT; ctx.lineWidth = Math.max(1, s * 0.06); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x - s * 0.04, y + s * 0.1 - ((t * 2) % 1) * s * 0.12, s * 0.04, 0, 6.28); ctx.fill();
}
function iconMag(ctx, x, y, s, t) {
  circleIcon(ctx, x, y, s, '#F2E9DA');
  const dx = Math.sin(t * 2.4) * s * 0.06;
  ctx.strokeStyle = OUT; ctx.lineWidth = Math.max(1.2, s * 0.08);
  ctx.beginPath(); ctx.arc(x - s * 0.06 + dx, y - s * 0.06, s * 0.16, 0, 6.28); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x + s * 0.06 + dx, y + s * 0.06); ctx.lineTo(x + s * 0.22 + dx, y + s * 0.22); ctx.stroke();
}
function iconDots(ctx, x, y, s, t) {
  ctx.fillStyle = '#FFF8EA';
  roundRect(ctx, x - s * 0.55, y - s * 0.35, s * 1.1, s * 0.7, s * 0.35); ctx.fill();
  ctx.strokeStyle = OUT; ctx.lineWidth = Math.max(1, s * 0.06); ctx.stroke();
  for (let i = 0; i < 3; i++) {
    const on = Math.floor(t * 3) % 3 === i;
    ctx.fillStyle = on ? '#E8951E' : '#8C8172';
    ctx.beginPath(); ctx.arc(x - s * 0.25 + i * s * 0.25, y, s * (on ? 0.09 : 0.07), 0, 6.28); ctx.fill();
  }
}
export function iconJar(ctx, x, y, s) {
  ctx.fillStyle = 'rgba(0,0,0,.25)'; roundRect(ctx, x - s * 0.36 + 1, y - s * 0.3 + 2, s * 0.72, s * 0.78, s * 0.2); ctx.fill();
  ctx.fillStyle = '#F3A42A'; roundRect(ctx, x - s * 0.36, y - s * 0.3, s * 0.72, s * 0.78, s * 0.2); ctx.fill();
  ctx.strokeStyle = OUT; ctx.lineWidth = Math.max(1, s * 0.06); ctx.stroke();
  ctx.fillStyle = '#FFD072'; roundRect(ctx, x - s * 0.24, y - s * 0.16, s * 0.12, s * 0.45, s * 0.06); ctx.fill();
  ctx.fillStyle = '#7A4A1E'; roundRect(ctx, x - s * 0.42, y - s * 0.46, s * 0.84, s * 0.2, s * 0.06); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#FFF1CF'; ctx.beginPath(); hexScreen(ctx, x + s * 0.06, y + s * 0.1, s * 0.15); ctx.fill();
}
function drawParcel(ctx, x, y, s, color) {
  ctx.fillStyle = 'rgba(0,0,0,.25)'; ctx.fillRect(x - s * 0.5 + 1, y - s * 0.35 + 2, s, s * 0.7);
  ctx.fillStyle = '#D7A86A'; ctx.fillRect(x - s * 0.5, y - s * 0.35, s, s * 0.7);
  ctx.strokeStyle = OUT; ctx.lineWidth = Math.max(1, s * 0.06); ctx.strokeRect(x - s * 0.5, y - s * 0.35, s, s * 0.7);
  ctx.fillStyle = color; ctx.fillRect(x - s * 0.08, y - s * 0.35, s * 0.16, s * 0.7); ctx.fillRect(x - s * 0.5, y - s * 0.06, s, s * 0.12);
  ctx.beginPath(); ctx.ellipse(x - s * 0.14, y - s * 0.42, s * 0.14, s * 0.08, -0.5, 0, 6.28); ctx.ellipse(x + s * 0.14, y - s * 0.42, s * 0.14, s * 0.08, 0.5, 0, 6.28); ctx.fill();
}
function drawNoteIcon(ctx, x, y, s, fill, strip) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(-0.12);
  ctx.fillStyle = 'rgba(0,0,0,.25)'; ctx.fillRect(-s * 0.5 + 1, -s * 0.4 + 2, s, s * 0.8);
  ctx.fillStyle = fill; ctx.fillRect(-s * 0.5, -s * 0.4, s, s * 0.8);
  ctx.fillStyle = strip || '#FFB531'; ctx.fillRect(-s * 0.5, -s * 0.4, s, s * 0.14);
  ctx.fillStyle = 'rgba(43,29,18,.45)'; ctx.fillRect(-s * 0.36, -s * 0.12, s * 0.7, s * 0.07); ctx.fillRect(-s * 0.36, s * 0.04, s * 0.5, s * 0.07);
  ctx.restore();
}
