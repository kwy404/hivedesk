import { describe, it, expect } from 'vitest';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { createAnthropicBrain, createChatCompletionsBrain, createGeminiBrain, listModels, testConnection, redact, portableSchema } from '../src/brain/cloud.js';
import { KeyStore } from '../src/brain/keys.js';
import { BrainManager } from '../src/brain/manager.js';
import { EventBus } from '../src/bus.js';
import { Scheduler } from '../src/crew/scheduler.js';
import { actionSchema } from '../src/tools/index.js';
import { tmpDir } from './helpers.js';

const schema = actionSchema(['write_file']);
const KEY = 'sk-ant-test-1234567890abcdef';

/** A recorded style mock server: handler(req, body) returns { status, headers, sse | json | text }. */
async function mock(handler) {
  const calls = [];
  const s = http.createServer(async (req, res) => {
    let b = '';
    for await (const c of req) b += c;
    const body = b ? JSON.parse(b) : null;
    calls.push({ url: req.url, method: req.method, headers: req.headers, body });
    const out = await handler(req, body, calls.length);
    res.statusCode = out.status || 200;
    for (const [k, v] of Object.entries(out.headers || {})) res.setHeader(k, v);
    if (out.hang) return;
    if (out.sse) {
      res.setHeader('content-type', 'text/event-stream');
      for (const ev of out.sse) res.write(`event: ${ev.type || 'message'}\ndata: ${JSON.stringify(ev)}\n\n`);
      return res.end();
    }
    if (out.json) { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(out.json)); }
    res.end(out.text || '');
  });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${s.address().port}`, calls, close: () => { s.closeAllConnections?.(); s.close(); } };
}

const anthropicSse = (text) => [
  { type: 'message_start', message: { usage: { input_tokens: 21 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  ...text.match(/.{1,12}/g).map((t) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } })),
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } },
  { type: 'message_stop' }
];
const answer = JSON.stringify({ tool: 'write_file', args: { path: 'a.html', content: 'hi' } });

describe('Anthropic adapter', () => {
  it('streams, sends structured output config and parses the JSON', async () => {
    const m = await mock(() => ({ sse: anthropicSse(answer) }));
    const b = createAnthropicBrain({ key: KEY, model: 'claude-opus-5-5', baseUrl: m.url });
    const tokens = [];
    const r = await b.chat([{ role: 'system', content: 'sys' }, { role: 'user', content: 'go' }], { schema, onToken: (t) => tokens.push(t) });
    expect(r.json.tool).toBe('write_file');
    expect(r).toMatchObject({ promptTokens: 21, completionTokens: 9 });
    expect(tokens.join('')).toBe(answer);
    const c = m.calls[0];
    expect(c.url).toBe('/messages');
    expect(c.headers['x-api-key']).toBe(KEY);
    expect(c.headers['anthropic-version']).toBe('2023-06-01');
    expect(c.body).toMatchObject({ model: 'claude-opus-5-5', system: 'sys', stream: true, output_config: { format: { type: 'json_schema' } } });
    expect(c.body.temperature).toBeUndefined();
    expect(c.body.tool_choice).toBeUndefined();
    expect(JSON.stringify(c.body.output_config)).not.toContain('oneOf');
    m.close();
  });

  it('falls back to prompt level JSON when structured output is refused', async () => {
    const m = await mock((req, body) => (body.output_config ? { status: 400, json: { error: { message: 'output_config not supported' } } } : { sse: anthropicSse(`Sure: ${answer}`) }));
    const b = createAnthropicBrain({ key: KEY, model: 'm', baseUrl: m.url });
    const r = await b.chat([{ role: 'user', content: 'go' }], { schema });
    expect(r.json.tool).toBe('write_file');
    expect(m.calls[1].body.system).toContain('Answer with only one JSON value');
    m.close();
  });

  it('turns 401 into a clear error without the key, and waits on 429 retry-after', async () => {
    const bad = await mock(() => ({ status: 401, json: { error: { message: `invalid key ${KEY}` } } }));
    const e = await createAnthropicBrain({ key: KEY, model: 'm', baseUrl: bad.url }).chat([{ role: 'user', content: 'x' }]).catch((x) => x);
    expect(e.code).toBe('auth');
    expect(e.message).not.toContain(KEY);
    bad.close();
    const started = Date.now();
    const limited = await mock((req, body, n) => (n === 1 ? { status: 429, headers: { 'retry-after': '1' }, json: {} } : { sse: anthropicSse('ok') }));
    const r = await createAnthropicBrain({ key: KEY, model: 'm', baseUrl: limited.url }).chat([{ role: 'user', content: 'x' }]);
    expect(r.text).toBe('ok');
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    limited.close();
  });

  it('times out with a clear error', async () => {
    const m = await mock(() => ({ hang: true }));
    const e = await createAnthropicBrain({ key: KEY, model: 'm', baseUrl: m.url, timeoutMs: 200 }).chat([{ role: 'user', content: 'x' }]).catch((x) => x);
    expect(e.code).toBe('timeout');
    m.close();
  });
});

describe('OpenAI and compatible adapters', () => {
  const sse = (text) => [...text.match(/.{1,10}/g).map((t) => ({ choices: [{ delta: { content: t } }] })), { choices: [], usage: { prompt_tokens: 7, completion_tokens: 5 } }];

  it('uses json_schema, then json_object, then prompt JSON as the endpoint allows', async () => {
    const m = await mock((req, body) => {
      if (body.response_format?.type === 'json_schema') return { status: 400, json: { error: { message: 'json_schema unsupported' } } };
      if (body.response_format?.type === 'json_object') return { status: 400, json: { error: { message: 'response_format unsupported' } } };
      return { sse: sse(answer) };
    });
    const b = createChatCompletionsBrain({ provider: 'compatible', model: 'local-model', baseUrl: m.url });
    const r = await b.chat([{ role: 'system', content: 's' }, { role: 'user', content: 'go' }], { schema });
    expect(r.json.args.path).toBe('a.html');
    expect(r.completionTokens).toBe(5);
    expect(m.calls.map((c) => c.body.response_format?.type || 'prompt')).toEqual(['json_schema', 'json_object', 'prompt']);
    expect(m.calls[2].body.messages[0].content).toContain('JSON schema');
    expect(m.calls[0].headers.authorization).toBeUndefined();
    m.close();
  });

  it('sends the bearer key for xAI and OpenAI', async () => {
    const m = await mock(() => ({ sse: sse('hello') }));
    await createChatCompletionsBrain({ provider: 'xai', key: 'xai-abcdefghijkl', model: 'grok-3-mini', baseUrl: m.url }).chat([{ role: 'user', content: 'x' }]);
    expect(m.calls[0].headers.authorization).toBe('Bearer xai-abcdefghijkl');
    expect(m.calls[0].url).toBe('/chat/completions');
    m.close();
  });
});

describe('Gemini adapter', () => {
  it('streams generateContent with JSON mode and the system instruction', async () => {
    const m = await mock(() => ({ sse: [{ candidates: [{ content: { parts: [{ text: answer.slice(0, 20) }] } }] }, { candidates: [{ content: { parts: [{ text: answer.slice(20) }] } }], usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 4 } }] }));
    const b = createGeminiBrain({ key: 'AIzaTESTKEY1234567', model: 'gemini-2.5-flash', baseUrl: m.url });
    const r = await b.chat([{ role: 'system', content: 'sys' }, { role: 'user', content: 'go' }, { role: 'assistant', content: 'a' }, { role: 'user', content: 'b' }], { schema });
    expect(r.json.tool).toBe('write_file');
    expect(r.promptTokens).toBe(11);
    const c = m.calls[0];
    expect(c.url).toBe('/models/gemini-2.5-flash:streamGenerateContent?alt=sse');
    expect(c.headers['x-goog-api-key']).toBe('AIzaTESTKEY1234567');
    expect(c.body.contents.map((x) => x.role)).toEqual(['user', 'model', 'user']);
    expect(c.body.generationConfig.responseMimeType).toBe('application/json');
    expect(c.body.systemInstruction.parts[0].text).toContain('sys');
    m.close();
  });
});

describe('models, test connection, keys', () => {
  it('lists models from the provider and falls back to defaults', async () => {
    const m = await mock((req) => (req.url.startsWith('/models') ? { json: { data: [{ id: 'claude-opus-5-5' }, { id: 'claude-haiku-5-5' }] } } : { json: {} }));
    expect(await listModels('anthropic', { key: KEY, baseUrl: m.url })).toEqual(['claude-opus-5-5', 'claude-haiku-5-5']);
    m.close();
    expect(await listModels('anthropic', { key: KEY, baseUrl: 'http://127.0.0.1:9' })).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
  });

  it('tests a connection and reports a clear error', async () => {
    const ok = await mock(() => ({ sse: anthropicSse('ok') }));
    expect(await testConnection('anthropic', { key: KEY, model: 'claude-haiku-5-5', baseUrl: ok.url })).toMatchObject({ ok: true, sample: 'ok' });
    ok.close();
    const bad = await mock(() => ({ status: 401, json: {} }));
    const r = await testConnection('anthropic', { key: KEY, baseUrl: bad.url });
    expect(r).toMatchObject({ ok: false, code: 'auth' });
    bad.close();
  });

  it('redacts keys and keeps them out of the public view, events and file mode', async () => {
    expect(redact(`error with ${KEY} and sk-proj-abcdefghijklmnop`, KEY)).toBe('error with [key] and sk-[key]');
    const home = tmpDir();
    const keys = new KeyStore(home);
    keys.set('anthropic', { key: KEY, model: 'claude-sonnet-5-5' });
    const view = JSON.stringify(keys.publicView());
    expect(view).not.toContain(KEY);
    expect(keys.publicView().anthropic).toMatchObject({ configured: true, model: 'claude-sonnet-5-5' });
    expect(new KeyStore(home).get('anthropic').key).toBe(KEY);
    if (process.platform !== 'win32') expect(fs.statSync(path.join(home, 'keys.json')).mode & 0o777).toBe(0o600);
    const bus = new EventBus();
    const m = new BrainManager({ bus, scheduler: new Scheduler(bus), home, keyStore: keys });
    m.setProvider('openai', { key: 'sk-openai-secret-123456', model: 'gpt-4.1-mini' });
    expect(JSON.stringify(bus.events)).not.toContain('sk-openai-secret-123456');
    expect(JSON.stringify(bus.state)).not.toContain(KEY);
    expect(bus.state.providers.openai.configured).toBe(true);
    expect(m.removeProvider('openai')).toBe(true);
    expect(bus.state.providers.openai.configured).toBe(false);
  });

  it('turns oneOf and const into what strict providers accept', () => {
    const s = portableSchema({ oneOf: [{ type: 'object', properties: { tool: { const: 'x' } } }] });
    expect(s).toEqual({ anyOf: [{ type: 'object', properties: { tool: { enum: ['x'], type: 'string' } } }] });
  });
});

describe('per worker brains', () => {
  it('Mel plans on a cloud brain while Dev stays on the main brain', async () => {
    const m = await mock(() => ({ sse: anthropicSse('cloud') }));
    const bus = new EventBus();
    const scheduler = new Scheduler(bus);
    const keys = new KeyStore(null);
    keys.set('anthropic', { key: KEY, baseUrl: m.url, model: 'claude-opus-5-5' });
    const mgr = new BrainManager({ bus, scheduler, home: tmpDir(), keyStore: keys });
    scheduler.addBrain({ id: 'main', label: 'local', kind: 'local', chat: async () => ({ text: 'local', promptTokens: 1, completionTokens: 1, ms: 1 }) });
    mgr.applyWorkerBrains({ mel: 'anthropic', dev: 'default' });
    const [a, b2] = await Promise.all([
      scheduler.turn({ workerId: 'mel', messages: [{ role: 'user', content: 'plan' }] }),
      scheduler.turn({ workerId: 'dev', messages: [{ role: 'user', content: 'code' }] })
    ]);
    expect(a.text).toBe('cloud');
    expect(b2.text).toBe('local');
    expect(bus.state.usage['cloud:anthropic']).toMatchObject({ completion: 9, turns: 1 });
    expect(bus.state.usage.main.turns).toBe(1);
    m.close();
  });
});
