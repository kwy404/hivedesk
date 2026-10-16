// Brains over HTTP: Ollama (native API, schema as `format`), LM Studio and any OpenAI compatible endpoint.
import { withSchema, estimateTokens, messagesChars } from './types.js';
import { simplifySchema } from './schema.js';

export const OLLAMA_URL = 'http://127.0.0.1:11434';
export const LMSTUDIO_URL = 'http://127.0.0.1:1234/v1';

async function readLines(res, onLine) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) onLine(line);
    }
  }
  if (buf.trim()) onLine(buf.trim());
}

async function failText(res) {
  let t = '';
  try { t = await res.text(); } catch { /* none */ }
  return `HTTP ${res.status}${t ? ': ' + t.slice(0, 300) : ''}`;
}

/**
 * Ollama native chat. Ollama 0.5+ accepts a JSON schema in `format` and constrains the output with it.
 * @param {{ url?: string, model: string, id?: string, fetchImpl?: typeof fetch, ctx?: number }} opts
 */
export function createOllamaBrain(opts) {
  const url = (opts.url || OLLAMA_URL).replace(/\/$/, '');
  const f = opts.fetchImpl || fetch;
  const raw = async (messages, options = {}) => {
    const started = Date.now();
    const body = {
      model: opts.model,
      messages,
      stream: true,
      options: { temperature: options.temperature ?? 0.2, num_predict: options.maxTokens ?? 1024, num_ctx: opts.ctx || 8192 }
    };
    if (options.schema) body.format = simplifySchema(options.schema);
    const res = await f(`${url}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: options.signal });
    if (!res.ok) throw new Error(`Ollama: ${await failText(res)}`);
    let text = '';
    let promptTokens = 0;
    let completionTokens = 0;
    await readLines(res, (line) => {
      let j;
      try { j = JSON.parse(line); } catch { return; }
      if (j.error) throw new Error(`Ollama: ${j.error}`);
      const piece = j.message?.content || '';
      if (piece) { text += piece; options.onToken?.(piece); }
      if (j.done) { promptTokens = j.prompt_eval_count || 0; completionTokens = j.eval_count || 0; }
    });
    return { text, promptTokens: promptTokens || estimateTokens('x'.repeat(messagesChars(messages))), completionTokens: completionTokens || estimateTokens(text), ms: Date.now() - started, model: opts.model };
  };
  return {
    id: opts.id || 'ollama',
    label: `Ollama: ${opts.model}`,
    kind: 'local',
    info: () => ({ backend: 'ollama', model: opts.model, url }),
    chat: withSchema(raw)
  };
}

/**
 * OpenAI compatible chat completions (LM Studio, llama.cpp server, hosted endpoints).
 * @param {{ url: string, model: string, key?: string, id?: string, backend?: string, fetchImpl?: typeof fetch }} opts
 */
export function createOpenAIBrain(opts) {
  const url = opts.url.replace(/\/$/, '');
  const f = opts.fetchImpl || fetch;
  let schemaSupported = true;
  const raw = async (messages, options = {}) => {
    const started = Date.now();
    const body = {
      model: opts.model,
      messages,
      temperature: options.temperature ?? 0.2,
      max_tokens: options.maxTokens ?? 1024,
      stream: true,
      stream_options: { include_usage: true }
    };
    if (options.schema && schemaSupported) {
      body.response_format = { type: 'json_schema', json_schema: { name: 'answer', schema: simplifySchema(options.schema), strict: false } };
    }
    const headers = { 'content-type': 'application/json' };
    if (opts.key) headers.authorization = `Bearer ${opts.key}`;
    let res = await f(`${url}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal: options.signal });
    if (!res.ok && body.response_format && res.status === 400) {
      // The endpoint does not know json_schema: fall back to validation and retry.
      schemaSupported = false;
      delete body.response_format;
      res = await f(`${url}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal: options.signal });
    }
    if (!res.ok) throw new Error(`${opts.backend || 'endpoint'}: ${await failText(res)}`);
    let text = '';
    let usage = null;
    const type = res.headers.get('content-type') || '';
    if (type.includes('application/json')) {
      const j = await res.json();
      text = j.choices?.[0]?.message?.content || '';
      usage = j.usage;
      if (text) options.onToken?.(text);
    } else {
      await readLines(res, (line) => {
        if (!line.startsWith('data:')) return;
        const data = line.slice(5).trim();
        if (data === '[DONE]') return;
        let j;
        try { j = JSON.parse(data); } catch { return; }
        const piece = j.choices?.[0]?.delta?.content || '';
        if (piece) { text += piece; options.onToken?.(piece); }
        if (j.usage) usage = j.usage;
      });
    }
    return {
      text,
      promptTokens: usage?.prompt_tokens || estimateTokens('x'.repeat(messagesChars(messages))),
      completionTokens: usage?.completion_tokens || estimateTokens(text),
      ms: Date.now() - started,
      model: opts.model
    };
  };
  return {
    id: opts.id || opts.backend || 'openai',
    label: `${opts.backend === 'lmstudio' ? 'LM Studio' : 'Endpoint'}: ${opts.model}`,
    kind: 'local',
    info: () => ({ backend: opts.backend || 'openai', model: opts.model, url }),
    chat: withSchema(raw)
  };
}

async function getJson(f, url, ms = 1500) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await f(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Lists Ollama models, or null when Ollama is not running. */
export async function probeOllama(url = OLLAMA_URL, f = fetch) {
  const j = await getJson(f, `${url.replace(/\/$/, '')}/api/tags`);
  if (!j || !Array.isArray(j.models)) return null;
  return j.models.map((m) => m.name || m.model).filter(Boolean);
}

/** Lists LM Studio models, or null when LM Studio is not running. */
export async function probeLmStudio(url = LMSTUDIO_URL, f = fetch) {
  const j = await getJson(f, `${url.replace(/\/$/, '')}/models`);
  if (!j || !Array.isArray(j.data)) return null;
  return j.data.map((m) => m.id).filter((id) => id && !/embed/i.test(id));
}

/** Prefers a qwen2.5-coder model, then any coder model, then the first one. */
export function pickServerModel(models) {
  if (!models || !models.length) return null;
  return models.find((m) => /qwen2\.5-coder/i.test(m)) || models.find((m) => /coder|code/i.test(m)) || models[0];
}
