// Nothing downloads without a yes; resume and SHA-256 for split files; the models.* commands.
import { describe, it, expect } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BrainManager } from '../../src/brain/manager.js';
import { downloadModel, isCached, MODELS } from '../../src/brain/models.js';
import { ConsentStore, downloadGate } from '../../src/brain/catalog/consent.js';
import { registerModelCommands } from '../../src/brain/catalog/commands.js';
import { pick } from '../../src/brain/catalog/index.js';
import { EventBus } from '../../src/bus.js';
import { Scheduler } from '../../src/crew/scheduler.js';
import { tmpDir, waitFor } from '../helpers.js';

const GB = 1e9;
const HW = { os: 'test', cpus: 4, ramBytes: 16 * GB, freeRamBytes: 8 * GB, diskFreeBytes: 100 * GB, gpu: { name: 'Test GPU', vramBytes: 6.4 * GB, backend: 'cuda' }, cpu: { cores: 4, threads: 4, avx2: true } };

function make(opts = {}) {
  const bus = new EventBus();
  const scheduler = new Scheduler(bus);
  const home = opts.home || tmpDir();
  const fetched = [];
  const loaded = [];
  const cached = new Set(opts.cached || []);
  const m = new BrainManager({
    bus, scheduler, home, hardware: opts.hardware || HW, flags: { brain: 'local', ...(opts.flags || {}) },
    isCachedImpl: (h, model) => cached.has(model.id),
    fetchImpl: async (u) => {
      fetched.push(String(u));
      const e = new TypeError('fetch failed');
      e.cause = { code: 'ECONNREFUSED' };
      throw e;
    },
    loadRuntimeImpl: async () => ({ mod: {}, version: 't', entry: 'x' }),
    createLocalImpl: async (o) => { loaded.push(o); return { id: 'local', label: 'L', kind: 'local', info: () => ({ gpu: 'cuda', gpuLayers: 29, totalLayers: 29, contextSize: 4096 }), chat: async () => ({}) }; }
  });
  return { bus, m, home, fetched, loaded, cached };
}

const hf = (list) => list.filter((u) => u.includes('huggingface.co'));

describe('consent before any download', () => {
  it('an automatic first start downloads nothing and asks', async () => {
    const t = make();
    await t.m.start();
    expect(hf(t.fetched)).toEqual([]);
    expect(t.bus.state.brain).toMatchObject({ state: 'needs_download', consent: true });
    const ask = t.bus.events.find((e) => e.type === 'models.consent.required');
    expect(ask.data).toMatchObject({ reason: 'needs_consent', trigger: 'auto' });
    expect(ask.data.license).toMatchObject({ name: expect.any(String) });
    expect(ask.data.bytes).toBeGreaterThan(1e8);
    expect(t.loaded).toEqual([]);
    const a = await t.m.analyze();
    expect(a.pending.id).toBe(ask.data.id);
    expect(a.firstLaunch).toBeNull();
  });

  it('choosing a model in Settings is not a yes: it asks with trigger user', async () => {
    const t = make();
    t.m.select({ backend: 'local', model: 'qwen2.5-coder-7b:Q3_K_M' });
    await waitFor(() => t.bus.events.some((e) => e.type === 'models.consent.required'));
    await t.m.running;
    expect(hf(t.fetched)).toEqual([]);
    expect(t.bus.events.find((e) => e.type === 'models.consent.required').data).toMatchObject({ id: 'qwen2.5-coder-7b:Q3_K_M', trigger: 'user' });
  });

  it('the yes (models.consent) is remembered, then the download starts', async () => {
    const t = make();
    await t.m.start();
    const id = t.bus.events.find((e) => e.type === 'models.consent.required').data.id;
    t.m.consentTo({ id, via: 'dialog', answer: 'recommended' });
    await waitFor(() => t.bus.events.some((e) => e.type === 'brain.download.failed'));
    expect(hf(t.fetched)[0]).toBe(pick(...id.split(':')).url);
    const saved = JSON.parse(fs.readFileSync(path.join(t.home, 'models', 'consent.json'), 'utf8'));
    expect(saved.accepted[id]).toMatchObject({ via: 'dialog' });
    expect(saved.accepted[id].sha256).toHaveLength(1);
    expect(saved.firstLaunch.answer).toBe('recommended');
    expect(saved.selected).toBe(id);
    expect(t.bus.events.find((e) => e.type === 'models.consent.given').data.id).toBe(id);
  });

  it('a model named on the command line is a yes', async () => {
    const t = make({ flags: { model: '3b' } });
    await t.m.start();
    expect(hf(t.fetched)[0]).toBe(pick('qwen2.5-coder-3b', 'Q4_K_M').url);
    expect(MODELS[2].file).toBe(pick('qwen2.5-coder-3b', 'Q4_K_M').file);
    expect(t.bus.events.some((e) => e.type === 'models.consent.required')).toBe(false);
  });

  it('"Agora nao" records the answer and downloads nothing; --no-download never downloads', async () => {
    const t = make();
    await t.m.start();
    expect(t.m.later().firstLaunch.answer).toBe('later');
    expect(hf(t.fetched)).toEqual([]);
    expect(new ConsentStore(t.home).firstLaunch.answer).toBe('later');
    const store = new ConsentStore(tmpDir());
    const p = pick('qwen2.5-coder-3b', 'Q4_K_M');
    store.grant(p, 'models');
    expect(downloadGate(p, { store, noDownload: true })).toEqual({ ok: false, reason: 'no_download' });
    expect(downloadGate(p, { store })).toEqual({ ok: true });
  });

  it('a yes is for one exact file: another checksum asks again', () => {
    const store = new ConsentStore(tmpDir());
    const p = pick('qwen2.5-coder-7b', 'IQ4_XS');
    expect(store.has(p)).toBe(false);
    store.grant(p, 'card');
    expect(store.has(p)).toBe(true);
    expect(store.has({ ...p, files: [{ ...p.files[0], sha256: 'f'.repeat(64) }] })).toBe(false);
    expect(() => store.grant(p, 'a web page')).toThrow(/unknown consent source/);
    expect(store.revoke(p.id)).toBe(true);
    expect(store.has(p)).toBe(false);
  });

  it('a step down after a GPU failure asks before downloading the smaller model', async () => {
    const bus = new EventBus();
    const home = tmpDir();
    const fetched = [];
    const m = new BrainManager({
      bus, scheduler: new Scheduler(bus), home, hardware: HW, flags: { brain: 'local' },
      isCachedImpl: (h, model) => model.id === 'qwen2.5-coder-3b:Q4_K_M' || model.id === 'qwen2.5-coder-3b',
      fetchImpl: async (u) => { fetched.push(String(u)); throw new TypeError('no network'); },
      loadRuntimeImpl: async () => ({ mod: {}, version: 't', entry: 'x' }),
      createLocalImpl: async (o) => { if (o.gpu) throw new Error('CUDA failed to initialize'); return { id: 'local', info: () => ({}), chat: async () => ({}) }; }
    });
    await m.start();
    expect(hf(fetched)).toEqual([]);
    const ask = bus.events.find((e) => e.type === 'models.consent.required');
    expect(ask.data).toMatchObject({ id: 'qwen2.5-coder-1.5b:Q4_K_M', trigger: 'fallback' });
  });

  it('deletes a downloaded model that is not in use and forgets its yes', async () => {
    const home = tmpDir();
    const p = pick('qwen2.5-coder-0.5b', 'Q4_K_M');
    fs.mkdirSync(path.join(home, 'models'), { recursive: true });
    fs.writeFileSync(path.join(home, 'models', p.file), 'xx');
    fs.writeFileSync(path.join(home, 'models', p.file + '.part'), 'y');
    const t = make({ home });
    t.m.consent.grant(p, 'models');
    const r = await t.m.deleteModel(p.id);
    expect(r).toEqual({ id: p.id, freed: 3 });
    expect(fs.existsSync(path.join(home, 'models', p.file))).toBe(false);
    expect(t.m.consent.has(p)).toBe(false);
    await expect(t.m.deleteModel('nope:Q4_K_M')).rejects.toThrow(/catalog/);
  });
});

describe('download of split files: resume and SHA-256', () => {
  it('resumes a cut part, skips finished parts, and deletes a corrupt one', async () => {
    const a = crypto.randomBytes(200_000);
    const b = crypto.randomBytes(150_000);
    const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');
    const ranges = [];
    const s = http.createServer((req, res) => {
      const body = req.url.includes('p1') ? a : b;
      const r = req.headers.range;
      ranges.push([req.url, r || null]);
      if (r) {
        const start = Number(r.match(/bytes=(\d+)-/)[1]);
        res.writeHead(206, { 'content-length': body.length - start });
        return res.end(body.subarray(start));
      }
      res.writeHead(200, { 'content-length': body.length });
      res.end(body);
    });
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${s.address().port}`;
    const home = tmpDir();
    const model = {
      id: 'split:Q8_0', name: 'Split', bytes: a.length + b.length,
      files: [
        { file: 'm-00001-of-00002.gguf', bytes: a.length, sha256: sha(a), url: `${url}/p1` },
        { file: 'm-00002-of-00002.gguf', bytes: b.length, sha256: sha(b), url: `${url}/p2` }
      ]
    };
    fs.mkdirSync(path.join(home, 'models'), { recursive: true });
    fs.writeFileSync(path.join(home, 'models', 'm-00001-of-00002.gguf.part'), a.subarray(0, 5000));
    const seen = [];
    const out = await downloadModel(model, { home, onProgress: (p) => seen.push(p) });
    expect(out).toBe(path.join(home, 'models', 'm-00001-of-00002.gguf'));
    expect(ranges[0]).toEqual(['/p1', 'bytes=5000-']);
    expect(fs.readFileSync(path.join(home, 'models', 'm-00002-of-00002.gguf')).equals(b)).toBe(true);
    expect(seen.at(-1)).toMatchObject({ received: model.bytes, total: model.bytes, part: 2, parts: 2 });
    expect(isCached(home, model)).toBe(true);
    // Again: both parts are there, nothing is fetched.
    ranges.length = 0;
    await downloadModel(model, { home });
    expect(ranges).toEqual([]);
    // A corrupt second part: deleted, the first part stays.
    const bad = { ...model, id: 'bad', files: [model.files[0], { ...model.files[1], file: 'bad-2.gguf', sha256: '0'.repeat(64) }] };
    await expect(downloadModel(bad, { home })).rejects.toMatchObject({ code: 'checksum' });
    expect(fs.existsSync(path.join(home, 'models', 'bad-2.gguf.part'))).toBe(false);
    expect(fs.existsSync(path.join(home, 'models', 'm-00001-of-00002.gguf'))).toBe(true);
    s.close();
  });

  it('keeps a short body as a part to resume, and checks the disk first', async () => {
    const data = crypto.randomBytes(100_000);
    const s = http.createServer((req, res) => { res.writeHead(200); res.end(data.subarray(0, 40_000)); });
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    const home = tmpDir();
    const model = { id: 'short', name: 'Short', file: 's.gguf', bytes: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex'), url: `http://127.0.0.1:${s.address().port}/s` };
    await expect(downloadModel(model, { home })).rejects.toMatchObject({ code: 'no_network' });
    expect(fs.statSync(path.join(home, 'models', 's.gguf.part')).size).toBe(40_000);
    await expect(downloadModel({ ...model, id: 'big', file: 'big.gguf', bytes: 5e9 }, { home, freeBytes: 1e9 })).rejects.toMatchObject({ code: 'no_disk' });
    s.close();
  });
});

describe('models.* commands', () => {
  class CommandError extends Error { constructor(code, message) { super(message); this.code = code; } }
  function rig(brains) {
    const cmds = new Map();
    const bus = new EventBus();
    registerModelCommands((type, fn) => cmds.set(type, fn), () => brains, CommandError, bus);
    return (type, d) => cmds.get(type)(d);
  }

  it('lists the catalog without download URLs', async () => {
    const run = rig(null);
    const c = await run('models.catalog', {});
    expect(c.models.length).toBeGreaterThanOrEqual(40);
    expect(JSON.stringify(c)).not.toMatch(/resolve\//);
    await expect(run('models.analyze', {})).rejects.toMatchObject({ code: 'conflict' });
  });

  it('refuses a consent without yes: true from the user', async () => {
    const t = make();
    const run = rig(t.m);
    await expect(run('models.consent', { id: 'qwen2.5-coder-3b:Q4_K_M' })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(run('models.consent', { id: 'nope:Q4_K_M', yes: true })).rejects.toMatchObject({ code: 'not_found' });
    expect(hf(t.fetched)).toEqual([]);
    const r = await run('models.consent', { id: 'qwen2.5-coder-3b:Q4_K_M', yes: true, via: 'models' });
    expect(r.id).toBe('qwen2.5-coder-3b:Q4_K_M');
    await waitFor(() => hf(t.fetched).length > 0);
  });

  it('the pool meter never says runnable, and execution is off by default', async () => {
    const t = make();
    const run = rig(t.m);
    const p = await run('models.pool', { id: 'llama-3.3-70b:Q4_K_M', ctx: 4096 });
    expect(p).toMatchObject({ runnable: false, execution: 'off', unlocked: false });
    expect(p.need).toBeGreaterThan(40 * GB);
    expect(p.missing).toBe(p.need - p.total);
    expect(p.sharedVram + p.sharedRam).toBe(0);
  });
});

describe('the install queue, disk use and the router commands', () => {
  class CommandError extends Error { constructor(code, message) { super(message); this.code = code; } }

  it('installs several models one after the other, with a yes for each, without switching the model', async () => {
    const t = make({ flags: { model: '3b' } });
    const a = t.m.install('qwen2.5-coder-0.5b:Q4_K_M');
    const b = t.m.install('qwen2.5-coder-1.5b:Q4_K_M');
    expect(a).toMatchObject({ queued: true });
    expect(b).toMatchObject({ queued: true });
    expect(t.m.install('qwen2.5-coder-1.5b:Q4_K_M')).toMatchObject({ queued: true });
    await waitFor(() => t.bus.events.filter((e) => e.type === 'models.install.failed').length === 2);
    const order = t.bus.events.filter((e) => e.type === 'models.install.started').map((e) => e.data.id);
    expect(order).toEqual(['qwen2.5-coder-0.5b:Q4_K_M', 'qwen2.5-coder-1.5b:Q4_K_M']);
    expect(t.m.consent.has(pick('qwen2.5-coder-0.5b', 'Q4_K_M'))).toBe(true);
    expect(t.bus.events.some((e) => e.type === 'brain.choice' && /0\.5B/.test(e.data.model))).toBe(false);
    expect(() => t.m.install('nope:Q4_K_M')).toThrow(/catalog/);
    const d = t.m.disk();
    expect(d).toMatchObject({ total: expect.any(Number), files: expect.any(Array) });
    expect(t.m.queueState()).toEqual({ current: null, waiting: [] });
  });

  it('models.install needs yes: true, models.router.set changes and keeps the settings', async () => {
    const t = make();
    const cmds = new Map();
    registerModelCommands((type, fn) => cmds.set(type, fn), () => t.m, CommandError, t.bus);
    await expect(cmds.get('models.install')({ id: 'qwen2.5-coder-0.5b:Q4_K_M' })).rejects.toMatchObject({ code: 'bad_request' });
    const r = await cmds.get('models.router.set')({ auto: false, pins: { qa: 'qwen2.5-coder-3b' }, maxResident: 3 });
    expect(r).toMatchObject({ auto: false, maxResident: 3, pins: { qa: 'qwen2.5-coder-3b:Q4_K_M' } });
    expect(JSON.parse(fs.readFileSync(path.join(t.home, 'models', 'router.json'), 'utf8')).auto).toBe(false);
    expect(t.bus.events.find((e) => e.type === 'models.router.changed').data.auto).toBe(false);
    const g = await cmds.get('models.router.get')({});
    expect(g.preview).toEqual([]);
  });
});
