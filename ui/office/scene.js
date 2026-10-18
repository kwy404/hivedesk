// The Office: the crew's floor as a refined isometric room drawn on one canvas
// (docs/1.0/DESIGN.md, section 6). Every pose comes from the engine state (worker.status, tasks,
// queue) and every effect (hand offs, speech bubbles, check marks, success pulses) from a real
// engine event. Shared by the full Office mode and the mini widget. Colors come from the theme
// tokens through ui/js/art.js.

import { beeSvg } from '/js/bees.js';
import { hub } from '/city/hub.js';
import { artTokens, worldPalette, statusColor, tone, mixHex, alpha, shade, rgb } from '/js/art.js';

const FONT = '"Inter","Segoe UI Variable Text","Segoe UI",system-ui,-apple-system,sans-serif';
const MONO = '"JetBrains Mono","Cascadia Mono","Cascadia Code",ui-monospace,Consolas,monospace';

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

/* ---------- small math helpers ---------- */
const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[(Math.random() * arr.length) | 0];

/* ---------- day and night ---------- */
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
    this.stars = Array.from({ length: 18 }, (_, i) => ({ u: ((i * 73) % 97) / 97, t: ((i * 41) % 61) / 61, r: 0.6 + ((i * 7) % 5) / 5, ph: i }));
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
    this.k = (a * 1.25) / 64; // bee sprite scale: px per SVG unit
    this.buildPaths();
    this.bgGrad = null;
    if (!this.running) this.draw();
  }

  /** Screen point (CSS px) of a world point. */
  P(x, y, z = 0) { return [this.ox + (x - y) * this.a, this.oy + (x + y) * this.b - z * this.c]; }

  /* ---------- state sync ---------- */
  reduced() { return this.reducedFn(); }

  /** Creates and removes actors to match the crew. `animate` walks new hires in through the door. */
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
      bubble: null, badge: null, hopAt: -9, squashAt: -9, ph: Math.random() * 6.28,
      nextGlyph: 0, nextZ: 0, nextBubble: 0, alpha: 1, fadeAt: -9, build: animate ? this.now : -9, leaving: false,
      level: 1, sx: 0, sy: 0,
    };
    if (animate && !this.reduced()) {
      a.pos = { ...DOOR };
      a.alpha = 0;
      a.fadeAt = this.now + 0.6;
      a.route.push({ to: { ...home }, dur: 1.4, lift: 0.5, delay: 0.7 });
      this.sound('build');
    }
    this.actors.set(w.id, a);
    return a;
  }

  removeActor(a, animate) {
    if (!animate || this.reduced()) { this.actors.delete(a.id); this.slotOf.delete(a.id); return; }
    a.leaving = true;
    a.route = [{ to: { ...DOOR }, dur: 1.2, lift: 0.5, after: () => { this.actors.delete(a.id); this.slotOf.delete(a.id); } }];
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
        if (mel) { this.pulse(mel, 'ok'); this.sound('pop'); }
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
        break;
      case 'task.handoff': {
        // The task engine says who handed what to whom (PLAN section 10): the bee carries it over.
        const from = d.from || d.fromAgent || d.fromWorker;
        const to = d.to || d.toAgent || d.toWorker;
        if (from && to && from !== to) this.handoff(from, to, d.kind === 'fix' || d.reason === 'rejected' ? 'bad' : 'parcel');
        break;
      }
      case 'task.status': {
        this.layoutNotes(false);
        const t = s.tasks[d.taskId];
        if (!t) break;
        const a = this.actors.get(t.assignee);
        if (d.status === 'done' && a) {
          // quiet success: a check mark and one short pulse; the count in the HUD goes up
          a.badge = { kind: 'ok', at: this.now, until: this.now + 1.8 };
          this.pulse(a, 'ok');
          this.opts.onHoney?.();
          const lv = levelOf(s, t.assignee);
          if (lv != null && lv > (this.levelSeen.get(t.assignee) || 1)) {
            // the level is a quiet badge in the name tag, never a burst
            this.levelSeen.set(t.assignee, lv);
            a.level = lv;
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
        if (d.tool === 'write_file' || d.tool === 'edit_file') { a.wroteAt = this.now; this.sound('type'); }
        break;
      }
      case 'tool.result': {
        const c = this.calls.get(d.callId);
        this.calls.delete(d.callId);
        if (!c) break;
        const a = this.actors.get(c.workerId);
        if (!a) break;
        if (c.tool === 'check' && typeof d.passed === 'boolean') {
          // tool.result.passed: the structured verdict of the checks. Without it no mark is shown.
          a.badge = { kind: d.passed ? 'ok' : 'bad', at: this.now, until: this.now + 2.6 };
          this.sound(d.passed ? 'pass' : 'fail');
        } else if (c.tool === 'check' && !d.ok) {
          a.badge = { kind: 'bad', at: this.now, until: this.now + 2.6 };
          this.sound('fail');
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
          if (d.passed) this.pulse(a, 'ok');
          this.sound(d.passed ? 'pass' : 'fail');
        }
        break;
      }
      case 'file.changed': {
        const a = this.actors.get(d.workerId);
        if (a) this.label(a, `${d.op === 'create' ? '+ ' : ''}${String(d.path || '').split('/').pop()}`, artTokens().text2, 1.2);
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
  /** A finished job: one calm success pulse on every bee. No confetti, no burst. */
  celebrate() {
    this.celebrateAt = this.now;
    this.celebrateUntil = this.now + 0.6;
    this.sound('confetti');
    for (const a of this.actors.values()) this.pulse(a, 'ok');
  }

  /** Mel answers what the user does: a nod on approve, a curious tilt on a new request. */
  melReact(kind) {
    const mel = this.actors.get('mel');
    if (!mel) return;
    mel.react = { kind, at: this.now };
    if (kind === 'nod') mel.bubble = { text: pick(['Thanks. On it.', 'Approved. Back to work.', 'Noted, moving on.']), at: this.now, until: this.now + 2.6 };
    if (kind === 'curious') mel.bubble = { text: pick(['A new request. Reading it.', 'New job. Let me look.']), at: this.now, until: this.now + 2.8 };
    if (kind === 'shake') mel.bubble = { text: 'Okay, we skip that.', at: this.now, until: this.now + 2.6 };
    mel.idleSince = this.now;
  }

  handoff(fromId, toId, item) {
    const a = this.actors.get(fromId);
    const b = this.actors.get(toId);
    if (!a || !b || a === b || a.leaving) return;
    const spot = this.visitSpot(b);
    const T = artTokens();
    const color = item === 'bad' ? T.bad : a.w.color;
    a.route.push(
      { to: spot, dur: null, lift: 0.5, item, color, hold: 0.5, onArrive: () => { this.pulse(b, 'info'); this.sound('pop'); }, dropItem: true },
      { to: 'home', dur: null, lift: 0.4 },
    );
  }

  visitSpot(b) {
    if (b.isMel) return { x: MEL_HOME.x + 0.95, y: MEL_HOME.y + 0.9, z: 1.2 };
    return { x: b.desk.x + DW / 2 + 0.15, y: b.desk.y + DD + 0.55, z: 1.0 };
  }

  /** Kept for the HUD counter hook: a finished task counts at once, nothing flies. */
  honeyJar() { this.opts.onHoney?.(); }

  label(a, text, color, life = 1.4) {
    if (this.mini) return;
    this.spawn({ kind: 'label', x: a.sx, y: a.sy - 46 * this.k, vy: -10, text, color, life, max: life });
  }

  /** A short ring that grows and fades at the bee's feet: the one shot feedback (at most 400 ms). */
  pulse(a, kind = 'ok') {
    if (this.reduced()) return;
    this.spawn({ kind: 'pulse', id: a.id, tone: kind, life: 0.4, max: 0.4 });
  }

  spawn(p) {
    if (this.reduced() && p.kind !== 'jar') return;
    if (this.parts.length > 120) this.parts.shift();
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
    const T = artTokens();
    if (job.type === 'place') {
      mel.route.push({ to: this.notePoint(n, n.tu, n.tt), dur: 0.45 * speed, lift: 0.08, item: 'note', color: n.task?.assignee ? this.actors.get(n.task.assignee)?.w.color : T.accent, hold: 0.12 * speed,
        onArrive: () => { n.state = 'free'; n.u = n.tu; n.t = n.tt; n.alpha = 1; n.pop = this.now; this.sound('stick'); }, dropItem: true });
    } else {
      mel.route.push(
        { to: this.notePoint(n), dur: 0.5 * speed, lift: 0.1, hold: 0.12 * speed, onArrive: () => { n.state = 'carried'; this.sound('peel'); } },
        { to: () => this.notePoint(n, n.tu, n.tt), dur: 0.7 * speed, lift: 0.2, item: 'note', color: T.accent, hold: 0.15 * speed,
          onArrive: () => { n.state = 'free'; n.u = n.tu; n.t = n.tt; n.pop = this.now; this.sound('stick'); }, dropItem: true },
      );
    }
    if (!this.melQueue.length) mel.route.push({ to: 'home', dur: null, lift: 0.15, delay: 0.3 });
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
    for (const a of this.actors.values()) if (a.seg || a.route.length || a.badge || (a.mode !== 'sleep' && a.mode !== 'idle' && a.mode !== 'paused')) return false;
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
    // with nothing to do, Mel says something useful now and then
    const mel = this.actors.get('mel');
    if (mel && !jobRunning && !this.mini && !mel.seg && !mel.bubble) {
      if (!this.nextIdleTalk) this.nextIdleTalk = now + 6;
      if (now > this.nextIdleTalk) {
        const lines = (s.jobs || []).length
          ? ['Board is clear. What is next?', 'The crew is free for another job.', 'Everything on the board is done.']
          : ['Type a request in the box above.', 'The crew is ready when you are.', 'A landing page or a small app: just ask.'];
        mel.bubble = { text: pick(lines), at: now, until: now + 4 };
        mel.idleSince = now;
        this.nextIdleTalk = now + rnd(28, 40);
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
          const dur = reduced ? 0 : next.dur ?? clamp(0.6 + dist * 0.12, 0.6, 2);
          a.seg = { ...next, from: { ...a.pos }, to, t0: now, dur, lift: (next.lift ?? 0.5) + dist * 0.03 };
          a.item = next.item || null;
          a.itemColor = next.color;
          if (dur > 0) this.sound('whoosh');
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
        // glide home smoothly
        const hx = a.mode === 'plan' && a.isMel ? a.home.x + Math.sin(now * 0.5) * 0.9 : a.home.x;
        const k = 1 - Math.pow(0.002, dt);
        a.pos.x = lerp(a.pos.x, hx, k);
        a.pos.y = lerp(a.pos.y, a.home.y, k);
        a.pos.z = lerp(a.pos.z, a.home.z + (a.mode === 'sleep' || a.mode === 'paused' ? -0.12 : 0), k);
        a.flyU = null;
      }

      if (a.fadeAt > 0) a.alpha = clamp((now - a.fadeAt) / 0.25);
      if (a.leaving && a.seg) a.alpha = 1 - clamp((now - a.seg.t0) / (a.seg.dur || 0.3));
      if (a.mode === 'type') typing++;
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
      p.vy += (p.g || 0) * dt;
      p.x += (p.vx || 0) * dt;
      p.y += (p.vy || 0) * dt;
    }
  }

  targetMode(a, st, jobRunning) {
    if (a.leaving) return 'fly';
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
    const T = artTokens();
    const key = `${Math.round(h * 12)}|${T.bg}|${T.accent}|${T.scheme}`;
    if (key === this.palAt && this.pal) return this.pal;
    this.palAt = key;
    const night = nightFactor(h);
    const gold = goldenFactor(h) * (1 - night * 0.6);
    const W = worldPalette(night);
    this.pal = { ...W, night, gold, hour: h };
    this.bgGrad = null;
    return this.pal;
  }

  buildPaths() {
    // hexagon floor grid in floor units (hairlines only: the honeycomb stays, quietly)
    const r = 0.44;
    const hw = Math.sqrt(3) * r;
    const vh = 1.5 * r;
    const grid = new Path2D();
    for (let row = -1; row * vh < RY + r; row++) {
      for (let col = -1; col * hw < RX + hw; col++) {
        const cx = col * hw + (row & 1 ? hw / 2 : 0);
        const cy = row * vh;
        for (let i = 0; i < 6; i++) {
          const ang = (Math.PI / 180) * (60 * i - 30);
          const px = cx + r * Math.cos(ang);
          const py = cy + r * Math.sin(ang);
          if (i === 0) grid.moveTo(px, py); else grid.lineTo(px, py);
        }
        grid.closePath();
      }
    }
    this.floorGrout = grid;
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

  box(x, y, z, dx, dy, dz, top, left, right, edge = 'rgba(0,0,0,.28)') {
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
    ctx.fillStyle = top;
    ctx.beginPath(); ctx.ellipse(bx, ty, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
  }

  draw() {
    if (!this.w) return;
    this.hits = [];
    const ctx = this.ctx;
    const pal = this.palette();
    this.base();
    // backdrop: the graphite void
    if (!this.bgGrad) {
      const g = ctx.createRadialGradient(this.w * 0.5, this.h * 0.4, 10, this.w * 0.5, this.h * 0.5, Math.max(this.w, this.h) * 0.75);
      g.addColorStop(0, pal.void0); g.addColorStop(1, pal.void1);
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
    list.push({ k: 13.3 + 4.9, f: () => this.drawPlant(13.3, 4.9, 1.1) });
    list.push({ k: 0.4 + 1.2, f: () => this.drawShelfUnit(pal) });
    list.sort((p, q) => p.k - q.k);
    for (const it of list) it.f();

    this.drawLights(pal);
    this.drawOverlay(pal);
    this.drawParticles();
  }

  drawRoom(pal) {
    const ctx = this.ctx;
    const T = pal.T;
    const P = (x, y, z) => this.P(x, y, z);
    // floor slab: two crisp faces
    this.poly([P(-0.16, RY, 0), P(RX, RY, 0), P(RX, RY, -SLAB), P(-0.16, RY, -SLAB)], pal.sideA);
    this.poly([P(RX, -0.16, 0), P(RX, RY, 0), P(RX, RY, -SLAB), P(RX, -0.16, -SLAB)], pal.sideB);
    this.poly([P(-0.16, RY, 0), P(RX, RY, 0)], null, alpha(T.text, 0.08));
    // floor with a hairline honeycomb grid and the team zone
    this.floorT();
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, RX, RY); ctx.clip();
    ctx.fillStyle = pal.floor; ctx.fillRect(0, 0, RX, RY);
    ctx.strokeStyle = pal.floorLine; ctx.lineWidth = 0.018; ctx.stroke(this.floorGrout);
    ctx.beginPath(); hexPath(ctx, 6.6, 5.5, 4.2);
    ctx.fillStyle = alpha(T.accent, 0.025); ctx.fill();
    ctx.lineWidth = 0.025; ctx.strokeStyle = alpha(T.accent, 0.28); ctx.stroke();
    // soft daylight through the windows
    if (pal.night < 0.85) {
      const al = (1 - pal.night) * 0.05;
      ctx.fillStyle = alpha(T.text, al);
      for (const [y0, y1] of [[2.2, 4.0], [5.6, 7.4]]) {
        ctx.beginPath(); ctx.moveTo(0, y0); ctx.lineTo(0, y1); ctx.lineTo(2.6, y1 + 1.5); ctx.lineTo(2.6, y0 + 1.5); ctx.closePath(); ctx.fill();
      }
    }
    ctx.restore();
    this.base();
    // walls: graphite planes with a thin base rule and a soft shade into the corner
    this.poly([P(0, 0, 0), P(0, RY, 0), P(0, RY, WALL), P(0, 0, WALL)], pal.wallL);
    this.poly([P(0, 0, 0), P(RX, 0, 0), P(RX, 0, WALL), P(0, 0, WALL)], pal.wallR);
    for (const side of ['L', 'R']) {
      if (side === 'L') this.leftT(); else this.rightT();
      const len = side === 'L' ? RY : RX;
      ctx.fillStyle = alpha(T.text, 0.035); ctx.fillRect(0, WALL - 0.12, len, 0.12);
      const g = ctx.createLinearGradient(side === 'L' ? RY : 0, 0, side === 'L' ? RY - 2.5 : 2.5, 0);
      g.addColorStop(0, 'rgba(0,0,0,.18)'); g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, len, WALL);
    }
    this.base();
    // wall caps and ends
    const Tt = 0.12;
    this.poly([P(0, 0, WALL), P(0, RY, WALL), P(-Tt, RY, WALL), P(-Tt, -Tt, WALL), P(RX, -Tt, WALL), P(RX, 0, WALL)], pal.cap);
    this.poly([P(-Tt, RY, 0), P(0, RY, 0), P(0, RY, WALL), P(-Tt, RY, WALL)], pal.capSide);
    this.poly([P(RX, -Tt, 0), P(RX, 0, 0), P(RX, 0, WALL), P(RX, -Tt, WALL)], shade(pal.capSide, -0.15));
    this.poly([P(0, 0, 0), P(0, 0, WALL)], null, 'rgba(0,0,0,.25)');

    this.drawWindows(pal);
    this.drawDoor(pal);
    this.drawClock(pal);
    this.drawHoneyShelf(pal);
  }

  drawWindows(pal) {
    const ctx = this.ctx;
    const T = pal.T;
    const night = pal.night;
    this.leftT();
    for (const [u0, u1] of [[2.6, 4.4], [6.0, 7.8]]) {
      const t0 = WALL - 2.28; const t1 = WALL - 0.98;
      ctx.save();
      ctx.beginPath(); ctx.rect(u0, t0, u1 - u0, t1 - t0); ctx.clip();
      const g = ctx.createLinearGradient(0, t0, 0, t1);
      g.addColorStop(0, pal.glassTop); g.addColorStop(1, pal.glassBot);
      ctx.fillStyle = g; ctx.fillRect(u0, t0, u1 - u0, t1 - t0);
      // a distant skyline, lit windows at night
      ctx.fillStyle = mixHex(pal.glassBot, T.bg, 0.5);
      for (let i = 0; i < 7; i++) { const bw = 0.22 + ((i * 37) % 5) * 0.03; const bh = 0.12 + ((i * 53) % 7) * 0.05; ctx.fillRect(u0 + i * 0.27, t1 - bh, bw, bh); }
      if (night > 0.5) {
        ctx.fillStyle = alpha(T.accent2, 0.55);
        for (let i = 0; i < 7; i++) ctx.fillRect(u0 + 0.06 + ((i * 29) % 17) * 0.1, t1 - 0.05 - ((i * 13) % 5) * 0.05, 0.025, 0.02);
        ctx.fillStyle = alpha(T.text, (night - 0.5) * 0.6);
        for (const s of this.stars) ctx.fillRect(u0 + s.u * (u1 - u0), t0 + s.t * (t1 - t0) * 0.6, 0.016 * s.r, 0.016 * s.r);
      }
      // one diagonal reflection
      ctx.fillStyle = pal.glassHi;
      ctx.beginPath(); ctx.moveTo(u0 + 0.2, t0); ctx.lineTo(u0 + 0.55, t0); ctx.lineTo(u0 + 0.15, t1); ctx.lineTo(u0 - 0.2, t1); ctx.closePath(); ctx.fill();
      ctx.restore();
      // a thin frame and one mullion
      ctx.strokeStyle = pal.cap; ctx.lineWidth = 0.035;
      ctx.strokeRect(u0, t0, u1 - u0, t1 - t0);
      ctx.lineWidth = 0.02;
      ctx.beginPath(); ctx.moveTo((u0 + u1) / 2, t0); ctx.lineTo((u0 + u1) / 2, t1); ctx.stroke();
    }
    this.base();
  }

  drawDoor(pal) {
    const ctx = this.ctx;
    this.rightT();
    const u0 = 11.9; const u1 = 13.0; const t0 = WALL - 2.05;
    ctx.fillStyle = pal.cap; ctx.fillRect(u0 - 0.04, t0 - 0.04, u1 - u0 + 0.08, WALL - t0 + 0.04);
    ctx.fillStyle = shade(pal.wallR, -0.25); ctx.fillRect(u0, t0, u1 - u0, WALL - t0);
    // a slim glass slit and the handle
    ctx.fillStyle = pal.glassTop; ctx.fillRect(u0 + 0.16, t0 + 0.16, 0.08, 1.2);
    ctx.fillStyle = pal.metal; ctx.fillRect(u1 - 0.2, t0 + 1.0, 0.04, 0.22);
    this.base();
  }

  drawClock(pal) {
    const ctx = this.ctx;
    const T = pal.T;
    this.rightT();
    const cu = 8.25; const ct = 0.78; const r = 0.3;
    ctx.fillStyle = pal.screen; ctx.beginPath(); ctx.arc(cu, ct, r, 0, 6.28); ctx.fill();
    ctx.strokeStyle = alpha(T.text, 0.18); ctx.lineWidth = 0.015; ctx.stroke();
    ctx.strokeStyle = alpha(T.text, 0.4); ctx.lineWidth = 0.015;
    for (let i = 0; i < 12; i++) {
      const an = (i / 12) * 6.283;
      ctx.beginPath(); ctx.moveTo(cu + Math.sin(an) * r * 0.8, ct - Math.cos(an) * r * 0.8); ctx.lineTo(cu + Math.sin(an) * r * 0.9, ct - Math.cos(an) * r * 0.9); ctx.stroke();
    }
    const h = pal.hour;
    const mins = (h % 1) * 60;
    const ha = ((h % 12) / 12) * 6.283;
    const ma = (mins / 60) * 6.283;
    ctx.lineCap = 'round';
    ctx.strokeStyle = T.text;
    ctx.lineWidth = 0.03; ctx.beginPath(); ctx.moveTo(cu, ct); ctx.lineTo(cu + Math.sin(ha) * r * 0.48, ct - Math.cos(ha) * r * 0.48); ctx.stroke();
    ctx.lineWidth = 0.02; ctx.beginPath(); ctx.moveTo(cu, ct); ctx.lineTo(cu + Math.sin(ma) * r * 0.72, ct - Math.cos(ma) * r * 0.72); ctx.stroke();
    ctx.lineCap = 'butt';
    ctx.fillStyle = T.accent; ctx.beginPath(); ctx.arc(cu, ct, 0.025, 0, 6.28); ctx.fill();
    this.base();
  }

  /** A small wall display with the number of finished tasks (it replaced the honey shelf). */
  drawHoneyShelf(pal) {
    const ctx = this.ctx;
    const T = pal.T;
    const done = doneCount(this.getState());
    this.rightT();
    const u0 = 9.15; const u1 = 11.45; const t0 = 0.6; const t1 = 1.55;
    ctx.fillStyle = pal.screen; ctx.fillRect(u0, t0, u1 - u0, t1 - t0);
    ctx.strokeStyle = alpha(T.text, 0.12); ctx.lineWidth = 0.012; ctx.strokeRect(u0, t0, u1 - u0, t1 - t0);
    ctx.fillStyle = T.ok; ctx.fillRect(u0, t0, 0.03, t1 - t0);
    this.rightT(100);
    ctx.fillStyle = alpha(T.text, 0.5); ctx.font = `600 11px ${FONT}`;
    ctx.fillText('TASKS DONE', (u0 + 0.14) * 100, (t0 + 0.24) * 100);
    ctx.fillStyle = T.text; ctx.font = `600 40px ${MONO}`;
    ctx.fillText(String(done), (u0 + 0.12) * 100, (t1 - 0.18) * 100);
    this.base();
  }

  drawBoard(pal) {
    const ctx = this.ctx;
    const T = pal.T;
    const { u0, u1, t0, t1 } = BOARD;
    this.rightT();
    // the kanban as a wall display
    ctx.fillStyle = 'rgba(0,0,0,.25)'; ctx.fillRect(u0 + 0.04, t0 + 0.05, u1 - u0, t1 - t0);
    ctx.fillStyle = pal.board; ctx.fillRect(u0, t0, u1 - u0, t1 - t0);
    ctx.strokeStyle = alpha(T.text, 0.12); ctx.lineWidth = 0.012; ctx.strokeRect(u0, t0, u1 - u0, t1 - t0);
    const cw = (u1 - u0 - 0.16) / 3;
    ctx.strokeStyle = alpha(T.text, 0.07); ctx.lineWidth = 0.012;
    ctx.beginPath();
    for (let c = 1; c < 3; c++) { const x = u0 + 0.08 + c * cw; ctx.moveTo(x, t0 + 0.08); ctx.lineTo(x, t1 - 0.06); }
    ctx.moveTo(u0 + 0.08, t0 + 0.36); ctx.lineTo(u1 - 0.08, t0 + 0.36);
    ctx.stroke();
    // column titles with counts
    this.rightT(100);
    ctx.font = `600 ${this.mini ? 18 : 13}px ${FONT}`;
    ctx.textBaseline = 'middle';
    const counts = [0, 0, 0];
    for (const n of this.notes.values()) if (!n.gone) counts[n.col]++;
    COLS.forEach((name, c) => {
      const x = (u0 + 0.08 + c * cw + 0.1) * 100;
      ctx.fillStyle = [T.muted, T.accent, T.ok][c];
      ctx.fillRect(x, (t0 + 0.2) * 100 - 4, 8, 8);
      ctx.fillStyle = alpha(T.text, 0.7);
      ctx.fillText(name.toUpperCase(), x + 14, (t0 + 0.2) * 100);
      ctx.fillStyle = alpha(T.text, 0.4);
      ctx.font = `500 ${this.mini ? 18 : 13}px ${MONO}`;
      ctx.textAlign = 'right';
      ctx.fillText(String(counts[c]), (u0 + 0.08 + (c + 1) * cw - 0.12) * 100, (t0 + 0.2) * 100);
      ctx.textAlign = 'left';
      ctx.font = `600 ${this.mini ? 18 : 13}px ${FONT}`;
    });
    ctx.textBaseline = 'alphabetic';
    // an empty board says so, plainly
    let live = 0;
    for (const n of this.notes.values()) if (!n.gone) live++;
    if (!live && !this.mini) {
      const cu = (u0 + u1) / 2; const ct = (t0 + t1) / 2 + 0.15;
      ctx.textAlign = 'center';
      ctx.fillStyle = alpha(T.text, 0.62); ctx.font = `600 17px ${FONT}`;
      ctx.fillText('Nothing on the board yet', cu * 100, (ct - 0.06) * 100);
      ctx.fillStyle = alpha(T.text, 0.38); ctx.font = `400 13px ${FONT}`;
      ctx.fillText('Ask the crew in the box above', cu * 100, (ct + 0.16) * 100);
      ctx.textAlign = 'left';
    }
    // the notes
    this.noteHits = [];
    for (const n of this.notes.values()) {
      if (n.state === 'hidden' || n.state === 'carried') continue;
      const fade = n.gone ? 1 - clamp((this.now - n.gone) / 0.25) : 1;
      if (fade <= 0) continue;
      this.drawNote(n, fade);
    }
    this.base();
  }

  drawNote(n, fade) {
    const ctx = this.ctx;
    const T = artTokens();
    const t = n.task || {};
    const appear = this.reduced() ? 1 : easeOut(clamp((this.now - n.pop) / 0.2));
    const w = n.w; const hgt = NOTE_H;
    const cx = n.u + w / 2; const cy = n.t + hgt / 2;
    this.rightT();
    ctx.save();
    ctx.globalAlpha = fade * appear;
    ctx.translate(cx, cy);
    const failed = t.status === 'failed' || t.status === 'blocked';
    const rule = failed ? T.bad : t.status === 'done' ? T.ok : t.status === 'skipped' ? T.faint : n.col === 1 ? T.accent : T.muted;
    ctx.fillStyle = this.pal?.card || T.panel3; ctx.fillRect(-w / 2, -hgt / 2, w, hgt);
    ctx.fillStyle = rule; ctx.fillRect(-w / 2, -hgt / 2, 0.035, hgt);
    if (this.highlight === n.id || this.dragTask === n.id) { ctx.strokeStyle = T.accent; ctx.lineWidth = 0.02; ctx.strokeRect(-w / 2, -hgt / 2, w, hgt); }
    ctx.scale(0.01, 0.01);
    if (!this.mini) {
      ctx.fillStyle = t.status === 'done' ? alpha(T.text, 0.6) : T.text;
      ctx.font = `500 14px ${FONT}`;
      const right = t.status === 'done' || failed ? 0.2 : 0.06;
      const line = wrap(ctx, t.title || '', (w - 0.14 - right) * 100, 1)[0] || '';
      ctx.fillText(line, (-w / 2 + 0.09) * 100, 0.05 * 100);
      if (t.status === 'done') { ctx.strokeStyle = T.ok; ctx.lineWidth = 2.4; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo((w / 2 - 0.17) * 100, 0); ctx.lineTo((w / 2 - 0.13) * 100, 4); ctx.lineTo((w / 2 - 0.06) * 100, -4); ctx.stroke(); ctx.lineCap = 'butt'; }
      if (failed) { ctx.fillStyle = T.bad; ctx.font = `700 15px ${FONT}`; ctx.fillText('!', (w / 2 - 0.11) * 100, 0.06 * 100); }
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
      const r = clamp(0.32 - z * 0.05, 0.14, 0.3);
      ctx.fillStyle = `rgba(0,0,0,${0.3 * a.alpha * clamp(1.4 - z * 0.25, 0.25, 1)})`;
      ctx.beginPath(); ctx.ellipse(a.pos.x, a.pos.y, r, r, 0, 0, 6.28); ctx.fill();
    }
    // desk shadows
    for (const a of this.actors.values()) {
      if (!a.desk) continue;
      ctx.fillStyle = 'rgba(0,0,0,.2)';
      ctx.fillRect(a.desk.x + 0.08, a.desk.y + 0.08, DW, DD);
    }
    this.base();
  }

  drawPodium(pal) {
    const ctx = this.ctx;
    const T = pal.T;
    const x = MEL_HOME.x; const y = MEL_HOME.y;
    // a hexagon podium with an amber rim
    const r = 0.42; const hgt = 0.62;
    const ring = [];
    for (let i = 0; i < 6; i++) { const an = (Math.PI / 3) * i + Math.PI / 6; ring.push([x + r * Math.cos(an), y + r * Math.sin(an)]); }
    for (let i = 0; i < 6; i++) {
      const p = ring[i]; const q = ring[(i + 1) % 6];
      const nx = (p[0] + q[0]) / 2 - x; const ny = (p[1] + q[1]) / 2 - y;
      if (nx + ny <= 0.01) continue;
      this.poly([this.P(p[0], p[1], 0), this.P(q[0], q[1], 0), this.P(q[0], q[1], hgt), this.P(p[0], p[1], hgt)], nx > ny ? pal.deskR : pal.deskL);
    }
    this.poly(ring.map((p) => this.P(p[0], p[1], hgt)), pal.deskTop, alpha(T.accent, 0.55), 1);
    void ctx;
  }

  drawDesk(a, pal) {
    const ctx = this.ctx;
    const T = pal.T;
    const { x, y } = a.desk;
    let sc = 1;
    if (a.build > 0) {
      const u = clamp((this.now - a.build) / 0.5);
      sc = easeOut(u);
      if (u >= 1) a.build = -9;
    }
    const fade = a.leaving ? clamp(1 - (a.seg ? (this.now - a.seg.t0) / 1.2 : 1)) : 1;
    ctx.save();
    ctx.globalAlpha = fade * sc;
    // a clean workstation: two slim legs, a slab top
    this.box(x + 0.06, y + 0.1, 0, 0.06, DD - 0.2, DH - 0.06, pal.leg, pal.leg, shade(pal.leg, -0.2));
    this.box(x + DW - 0.12, y + 0.1, 0, 0.06, DD - 0.2, DH - 0.06, pal.leg, pal.leg, shade(pal.leg, -0.2));
    this.box(x, y, DH - 0.06, DW, DD, 0.06, pal.deskTop, pal.deskL, pal.deskR, 'rgba(0,0,0,.2)');
    const z = DH;
    const col = tone(a.w.color || T.accent);
    const active = ['type', 'test', 'read', 'wait', 'stuck'].includes(a.mode);
    // the monitor: a thin slab facing the bee, its screen line lit in the agent color while it works
    const mx = x + 0.45; const my = y + 0.32; const mw = 0.9; const mh = 0.5;
    this.box(mx + mw / 2 - 0.05, my + 0.05, z, 0.1, 0.1, 0.12, pal.metal, pal.leg, pal.leg, null);
    this.box(mx, my, z + 0.12, mw, 0.04, mh, pal.screen, pal.screen, shade(pal.screen, -0.2), 'rgba(0,0,0,.35)');
    const s0 = this.P(mx + 0.06, my, z + 0.18); const s1 = this.P(mx + mw - 0.06, my, z + 0.18);
    ctx.strokeStyle = active ? col : alpha(T.text, 0.12); ctx.lineWidth = Math.max(1, this.a * 0.02);
    ctx.beginPath(); ctx.moveTo(s0[0], s0[1]); ctx.lineTo(s1[0], s1[1]); ctx.stroke();
    if (active) {
      // two code lines on the screen
      for (const [k, len] of [[0.36, 0.55], [0.28, 0.35]]) {
        const p0 = this.P(mx + 0.1, my, z + 0.12 + mh * (k + 0.2)); const p1 = this.P(mx + 0.1 + mw * len, my, z + 0.12 + mh * (k + 0.2));
        ctx.strokeStyle = alpha(col, 0.55); ctx.lineWidth = Math.max(0.8, this.a * 0.012);
        ctx.beginPath(); ctx.moveTo(p0[0], p0[1]); ctx.lineTo(p1[0], p1[1]); ctx.stroke();
      }
    }
    a.lampAt = this.P(mx + mw / 2, my, z + 0.4);
    ctx.restore();
  }

  drawChair(a, pal) {
    if (!a.desk) return;
    const x = a.home.x - 0.22; const y = a.home.y - 0.3;
    this.cyl(x + 0.22, y + 0.2, 0.02, 0.04, 0.4, pal.leg, pal.leg);
    this.box(x, y - 0.04, 0.42, 0.44, 0.44, 0.06, pal.partL, pal.partR, shade(pal.partR, -0.2), null);
    this.box(x, y - 0.08, 0.48, 0.44, 0.05, 0.5, pal.partL, pal.partL, shade(pal.partR, -0.25), null);
  }

  /** A minimal planter: a dark box and a faceted low poly crown. */
  drawPlant(x, y, s) {
    const ctx = this.ctx;
    const pal = this.pal;
    this.box(x - 0.18 * s, y - 0.18 * s, 0, 0.36 * s, 0.36 * s, 0.34 * s, pal.capSide, pal.leg, shade(pal.leg, -0.2), null);
    const b = this.P(x, y, 0.34 * s); const t = this.P(x, y, 1.15 * s);
    const w = this.a * 0.3 * s;
    ctx.fillStyle = pal.tree;
    ctx.beginPath(); ctx.moveTo(t[0], t[1]); ctx.lineTo(b[0] + w, b[1] - w * 0.2); ctx.lineTo(b[0], b[1] + w * 0.25); ctx.closePath(); ctx.fill();
    ctx.fillStyle = pal.treeB;
    ctx.beginPath(); ctx.moveTo(t[0], t[1]); ctx.lineTo(b[0] - w, b[1] - w * 0.2); ctx.lineTo(b[0], b[1] + w * 0.25); ctx.closePath(); ctx.fill();
  }

  drawCooler() { /* removed in 1.0: no decorative props without meaning */ }

  drawShelfUnit(pal) {
    // a storage rack against the left wall near the back, neutral spines
    const x = 0.02; const y = 0.55;
    this.box(x, y, 0, 0.42, 1.3, 1.75, pal.capSide, pal.leg, shade(pal.leg, -0.2), null);
    const T = pal.T;
    const spines = [pal.partL, pal.part, mixHex(pal.partL, T.info, 0.2), pal.partR, mixHex(pal.partL, T.accent, 0.18)];
    for (let row = 0; row < 3; row++) {
      const zz = 0.12 + row * 0.55;
      for (let i = 0; i < 5; i++) {
        const yy = y + 0.12 + i * 0.22;
        this.poly([this.P(x + 0.42, yy, zz), this.P(x + 0.42, yy + 0.16, zz), this.P(x + 0.42, yy + 0.16, zz + 0.32 + ((i + row) % 3) * 0.05), this.P(x + 0.42, yy, zz + 0.32 + ((i + row) % 3) * 0.05)], spines[(i * 2 + row) % spines.length]);
      }
    }
  }

  drawBee(a) {
    const ctx = this.ctx;
    const now = this.now;
    const reduced = this.reduced();
    const k = this.k;
    const T = artTokens();
    let hover = 0;
    let wingAmp = 0.12;
    let wingRate = 18;
    const m = a.seg ? 'fly' : a.mode;
    if (!reduced) {
      switch (m) {
        case 'fly': wingAmp = 0.22; wingRate = 30; break;
        case 'sleep': case 'paused': wingAmp = 0; hover = 0; break;
        case 'type': case 'test': case 'read': hover = Math.sin(now * 2.4 + a.ph) * 0.012; break;
        default: hover = Math.sin(now * 1.6 + a.ph) * 0.02;
      }
    } else wingAmp = 0;
    const p = this.P(a.pos.x, a.pos.y, a.pos.z + hover);
    a.sx = p[0]; a.sy = p[1];
    const ground = this.P(a.pos.x, a.pos.y, 0);
    // the status ring under the unit
    const sc = statusColor(m === 'fly' ? 'idle' : m, T);
    const sleep = m === 'sleep' || m === 'paused';
    const pulsing = (m === 'plan' || m === 'type') && !reduced;
    const ringA = sleep ? 0.45 : pulsing ? 0.55 + 0.35 * (0.5 + 0.5 * Math.sin(now * 3.4 + a.ph)) : 0.85;
    ctx.save();
    ctx.globalAlpha = a.alpha * ringA;
    ctx.strokeStyle = sc; ctx.lineWidth = Math.max(1.2, k * 2.2);
    if (sleep) ctx.setLineDash([3, 3]);
    // on the floor under the unit, like a selection ring
    ctx.beginPath(); ctx.ellipse(ground[0], ground[1], 18 * k, 7.5 * k, 0, 0, 6.28); ctx.stroke();
    ctx.restore();
    const img = this.sprite(a.w);
    ctx.save();
    ctx.globalAlpha = a.alpha * (m === 'paused' ? 0.6 : 1);
    ctx.translate(p[0], p[1]);
    // anchor: SVG point (32, 44) sits on the world point
    ctx.translate(-32 * k, -44 * k);
    // translucent wings behind the body, a low flutter
    const flap = wingAmp ? Math.sin(now * wingRate + a.ph) * wingAmp : 0;
    ctx.fillStyle = alpha(T.text, 0.12);
    ctx.strokeStyle = alpha(T.text, 0.42);
    ctx.lineWidth = Math.max(0.6, k);
    for (const [wx, dir] of [[19, -1], [45, 1]]) {
      ctx.save();
      ctx.translate(wx * k, 27 * k);
      ctx.rotate(dir * (0.42 - flap));
      ctx.beginPath(); ctx.ellipse(dir * 4 * k, -2 * k, 11 * k, 5.4 * k, 0, 0, 6.28);
      ctx.fill(); ctx.stroke();
      ctx.restore();
    }
    if (img) ctx.drawImage(img, -4 * k, -2 * k, 72 * k, 76 * k);
    else { ctx.fillStyle = tone(a.w.color || T.accent); ctx.beginPath(); ctx.arc(32 * k, 40 * k, 14 * k, 0, 6.28); ctx.fill(); }
    ctx.restore();
    // the thing in its hands
    if (a.item) {
      const hx = p[0]; const hy = p[1] + 18 * k;
      if (a.item === 'note' || a.item === 'bad') drawNoteIcon(ctx, hx, hy, 15 * k * 1.25, null, a.item === 'bad' ? T.bad : a.itemColor);
      else drawParcel(ctx, hx, hy, 14 * k * 1.25, a.itemColor || T.accent);
    }
    // the hit box for the DOM layer
    this.hits.push({ id: a.id, x: p[0] - 26 * k, y: p[1] - 40 * k, w: 52 * k, h: 70 * k });
  }

  sprite(w) {
    const px = Math.max(16, Math.round(this.k * 72 * this.dpr));
    const key = `${w.color}|${w.role}|${w.name}|${px}`;
    const sp = this.sprites.get(w.id);
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
    const ctx = this.ctx;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    // screens throw a faint light on busy units, a little more at night
    for (const a of this.actors.values()) {
      if (!['type', 'test', 'read'].includes(a.mode) || a.seg || !a.lampAt) continue;
      const r = this.a * 0.7;
      const [r0, g0, b0] = rgb(tone(a.w.color || pal.T.accent));
      const [x, y] = a.lampAt;
      const g = ctx.createRadialGradient(x, y, 1, x, y, r);
      g.addColorStop(0, `rgba(${r0},${g0},${b0},${0.06 + pal.night * 0.06})`); g.addColorStop(1, `rgba(${r0},${g0},${b0},0)`);
      ctx.fillStyle = g; ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
    ctx.restore();
  }

  /** Tags, bubbles, check marks and the waiting state: always on top, never darkened. */
  drawOverlay() {
    const ctx = this.ctx;
    const now = this.now;
    const k = this.k;
    const reduced = this.reduced();
    const s = this.getState();
    const T = artTokens();
    // info tags first, so bubbles sit on top of them
    if (!this.mini) {
      for (const a of this.actors.values()) {
        const at = a.desk ? this.P(a.desk.x + DW, a.desk.y + DD, 0) : this.P(MEL_HOME.x + 0.42, MEL_HOME.y + 0.42, 0);
        const on = this.highlight === a.id;
        const t = a.taskId && s.tasks?.[a.taskId];
        drawNameTag(ctx, at[0], at[1] + 6, a.w.name, levelOf(s, a.id), a.w.color, on, Math.max(10.5, Math.min(12, this.a * 0.2)),
          { status: statusColor(a.seg ? 'idle' : a.mode, T), role: a.w.role, task: t?.title || '' });
      }
    }
    for (const a of this.actors.values()) {
      const headY = a.sy - 40 * k;
      const m = a.seg ? 'fly' : a.mode;
      ctx.globalAlpha = a.alpha;
      if (m === 'stuck' && !this.mini) {
        // waiting for the user: a calm warn chip over the unit
        drawPill(ctx, a.sx, headY - 4, a.isMel ? 'Check the brief' : 'Needs your OK', T.warn, Math.max(10.5, Math.min(12, this.a * 0.19)));
      } else if (m === 'error') iconBang(ctx, a.sx + 20 * k, headY + 6 * k, Math.max(12, Math.min(18, this.a * 0.3)));
      if (a.badge) {
        const age = now - a.badge.at;
        const fade = clamp((a.badge.until - now) / 0.3) * (reduced ? 1 : easeOut(clamp(age / 0.2)));
        const bs = Math.max(12, Math.min(20, this.a * 0.3)) * (a.badge.big ? 1.2 : 1);
        ctx.globalAlpha = fade * a.alpha;
        (a.badge.kind === 'ok' ? iconCheck : iconX)(ctx, a.sx - 20 * k, headY + 8 * k - (reduced ? 0 : Math.min(age, 0.4) * 10), bs);
      }
      ctx.globalAlpha = 1;
      if (a.bubble && !this.mini) {
        const age = now - a.bubble.at;
        const fade = Math.min(clamp(age / 0.2), clamp((a.bubble.until - now) / 0.25));
        ctx.globalAlpha = fade;
        drawBubble(ctx, a.sx, headY - (m === 'stuck' ? 26 : 2), a.bubble.text, Math.max(11, Math.min(12.5, this.a * 0.2)), this.w, a.w.color);
        ctx.globalAlpha = 1;
      }
    }
    // carried notes ride with Mel
    const mel = this.actors.get('mel');
    if (mel) for (const n of this.notes.values()) if (n.state === 'carried') drawNoteIcon(ctx, mel.sx - 4, mel.sy + 18 * k, 16 * k * 1.3, null, this.actors.get(n.task?.assignee)?.w.color || T.accent);
  }

  drawParticles() {
    const ctx = this.ctx;
    const T = artTokens();
    for (const p of this.parts) {
      const life = 1 - p.age / p.max;
      switch (p.kind) {
        case 'pulse': {
          const a = this.actors.get(p.id);
          if (!a) break;
          const u = easeOut(p.age / p.max);
          ctx.globalAlpha = (1 - u) * 0.8 * a.alpha;
          ctx.strokeStyle = p.tone === 'info' ? T.info : T.ok; ctx.lineWidth = 1.5;
          const g = this.P(a.pos.x, a.pos.y, 0);
          ctx.beginPath(); ctx.ellipse(g[0], g[1], (18 + u * 12) * this.k, (7.5 + u * 5) * this.k, 0, 0, 6.28); ctx.stroke();
          break;
        }
        case 'label': {
          ctx.globalAlpha = clamp(life * 3);
          ctx.font = `500 ${Math.max(10, Math.min(11.5, this.a * 0.18))}px ${MONO}`;
          const tw = ctx.measureText(p.text).width;
          ctx.fillStyle = alpha(T.panel, 0.9);
          roundRect(ctx, p.x - tw / 2 - 6, p.y - 12, tw + 12, 17, 4); ctx.fill();
          ctx.fillStyle = p.color; ctx.textAlign = 'center'; ctx.fillText(p.text, p.x, p.y + 1); ctx.textAlign = 'left';
          break;
        }
        default: break;
      }
    }
    ctx.globalAlpha = 1;
  }

}

/* ---------- state helpers ---------- */
/** The agent's level from the City (xp the engine counts), or null when the engine has no city. */
export function levelOf(s, id) {
  const agents = hub.view?.()?.agents || s?.city?.agents;
  if (!agents) return null;
  const a = agents[id] || Object.values(agents).find((x) => x.workerId === id && !x.retired);
  return a ? a.level || 1 : null;
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

/* ---------- drawing helpers (screen space), shared with the City ---------- */
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

/**
 * The compact info tag under an agent: a status dot, the name and a quiet level badge. Hovered or
 * selected (`on`) with `more`, it expands to the role and the current task.
 * @param {{ status?: string, role?: string, task?: string }} [more]
 */
function drawNameTag(ctx, x, y, name, level, color, on, fs, more) {
  const T = artTokens();
  const lv = level != null ? `L${level}` : '';
  ctx.font = `600 ${fs}px ${FONT}`;
  const nw = ctx.measureText(name).width;
  ctx.font = `500 ${fs * 0.82}px ${MONO}`;
  const lw = lv ? ctx.measureText(lv).width + 6 : 0;
  const h = Math.round(fs + 8);
  const lines = [];
  if (on && more) {
    ctx.font = `400 ${fs * 0.92}px ${FONT}`;
    if (more.role) lines.push(wrap(ctx, more.role, 200, 1)[0] || '');
    if (more.task) lines.push(wrap(ctx, more.task, 200, 1)[0] || '');
  }
  ctx.font = `400 ${fs * 0.92}px ${FONT}`;
  const extraW = Math.max(0, ...lines.map((l) => ctx.measureText(l).width));
  const w = Math.max(nw + lw + fs + 14, extraW + 18);
  const H = h + lines.length * (fs + 4) + (lines.length ? 4 : 0);
  const x0 = Math.round(x - w / 2);
  ctx.fillStyle = alpha(T.panel, on ? 0.96 : 0.82);
  roundRect(ctx, x0, y, w, H, 4); ctx.fill();
  ctx.strokeStyle = on ? alpha(T.accent, 0.7) : alpha(T.text, 0.1); ctx.lineWidth = 1; ctx.stroke();
  // status dot (the ring color), then the name and the level
  ctx.fillStyle = more?.status || tone(color || T.accent);
  ctx.beginPath(); ctx.arc(x0 + 9, y + h / 2, Math.max(2.5, fs * 0.24), 0, 6.28); ctx.fill();
  ctx.font = `600 ${fs}px ${FONT}`;
  ctx.fillStyle = T.text;
  ctx.fillText(name, x0 + 16, y + h / 2 + fs * 0.36);
  if (lv) {
    ctx.font = `500 ${fs * 0.82}px ${MONO}`;
    ctx.fillStyle = T.muted;
    ctx.fillText(lv, x0 + 16 + nw + 6, y + h / 2 + fs * 0.32);
  }
  if (lines.length) {
    ctx.font = `400 ${fs * 0.92}px ${FONT}`;
    lines.forEach((l, i) => {
      ctx.fillStyle = i === 0 && more.role ? T.muted : T.text2;
      ctx.fillText(l, x0 + 9, y + h + 2 + (i + 1) * (fs + 4) - 4);
    });
  }
}

function drawBubble(ctx, x, y, text, fs, W, color) {
  const T = artTokens();
  ctx.font = `400 ${fs}px ${FONT}`;
  const maxW = Math.min(240, W * 0.3);
  const lines = wrap(ctx, text, maxW, 2);
  const tw = Math.max(...lines.map((l) => ctx.measureText(l).width));
  const pw = tw + 20; const ph = lines.length * (fs + 5) + 12;
  let bx = x - pw / 2;
  bx = Math.max(6, Math.min(W - pw - 6, bx));
  const by = y - ph - 8;
  ctx.fillStyle = alpha(T.panel2, 0.96);
  roundRect(ctx, bx, by, pw, ph, 6); ctx.fill();
  ctx.strokeStyle = alpha(T.text, 0.12); ctx.lineWidth = 1; ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x - 5, by + ph - 0.5); ctx.lineTo(x, by + ph + 6); ctx.lineTo(x + 5, by + ph - 0.5); ctx.closePath();
  ctx.fillStyle = alpha(T.panel2, 0.96); ctx.fill();
  ctx.fillStyle = tone(color || T.accent);
  ctx.fillRect(bx, by + 6, 2, ph - 12);
  ctx.fillStyle = T.text;
  lines.forEach((l, i) => ctx.fillText(l, bx + 11, by + 6 + fs * 0.92 + i * (fs + 5)));
}

/** A round status chip: panel fill, a hairline in the tone, a glyph drawn by `glyph`. */
function circleIcon(ctx, x, y, s, toneColor) {
  const T = artTokens();
  ctx.fillStyle = alpha(T.panel2, 0.96); ctx.beginPath(); ctx.arc(x, y, s / 2, 0, 6.28); ctx.fill();
  ctx.strokeStyle = alpha(toneColor, 0.75); ctx.lineWidth = 1; ctx.stroke();
}
function iconClock(ctx, x, y, s) {
  const T = artTokens();
  circleIcon(ctx, x, y, s, T.warn);
  ctx.strokeStyle = T.warn; ctx.lineCap = 'round'; ctx.lineWidth = Math.max(1.2, s * 0.08);
  ctx.beginPath(); ctx.moveTo(x, y - s * 0.24); ctx.lineTo(x, y); ctx.lineTo(x + s * 0.18, y + s * 0.1); ctx.stroke();
  ctx.lineCap = 'butt';
}
function iconCheck(ctx, x, y, s) {
  const T = artTokens();
  circleIcon(ctx, x, y, s, T.ok);
  ctx.strokeStyle = T.ok; ctx.lineWidth = Math.max(1.4, s * 0.1); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath(); ctx.moveTo(x - s * 0.2, y + s * 0.01); ctx.lineTo(x - s * 0.05, y + s * 0.15); ctx.lineTo(x + s * 0.21, y - s * 0.13); ctx.stroke();
  ctx.lineCap = 'butt'; ctx.lineJoin = 'miter';
}
function iconX(ctx, x, y, s) {
  const T = artTokens();
  circleIcon(ctx, x, y, s, T.bad);
  ctx.strokeStyle = T.bad; ctx.lineWidth = Math.max(1.4, s * 0.1); ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(x - s * 0.14, y - s * 0.14); ctx.lineTo(x + s * 0.14, y + s * 0.14); ctx.moveTo(x + s * 0.14, y - s * 0.14); ctx.lineTo(x - s * 0.14, y + s * 0.14); ctx.stroke();
  ctx.lineCap = 'butt';
}
/** A small chip: a dot in the tone and the text, on dark glass. `y` is the text baseline. */
function drawPill(ctx, x, y, text, color, fs) {
  const T = artTokens();
  ctx.font = `500 ${fs}px ${FONT}`;
  const tw = ctx.measureText(text).width;
  const w = tw + 24; const h = fs + 9;
  const x0 = Math.round(x - w / 2); const y0 = Math.round(y - fs - 2);
  ctx.fillStyle = alpha(T.panel, 0.92);
  roundRect(ctx, x0, y0, w, h, 4); ctx.fill();
  ctx.strokeStyle = alpha(color, 0.5); ctx.lineWidth = 1; ctx.stroke();
  ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x0 + 9, y0 + h / 2, 2.6, 0, 6.28); ctx.fill();
  ctx.fillStyle = T.text; ctx.fillText(text, x0 + 16, y0 + h / 2 + fs * 0.35);
}
function iconQuestion(ctx, x, y, s) {
  const T = artTokens();
  circleIcon(ctx, x, y, s, T.info);
  ctx.fillStyle = T.info; ctx.font = `600 ${s * 0.56}px ${FONT}`; ctx.textAlign = 'center'; ctx.fillText('?', x, y + s * 0.2); ctx.textAlign = 'left';
}
function iconPause(ctx, x, y, s) {
  const T = artTokens();
  circleIcon(ctx, x, y, s, T.muted);
  ctx.fillStyle = T.muted; ctx.fillRect(x - s * 0.15, y - s * 0.18, s * 0.1, s * 0.36); ctx.fillRect(x + s * 0.05, y - s * 0.18, s * 0.1, s * 0.36);
}
function iconBang(ctx, x, y, s) {
  const T = artTokens();
  circleIcon(ctx, x, y, s, T.bad);
  ctx.fillStyle = T.bad; ctx.font = `700 ${s * 0.56}px ${FONT}`; ctx.textAlign = 'center'; ctx.fillText('!', x, y + s * 0.2); ctx.textAlign = 'left';
}
function iconFlask(ctx, x, y, s) {
  const T = artTokens();
  circleIcon(ctx, x, y, s, T.ok);
  ctx.strokeStyle = T.ok; ctx.lineWidth = Math.max(1.2, s * 0.08); ctx.lineJoin = 'round';
  ctx.beginPath(); ctx.moveTo(x - s * 0.07, y - s * 0.22); ctx.lineTo(x - s * 0.07, y - s * 0.04); ctx.lineTo(x - s * 0.2, y + s * 0.2); ctx.lineTo(x + s * 0.2, y + s * 0.2); ctx.lineTo(x + s * 0.07, y - s * 0.04); ctx.lineTo(x + s * 0.07, y - s * 0.22); ctx.stroke();
  ctx.lineJoin = 'miter';
}
function iconMag(ctx, x, y, s) {
  const T = artTokens();
  circleIcon(ctx, x, y, s, T.info);
  ctx.strokeStyle = T.info; ctx.lineWidth = Math.max(1.2, s * 0.08); ctx.lineCap = 'round';
  ctx.beginPath(); ctx.arc(x - s * 0.05, y - s * 0.05, s * 0.15, 0, 6.28); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x + s * 0.06, y + s * 0.06); ctx.lineTo(x + s * 0.2, y + s * 0.2); ctx.stroke();
  ctx.lineCap = 'butt';
}
function iconDots(ctx, x, y, s, t) {
  const T = artTokens();
  ctx.fillStyle = alpha(T.panel2, 0.96);
  roundRect(ctx, x - s * 0.5, y - s * 0.3, s, s * 0.6, s * 0.3); ctx.fill();
  ctx.strokeStyle = alpha(T.accent, 0.6); ctx.lineWidth = 1; ctx.stroke();
  for (let i = 0; i < 3; i++) {
    const on = Math.floor(t * 2) % 3 === i;
    ctx.fillStyle = on ? T.accent : T.muted;
    ctx.beginPath(); ctx.arc(x - s * 0.22 + i * s * 0.22, y, s * 0.06, 0, 6.28); ctx.fill();
  }
}
/** Kept for older callers: a finished task, drawn as a quiet check chip (no jars in 1.0). */
export function iconJar(ctx, x, y, s) { iconCheck(ctx, x, y, s); }
/** A compute packet: a small hexagon outline in the link or agent color. */
function drawParcel(ctx, x, y, s, color) {
  const T = artTokens();
  ctx.fillStyle = alpha(T.panel2, 0.95); ctx.beginPath(); hexScreen(ctx, x, y, s * 0.42); ctx.fill();
  ctx.strokeStyle = color || T.link; ctx.lineWidth = 1.2; ctx.stroke();
  ctx.fillStyle = color || T.link; ctx.beginPath(); hexScreen(ctx, x, y, s * 0.16); ctx.fill();
}
/** A task card in flight: a dark card with a colored rule. `fill` is ignored (kept for older callers). */
function drawNoteIcon(ctx, x, y, s, fill, strip) {
  const T = artTokens();
  void fill;
  ctx.save(); ctx.translate(Math.round(x), Math.round(y));
  ctx.fillStyle = alpha(T.panel3, 0.97); roundRect(ctx, -s * 0.5, -s * 0.34, s, s * 0.68, 2); ctx.fill();
  ctx.strokeStyle = alpha(T.text, 0.14); ctx.lineWidth = 1; ctx.stroke();
  ctx.fillStyle = strip || T.accent; ctx.fillRect(-s * 0.5, -s * 0.34, Math.max(1.5, s * 0.08), s * 0.68);
  ctx.fillStyle = alpha(T.text, 0.45); ctx.fillRect(-s * 0.28, -s * 0.12, s * 0.62, Math.max(1, s * 0.06)); ctx.fillRect(-s * 0.28, s * 0.06, s * 0.42, Math.max(1, s * 0.06));
  ctx.restore();
}

// Shared with the City scene (ui/city/scene.js), which reuses the Office kit.
export { roundRect, hexPath, hexScreen, wrap, drawNameTag, drawBubble, drawPill, iconClock, iconCheck, iconX, iconDots, iconMag, iconFlask, iconQuestion, iconPause, iconBang, drawNoteIcon, drawParcel, mixHex, shade, alpha, rgb, goldenFactor };
