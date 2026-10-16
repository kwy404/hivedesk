// Local brain: node-llama-cpp with a GGUF file. Every schema becomes a grammar, so even small models
// always answer with a valid tool call.
import fs from 'node:fs';
import os from 'node:os';
import { simplifySchema, validate, extractJson } from './schema.js';

/** Size of a GGUF file, adding the other parts of a split model (name-00001-of-00003.gguf). */
export function fileSize(file) {
  let total = 0;
  try { total = fs.statSync(file).size; } catch { return 0; }
  const m = file.match(/^(.*-)(\d{5})-of-(\d{5})\.gguf$/i);
  if (m) {
    total = 0;
    for (let i = 1; i <= Number(m[3]); i++) {
      try { total += fs.statSync(`${m[1]}${String(i).padStart(5, '0')}-of-${m[3]}.gguf`).size; } catch { /* missing part */ }
    }
  }
  return total;
}

/** Free RAM needed before a load: little when the weights go to the GPU (memory mapped), the whole file plus room on the CPU. */
export function ramNeeded(fileBytes, gpu) {
  return gpu ? 2.5e9 : Math.max(4e9, fileBytes + 1.5e9);
}

export class MemoryError extends Error {
  constructor(message, hint) {
    super(message);
    this.code = 'no_memory';
    this.hint = hint;
  }
}

/**
 * GPU first: as many layers on the GPU as fit next to the context (fitContext), weights memory mapped,
 * and a free RAM check before anything is loaded, so a model never pushes the machine into swap.
 * @param {{
 *   mod: any,                      the imported node-llama-cpp module
 *   modelPath: string,
 *   gpu?: boolean,                 false forces the CPU
 *   contextSize?: number,          default 4096
 *   id?: string, name?: string,
 *   minGpuShare?: number,          fail (so the caller can fall back) when fewer layers than this share fit on the GPU; default 0.5
 *   freeMem?: () => number,
 *   onLoadProgress?: (p: number) => void
 * }} opts
 */
export async function createLocalBrain(opts) {
  const { getLlama, LlamaChat, LlamaLogLevel } = opts.mod;
  const gpuWanted = opts.gpu !== false;
  const ctxSize = opts.contextSize || 4096;
  const fileBytes = fileSize(opts.modelPath);
  const free = (opts.freeMem || os.freemem)();
  const need = ramNeeded(fileBytes, gpuWanted);
  if (free < need) {
    throw new MemoryError(`Not enough free RAM to load the model: ${(free / 1e9).toFixed(1)} GB free, ${(need / 1e9).toFixed(1)} GB needed.`,
      'Close some apps and press Retry, or use a smaller model, or Ollama or LM Studio.');
  }
  const llama = await getLlama({ gpu: gpuWanted ? 'auto' : false, logLevel: LlamaLogLevel?.error ?? 'error', build: 'never' })
    .catch(async (err) => {
      // No prebuilt binary for this GPU: let the runtime pick, which may build or fall back.
      if (!gpuWanted) throw err;
      return getLlama({ gpu: 'auto', logLevel: LlamaLogLevel?.error ?? 'error' });
    });
  if (gpuWanted && !llama.gpu) {
    await llama.dispose?.();
    throw new Error('no GPU backend (CUDA, Vulkan or Metal) could be loaded');
  }
  const model = await llama.loadModel({
    modelPath: opts.modelPath,
    gpuLayers: gpuWanted ? { fitContext: { contextSize: ctxSize } } : 0,
    useMmap: true,
    onLoadProgress: opts.onLoadProgress
  });
  const totalLayers = (model.fileInfo?.architectureMetadata?.block_count ?? 0) + 1;
  if (gpuWanted && totalLayers > 1 && model.gpuLayers < totalLayers * (opts.minGpuShare ?? 0.5)) {
    const got = model.gpuLayers;
    await model.dispose();
    await llama.dispose?.();
    throw new Error(`only ${got} of ${totalLayers} layers fit on the GPU`);
  }
  const context = await model.createContext({ contextSize: ctxSize });
  const sequence = context.getSequence();
  const grammars = new Map();
  const backend = llama.gpu || 'cpu';
  const name = opts.name || opts.modelPath.split(/[\\/]/).pop();

  async function grammarFor(schema) {
    const key = JSON.stringify(schema);
    if (!grammars.has(key)) grammars.set(key, await llama.createGrammarForJsonSchema(simplifySchema(schema)));
    return grammars.get(key);
  }

  function toHistory(messages) {
    const history = [];
    for (const m of messages) {
      if (m.role === 'system') history.push({ type: 'system', text: m.content });
      else if (m.role === 'user') history.push({ type: 'user', text: m.content });
      else history.push({ type: 'model', response: [m.content] });
    }
    history.push({ type: 'model', response: [] });
    return history;
  }

  let busy = false;
  const brain = {
    id: opts.id || 'local',
    label: `Local: ${name}`,
    kind: 'local',
    info: () => ({
      backend: 'local', model: name, gpu: backend, gpuLayers: model.gpuLayers, totalLayers, contextSize: context.contextSize
    }),
    async chat(messages, options = {}) {
      if (busy) throw new Error('the local brain is busy');
      busy = true;
      const started = Date.now();
      const meter = sequence.tokenMeter?.getState?.() || { usedInputTokens: 0, usedOutputTokens: 0 };
      const chat = new LlamaChat({ contextSequence: sequence, autoDisposeSequence: false });
      try {
        const grammar = options.schema ? await grammarFor(options.schema) : undefined;
        const res = await chat.generateResponse(toHistory(messages), {
          grammar,
          maxTokens: options.maxTokens ?? 1024,
          temperature: options.temperature ?? 0.2,
          signal: options.signal,
          stopOnAbortSignal: false,
          onTextChunk: options.onToken
        });
        const text = res.response;
        const after = sequence.tokenMeter?.getState?.() || meter;
        const out = {
          text,
          promptTokens: after.usedInputTokens - meter.usedInputTokens,
          completionTokens: after.usedOutputTokens - meter.usedOutputTokens,
          ms: Date.now() - started,
          model: name
        };
        if (options.schema) {
          let json;
          try { json = grammar.parse(text); } catch { json = extractJson(text); }
          const errors = json === undefined ? ['not JSON (the answer was cut by maxTokens?)'] : validate(options.schema, json);
          if (errors.length) {
            const err = new Error(`the model answer did not match the schema: ${errors[0]}`);
            err.code = 'invalid_json';
            throw err;
          }
          out.json = json;
        }
        return out;
      } finally {
        chat.dispose({ disposeSequence: false });
        busy = false;
      }
    },
    async close() {
      try { await context.dispose(); } catch { /* ignore */ }
      try { await model.dispose(); } catch { /* ignore */ }
      try { await llama.dispose(); } catch { /* ignore */ }
    }
  };
  brain.backend = backend;
  return brain;
}
