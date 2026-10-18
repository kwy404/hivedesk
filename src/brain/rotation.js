// Automatic model rotation: one brain for the scheduler ("Local: automatic") that, for every turn, asks
// the router which installed model fits the role and the task, keeps a few models loaded within the VRAM
// and RAM budget, switches to the next candidate when a model fails, and says which model answered and
// why. The scheduler still decides the machine; this brain is this machine's slot.
//
// Events:  model.routed  { turnId, workerId, profile, id, model, where, reason, why }
//          model.rotated { turnId, workerId, from, to, cause }        cause: load, oom, error, timeout, invalid_json
//          model.loaded  { id, model, where, ms, evicted }
//          model.unloaded { id, model, reason }
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolvePick } from './catalog/index.js';
import { route, profileFor, contextFor, evictionPlan, normalizePin, PROFILES } from './catalog/router.js';
import { budgets, placement } from './catalog/recommend.js';

export const ROUTER_DEFAULTS = Object.freeze({ auto: true, maxResident: 2, pins: {}, overrides: {} });
const COOLDOWN_MS = 10 * 60_000;

/** The router settings in <home>/models/router.json: automatic on by default, pins per role, overrides per task. */
export class RouterSettings {
  constructor(home) {
    this.file = home ? path.join(home, 'models', 'router.json') : null;
    let d = {};
    try { d = this.file ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : {}; } catch { d = {}; }
    this.data = RouterSettings.clean(d);
  }

  static clean(d = {}) {
    const pins = {};
    for (const [role, id] of Object.entries(d.pins || {})) { const n = normalizePin(id); if (n && /^[\w.-]{1,40}$/.test(role)) pins[role] = n; }
    const overrides = {};
    for (const [task, id] of Object.entries(d.overrides || {})) { const n = normalizePin(id); if (n && /^[\w.:-]{1,80}$/.test(task)) overrides[task] = n; }
    const max = Number(d.maxResident);
    return { auto: d.auto !== false, maxResident: Number.isInteger(max) && max >= 1 && max <= 4 ? max : ROUTER_DEFAULTS.maxResident, pins, overrides };
  }

  set(patch = {}) {
    const next = { ...this.data, ...patch };
    if (patch.pins) next.pins = { ...this.data.pins, ...patch.pins };
    if (patch.overrides) next.overrides = { ...this.data.overrides, ...patch.overrides };
    // null removes a pin or an override
    for (const k of Object.keys(patch.pins || {})) if (patch.pins[k] == null) delete next.pins[k];
    for (const k of Object.keys(patch.overrides || {})) if (patch.overrides[k] == null) delete next.overrides[k];
    this.data = RouterSettings.clean(next);
    if (this.file) {
      try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(this.data, null, 1)); } catch { /* read only: this run only */ }
    }
    return this.data;
  }
}

/**
 * The loaded models. `load(pick, { gpu, ctx })` returns a brain with chat() and close().
 */
export class ModelPool {
  /**
   * @param {{ load: (p: any, o: { gpu: boolean, ctx: number }) => Promise<any>, hw: any, maxResident?: () => number,
   *   bus?: any, log?: (s: string) => void, now?: () => number }} opts
   */
  constructor(opts) {
    this.load = opts.load;
    this.hw = opts.hw;
    this.maxResident = opts.maxResident || (() => ROUTER_DEFAULTS.maxResident);
    this.bus = opts.bus;
    this.log = opts.log || (() => {});
    this.now = opts.now || Date.now;
    /** @type {Map<string, { id: string, pick: any, brain: any, need: number, where: string, ctx: number, lastUsed: number, uses: number, busy: boolean }>} */
    this.resident = new Map();
    this.loading = null;
    this.tick = 0;
  }

  budget() {
    const b = budgets(this.hw);
    return { vram: b.vram, ram: b.unified ? Math.max(0, (this.hw.ramBytes || 0) - 4e9) : b.cpuRam };
  }

  list() {
    return [...this.resident.values()].map(({ brain, pick, ...r }) => ({ ...r, model: pick.name }));
  }

  /** Puts an already loaded brain in the pool (the model the manager loaded at start). */
  adopt(pick, brain, { where, ctx }) {
    this.resident.set(pick.id, { id: pick.id, pick, brain, need: this._need(pick, ctx), where, ctx, lastUsed: ++this.tick, uses: 0, busy: false });
  }

  _need(pick, ctx) {
    const pl = placement(this.hw, pick, ctx);
    return pl.need;
  }

  /** Would loading this pick unload another model? */
  needsEvict(pick, ctx, where) {
    if (this.resident.has(pick.id)) return false;
    const plan = evictionPlan([...this.resident.values()], { need: this._need(pick, ctx), where, budget: this.budget(), maxResident: this.maxResident() });
    return plan.evict.length > 0;
  }

  async _unload(id, reason) {
    const r = this.resident.get(id);
    if (!r) return;
    this.resident.delete(id);
    try { await r.brain.close?.(); } catch { /* ignore */ }
    this.bus?.emit('model.unloaded', { id, model: r.pick.name, reason });
    this.log(`unloaded ${r.pick.name} (${reason})`);
  }

  /** The brain for this pick, loaded now if needed, unloading the least used models to make room. */
  async ensure(pick, { ctx, where }) {
    const have = this.resident.get(pick.id);
    if (have && have.ctx >= ctx) { have.lastUsed = ++this.tick; return have; }
    while (this.loading) await this.loading.catch(() => {});
    const again = this.resident.get(pick.id);
    if (again && again.ctx >= ctx) { again.lastUsed = ++this.tick; return again; }
    if (again) await this._unload(pick.id, 'a longer context is needed');
    const need = this._need(pick, ctx);
    const plan = evictionPlan([...this.resident.values()], { need, where, budget: this.budget(), maxResident: this.maxResident() });
    for (const id of plan.evict) await this._unload(id, 'room for another model');
    const started = this.now();
    this.loading = (async () => {
      const brain = await this.load(pick, { gpu: where === 'gpu' || where === 'partial', ctx });
      const r = { id: pick.id, pick, brain, need, where, ctx, lastUsed: ++this.tick, uses: 0, busy: false };
      this.resident.set(pick.id, r);
      this.bus?.emit('model.loaded', { id: pick.id, model: pick.name, where, ms: this.now() - started, evicted: plan.evict });
      return r;
    })();
    try { return await this.loading; } finally { this.loading = null; }
  }

  /** Loads a model in the background only when it fits without unloading anything and nothing is loading. */
  warm(pick, { ctx, where }) {
    if (this.loading || this.resident.has(pick.id)) return false;
    const plan = evictionPlan([...this.resident.values()], { need: this._need(pick, ctx), where, budget: this.budget(), maxResident: this.maxResident() });
    if (plan.evict.length || !plan.fits) return false;
    this.ensure(pick, { ctx, where }).catch((err) => this.log(`warming ${pick.name} failed: ${err.message}`));
    return true;
  }

  async close() {
    for (const id of [...this.resident.keys()]) await this._unload(id, 'shutdown');
  }
}

/**
 * The scheduler's brain for automatic rotation.
 * @param {{
 *   pool: ModelPool, settings: RouterSettings, bus: any, hw: any,
 *   installed: () => string[],                       pick ids in the cache
 *   fallback: () => string | null,                   the model chosen in Settings (used when automatic is off)
 *   worker: (id: string) => any,                     the crew member (role) behind a turn
 *   peek?: () => any,                                the next queued turn ({ workerId, taskId, jobId }), for warming
 *   peers?: () => Record<string, any[]>,             pick id -> friends that can run it (from the scheduler); not used yet
 *   freeRam?: () => number, freeVram?: () => number | null,
 *   timeoutMs?: (choice: any, options: any) => number,
 *   now?: () => number, log?: (s: string) => void, defaultCtx?: number
 * }} o
 */
export function createAutoBrain(o) {
  const failures = {};
  const invalid = {};
  const now = o.now || Date.now;
  const log = o.log || (() => {});
  const freeRam = o.freeRam || (() => os.freemem());
  let current = null;

  function decide(turn, messages, options, exclude = []) {
    const s = o.settings.data;
    const worker = o.worker(turn.workerId) || { id: turn.workerId };
    const profile = profileFor(worker, turn);
    const ctx = Math.max(o.defaultCtx || 4096, contextFor(messages, options.maxTokens));
    const installed = o.installed();
    const resident = [...o.pool.resident.keys()];
    const fixed = s.auto ? null : o.fallback();
    const needsEvict = installed.filter((id) => { const p = resolvePick(id); if (!p) return false; const pl = placement(o.hw, p, ctx); return o.pool.needsEvict(p, ctx, pl.where); });
    const input = {
      profile, ctx, hw: o.hw, installed, resident, needsEvict, failures, exclude,
      freeRam: freeRam() + o.pool.list().filter((r) => r.where === 'cpu').reduce((n, r) => n + r.need, 0),
      freeVram: null,
      pin: fixed || s.pins[worker.id] || s.pins[profile] || null,
      override: (turn.taskId && s.overrides[turn.taskId]) || null,
      peers: s.auto && o.peers ? o.peers() : {},
      worker: worker.name || worker.id || 'The crew', now: now()
    };
    return { input, decision: route(input), profile, ctx, worker };
  }

  const brain = {
    id: 'local',
    kind: 'local',
    get label() { return `Local: ${o.settings.data.auto ? 'automatic' : 'fixed'}${current ? ` (${current.pick.name})` : ''}`; },
    info() {
      // Before the first turn, the model the manager loaded at start (adopted into the pool) is the one serving:
      // the compute plane reads its device and its catalog id to share it (src/compute/index.js localServing).
      const slot = current || [...o.pool.resident.values()].sort((a, b) => b.lastUsed - a.lastUsed)[0] || null;
      const i = slot?.brain?.info?.() || {};
      return { ...i, backend: 'local', model: slot ? slot.pick.name : i.model, ...(slot ? { modelId: slot.pick.id } : {}), auto: o.settings.data.auto, resident: o.pool.list() };
    },
    async chat(messages, options = {}) {
      const turn = options.turn || {};
      const tried = [];
      let lastErr = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        const { decision, profile, ctx, worker } = decide(turn, messages, options, tried);
        const c = decision.choice;
        if (!c) break;
        if (c.where === 'peer') { tried.push(c.id); continue; } // the scheduler runs friends' models, not this slot
        const pick = resolvePick(c.id);
        o.bus.emit('model.routed', { turnId: turn.turnId, workerId: turn.workerId, taskId: turn.taskId, profile, id: c.id, model: c.name, short: c.short, where: c.where, reason: decision.reason, why: decision.why, rotated: tried.length > 0 });
        let slot;
        try {
          slot = await o.pool.ensure(pick, { ctx, where: c.where });
        } catch (err) {
          const cause = err.code === 'no_memory' || /memory|VRAM|too large|layers fit/i.test(String(err.message)) ? 'oom' : 'load';
          lastErr = err;
          fail(c, cause, err, turn, tried);
          continue;
        }
        current = slot;
        slot.busy = true;
        slot.uses++;
        const inner = new AbortController();
        const onAbort = () => inner.abort();
        options.signal?.addEventListener('abort', onAbort, { once: true });
        let timedOut = false;
        const limit = o.timeoutMs ? o.timeoutMs(c, options) : 60_000 + ((options.maxTokens || 1024) / Math.max(c.tps || 2, 2)) * 3000;
        const timer = setTimeout(() => { timedOut = true; inner.abort(); }, limit);
        timer.unref?.();
        try {
          const { turn: _t, ...rest } = options;
          const result = await slot.brain.chat(messages, { ...rest, signal: inner.signal });
          if (timedOut) throw Object.assign(new Error('the model took too long'), { code: 'timeout' });
          invalid[c.id] = 0;
          result.model = c.name;
          result.route = { id: c.id, reason: decision.reason, profile };
          setTimeout(() => warmNext(), 0).unref?.();
          return result;
        } catch (err) {
          if (options.signal?.aborted) throw err;
          lastErr = err;
          if (timedOut || err.code === 'timeout') { fail(c, 'timeout', err, turn, tried); continue; }
          if (err.code === 'invalid_json') {
            invalid[c.id] = (invalid[c.id] || 0) + 1;
            if (invalid[c.id] < 2) throw err; // the worker retries; a second invalid answer rotates
            invalid[c.id] = 0;
            fail(c, 'invalid_json', err, turn, tried);
            continue;
          }
          fail(c, /memory|VRAM|out of memory/i.test(String(err.message)) ? 'oom' : 'error', err, turn, tried);
          continue;
        } finally {
          clearTimeout(timer);
          options.signal?.removeEventListener('abort', onAbort);
          slot.busy = false;
        }
        void worker;
      }
      throw lastErr || Object.assign(new Error('no installed model can run this turn'), { code: 'no_model' });
    },
    async close() { await o.pool.close(); }
  };

  function fail(c, cause, err, turn, tried) {
    tried.push(c.id);
    failures[c.id] = { count: (failures[c.id]?.count || 0) + 1, until: now() + COOLDOWN_MS, why: cause };
    const msg = String(err?.message || err).slice(0, 200);
    log(`${c.name} failed (${cause}: ${msg}); rotating to the next model`);
    o.bus.emit('model.rotated', { turnId: turn.turnId, workerId: turn.workerId, from: c.id, cause, message: msg });
    if (cause === 'oom' || cause === 'load') o.pool._unload(c.id, `failed: ${cause}`).catch(() => {});
  }

  function warmNext() {
    const next = o.peek?.();
    if (!next) return;
    try {
      const { decision, ctx } = decide({ ...next, kind: next.jobId || next.taskId ? 'job' : undefined }, [], { maxTokens: 1024 });
      const c = decision.choice;
      if (c && c.where !== 'peer' && !o.pool.resident.has(c.id)) {
        if (o.pool.warm(resolvePick(c.id), { ctx, where: c.where })) log(`warming ${c.name} for ${next.workerId}`);
      }
    } catch { /* warming is best effort */ }
  }

  brain.failures = failures;
  brain.decide = (turn, messages = [], options = {}) => decide(turn, messages, options).decision;
  return brain;
}

export { PROFILES };
