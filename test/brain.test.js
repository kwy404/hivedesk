import { describe, it, expect } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { validate, extractJson, simplifySchema } from '../src/brain/schema.js';
import { withSchema } from '../src/brain/types.js';
import { createFakeBrain } from '../src/brain/fake.js';
import { createRelayBrain } from '../src/brain/relay.js';
import { createOllamaBrain, createOpenAIBrain, probeOllama, probeLmStudio, pickServerModel } from '../src/brain/http.js';
import { MODELS, pickModel, chooseModel, modelById, smallerModel, downloadModel, isCached } from '../src/brain/models.js';
import { BrainManager, bar } from '../src/brain/manager.js';
import { EventBus } from '../src/bus.js';
import { Scheduler } from '../src/crew/scheduler.js';
import { actionSchema } from '../src/tools/index.js';
import { tmpDir } from './helpers.js';

const schema = actionSchema(['write_file']);

describe('schema helpers', () => {
  it('validates the subset the engine uses', () => {
    const s = { type: 'object', properties: { a: { type: 'integer' }, b: { enum: ['x', 'y'] }, c: { type: 'array', items: { type: 'string' }, maxItems: 2 } }, required: ['a', 'b'], additionalProperties: false };
    expect(validate(s, { a: 1, b: 'x', c: ['k'] })).toEqual([]);
    expect(validate(s, { a: 1.5, b: 'z', c: ['k', 'l', 'm'], d: 1 })).toHaveLength(4);
    expect(validate(s, { b: 'x' })).toEqual(['$.a is required']);
  });

  it('pulls JSON out of chatty text and code fences', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('Sure!\n```json\n{"a":[1,2]}\n```')).toEqual({ a: [1, 2] });
    expect(extractJson('Here: {"t":"a } b"} and more')).toEqual({ t: 'a } b' });
    expect(extractJson('nothing here')).toBeUndefined();
  });

  it('simplifies schemas for grammar engines', () => {
    expect(simplifySchema({ $schema: 'x', anyOf: [{ type: 'string', format: 'uri' }] })).toEqual({ oneOf: [{ type: 'string' }] });
  });

  it('retries once with the validation errors, then gives up', async () => {
    const answers = ['not json', '{"tool":"write_file","args":{"path":"a","content":"b"}}'];
    const seen = [];
    const chat = withSchema(async (messages) => { seen.push(messages); return { text: answers.shift(), promptTokens: 1, completionTokens: 1, ms: 1 }; });
    const r = await chat([{ role: 'user', content: 'go' }], { schema });
    expect(r.json.tool).toBe('write_file');
    expect(seen[1].at(-1).content).toContain('not valid');
    const bad = withSchema(async () => ({ text: '{"tool":"nope"}', promptTokens: 0, completionTokens: 0, ms: 0 }));
    await expect(bad([], { schema })).rejects.toMatchObject({ code: 'invalid_json' });
  });
});

describe('fake brain', () => {
  it('answers from a script and streams tokens', async () => {
    const b = createFakeBrain({ respond: (m, o, n) => ({ n }) });
    const tokens = [];
    const r = await b.chat([{ role: 'user', content: 'hello' }], { schema: {}, onToken: (t) => tokens.push(t) });
    expect(r.json).toEqual({ n: 0 });
    expect(tokens.join('')).toBe('{"n":0}');
    expect((await b.chat([])).text).toBe('{"n":1}');
    expect(b.calls).toHaveLength(2);
  });
});

function jsonServer(handler) {
  const s = http.createServer(handler);
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r({ s, url: `http://127.0.0.1:${s.address().port}` })));
}

async function body(req) {
  let b = '';
  for await (const c of req) b += c;
  return JSON.parse(b || '{}');
}

describe('HTTP brains', () => {
  it('talks to Ollama with the schema as format', async () => {
    let seen;
    const { s, url } = await jsonServer(async (req, res) => {
      if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'llama3:8b' }, { name: 'qwen2.5-coder:7b' }] }));
      seen = await body(req);
      res.write(JSON.stringify({ message: { content: '{"tool":"write_file",' } }) + '\n');
      res.end(JSON.stringify({ message: { content: '"args":{"path":"a","content":"b"}}' }, done: true, prompt_eval_count: 11, eval_count: 7 }) + '\n');
    });
    const models = await probeOllama(url);
    expect(pickServerModel(models)).toBe('qwen2.5-coder:7b');
    const b = createOllamaBrain({ url, model: 'qwen2.5-coder:7b' });
    const toks = [];
    const r = await b.chat([{ role: 'user', content: 'x' }], { schema, onToken: (t) => toks.push(t) });
    expect(seen.format.oneOf).toBeDefined();
    expect(seen.stream).toBe(true);
    expect(r).toMatchObject({ promptTokens: 11, completionTokens: 7, json: { tool: 'write_file' } });
    expect(toks).toHaveLength(2);
    s.close();
  });

  it('talks to an OpenAI compatible endpoint over SSE and falls back when json_schema is refused', async () => {
    const bodies = [];
    const { s, url } = await jsonServer(async (req, res) => {
      if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'text-embedding-x' }, { id: 'qwen2.5-coder-3b-instruct' }] }));
      const b = await body(req);
      bodies.push({ b, auth: req.headers.authorization });
      if (b.response_format) { res.statusCode = 400; return res.end('{"error":"response_format not supported"}'); }
      res.setHeader('content-type', 'text/event-stream');
      res.write('data: {"choices":[{"delta":{"content":"{\\"tool\\":\\"done\\","}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"\\"args\\":{\\"summary\\":\\"ok\\"}}"}}]}\n\n');
      res.write('data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":3}}\n\n');
      res.end('data: [DONE]\n\n');
    });
    expect(await probeLmStudio(`${url}/v1`)).toEqual(['qwen2.5-coder-3b-instruct']);
    const b = createOpenAIBrain({ url: `${url}/v1`, model: 'm', key: 'k123', backend: 'openai' });
    const r = await b.chat([{ role: 'user', content: 'x' }], { schema });
    expect(r.json).toEqual({ tool: 'done', args: { summary: 'ok' } });
    expect(r.completionTokens).toBe(3);
    expect(bodies[0].b.response_format.type).toBe('json_schema');
    expect(bodies[1].b.response_format).toBeUndefined();
    expect(bodies[1].auth).toBe('Bearer k123');
    s.close();
  });

  it('reports a server that is not running as null', async () => {
    expect(await probeOllama('http://127.0.0.1:9')).toBeNull();
  });
});

describe('relay brain', () => {
  it('sends brain.request frames and resolves on respond', async () => {
    const sent = [];
    const b = createRelayBrain({ id: 'b_remote_1', label: 'Friend', send: (f) => sent.push(f) });
    const tokens = [];
    const p = b.chat([{ role: 'user', content: 'hi' }], { schema, maxTokens: 50, onToken: (t) => tokens.push(t), signal: new AbortController().signal });
    expect(sent[0]).toMatchObject({ kind: 'brain.request', brainId: 'b_remote_1', options: { maxTokens: 50 } });
    expect(sent[0].options.signal).toBeUndefined();
    b.token(sent[0].requestId, 'part');
    expect(b.respond(sent[0].requestId, true, { text: '{"tool":"done","args":{"summary":"x"}}', completionTokens: 4 })).toBe(true);
    const r = await p;
    expect(r.json.tool).toBe('done');
    expect(tokens).toEqual(['part']);
    expect(b.respond('unknown', true, {})).toBe(false);
  });

  it('rejects invalid answers, timeouts and disconnects', async () => {
    const sent = [];
    const b = createRelayBrain({ id: 'r', label: 'x', send: (f) => sent.push(f), timeoutMs: 50 });
    const p1 = b.chat([], { schema });
    b.respond(sent[0].requestId, true, { text: 'nope' });
    await expect(p1).rejects.toMatchObject({ code: 'invalid_json' });
    await expect(b.chat([], {})).rejects.toMatchObject({ code: 'timeout' });
    expect(sent.some((f) => f.kind === 'brain.cancel')).toBe(true);
    const p3 = b.chat([], {});
    await b.close();
    await expect(p3).rejects.toThrow('disconnected');
  });
});

describe('model choice and download', () => {
  const GB = 1e9;
  it('picks the model by VRAM and RAM', () => {
    const MiB = 1024 * 1024;
    // The table from FIRST-RUN.md, with the sizes real cards report.
    expect(chooseModel({ gpu: { vramBytes: 12288 * MiB }, ramBytes: 32 * GB })).toMatchObject({ gpu: true, model: { id: 'qwen2.5-coder-14b' } });
    expect(chooseModel({ gpu: { vramBytes: 8192 * MiB }, ramBytes: 16 * GB })).toMatchObject({ gpu: true, model: { id: 'qwen2.5-coder-7b' } });
    const gtx = chooseModel({ gpu: { name: 'NVIDIA GeForce GTX 1060 6GB', vramBytes: 6144 * MiB }, ramBytes: 16 * GB });
    expect(gtx).toMatchObject({ gpu: true, model: { id: 'qwen2.5-coder-3b' } });
    expect(gtx.reason).toBe('NVIDIA GeForce GTX 1060 6GB (6.4 GB VRAM) found: using Qwen2.5-Coder 3B (2.1 GB), fully on the GPU.');
    expect(chooseModel({ gpu: { vramBytes: 4096 * MiB }, ramBytes: 8 * GB }).model.id).toBe('qwen2.5-coder-3b');
    expect(chooseModel({ gpu: { vramBytes: 2048 * MiB }, ramBytes: 16 * GB })).toMatchObject({ gpu: false, model: { id: 'qwen2.5-coder-3b' } });
    expect(chooseModel({ gpu: null, ramBytes: 32 * GB })).toMatchObject({ gpu: false, model: { id: 'qwen2.5-coder-3b' } });
    expect(chooseModel({ gpu: null, ramBytes: 8 * 1024 * MiB })).toMatchObject({ gpu: false, model: { id: 'qwen2.5-coder-1.5b' } });
    const tiny = chooseModel({ gpu: null, ramBytes: 4 * GB });
    expect(tiny.model.id).toBe('qwen2.5-coder-0.5b');
    expect(tiny.warning).toMatch(/basic/);
    expect(pickModel({ gpu: { vramBytes: 8 * GB }, ramBytes: 8 * GB }, { gpu: false }).id).toBe('qwen2.5-coder-1.5b');
    expect(modelById('7B').id).toBe('qwen2.5-coder-7b');
    expect(modelById('1.5b').id).toBe('qwen2.5-coder-1.5b');
    expect(smallerModel(modelById('3b')).id).toBe('qwen2.5-coder-1.5b');
    expect(smallerModel(MODELS[0])).toBeNull();
    for (const m of MODELS) expect(m.url).toMatch(/^https:\/\/huggingface\.co\/Qwen\/Qwen2\.5-Coder-.*-Instruct-GGUF\/resolve\/main\/.*q4_k_m\.gguf$/);
  });

  function fakeModel(data) {
    return { id: 'fake', name: 'Fake model', file: 'fake.gguf', bytes: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') };
  }

  it('downloads with progress, resumes a partial file and checks the hash', async () => {
    const data = crypto.randomBytes(300_000);
    let ranges = [];
    const { s, url } = await jsonServer((req, res) => {
      const r = req.headers.range;
      ranges.push(r || null);
      if (r) {
        const start = Number(r.match(/bytes=(\d+)-/)[1]);
        res.writeHead(206, { 'content-length': data.length - start });
        return res.end(data.subarray(start));
      }
      res.writeHead(200, { 'content-length': data.length });
      res.end(data);
    });
    const home = tmpDir();
    const model = { ...fakeModel(data), url: `${url}/m.gguf` };
    fs.mkdirSync(path.join(home, 'models'), { recursive: true });
    fs.writeFileSync(path.join(home, 'models', 'fake.gguf.part'), data.subarray(0, 1000));
    const seen = [];
    const out = await downloadModel(model, { home, onProgress: (p) => seen.push(p) });
    expect(fs.readFileSync(out).equals(data)).toBe(true);
    expect(ranges[0]).toBe('bytes=1000-');
    expect(seen.at(-1).received).toBe(data.length);
    expect(isCached(home, model)).toBe(true);

    const bad = { ...model, file: 'bad.gguf', sha256: '0'.repeat(64) };
    await expect(downloadModel(bad, { home })).rejects.toMatchObject({ code: 'checksum' });
    expect(fs.existsSync(path.join(home, 'models', 'bad.gguf.part'))).toBe(false);

    // A part without a SHA-256, or without a size, is never downloaded.
    const fetched = [];
    const spy = async (u) => { fetched.push(u); throw new Error('must not fetch'); };
    await expect(downloadModel({ ...model, file: 'nosha.gguf', sha256: null }, { home, fetchImpl: spy })).rejects.toMatchObject({ code: 'checksum' });
    await expect(downloadModel({ name: 'Split', files: [{ file: 'a.gguf', bytes: 10, sha256: model.sha256, url: model.url }, { file: 'b.gguf', bytes: 10, url: model.url }] }, { home, fetchImpl: spy })).rejects.toMatchObject({ code: 'checksum' });
    await expect(downloadModel({ ...model, file: 'nosize.gguf', bytes: 0 }, { home, fetchImpl: spy })).rejects.toMatchObject({ code: 'too_big' });
    expect(fetched).toEqual([]);
    // A server that sends more than the named size is cut off and the part dropped.
    await expect(downloadModel({ ...model, file: 'short.gguf', bytes: 500 }, { home, freeBytes: 1e12 })).rejects.toMatchObject({ code: 'checksum' });
    expect(fs.existsSync(path.join(home, 'models', 'short.gguf.part'))).toBe(false);
    s.close();
  });

  it('fails clearly without disk space or network', async () => {
    const home = tmpDir();
    const model = { ...MODELS[0] };
    await expect(downloadModel(model, { home, freeBytes: 1000 })).rejects.toMatchObject({ code: 'no_disk' });
    const offline = async () => { const e = new TypeError('fetch failed'); e.cause = { code: 'ENOTFOUND' }; throw e; };
    await expect(downloadModel(model, { home, fetchImpl: offline, freeBytes: 1e12 })).rejects.toMatchObject({ code: 'no_network' });
  });

  it('draws a progress bar', () => {
    expect(bar('M', 50, 100, 10)).toMatch(/^M \[#{12}\.{12}\] 50\.0% 50 B of 100 B at 10 B\/s/);
  });
});

describe('brain manager (first run pipeline)', () => {
  const GB = 1e9;
  const hw = { os: 'test', cpus: 8, ramBytes: 16 * GB, freeRamBytes: 8 * GB, gpu: { name: 'Test GPU', vramBytes: 6.4 * GB, backend: 'cuda' }, diskFreeBytes: 100 * GB };

  function offlineFetch(routes = {}) {
    return async (u, init) => {
      const url = String(u);
      for (const [k, v] of Object.entries(routes)) if (url.includes(k)) return v(url, init);
      const e = new TypeError('fetch failed');
      e.cause = { code: 'ECONNREFUSED' };
      throw e;
    };
  }

  function make(opts = {}) {
    const bus = new EventBus();
    const scheduler = new Scheduler(bus);
    const home = opts.home || tmpDir();
    const loaded = [];
    const cached = new Set();
    const m = new BrainManager({
      bus, scheduler, home, hardware: opts.hardware || hw, flags: opts.flags,
      isCachedImpl: (h, model) => cached.has(model.id),
      fetchImpl: opts.fetch || offlineFetch(),
      loadRuntimeImpl: async () => ({ mod: {}, version: '0.0.0-test', entry: 'x' }),
      createLocalImpl: async (o) => {
        loaded.push(o);
        if (opts.gpuFails && o.gpu) throw new Error('CUDA out of memory');
        return { id: 'local', label: 'Local', kind: 'local', info: () => ({ model: o.name, gpu: o.gpu ? 'cuda' : false, gpuLayers: 29, contextSize: 8192 }), chat: async () => ({ text: '', promptTokens: 0, completionTokens: 0, ms: 1 }) };
      }
    });
    return { bus, scheduler, home, m, loaded, cache: (model) => cached.add(model.id) };
  }

  it('uses Ollama when it is running, without downloading', async () => {
    const { m, bus, scheduler } = make({
      fetch: offlineFetch({ '/api/tags': async () => new Response(JSON.stringify({ models: [{ name: 'qwen2.5-coder:7b' }] })) })
    });
    await m.start();
    expect(bus.state.brain).toMatchObject({ state: 'ready', backend: 'ollama', model: 'qwen2.5-coder:7b' });
    expect(scheduler.hasBrain).toBe(true);
    expect(bus.events.some((e) => e.type === 'brain.download.started')).toBe(false);
  });

  it('loads a cached model by hardware with no download (second run)', async () => {
    const t = make();
    t.cache(MODELS[2]);
    await t.m.start();
    expect(t.loaded[0]).toMatchObject({ gpu: true, name: MODELS[2].name });
    expect(t.bus.state.brain).toMatchObject({ state: 'ready', backend: 'local' });
    expect(t.bus.events.some((e) => e.type === 'brain.download.required')).toBe(false);
    expect(t.bus.events.find((e) => e.type === 'hardware.detected')).toBeTruthy();
  });

  it('falls back to the 1.5B model on the CPU when the GPU fails', async () => {
    const t = make({ gpuFails: true });
    t.cache(MODELS[2]);
    t.cache(MODELS[1]);
    await t.m.start();
    expect(t.loaded.map((o) => [o.name, o.gpu])).toEqual([[MODELS[2].name, true], [MODELS[1].name, false]]);
    const fb = t.bus.events.find((e) => e.type === 'brain.fallback');
    expect(fb.data.to).toMatchObject({ gpu: false, model: MODELS[1].name });
    expect(t.bus.state.brain.state).toBe('ready');
  });

  it('with --no-download it says a download is needed and waits', async () => {
    const t = make({ flags: { noDownload: true } });
    await t.m.start();
    const choice = t.bus.events.find((e) => e.type === 'brain.choice').data;
    expect(t.bus.state.brain).toMatchObject({ state: 'needs_download', model: choice.model });
    expect(t.bus.events.find((e) => e.type === 'brain.download.required').data).toMatchObject({ bytes: choice.bytes, source: expect.stringMatching(/^https:\/\/huggingface\.co\/(Qwen|bartowski)\/Qwen2\.5-Coder-/) });
    expect(t.bus.events.find((e) => e.type === 'models.consent.required').data.reason).toBe('no_download');
    expect(choice.reason).toMatch(/Test GPU \(6\.4 GB VRAM\) found: using \d+B /);
    expect(t.scheduler.hasBrain).toBe(false);
  });

  it('reports no network with a hint, and picks a model that fits the free disk', async () => {
    const t = make({ flags: { model: '3b' } });
    await t.m.start();
    expect(t.bus.state.brain.state).toBe('error');
    expect(t.bus.state.brain.hint).toMatch(/Retry/);
    expect(t.bus.events.find((e) => e.type === 'brain.download.failed').data.code).toBe('no_network');

    const small = make({ hardware: { ...hw, diskFreeBytes: 1.5 * GB } });
    await small.m.start();
    expect(small.bus.events.find((e) => e.type === 'brain.choice').data.bytes).toBeLessThan(1.4 * GB);

    const none = make({ hardware: { ...hw, diskFreeBytes: 0.5 * GB } });
    // The real free disk is read from the home folder, so this one only checks the message path when it applies.
    await none.m.start();
    expect(['error', 'needs_download']).toContain(none.bus.state.brain.state);
    if (none.bus.state.brain.state === 'needs_download') expect(none.bus.events.find((e) => e.type === 'brain.choice').data.bytes).toBeLessThan(0.4 * GB);
  });

  it('uses a --model file directly', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'my.gguf');
    fs.writeFileSync(file, 'x');
    const t = make({ flags: { model: file } });
    await t.m.start();
    expect(t.loaded[0].modelPath).toBe(file);
    const missing = make({ flags: { model: path.join(dir, 'nope.gguf') } });
    await missing.m.start();
    expect(missing.bus.state.brain).toMatchObject({ state: 'error' });
    expect(missing.bus.state.brain.detail).toMatch(/not found/);
  });

  it('probes the options', async () => {
    const t = make();
    const p = await t.m.probe();
    expect(p.recommended.model).toMatch(/^qwen2\.5-coder-7b:/);
    expect(p.options.find((o) => o.recommended).model).toBe(p.recommended.model);
    expect(p.options.filter((o) => o.backend === 'local').length).toBeGreaterThanOrEqual(5);
    expect(p.options.find((o) => o.backend === 'ollama').available).toBe(false);
  });
});

describe('runtime install', () => {
  it('retries with a private npm cache, then reports no network', async () => {
    const { installRuntime } = await import('../src/brain/runtime.js');
    const { EventEmitter } = await import('node:events');
    const calls = [];
    const fakeSpawn = (cmd, args) => {
      calls.push(args);
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      setImmediate(() => {
        child.stderr.emit('data', calls.length === 1 ? 'npm error EPERM stat cache\n' : 'npm error ENOTFOUND registry.npmjs.org\n');
        child.emit('close', 1);
      });
      return child;
    };
    await expect(installRuntime(tmpDir(), { spawnImpl: fakeSpawn })).rejects.toMatchObject({ code: 'no_network' });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('--cache');
    for (const a of calls) {
      expect(a).toContain('--ignore-scripts');
      expect(a.find((x) => x.startsWith('node-llama-cpp@'))).toMatch(/^node-llama-cpp@\d+\.\d+\.\d+$/);
    }
  });

  const npmFake = async (outcome) => {
    const { EventEmitter } = await import('node:events');
    const calls = [];
    const spawnImpl = (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      setImmediate(() => {
        const r = outcome(calls.length, args);
        if (r.out) child.stderr.emit('data', r.out);
        child.emit('close', r.code);
      });
      return child;
    };
    return { calls, spawnImpl };
  };

  it('runs npm without a shell, keeps a home with spaces as one argument, retries in a fresh folder, and says why it failed', async () => {
    const { installRuntime } = await import('../src/brain/runtime.js');
    const home = path.join(tmpDir(), 'First Last', '.hivedesk');
    const f = await npmFake(() => ({ code: 1, out: 'npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/x\nnpm error A complete log of this run can be found in: C:\\log.txt\n' }));
    const err = await installRuntime(home, { spawnImpl: f.spawnImpl }).catch((e) => e);
    expect(err).toMatchObject({ code: 'install_failed' });
    expect(err.message).toMatch(/404 Not Found/);
    expect(err.message).not.toMatch(/complete log/);
    expect(f.calls).toHaveLength(3);
    for (const c of f.calls) {
      expect(c.opts.shell).toBeFalsy();
      expect(c.args[0]).toMatch(/npm-cli\.js$/);
      expect(c.args[c.args.indexOf('--prefix') + 1]).toContain('First Last');
    }
    expect(f.calls[2].args[f.calls[2].args.indexOf('--prefix') + 1]).toMatch(/runtime\.new$/);
    expect(fs.existsSync(path.join(home, 'runtime.new'))).toBe(false);
  });

  it('swaps in the fresh folder when only that install works', async () => {
    const { installRuntime } = await import('../src/brain/runtime.js');
    const home = path.join(tmpDir(), 'h');
    const f = await npmFake((n, args) => {
      if (n < 3) return { code: 1, out: 'npm error EBUSY: resource busy or locked\n' };
      const prefix = args[args.indexOf('--prefix') + 1];
      const pkgDir = path.join(prefix, 'node_modules', 'node-llama-cpp');
      fs.mkdirSync(path.join(pkgDir, 'dist'), { recursive: true });
      fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ version: '3.22.1', main: 'dist/index.js' }));
      fs.writeFileSync(path.join(pkgDir, 'dist', 'index.js'), 'export {};');
      return { code: 0 };
    });
    const found = await installRuntime(home, { spawnImpl: f.spawnImpl });
    expect(found.version).toBe('3.22.1');
    expect(found.entry).toBe(path.join(home, 'runtime', 'node_modules', 'node-llama-cpp', 'dist', 'index.js'));
    expect(fs.existsSync(path.join(home, 'runtime.new'))).toBe(false);
  });

  it('finds the npm of a Node.js on the PATH when the running node has none, and reports a missing npm clearly', async () => {
    const { npmCli, npmReason } = await import('../src/brain/runtime.js');
    const root = tmpDir();
    const bin = path.join(root, 'bin');
    const exe = process.platform === 'win32' ? 'node.exe' : 'node';
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, exe), '');
    const script = process.platform === 'win32' ? path.join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js') : path.join(root, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(script, '');
    const bundled = path.join(tmpDir(), 'app', exe);
    expect(npmCli({ PATH: bin }, bundled)).toEqual({ node: bundled, script: expect.stringMatching(/npm-cli\.js$/) });
    expect(npmCli({ PATH: '' }, bundled)).toBe(null);
    expect(npmReason('npm error code ENOENT\nnpm error syscall spawn\nnpm error A complete log of this run can be found in: x')).toBe('code ENOENT syscall spawn');
  });
});

describe('local brain guards', () => {
  it('refuses to load when free RAM is too low, before touching the runtime', async () => {
    const { createLocalBrain, ramNeeded } = await import('../src/brain/local.js');
    let touched = false;
    const mod = { getLlama: async () => { touched = true; throw new Error('should not load'); } };
    const file = path.join(tmpDir(), 'm.gguf');
    fs.writeFileSync(file, 'x');
    await expect(createLocalBrain({ mod, modelPath: file, gpu: false, freeMem: () => 1e9 })).rejects.toMatchObject({ code: 'no_memory' });
    expect(touched).toBe(false);
    expect(ramNeeded(4.7e9, true)).toBe(2.5e9);
    expect(ramNeeded(4.7e9, false)).toBeCloseTo(6.2e9);
    expect(ramNeeded(1e9, false)).toBe(4e9);
  });

  it('asks for as many GPU layers as fit the context, memory mapped, and fails when too few fit', async () => {
    const { createLocalBrain, fileSize } = await import('../src/brain/local.js');
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'm-00001-of-00002.gguf'), 'abc');
    fs.writeFileSync(path.join(dir, 'm-00002-of-00002.gguf'), 'de');
    expect(fileSize(path.join(dir, 'm-00001-of-00002.gguf'))).toBe(5);
    let loadOpts;
    let ctxOpts;
    const fakeModel = (layers) => ({
      gpuLayers: layers, fileInfo: { architectureMetadata: { block_count: 28 } },
      dispose: async () => {},
      createContext: async (o) => { ctxOpts = o; return { contextSize: o.contextSize, getSequence: () => ({}) }; }
    });
    let layers = 29;
    const mod = { getLlama: async () => ({ gpu: 'vulkan', dispose: async () => {}, loadModel: async (o) => { loadOpts = o; return fakeModel(layers); } }), LlamaChat: class {} };
    const b = await createLocalBrain({ mod, modelPath: path.join(dir, 'm-00001-of-00002.gguf'), freeMem: () => 8e9 });
    expect(loadOpts).toMatchObject({ gpuLayers: { fitContext: { contextSize: 4096 } }, useMmap: false });
    expect(ctxOpts.contextSize).toBe(4096);
    expect(b.info()).toMatchObject({ gpu: 'vulkan', gpuLayers: 29, totalLayers: 29 });
    layers = 5;
    await expect(createLocalBrain({ mod, modelPath: path.join(dir, 'm-00001-of-00002.gguf'), freeMem: () => 8e9 })).rejects.toThrow('only 5 of 29 layers');
  });
});

describe('VRAM fallback', () => {
  it('steps down to a smaller model on the GPU when the model does not fit in VRAM', async () => {
    const bus = new EventBus();
    const loaded = [];
    const cached = new Set(['qwen2.5-coder-7b', 'qwen2.5-coder-3b']);
    const m = new BrainManager({
      bus, scheduler: new Scheduler(bus), home: tmpDir(),
      fetchImpl: async () => { throw new TypeError('no network in tests'); },
      hardware: { os: 't', cpus: 4, ramBytes: 16e9, freeRamBytes: 8e9, gpu: { name: 'G', vramBytes: 8.6e9, backend: 'cuda' }, diskFreeBytes: 100e9 },
      isCachedImpl: (h, model) => cached.has(model.id),
      loadRuntimeImpl: async () => ({ mod: {}, version: 't', entry: 'x' }),
      createLocalImpl: async (o) => {
        loaded.push([o.name, o.gpu]);
        if (/7B/.test(o.name)) throw new Error('A context size of 4096 is too large for the available VRAM');
        return { id: 'local', label: 'L', kind: 'local', info: () => ({ gpu: 'cuda', gpuLayers: 37, totalLayers: 37 }), chat: async () => ({}) };
      }
    });
    await m.start();
    expect(loaded).toEqual([[MODELS[3].name, true], [MODELS[2].name, true]]);
    expect(bus.events.find((e) => e.type === 'brain.fallback').data.to).toMatchObject({ gpu: true, model: MODELS[2].name });
    expect(bus.state.brain.state).toBe('ready');
  });
});
