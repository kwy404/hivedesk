import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { EventBus } from '../../src/bus.js';
import { Scheduler } from '../../src/crew/scheduler.js';
import register, { localServing } from '../../src/compute/index.js';
import { loadShare, saveShare, patchShare } from '../../src/compute/share.js';
import { tmpDir, waitFor } from '../helpers.js';
import { Net, controlledBrain, resource, tick } from './rig.js';

function fakeProbe(sample = resource()) {
  let n = 0;
  return { calls: () => n, sample: async () => { n++; return { ...sample, sampledAt: Date.now() }; }, setRuntime() {}, close() {} };
}

function engine(opts = {}) {
  const home = tmpDir();
  const bus = new EventBus();
  const scheduler = new Scheduler(bus);
  const brain = opts.brain || controlledBrain();
  scheduler.addBrain(brain);
  const commands = new Map();
  const routes = [];
  const live = [];
  bus.onLive((type, data) => live.push({ type, data }));
  const probe = fakeProbe(opts.resource);
  const plane = register({ bus, scheduler, home, probe, link: opts.link, sharePollMs: opts.sharePollMs, server: { command: (t, fn) => commands.set(t, fn), route: (...a) => routes.push(a) } });
  const run = (t, d = {}) => commands.get(t)(d);
  return { home, bus, scheduler, brain, commands, routes, live, probe, plane, run };
}

describe('compute plug-in', () => {
  it('samples the machine and sends throttled live frames plus a logged change', async () => {
    const e = engine();
    await waitFor(() => e.live.some((l) => l.type === 'resources.sample'));
    const s = e.live.find((l) => l.type === 'resources.sample').data;
    expect(s).toMatchObject({ machine: 'local', serving: { model: 'qwen2.5-coder-3b', device: 'gpu', gpuIndex: 0 }, busy: { jobs: 0 } });
    expect(s.gpus[0].source).toBe('nvidia-smi');
    expect(e.bus.events.filter((ev) => ev.type === 'resources.changed')).toHaveLength(1);
    // Live frames are never logged.
    expect(e.bus.events.some((ev) => ev.type === 'resources.sample')).toBe(false);
    await e.plane.sample();
    expect(e.bus.events.filter((ev) => ev.type === 'resources.changed')).toHaveLength(1);
    e.plane.close();
  });

  it('shows and changes ShareSettings and saves them', async () => {
    const e = engine();
    expect(e.run('compute.share.get').share.enabled).toBe(false);
    const r = e.run('compute.share.set', { change: { cpu: { enabled: true, maxThreads: 2 } } });
    expect(r.share.cpu).toMatchObject({ enabled: true, maxThreads: 2 });
    expect(r.lines).toContain('CPU sharing: on');
    expect(loadShare(e.home).cpu.enabled).toBe(true);
    expect(e.bus.events.find((ev) => ev.type === 'share.changed').data.why).toBe('window');
    e.plane.close();
  });

  it('picks up a `hivedesk share` change written by another process', async () => {
    const e = engine({ sharePollMs: 20 });
    await tick(30);
    saveShare(e.home, patchShare(loadShare(e.home), { gpu: { enabled: true, remoteInference: true } }));
    await waitFor(() => e.bus.events.some((ev) => ev.type === 'share.changed'));
    expect(e.bus.events.find((ev) => ev.type === 'share.changed').data.why).toBe('settings file');
    expect(e.plane.share.gpu.enabled).toBe(true);
    expect(fs.existsSync(path.join(e.home, 'settings.json'))).toBe(true);
    e.plane.close();
  });

  it('answers where a job would run, with the reason', async () => {
    const e = engine();
    await waitFor(() => e.plane.resource);
    const { decision } = e.run('compute.decide', { promptChars: 2000, maxTokens: 256 });
    expect(decision.ok).toBe(true);
    expect(decision.target.kind).toBe('local-gpu');
    expect(decision.reason).toMatch(/^Your GPU: Qwen2\.5-Coder 3B fits in/);
    e.plane.close();
  });

  it('without p2p it runs local only and says so', async () => {
    const e = engine();
    await waitFor(() => e.plane.resource);
    expect(e.run('compute.resources').p2p).toBe(false);
    expect(() => e.run('compute.job.stop', { all: true })).toThrow(/not available in this build/);
    expect(e.scheduler.brains.has('compute')).toBe(false);
    e.plane.close();
  });

  it('with a peer that grants compute, the compute brain joins the pool and adverts flow both ways', async () => {
    const net = new Net();
    const mine = net.node('alex');
    const rita = net.node('rita');
    const got = [];
    rita.onMessage((from, type, body) => { if (type === 'resource.advert') got.push(body); });
    net.grant(mine, rita);   // rita may use my machine: she gets my adverts
    net.grant(rita, mine);   // I may use hers: the compute brain joins my pool
    const e = engine({ link: mine });
    await waitFor(() => got.length);
    expect(got[0]).toMatchObject({ serving: { model: 'qwen2.5-coder-3b', device: 'gpu' }, share: { gpu: { enabled: false } }, busy: { jobs: 0 } });
    expect(JSON.stringify(got[0])).not.toMatch(/luid|pciBusId/);
    expect(e.scheduler.brains.has('compute')).toBe(true);
    rita.send(mine.selfId, 'resource.advert', { gpus: [{ name: 'RTX 3060', vramTotalBytes: 12e9, vramFreeBytes: 9e9 }], share: {}, serving: null });
    await waitFor(() => e.live.some((l) => l.type === 'resources.peer'));
    expect(e.live.find((l) => l.type === 'resources.peer').data).toMatchObject({ peerId: rita.selfId, reportedBy: "rita's PC" });
    net.revoke(rita, mine);
    expect(e.scheduler.brains.has('compute')).toBe(false);
    e.plane.close();
  });

  it('sees the loaded brain where it really runs', () => {
    const bus = new EventBus();
    const s = new Scheduler(bus);
    s.addBrain({ id: 'cloud:openai', kind: 'cloud', info: () => ({ backend: 'openai', model: 'x' }), chat: async () => ({}) });
    expect(localServing(s, resource())).toBe(null);
    s.addBrain(controlledBrain({ gpu: 'cpu' }));
    expect(localServing(s, resource())).toMatchObject({ brainId: 'local', device: 'cpu', vramBytes: 0 });
    const s2 = new Scheduler(bus);
    s2.addBrain(controlledBrain({ backend: 'ollama' }));
    expect(localServing(s2, { gpus: [{ vendor: 'intel', integrated: true }, { vendor: 'amd', integrated: false }] })).toMatchObject({ device: 'gpu', gpuIndex: 1 });
    expect(patchShare).toBeTypeOf('function');
  });
});

describe('the model a rotating local brain serves', () => {
  it('uses the catalog id and the device of the loaded model, and a model id on the allowlist covers its quants', async () => {
    const { sameModel } = await import('../../src/compute/estimate.js');
    const brain = { id: 'local', kind: 'local', info: () => ({ backend: 'local', model: 'Qwen2.5-Coder 3B Instruct (Q4_K_M)', modelId: 'qwen2.5-coder-3b:Q4_K_M', gpu: 'vulkan', fileBytes: 2e9 }) };
    const s = localServing({ brains: new Map([['local', { brain }]]) }, resource());
    expect(s).toMatchObject({ model: 'qwen2.5-coder-3b:Q4_K_M', device: 'gpu', gpuIndex: 0 });
    expect(sameModel(s.model, 'qwen2.5-coder-3b')).toBe(true);
    expect(sameModel(s.model, 'qwen2.5-coder-3b:Q8_0')).toBe(false);
    expect(sameModel(s.model, 'qwen2.5-coder-7b')).toBe(false);
  });
});
