// The source list for the model catalog: which models, where their GGUF files live, the architecture
// numbers the VRAM estimate needs and the quality heuristic. refresh.mjs turns this into catalog.json
// with the exact files, sizes and SHA-256 read from the Hugging Face API.
//
// Only repositories of the model publishers or of well known quantizers are listed (TRUSTED below).
//
// Quality heuristic (0 to 100 per task, for the Q8_0 file): a rounded reading of the published model
// cards and public leaderboards (HumanEval, MBPP and LiveCodeBench for coding; MMLU, GSM8K and MATH for
// reasoning; MT-Bench and Arena style rankings for chat), scaled so that the best model in the catalog is
// near 90. It is a ranking aid, not a measurement. The quantization lowers it with QUANT_QUALITY, and small
// models lose more (see qualityFor in estimate.js).

/** Hugging Face owners whose GGUF files the catalog may link. */
export const TRUSTED = {
  Qwen: 'publisher',
  'ggml-org': 'publisher',
  microsoft: 'publisher',
  google: 'publisher',
  mistralai: 'publisher',
  'meta-llama': 'publisher',
  'ibm-granite': 'publisher',
  bartowski: 'quantizer',
  unsloth: 'quantizer',
  'lmstudio-community': 'quantizer',
  MaziyarPanahi: 'quantizer',
  TheBloke: 'quantizer'
};

/** The quantizations the catalog looks for, smallest first. */
export const QUANTS = ['Q2_K', 'IQ3_XS', 'Q3_K_S', 'Q3_K_M', 'IQ4_XS', 'Q4_K_S', 'Q4_K_M', 'Q5_K_M', 'Q6_K', 'Q8_0'];

/** Licenses: what to show before a download. */
export const LICENSES = {
  'apache-2.0': { name: 'Apache 2.0', url: 'https://www.apache.org/licenses/LICENSE-2.0', commercial: true },
  mit: { name: 'MIT', url: 'https://opensource.org/license/mit', commercial: true },
  'qwen-research': { name: 'Qwen Research License', commercial: false, notes: 'Research and non commercial use only.' },
  qwen: { name: 'Qwen License', commercial: true, notes: 'Commercial use allowed below 100 million monthly active users; above that a license from Alibaba is needed.' },
  'llama3.1': { name: 'Llama 3.1 Community License', url: 'https://www.llama.com/llama3_1/license/', commercial: true, notes: 'Accept the Meta license: attribution ("Built with Llama"), the acceptable use policy, and a separate license above 700 million monthly active users.' },
  'llama3.2': { name: 'Llama 3.2 Community License', url: 'https://www.llama.com/llama3_2/license/', commercial: true, notes: 'Accept the Meta license: attribution ("Built with Llama"), the acceptable use policy, and a separate license above 700 million monthly active users.' },
  'llama3.3': { name: 'Llama 3.3 Community License', url: 'https://www.llama.com/llama3_3/license/', commercial: true, notes: 'Accept the Meta license: attribution ("Built with Llama"), the acceptable use policy, and a separate license above 700 million monthly active users.' },
  gemma: { name: 'Gemma Terms of Use', url: 'https://ai.google.dev/gemma/terms', commercial: true, notes: 'Not an open source license: Google\'s Gemma Terms of Use and its prohibited use policy apply, and pass to anything you share that is built on it.' },
  deepseek: { name: 'DeepSeek License', url: 'https://github.com/deepseek-ai/DeepSeek-Coder/blob/main/LICENSE-MODEL', commercial: true, notes: 'Commercial use allowed with the use restrictions of the DeepSeek model license.' },
  mnpl: { name: 'Mistral AI Non-Production License', url: 'https://mistral.ai/licenses/MNPL-0.1.md', commercial: false, notes: 'Research and testing only: no production or commercial use without a license from Mistral AI.' },
  'bigcode-openrail-m': { name: 'BigCode OpenRAIL-M', url: 'https://huggingface.co/spaces/bigcode/bigcode-model-license-agreement', commercial: true, notes: 'Commercial use allowed with the use restrictions of the OpenRAIL-M license, which pass to what you share.' },
  'deepseek-license': { name: 'DeepSeek License', url: 'https://github.com/deepseek-ai/DeepSeek-Coder-V2/blob/main/LICENSE-MODEL', commercial: true, notes: 'Commercial use allowed with the use restrictions of the DeepSeek model license.' }
};

const QWEN_VOCAB = 151936;
const QWEN_VOCAB_L = 152064;

const qwenCoder = (size, arch, q, license = 'apache-2.0') => ({
  id: `qwen2.5-coder-${size.toLowerCase()}`, family: 'qwen2.5-coder', name: `Qwen2.5-Coder ${size} Instruct`,
  tasks: ['coding'], params: Number(size.replace('B', '')), arch: { type: 'qwen2', ...arch }, license,
  base: `Qwen/Qwen2.5-Coder-${size}-Instruct`, sources: [`Qwen/Qwen2.5-Coder-${size}-Instruct-GGUF`, `bartowski/Qwen2.5-Coder-${size}-Instruct-GGUF`], quality: q
});
const qwen = (size, arch, q, license = 'apache-2.0') => ({
  id: `qwen2.5-${size.toLowerCase()}`, family: 'qwen2.5', name: `Qwen2.5 ${size} Instruct`,
  tasks: ['general'], params: Number(size.replace('B', '')), arch: { type: 'qwen2', ...arch }, license,
  base: `Qwen/Qwen2.5-${size}-Instruct`, sources: [`Qwen/Qwen2.5-${size}-Instruct-GGUF`, `bartowski/Qwen2.5-${size}-Instruct-GGUF`], quality: q
});
const qwen3 = (size, arch, q) => ({
  id: `qwen3-${size.toLowerCase()}`, family: 'qwen3', name: `Qwen3 ${size}`,
  tasks: ['general', 'reasoning'], params: Number(size.replace('B', '')), arch: { type: 'qwen3', ...arch }, license: 'apache-2.0',
  base: `Qwen/Qwen3-${size}`, sources: [`Qwen/Qwen3-${size}-GGUF`, `bartowski/Qwen_Qwen3-${size}-GGUF`], quality: q,
  notes: 'A thinking model: hivedesk asks for structured answers, which keeps the thinking short.'
});
const bart = (id, family, name, repo, base, tasks, params, arch, license, q, extra = {}) => ({
  id, family, name, tasks, params, arch, license, base, sources: Array.isArray(repo) ? repo : [repo], quality: q, ...extra
});

const THINK = { notes: 'A thinking model: long answers, best for math and logic.' };
const VISION = 'Can also read images with its vision projector (a separate mmproj file); hivedesk sends text only for now.';

/**
 * arch: layers, kvHeads, headDim, vocab, ctx (the trained context length); kvBytesPerToken overrides the
 * K and V cache formula for attention layouts that do not fit it.
 * quality: { coding, reasoning, chat } for the Q8_0 file.
 */
export const FAMILIES = [
  // Coding
  qwenCoder('0.5B', { layers: 24, kvHeads: 2, headDim: 64, vocab: QWEN_VOCAB, ctx: 32768 }, { coding: 30, reasoning: 22, chat: 24 }),
  qwenCoder('1.5B', { layers: 28, kvHeads: 2, headDim: 128, vocab: QWEN_VOCAB, ctx: 32768 }, { coding: 46, reasoning: 34, chat: 34 }),
  qwenCoder('3B', { layers: 36, kvHeads: 2, headDim: 128, vocab: QWEN_VOCAB, ctx: 32768 }, { coding: 58, reasoning: 44, chat: 42 }, 'qwen-research'),
  qwenCoder('7B', { layers: 28, kvHeads: 4, headDim: 128, vocab: QWEN_VOCAB_L, ctx: 32768 }, { coding: 72, reasoning: 55, chat: 52 }),
  qwenCoder('14B', { layers: 48, kvHeads: 8, headDim: 128, vocab: QWEN_VOCAB_L, ctx: 32768 }, { coding: 80, reasoning: 65, chat: 60 }),
  qwenCoder('32B', { layers: 64, kvHeads: 8, headDim: 128, vocab: QWEN_VOCAB_L, ctx: 32768 }, { coding: 88, reasoning: 72, chat: 66 }),
  bart('qwen3-coder-30b-a3b', 'qwen3-coder', 'Qwen3-Coder 30B A3B Instruct', ['unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF', 'lmstudio-community/Qwen3-Coder-30B-A3B-Instruct-GGUF'], 'Qwen/Qwen3-Coder-30B-A3B-Instruct',
    ['coding'], 30.5, { type: 'qwen3moe', layers: 48, kvHeads: 4, headDim: 128, vocab: QWEN_VOCAB, ctx: 262144 }, 'apache-2.0', { coding: 89, reasoning: 72, chat: 68 },
    { activeParams: 3.3, notes: 'Mixture of experts: 30B weights, about 3B active per token, so it runs faster than its size suggests once it fits in memory.' }),
  bart('deepseek-coder-v2-lite', 'deepseek-coder-v2', 'DeepSeek-Coder-V2-Lite Instruct', 'bartowski/DeepSeek-Coder-V2-Lite-Instruct-GGUF', 'deepseek-ai/DeepSeek-Coder-V2-Lite-Instruct',
    ['coding'], 15.7, { type: 'deepseek2', layers: 27, kvHeads: 16, headDim: 128, vocab: 102400, ctx: 163840, kvBytesPerToken: 27 * (16 * 192 + 16 * 128) * 2 }, 'deepseek-license', { coding: 74, reasoning: 52, chat: 50 },
    { activeParams: 2.4, notes: 'Mixture of experts: 16B weights, about 2.4B active per token.' }),

  // General
  qwen('0.5B', { layers: 24, kvHeads: 2, headDim: 64, vocab: QWEN_VOCAB, ctx: 32768 }, { coding: 18, reasoning: 22, chat: 28 }),
  qwen('1.5B', { layers: 28, kvHeads: 2, headDim: 128, vocab: QWEN_VOCAB, ctx: 32768 }, { coding: 30, reasoning: 38, chat: 40 }),
  qwen('3B', { layers: 36, kvHeads: 2, headDim: 128, vocab: QWEN_VOCAB, ctx: 32768 }, { coding: 42, reasoning: 50, chat: 50 }, 'qwen-research'),
  qwen('7B', { layers: 28, kvHeads: 4, headDim: 128, vocab: QWEN_VOCAB_L, ctx: 32768 }, { coding: 58, reasoning: 64, chat: 62 }),
  qwen('14B', { layers: 48, kvHeads: 8, headDim: 128, vocab: QWEN_VOCAB_L, ctx: 32768 }, { coding: 66, reasoning: 72, chat: 68 }),
  qwen('32B', { layers: 64, kvHeads: 8, headDim: 128, vocab: QWEN_VOCAB_L, ctx: 32768 }, { coding: 74, reasoning: 78, chat: 72 }),
  qwen('72B', { layers: 80, kvHeads: 8, headDim: 128, vocab: QWEN_VOCAB_L, ctx: 32768 }, { coding: 78, reasoning: 84, chat: 78 }, 'qwen'),
  qwen3('4B', { layers: 36, kvHeads: 8, headDim: 128, vocab: QWEN_VOCAB, ctx: 32768 }, { coding: 55, reasoning: 62, chat: 56 }),
  qwen3('8B', { layers: 36, kvHeads: 8, headDim: 128, vocab: QWEN_VOCAB, ctx: 32768 }, { coding: 62, reasoning: 68, chat: 62 }),
  qwen3('14B', { layers: 40, kvHeads: 8, headDim: 128, vocab: QWEN_VOCAB, ctx: 32768 }, { coding: 70, reasoning: 74, chat: 68 }),
  qwen3('32B', { layers: 64, kvHeads: 8, headDim: 128, vocab: QWEN_VOCAB, ctx: 32768 }, { coding: 76, reasoning: 80, chat: 72 }),
  bart('qwen3-30b-a3b', 'qwen3', 'Qwen3 30B A3B', ['Qwen/Qwen3-30B-A3B-GGUF', 'bartowski/Qwen_Qwen3-30B-A3B-GGUF'], 'Qwen/Qwen3-30B-A3B',
    ['general', 'reasoning'], 30.5, { type: 'qwen3moe', layers: 48, kvHeads: 4, headDim: 128, vocab: QWEN_VOCAB, ctx: 32768 }, 'apache-2.0', { coding: 72, reasoning: 77, chat: 70 },
    { activeParams: 3.3, notes: 'Mixture of experts: about 3B active per token.' }),
  bart('llama-3.2-1b', 'llama-3.2', 'Llama 3.2 1B Instruct', 'bartowski/Llama-3.2-1B-Instruct-GGUF', 'meta-llama/Llama-3.2-1B-Instruct',
    ['general'], 1.24, { type: 'llama', layers: 16, kvHeads: 8, headDim: 64, vocab: 128256, ctx: 131072 }, 'llama3.2', { coding: 18, reasoning: 25, chat: 32 }),
  bart('llama-3.2-3b', 'llama-3.2', 'Llama 3.2 3B Instruct', 'bartowski/Llama-3.2-3B-Instruct-GGUF', 'meta-llama/Llama-3.2-3B-Instruct',
    ['general'], 3.21, { type: 'llama', layers: 28, kvHeads: 8, headDim: 128, vocab: 128256, ctx: 131072 }, 'llama3.2', { coding: 32, reasoning: 42, chat: 48 }),
  bart('llama-3.1-8b', 'llama-3.1', 'Llama 3.1 8B Instruct', 'bartowski/Meta-Llama-3.1-8B-Instruct-GGUF', 'meta-llama/Llama-3.1-8B-Instruct',
    ['general'], 8.03, { type: 'llama', layers: 32, kvHeads: 8, headDim: 128, vocab: 128256, ctx: 131072 }, 'llama3.1', { coding: 45, reasoning: 55, chat: 60 }),
  bart('llama-3.3-70b', 'llama-3.3', 'Llama 3.3 70B Instruct', 'bartowski/Llama-3.3-70B-Instruct-GGUF', 'meta-llama/Llama-3.3-70B-Instruct',
    ['general', 'reasoning'], 70.6, { type: 'llama', layers: 80, kvHeads: 8, headDim: 128, vocab: 128256, ctx: 131072 }, 'llama3.3', { coding: 70, reasoning: 82, chat: 80 }),
  bart('mistral-7b-v0.3', 'mistral', 'Mistral 7B Instruct v0.3', 'bartowski/Mistral-7B-Instruct-v0.3-GGUF', 'mistralai/Mistral-7B-Instruct-v0.3',
    ['general'], 7.25, { type: 'llama', layers: 32, kvHeads: 8, headDim: 128, vocab: 32768, ctx: 32768 }, 'apache-2.0', { coding: 30, reasoning: 45, chat: 52 }),
  bart('mistral-nemo-12b', 'mistral', 'Mistral Nemo 12B Instruct', 'bartowski/Mistral-Nemo-Instruct-2407-GGUF', 'mistralai/Mistral-Nemo-Instruct-2407',
    ['general'], 12.2, { type: 'llama', layers: 40, kvHeads: 8, headDim: 128, vocab: 131072, ctx: 131072 }, 'apache-2.0', { coding: 42, reasoning: 58, chat: 62 }),
  bart('mistral-small-24b', 'mistral', 'Mistral Small 24B Instruct 2501', 'bartowski/Mistral-Small-24B-Instruct-2501-GGUF', 'mistralai/Mistral-Small-24B-Instruct-2501',
    ['general', 'reasoning'], 23.6, { type: 'llama', layers: 40, kvHeads: 8, headDim: 128, vocab: 131072, ctx: 32768 }, 'apache-2.0', { coding: 64, reasoning: 72, chat: 70 }),
  bart('mixtral-8x7b', 'mixtral', 'Mixtral 8x7B Instruct v0.1', ['MaziyarPanahi/Mixtral-8x7B-Instruct-v0.1-GGUF', 'TheBloke/Mixtral-8x7B-Instruct-v0.1-GGUF'], 'mistralai/Mixtral-8x7B-Instruct-v0.1',
    ['general'], 46.7, { type: 'llama', layers: 32, kvHeads: 8, headDim: 128, vocab: 32000, ctx: 32768 }, 'apache-2.0', { coding: 42, reasoning: 62, chat: 64 },
    { activeParams: 12.9, notes: 'Mixture of experts: 47B weights, about 13B active per token.' }),
  bart('gemma-2-2b', 'gemma-2', 'Gemma 2 2B it', 'bartowski/gemma-2-2b-it-GGUF', 'google/gemma-2-2b-it',
    ['general'], 2.61, { type: 'gemma2', layers: 26, kvHeads: 4, headDim: 256, vocab: 256000, ctx: 8192 }, 'gemma', { coding: 22, reasoning: 38, chat: 45 }),
  bart('gemma-2-9b', 'gemma-2', 'Gemma 2 9B it', 'bartowski/gemma-2-9b-it-GGUF', 'google/gemma-2-9b-it',
    ['general'], 9.24, { type: 'gemma2', layers: 42, kvHeads: 8, headDim: 256, vocab: 256000, ctx: 8192 }, 'gemma', { coding: 42, reasoning: 62, chat: 64 }),
  bart('gemma-2-27b', 'gemma-2', 'Gemma 2 27B it', 'bartowski/gemma-2-27b-it-GGUF', 'google/gemma-2-27b-it',
    ['general'], 27.2, { type: 'gemma2', layers: 46, kvHeads: 16, headDim: 128, vocab: 256000, ctx: 8192 }, 'gemma', { coding: 52, reasoning: 70, chat: 70 }),
  bart('gemma-3-4b', 'gemma-3', 'Gemma 3 4B it', 'bartowski/google_gemma-3-4b-it-GGUF', 'google/gemma-3-4b-it',
    ['general', 'vision'], 3.88, { type: 'gemma3', layers: 34, kvHeads: 4, headDim: 256, vocab: 262144, ctx: 131072 }, 'gemma', { coding: 36, reasoning: 50, chat: 54 }, { notes: VISION }),
  bart('gemma-3-12b', 'gemma-3', 'Gemma 3 12B it', 'bartowski/google_gemma-3-12b-it-GGUF', 'google/gemma-3-12b-it',
    ['general', 'vision'], 11.8, { type: 'gemma3', layers: 48, kvHeads: 8, headDim: 256, vocab: 262144, ctx: 131072 }, 'gemma', { coding: 52, reasoning: 66, chat: 68 }, { notes: VISION }),
  bart('gemma-3-27b', 'gemma-3', 'Gemma 3 27B it', 'bartowski/google_gemma-3-27b-it-GGUF', 'google/gemma-3-27b-it',
    ['general', 'reasoning', 'vision'], 27.0, { type: 'gemma3', layers: 62, kvHeads: 16, headDim: 128, vocab: 262144, ctx: 131072 }, 'gemma', { coding: 62, reasoning: 74, chat: 74 }, { notes: VISION }),
  bart('phi-3.5-mini', 'phi', 'Phi-3.5 mini instruct', 'bartowski/Phi-3.5-mini-instruct-GGUF', 'microsoft/Phi-3.5-mini-instruct',
    ['general', 'reasoning'], 3.82, { type: 'phi3', layers: 32, kvHeads: 32, headDim: 96, vocab: 32064, ctx: 131072 }, 'mit', { coding: 45, reasoning: 55, chat: 48 }),
  bart('phi-4-mini', 'phi', 'Phi-4 mini instruct', 'bartowski/microsoft_Phi-4-mini-instruct-GGUF', 'microsoft/Phi-4-mini-instruct',
    ['general', 'reasoning'], 3.84, { type: 'phi3', layers: 32, kvHeads: 8, headDim: 128, vocab: 200064, ctx: 131072 }, 'mit', { coding: 50, reasoning: 58, chat: 50 }),
  bart('phi-4', 'phi', 'Phi-4 14B', 'bartowski/phi-4-GGUF', 'microsoft/phi-4',
    ['general', 'reasoning', 'coding'], 14.7, { type: 'phi3', layers: 40, kvHeads: 10, headDim: 128, vocab: 100352, ctx: 16384 }, 'mit', { coding: 66, reasoning: 75, chat: 62 }),
  bart('deepseek-r1-distill-qwen-7b', 'deepseek-r1-distill', 'DeepSeek-R1-Distill-Qwen 7B', 'bartowski/DeepSeek-R1-Distill-Qwen-7B-GGUF', 'deepseek-ai/DeepSeek-R1-Distill-Qwen-7B',
    ['reasoning'], 7.62, { type: 'qwen2', layers: 28, kvHeads: 4, headDim: 128, vocab: QWEN_VOCAB_L, ctx: 131072 }, 'mit', { coding: 45, reasoning: 62, chat: 40 },
    { notes: 'A thinking model: long answers, best for math and logic.' }),
  bart('deepseek-r1-distill-qwen-14b', 'deepseek-r1-distill', 'DeepSeek-R1-Distill-Qwen 14B', 'bartowski/DeepSeek-R1-Distill-Qwen-14B-GGUF', 'deepseek-ai/DeepSeek-R1-Distill-Qwen-14B',
    ['reasoning'], 14.8, { type: 'qwen2', layers: 48, kvHeads: 8, headDim: 128, vocab: QWEN_VOCAB_L, ctx: 131072 }, 'mit', { coding: 58, reasoning: 72, chat: 50 },
    { notes: 'A thinking model: long answers, best for math and logic.' }),
  bart('deepseek-r1-distill-qwen-32b', 'deepseek-r1-distill', 'DeepSeek-R1-Distill-Qwen 32B', 'bartowski/DeepSeek-R1-Distill-Qwen-32B-GGUF', 'deepseek-ai/DeepSeek-R1-Distill-Qwen-32B',
    ['reasoning'], 32.8, { type: 'qwen2', layers: 64, kvHeads: 8, headDim: 128, vocab: QWEN_VOCAB_L, ctx: 131072 }, 'mit', { coding: 68, reasoning: 80, chat: 56 },
    { notes: 'A thinking model: long answers, best for math and logic.' }),
  bart('granite-3.3-8b', 'granite', 'Granite 3.3 8B Instruct', 'bartowski/ibm-granite_granite-3.3-8b-instruct-GGUF', 'ibm-granite/granite-3.3-8b-instruct',
    ['general'], 8.17, { type: 'granite', layers: 40, kvHeads: 8, headDim: 128, vocab: 49159, ctx: 131072 }, 'apache-2.0', { coding: 48, reasoning: 55, chat: 55 }),

  // Small and fast
  bart('qwen3-0.6b', 'qwen3', 'Qwen3 0.6B', ['Qwen/Qwen3-0.6B-GGUF', 'bartowski/Qwen_Qwen3-0.6B-GGUF'], 'Qwen/Qwen3-0.6B',
    ['general'], 0.6, { type: 'qwen3', layers: 28, kvHeads: 8, headDim: 128, vocab: QWEN_VOCAB, ctx: 32768 }, 'apache-2.0', { coding: 22, reasoning: 30, chat: 30 }),
  bart('qwen3-1.7b', 'qwen3', 'Qwen3 1.7B', ['Qwen/Qwen3-1.7B-GGUF', 'bartowski/Qwen_Qwen3-1.7B-GGUF'], 'Qwen/Qwen3-1.7B',
    ['general', 'reasoning'], 1.7, { type: 'qwen3', layers: 28, kvHeads: 8, headDim: 128, vocab: QWEN_VOCAB, ctx: 32768 }, 'apache-2.0', { coding: 40, reasoning: 48, chat: 44 }),
  bart('gemma-3-1b', 'gemma-3', 'Gemma 3 1B it', 'bartowski/google_gemma-3-1b-it-GGUF', 'google/gemma-3-1b-it',
    ['general'], 1.0, { type: 'gemma3', layers: 26, kvHeads: 1, headDim: 256, vocab: 262144, ctx: 32768 }, 'gemma', { coding: 18, reasoning: 30, chat: 38 }),
  bart('smollm2-1.7b', 'smollm', 'SmolLM2 1.7B Instruct', 'bartowski/SmolLM2-1.7B-Instruct-GGUF', 'HuggingFaceTB/SmolLM2-1.7B-Instruct',
    ['general'], 1.7, { type: 'llama', layers: 24, kvHeads: 32, headDim: 64, vocab: 49152, ctx: 8192 }, 'apache-2.0', { coding: 20, reasoning: 32, chat: 40 }),
  bart('granite-3.3-2b', 'granite', 'Granite 3.3 2B Instruct', 'bartowski/ibm-granite_granite-3.3-2b-instruct-GGUF', 'ibm-granite/granite-3.3-2b-instruct',
    ['general'], 2.5, { type: 'granite', layers: 40, kvHeads: 8, headDim: 64, vocab: 49159, ctx: 131072 }, 'apache-2.0', { coding: 34, reasoning: 42, chat: 44 }),

  // More coding
  bart('yi-coder-9b', 'yi-coder', 'Yi-Coder 9B Chat', 'bartowski/Yi-Coder-9B-Chat-GGUF', '01-ai/Yi-Coder-9B-Chat',
    ['coding'], 8.83, { type: 'llama', layers: 48, kvHeads: 4, headDim: 128, vocab: 64000, ctx: 131072 }, 'apache-2.0', { coding: 70, reasoning: 45, chat: 42 }),
  bart('deepseek-coder-6.7b', 'deepseek-coder', 'DeepSeek-Coder 6.7B Instruct', 'TheBloke/deepseek-coder-6.7B-instruct-GGUF', 'deepseek-ai/deepseek-coder-6.7b-instruct',
    ['coding'], 6.74, { type: 'llama', layers: 32, kvHeads: 32, headDim: 128, vocab: 32256, ctx: 16384 }, 'deepseek', { coding: 60, reasoning: 35, chat: 32 }),
  bart('codestral-22b', 'codestral', 'Codestral 22B v0.1', 'bartowski/Codestral-22B-v0.1-GGUF', 'mistralai/Codestral-22B-v0.1',
    ['coding'], 22.2, { type: 'llama', layers: 56, kvHeads: 8, headDim: 128, vocab: 32768, ctx: 32768 }, 'mnpl', { coding: 76, reasoning: 55, chat: 52 }),
  bart('starcoder2-15b', 'starcoder2', 'StarCoder2 15B Instruct', 'bartowski/starcoder2-15b-instruct-v0.1-GGUF', 'bigcode/starcoder2-15b-instruct-v0.1',
    ['coding'], 16.0, { type: 'starcoder2', layers: 40, kvHeads: 4, headDim: 128, vocab: 49152, ctx: 16384 }, 'bigcode-openrail-m', { coding: 66, reasoning: 38, chat: 34 }),
  bart('devstral-small-24b', 'devstral', 'Devstral Small 24B (2505)', 'bartowski/mistralai_Devstral-Small-2505-GGUF', 'mistralai/Devstral-Small-2505',
    ['coding'], 23.6, { type: 'llama', layers: 40, kvHeads: 8, headDim: 128, vocab: 131072, ctx: 131072 }, 'apache-2.0', { coding: 82, reasoning: 66, chat: 60 },
    { notes: 'Made for coding agents that edit many files.' }),

  // More reasoning and general
  bart('qwq-32b', 'qwq', 'QwQ 32B', 'bartowski/Qwen_QwQ-32B-GGUF', 'Qwen/QwQ-32B',
    ['reasoning'], 32.8, { type: 'qwen2', layers: 64, kvHeads: 8, headDim: 128, vocab: QWEN_VOCAB_L, ctx: 32768 }, 'apache-2.0', { coding: 74, reasoning: 86, chat: 64 }, THINK),
  bart('deepseek-r1-distill-llama-8b', 'deepseek-r1-distill', 'DeepSeek-R1-Distill-Llama 8B', 'bartowski/DeepSeek-R1-Distill-Llama-8B-GGUF', 'deepseek-ai/DeepSeek-R1-Distill-Llama-8B',
    ['reasoning'], 8.03, { type: 'llama', layers: 32, kvHeads: 8, headDim: 128, vocab: 128256, ctx: 131072 }, 'mit', { coding: 46, reasoning: 64, chat: 44 }, THINK),
  bart('phi-4-reasoning', 'phi', 'Phi-4 reasoning 14B', 'bartowski/microsoft_Phi-4-reasoning-GGUF', 'microsoft/Phi-4-reasoning',
    ['reasoning'], 14.7, { type: 'phi3', layers: 40, kvHeads: 10, headDim: 128, vocab: 100352, ctx: 32768 }, 'mit', { coding: 68, reasoning: 82, chat: 56 }, THINK),
  bart('mistral-small-3.2-24b', 'mistral', 'Mistral Small 3.2 24B Instruct', 'bartowski/mistralai_Mistral-Small-3.2-24B-Instruct-2506-GGUF', 'mistralai/Mistral-Small-3.2-24B-Instruct-2506',
    ['general', 'reasoning', 'vision'], 24.0, { type: 'llama', layers: 40, kvHeads: 8, headDim: 128, vocab: 131072, ctx: 131072 }, 'apache-2.0', { coding: 70, reasoning: 75, chat: 74 }, { notes: VISION }),

  // Vision
  bart('qwen2.5-vl-3b', 'qwen2.5-vl', 'Qwen2.5-VL 3B Instruct', 'ggml-org/Qwen2.5-VL-3B-Instruct-GGUF', 'Qwen/Qwen2.5-VL-3B-Instruct',
    ['general', 'vision'], 3.75, { type: 'qwen2vl', layers: 36, kvHeads: 2, headDim: 128, vocab: QWEN_VOCAB, ctx: 32768 }, 'qwen-research', { coding: 36, reasoning: 44, chat: 46 }, { notes: VISION }),
  bart('qwen2.5-vl-7b', 'qwen2.5-vl', 'Qwen2.5-VL 7B Instruct', ['ggml-org/Qwen2.5-VL-7B-Instruct-GGUF', 'bartowski/Qwen_Qwen2.5-VL-7B-Instruct-GGUF'], 'Qwen/Qwen2.5-VL-7B-Instruct',
    ['general', 'vision'], 8.29, { type: 'qwen2vl', layers: 28, kvHeads: 4, headDim: 128, vocab: QWEN_VOCAB_L, ctx: 32768 }, 'apache-2.0', { coding: 52, reasoning: 58, chat: 60 }, { notes: VISION })
];
