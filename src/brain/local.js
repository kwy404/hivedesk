// Local brain: node-llama-cpp with a GGUF file. Every schema becomes a grammar, so even small models
// always answer with a valid tool call.
import { simplifySchema, validate, extractJson } from './schema.js';

/**
 * @param {{
 *   mod: any,                      the imported node-llama-cpp module
 *   modelPath: string,
 *   gpu?: boolean,                 false forces the CPU
 *   contextSize?: number,
 *   id?: string, name?: string,
 *   onLoadProgress?: (p: number) => void
 * }} opts
 */
export async function createLocalBrain(opts) {
  const { getLlama, LlamaChat, LlamaLogLevel } = opts.mod;
  const llama = await getLlama({ gpu: opts.gpu === false ? false : 'auto', logLevel: LlamaLogLevel?.error ?? 'error', build: 'never' })
    .catch(async (err) => {
      // No prebuilt binary for this GPU: let the runtime pick, which may build or fall back.
      if (opts.gpu === false) throw err;
      return getLlama({ gpu: 'auto', logLevel: LlamaLogLevel?.error ?? 'error' });
    });
  const model = await llama.loadModel({
    modelPath: opts.modelPath,
    gpuLayers: opts.gpu === false ? 0 : 'auto',
    onLoadProgress: opts.onLoadProgress
  });
  const context = await model.createContext({ contextSize: { min: 2048, max: opts.contextSize || 8192 } });
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
      backend: 'local', model: name, gpu: backend, gpuLayers: model.gpuLayers, contextSize: context.contextSize
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
