// The recommendation for ten hardware profiles, plus context size, task, disk, installed models and the
// reasons. Pure: no hardware is touched.
import { describe, it, expect } from 'vitest';
import { recommend, budgets, placement, cpuCores, explainText, shortName, gpuBandwidth } from '../../src/brain/catalog/recommend.js';
import { pick, needFor } from '../../src/brain/catalog/index.js';
import { inferCpuFeatures, vulkanGpu, probeOs } from '../../src/brain/hardware.js';

const GB = 1e9;
const P = {
  gtx1060: { gpu: { name: 'NVIDIA GeForce GTX 1060 6GB', vramBytes: 6442450944, backend: 'cuda' }, ramBytes: 16 * GB, diskFreeBytes: 120 * GB, cpu: { model: 'Intel(R) Core(TM) i5-4440 CPU @ 3.10GHz', cores: 4, threads: 4, avx2: true, avx512: false, ramMts: 1600, ramModules: 2 } },
  rtx3060: { gpu: { name: 'NVIDIA GeForce RTX 3060', vramBytes: 12884901888, backend: 'cuda' }, ramBytes: 32 * GB, diskFreeBytes: 500 * GB, cpu: { cores: 6, threads: 12, avx2: true } },
  rtx4090: { gpu: { name: 'NVIDIA GeForce RTX 4090', vramBytes: 25757220864, backend: 'cuda' }, ramBytes: 64 * GB, diskFreeBytes: 1000 * GB, cpu: { cores: 16, threads: 32, avx2: true, avx512: true } },
  gtx1650: { gpu: { name: 'NVIDIA GeForce GTX 1650', vramBytes: 4294967296, backend: 'cuda' }, ramBytes: 8 * GB, diskFreeBytes: 60 * GB, cpu: { cores: 4, threads: 8, avx2: true } },
  laptop8: { gpu: null, ramBytes: 8 * GB, diskFreeBytes: 50 * GB, cpu: { model: 'Intel(R) Core(TM) i5-8250U', cores: 4, threads: 8, avx2: true } },
  desk32cpu: { gpu: null, ramBytes: 32 * GB, diskFreeBytes: 300 * GB, cpu: { model: 'AMD Ryzen 7 7700X', cores: 8, threads: 16, avx2: true, avx512: true, ramMts: 5200, ramModules: 2 } },
  m1_8: { gpu: { name: 'Apple M1 GPU', chip: 'Apple M1', vramBytes: Math.floor(8 * GB * 0.66), backend: 'metal', unified: true }, ramBytes: 8 * GB, diskFreeBytes: 100 * GB, cpu: { cores: 8, threads: 8, avx2: false } },
  m2max64: { gpu: { name: 'Apple M2 Max GPU', chip: 'Apple M2 Max', vramBytes: Math.floor(64 * GB * 0.75), backend: 'metal', unified: true }, ramBytes: 64 * GB, diskFreeBytes: 500 * GB, cpu: { cores: 12, threads: 12, avx2: false } },
  oldcpu4: { gpu: null, ramBytes: 4 * GB, diskFreeBytes: 20 * GB, cpu: { model: 'Intel(R) Core(TM)2 Duo', cores: 2, threads: 2, avx2: false } },
  rx6700: { gpu: { name: 'AMD Radeon RX 6700 XT', vramBytes: 12 * GB, backend: 'vulkan' }, ramBytes: 16 * GB, diskFreeBytes: 200 * GB, cpu: { cores: 6, threads: 12, avx2: true } },
  lowdisk: { gpu: { name: 'NVIDIA GeForce RTX 3070', vramBytes: 8589934592, backend: 'cuda' }, ramBytes: 16 * GB, diskFreeBytes: 3 * GB, cpu: { cores: 8, threads: 16, avx2: true } }
};
const rec = (k, o) => recommend(P[k], { ctx: 4096, task: 'coding', ...o });

describe('recommendation for ten hardware profiles', () => {
  it('GTX 1060 6 GB (this PC): 7B IQ4_XS fully on the GPU, measured, never the 7B Q4_K_M that spills', () => {
    const r = rec('gtx1060');
    expect(r.recommended).toMatchObject({ id: 'qwen2.5-coder-7b:IQ4_XS', where: 'gpu', measured: true, tps: 20.6 });
    expect(r.options.find((o) => o.id === 'qwen2.5-coder-7b:Q4_K_M').where).not.toBe('gpu');
    expect(r.faster.measured).toBe(true);
    expect(r.faster.tps).toBeGreaterThan(r.recommended.tps);
    expect(r.smarter.quality).toBeGreaterThan(r.recommended.quality);
    // Q3_K on this card is slow: measured, and below IQ4_XS
    expect(r.options.find((o) => o.id === 'qwen2.5-coder-7b:Q3_K_M').tps).toBeLessThan(10);
    expect(r.hardware).toMatchObject({ cpu: { cores: 4, avx2: true } });
  });

  it('RTX 3060 12 GB: a 14B class model fully on the GPU at a good speed', () => {
    const r = rec('rtx3060');
    expect(r.recommended.where).toBe('gpu');
    expect(pick(...r.recommended.id.split(':')).params).toBeGreaterThanOrEqual(14);
    expect(r.recommended.tps).toBeGreaterThanOrEqual(10);
  });

  it('RTX 4090 24 GB: the best coding quality, and a giant 32B Q4_K_M runs alone on it', () => {
    const r = rec('rtx4090');
    expect(r.recommended.quality).toBeGreaterThanOrEqual(85);
    expect(r.recommended.where).toBe('gpu');
    const big = r.options.find((o) => o.id === 'qwen2.5-coder-32b:Q4_K_M');
    expect(big).toMatchObject({ giant: true, where: 'gpu', runnable: true });
  });

  it('GTX 1650 4 GB with 8 GB RAM: a 3B fully on the GPU; the 7B only partly', () => {
    const r = rec('gtx1650');
    expect(r.recommended.modelId).toBe('qwen2.5-coder-3b');
    expect(r.recommended.where).toBe('gpu');
    expect(r.options.filter((o) => o.modelId === 'qwen2.5-coder-7b').every((o) => o.where !== 'gpu' || o.quant === 'Q2_K' || o.quant.startsWith('IQ3'))).toBe(true);
  });

  it('CPU only laptop, 8 GB: a small model on the CPU that leaves RAM for the OS, at a usable speed', () => {
    const r = rec('laptop8');
    expect(r.hardware.gpu).toBeNull();
    expect(r.recommended.where).toBe('cpu');
    expect(r.recommended.need).toBeLessThanOrEqual(budgets(P.laptop8).cpuRam);
    expect(r.recommended.tps).toBeGreaterThanOrEqual(4);
    expect(r.recommended.why[0]).toMatchObject({ k: 'cpu', cores: 4, avx2: true });
  });

  it('CPU only desktop with AVX-512 and 32 GB: a mixture of experts model, fast because few weights are read per token', () => {
    const r = rec('desk32cpu');
    expect(r.recommended.where).toBe('cpu');
    expect(pick(...r.recommended.id.split(':')).activeParams).toBeGreaterThan(0);
    const avx2Only = recommend({ ...P.desk32cpu, cpu: { ...P.desk32cpu.cpu, avx512: false, cores: 2, ramMts: null } }, { ctx: 4096 });
    expect(avx2Only.options.find((o) => o.id === 'qwen2.5-coder-7b:Q4_K_M').tps).toBeLessThan(r.options.find((o) => o.id === 'qwen2.5-coder-7b:Q4_K_M').tps);
  });

  it('Apple M1 with 8 GB unified memory: the GPU through Metal, within the wired share', () => {
    const r = rec('m1_8');
    expect(r.recommended.where).toBe('gpu');
    expect(r.recommended.why[0].k).toBe('unified');
    expect(r.recommended.need).toBeLessThanOrEqual(P.m1_8.gpu.vramBytes - 1e9);
    expect(r.options.every((o) => o.where !== 'partial' && o.where !== 'cpu')).toBe(true);
  });

  it('Apple M2 Max with 64 GB: top quality on the GPU', () => {
    const r = rec('m2max64');
    expect(r.recommended.quality).toBeGreaterThanOrEqual(85);
    expect(r.recommended.where).toBe('gpu');
    expect(gpuBandwidth(P.m2max64.gpu)).toBe(400e9);
  });

  it('old CPU without AVX2 and 4 GB: the smallest models, with the basic results warning', () => {
    const r = rec('oldcpu4');
    expect(r.recommended.where).toBe('cpu');
    expect(['qwen2.5-coder-0.5b', 'qwen2.5-coder-1.5b', 'qwen2.5-0.5b', 'llama-3.2-1b']).toContain(r.recommended.modelId);
    expect(r.warning).toBe('basic');
    expect(r.recommended.why[0]).toMatchObject({ k: 'cpu', avx2: false });
  });

  it('AMD RX 6700 XT 12 GB on Vulkan: on the GPU, a little slower than the same bandwidth on CUDA', () => {
    const r = rec('rx6700');
    expect(r.recommended.where).toBe('gpu');
    expect(r.hardware.gpu.backend).toBe('vulkan');
    const cuda = recommend({ ...P.rx6700, gpu: { ...P.rx6700.gpu, backend: 'cuda' } }, { ctx: 4096 });
    const id = 'qwen2.5-coder-7b:Q4_K_M';
    expect(r.options.find((o) => o.id === id).tps).toBeLessThan(cuda.options.find((o) => o.id === id).tps);
  });

  it('3 GB of free disk: only what fits on the disk, unless it is already downloaded', () => {
    const r = rec('lowdisk');
    expect(r.recommended.bytes + 0.1 * GB).toBeLessThanOrEqual(3 * GB);
    const with7b = rec('lowdisk', { installed: ['qwen2.5-coder-7b:Q4_K_M'] });
    expect(with7b.options.find((o) => o.id === 'qwen2.5-coder-7b:Q4_K_M').runnable).toBe(true);
    expect(with7b.recommended.id).toBe('qwen2.5-coder-7b:Q4_K_M');
    expect(with7b.recommended.why.some((w) => w.k === 'installed')).toBe(true);
  });
});

describe('context, task and reasons', () => {
  it('a bigger context needs more memory and can move a model off the GPU', () => {
    const p = pick('qwen2.5-coder-7b', 'IQ4_XS');
    expect(needFor(p, 32768)).toBeGreaterThan(needFor(p, 4096));
    expect(placement(P.gtx1060, p, 4096).where).toBe('gpu');
    expect(placement(P.gtx1060, p, 32768).where).not.toBe('gpu');
    const r = recommend(P.gtx1060, { ctx: 32768 });
    expect(r.options.every((o) => pick(...o.id.split(':')).contextLength >= 32768)).toBe(true);
    expect(recommend(P.gtx1060, { ctx: 16384 }).options.some((o) => o.modelId === 'gemma-2-9b')).toBe(false);
  });

  it('ranks by the task: reasoning prefers a different model than coding on a big card', () => {
    const coding = rec('rtx4090');
    const reasoning = rec('rtx4090', { task: 'reasoning' });
    expect(reasoning.task).toBe('reasoning');
    expect(reasoning.recommended.quality).toBeGreaterThanOrEqual(75);
    expect(coding.options[0].id === reasoning.options[0].id && coding.options[1].id === reasoning.options[1].id).toBe(false);
  });

  it('says why: fits in the VRAM with the context, smarter than the current model, measured or estimated', () => {
    const r = rec('gtx1060', { current: 'qwen2.5-coder-3b:Q4_K_M', installed: ['qwen2.5-coder-3b:Q4_K_M'] });
    expect(r.current.id).toBe('qwen2.5-coder-3b:Q4_K_M');
    expect(r.recommended.why).toEqual(expect.arrayContaining([
      expect.objectContaining({ k: 'fitsGpu', ctx: 4096, vram: 6442450944 }),
      expect.objectContaining({ k: 'smarter', than: '3B Q4_K_M' }),
      expect.objectContaining({ k: 'measured' })
    ]));
    expect(explainText(r.recommended)).toMatch(/^7B IQ4_XS .*fits in the 6\.4 GB of VRAM with a 4096 token context; smarter than 3B Q4_K_M/);
    expect(shortName({ modelId: 'qwen3-coder-30b-a3b', quant: 'Q4_K_M' })).toBe('30B Q4_K_M');
  });

  it('turns the GPU off on request (--cpu) and counts cores', () => {
    const r = recommend(P.gtx1060, { ctx: 4096, gpu: false });
    expect(r.recommended.where).toBe('cpu');
    expect(r.hardware.gpu).toBeNull();
    expect(cpuCores({ cpu: { threads: 8 } })).toBe(4);
    expect(cpuCores({ cpu: { threads: 4 } })).toBe(4);
  });
});

describe('hardware probes', () => {
  it('infers AVX2 and AVX-512 from the CPU name', () => {
    expect(inferCpuFeatures('Intel(R) Core(TM) i5-4440 CPU @ 3.10GHz')).toEqual({ avx2: true, avx512: false });
    expect(inferCpuFeatures('Intel(R) Core(TM) i7-3770 CPU')).toEqual({ avx2: false, avx512: false });
    expect(inferCpuFeatures('11th Gen Intel(R) Core(TM) i7-11700K')).toEqual({ avx2: true, avx512: true });
    expect(inferCpuFeatures('13th Gen Intel(R) Core(TM) i5-13600K')).toEqual({ avx2: true, avx512: false });
    expect(inferCpuFeatures('AMD Ryzen 5 3600 6-Core Processor')).toEqual({ avx2: true, avx512: false });
    expect(inferCpuFeatures('AMD Ryzen 9 7950X 16-Core Processor')).toEqual({ avx2: true, avx512: true });
    expect(inferCpuFeatures('Apple M2')).toEqual({ avx2: false, avx512: false });
  });

  it('finds a Vulkan GPU, but not integrated graphics', () => {
    expect(vulkanGpu([{ name: 'Intel(R) HD Graphics 4600', vramBytes: 0 }, { name: 'AMD Radeon RX 6600', vramBytes: 8 * GB }])).toMatchObject({ backend: 'vulkan', vramBytes: 8 * GB });
    expect(vulkanGpu([{ name: 'Intel(R) UHD Graphics 620', vramBytes: 128e6 }])).toBeNull();
  });

  it('reads the Windows probe and the Linux /proc/cpuinfo', async () => {
    const win = await probeOs(async () => JSON.stringify({ cores: 4, threads: 4, avx2: true, avx512: false, ram: [1600, 1600], gpus: [{ name: 'NVIDIA GeForce GTX 1060 6GB', vram: 6442450944 }] }), 'win32');
    expect(win).toMatchObject({ cores: 4, avx2: true, avx512: false, ramMts: 1600, ramModules: 2 });
    const linux = await probeOs(async () => null, 'linux', (f) => {
      if (f === '/proc/cpuinfo') return 'processor\t: 0\nphysical id\t: 0\ncpu cores\t: 8\nflags\t\t: fpu sse avx avx2 avx512f\n';
      throw new Error('no');
    });
    expect(linux).toMatchObject({ cores: 8, avx2: true, avx512: true });
    expect(await probeOs(async () => 'not json', 'win32')).toBeNull();
  });
});
