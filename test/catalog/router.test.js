// Automatic rotation: the router's choice for ten hardware and task combinations, rotation on out of
// memory, error, timeout and invalid JSON, the eviction policy, pins and overrides. No model runs: the
// loader and the brains are fakes.
import { describe, it, expect } from 'vitest';
import { route, rotate, profileFor, contextFor, evictionPlan, PROFILES } from '../../src/brain/catalog/router.js';
import { ModelPool, createAutoBrain, RouterSettings } from '../../src/brain/rotation.js';
import { EventBus } from '../../src/bus.js';
import { tmpDir } from '../helpers.js';

const GB = 1e9;
const HW = {
  gtx1060: { gpu: { name: 'NVIDIA GeForce GTX 1060 6GB', vramBytes: 6442450944, backend: 'cuda' }, ramBytes: 16 * GB, cpu: { model: 'Intel(R) Core(TM) i5-4440', cores: 4, threads: 4, avx2: true, ramMts: 1600, ramModules: 2 } },
  rtx3090: { gpu: { name: 'NVIDIA GeForce RTX 3090', vramBytes: 25.7 * GB, backend: 'cuda' }, ramBytes: 64 * GB, cpu: { cores: 12, threads: 24, avx2: true } },
  cpu16: { gpu: null, ramBytes: 16 * GB, cpu: { cores: 6, threads: 12, avx2: true, ramMts: 3200, ramModules: 2 } },
  m2_16: { gpu: { name: 'Apple M2 GPU', chip: 'Apple M2', vramBytes: 10.5 * GB, backend: 'metal', unified: true }, ramBytes: 16 * GB, cpu: { cores: 8, threads: 8 } }
};
const SMALL_SET = ['qwen2.5-coder-3b:Q4_K_M', 'qwen2.5-coder-7b:IQ4_XS', 'qwen2.5-coder-1.5b:Q4_K_M'];
const BIG_SET = ['qwen2.5-coder-32b:Q4_K_M', 'qwen3-32b:Q4_K_M', 'qwen2.5-coder-3b:Q4_K_M', 'qwen2.5-7b:Q4_K_M', 'deepseek-r1-distill-qwen-14b:Q4_K_M'];
const r = (hw, profile, installed, extra = {}) => route({ profile, ctx: 4096, hw: HW[hw], installed, ...extra });

describe('the router: ten hardware and task combinations', () => {
  it('1. GTX 1060, Dev writing code: the 7B on the GPU (best for code, fits)', () => {
    const d = r('gtx1060', 'code', SMALL_SET);
    expect(d.choice).toMatchObject({ id: 'qwen2.5-coder-7b:IQ4_XS', where: 'gpu' });
    expect(d.why[0]).toMatchObject({ k: 'best', task: 'coding' });
    expect(d.reason).toMatch(/best for code and fits on the GPU/);
  });

  it('2. GTX 1060, QA reviewing with nothing loaded: the fast 3B', () => {
    expect(r('gtx1060', 'review', SMALL_SET).choice.id).toBe('qwen2.5-coder-3b:Q4_K_M');
  });

  it('3. GTX 1060, QA reviewing while the 7B is loaded and a swap would unload it: stays on the 7B', () => {
    const d = r('gtx1060', 'review', SMALL_SET, { resident: ['qwen2.5-coder-7b:IQ4_XS'], needsEvict: ['qwen2.5-coder-3b:Q4_K_M', 'qwen2.5-coder-1.5b:Q4_K_M'] });
    expect(d.choice.id).toBe('qwen2.5-coder-7b:IQ4_XS');
    expect(d.why.some((w) => w.k === 'loaded')).toBe(true);
  });

  it('4. RTX 3090, Mel planning: the strongest reasoning model that fits', () => {
    const d = r('rtx3090', 'plan', BIG_SET);
    expect(d.choice.id).toBe('qwen3-32b:Q4_K_M');
    expect(d.choice.where).toBe('gpu');
  });

  it('5. RTX 3090, Dev coding: the 32B coder', () => {
    expect(r('rtx3090', 'code', BIG_SET).choice.id).toBe('qwen2.5-coder-32b:Q4_K_M');
  });

  it('6. RTX 3090, chat: a fast general model, not the 32B', () => {
    const d = r('rtx3090', 'chat', BIG_SET);
    expect(d.choice.id).not.toMatch(/32b/);
    expect(PROFILES.chat.speed).toBe('fast');
  });

  it('7. CPU only with 16 GB: a model that runs on the CPU at a usable speed, the 32B never', () => {
    const d = r('cpu16', 'code', [...SMALL_SET, 'qwen2.5-coder-32b:Q4_K_M']);
    expect(d.choice.where).toBe('cpu');
    expect(d.candidates.find((c) => c.id === 'qwen2.5-coder-32b:Q4_K_M').skip).toBe('does not fit this PC');
  });

  it('8. Apple M2 16 GB, Writer: the unified memory GPU', () => {
    const d = r('m2_16', 'write', [...SMALL_SET, 'qwen2.5-7b:Q4_K_M']);
    expect(d.choice.where).toBe('gpu');
    expect(d.choice.id).toBe('qwen2.5-7b:Q4_K_M');
  });

  it('9. GTX 1060, a turn that needs a long context: a model that still fits, never one with too short a context', () => {
    const d = route({ profile: 'code', ctx: 16384, hw: HW.gtx1060, installed: [...SMALL_SET, 'gemma-2-9b:Q4_K_M'] });
    expect(d.candidates.find((c) => c.id === 'gemma-2-9b:Q4_K_M').skip).toBe('context too long');
    expect(d.choice).toBeTruthy();
    expect(d.choice.need).toBeGreaterThan(route({ profile: 'code', ctx: 4096, hw: HW.gtx1060, installed: [d.choice.id] }).choice.need);
  });

  it('10. GTX 1060 with a friend that can run the 32B: the router offers it and leaves the machine to the scheduler', () => {
    const d = r('gtx1060', 'plan', [...SMALL_SET], { peers: { 'qwen2.5-coder-32b:Q4_K_M': [{ peerId: 'p_rita', name: 'Rita', tps: 10 }] } });
    expect(d.choice).toMatchObject({ id: 'qwen2.5-coder-32b:Q4_K_M', where: 'peer' });
    expect(d.choice.peers[0].name).toBe('Rita');
    expect(d.reason).toMatch(/friend's machine/);
  });

  it('memory free right now counts: a model that is not loaded must fit next to what is', () => {
    const d = r('gtx1060', 'code', SMALL_SET, { freeVram: 3.5 * GB });
    expect(d.candidates.find((c) => c.id === 'qwen2.5-coder-7b:IQ4_XS').skip).toBe('not enough free VRAM now');
    expect(d.choice.id).toBe('qwen2.5-coder-3b:Q4_K_M');
  });
});

describe('pins, overrides and roles', () => {
  it('a pin wins for its role, an override wins for its task, both only while they can run', () => {
    expect(r('gtx1060', 'code', SMALL_SET, { pin: 'qwen2.5-coder-1.5b:Q4_K_M' }).choice).toMatchObject({ id: 'qwen2.5-coder-1.5b:Q4_K_M', pinned: true });
    const both = r('gtx1060', 'code', SMALL_SET, { pin: 'qwen2.5-coder-1.5b:Q4_K_M', override: 'qwen2.5-coder-3b:Q4_K_M' });
    expect(both.choice.id).toBe('qwen2.5-coder-3b:Q4_K_M');
    expect(both.why[0].k).toBe('override');
    const failed = r('gtx1060', 'code', SMALL_SET, { pin: 'qwen2.5-coder-1.5b:Q4_K_M', failures: { 'qwen2.5-coder-1.5b:Q4_K_M': { until: Date.now() + 60000, why: 'oom' } } });
    expect(failed.choice.id).toBe('qwen2.5-coder-7b:IQ4_XS');
  });

  it('maps roles to profiles, and a turn outside a job is chat', () => {
    expect(profileFor({ id: 'mel' }, { jobId: 'j' })).toBe('plan');
    expect(profileFor({ id: 'dev' }, { taskId: 't' })).toBe('code');
    expect(profileFor({ id: 'qa' }, { taskId: 't' })).toBe('review');
    expect(profileFor({ id: 'writer' }, { taskId: 't' })).toBe('write');
    expect(profileFor({ id: 'dev' }, {})).toBe('chat');
    expect(profileFor({ id: 'w_x', role: 'Software architect' }, { taskId: 't' })).toBe('plan');
    expect(profileFor({ id: 'w_y', role: 'Test engineer' }, { taskId: 't' })).toBe('review');
    expect(contextFor([{ content: 'x'.repeat(35000) }], 2000)).toBe(16384);
    expect(contextFor([], 500)).toBe(2048);
  });

  it('keeps pins and overrides in router.json, automatic on by default', () => {
    const home = tmpDir();
    const s = new RouterSettings(home);
    expect(s.data).toMatchObject({ auto: true, maxResident: 2 });
    s.set({ pins: { qa: 'qwen2.5-coder-3b' }, overrides: { t_1: 'qwen2.5-coder-7b:iq4_xs' }, maxResident: 9 });
    const again = new RouterSettings(home);
    expect(again.data.pins.qa).toBe('qwen2.5-coder-3b:Q4_K_M');
    expect(again.data.overrides.t_1).toBe('qwen2.5-coder-7b:IQ4_XS');
    expect(again.data.maxResident).toBe(2);
    again.set({ pins: { qa: null }, auto: false });
    expect(new RouterSettings(home).data).toMatchObject({ auto: false, pins: {} });
  });
});

describe('the eviction policy', () => {
  const budget = { vram: 5.7 * GB, ram: 12 * GB };
  it('unloads the least recently used model, then the least used, never one that is busy', () => {
    const resident = [
      { id: 'a', need: 2.5 * GB, where: 'gpu', lastUsed: 5, uses: 9 },
      { id: 'b', need: 2.5 * GB, where: 'gpu', lastUsed: 2, uses: 1 }
    ];
    expect(evictionPlan(resident, { need: 3 * GB, where: 'gpu', budget, maxResident: 3 })).toEqual({ evict: ['b'], fits: true });
    expect(evictionPlan([{ ...resident[0] }, { ...resident[1], busy: true }], { need: 3 * GB, where: 'gpu', budget, maxResident: 3 })).toEqual({ evict: ['a'], fits: true });
    expect(evictionPlan(resident, { need: 0.5 * GB, where: 'gpu', budget, maxResident: 3 })).toEqual({ evict: [], fits: true });
  });

  it('keeps at most N models, and a CPU model does not unload GPU models for memory', () => {
    const resident = [{ id: 'g', need: 4 * GB, where: 'gpu', lastUsed: 1, uses: 1 }, { id: 'c', need: 3 * GB, where: 'cpu', lastUsed: 2, uses: 1 }];
    expect(evictionPlan(resident, { need: 2 * GB, where: 'cpu', budget, maxResident: 3 })).toEqual({ evict: [], fits: true });
    expect(evictionPlan(resident, { need: 2 * GB, where: 'cpu', budget, maxResident: 2 })).toEqual({ evict: ['g'], fits: true });
    expect(evictionPlan(resident, { need: 20 * GB, where: 'gpu', budget, maxResident: 4 }).fits).toBe(false);
  });
});

// ---------------------------------------------------------------- the automatic brain, with fakes

function rig(opts = {}) {
  const bus = new EventBus();
  const loads = [];
  const closed = [];
  const behaviour = opts.behaviour || {};
  const settings = new RouterSettings(null);
  if (opts.settings) settings.set(opts.settings);
  const pool = new ModelPool({
    hw: HW.gtx1060, bus, maxResident: () => settings.data.maxResident,
    load: async (p, o) => {
      loads.push([p.id, o.gpu]);
      if (behaviour[p.id] === 'oom') throw Object.assign(new Error('Not enough free RAM to load the model'), { code: 'no_memory' });
      let calls = 0;
      return {
        info: () => ({ model: p.name }),
        close: async () => { closed.push(p.id); },
        chat: async (messages, options) => {
          calls++;
          const b = behaviour[p.id];
          if (b === 'error') throw new Error('the model crashed');
          if (b === 'hang') return new Promise((resolve, reject) => options.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
          if (b === 'badjson') throw Object.assign(new Error('the model answer did not match the schema'), { code: 'invalid_json' });
          return { text: `${p.id} answered`, promptTokens: 1, completionTokens: 1, ms: 1, calls };
        }
      };
    }
  });
  const crew = { mel: { id: 'mel', name: 'Mel' }, dev: { id: 'dev', name: 'Dev' }, qa: { id: 'qa', name: 'QA' } };
  const brain = createAutoBrain({
    pool, settings, bus, hw: HW.gtx1060,
    installed: () => opts.installed || SMALL_SET,
    fallback: () => 'qwen2.5-coder-3b:Q4_K_M',
    worker: (id) => crew[id],
    freeRam: () => 12 * GB,
    timeoutMs: () => opts.timeoutMs || 5000
  });
  return { bus, brain, pool, loads, closed, settings };
}
const ask = (brain, workerId, extra = {}) => brain.chat([{ role: 'user', content: 'hi' }], { maxTokens: 200, turn: { turnId: `t_${Math.random()}`, workerId, taskId: 'task_1', jobId: 'job_1' }, ...extra });

describe('the automatic brain', () => {
  it('routes per role, says which model answered and why, and loads it once', async () => {
    const t = rig();
    const a = await ask(t.brain, 'dev');
    expect(a.text).toBe('qwen2.5-coder-7b:IQ4_XS answered');
    expect(a.route.reason).toMatch(/^Dev used .*7B.*best for code and fits on the GPU/);
    const routed = t.bus.events.filter((e) => e.type === 'model.routed');
    expect(routed[0].data).toMatchObject({ workerId: 'dev', profile: 'code', id: 'qwen2.5-coder-7b:IQ4_XS', where: 'gpu' });
    await ask(t.brain, 'dev');
    expect(t.loads).toEqual([['qwen2.5-coder-7b:IQ4_XS', true]]);
  });

  it('rotates to the next model when a load runs out of memory, and logs why', async () => {
    const t = rig({ behaviour: { 'qwen2.5-coder-7b:IQ4_XS': 'oom' } });
    const a = await ask(t.brain, 'dev');
    expect(a.text).not.toMatch(/7b/);
    const rot = t.bus.events.find((e) => e.type === 'model.rotated');
    expect(rot.data).toMatchObject({ from: 'qwen2.5-coder-7b:IQ4_XS', cause: 'oom' });
    expect(t.brain.failures['qwen2.5-coder-7b:IQ4_XS'].why).toBe('oom');
    // In the cool down the failed model is not tried again.
    await ask(t.brain, 'dev');
    expect(t.loads.filter(([id]) => id === 'qwen2.5-coder-7b:IQ4_XS')).toHaveLength(1);
  });

  it('rotates on an error and on a timeout', async () => {
    const e = rig({ behaviour: { 'qwen2.5-coder-7b:IQ4_XS': 'error' } });
    expect((await ask(e.brain, 'dev')).text).toBe('qwen2.5-coder-3b:Q4_K_M answered');
    expect(e.bus.events.find((x) => x.type === 'model.rotated').data.cause).toBe('error');
    const h = rig({ behaviour: { 'qwen2.5-coder-7b:IQ4_XS': 'hang' }, timeoutMs: 50 });
    expect((await ask(h.brain, 'dev')).text).toBe('qwen2.5-coder-3b:Q4_K_M answered');
    expect(h.bus.events.find((x) => x.type === 'model.rotated').data.cause).toBe('timeout');
  });

  it('rotates after invalid JSON twice, not once', async () => {
    const t = rig({ behaviour: { 'qwen2.5-coder-7b:IQ4_XS': 'badjson' } });
    await expect(ask(t.brain, 'dev')).rejects.toMatchObject({ code: 'invalid_json' });
    expect(t.bus.events.some((x) => x.type === 'model.rotated')).toBe(false);
    const second = await ask(t.brain, 'dev');
    expect(second.text).toBe('qwen2.5-coder-3b:Q4_K_M answered');
    expect(t.bus.events.find((x) => x.type === 'model.rotated').data.cause).toBe('invalid_json');
  });

  it('a cancelled turn is not a failure', async () => {
    const t = rig({ behaviour: { 'qwen2.5-coder-7b:IQ4_XS': 'hang' } });
    const ctrl = new AbortController();
    const p = ask(t.brain, 'dev', { signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 20);
    await expect(p).rejects.toThrow();
    expect(t.bus.events.some((x) => x.type === 'model.rotated')).toBe(false);
  });

  it('keeps models within the budget: on a 6 GB card the 3B unloads the 7B', async () => {
    const t = rig({ settings: { pins: { qa: 'qwen2.5-coder-3b:Q4_K_M' } } });
    await ask(t.brain, 'dev');
    await ask(t.brain, 'qa');
    expect(t.closed).toEqual(['qwen2.5-coder-7b:IQ4_XS']);
    expect([...t.pool.resident.keys()]).toEqual(['qwen2.5-coder-3b:Q4_K_M']);
    expect(t.bus.events.find((x) => x.type === 'model.loaded' && x.data.id === 'qwen2.5-coder-3b:Q4_K_M').data.evicted).toEqual(['qwen2.5-coder-7b:IQ4_XS']);
  });

  it('keeps several small models loaded when they fit, and warms one only when there is room', async () => {
    const t = rig({ installed: ['qwen2.5-coder-1.5b:Q4_K_M', 'qwen2.5-coder-0.5b:Q4_K_M'], settings: { pins: { qa: 'qwen2.5-coder-0.5b:Q4_K_M' } } });
    await ask(t.brain, 'dev');
    await ask(t.brain, 'qa');
    expect(t.closed).toEqual([]);
    expect(t.pool.resident.size).toBe(2);
    const p = (await import('../../src/brain/catalog/index.js')).pick('qwen2.5-coder-3b', 'Q4_K_M');
    expect(t.pool.warm(p, { ctx: 4096, where: 'gpu' })).toBe(false); // would need an unload (at most 2 loaded)
  });

  it('with automatic off every role uses the chosen model', async () => {
    const t = rig({ settings: { auto: false } });
    await ask(t.brain, 'dev');
    expect(t.loads).toEqual([['qwen2.5-coder-3b:Q4_K_M', true]]);
    expect(t.bus.events.find((x) => x.type === 'model.routed').data.why[0].k).toBe('pinned');
  });

  it('a pinned role and a task override are respected by the brain', async () => {
    const t = rig({ settings: { pins: { dev: 'qwen2.5-coder-1.5b:Q4_K_M' }, overrides: { task_9: 'qwen2.5-coder-3b:Q4_K_M' } } });
    expect((await ask(t.brain, 'dev')).text).toBe('qwen2.5-coder-1.5b:Q4_K_M answered');
    const o = await t.brain.chat([{ role: 'user', content: 'x' }], { turn: { workerId: 'dev', taskId: 'task_9', jobId: 'j' } });
    expect(o.text).toBe('qwen2.5-coder-3b:Q4_K_M answered');
  });

  it('rotate() excludes the failed model', () => {
    const input = { profile: 'code', ctx: 4096, hw: HW.gtx1060, installed: SMALL_SET };
    expect(rotate(input, 'qwen2.5-coder-7b:IQ4_XS').choice.id).not.toBe('qwen2.5-coder-7b:IQ4_XS');
  });
});
