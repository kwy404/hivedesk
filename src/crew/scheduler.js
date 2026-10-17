// Fair turn scheduler: one queue of model turns, a pool of brains, one turn per brain at a time.
// Workers are served round robin (the worker served longest ago goes first), oldest turn first inside a worker.

let turnSeq = 0;

export class Scheduler {
  /** @param {import('../bus.js').EventBus} bus */
  constructor(bus, opts = {}) {
    this.bus = bus;
    /** @type {Map<string, { brain: any, busy: boolean, current: any }>} */
    this.brains = new Map();
    /** @type {any[]} */
    this.waiting = [];
    /** @type {Map<string, number>} last time each worker was served (a counter, not a clock) */
    this.lastServed = new Map();
    this.tick = 0;
    /** @type {Set<string>} */
    this.paused = new Set();
    /** @type {Map<string, any>} the last prompts and answers, for the "show prompt" debug view */
    this.prompts = new Map();
    /** @type {Map<string, string>} workerId -> preferred brainId */
    this.prefs = new Map();
    this.maxRetries = opts.maxRetries ?? 1;
    this.turnTimeoutMs = opts.turnTimeoutMs ?? 10 * 60_000;
    this._lastQueueJson = '';
  }

  /** @param {import('../brain/types.js').Brain} brain */
  addBrain(brain) {
    if (this.brains.has(brain.id)) this.removeBrain(brain.id, 'replaced');
    this.brains.set(brain.id, { brain, busy: false, current: null });
    const info = brain.info?.() || {};
    this.bus.emit('brain.attached', { brainId: brain.id, label: brain.label, kind: brain.kind, model: info.model });
    this._pump();
  }

  removeBrain(brainId, reason = 'removed') {
    const slot = this.brains.get(brainId);
    if (!slot) return false;
    this.brains.delete(brainId);
    if (slot.current) {
      slot.current.ctrl.abort();
      slot.current.requeue = true;
    }
    this.bus.emit('brain.detached', { brainId, reason });
    try { slot.brain.close?.(); } catch { /* ignore */ }
    this._pump();
    return true;
  }

  get hasBrain() {
    return this.brains.size > 0;
  }

  /**
   * Queues one model turn and resolves with the brain's ChatResult.
   * @param {{ workerId: string, taskId?: string, jobId?: string, messages: any[], options?: any, signal?: AbortSignal, budget?: any }} req
   */
  turn(req) {
    return new Promise((resolve, reject) => {
      const item = { ...req, options: req.options || {}, resolve, reject, enq: ++this.tick, attempts: 0, turnId: `turn_${++turnSeq}` };
      if (req.signal?.aborted) return reject(new Error('cancelled'));
      req.signal?.addEventListener('abort', () => {
        const i = this.waiting.indexOf(item);
        if (i !== -1) {
          this.waiting.splice(i, 1);
          this._status(item.workerId, 'idle', item);
          this._emitQueue();
          reject(new Error('cancelled'));
        }
      }, { once: true });
      this.waiting.push(item);
      this._status(item.workerId, 'queued', item);
      this._emitQueue();
      this._pump();
    });
  }

  /** Picks the next turn: the worker served longest ago, then the oldest turn. */
  _remember(item, brainId) {
    this.prompts.set(item.turnId, {
      turnId: item.turnId, workerId: item.workerId, taskId: item.taskId, jobId: item.jobId, brainId,
      messages: item.messages.map((m) => ({ role: m.role, content: String(m.content).slice(0, 40000) })),
      budget: item.budget || null, response: null, ts: new Date().toISOString()
    });
    while (this.prompts.size > 40) this.prompts.delete(this.prompts.keys().next().value);
  }

  /** A paused worker keeps its place in the queue but gets no turns until it is resumed. */
  setPaused(workerId, paused) {
    if (paused) this.paused.add(workerId);
    else this.paused.delete(workerId);
    this._emitQueue();
    this._pump();
  }

  _next(brainId, brain) {
    if (!this.waiting.length) return null;
    let best = null;
    for (const item of this.waiting) {
      if (this.paused.has(item.workerId)) continue;
      if (brainId && !this._eligible(item, brainId, brain)) continue;
      if (!best) { best = item; continue; }
      const a = this.lastServed.get(item.workerId) ?? -1;
      const b = this.lastServed.get(best.workerId) ?? -1;
      if (a < b || (a === b && item.enq < best.enq)) best = item;
    }
    if (!best) return null;
    this.waiting.splice(this.waiting.indexOf(best), 1);
    return best;
  }

  _pump() {
    for (const [id, slot] of this.brains) {
      if (slot.busy) continue;
      const item = this._next(id, slot.brain);
      if (!item) continue;
      this._start(id, slot, item);
    }
  }

  /**
   * Per worker brain choice: turns of `workerId` go to `brainId` while that brain is attached.
   * `null` clears it (the worker uses whatever brain is free).
   */
  setPreference(workerId, brainId) {
    if (brainId) this.prefs.set(workerId, brainId);
    else this.prefs.delete(workerId);
    this._pump();
  }

  /** Can this brain take this turn? A brain with `only` serves just those workers; a preference wins. */
  _eligible(item, brainId, brain) {
    if (brain?.only && !brain.only.has(item.workerId)) return false;
    // A turn may limit the brains it runs on (a lent turn: this machine's own local models only).
    if (typeof item.accept === 'function' && !item.accept(brain, brainId)) return false;
    const pref = this.prefs.get(item.workerId);
    if (pref && pref !== brainId && this.brains.has(pref)) return false;
    return true;
  }

  async _start(brainId, slot, item) {
    slot.busy = true;
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    item.signal?.addEventListener('abort', onAbort, { once: true });
    const current = { item, ctrl, requeue: false };
    slot.current = current;
    this.lastServed.set(item.workerId, ++this.tick);
    item.attempts++;
    this._status(item.workerId, 'thinking', item);
    this.bus.emit('turn.started', { turnId: item.turnId, workerId: item.workerId, taskId: item.taskId, brainId, n: item.n ?? item.attempts, ...(item.budget ? { budget: item.budget } : {}) }, { jobId: item.jobId });
    this._remember(item, brainId);
    this._emitQueue();
    const timer = setTimeout(() => ctrl.abort(), this.turnTimeoutMs);
    timer.unref?.();
    const started = Date.now();
    try {
      const result = await slot.brain.chat(item.messages, {
        ...item.options,
        signal: ctrl.signal,
        onToken: (text) => {
          this.bus.live('turn.token', { turnId: item.turnId, workerId: item.workerId, text });
          item.options.onToken?.(text);
        }
      });
      const ms = result.ms || Date.now() - started;
      const tps = result.completionTokens && ms ? Math.round((result.completionTokens / (ms / 1000)) * 10) / 10 : 0;
      this.bus.emit('turn.ended', {
        turnId: item.turnId, workerId: item.workerId, taskId: item.taskId, brainId,
        promptTokens: result.promptTokens || 0, completionTokens: result.completionTokens || 0, ms, tps
      }, { jobId: item.jobId });
      this.bus.live('brain.stats', { brainId, tps, queue: this.waiting.length, loaded: true });
      const rec = this.prompts.get(item.turnId);
      if (rec) rec.response = String(result.text || '').slice(0, 20000);
      // A turn a friend's machine answered is marked, so its tool calls wait for the host.
      if (slot.brain.kind === 'remote' && result && typeof result === 'object') result.remote = { brainId, label: String(slot.brain.label || 'friend').slice(0, 80) };
      item.resolve(result);
    } catch (err) {
      const cancelled = item.signal?.aborted;
      this.bus.emit('turn.ended', {
        turnId: item.turnId, workerId: item.workerId, taskId: item.taskId, brainId,
        promptTokens: 0, completionTokens: 0, ms: Date.now() - started, tps: 0, error: String(err?.message || err)
      }, { jobId: item.jobId });
      const retry = current.requeue || (item.attempts <= this.maxRetries && this.brains.size > 0 && err?.code !== 'invalid_json');
      if (!cancelled && retry) {
        // Retry once (or move to another brain when this one went away), at the front of the line.
        item.enq = 0;
        this.waiting.unshift(item);
        this._status(item.workerId, 'queued', item);
      } else {
        item.reject(err instanceof Error ? err : new Error(String(err)));
      }
    } finally {
      clearTimeout(timer);
      item.signal?.removeEventListener('abort', onAbort);
      slot.busy = false;
      slot.current = null;
      this._emitQueue();
      this._pump();
    }
  }

  _status(workerId, status, item) {
    this.bus.emit('worker.status', { workerId, status, taskId: item?.taskId }, { jobId: item?.jobId });
  }

  queueState() {
    const running = [];
    for (const [brainId, slot] of this.brains) {
      if (slot.current) running.push({ workerId: slot.current.item.workerId, taskId: slot.current.item.taskId, brainId });
    }
    const waiting = [...this.waiting].sort((a, b) => {
      const x = this.lastServed.get(a.workerId) ?? -1;
      const y = this.lastServed.get(b.workerId) ?? -1;
      return x - y || a.enq - b.enq;
    }).map((i) => ({ workerId: i.workerId, taskId: i.taskId }));
    return { running, waiting };
  }

  _emitQueue() {
    const q = this.queueState();
    const json = JSON.stringify(q);
    if (json === this._lastQueueJson) return;
    this._lastQueueJson = json;
    this.bus.emit('queue.updated', q);
  }

  async close() {
    for (const id of [...this.brains.keys()]) this.removeBrain(id, 'shutdown');
    for (const item of this.waiting.splice(0)) item.reject(new Error('shutting down'));
  }
}
