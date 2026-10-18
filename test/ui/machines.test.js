// The Machines panel view (ui/city/machines.js): a number is a measurement with a source, or it is
// unknown. The 0.2 slot "load" is not a CPU or GPU load, and a friend's join data is not verified.
import { describe, it, expect } from 'vitest';
import { machinesView, machineCard, liveOf, gb } from '../../ui/city/machines.js';
import { blankCompute, applyComputeLive, applyComputeEvent } from '../../ui/city/compute.js';
import { viewOf, blankLive, applyLive } from '../../ui/city/model.js';
import { initialCity, reduceCity, ROOMS } from '../../src/city/state.js';

let seq = 0;
const ev = (type, data) => ({ seq: ++seq, ts: new Date(1_800_000_000_000 + seq * 1000).toISOString(), type, data });
const byKey = (card) => Object.fromEntries(card.fields.map((f) => [f.key, f]));

function city({ gpu = { name: 'NVIDIA RTX 4070', vramBytes: 12 * 1024 ** 3, backend: 'cuda' } } = {}) {
  const c = initialCity();
  reduceCity(c, ev('city.started', { host: 'm_host' }));
  reduceCity(c, ev('city.machine.joined', { machine: { id: 'm_host', name: 'Studio', host: true, owner: 'host', gpu, ramBytes: 32 * 1024 ** 3, cpus: 16, model: 'Qwen2.5-Coder 7B', peerId: 'hd1me' } }));
  reduceCity(c, ev('city.machine.joined', { machine: { id: 'm_rita', name: "Rita's PC", host: false, owner: 'peer:hd1rita', peerId: 'hd1rita', reported: true, gpu: { name: 'RTX 3060', vramBytes: 12e9 }, ramBytes: 16e9, cpus: 12 } }));
  for (const r of ROOMS) reduceCity(c, ev('city.room.added', { room: { ...r } }));
  return c;
}

describe('the Machines panel view', () => {
  it('says not measured for everything no probe measured, and marks start time and join data', () => {
    const v = viewOf(city());
    const cards = machinesView(v, blankCompute(), { now: Date.now() });
    expect(cards.map((x) => x.id)).toEqual(['m_host', 'm_rita']);
    const host = byKey(cards[0]);
    expect(cards[0].state).toBe('static');
    expect(host.gpu).toMatchObject({ value: 'NVIDIA RTX 4070', state: 'static', source: 'startup' });
    expect(host.vram).toMatchObject({ value: { usedBytes: null, totalBytes: 12 * 1024 ** 3 }, state: 'static' });
    expect(host.gpuUtil).toMatchObject({ value: null, state: 'unknown', source: null });
    expect(host.cpu).toMatchObject({ value: null, state: 'unknown', cores: 16 });
    expect(host.tps).toMatchObject({ value: null, state: 'unknown' });
    expect(host.slots.state).toBe('unknown');
    const rita = byKey(cards[1]);
    expect(cards[1].state).toBe('joined');
    expect(rita.gpu).toMatchObject({ value: 'RTX 3060', state: 'joined', source: "join:Rita's PC" });
    expect(cards[0].share).toBe(null);
  });

  it('calls Apple unified memory an estimate', () => {
    const v = viewOf(city({ gpu: { name: 'Apple Silicon GPU', vramBytes: 10e9, backend: 'metal', unified: true } }));
    const f = byKey(machineCard(v.machines.m_host, v, blankCompute()));
    expect(f.vram.state).toBe('estimate');
    expect(f.vram.source).toBe('unified');
  });

  it('shows live probe values with their source, a friend advert as reported, and stale samples', () => {
    const v = viewOf(city());
    const c = blankCompute();
    const now = 1_900_000_000_000;
    applyComputeLive(c, { type: 'resources.sample', data: { machineId: 'm_host', sampledAt: now - 1000, cpu: { cores: 16, loadPct: 37.5 }, ram: { totalBytes: 32e9, freeBytes: 20e9 }, gpus: [{ name: 'NVIDIA RTX 4070', vendor: 'nvidia', vramTotalBytes: 12e9, vramFreeBytes: 3e9, utilPct: 64, source: 'nvidia-smi' }], models: [{ id: 'qwen-7b', loaded: true }] } }, { now });
    applyComputeLive(c, { type: 'resource.advert', data: { peerId: 'hd1rita', resource: { machineId: 'm_rita', sampledAt: now - 30_000, cpu: { loadPct: 5 }, gpus: [] } } }, { now, selfPeerId: 'hd1me' });
    const [host, rita] = machinesView(v, c, { now, selfPeerId: 'hd1me' });
    const h = byKey(host);
    expect(host.state).toBe('measured');
    expect(h.gpuUtil).toMatchObject({ value: 64, state: 'measured', source: 'nvidia-smi' });
    expect(h.vram.value).toEqual({ usedBytes: 9e9, totalBytes: 12e9 });
    expect(h.cpu).toMatchObject({ value: 37.5, state: 'measured', source: 'os.cpus' });
    expect(h.ram.value).toEqual({ usedBytes: 12e9, totalBytes: 32e9 });
    expect(h.model).toMatchObject({ value: 'qwen-7b', loaded: true, source: 'runtime' });
    // the building indicators: the load ring and the VRAM bar read only measured or reported values
    expect(liveOf(host)).toMatchObject({ util: 0.64, vram: 0.75, cpu: 0.375 });
    expect(rita.state).toBe('stale');
    expect(byKey(rita).gpu).toMatchObject({ value: null, state: 'none' });
  });

  it('turns the engine slot frame into model slots and real tokens per second, never a load bar', () => {
    const live = blankLive();
    applyLive(live, { type: 'city.machine.load', data: { machineId: 'm_host', load: 1, slots: { busy: 1, total: 1 }, queue: 0, tps: 23.4 } });
    const v = viewOf(city(), live);
    const f = byKey(machineCard(v.machines.m_host, v, blankCompute()));
    expect(f.slots).toMatchObject({ value: { busy: 1, total: 1 }, state: 'measured', source: 'scheduler' });
    expect(f.tps).toMatchObject({ value: 23.4, state: 'measured', source: 'turn.ended' });
    expect(f).not.toHaveProperty('load');
    expect(liveOf(machineCard(v.machines.m_host, v, blankCompute()))).toEqual({ util: null, vram: null, cpu: null, jobs: 0, slotsBusy: 1 });
  });

  it('lists the jobs a machine serves with their leases, and the share settings', () => {
    const v = viewOf(city());
    const c = blankCompute();
    const now = Date.now();
    applyComputeEvent(c, ev('job.created', { job: { id: 'jb_9', requester: 'hd1rita', worker: 'hd1me', input: { model: 'qwen-7b' } } }));
    applyComputeEvent(c, ev('job.accepted', { jobId: 'jb_9', lease: { id: 'ls_9', expiresAt: now + 9000, hardDeadline: now + 60000 } }));
    applyComputeEvent(c, ev('share.changed', { share: { enabled: true, remoteInference: true, maxConcurrentJobs: 1, maxVramBytes: null, maxJobSeconds: 120, maxTokensPerJob: 2048, modelAllowlist: ['qwen-7b'] } }));
    const host = machineCard(v.machines.m_host, v, c, { now, selfPeerId: 'hd1me' });
    expect(host.jobs).toEqual([expect.objectContaining({ id: 'jb_9', state: 'leased', forPeer: true, leaseId: 'ls_9', countdown: { lease: 9, deadline: 60 } })]);
    expect(host.share).toMatchObject({ enabled: true, remoteInference: true, maxJobSeconds: 120, maxVramBytes: null, modelAllowlist: ['qwen-7b'] });
    expect(machineCard(v.machines.m_rita, v, c, { now, selfPeerId: 'hd1me' }).jobs).toEqual([]);
    expect(gb(12 * 1024 ** 3)).toBe(12);
    expect(gb(1.5 * 1024 ** 3)).toBe(1.5);
    expect(gb(null)).toBe(null);
  });
});
