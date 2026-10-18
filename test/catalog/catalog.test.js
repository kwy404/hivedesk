// The stored catalog (src/brain/catalog/catalog.json) and the estimates. No network: the JSON was
// fetched from the Hugging Face API by refresh.mjs and is validated here as it is.
import { describe, it, expect } from 'vitest';
import { loadCatalog, validateCatalog, pick, resolvePick, allPicks, needFor } from '../../src/brain/catalog/index.js';
import { kvBytesPerToken, memoryNeed, qualityFor, QUANT_QUALITY, GIANT_VRAM, speedClass, estimateTps } from '../../src/brain/catalog/estimate.js';
import { FAMILIES, TRUSTED, QUANTS } from '../../src/brain/catalog/families.js';
import { findQuant } from '../../src/brain/catalog/refresh.mjs';
import { MODELS } from '../../src/brain/models.js';

const c = loadCatalog();
const GB = 1e9;

describe('model catalog', () => {
  it('is valid: ids, licenses, trusted repos at a pinned revision, sizes, SHA-256 and VRAM tables', () => {
    expect(validateCatalog(c)).toEqual([]);
  });

  it('covers every family in families.js and the Qwen2.5-Coder sizes from 0.5B to 32B', () => {
    expect(c.models.map((m) => m.id)).toEqual(FAMILIES.map((f) => f.id));
    for (const s of ['0.5b', '1.5b', '3b', '7b', '14b', '32b']) expect(c.models.find((m) => m.id === `qwen2.5-coder-${s}`)).toBeTruthy();
    for (const fam of ['qwen2.5', 'qwen3', 'llama-3.2', 'llama-3.1', 'llama-3.3', 'mistral', 'mixtral', 'gemma-2', 'gemma-3', 'phi', 'deepseek-coder-v2', 'deepseek-r1-distill', 'granite', 'qwen3-coder']) {
      expect(c.models.some((m) => m.family === fam), fam).toBe(true);
    }
    expect(c.models.length).toBeGreaterThanOrEqual(55);
    expect(allPicks(c).length).toBeGreaterThanOrEqual(520);
  });

  it('has the quantizations, including the IQ ones where they exist', () => {
    const coder7 = c.models.find((m) => m.id === 'qwen2.5-coder-7b');
    expect(coder7.variants.map((v) => v.quant)).toEqual(QUANTS);
    for (const m of c.models) expect(m.variants.some((v) => v.quant === 'Q4_K_M'), m.id).toBe(true);
    expect(c.models.filter((m) => m.variants.some((v) => v.quant === 'IQ4_XS')).length).toBeGreaterThan(30);
    // smallest first, and a bigger quantization is a bigger file
    for (const m of c.models) {
      const order = m.variants.map((v) => QUANTS.indexOf(v.quant));
      expect([...order].sort((a, b) => a - b)).toEqual(order);
    }
  });

  it('keeps the official Qwen files and checksums the 0.1 table used', () => {
    for (const legacy of MODELS) {
      const p = pick(legacy.id, 'Q4_K_M');
      expect(p.files).toHaveLength(1);
      expect(p.files[0].sha256).toBe(legacy.sha256);
      expect(p.bytes).toBe(legacy.bytes);
      expect(p.repo).toBe(legacy.repo);
    }
  });

  it('links only publishers and well known quantizers, and shows the licenses that need care', () => {
    for (const m of c.models) for (const v of m.variants) expect(TRUSTED[v.repo.split('/')[0]], v.repo).toBeTruthy();
    const gemma = c.models.filter((m) => m.family.startsWith('gemma'));
    expect(gemma.length).toBe(7);
    expect(c.models.find((m) => m.id === 'codestral-22b').license).toMatchObject({ id: 'mnpl', commercial: false });
    expect(c.models.filter((m) => m.tasks.includes('vision')).length).toBeGreaterThanOrEqual(5);
    for (const g of gemma) { expect(g.license.id).toBe('gemma'); expect(g.license.notes).toMatch(/Gemma Terms of Use/); }
    for (const m of c.models.filter((x) => x.family.startsWith('llama'))) expect(m.license.notes).toMatch(/Meta license/);
    expect(c.models.find((m) => m.id === 'qwen2.5-coder-3b').license).toMatchObject({ id: 'qwen-research', commercial: false });
    expect(c.models.find((m) => m.id === 'qwen2.5-72b').license.id).toBe('qwen');
  });

  it('flags the giant models: 32B Q4 and the 70B class, not 7B or 14B', () => {
    const giant = (id) => c.models.find((m) => m.id === id).giant;
    for (const id of ['qwen2.5-coder-32b', 'qwen2.5-32b', 'qwen2.5-72b', 'llama-3.3-70b', 'mixtral-8x7b', 'qwen3-32b']) expect(giant(id), id).toBe(true);
    for (const id of ['qwen2.5-coder-7b', 'qwen2.5-coder-14b', 'llama-3.1-8b', 'phi-4']) expect(giant(id), id).toBe(false);
    const p = pick('qwen2.5-coder-32b', 'Q4_K_M');
    expect(needFor(p, 4096)).toBeGreaterThan(20 * GB);
    expect(pick('llama-3.3-70b', 'Q4_K_M').files.length).toBeGreaterThanOrEqual(1);
    // the 70B Q8_0 file is split into parts, all checksummed
    const big = pick('llama-3.3-70b', 'Q8_0');
    expect(big.files.length).toBeGreaterThan(1);
    expect(big.bytes).toBe(big.files.reduce((n, f) => n + f.bytes, 0));
    expect(big.sha256).toBeNull();
  });

  it('resolves names: id:quant, the bare id (Q4_K_M), and a known file name', () => {
    expect(resolvePick('qwen2.5-coder-7b:q3_k_m').id).toBe('qwen2.5-coder-7b:Q3_K_M');
    expect(resolvePick('qwen2.5-coder-7b').quant).toBe('Q4_K_M');
    expect(resolvePick('qwen2.5-coder-3b-instruct-q4_k_m.gguf').id).toBe('qwen2.5-coder-3b:Q4_K_M');
    expect(resolvePick('nope:Q4_K_M')).toBeNull();
    expect(resolvePick('')).toBeNull();
  });

  it('refresh finds single files before split ones and rejects UD and mmproj files', () => {
    const f = (path) => ({ path, lfs: { oid: 'x', size: 1 } });
    const files = [f('m-q4_k_m-00001-of-00002.gguf'), f('m-q4_k_m-00002-of-00002.gguf'), f('m-q4_k_m.gguf'), f('m-UD-Q2_K_XL.gguf'), f('mmproj-Q8_0.gguf'), f('m-Q2_K_L.gguf'), f('x/m-Q8_0-00001-of-00002.gguf'), f('x/m-Q8_0-00002-of-00002.gguf')];
    expect(findQuant(files, 'Q4_K_M').map((x) => x.path)).toEqual(['m-q4_k_m.gguf']);
    expect(findQuant(files, 'Q2_K')).toBeNull();
    expect(findQuant(files, 'Q8_0').map((x) => x.path)).toEqual(['x/m-Q8_0-00001-of-00002.gguf', 'x/m-Q8_0-00002-of-00002.gguf']);
    expect(findQuant([f('a-Q6_K-00001-of-00003.gguf')], 'Q6_K')).toBeNull();
  });
});

describe('VRAM and quality estimates', () => {
  const coder7 = c.models.find((m) => m.id === 'qwen2.5-coder-7b');

  it('computes the K and V cache from the architecture', () => {
    expect(kvBytesPerToken(coder7.arch)).toBe(2 * 28 * 4 * 128 * 2);
    const ds = c.models.find((m) => m.id === 'deepseek-coder-v2-lite');
    expect(kvBytesPerToken(ds.arch)).toBe(27 * (16 * 192 + 16 * 128) * 2);
  });

  it('adds weights, the cache for the context, compute and the runtime reserve', () => {
    const p = pick('qwen2.5-coder-7b', 'Q4_K_M');
    const n4 = memoryNeed(p.arch, p.bytes, 4096);
    const n8 = memoryNeed(p.arch, p.bytes, 8192);
    expect(n4).toBeGreaterThan(p.bytes + 0.5 * GB);
    expect(n4).toBeLessThan(6 * GB);
    expect(n8 - n4).toBe(Math.round(kvBytesPerToken(p.arch) * 4096 + 4096 * 40e3));
    // the stored table is the same formula
    const v = coder7.variants.find((x) => x.quant === 'Q4_K_M');
    expect(v.vram['4096']).toBe(n4);
    expect(Object.keys(v.vram)).toEqual(['2048', '4096', '8192', '16384', '32768']);
    // only up to the trained context
    expect(Object.keys(c.models.find((m) => m.id === 'gemma-2-9b').variants[0].vram)).toEqual(['2048', '4096', '8192']);
    expect(GIANT_VRAM).toBe(16 * GB);
  });

  it('lowers quality with the quantization, and more for small models', () => {
    const m = { quality: { coding: 80, reasoning: 60, chat: 50 }, params: 14 };
    const order = ['Q2_K', 'Q3_K_S', 'Q3_K_M', 'Q4_K_M', 'Q5_K_M', 'Q6_K', 'Q8_0'].map((q) => qualityFor(m, q, 'coding'));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(qualityFor(m, 'Q8_0', 'coding')).toBe(80);
    const small = { ...m, params: 1.5 };
    expect(80 - qualityFor(small, 'Q2_K', 'coding')).toBeGreaterThan(80 - qualityFor(m, 'Q2_K', 'coding'));
    expect(Object.keys(QUANT_QUALITY).sort()).toEqual([...QUANTS].sort());
  });

  it('estimates speed from bandwidth and splits time between GPU and CPU', () => {
    const full = estimateTps({ bytes: 4e9, gpuShare: 1, gpuBandwidth: 200e9, cpuBandwidth: 20e9, gpuEff: 0.5 });
    expect(full).toBeCloseTo(25, 5);
    const half = estimateTps({ bytes: 4e9, gpuShare: 0.5, gpuBandwidth: 200e9, cpuBandwidth: 20e9, gpuEff: 0.5, cpuEff: 0.5 });
    expect(half).toBeLessThan(full / 4);
    const moe = estimateTps({ bytes: 4e9, activeShare: 0.1, gpuShare: 0, cpuBandwidth: 20e9, cpuEff: 0.5 });
    expect(moe).toBeCloseTo(25, 5);
    expect([speedClass(30), speedClass(12), speedClass(5), speedClass(1), speedClass(0)]).toEqual(['fast', 'good', 'slow', 'very_slow', 'unknown']);
  });
});
