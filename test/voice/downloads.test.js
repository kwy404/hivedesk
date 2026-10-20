// Voice downloads and process starts under faults: network, a missing asset, a bad hash, an antivirus
// quarantine, a program that cannot start, a taken port, and paths with spaces and accents.
import { describe, it, expect, afterEach, vi } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { VoiceStore } from '../../src/voice/store.js';
import { WhisperServer, startError } from '../../src/voice/whisper.js';
import { piperSpeak } from '../../src/voice/piper.js';
import { createVoiceEngine } from '../../src/voice/index.js';
import { sttRuntimesFor, TTS_RUNTIMES } from '../../src/voice/catalog.js';

const roots = [];
const servers = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});
function home() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hd voice '));
  roots.push(base);
  const h = path.join(base, 'José Ação', '.hivedesk');
  fs.mkdirSync(h, { recursive: true });
  return h;
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
function serve(handler) {
  const s = http.createServer(handler);
  servers.push(s);
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${s.address().port}`)));
}
const full = (body) => (req, res) => {
  const m = /bytes=(\d+)-/.exec(req.headers.range || '');
  const start = m ? Number(m[1]) : 0;
  res.writeHead(m ? 206 : 200, { 'content-length': body.length - start });
  res.end(body.subarray(start));
};

describe('voice downloads', () => {
  const model = crypto.randomBytes(120_000);
  const sttPkg = (url) => ({ id: 'tiny', kind: 'stt', name: 'Whisper tiny', file: 'ggml-tiny.bin', bytes: model.length, sha256: sha(model), url });

  it('the whisper model: no network, a drop then resume, 404, bad hash, each clear, then Retry works', async () => {
    const h = home();
    const store = new VoiceStore(h);
    const off = sttPkg('http://127.0.0.1:9/ggml-tiny.bin');
    store.grant(off);
    await expect(store.install(off)).rejects.toMatchObject({ code: 'no_network' });
    let n = 0;
    const url = await serve((req, res) => {
      if (req.url === '/gone') { res.writeHead(404); return res.end(); }
      if (n++ === 0) { res.writeHead(200, { 'content-length': model.length }); return res.write(model.subarray(0, 40_000), () => setTimeout(() => res.socket.destroy(), 20)); }
      full(model)(req, res);
    });
    const pkg = sttPkg(`${url}/ggml-tiny.bin`);
    store.grant(pkg);
    await expect(store.install(pkg)).rejects.toMatchObject({ code: 'no_network' });
    await store.install(pkg);
    expect(store.installed(pkg)).toBe(true);
    const gone = { ...sttPkg(`${url}/gone`), id: 'base', file: 'ggml-base.bin' };
    store.grant(gone);
    await expect(store.install(gone)).rejects.toMatchObject({ code: 'not_found', status: 404 });
    const bad = { ...sttPkg(`${url}/x`), id: 'small', file: 'ggml-small.bin', sha256: '0'.repeat(64) };
    store.grant(bad);
    await expect(store.install(bad)).rejects.toMatchObject({ code: 'checksum' });
    expect(fs.existsSync(path.join(h, 'voice', 'models', 'ggml-small.bin.part'))).toBe(false);
  });

  it('a Piper voice downloads both of its files', async () => {
    const h = home();
    const onnx = crypto.randomBytes(50_000);
    const json = Buffer.from('{"audio":{"sample_rate":22050}}');
    const url = await serve((req, res) => full(req.url.endsWith('.json') ? json : onnx)(req, res));
    const v = { id: 'v1', kind: 'tts', name: 'Voice', bytes: onnx.length + json.length, files: [
      { file: 'v.onnx', bytes: onnx.length, sha256: sha(onnx), url: `${url}/v.onnx` },
      { file: 'v.onnx.json', bytes: json.length, sha256: sha(json), url: `${url}/v.onnx.json` }] };
    const store = new VoiceStore(h);
    await expect(store.install(v)).rejects.toMatchObject({ code: 'needs_consent' });
    store.grant(v);
    await store.install(v);
    expect(store.installed(v)).toBe(true);
  });

  it('the whisper server archive: an antivirus quarantine says so, and Retry installs it', async () => {
    const h = home();
    const zip = crypto.randomBytes(20_000);
    const url = await serve(full(zip));
    const rt = { id: 'whisper-test', kind: 'stt-runtime', platform: process.platform, arch: process.arch, binary: 'whisper-server', name: 'whisper.cpp server (CPU)', file: 'w.zip', bytes: zip.length, sha256: sha(zip), url: `${url}/w.zip` };
    const store = new VoiceStore(h);
    store.grant(rt);
    const exe = process.platform === 'win32' ? 'whisper-server.exe' : 'whisper-server';
    // The antivirus removes the program as soon as it is unpacked.
    await expect(store.install(rt, { untar: async () => {} })).rejects.toMatchObject({ code: 'quarantined', message: expect.stringMatching(/antivirus/) });
    await store.install(rt, { untar: async (f, dir) => fs.writeFileSync(path.join(dir, exe), 'x') });
    expect(store.binaryOf(rt)).toBeTruthy();
  });

  it('a build for another platform, or an unknown asset, is refused before any download', () => {
    const e = createVoiceEngine({ home: home(), bus: { emit() {}, live() {} }, hardware: async () => ({}) });
    const other = [...sttRuntimesFor('linux', 'x64'), ...TTS_RUNTIMES].find((r) => r.platform !== process.platform);
    expect(() => e.consent({ id: other.id, yes: true })).toThrow(/another platform/);
    expect(() => e.consent({ id: 'no-such-asset', yes: true })).toThrow(/no such/);
    expect(() => e.consent({ id: 'tiny' })).toThrow(/yes: true/);
  });
});

describe('voice processes', () => {
  const h = () => home();
  function fakeChild() {
    const c = new EventEmitter();
    c.stdout = new EventEmitter();
    c.stderr = new EventEmitter();
    c.stdin = { end: () => {} };
    c.kill = () => c.emit('exit', 0);
    return c;
  }

  it('passes paths with spaces and accents as single arguments, never through a shell', async () => {
    const dir = h();
    const binary = path.join(dir, 'voice', 'runtime', 'whisper', 'whisper-server.exe');
    const modelFile = path.join(dir, 'voice', 'models', 'ggml-tiny.bin');
    const calls = [];
    const spawnImpl = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return fakeChild(); };
    const ws = new WhisperServer({ binary, model: modelFile, spawnImpl, fetchImpl: async () => ({ status: 200 }) });
    await ws.start();
    expect(calls[0].cmd).toBe(binary);
    expect(calls[0].args[calls[0].args.indexOf('-m') + 1]).toBe(modelFile);
    expect(calls[0].opts.shell).toBeFalsy();
    expect(calls[0].opts.cwd).toBe(path.dirname(binary));
    ws.stop();
    const pcalls = [];
    const pspawn = (cmd, args, opts) => { pcalls.push({ cmd, args, opts }); const c = fakeChild(); setTimeout(() => { c.stdout.emit('data', Buffer.alloc(200)); c.emit('close', 0); }, 5); return c; };
    const voice = path.join(dir, 'voice', 'voices', 'pt_BR-faber-medium.onnx');
    await piperSpeak({ binary: path.join(dir, 'piper', 'piper.exe'), model: voice, config: `${voice}.json`, text: 'Olá', spawnImpl: pspawn });
    expect(pcalls[0].args[pcalls[0].args.indexOf('-m') + 1]).toBe(voice);
    expect(pcalls[0].opts.shell).toBeFalsy();
  });

  it('a program gone (quarantined) or blocked fails at once with a clear code, not after a minute', async () => {
    for (const [code, want] of [['ENOENT', 'stt_missing'], ['EPERM', 'stt_blocked']]) {
      const spawnImpl = () => { const c = fakeChild(); setTimeout(() => c.emit('error', Object.assign(new Error(`spawn ${code}`), { code })), 5); return c; };
      const ws = new WhisperServer({ binary: 'C:\\x y\\whisper-server.exe', model: 'm', spawnImpl, fetchImpl: async () => { throw new Error('down'); } });
      const t0 = Date.now();
      await expect(ws.start()).rejects.toMatchObject({ code: want });
      expect(Date.now() - t0).toBeLessThan(3000);
    }
    const pspawn = () => { const c = fakeChild(); setTimeout(() => { c.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })); c.emit('close', -2); }, 5); return c; };
    await expect(piperSpeak({ binary: 'p', model: 'm', config: 'c', text: 'hi', spawnImpl: pspawn })).rejects.toMatchObject({ code: 'tts_missing' });
  });

  it('an exe that cannot start says why, never only an exit code', () => {
    expect(startError(3221225781, '', null, 'w').message).toMatch(/DLL/);
    expect(startError(-1073741515, '', null, 'w').code).toBe('stt_start');
    expect(startError(3221225501, '', null, 'w').message).toMatch(/processor/);
    expect(startError(1, 'error: failed to load model', null, 'w').code).toBe('stt_model');
  });

  it('a port taken between the probe and the bind: another port, and the turn goes on', async () => {
    let n = 0;
    const ports = [];
    const spawnImpl = (cmd, args) => {
      ports.push(args[args.indexOf('--port') + 1]);
      const c = fakeChild();
      if (n++ === 0) setTimeout(() => { c.stderr.emit('data', "main: couldn't bind to server socket: hostname=127.0.0.1 port=5000\n"); c.emit('exit', 1); }, 5);
      return c;
    };
    let up = false;
    const ws = new WhisperServer({ binary: 'w', model: 'm', spawnImpl, fetchImpl: async () => { if (n < 2) throw new Error('down'); up = true; return { status: 200 }; } });
    await ws.start();
    expect(up).toBe(true);
    expect(ports.length).toBe(2);
    ws.stop();
  });
});
