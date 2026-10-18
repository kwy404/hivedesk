// Pure estimates for the catalog: memory needed per context size, quality per quantization, speed.
// No imports, no I/O, so the refresh script, the engine, the browser and the tests share the same math.
//
// Memory (VRAM on a GPU, RAM on the CPU) = weights + K and V cache + compute buffers + runtime reserve.
//   weights:  the GGUF file size (all parts).
//   KV cache: 2 (K and V) x layers x KV heads x head size x 2 bytes (f16) per token, times the context.
//   compute:  120 MB + the logits buffer (vocab x 512 batch x 4 bytes, halved: it is reused) + 40 KB per
//             context token (attention scratch). Calibrated against llama.cpp CUDA logs for Qwen2.5 7B.
//   reserve:  350 MB for the CUDA, Vulkan or Metal context itself.
// Checked on a GTX 1060 6 GB (6.44e9 bytes): Qwen2.5-Coder 7B Q4_K_M fits fully with 4096 tokens and
// not with 8192, which is what the runtime does (docs/BENCHMARKS.md).

export const GB = 1e9;
export const CONTEXTS = [2048, 4096, 8192, 16384, 32768];
export const RUNTIME_RESERVE = 0.35e9;
/** A variant is "giant" when it needs more than this at 4096 tokens: more than the 6 to 16 GB that typical single consumer GPUs have. */
export const GIANT_VRAM = 16e9;

/**
 * Share of quality kept by each quantization, from the llama.cpp perplexity and KL divergence tables
 * (Q8_0 is close to the f16 model). Small models lose more, see qualityFor.
 */
export const QUANT_QUALITY = {
  Q8_0: 1.0, Q6_K: 0.995, Q5_K_M: 0.985, Q4_K_M: 0.97, Q4_K_S: 0.96, IQ4_XS: 0.96,
  Q3_K_M: 0.92, IQ3_XS: 0.89, Q3_K_S: 0.885, Q2_K: 0.8
};

/** Bits per weight, for display and for sorting. */
export const QUANT_BITS = { Q2_K: 2.6, IQ3_XS: 3.3, Q3_K_S: 3.5, Q3_K_M: 3.9, IQ4_XS: 4.25, Q4_K_S: 4.6, Q4_K_M: 4.85, Q5_K_M: 5.7, Q6_K: 6.6, Q8_0: 8.5 };

export function kvBytesPerToken(arch) {
  return arch.kvBytesPerToken || 2 * arch.layers * arch.kvHeads * arch.headDim * 2;
}

export function computeBytes(arch, ctx) {
  return 0.12e9 + (arch.vocab || 150000) * 512 * 4 * 0.5 + ctx * 40e3;
}

/** Bytes of VRAM (or RAM on the CPU) needed to run a file of `bytes` with `ctx` tokens of context. */
export function memoryNeed(arch, bytes, ctx) {
  return Math.round(bytes + kvBytesPerToken(arch) * ctx + computeBytes(arch, ctx) + RUNTIME_RESERVE);
}

/** { "2048": bytes, ... } up to the trained context of the model. */
export function vramTable(arch, bytes) {
  const out = {};
  for (const c of CONTEXTS) if (c <= (arch.ctx || 4096)) out[String(c)] = memoryNeed(arch, bytes, c);
  return out;
}

/** Quality 0 to 100 for a task ('coding', 'reasoning', 'chat'), lowered by the quantization. */
export function qualityFor(model, quant, task) {
  const base = model.quality?.[task] ?? model.quality?.chat ?? 0;
  const keep = QUANT_QUALITY[quant] ?? 0.9;
  const p = model.params || 7;
  const sizeFactor = p < 3 ? 1.6 : p < 8 ? 1.2 : p < 20 ? 1.0 : 0.8;
  return Math.max(0, Math.round(base * (1 - (1 - keep) * sizeFactor)));
}

/** Coarse class from the parameters used per token. */
export function staticSpeedClass(model) {
  const a = model.activeParams || model.params;
  return a <= 4 ? 'fast' : a <= 9 ? 'medium' : a <= 16 ? 'slow' : 'very_slow';
}

/** Class from an estimated or measured tokens per second while writing. */
export function speedClass(tps) {
  if (!(tps > 0)) return 'unknown';
  return tps >= 25 ? 'fast' : tps >= 10 ? 'good' : tps >= 4 ? 'slow' : 'very_slow';
}

/**
 * Tokens per second while writing. Generation reads every active weight once per token, so it is bound by
 * memory bandwidth: tps = efficiency x bandwidth / active bytes. With layers split between the GPU and the
 * CPU, the two times add up. Efficiencies calibrated on the GTX 1060 and the i5-4440 (docs/BENCHMARKS.md).
 * @param {{ bytes: number, activeShare?: number, gpuShare?: number, gpuBandwidth?: number, cpuBandwidth: number, gpuEff?: number, cpuEff?: number }} o
 */
export function estimateTps(o) {
  const active = o.bytes * (o.activeShare ?? 1);
  const g = Math.max(0, Math.min(1, o.gpuShare ?? 0));
  const gpuT = g > 0 && o.gpuBandwidth ? (active * g) / (o.gpuBandwidth * (o.gpuEff ?? GPU_EFF)) : 0;
  const cpuT = g < 1 ? (active * (1 - g)) / (o.cpuBandwidth * (o.cpuEff ?? CPU_EFF)) : 0;
  const t = gpuT + cpuT;
  return t > 0 ? 1 / t : 0;
}

export const GPU_EFF = 0.5;
// On the i5-4440 (DDR3-1600, two channels, 25.6 GB/s) Qwen2.5-Coder 1.5B Q4_K_M wrote 6.5 tokens/s on the
// CPU through llama.cpp: about 7 GB/s read per second, 0.28 of the bandwidth (docs/BENCHMARKS.md).
export const CPU_EFF = 0.35;
