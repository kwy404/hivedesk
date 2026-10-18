// The pooled giant model meter: what counts (only what friends explicitly shared), the missing memory,
// the "invite 2 to 3 friends" hint, the honest speed with CPU workers and the internet, and the
// sharing settings (GPU and CPU separate, both off by default, clamped to the machine).
import { describe, it, expect } from 'vitest';
import { poolMeter, contribution, clampShare, shareDefaults, MIN_POOL_TPS } from '../../src/brain/catalog/pool.js';
import { pick } from '../../src/brain/catalog/index.js';
import { memoryNeed } from '../../src/brain/catalog/estimate.js';
import { cityPeers } from '../../src/brain/catalog/commands.js';

const GB = 1e9;
const ME = { gpu: { name: 'NVIDIA GeForce GTX 1060 6GB', vramBytes: 6.44 * GB, backend: 'cuda' }, ramBytes: 16 * GB, cpu: { cores: 4, threads: 4, avx2: true, ramMts: 1600, ramModules: 2 } };
const NO_RAM = { ...ME, ramBytes: 4 * GB };
const friend = (id, vram, extra = {}) => ({
  id, name: id, online: true, network: 'lan',
  hw: { gpu: { name: 'NVIDIA GeForce RTX 3060', vramBytes: vram + 1 * GB }, ramBytes: 32 * GB, cpu: { cores: 8 } },
  share: { gpu: { enabled: true, maxVramBytes: vram }, cpu: { enabled: false } }, ...extra
});
// A fake giant: exactly 40 GB needed at 4096 tokens.
const giant = (() => {
  const p = pick('llama-3.3-70b', 'Q4_K_M');
  const overhead = memoryNeed(p.arch, 0, 4096);
  return { ...p, bytes: 40 * GB - overhead };
})();

describe('sharing settings', () => {
  it('are off by default, GPU and CPU separately', () => {
    const d = shareDefaults();
    expect(d.gpu.enabled).toBe(false);
    expect(d.cpu.enabled).toBe(false);
    expect(d.gpu).toMatchObject({ maxVramBytes: 0, maxJobs: 1 });
    expect(d.cpu).toMatchObject({ maxThreads: 0, maxRamBytes: 0, maxJobs: 1 });
    expect(clampShare(undefined, ME)).toEqual(d);
  });

  it('are clamped to the machine: VRAM minus 1 GB, never every core, RAM minus 4 GB, 5 to 480 minutes, 1 to 4 jobs', () => {
    const s = clampShare({ gpu: { enabled: true, maxVramBytes: 99 * GB, maxMinutes: 9999, maxJobs: 50 }, cpu: { enabled: true, maxThreads: 64, maxRamBytes: 99 * GB, maxMinutes: 1 } }, ME);
    expect(s.gpu).toEqual({ enabled: true, maxVramBytes: 5.44 * GB, maxMinutes: 480, maxJobs: 4 });
    expect(s.cpu).toMatchObject({ enabled: true, maxThreads: 3, maxRamBytes: 12 * GB, maxMinutes: 5, maxJobs: 1 });
    // enabled needs an amount, and only true enables
    expect(clampShare({ gpu: { enabled: true, maxVramBytes: 0 } }, ME).gpu.enabled).toBe(false);
    expect(clampShare({ gpu: { enabled: 'yes', maxVramBytes: 4 * GB } }, ME).gpu.enabled).toBe(false);
    expect(clampShare({ gpu: { enabled: true, maxVramBytes: 4 * GB } }, { ramBytes: 16 * GB }).gpu.enabled).toBe(false);
  });
});

describe('what a friend contributes', () => {
  it('only what was explicitly shared, while online and not expired', () => {
    expect(contribution(friend('ana', 8 * GB))).toMatchObject({ vram: 8 * GB, ram: 0 });
    expect(contribution({ ...friend('ana', 8 * GB), share: null }).vram).toBe(0);
    expect(contribution({ ...friend('ana', 8 * GB), online: false }).vram).toBe(0);
    expect(contribution({ ...friend('ana', 8 * GB), sharedUntil: 1000 }, 2000).vram).toBe(0);
    // a self reported share above the reported card is capped
    expect(contribution(friend('big', 40 * GB)).vram).toBe(40 * GB);
    expect(contribution({ ...friend('liar', 40 * GB), hw: { gpu: { vramBytes: 8 * GB }, ramBytes: 16 * GB } }).vram).toBe(7 * GB);
  });

  it('reads the City machines but never the host, and nothing a friend did not share', () => {
    const peers = cityPeers({ city: { machines: { a: { id: 'a', host: true, name: 'Me' }, b: { id: 'b', name: 'Rita', gpu: 'RTX 3060', vramBytes: 12 * GB } } } });
    expect(peers.map((p) => p.id)).toEqual(['b']);
    expect(peers[0].share).toBeNull();
    expect(contribution(peers[0]).vram).toBe(0);
  });
});

describe('the unlock meter', () => {
  it('40 GB needed, 18 GB in the city: 22 GB missing, invite 2 to 3 friends with a GPU', () => {
    const hw = { ...NO_RAM, gpu: { ...ME.gpu, vramBytes: 6.75 * GB } };
    const m = poolMeter(giant, 4096, hw, [friend('ana', 6 * GB), friend('bia', 6 * GB)]);
    expect(m.need).toBeCloseTo(40 * GB, -6);
    expect(m.mine.vram).toBe(6 * GB);
    expect(m.vram).toBe(18 * GB);
    expect(m.sharedVram).toBe(12 * GB);
    expect(m.missingVram).toBeCloseTo(22 * GB, -6);
    expect(m.friendsHint).toEqual([2, 3]);
    expect(m.unlocked).toBe(false);
  });

  it('unlocks for the session when the pooled memory fits and the speed is usable', () => {
    const m = poolMeter(giant, 4096, NO_RAM, [friend('ana', 12 * GB), friend('bia', 12 * GB), friend('cai', 12 * GB)]);
    expect(m.missing).toBe(0);
    expect(m.tps).toBeGreaterThanOrEqual(MIN_POOL_TPS);
    expect(m.unlocked).toBe(true);
    expect(m.network).toBe('lan');
    expect(m.plan.reduce((n, s) => n + s.bytes, 0)).toBeCloseTo(giant.bytes, -3);
  });

  it('counts shared RAM for memory but weighs it honestly for speed', () => {
    const gpuOnly = poolMeter(giant, 4096, NO_RAM, [friend('ana', 12 * GB), friend('bia', 12 * GB), friend('cai', 12 * GB)]);
    const cpuFriend = { ...friend('dan', 0), share: { gpu: { enabled: false }, cpu: { enabled: true, maxThreads: 7, maxRamBytes: 24 * GB } } };
    const mixed = poolMeter(giant, 4096, NO_RAM, [friend('ana', 12 * GB), cpuFriend]);
    expect(mixed.missing).toBe(0);
    expect(mixed.sharedRam).toBe(24 * GB);
    expect(mixed.tps).toBeLessThan(gpuOnly.tps / 2);
  });

  it('is slower over the internet than on the same network, and never unlocks without a friend', () => {
    const lan = poolMeter(giant, 4096, NO_RAM, [friend('ana', 12 * GB), friend('bia', 12 * GB), friend('cai', 12 * GB)]);
    const far = poolMeter(giant, 4096, NO_RAM, ['ana', 'bia', 'cai'].map((id) => friend(id, 12 * GB, { network: 'internet' })));
    expect(far.network).toBe('internet');
    expect(far.tps).toBeLessThan(lan.tps);
    const alone = poolMeter(pick('qwen2.5-coder-3b', 'Q4_K_M'), 4096, ME, []);
    expect(alone.missing).toBe(0);
    expect(alone.unlocked).toBe(false);
  });

  it('does not unlock when the memory fits but the estimate is under 1 token per second', () => {
    const slow = { ...friend('slow', 0), network: 'internet', share: { gpu: { enabled: false }, cpu: { enabled: true, maxThreads: 1, maxRamBytes: 40 * GB } }, hw: { ramBytes: 64 * GB, cpu: { cores: 2 } } };
    const m = poolMeter(giant, 4096, NO_RAM, [slow]);
    expect(m.missing).toBe(0);
    expect(m.tps).toBeLessThan(1);
    expect(m.unlocked).toBe(false);
  });
});
