// Search and replace across the files of a root, in a pool of two worker threads (PLAN 11.2).
// Walks with the ignore rules (.git, node_modules, .hivedesk, .gitignore), literal or regular
// expression, case, whole word, include and exclude globs, at most 5,000 hits, files up to 2 MB.
import { Worker } from 'node:worker_threads';
import { walkFiles, MAX_SEARCH_BYTES } from './walk.js';
import { buildRegex } from './match.js';
import { WorkbenchError } from './origin.js';

export const MAX_HITS = 5000;
const CHUNK = 120;

export class SearchPool {
  constructor({ size = 2 } = {}) {
    this.size = size;
    this.workers = [];
    this.queue = [];
    this.seq = 0;
    this.closed = false;
  }

  _spawn() {
    const w = new Worker(new URL('./search-worker.js', import.meta.url));
    w.unref();
    const slot = { w, part: null };
    w.on('message', (msg) => {
      const part = slot.part;
      slot.part = null;
      if (part && msg.id === part.id) {
        if (msg.ok) part.resolve(msg);
        else part.reject(Object.assign(new Error(msg.error), { code: msg.code || 'internal' }));
      }
      this._pump();
    });
    const gone = (err) => {
      this.workers = this.workers.filter((s) => s !== slot);
      const part = slot.part;
      slot.part = null;
      if (part) part.reject(part.cancelled ? Object.assign(new Error('cancelled'), { code: 'cancelled' }) : (err || new Error('the search worker stopped')));
      this._pump();
    };
    w.on('error', gone);
    w.on('exit', () => gone(null));
    this.workers.push(slot);
    return slot;
  }

  _pump() {
    if (this.closed) return;
    while (this.queue.length) {
      let slot = this.workers.find((s) => !s.part);
      if (!slot && this.workers.length < this.size) slot = this._spawn();
      if (!slot) return;
      const part = this.queue.shift();
      slot.part = part;
      slot.w.postMessage(part.job);
    }
  }

  /** Runs one part of a search on a free worker. */
  run(owner, job) {
    if (this.closed) return Promise.reject(new Error('closed'));
    return new Promise((resolve, reject) => {
      const part = { id: job.id = `p${++this.seq}`, owner, job, resolve, reject, cancelled: false };
      this.queue.push(part);
      this._pump();
    });
  }

  /** Cancels every queued and running part of one search; running workers are terminated. */
  cancel(owner) {
    const err = Object.assign(new Error('cancelled'), { code: 'cancelled' });
    this.queue = this.queue.filter((p) => {
      if (p.owner !== owner) return true;
      p.reject(err);
      return false;
    });
    for (const s of this.workers) {
      if (s.part?.owner === owner) {
        s.part.cancelled = true;
        s.w.terminate();
      }
    }
  }

  async close() {
    this.closed = true;
    for (const p of this.queue) p.reject(Object.assign(new Error('closed'), { code: 'cancelled' }));
    this.queue = [];
    await Promise.all(this.workers.map((s) => s.w.terminate()));
    this.workers = [];
  }
}

function cleanSpec(d) {
  const list = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : []).map((s) => String(s).trim()).filter(Boolean).slice(0, 40);
  return {
    query: typeof d.query === 'string' ? d.query : '',
    regex: !!d.regex,
    caseSensitive: !!d.caseSensitive,
    wholeWord: !!d.wholeWord,
    include: list(d.include),
    exclude: list(d.exclude)
  };
}

export class Searcher {
  /** @param {{ pool?: SearchPool, excludes?: () => string[] }} [o] */
  constructor(o = {}) {
    this.pool = o.pool || new SearchPool();
    this.excludes = o.excludes || (() => []);
    this.running = new Map();
    this.previews = new Map();
    this.seq = 0;
  }

  _files(root, spec) {
    const r = walkFiles(root.path, { include: spec.include, exclude: [...this.excludes(), ...spec.exclude], maxFiles: 50000 });
    return { files: r.files.filter((f) => f.bytes <= MAX_SEARCH_BYTES), truncatedWalk: r.truncated, skippedLarge: r.skippedLarge };
  }

  /**
   * Searches a root. `onResult({ path, hits })` streams each matching file.
   * @returns {Promise<{ searchId: string, files: number, hits: number, scanned: number, truncated: boolean, timedOut: boolean, cancelled: boolean, skippedLarge: number, ms: number }>}
   */
  async search(root, data, { onResult = () => {}, maxHits = MAX_HITS, timeoutMs = 30_000, searchId } = {}) {
    const spec = cleanSpec(data);
    try { buildRegex(spec); } catch (err) { throw new WorkbenchError('bad_request', err.message); }
    const id = searchId || `s${++this.seq}`;
    const started = Date.now();
    const { files, truncatedWalk, skippedLarge } = this._files(root, spec);
    const cap = Math.min(MAX_HITS, Math.max(1, Number(maxHits) || MAX_HITS));
    const state = { hits: 0, files: 0, scanned: 0, truncated: truncatedWalk, timedOut: false, cancelled: false };
    this.running.set(id, state);
    const timer = setTimeout(() => { state.timedOut = true; this.pool.cancel(id); }, timeoutMs);
    timer.unref?.();
    const parts = [];
    for (let i = 0; i < files.length; i += CHUNK) {
      const chunk = files.slice(i, i + CHUNK).map((f) => ({ rel: f.rel, abs: f.abs }));
      parts.push(this.pool.run(id, { type: 'search', files: chunk, spec, limit: cap }).then((msg) => {
        state.scanned += msg.scanned;
        for (const r of msg.results) {
          if (state.hits >= cap) { state.truncated = true; break; }
          const room = cap - state.hits;
          const hits = r.hits.length > room ? r.hits.slice(0, room) : r.hits;
          if (hits.length < r.hits.length) state.truncated = true;
          state.hits += hits.length;
          state.files++;
          onResult({ path: r.path, hits });
        }
        if (state.hits >= cap) { state.truncated = true; this.pool.cancel(id); }
      }, (err) => {
        if (err.code !== 'cancelled') throw err;
      }));
    }
    try {
      await Promise.all(parts);
    } finally {
      clearTimeout(timer);
      this.running.delete(id);
    }
    return { searchId: id, files: state.files, hits: state.hits, scanned: state.scanned, truncated: state.truncated, timedOut: state.timedOut, cancelled: state.cancelled, skippedLarge, ms: Date.now() - started };
  }

  cancel(searchId) {
    const s = this.running.get(searchId);
    if (!s) return false;
    s.cancelled = true;
    this.pool.cancel(searchId);
    return true;
  }

  /**
   * Computes a replace over the matching files without writing anything.
   * @returns {Promise<{ previewId: string, files: Array<{ path: string, count: number, changes: Array<{ line: number, before: string, after: string }> }>, total: number, timedOut: boolean }>}
   */
  async previewReplace(root, data, { timeoutMs = 60_000 } = {}) {
    const spec = cleanSpec(data);
    try { buildRegex(spec); } catch (err) { throw new WorkbenchError('bad_request', err.message); }
    if (typeof data.replace !== 'string') throw new WorkbenchError('bad_request', 'replace must be text');
    const owner = `r${++this.seq}`;
    let { files } = this._files(root, spec);
    if (Array.isArray(data.paths) && data.paths.length) {
      const only = new Set(data.paths.map(String));
      files = files.filter((f) => only.has(f.rel));
    }
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; this.pool.cancel(owner); }, timeoutMs);
    timer.unref?.();
    const entries = new Map();
    const parts = [];
    for (let i = 0; i < files.length; i += CHUNK) {
      const chunk = files.slice(i, i + CHUNK).map((f) => ({ rel: f.rel, abs: f.abs }));
      parts.push(this.pool.run(owner, { type: 'replace', files: chunk, spec, replacement: data.replace }).then((msg) => {
        for (const r of msg.results) entries.set(r.path, r);
      }, (err) => { if (err.code !== 'cancelled') throw err; }));
    }
    try { await Promise.all(parts); } finally { clearTimeout(timer); }
    if (timedOut) throw new WorkbenchError('timeout', 'the replace preview took too long and was stopped');
    for (const [k, v] of this.previews) if (v.expires < Date.now()) this.previews.delete(k);
    this.previews.set(owner, { rootId: root.id, entries, expires: Date.now() + 10 * 60_000, spec, replace: data.replace });
    const list = [...entries.values()].sort((a, b) => a.path.localeCompare(b.path)).map((e) => ({ path: e.path, count: e.count, changes: e.changes }));
    return { previewId: owner, files: list, total: list.reduce((n, f) => n + f.count, 0), timedOut };
  }

  /** The stored preview (for apply). Throws when it expired. */
  takePreview(previewId) {
    const p = this.previews.get(String(previewId || ''));
    if (!p || p.expires < Date.now()) throw new WorkbenchError('not_found', 'that replace preview expired; preview it again');
    this.previews.delete(String(previewId));
    return p;
  }

  close() {
    return this.pool.close();
  }
}
