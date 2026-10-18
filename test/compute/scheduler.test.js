import { describe, it, expect } from 'vitest';
import { decide, ResourceScheduler } from '../../src/compute/scheduler.js';
import { defaultShare, patchShare } from '../../src/compute/share.js';

const GiB = 1024 ** 3;
const NOW = 1_800_000_000_000;
const RITA = 'hd1' + 'r'.repeat(49);
const SAM = 'hd1' + 's'.repeat(49);

const prompt = (chars = 1600) => [{ role: 'user', content: 'x'.repeat(chars) }];
const job = (over = {}) => ({ input: { model: 'any-allowed', messages: prompt(), maxTokens: 1024 }, priority: 'normal', ...over });

function localRes({ free = 3.2 * GiB, total = 12 * GiB } = {}) {
  return {
    sampledAt: NOW,
    cpu: { model: 'Test CPU', cores: 6, threads: 12, avx2: true, loadPct: 10 },
    ram: { totalBytes: 32 * GiB, freeBytes: 20 * GiB },
    gpus: [{ index: 0, name: 'RTX 3060', vendor: 'nvidia', vramTotalBytes: total, vramFreeBytes: free, utilPct: 5, source: 'nvidia-smi' }]
  };
}

function sharing(change = {}) {
  return patchShare(defaultShare(12), { modelAllowlist: ['qwen2.5-coder-7b'], ...change, gpu: { enabled: true, remoteInference: true, ...change.gpu } }, { threads: 12 });
}

function advert(over = {}) {
  return {
    sampledAt: NOW - 1000, receivedAt: NOW - 1000,
    cpu: { model: 'Peer CPU', cores: 8, threads: 16, loadPct: 5 },
    ram: { totalBytes: 32 * GiB, freeBytes: 24 * GiB },
    gpus: [{ index: 0, name: 'RTX 3060', vendor: 'nvidia', vramTotalBytes: 12 * GiB, vramFreeBytes: 9.1 * GiB, utilPct: 2, source: 'nvidia-smi' }],
    serving: { model: 'qwen2.5-coder-7b', device: 'gpu', gpuIndex: 0, vramBytes: 5.5 * GiB },
    share: sharing(),
    insideHours: true,
    busy: { jobs: 0, turns: 0 },
    ...over
  };
}

const rita = (over = {}, adOver = {}) => ({ peerId: RITA, name: "Rita's PC", online: true, granted: true, rttMs: 30, advert: advert(adOver), ...over });

function input(over = {}) {
  return {
    job: job(over.job),
    local: { resource: localRes(over.res), brain: over.brain === undefined ? { device: 'cpu', model: 'qwen2.5-coder-7b' } : over.brain, queue: over.queue || { waiting: 0, running: 0 } },
    peers: over.peers || [rita()],
    now: NOW,
    outcomes: over.outcomes
  };
}

const cand = (d, key) => d.candidates.find((c) => c.target === key);

describe('resource scheduler decisions', () => {
  it('picks the peer GPU over a slow local CPU and says why in one sentence', () => {
    const d = decide(input());
    expect(d.ok).toBe(true);
    expect(d.target).toEqual({ kind: 'peer-gpu', peerId: RITA, gpuIndex: 0, model: 'qwen2.5-coder-7b' });
    expect(d.reason).toMatch(/^Rita's PC, GPU: Qwen2\.5-Coder 7B fits in 9\.1 of 12\.0 GB free, about \d+ s\./);
    expect(d.reason).toMatch(/Your GPU has 3\.2 GB free and Qwen2\.5-Coder 7B needs 5\.\d GB/);
    expect(cand(d, 'local-cpu').ok).toBe(true);
    expect(cand(d, 'local-cpu').estimateMs).toBeGreaterThan(d.estimateMs);
    expect(cand(d, 'local-gpu:0')).toMatchObject({ ok: false, code: 'vram' });
  });

  it('prefers the local GPU when it hosts the model (local bonus, no network)', () => {
    const d = decide(input({ brain: { device: 'gpu', gpuIndex: 0, model: 'qwen2.5-coder-7b' }, res: { free: 6 * GiB } }));
    expect(d.target.kind).toBe('local-gpu');
    expect(d.reason).toMatch(/^Your GPU: Qwen2\.5-Coder 7B fits in 6\.0 of 12\.0 GB free/);
    expect(d.reason).toMatch(/Rita's PC \(GPU\) would take about/);
  });

  it('breaks an exact tie for the local target', () => {
    const s = new ResourceScheduler({ now: () => NOW });
    // Same estimate everywhere: local GPU hosts the model and the peer has 0 ms RTT and the same speeds.
    const d = s.decide({ job: job(), local: { resource: localRes({ free: 9.1 * GiB }), brain: { device: 'gpu', gpuIndex: 0, model: 'qwen2.5-coder-7b' }, queue: { waiting: 0, running: 0 } }, peers: [rita({ rttMs: 0 })] });
    expect(d.target.kind).toBe('local-gpu');
  });

  it('is deterministic', () => {
    expect(decide(input())).toEqual(decide(input()));
  });

  const rejects = [
    ['a peer without a grant', { peers: [rita({ granted: false })] }, 'not_granted', /has not granted you compute\.inference/],
    ['a blocked peer', { peers: [rita({ blocked: true })] }, 'not_granted', /is blocked/],
    ['a peer that revoked a job this session', { peers: [rita({ revoked: true })] }, 'not_granted', /stopped one of your jobs/],
    ['a peer that does not share its GPU', { peers: [rita({}, { share: patchShare(sharing(), { gpu: { enabled: false } }) })] }, 'sharing_off', /does not share its GPU/],
    ['remote inference off', { peers: [rita({}, { share: patchShare(sharing(), { gpu: { remoteInference: false } }) })] }, 'sharing_off', /does not share its GPU/],
    ['a stale advert', { peers: [rita({}, { receivedAt: NOW - 16_000 })] }, 'sharing_off', /last 15 s/],
    ['outside its hours', { peers: [rita({}, { insideHours: false })] }, 'outside_hours', /hours/],
    ['a model not on its allowlist', { peers: [rita({}, { share: sharing({ modelAllowlist: ['qwen2.5-coder-3b'] }) })] }, 'model_not_allowed', /does not allow Qwen2\.5-Coder 7B/],
    ['no model loaded', { peers: [rita({}, { serving: null })] }, 'model_missing', /no model loaded/],
    ['at its job limit', { peers: [rita({}, { busy: { jobs: 1, turns: 0 } })] }, 'busy', /its limit/],
    ['a VRAM limit under what the model holds', { peers: [rita({}, { share: sharing({ gpu: { maxVramBytes: 4 * GiB } }) })] }, 'vram', /lends at most 4\.0 GB/],
    ['too little free VRAM', { peers: [rita({}, { gpus: [{ index: 0, name: 'RTX 3060', vendor: 'nvidia', vramTotalBytes: 12 * GiB, vramFreeBytes: 0.5 * GiB }] })] }, 'vram', /0\.5 GB free/],
    ['an agent that thinks only on its own machine', { job: { onlyLocal: true } }, 'not_granted', /only on its own machine/]
  ];
  for (const [name, over, code, detail] of rejects) {
    it(`rejects ${name} with ${code}`, () => {
      const d = decide(input(over));
      const c = cand(d, `peer-gpu:${RITA}:0`);
      expect(c).toMatchObject({ ok: false, code });
      expect(c.detail).toMatch(detail);
      expect(d.target?.kind).not.toBe('peer-gpu');
    });
  }

  it('skips peers that are offline entirely', () => {
    const d = decide(input({ peers: [rita({ online: false })] }));
    expect(d.candidates.some((c) => c.target.includes(RITA))).toBe(false);
    expect(d.target.kind).toBe('local-cpu');
  });

  it('refuses a job over the deadline and over the peer limit', () => {
    const d = decide(input({ job: { deadlineMs: 2000 } }));
    expect(d.ok).toBe(false);
    expect(cand(d, 'local-cpu')).toMatchObject({ ok: false, code: 'too_long' });
    expect(cand(d, `peer-gpu:${RITA}:0`)).toMatchObject({ ok: false, code: 'too_long' });
    const d2 = decide(input({ peers: [rita({}, { share: sharing({ gpu: { maxJobSeconds: 10 } }) })] }));
    expect(cand(d2, `peer-gpu:${RITA}:0`)).toMatchObject({ ok: false, code: 'too_long' });
    expect(cand(d2, `peer-gpu:${RITA}:0`).detail).toMatch(/its 10 s limit/);
  });

  it('says why nothing can run', () => {
    const d = decide(input({ brain: null, peers: [rita({ granted: false })] }));
    expect(d.ok).toBe(false);
    expect(d.target).toBe(null);
    expect(d.reason).toMatch(/^No machine can run this now/);
  });

  it('keeps background jobs off a busy local machine', () => {
    const d = decide(input({ job: { priority: 'background' }, brain: { device: 'gpu', gpuIndex: 0, model: 'qwen2.5-coder-7b' }, res: { free: 6 * GiB }, queue: { waiting: 1, running: 1 } }));
    expect(cand(d, 'local-gpu:0')).toMatchObject({ ok: false, code: 'busy' });
    expect(d.target.kind).toBe('peer-gpu');
  });

  it('a named model must be the one a target runs', () => {
    const d = decide(input({ job: { input: { model: 'qwen2.5-coder-14b', messages: prompt(), maxTokens: 512 } } }));
    expect(cand(d, 'local-cpu')).toMatchObject({ ok: false, code: 'model_missing' });
    expect(cand(d, `peer-gpu:${RITA}:0`)).toMatchObject({ ok: false, code: 'model_missing' });
  });

  it('uses a peer CPU when only the CPU is shared', () => {
    const share = patchShare(defaultShare(16), { cpu: { enabled: true, maxThreads: 8 }, modelAllowlist: ['3b'] }, { threads: 16 });
    const d = decide(input({ brain: null, peers: [rita({}, { gpus: [], serving: { model: 'qwen2.5-coder-3b', device: 'cpu' }, share })] }));
    expect(d.target).toMatchObject({ kind: 'peer-cpu', peerId: RITA });
    expect(d.reason).toMatch(/^Rita's PC, CPU: Qwen2\.5-Coder 3B, about/);
  });

  it('a CPU peer job over the lent RAM is refused with ram', () => {
    const share = patchShare(defaultShare(16), { cpu: { enabled: true, maxRamBytes: 1 * GiB }, modelAllowlist: ['3b'] }, { threads: 16 });
    const d = decide(input({ peers: [rita({}, { gpus: [], serving: { model: 'qwen2.5-coder-3b', device: 'cpu' }, share })] }));
    expect(cand(d, `peer-cpu:${RITA}`)).toMatchObject({ ok: false, code: 'ram' });
  });

  it('penalizes a target that crashed and remembers revokes', () => {
    const s = new ResourceScheduler({ now: () => NOW });
    const base = { job: job(), local: { resource: localRes({ free: 9 * GiB }), brain: { device: 'gpu', gpuIndex: 0, model: 'qwen2.5-coder-7b' }, queue: { waiting: 0, running: 0 } }, peers: [rita()] };
    expect(s.decide(base).target.kind).toBe('local-gpu');
    s.record('local-gpu:0', 'crashed');
    expect(s.decide(base).target.kind).toBe('peer-gpu');
    s.revoked(RITA);
    const d = s.decide(base);
    expect(d.target.kind).toBe('local-gpu');
    expect(cand(d, `peer-gpu:${RITA}:0`)).toMatchObject({ ok: false, code: 'not_granted' });
  });

  it('chooses between two peers by estimate and learns measured speeds', () => {
    const s = new ResourceScheduler({ now: () => NOW });
    const sam = { peerId: SAM, name: "Sam's PC", online: true, granted: true, rttMs: 10, advert: advert() };
    const base = { job: job(), local: { resource: localRes(), brain: null, queue: { waiting: 0, running: 0 } }, peers: [rita(), sam] };
    expect(s.decide(base).target.peerId).toBe(SAM);   // same speed, lower RTT
    // Sam turns out slow in practice: 5 tokens per second.
    s.speeds.observe(`peer-gpu:${SAM}:0`, 'qwen2.5-coder-7b', 'gpu', { promptTokens: 400, completionTokens: 100, ms: 20_500 });
    const d = s.decide(base);
    expect(d.target.peerId).toBe(RITA);
    expect(d.reason).toMatch(/Sam's PC \(GPU\) would take about/);
  });
});
