// Tokens per second measured on real machines (docs/BENCHMARKS.md, test/catalog/bench.mjs). When the GPU
// (or CPU) name matches, the recommendation uses these instead of the bandwidth estimate.
// { match: RegExp on "<gpu name>|<cpu name>", id: '<model>:<quant>', where: 'gpu' | 'partial' | 'cpu', ctx, tps }
//
// GTX 1060 6 GB, i5-4440, 16 GB DDR3-1600, node-llama-cpp 3.22.1 (Vulkan backend), October 2026.
// Q3_K_M is slow on this card (the Vulkan Q3_K kernels on Pascal), and 7B Q4_K_M does not fit next to a
// 4096 context: it spills into shared memory or keeps layers on the CPU, at 4 to 5 tokens/s.
const GTX1060 = /GTX\s*1060/i;

export const MEASURED = [
  { match: GTX1060, id: 'qwen2.5-coder-3b:Q4_K_M', where: 'gpu', ctx: 4096, tps: 48 },
  { match: GTX1060, id: 'qwen2.5-coder-3b:Q8_0', where: 'gpu', ctx: 4096, tps: 27.9 },
  { match: GTX1060, id: 'qwen2.5-coder-7b:Q3_K_M', where: 'gpu', ctx: 4096, tps: 8.7 },
  { match: GTX1060, id: 'qwen2.5-coder-7b:Q3_K_M', where: 'gpu', ctx: 8192, tps: 11.2 },
  { match: GTX1060, id: 'qwen2.5-coder-7b:IQ4_XS', where: 'gpu', ctx: 4096, tps: 20.6 },
  { match: GTX1060, id: 'qwen2.5-coder-7b:IQ4_XS', where: 'gpu', ctx: 8192, tps: 24.6 },
  { match: GTX1060, id: 'qwen2.5-coder-7b:Q4_K_M', where: 'partial', ctx: 4096, tps: 4 },
  { match: GTX1060, id: 'qwen2.5-coder-7b:Q4_K_M', where: 'partial', ctx: 8192, tps: 4.9 }
];

/**
 * Speed factors measured on one card and applied to its family when there is no direct measurement:
 * on the GTX 1060 (Pascal, Vulkan) Q3_K_M ran at 0.35 of the bandwidth estimate.
 */
export const QUANT_FACTORS = [
  { match: /GTX\s*10[5-8]0/i, quants: ['Q3_K_S', 'Q3_K_M'], factor: 0.35 }
];
