// Cloud brains behind the same interface as the local one: chat(messages, { schema, signal, onToken }).
// Raw HTTP with fetch, so the package keeps zero runtime dependencies. Each adapter asks the provider for
// schema constrained JSON where it can, and falls back to prompt level JSON, validation and one retry.
import { withSchema, estimateTokens, messagesChars } from './types.js';
import { simplifySchema, describeSchema } from './schema.js';

/** Supported providers. Model lists come from the provider when a key is set; these are the fallbacks. */
export const PROVIDERS = {
  anthropic: {
    label: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1',
    models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'], keyHint: 'sk-ant-...'
  },
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4.1-mini', 'gpt-4.1'], keyHint: 'sk-...' },
  xai: { label: 'xAI', baseUrl: 'https://api.x.ai/v1', models: ['grok-3-mini', 'grok-3'], keyHint: 'xai-...' },
  gemini: { label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', models: ['gemini-2.5-flash', 'gemini-2.5-pro'], keyHint: 'AIza...' },
  compatible: { label: 'OpenAI compatible endpoint', baseUrl: '', models: [], keyHint: 'optional for local servers' }
};

export class ProviderError extends Error {
  /** @param {'auth'|'rate_limit'|'timeout'|'http'|'network'|'refused'} code */
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
});

/** Never let a key reach a log, an event or an error message. */
export function redact(text, key) {
  let s = String(text ?? '');
  if (key && key.length >= 6) s = s.split(key).join('[key]');
  return s.replace(/(sk-ant-|sk-|xai-|AIza)[A-Za-z0-9_\-]{8,}/g, '$1[key]');
}

/**
 * fetch with a timeout, clear errors, and retries on 429 (honoring retry-after) and 5xx.
 * @returns {Promise<Response>}
 */
export async function request(f, url, init, { key, timeoutMs = 120_000, retries = 2, signal, label = 'provider' } = {}) {
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const onAbort = () => ctrl.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    let res;
    try {
      res = await f(url, { ...init, signal: ctrl.signal });
    } catch (err) {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) throw new Error('aborted');
      if (ctrl.signal.aborted) throw new ProviderError('timeout', `${label} did not answer within ${Math.round(timeoutMs / 1000)} s`);
      throw new ProviderError('network', `${label} could not be reached: ${redact(err.cause?.code || err.message, key)}`);
    }
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    if (res.ok) return res;
    let body = '';
    try { body = await res.text(); } catch { /* none */ }
    const detail = redact(body.slice(0, 300), key);
    if (res.status === 401 || res.status === 403) throw new ProviderError('auth', `${label} refused the key (HTTP ${res.status}). Check it in Settings, Providers.`, res.status);
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      const after = Number(res.headers.get('retry-after'));
      const wait = Number.isFinite(after) && after > 0 ? Math.min(after * 1000, 30_000) : 1000 * 2 ** attempt;
      await sleep(wait, signal);
      continue;
    }
    if (res.status === 429) throw new ProviderError('rate_limit', `${label} is rate limiting this key (HTTP 429). Wait a minute or use another brain.`, 429);
    throw new ProviderError('http', `${label} answered HTTP ${res.status}${detail ? ': ' + detail : ''}`, res.status);
  }
}

/** Server sent events: calls onData with each parsed `data:` JSON. */
export async function readSse(res, onData) {
  const decoder = new TextDecoder();
  let buf = '';
  const flush = (block) => {
    for (const line of block.split('\n')) {
      const l = line.trim();
      if (!l.startsWith('data:')) continue;
      const data = l.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try { onData(JSON.parse(data)); } catch (err) { if (err instanceof ProviderError) throw err; }
    }
  };
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
    let i;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      flush(buf.slice(0, i));
      buf = buf.slice(i + 2);
    }
  }
  if (buf.trim()) flush(buf);
}

function splitSystem(messages) {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const rest = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    const last = rest[rest.length - 1];
    if (last && last.role === m.role) last.content += `\n\n${m.content}`;
    else rest.push({ role: m.role, content: m.content });
  }
  if (rest[0]?.role === 'assistant') rest.unshift({ role: 'user', content: '(start)' });
  return { system, rest };
}

/** JSON schema for providers that take a strict subset: oneOf becomes anyOf, const becomes a one value enum. */
export function portableSchema(schema) {
  const s = simplifySchema(schema);
  const walk = (n) => {
    if (Array.isArray(n)) return n.map(walk);
    if (!n || typeof n !== 'object') return n;
    const out = {};
    for (const [k, v] of Object.entries(n)) {
      if (k === 'oneOf') out.anyOf = walk(v);
      else if (k === 'const') out.enum = [v];
      else if (k === 'description') continue;
      else out[k] = walk(v);
    }
    if (out.enum && !out.type && out.enum.every((x) => typeof x === 'string')) out.type = 'string';
    return out;
  };
  return walk(s);
}

const jsonInstruction = (schema) => `Answer with only one JSON value, no prose, matching this JSON schema:\n${describeSchema(schema)}`;

/**
 * Anthropic Messages API (streaming). JSON comes from structured outputs (output_config.format);
 * if the model or account refuses that, the schema goes in the prompt and the answer is validated.
 */
export function createAnthropicBrain({ key, model, baseUrl, id, fetchImpl, timeoutMs }) {
  const f = fetchImpl || fetch;
  const url = `${(baseUrl || PROVIDERS.anthropic.baseUrl).replace(/\/$/, '')}/messages`;
  let structured = true;
  const raw = async (messages, options = {}) => {
    const started = Date.now();
    const { system, rest } = splitSystem(messages);
    const body = { model, max_tokens: options.maxTokens ?? 4096, messages: rest, stream: true };
    if (options.schema && structured) body.output_config = { format: { type: 'json_schema', schema: portableSchema(options.schema) } };
    const sys = options.schema && !structured ? `${system}\n\n${jsonInstruction(options.schema)}` : system;
    if (sys) body.system = sys;
    const headers = { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' };
    let res;
    try {
      res = await request(f, url, { method: 'POST', headers, body: JSON.stringify(body) }, { key, signal: options.signal, timeoutMs, label: 'Anthropic' });
    } catch (err) {
      if (err.code === 'http' && err.status === 400 && body.output_config) {
        structured = false;
        return raw(messages, options);
      }
      throw err;
    }
    let text = '';
    let promptTokens = 0;
    let completionTokens = 0;
    let stop = '';
    await readSse(res, (ev) => {
      if (ev.type === 'message_start') promptTokens = ev.message?.usage?.input_tokens || 0;
      else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') { text += ev.delta.text; options.onToken?.(ev.delta.text); }
      else if (ev.type === 'message_delta') { completionTokens = ev.usage?.output_tokens || completionTokens; stop = ev.delta?.stop_reason || stop; }
      else if (ev.type === 'error') throw new ProviderError('http', `Anthropic stream error: ${redact(ev.error?.message || 'unknown', key)}`);
    });
    if (stop === 'refusal') throw new ProviderError('refused', 'Anthropic declined this request (stop reason: refusal).');
    return { text, promptTokens: promptTokens || estimateTokens('x'.repeat(messagesChars(messages))), completionTokens: completionTokens || estimateTokens(text), ms: Date.now() - started, model };
  };
  return { id: id || 'cloud:anthropic', label: `Anthropic: ${model}`, kind: 'cloud', provider: 'anthropic', info: () => ({ backend: 'anthropic', model }), chat: withSchema(raw) };
}

/**
 * OpenAI Chat Completions, and every OpenAI compatible endpoint (xAI, OpenRouter, Groq, Mistral, local servers).
 * JSON comes from response_format json_schema; endpoints that reject it get json_object, then prompt level JSON.
 */
export function createChatCompletionsBrain({ provider = 'openai', key, model, baseUrl, id, fetchImpl, timeoutMs }) {
  const f = fetchImpl || fetch;
  const base = (baseUrl || PROVIDERS[provider]?.baseUrl || '').replace(/\/$/, '');
  const label = PROVIDERS[provider]?.label || 'Endpoint';
  let mode = 'schema'; // schema, object, prompt
  const raw = async (messages, options = {}) => {
    const started = Date.now();
    const msgs = options.schema && mode !== 'schema' ? [...messages.map((m, i) => (i === 0 && m.role === 'system' ? { ...m, content: `${m.content}\n\n${jsonInstruction(options.schema)}` } : m))] : messages;
    const body = { model, messages: msgs, max_tokens: options.maxTokens ?? 4096, stream: true, stream_options: { include_usage: true } };
    if (options.temperature !== undefined) body.temperature = options.temperature;
    if (options.schema && mode === 'schema') body.response_format = { type: 'json_schema', json_schema: { name: 'answer', schema: portableSchema(options.schema), strict: false } };
    if (options.schema && mode === 'object') body.response_format = { type: 'json_object' };
    const headers = { 'content-type': 'application/json' };
    if (key) headers.authorization = `Bearer ${key}`;
    let res;
    try {
      res = await request(f, `${base}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) }, { key, signal: options.signal, timeoutMs, label });
    } catch (err) {
      if (err.code === 'http' && err.status === 400 && options.schema && mode !== 'prompt') {
        mode = mode === 'schema' ? 'object' : 'prompt';
        return raw(messages, options);
      }
      throw err;
    }
    let text = '';
    let usage = null;
    await readSse(res, (j) => {
      const piece = j.choices?.[0]?.delta?.content || '';
      if (piece) { text += piece; options.onToken?.(piece); }
      if (j.usage) usage = j.usage;
      if (j.error) throw new ProviderError('http', `${label} stream error: ${redact(j.error.message || 'unknown', key)}`);
    });
    return { text, promptTokens: usage?.prompt_tokens || estimateTokens('x'.repeat(messagesChars(messages))), completionTokens: usage?.completion_tokens || estimateTokens(text), ms: Date.now() - started, model };
  };
  return { id: id || `cloud:${provider}`, label: `${label}: ${model}`, kind: 'cloud', provider, info: () => ({ backend: provider, model, url: base }), chat: withSchema(raw) };
}

/** Google Gemini generateContent (streaming). JSON mode plus prompt level schema and validation. */
export function createGeminiBrain({ key, model, baseUrl, id, fetchImpl, timeoutMs }) {
  const f = fetchImpl || fetch;
  const base = (baseUrl || PROVIDERS.gemini.baseUrl).replace(/\/$/, '');
  const raw = async (messages, options = {}) => {
    const started = Date.now();
    const { system, rest } = splitSystem(messages);
    const body = {
      contents: rest.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
      generationConfig: { maxOutputTokens: options.maxTokens ?? 4096, ...(options.temperature !== undefined ? { temperature: options.temperature } : {}), ...(options.schema ? { responseMimeType: 'application/json' } : {}) }
    };
    const sys = options.schema ? `${system}\n\n${jsonInstruction(options.schema)}` : system;
    if (sys) body.systemInstruction = { parts: [{ text: sys }] };
    const url = `${base}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
    const res = await request(f, url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body) }, { key, signal: options.signal, timeoutMs, label: 'Gemini' });
    let text = '';
    let usage = null;
    await readSse(res, (j) => {
      for (const p of j.candidates?.[0]?.content?.parts || []) if (p.text) { text += p.text; options.onToken?.(p.text); }
      if (j.usageMetadata) usage = j.usageMetadata;
      if (j.error) throw new ProviderError('http', `Gemini stream error: ${redact(j.error.message || 'unknown', key)}`);
    });
    return { text, promptTokens: usage?.promptTokenCount || estimateTokens('x'.repeat(messagesChars(messages))), completionTokens: usage?.candidatesTokenCount || estimateTokens(text), ms: Date.now() - started, model };
  };
  return { id: id || 'cloud:gemini', label: `Gemini: ${model}`, kind: 'cloud', provider: 'gemini', info: () => ({ backend: 'gemini', model }), chat: withSchema(raw) };
}

/** One brain for a provider and model. */
export function createCloudBrain(provider, opts) {
  if (provider === 'anthropic') return createAnthropicBrain(opts);
  if (provider === 'gemini') return createGeminiBrain(opts);
  if (provider === 'openai' || provider === 'xai' || provider === 'compatible') return createChatCompletionsBrain({ ...opts, provider });
  throw new Error(`unknown provider ${provider}`);
}

/** Model ids from the provider, or the defaults when the provider has no list endpoint or it fails. */
export async function listModels(provider, { key, baseUrl, fetchImpl } = {}) {
  const f = fetchImpl || fetch;
  const def = PROVIDERS[provider]?.models || [];
  const base = (baseUrl || PROVIDERS[provider]?.baseUrl || '').replace(/\/$/, '');
  if (!base) return def;
  try {
    if (provider === 'anthropic') {
      const res = await request(f, `${base}/models?limit=100`, { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } }, { key, timeoutMs: 10_000, retries: 0, label: 'Anthropic' });
      const j = await res.json();
      const ids = (j.data || []).map((m) => m.id).filter(Boolean);
      return ids.length ? ids : def;
    }
    if (provider === 'gemini') {
      const res = await request(f, `${base}/models`, { headers: { 'x-goog-api-key': key } }, { key, timeoutMs: 10_000, retries: 0, label: 'Gemini' });
      const j = await res.json();
      const ids = (j.models || []).filter((m) => (m.supportedGenerationMethods || []).includes('generateContent')).map((m) => String(m.name).replace(/^models\//, ''));
      return ids.length ? ids : def;
    }
    const headers = key ? { authorization: `Bearer ${key}` } : {};
    const res = await request(f, `${base}/models`, { headers }, { key, timeoutMs: 10_000, retries: 0, label: PROVIDERS[provider]?.label || 'Endpoint' });
    const j = await res.json();
    const ids = (j.data || []).map((m) => m.id).filter((x) => x && !/embed|whisper|tts|dall-e|image|audio|moderation/i.test(x));
    return ids.length ? ids : def;
  } catch (err) {
    if (err.code === 'auth') throw err;
    return def;
  }
}

/** A tiny request that proves the key and the model work. */
export async function testConnection(provider, { key, model, baseUrl, fetchImpl, timeoutMs = 30_000 } = {}) {
  const started = Date.now();
  const brain = createCloudBrain(provider, { key, model: model || PROVIDERS[provider]?.models[0], baseUrl, fetchImpl, timeoutMs });
  try {
    const r = await brain.chat([{ role: 'user', content: 'Reply with the word ok.' }], { maxTokens: 16 });
    return { ok: true, model: r.model, ms: Date.now() - started, sample: r.text.slice(0, 40) };
  } catch (err) {
    return { ok: false, code: err.code || 'error', error: redact(err.message, key), ms: Date.now() - started };
  }
}
