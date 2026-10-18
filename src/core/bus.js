// Event bus v2 (PLAN.md section 1.3 and 1.4).
// One append only log per project, in segments; a store of domain reducers; snapshots so a start
// replays only the tail; an origin and an optional cause on every event; schema checks on emit.
import fs from 'node:fs';
import path from 'node:path';
import { SegmentLog, parseEvents } from './log.js';
import { SnapshotStore, SNAPSHOT_EVERY, SNAPSHOT_MS } from './snapshots.js';
import { Store } from './store.js';
import { checkEvent } from './events.js';
import { normalizeOrigin, currentContext, SYSTEM } from './origin.js';

const WARN_LIMIT = 50;

export class SchemaError extends Error {
  constructor(type, errors) {
    super(`event ${type}: ${errors.join('; ')}`);
    this.code = 'bad_event';
    this.errors = errors;
  }
}

/** strict: unknown or bad types throw. check: bad registered types throw (the default under vitest). warn: counted only. */
function strictnessFrom(opt) {
  if (opt === true || opt === 'strict') return 'strict';
  if (opt === 'check') return 'check';
  if (opt === false || opt === 'warn') return 'warn';
  if (process.env.HIVEDESK_STRICT === '1') return 'strict';
  return process.env.VITEST ? 'check' : 'warn';
}

export class EventBus {
  /**
   * @param {{
   *   dir?: string, file?: string, snapshotFile?: string, readOnly?: boolean,
   *   demo?: boolean, version?: string, lend?: boolean, strict?: boolean | 'strict' | 'check' | 'warn',
   *   segmentBytes?: number, snapshotEvery?: number, snapshotMs?: number, domains?: any[]
   * }} opts
   * dir: the project's .hivedesk folder (segments in events/, snapshots in snapshots/, the 0.x events.jsonl read first).
   * file: one log file and no snapshots (the 0.x layout). Neither: the log lives in memory only (tests).
   */
  constructor(opts = {}) {
    const started = Date.now();
    this.root = opts.dir || null;
    this.readOnly = !!opts.readOnly;
    this.file = opts.file || (this.root ? path.join(this.root, 'events.jsonl') : null);
    this.snapshotFile = opts.snapshotFile || null;
    this.demo = !!opts.demo;
    this.meta = { version: opts.version, demo: this.demo, lend: !!opts.lend };
    this.strictness = strictnessFrom(opts.strict);
    this.snapshotEvery = opts.snapshotEvery || SNAPSHOT_EVERY;
    this.snapshotMs = opts.snapshotMs || SNAPSHOT_MS;
    /** @type {Array<{ type: string, errors: string[] }>} */
    this.warnings = [];
    this.listeners = new Set();
    this.liveListeners = new Set();
    this.log = this.file ? new SegmentLog({ dir: this.root ? path.join(this.root, 'events') : null, legacyFile: this.file, segmentBytes: opts.segmentBytes, readOnly: this.readOnly }) : null;
    this.snapshots = this.root ? new SnapshotStore({ dir: path.join(this.root, 'snapshots'), readOnly: this.readOnly }) : null;
    this.store = new Store({ meta: this.meta, domains: opts.domains });

    // ---- restore: the newest usable snapshot, then the events after it ----
    let tail = [];
    this._base = 0;
    this._baseDump = null;
    if (this.log) {
      const last = this.log.lastEvent();
      const lastSeq = last ? last.seq : 0;
      const snap = this.snapshots ? this.snapshots.latest(lastSeq, (s) => this.store.accepts(s.store)) : null;
      if (snap && this.store.load(snap.store)) {
        this._base = snap.seq;
        this._baseDump = snap.store;
        tail = this.log.readFrom(snap.seq);
      } else {
        tail = this.log.readAll();
      }
    }
    this._tail = tail;
    /** every event, read from disk only when someone asks for history before the snapshot */
    this._all = this._base === 0 ? tail : null;
    this.store.replay(tail);
    this.seq = tail.length ? tail[tail.length - 1].seq : this._base;
    this._sinceSnapshot = tail.length;
    this.restore = { snapshotSeq: this._base, replayed: tail.length, ms: Date.now() - started };
    this._applyMeta(this.state);
    this._snapTimer = null;
    this._snapClock = null;
    if (this.snapshots && !this.readOnly) {
      this._snapClock = setInterval(() => { if (this._sinceSnapshot > 0) this.writeStoreSnapshot(); }, this.snapshotMs);
      this._snapClock.unref?.();
    }
  }

  /** bus.state: the 0.x crew state at the root, with city, board (1.0 tasks) and the other domains mounted on it. */
  get state() {
    return this.store.state;
  }

  /** Every event since the log began. Loaded from the segments on first use when the start used a snapshot. */
  get events() {
    if (!this._all) {
      const all = this.log ? this.log.readFrom(0) : [];
      // Events emitted since the start are already on disk; keep the in memory copies (the same objects listeners saw).
      const firstLive = this._tail.length ? this._tail[0].seq : Infinity;
      this._all = all.filter((e) => e.seq < firstLive).concat(this._tail);
    }
    return this._all;
  }

  _applyMeta(s) {
    s.demo = this.demo;
    s.lend = this.meta.lend;
    if (this.meta.version) s.version = this.meta.version;
    return s;
  }

  _check(type, data) {
    if (typeof type !== 'string' || !type) throw new SchemaError(String(type), ['the type must be a non empty string']);
    const { known, errors } = checkEvent(type, data);
    if (!errors.length) return;
    const fatal = this.strictness === 'strict' || (this.strictness === 'check' && known);
    if (fatal) throw new SchemaError(type, errors);
    if (this.warnings.length < WARN_LIMIT) this.warnings.push({ type, errors });
  }

  /**
   * Appends and broadcasts an event.
   * @param {string} type
   * @param {object} [data]
   * @param {{ jobId?: string, origin?: { kind: string, peerId?: string, agentId?: string }, cause?: number | string }} [opts]
   * The origin and cause default to those of the running command or job (src/core/origin.js), else system.
   */
  emit(type, data = {}, opts = {}) {
    if (this.readOnly) throw Object.assign(new Error('this log is open read only'), { code: 'conflict' });
    this._check(type, data);
    const ctx = currentContext();
    const event = { seq: this.seq + 1, ts: new Date().toISOString(), type };
    if (opts.jobId) event.jobId = opts.jobId;
    if (this.demo) event.demo = true;
    event.origin = normalizeOrigin(opts.origin || ctx?.origin || SYSTEM);
    const cause = opts.cause ?? ctx?.cause;
    if (cause !== undefined && cause !== null) event.cause = cause;
    event.data = data;
    if (this.log) this.log.append(event);
    this.seq = event.seq;
    this._tail.push(event);
    if (this._all && this._all !== this._tail) this._all.push(event);
    this.store.apply(event);
    this._applyMeta(this.state);
    this._sinceSnapshot += 1;
    if (this.snapshots && this._sinceSnapshot >= this.snapshotEvery) this.writeStoreSnapshot();
    this._scheduleSnapshot();
    for (const fn of this.listeners) {
      try { fn(event); } catch { /* a listener must never break the log */ }
    }
    return event;
  }

  /** Ephemeral frame, not logged (tokens, load, presence, progress). */
  live(type, data = {}) {
    for (const fn of this.liveListeners) {
      try { fn(type, data); } catch { /* ignore */ }
    }
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  onLive(fn) { this.liveListeners.add(fn); return () => this.liveListeners.delete(fn); }

  since(seq = 0, limit = 1000) {
    const list = seq >= this._base ? this._tail : this.events;
    const out = [];
    for (const e of list) {
      if (e.seq > seq) {
        out.push(e);
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  /** The whole state at any seq: from the start snapshot when the seq is after it, else from the first event. */
  stateAt(seq) {
    const store = new Store({ meta: this.meta, domains: this.store.domains });
    if (this._baseDump && seq >= this._base) {
      store.load(this._baseDump);
      store.replay(this._tail, seq);
    } else {
      store.replay(this.events, seq);
    }
    return this._applyMeta(store.state);
  }

  /** Writes a store snapshot now (snapshots/<seq>.json). */
  writeStoreSnapshot() {
    if (!this.snapshots || this.readOnly || !this.seq) return null;
    try {
      const file = this.snapshots.write(this.seq, { v: 1, ts: new Date().toISOString(), store: this.store.dump() });
      this._sinceSnapshot = 0;
      return file;
    } catch {
      return null; /* a snapshot is only a shortcut; the log is the truth */
    }
  }

  _scheduleSnapshot() {
    if (!this.snapshotFile || this._snapTimer) return;
    this._snapTimer = setTimeout(() => {
      this._snapTimer = null;
      this.writeSnapshot();
    }, 2000);
    this._snapTimer.unref?.();
  }

  /** The 0.x state.json cache (PROTOCOL.md section 7). */
  writeSnapshot() {
    if (!this.snapshotFile || this.readOnly) return;
    try {
      const tmp = this.snapshotFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.state));
      fs.renameSync(tmp, this.snapshotFile);
    } catch { /* the snapshot is only a cache */ }
  }

  /** Facts about the log on disk, for `store.info`, the doctor and `hivedesk city`. */
  info() {
    return {
      lastSeq: this.seq,
      segments: this.log ? this.log.segments().map((s) => ({ file: path.basename(s.file), firstSeq: s.firstSeq, legacy: s.legacy, bytes: safeSize(s.file) })) : [],
      bytes: this.log ? this.log.bytes() : 0,
      snapshots: this.snapshots ? this.snapshots.list().map((s) => s.seq) : [],
      restore: { ...this.restore },
      warnings: this.warnings.length,
      strictness: this.strictness
    };
  }

  close() {
    if (this._snapTimer) clearTimeout(this._snapTimer);
    this._snapTimer = null;
    if (this._snapClock) clearInterval(this._snapClock);
    this._snapClock = null;
    if (this._sinceSnapshot > 0) this.writeStoreSnapshot();
    this.writeSnapshot();
  }
}

function safeSize(file) {
  try { return fs.statSync(file).size; } catch { return 0; }
}

/** Reads one jsonl event file, skipping a torn last line. */
export function readEventsFile(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  return parseEvents(text);
}
