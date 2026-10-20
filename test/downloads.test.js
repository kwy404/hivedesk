// Every way a model download can fail, against a local HTTP server that injects the fault, in a home
// folder with spaces and non ASCII letters. Each failure has a clear code and message, leaves nothing
// corrupt behind, and a Retry afterwards works.
import { describe, it, expect, afterEach, vi } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { downloadModel, isCached, DownloadError } from '../src/brain/models.js';
import { installRuntime, RuntimeError } from '../src/brain/runtime.js';
import { BrainManager } from '../src/brain/manager.js';
import { EventBus } from '../src/bus.js';
import { Scheduler } from '../src/crew/scheduler.js';

const homes = [];
function home() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hd dl '));
  const h = path.join(base, 'José Ação', '.hivedesk');
  fs.mkdirSync(h, { recursive: true });
  homes.push(base);
  return h;
}
const servers = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const s of servers.splice(0)) s.close();
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
});

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const data = crypto.randomBytes(256 * 1024);
const model = (url, extra = {}) => ({ id: 'fake', name: 'Fake model', file: 'fake.gguf', bytes: data.length, sha256: sha(data), url, ...extra });

/** A file server: `plan` is a list of handlers used one per request (the last one repeats). */
function serve(plan, body = data) {
  const seen = [];
  const s = http.createServer((req, res) => {
    seen.push({ url: req.url, range: req.headers.range || null });
    const step = plan.length > 1 ? plan.shift() : plan[0];
    step(req, res, body);
  });
  servers.push(s);
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${s.address().port}`, seen })));
}
const ok = (req, res, body) => {
  const m = /bytes=(\d+)-/.exec(req.headers.range || '');
  const start = m ? Number(m[1]) : 0;
  if (start >= body.length) { res.writeHead(416, { 'content-range': `bytes */${body.length}` }); return res.end(); }
  res.writeHead(m ? 206 : 200, { 'content-length': body.length - start, ...(m ? { 'content-range': `bytes ${start}-${body.length - 1}/${body.length}` } : {}) });
  res.end(body.subarray(start));
};
const status = (code, headers = {}) => (req, res) => { res.writeHead(code, headers); res.end('no'); };
const drop = (at) => (req, res, body) => {
  res.writeHead(200, { 'content-length': body.length });
  res.write(body.subarray(0, at), () => setTimeout(() => res.socket.destroy(), 20));
};
const shortBody = (at) => (req, res, body) => { res.writeHead(200, {}); res.end(body.subarray(0, at)); };
const lyingLength = (req, res, body) => { res.writeHead(200, { 'content-length': body.length + 5000 }); res.end(body); };

async function fail(p) {
  try { await p; } catch (err) { return err; }
  throw new Error('expected a failure');
}
const dir = (h) => path.join(h, 'models');

describe('model download faults', () => {
  it('no network at start: no_network naming the host, nothing written, Retry works', async () => {
    const h = home();
    const err = await fail(downloadModel(model('http://127.0.0.1:9/m.gguf'), { home: h, freeBytes: 1e12 }));
    expect(err).toBeInstanceOf(DownloadError);
    expect(err.code).toBe('no_network');
    expect(err.message).toMatch(/127\.0\.0\.1/);
    expect(err.message).not.toMatch(/huggingface/);
    const { url } = await serve([ok]);
    await downloadModel(model(`${url}/m.gguf`), { home: h, freeBytes: 1e12 });
    expect(isCached(h, model(''))).toBe(true);
  });

  it('the connection drops mid download, then Retry resumes with a range', async () => {
    const h = home();
    const { url, seen } = await serve([drop(100_000), ok]);
    const err = await fail(downloadModel(model(`${url}/m.gguf`), { home: h, freeBytes: 1e12 }));
    expect(err.code).toBe('no_network');
    expect(fs.statSync(path.join(dir(h), 'fake.gguf.part')).size).toBeGreaterThan(0);
    const out = await downloadModel(model(`${url}/m.gguf`), { home: h, freeBytes: 1e12 });
    expect(fs.readFileSync(out).equals(data)).toBe(true);
    expect(seen[1].range).toMatch(/^bytes=\d+-$/);
  });

  it.each([
    [404, 'not_found'],
    [403, 'forbidden'],
    [500, 'server'],
    [503, 'server']
  ])('HTTP %i ends in %s with a clear message, then Retry works', async (code, want) => {
    const h = home();
    const { url } = await serve([status(code), ok]);
    const err = await fail(downloadModel(model(`${url}/m.gguf`), { home: h, freeBytes: 1e12, retryDelayMs: 1 }));
    expect(err.code).toBe(want);
    expect(err.message).toContain(String(code));
    expect(err.hint).toMatch(/Retry|another model/);
    expect(fs.existsSync(path.join(dir(h), 'fake.gguf'))).toBe(false);
    await downloadModel(model(`${url}/m.gguf`), { home: h, freeBytes: 1e12 });
    expect(isCached(h, model(''))).toBe(true);
  });

  it('429 with a short Retry-After waits and goes on; a long one ends in rate_limited', async () => {
    const h = home();
    const { url, seen } = await serve([status(429, { 'retry-after': '1' }), ok]);
    const t0 = Date.now();
    await downloadModel(model(`${url}/m.gguf`), { home: h, freeBytes: 1e12 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
    expect(seen.length).toBe(2);
    const h2 = home();
    const s2 = await serve([status(429, { 'retry-after': '3600' })]);
    const err = await fail(downloadModel(model(`${s2.url}/m.gguf`), { home: h2, freeBytes: 1e12 }));
    expect(err.code).toBe('rate_limited');
    expect(err.retryAfter).toBe(3600);
  });

  it('follows a CDN style redirect chain and keeps the range on resume', async () => {
    const h = home();
    const redirect = (to) => (req, res) => { res.writeHead(302, { location: to }); res.end(); };
    const { url, seen } = await serve([redirect('/a'), redirect('/b?sig=1'), drop(50_000), redirect('/a'), redirect('/b?sig=2'), ok]);
    await fail(downloadModel(model(`${url}/m.gguf`), { home: h, freeBytes: 1e12 }));
    const out = await downloadModel(model(`${url}/m.gguf`), { home: h, freeBytes: 1e12 });
    expect(fs.readFileSync(out).equals(data)).toBe(true);
    expect(seen.at(-1)).toMatchObject({ url: '/b?sig=2', range: expect.stringMatching(/^bytes=\d+-/) });
  });

  it('a wrong Content-Length and a truncated body keep the part, and Retry finishes it', async () => {
    for (const first of [lyingLength, shortBody(70_000)]) {
      const h = home();
      const { url } = await serve([first, ok]);
      const err = await fail(downloadModel(model(`${url}/m.gguf`), { home: h, freeBytes: 1e12 }));
      expect(err.code).toBe('no_network');
      expect(fs.existsSync(path.join(dir(h), 'fake.gguf'))).toBe(false);
      const out = await downloadModel(model(`${url}/m.gguf`), { home: h, freeBytes: 1e12 });
      expect(fs.readFileSync(out).equals(data)).toBe(true);
    }
  });

  it('a SHA-256 mismatch deletes the file and says so', async () => {
    const h = home();
    const { url } = await serve([ok]);
    const err = await fail(downloadModel(model(`${url}/m.gguf`, { sha256: '0'.repeat(64) }), { home: h, freeBytes: 1e12 }));
    expect(err.code).toBe('checksum');
    expect(err.message).toMatch(/corrupt/);
    expect(err.hint).toMatch(/deleted/);
    expect(fs.readdirSync(dir(h))).toEqual([]);
  });

  it('a part file left by a crash: partial resumes, complete is verified without a request, oversize starts over', async () => {
    const { url, seen } = await serve([ok]);
    const h = home();
    fs.mkdirSync(dir(h), { recursive: true });
    fs.writeFileSync(path.join(dir(h), 'fake.gguf.part'), data);
    const out = await downloadModel(model(`${url}/m.gguf`), { home: h, freeBytes: 1e12 });
    expect(fs.readFileSync(out).equals(data)).toBe(true);
    expect(seen.length).toBe(0);
    // A complete part with the wrong bytes is dropped and downloaded again.
    const h2 = home();
    fs.mkdirSync(dir(h2), { recursive: true });
    fs.writeFileSync(path.join(dir(h2), 'fake.gguf.part'), Buffer.alloc(data.length));
    const out2 = await downloadModel(model(`${url}/m.gguf`), { home: h2, freeBytes: 1e12 });
    expect(fs.readFileSync(out2).equals(data)).toBe(true);
    const h3 = home();
    fs.mkdirSync(dir(h3), { recursive: true });
    fs.writeFileSync(path.join(dir(h3), 'fake.gguf.part'), Buffer.alloc(data.length + 10));
    const out3 = await downloadModel(model(`${url}/m.gguf`), { home: h3, freeBytes: 1e12 });
    expect(fs.readFileSync(out3).equals(data)).toBe(true);
  });

  it('not enough free space is checked before starting and writes nothing', async () => {
    const h = home();
    const { url, seen } = await serve([ok]);
    const err = await fail(downloadModel(model(`${url}/m.gguf`), { home: h, freeBytes: 1000 }));
    expect(err.code).toBe('no_disk');
    expect(err.hint).toMatch(/Free some space/);
    expect(seen.length).toBe(0);
    expect(fs.readdirSync(dir(h))).toEqual([]);
  });

  it('the disk fills up while writing: no_disk, the part stays for Retry, no crash', async () => {
    const h = home();
    const { url } = await serve([ok]);
    const real = fs.createWriteStream;
    vi.spyOn(fs, 'createWriteStream').mockImplementationOnce((file, o) => {
      const w = real(file, o);
      const write = w.write.bind(w);
      let n = 0;
      w.write = (c, ...rest) => { if (++n === 2) { process.nextTick(() => w.destroy(Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }))); return false; } return write(c, ...rest); };
      return w;
    });
    const err = await fail(downloadModel(model(`${url}/m.gguf`), { home: h, freeBytes: 1e12 }));
    expect(err.code).toBe('no_disk');
    expect(fs.existsSync(path.join(dir(h), 'fake.gguf'))).toBe(false);
    await downloadModel(model(`${url}/m.gguf`), { home: h, freeBytes: 1e12 });
    expect(isCached(h, model(''))).toBe(true);
  });

  it('a part file that cannot be opened (locked) ends in locked, with no crash', async () => {
    const h = home();
    const { url } = await serve([ok]);
    fs.mkdirSync(path.join(dir(h), 'fake.gguf.part'), { recursive: true });
    const err = await fail(downloadModel(model(`${url}/m.gguf`), { home: h, freeBytes: 1e12 }));
    expect(['locked', 'io']).toContain(err.code);
    expect(err).toBeInstanceOf(DownloadError);
    expect(err.hint).toMatch(/Retry/);
  });

  it('the target file locked by an antivirus (EBUSY, EPERM): retried, then locked; Retry finishes without downloading again', async () => {
    const h = home();
    const { url, seen } = await serve([ok]);
    const busy = (code) => () => { throw Object.assign(new Error(`${code}: resource busy or locked, rename`), { code }); };
    // A short lock is waited out.
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(busy('EBUSY'));
    await downloadModel(model(`${url}/m.gguf`), { home: h, freeBytes: 1e12, retryDelayMs: 1 });
    expect(isCached(h, model(''))).toBe(true);
    vi.restoreAllMocks();
    // A lock that stays: a clear message, the verified part is kept, the next try only renames it.
    const h2 = home();
    vi.spyOn(fs, 'renameSync').mockImplementation(busy('EPERM'));
    const err = await fail(downloadModel(model(`${url}/m.gguf`), { home: h2, freeBytes: 1e12, retryDelayMs: 1 }));
    expect(err.code).toBe('locked');
    expect(err.hint).toMatch(/antivirus/i);
    vi.restoreAllMocks();
    const before = seen.length;
    await downloadModel(model(`${url}/m.gguf`), { home: h2, freeBytes: 1e12 });
    expect(isCached(h2, model(''))).toBe(true);
    expect(seen.length).toBe(before);
  });

  it('two downloads of the same model at once share one file and both succeed', async () => {
    const h = home();
    const { url, seen } = await serve([ok]);
    const [a, b] = await Promise.all([
      downloadModel(model(`${url}/m.gguf`), { home: h, freeBytes: 1e12 }),
      downloadModel(model(`${url}/m.gguf`), { home: h, freeBytes: 1e12 })
    ]);
    expect(a).toBe(b);
    expect(fs.readFileSync(a).equals(data)).toBe(true);
    expect(seen.length).toBe(1);
  });

  it('cancel during the download, then download again resumes', async () => {
    const h = home();
    const slow = (req, res, body) => { res.writeHead(200, { 'content-length': body.length }); res.write(body.subarray(0, 60_000)); };
    const { url } = await serve([slow, ok]);
    const ctrl = new AbortController();
    const p = downloadModel(model(`${url}/m.gguf`), { home: h, freeBytes: 1e12, signal: ctrl.signal, onProgress: () => {} });
    setTimeout(() => ctrl.abort(), 300);
    const err = await fail(p);
    expect(err.code).toBe('aborted');
    const out = await downloadModel(model(`${url}/m.gguf`), { home: h, freeBytes: 1e12 });
    expect(fs.readFileSync(out).equals(data)).toBe(true);
  });

  it('a multi part GGUF downloads every part, resumes in the second, and loads the first', async () => {
    const h = home();
    const a = data.subarray(0, 100_000);
    const b = data.subarray(100_000);
    let n = 0;
    const s = http.createServer((req, res) => {
      const body = req.url.includes('x-00002') ? b : a;
      if (req.url.includes('x-00002') && n++ === 0) return drop(30_000)(req, res, body);
      ok(req, res, body);
    });
    servers.push(s);
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${s.address().port}`;
    const split = { name: 'Split', files: [
      { file: 'x-00001-of-00002.gguf', bytes: a.length, sha256: sha(a), url: `${url}/x-00001-of-00002.gguf` },
      { file: 'x-00002-of-00002.gguf', bytes: b.length, sha256: sha(b), url: `${url}/x-00002-of-00002.gguf` }
    ] };
    const parts = [];
    await fail(downloadModel(split, { home: h, freeBytes: 1e12, onProgress: (p) => parts.push(p.part) }));
    const out = await downloadModel(split, { home: h, freeBytes: 1e12 });
    expect(path.basename(out)).toBe('x-00001-of-00002.gguf');
    expect(fs.readFileSync(path.join(dir(h), 'x-00002-of-00002.gguf')).equals(b)).toBe(true);
  });
});

describe('runtime install faults', () => {
  const fakeSpawn = (tail, code = 1) => (cmd, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setTimeout(() => { child.stderr.emit('data', tail); child.emit('close', code); }, 5);
    return child;
  };
  it('npm 404 and EBUSY say what happened and never only an exit code', async () => {
    for (const [tail, want] of [['npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/node-llama-cpp\n', /404/], ['npm error code EBUSY\nnpm error EBUSY: resource busy or locked, rename\n', /EBUSY|locked/]]) {
      const h = home();
      const err = await fail(installRuntime(h, { spawnImpl: fakeSpawn(tail) }));
      expect(err).toBeInstanceOf(RuntimeError);
      expect(err.message).toMatch(want);
      expect(err.message).not.toMatch(/exit code/);
      expect(err.hint).toBeTruthy();
    }
  });
});

describe('brain manager: download then load', () => {
  const GB = 1e9;
  const hw = { os: 'test', cpus: 8, ramBytes: 16 * GB, freeRamBytes: 8 * GB, gpu: { name: 'GTX 1060', vramBytes: 6.4 * GB, backend: 'cuda' }, diskFreeBytes: 100 * GB };
  function make(h, fetchImpl, createLocal) {
    const bus = new EventBus();
    const scheduler = new Scheduler(bus);
    const m = new BrainManager({ bus, scheduler, home: h, hardware: hw, fetchImpl,
      loadRuntimeImpl: async () => ({ mod: {}, version: 'test', entry: 'x' }),
      createLocalImpl: createLocal || (async (o) => ({ id: 'local', label: 'Local', kind: 'local', info: () => ({ model: o.name, gpu: 'cuda', gpuLayers: 25, totalLayers: 25, contextSize: 4096 }), chat: async () => ({ text: '' }) })) });
    return { bus, m };
  }

  it('a failed download carries its code in the status, Retry downloads and loads the model', async () => {
    const h = home();
    let fails = 1;
    const fetchImpl = async (u, init) => {
      if (fails-- > 0) { const e = new TypeError('fetch failed'); e.cause = { code: 'ECONNRESET' }; throw e; }
      return new Response(data, { status: 200, headers: { 'content-length': String(data.length) } });
    };
    const { bus, m } = make(h, fetchImpl);
    const pick = { id: 'fake-test', name: 'Fake model', quant: 'T', file: 'fake.gguf', bytes: data.length, source: 'test', files: [{ file: 'fake.gguf', bytes: data.length, sha256: sha(data), url: 'http://127.0.0.1:1/m.gguf' }] };
    m.cliConsent.add(pick.id);
    const f1 = await m._ensureModel(pick);
    expect(f1).toBe(null);
    expect(bus.state.brain).toMatchObject({ state: 'error', code: 'no_network' });
    const f2 = await m._ensureModel(pick);
    expect(fs.readFileSync(f2).equals(data)).toBe(true);
  });

  it('not enough RAM or VRAM to load ends in a clear error with the code', async () => {
    const h = home();
    const { MemoryError } = await import('../src/brain/local.js');
    const { bus, m } = make(h, null, async () => { throw new MemoryError('Not enough free RAM to load the model: 1.0 GB free, 2.0 GB needed.', 'Close other apps or use a smaller model.'); });
    await m._load({ mod: {} }, path.join(h, 'x.gguf'), 'X', false, null);
    expect(bus.state.brain).toMatchObject({ state: 'error', code: 'no_memory' });
    expect(bus.state.brain.hint).toMatch(/smaller model/);
  });
});
