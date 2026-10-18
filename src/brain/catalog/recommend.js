// The recommendation engine: given the hardware, the context size and the task, rank every catalog
// entry by quality at a usable speed and say why. Pure (no I/O): the engine, the UI and the tests share it.
import { allPicks, needFor, qualityOf, loadCatalog } from './index.js';
import { estimateTps, speedClass, GPU_EFF, CPU_EFF } from './estimate.js';
import { MEASURED, QUANT_FACTORS } from './measured.js';

/** Memory bandwidth in GB/s by GPU name (longest names first so "3060 Ti" wins over "3060"). */
const GPU_BW = [
  [/GTX\s*1050\s*Ti/i, 112], [/GTX\s*1050/i, 112], [/GTX\s*1060/i, 192], [/GTX\s*1070\s*Ti/i, 256], [/GTX\s*1070/i, 256],
  [/GTX\s*1080\s*Ti/i, 484], [/GTX\s*1080/i, 320], [/GTX\s*1650/i, 128], [/GTX\s*1660\s*(Super|Ti)/i, 336], [/GTX\s*1660/i, 192],
  [/RTX\s*2060\s*Super/i, 448], [/RTX\s*2060/i, 336], [/RTX\s*2070/i, 448], [/RTX\s*2080\s*Ti/i, 616], [/RTX\s*2080/i, 448],
  [/RTX\s*3050/i, 224], [/RTX\s*3060\s*Ti/i, 448], [/RTX\s*3060/i, 360], [/RTX\s*3070/i, 448], [/RTX\s*3080\s*Ti/i, 912], [/RTX\s*3080/i, 760], [/RTX\s*3090/i, 936],
  [/RTX\s*4060\s*Ti/i, 288], [/RTX\s*4060/i, 272], [/RTX\s*4070\s*Ti/i, 504], [/RTX\s*4070/i, 504], [/RTX\s*4080/i, 717], [/RTX\s*4090/i, 1008],
  [/RTX\s*5060/i, 448], [/RTX\s*5070\s*Ti/i, 896], [/RTX\s*5070/i, 672], [/RTX\s*5080/i, 960], [/RTX\s*5090/i, 1792],
  [/RX\s*6600/i, 224], [/RX\s*6700/i, 384], [/RX\s*6800/i, 512], [/RX\s*6900/i, 512], [/RX\s*7600/i, 288], [/RX\s*7700/i, 432], [/RX\s*7800/i, 624], [/RX\s*7900/i, 960],
  [/Arc.*A7[57]0/i, 512], [/Arc.*B580/i, 456],
  [/M1\s*Ultra/i, 800], [/M1\s*Max/i, 400], [/M1\s*Pro/i, 200], [/M1\b/i, 68],
  [/M2\s*Ultra/i, 800], [/M2\s*Max/i, 400], [/M2\s*Pro/i, 200], [/M2\b/i, 100],
  [/M3\s*Ultra/i, 819], [/M3\s*Max/i, 400], [/M3\s*Pro/i, 150], [/M3\b/i, 100],
  [/M4\s*Max/i, 546], [/M4\s*Pro/i, 273], [/M4\b/i, 120]
];

export function gpuBandwidth(gpu) {
  if (!gpu) return 0;
  const name = `${gpu.name || ''} ${gpu.chip || ''}`;
  for (const [re, bw] of GPU_BW) if (re.test(name)) return bw * 1e9;
  const gb = (gpu.vramBytes || 0) / 1e9;
  return gpu.unified ? 100e9 : (30 * gb + 40) * 1e9;
}

/** CPU memory bandwidth: the RAM speed times two channels when the OS reports it, otherwise 20 GB/s. */
export function cpuBandwidth(hw) {
  if (hw.gpu?.unified) return gpuBandwidth(hw.gpu) * 0.6;
  const mts = hw.cpu?.ramMts;
  if (mts > 0) return mts * 1e6 * 8 * Math.min(Math.max(hw.cpu.ramModules || 2, 1), 2);
  return 20e9;
}

/** Physical cores the runtime should use. */
export function cpuCores(hw) {
  const c = hw.cpu?.cores;
  if (c > 0) return c;
  const t = hw.cpu?.threads || hw.cpus || 4;
  return t > 4 ? Math.ceil(t / 2) : t;
}

/** Tokens per second the CPU can compute regardless of bandwidth (matters on old and few core CPUs). */
export function cpuComputeCap(hw, activeParamsB) {
  const f = hw.cpu?.avx512 ? 1.5 : hw.cpu?.avx2 !== false ? 1 : 0.45;
  return (cpuCores(hw) * f * 6) / Math.max(activeParamsB, 0.3);
}

/** What part of the memory can hold a model. */
export function budgets(hw) {
  const ram = hw.ramBytes || 0;
  const gpu = hw.gpu && (hw.gpu.vramBytes || 0) >= 1.5e9 && hw.useGpu !== false ? hw.gpu : null;
  const unified = !!gpu?.unified;
  // Dedicated cards: 0.75 GB stay for the display and the driver. Measured on a GTX 1060 6 GB (Vulkan):
  // an estimate of 5.64 GB ran fully on the GPU, 5.71 GB spilled into shared memory at 4 tokens/s.
  const vram = gpu ? Math.max(0, gpu.vramBytes - (unified ? 1.0e9 : 0.75e9)) : 0;
  // On the CPU: leave room for the OS and the apps.
  const cpuRam = unified ? 0 : ram <= 8.5e9 ? Math.max(0, ram - 2.5e9) : ram <= 16.5e9 ? ram - 4e9 : ram * 0.75;
  return { gpu, unified, vram, cpuRam, disk: hw.diskFreeBytes ?? null };
}

const speedWeight = (tps) => (tps >= 15 ? 1 : tps >= 8 ? 0.93 : tps >= 5 ? 0.82 : tps >= 3 ? 0.62 : tps >= 1.5 ? 0.4 : 0.15);

const hwName = (hw) => `${hw.gpu?.name || ''}|${hw.cpu?.model || hw.cpuModel || ''}`;

/** True when this machine has direct measurements (then "faster" only promises measured speeds). */
export function isMeasured(hw) {
  const name = hwName(hw);
  return MEASURED.some((m) => m.match.test(name));
}

function quantFactor(hw, p) {
  const name = hw.gpu?.name || '';
  const f = QUANT_FACTORS.find((x) => x.quants.includes(p.quant) && x.match.test(name));
  return f ? f.factor : 1;
}

function measuredTps(hw, p, ctx, where) {
  const name = hwName(hw);
  for (const m of MEASURED) {
    if (m.where === where && m.id === p.id && m.ctx === ctx && m.match.test(name)) return m.tps;
  }
  return null;
}

/**
 * Where one entry would run and how fast.
 * @returns {{ where: 'gpu' | 'partial' | 'cpu' | 'none', gpuShare: number, need: number, tps: number, measured: boolean, why?: string }}
 */
export function placement(hw, p, ctx, b = budgets(hw)) {
  const need = needFor(p, ctx);
  const activeShare = p.activeParams ? p.activeParams / p.params : 1;
  const activeB = p.activeParams || p.params;
  const gpuBw = gpuBandwidth(b.gpu);
  const cpuBw = cpuBandwidth(hw);
  const eff = b.gpu?.backend === 'vulkan' ? GPU_EFF * 0.7 : GPU_EFF;
  const cap = cpuComputeCap(hw, activeB);
  // Full GPU, full CPU (bandwidth or compute bound, whichever is slower), and a split adds the two times.
  const gpuFull = gpuBw ? estimateTps({ bytes: p.bytes, activeShare, gpuShare: 1, gpuBandwidth: gpuBw, cpuBandwidth: cpuBw, gpuEff: eff }) * quantFactor(hw, p) : 0;
  const cpuFull = Math.min(estimateTps({ bytes: p.bytes, activeShare, gpuShare: 0, cpuBandwidth: cpuBw, cpuEff: CPU_EFF }), cap);
  const result = (where, gpuShare) => {
    const est = where === 'gpu' ? gpuFull : where === 'cpu' ? cpuFull : 1 / (gpuShare / gpuFull + (1 - gpuShare) / cpuFull);
    const m = measuredTps(hw, p, ctx, where);
    return { where, gpuShare, need, tps: Math.round((m ?? est) * 10) / 10, measured: m != null };
  };
  if (b.gpu && need <= b.vram) return result('gpu', 1);
  if (b.gpu && !b.unified) {
    const overhead = need - p.bytes;
    const share = (b.vram - overhead) / p.bytes;
    if (share >= 0.5 && p.bytes * (1 - share) + 1.5e9 <= Math.max(b.cpuRam, (hw.ramBytes || 0) - 4e9)) return result('partial', Math.min(share, 0.99));
  }
  if (!b.unified && need <= b.cpuRam) return result('cpu', 0);
  return { where: 'none', gpuShare: 0, need, tps: 0, measured: false };
}

/**
 * Ranks the catalog for this machine.
 * @param {object} hw  detectHardware() or a profile: { gpu, ramBytes, diskFreeBytes, cpu: { cores, threads, avx2, avx512, ramMts, ramModules } }
 * @param {{ ctx?: number, task?: 'coding' | 'reasoning' | 'chat' | 'general', installed?: string[], current?: string | null, catalog?: any, gpu?: boolean }} [opts]
 */
export function recommend(hw, opts = {}) {
  const ctx = opts.ctx || 4096;
  const task = opts.task || 'coding';
  const installed = new Set(opts.installed || []);
  const catalog = opts.catalog || loadCatalog();
  const b = budgets({ ...hw, useGpu: opts.gpu });
  const picks = allPicks(catalog).filter((p) => (p.contextLength || 4096) >= ctx);
  const ranked = [];
  for (const p of picks) {
    const pl = placement(hw, p, ctx, b);
    const quality = qualityOf(p, task);
    const fitsDisk = installed.has(p.id) || b.disk == null || p.bytes + 0.1e9 <= b.disk;
    // Thinking models write long hidden reasoning first: slower for crew turns that are not reasoning.
    const thinkingOnly = p.tasks.length === 1 && p.tasks[0] === 'reasoning' && task !== 'reasoning';
    const runnable = pl.where !== 'none' && fitsDisk && pl.tps >= 1;
    const score = runnable ? quality * speedWeight(pl.tps) * (thinkingOnly ? 0.85 : 1) * (pl.where === 'partial' ? 0.9 : 1) + (installed.has(p.id) ? 1.5 : 0) : 0;
    ranked.push({
      id: p.id, modelId: p.modelId, quant: p.quant, name: p.name, bytes: p.bytes, license: p.license.id,
      where: pl.where, gpuShare: pl.gpuShare, need: pl.need, tps: pl.tps, measured: pl.measured, speed: speedClass(pl.tps),
      quality, score: Math.round(score * 10) / 10, runnable, fitsDisk, giant: p.giant, installed: installed.has(p.id)
    });
  }
  ranked.sort((x, y) => y.score - x.score || y.quality - x.quality || x.bytes - y.bytes);
  const ok = ranked.filter((r) => r.runnable);
  const rec = ok[0] || null;
  const current = opts.current ? ranked.find((r) => r.id === opts.current) || null : null;
  let faster = null;
  let smarter = null;
  if (rec) {
    const fast = ok.filter((r) => r.id !== rec.id && r.tps >= rec.tps * 1.35 && r.quality >= rec.quality - 25);
    // On a machine we measured, "faster" only promises a measured speed when one qualifies.
    const pool = isMeasured(hw) && fast.some((r) => r.measured) ? fast.filter((r) => r.measured) : fast;
    faster = pool.sort((x, y) => y.score - x.score)[0] || null;
    smarter = ok.filter((r) => r.id !== rec.id && r.quality > rec.quality && r.tps >= 2).sort((x, y) => y.quality - x.quality || y.tps - x.tps)[0] || null;
  }
  const withWhy = (r) => (r ? { ...r, why: explain(hw, r, { ctx, b, against: current && current.id !== r.id ? current : r === rec ? null : rec }) } : null);
  return {
    ctx, task,
    hardware: summary(hw, b),
    recommended: withWhy(rec), faster: withWhy(faster), smarter: withWhy(smarter),
    current: current ? withWhy(current) : null,
    options: ranked,
    warning: !rec ? 'nothing_fits' : rec.quality < 35 ? 'basic' : null
  };
}

function summary(hw, b) {
  return {
    gpu: b.gpu ? { name: b.gpu.name, vramBytes: b.gpu.vramBytes, backend: b.gpu.backend || 'cuda', unified: !!b.gpu.unified, cuda: b.gpu.cuda || null } : null,
    usableVram: b.vram, usableRam: b.unified ? Math.max(0, (hw.ramBytes || 0) - 1e9) : b.cpuRam,
    ramBytes: hw.ramBytes || 0, diskFreeBytes: hw.diskFreeBytes ?? null,
    cpu: { model: hw.cpu?.model || hw.cpuModel || null, cores: cpuCores(hw), threads: hw.cpu?.threads || hw.cpus || null, avx2: hw.cpu?.avx2 ?? null, avx512: hw.cpu?.avx512 ?? null },
    gpuBandwidth: gpuBandwidth(b.gpu), cpuBandwidth: cpuBandwidth(hw)
  };
}

/**
 * Why, as structured parts the UI translates: { k, ...params }.
 *   fitsGpu { vram, ctx }  partial { share, ctx }  cpu { ram, cores, avx2 }  unified { ram, ctx }
 *   smarter { than }  faster { than, x }  installed  measured { tps }  estimated { tps }  license { id }
 */
export function explain(hw, r, { ctx, b = budgets(hw), against = null } = {}) {
  const why = [];
  if (r.where === 'gpu' && b.unified) why.push({ k: 'unified', ram: hw.ramBytes, ctx });
  else if (r.where === 'gpu') why.push({ k: 'fitsGpu', vram: b.gpu.vramBytes, need: r.need, ctx });
  else if (r.where === 'partial') why.push({ k: 'partial', share: Math.round(r.gpuShare * 100), ctx });
  else if (r.where === 'cpu') why.push({ k: 'cpu', ram: hw.ramBytes, cores: cpuCores(hw), avx2: hw.cpu?.avx2 ?? null, ctx });
  if (against) {
    if (r.quality > against.quality) why.push({ k: 'smarter', than: shortName(against) });
    if (r.tps > against.tps * 1.2) why.push({ k: 'faster', than: shortName(against), x: Math.round((r.tps / Math.max(against.tps, 0.1)) * 10) / 10 });
  }
  if (r.installed) why.push({ k: 'installed' });
  why.push({ k: r.measured ? 'measured' : 'estimated', tps: r.tps });
  return why;
}

/** "7B Q3_K_M" style short name. */
export function shortName(r) {
  const size = /(\d+(?:\.\d+)?b)(?:-a\d+b)?$/i.exec(r.modelId)?.[1]?.toUpperCase() || r.modelId;
  return `${size} ${r.quant}`;
}

/** One line in English for the terminal log. */
export function explainText(r) {
  if (!r) return 'no model fits this machine';
  const gb = (n) => `${(n / 1e9).toFixed(n >= 10e9 ? 0 : 1)} GB`;
  const parts = r.why.map((w) => {
    switch (w.k) {
      case 'fitsGpu': return `fits in the ${gb(w.vram)} of VRAM with a ${w.ctx} token context`;
      case 'unified': return `fits in the unified memory (${gb(w.ram)}) with a ${w.ctx} token context`;
      case 'partial': return `${w.share}% of the layers on the GPU, the rest on the CPU (slower)`;
      case 'cpu': return `runs on the CPU (${w.cores} cores${w.avx2 ? ', AVX2' : w.avx2 === false ? ', no AVX2' : ''}, ${gb(w.ram)} RAM)`;
      case 'smarter': return `smarter than ${w.than}`;
      case 'faster': return `${w.x}x faster than ${w.than}`;
      case 'installed': return 'already downloaded';
      case 'measured': return `${w.tps} tokens/s measured on this kind of machine`;
      case 'estimated': return `about ${w.tps} tokens/s (estimate)`;
      default: return '';
    }
  }).filter(Boolean);
  return `${shortName(r)} (${r.name}): ${parts.join('; ')}`;
}
