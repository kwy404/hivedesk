// Append-only event log plus live state. events.jsonl is the source of truth.
import fs from 'node:fs';
import path from 'node:path';
import { initialState, reduce, replay } from './replay/reduce.js';
import { reduceCity, replayCity } from './city/state.js';

export class EventBus {
  /**
   * @param {{ file?: string, snapshotFile?: string, demo?: boolean, version?: string, lend?: boolean }} opts
   * Without `file` the log lives in memory only (tests).
   */
  constructor(opts = {}) {
    this.file = opts.file || null;
    this.snapshotFile = opts.snapshotFile || null;
    this.demo = !!opts.demo;
    this.meta = { version: opts.version, demo: this.demo, lend: !!opts.lend };
    /** @type {any[]} */
    this.events = [];
    this.listeners = new Set();
    this.liveListeners = new Set();
    this.seq = 0;
    if (this.file && fs.existsSync(this.file)) this.events = readEventsFile(this.file);
    this.seq = this.events.length ? this.events[this.events.length - 1].seq : 0;
    this.state = replay(this.events, Infinity, this.meta);
    // Hive City (src/city/): the same log, its own pure reducer (CITY-PROTOCOL.md).
    this.state.city = replayCity(this.events);
    // This run decides the Demo label, not an old demo run in the same log.
    this.state.demo = this.demo;
    this.state.lend = this.meta.lend;
    if (opts.version) this.state.version = opts.version;
    this._snapTimer = null;
  }

  /**
   * Appends and broadcasts an event.
   * @param {string} type
   * @param {object} [data]
   * @param {{ jobId?: string }} [opts]
   */
  emit(type, data = {}, opts = {}) {
    const event = { seq: ++this.seq, ts: new Date().toISOString(), type };
    if (opts.jobId) event.jobId = opts.jobId;
    if (this.demo) event.demo = true;
    event.data = data;
    this.events.push(event);
    if (this.file) fs.appendFileSync(this.file, JSON.stringify(event) + '\n');
    reduce(this.state, event);
    reduceCity(this.state.city, event);
    this._scheduleSnapshot();
    for (const fn of this.listeners) {
      try { fn(event); } catch (err) { /* a listener must never break the log */ }
    }
    return event;
  }

  /** Ephemeral frame, not logged. */
  live(type, data = {}) {
    for (const fn of this.liveListeners) {
      try { fn(type, data); } catch { /* ignore */ }
    }
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  onLive(fn) { this.liveListeners.add(fn); return () => this.liveListeners.delete(fn); }

  since(seq = 0, limit = 1000) {
    const out = [];
    for (const e of this.events) {
      if (e.seq > seq) {
        out.push(e);
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  stateAt(seq) {
    const s = replay(this.events, seq, this.meta);
    s.city = replayCity(this.events, seq);
    s.demo = this.demo || s.demo;
    return s;
  }

  _scheduleSnapshot() {
    if (!this.snapshotFile || this._snapTimer) return;
    this._snapTimer = setTimeout(() => {
      this._snapTimer = null;
      this.writeSnapshot();
    }, 2000);
    this._snapTimer.unref?.();
  }

  writeSnapshot() {
    if (!this.snapshotFile) return;
    try {
      const tmp = this.snapshotFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.state));
      fs.renameSync(tmp, this.snapshotFile);
    } catch { /* the snapshot is only a cache */ }
  }

  close() {
    if (this._snapTimer) clearTimeout(this._snapTimer);
    this._snapTimer = null;
    this.writeSnapshot();
  }
}

/** Reads a jsonl event file, skipping a torn last line. */
export function readEventsFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (typeof e.seq === 'number') out.push(e);
    } catch { /* torn write at crash time */ }
  }
  return out;
}

/** Creates the .hivedesk layout inside `dir` and returns the paths. */
export function initHome(dir) {
  const root = path.join(dir, '.hivedesk');
  const paths = {
    root,
    events: path.join(root, 'events.jsonl'),
    state: path.join(root, 'state.json'),
    playbooks: path.join(root, 'playbooks'),
    workspace: path.join(root, 'workspace'),
    city: path.join(root, 'city')
  };
  for (const p of [root, paths.playbooks, paths.workspace]) fs.mkdirSync(p, { recursive: true });
  return paths;
}

/** True when this folder holds a hivedesk log written by a real (not demo) run. */
export function hasRealLog(dir) {
  let text;
  try { text = fs.readFileSync(path.join(dir, '.hivedesk', 'events.jsonl'), 'utf8'); } catch { return false; }
  // emit() writes seq, ts, type, jobId and demo before data, so the label sits before "data":.
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const at = line.indexOf('"data":');
    if (!(at === -1 ? line : line.slice(0, at)).includes('"demo":true')) return true;
  }
  return false;
}

export { initialState };
