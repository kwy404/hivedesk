// The engine side of voice mode: the catalog and the hardware recommendation, the consent gate of
// every download, the whisper.cpp server process, the HTTP endpoints, and the streamed answer.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { STT_MODELS, STT_RUNTIMES, TTS_RUNTIMES, TTS_VOICES, recommendStt } from '../../src/voice/catalog.js';
import { VoiceStore } from '../../src/voice/store.js';
import { createVoiceEngine, registerVoice, voiceStrings } from '../../src/voice/index.js';
import { WhisperServer, cleanTranscript } from '../../src/voice/whisper.js';
import { VoiceReplies, voiceIntent } from '../../src/voice/reply.js';
import { pcmToWav } from '../../src/voice/wav.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'node_modules', '.cache', 'voice-test');
let n = 0;
const freshHome = () => { const d = path.join(ROOT, `h${process.pid}_${++n}`); fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); return d; };
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const bus = () => ({ events: [], lives: [], emit(t, d) { this.events.push([t, d]); }, live(t, d) { this.lives.push([t, d]); } });
const wav = (seconds = 1) => pcmToWav(Buffer.alloc(Math.round(16000 * 2 * seconds)), 16000);

/** A whisper-server stand in: a child process that "listens" and answers /health and /inference. */
function fakeWhisper(text = ' [BLANK_AUDIO] hello there ') {
  const spawned = [];
  const spawnImpl = vi.fn((bin, args) => {
    const c = new EventEmitter();
    c.stdout = new EventEmitter();
    c.stderr = new EventEmitter();
    c.kill = vi.fn(() => c.emit('exit', 0));
    spawned.push({ bin, args, c });
    return c;
  });
  const fetchImpl = vi.fn(async (url, opts = {}) => {
    if (String(url).endsWith('/health')) return { status: 200, ok: true, json: async () => ({ status: 'ok' }) };
    if (String(url).endsWith('/inference')) {
      const form = opts.body;
      return { ok: true, status: 200, json: async () => ({ text, language: form.get('language') }) };
    }
    throw new Error(`unexpected ${url}`);
  });
  return { spawnImpl, fetchImpl, spawned };
}

describe('voice catalog', () => {
  it('every download has its exact size and SHA-256', () => {
    for (const p of [...STT_MODELS, ...STT_RUNTIMES, ...TTS_RUNTIMES]) {
      expect(p.bytes, p.id).toBeGreaterThan(1e6);
      expect(p.sha256, p.id).toMatch(/^[0-9a-f]{64}$/);
      expect(p.url, p.id).toMatch(/^https:\/\/(huggingface\.co|github\.com)\//);
    }
    for (const v of TTS_VOICES) for (const f of v.files) expect(f.sha256, f.file).toMatch(/^[0-9a-f]{64}$/);
    expect(STT_MODELS.map((m) => m.id)).toEqual(['tiny', 'base', 'small']);
    // Piper publishes no Japanese or Korean voice: those languages use the system voices
    expect(TTS_VOICES.map((v) => v.locale).sort()).toEqual(['de', 'en', 'es', 'fr', 'it', 'pt-BR', 'ru', 'zh-CN']);
  });

  it('recommends a model by hardware', () => {
    expect(recommendStt({ os: 'win32', arch: 'x64', cpus: 4, ramBytes: 8e9, freeRamBytes: 4e9 })).toMatchObject({ model: 'tiny', device: 'cpu', runtime: 'whisper-win-x64-cpu', gpuRuntime: null });
    expect(recommendStt({ os: 'linux', arch: 'x64', cpus: 12, ramBytes: 16e9, freeRamBytes: 8e9 })).toMatchObject({ model: 'base', device: 'cpu', runtime: 'whisper-linux-x64-cpu' });
    expect(recommendStt({ os: 'win32', arch: 'x64', cpus: 8, freeRamBytes: 6e9, gpu: { name: 'NVIDIA GeForce RTX 3060', backend: 'cuda' } })).toMatchObject({ model: 'small', device: 'gpu', gpuRuntime: 'whisper-win-x64-cuda' });
    expect(recommendStt({ os: 'win32', arch: 'x64', cpus: 16, freeRamBytes: 6e8 })).toMatchObject({ model: 'tiny', reason: 'low_ram' });
    expect(recommendStt({ os: 'darwin', arch: 'arm64', cpus: 8, freeRamBytes: 8e9, gpu: { backend: 'metal' } })).toMatchObject({ model: 'small', runtime: null, device: 'gpu' });
  });
});

describe('consent and downloads', () => {
  const body = Buffer.from('a small test model');
  const pkg = { id: 'test-model', kind: 'stt', name: 'Test', file: 'ggml-test.bin', bytes: body.length, sha256: crypto.createHash('sha256').update(body).digest('hex'), url: 'https://huggingface.co/x/ggml-test.bin' };
  const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, body: [body] }));

  it('nothing downloads without the yes for that exact file', async () => {
    const store = new VoiceStore(freshHome());
    await expect(store.install(pkg, { fetchImpl })).rejects.toMatchObject({ code: 'needs_consent' });
    expect(fetchImpl).not.toHaveBeenCalled();
    store.grant(pkg);
    await store.install(pkg, { fetchImpl });
    expect(store.installed(pkg)).toBe(true);
    // a changed file (new checksum) asks again
    expect(store.hasConsent({ ...pkg, sha256: 'f'.repeat(64) })).toBe(false);
  });

  it('a corrupt download is refused by its checksum', async () => {
    const store = new VoiceStore(freshHome());
    const bad = { ...pkg, id: 'bad', sha256: '0'.repeat(64) };
    store.grant(bad);
    await expect(store.install(bad, { fetchImpl })).rejects.toMatchObject({ code: 'checksum' });
    expect(store.installed(bad)).toBe(false);
  });

  it('voice.consent needs yes: true and the right platform, and records the yes', () => {
    const b = bus();
    const eng = createVoiceEngine({ home: freshHome(), bus: b, hardware: async () => ({}) });
    expect(() => eng.consent({ id: 'tiny' })).toThrow(/yes: true/);
    expect(() => eng.consent({ id: 'nope', yes: true })).toThrow(/no such/);
    const other = STT_RUNTIMES.find((r) => r.platform !== process.platform);
    expect(() => eng.consent({ id: other.id, yes: true })).toThrow(/another platform/);
    expect(eng.store.hasConsent(STT_MODELS[0])).toBe(false);
  });

  it('an archive is unpacked and its server program found', async () => {
    const store = new VoiceStore(freshHome());
    const arch = { id: 'rt-test', kind: 'stt-runtime', platform: process.platform, name: 'rt', binary: 'whisper-server', file: 'rt.zip', bytes: body.length, sha256: pkg.sha256, url: 'https://github.com/x/rt.zip' };
    store.grant(arch);
    const untar = vi.fn(async (file, dir) => { fs.mkdirSync(path.join(dir, 'Release'), { recursive: true }); fs.writeFileSync(path.join(dir, 'Release', process.platform === 'win32' ? 'whisper-server.exe' : 'whisper-server'), 'x'); });
    await store.install(arch, { fetchImpl, untar });
    expect(untar).toHaveBeenCalled();
    expect(store.binaryOf(arch)).toMatch(/whisper-server/);
    expect(fs.existsSync(path.join(store.dirFor(arch), 'rt.zip'))).toBe(false);
  });
});

describe('local speech to text', () => {
  it('starts whisper-server on loopback, sends the turn, cleans the text, and stops when idle', async () => {
    const fw = fakeWhisper();
    const ws = new WhisperServer({ binary: '/x/whisper-server', model: '/m/ggml-tiny.bin', gpu: false, idleMs: 30, spawnImpl: fw.spawnImpl, fetchImpl: fw.fetchImpl });
    const r = await ws.transcribe(wav(), 'pt');
    expect(r).toMatchObject({ text: 'hello there', device: 'cpu' });
    const args = fw.spawned[0].args;
    expect(args).toEqual(expect.arrayContaining(['--host', '127.0.0.1', '-m', '/m/ggml-tiny.bin', '-ng']));
    const call = fw.fetchImpl.mock.calls.find(([u]) => String(u).endsWith('/inference'));
    expect(String(call[0])).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/inference$/);
    expect(call[1].body.get('language')).toBe('pt');
    await new Promise((res) => setTimeout(res, 60));
    expect(ws.running).toBe(false);
    expect(fw.spawned[0].c.kill).toHaveBeenCalled();
  });

  it('uses the GPU build without -ng', async () => {
    const fw = fakeWhisper('ok');
    const ws = new WhisperServer({ binary: 'b', model: 'm', gpu: true, spawnImpl: fw.spawnImpl, fetchImpl: fw.fetchImpl });
    await ws.transcribe(wav(), 'en');
    expect(fw.spawned[0].args).not.toContain('-ng');
    ws.stop();
  });

  it('cleans whisper markers', () => {
    expect(cleanTranscript(' [Music] (laughs) Open the files. ')).toBe('Open the files.');
  });

  it('the engine refuses to transcribe before the model is installed, and very short audio is empty', async () => {
    const eng = createVoiceEngine({ home: freshHome(), bus: bus(), hardware: async () => ({}), env: { PATH: '' } });
    await expect(eng.transcribe(wav(1), 'en')).rejects.toMatchObject({ code: 'needs_download' });
    expect(await eng.transcribe(wav(0.05), 'en')).toMatchObject({ text: '' });
  });
});

describe('HTTP endpoints and commands', () => {
  let server; let base; let commands; let eng;
  beforeEach(async () => {
    commands = new Map();
    const routes = [];
    const fake = { command: (t, fn) => commands.set(t, fn), route: (m, p, h) => routes.push({ m, p, h }) };
    eng = createVoiceEngine({ home: freshHome(), bus: bus(), hardware: async () => ({ cpus: 4, os: process.platform }), env: { PATH: '' } });
    registerVoice({ server: fake, engine: eng });
    server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const r = routes.find((x) => x.m === req.method && x.p === url.pathname);
      if (!r) { res.writeHead(404); res.end(); return; }
      r.h(req, res, url);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
    return () => new Promise((r) => server.close(r));
  });

  it('registers the voice commands; a Code together guest is refused', async () => {
    expect([...commands.keys()]).toEqual(expect.arrayContaining(['voice.status', 'voice.strings', 'voice.consent', 'voice.cancel', 'voice.remove', 'voice.select', 'voice.reply', 'voice.reply.cancel', 'voice.stt.stop']));
    await expect(commands.get('voice.status')({ as: { id: 'g1', role: 'editor' } })).rejects.toMatchObject({ code: 'forbidden' });
    const st = await commands.get('voice.status')({});
    expect(st.stt.ready).toBe(false);
    expect(st.stt.models.find((m) => m.recommended)).toBeTruthy();
    expect(st.stt.models[0]).toMatchObject({ size: expect.stringMatching(/MB/), installed: false, consented: false });
    await expect(commands.get('voice.consent')({ id: 'tiny' })).rejects.toMatchObject({ code: 'bad_request' });
    const s = await commands.get('voice.strings')({ lang: 'pt-BR' });
    expect(s.strings['voice.q.intro']).toBe('A equipe tem uma pergunta.');
  });

  it('POST /api/voice/stt answers 409 until the model is there, 400 for audio it cannot use', async () => {
    let r = await fetch(`${base}/api/voice/stt?lang=en`, { method: 'POST', body: wav(1) });
    expect(r.status).toBe(409);
    expect((await r.json()).error.code).toBe('needs_download');
    r = await fetch(`${base}/api/voice/stt?lang=en`, { method: 'POST', body: Buffer.from('not audio at all, sorry, not audio at all, sorry') });
    expect(r.status).toBe(400);
    r = await fetch(`${base}/api/voice/stt`, { method: 'POST', body: Buffer.alloc(16000 * 2 * 31 + 44) });
    expect(r.status).toBe(413);
  });

  it('POST /api/voice/stt returns the text with the local model', async () => {
    const fw = fakeWhisper('Open the editor.');
    const home = freshHome();
    const e2 = createVoiceEngine({ home, bus: bus(), hardware: async () => ({}), spawnImpl: fw.spawnImpl, fetchImpl: fw.fetchImpl, env: { PATH: '' } });
    // pretend the files are there: the model by size, the server program on disk
    const tiny = STT_MODELS[0];
    fs.mkdirSync(e2.store.dirFor(tiny), { recursive: true });
    const fd = fs.openSync(e2.store.pathOf(tiny), 'w'); fs.ftruncateSync(fd, tiny.bytes); fs.closeSync(fd);
    const rt = STT_RUNTIMES.find((x) => x.platform === process.platform && x.arch === process.arch);
    if (!rt) return; // no published build for this platform (macOS): a system whisper-server is used there
    fs.mkdirSync(e2.store.dirFor(rt), { recursive: true });
    fs.writeFileSync(path.join(e2.store.dirFor(rt), process.platform === 'win32' ? 'whisper-server.exe' : 'whisper-server'), 'x');
    const r = await e2.transcribe(wav(1), 'de');
    expect(r).toMatchObject({ text: 'Open the editor.', model: 'tiny', device: 'cpu' });
    expect(fw.fetchImpl.mock.calls.find(([u]) => String(u).endsWith('/inference'))[1].body.get('language')).toBe('de');
    e2.close();
  });

  it('with the CPU build installed, the model is recommended for the CPU and the GPU build stays on offer', async () => {
    const rt = STT_RUNTIMES.find((x) => x.platform === process.platform && x.arch === process.arch && !x.gpu);
    if (!rt) return;
    const e2 = createVoiceEngine({ home: freshHome(), bus: bus(), hardware: async () => ({ os: process.platform, arch: process.arch, cpus: 4, freeRamBytes: 6e9, gpu: { name: 'NVIDIA GeForce GTX 1060', backend: 'cuda' } }), env: { PATH: '' } });
    fs.mkdirSync(e2.store.dirFor(rt), { recursive: true });
    fs.writeFileSync(path.join(e2.store.dirFor(rt), process.platform === 'win32' ? 'whisper-server.exe' : 'whisper-server'), 'x');
    const st = await e2.status();
    expect(st.stt.recommended.model).toBe('tiny');
    expect(st.stt.runtime).toMatchObject({ device: 'cpu' });
  });

  it('POST /api/voice/tts says when no local voice is installed', async () => {
    const r = await fetch(`${base}/api/voice/tts`, { method: 'POST', body: JSON.stringify({ text: 'hello', lang: 'en' }) });
    expect(r.status).toBe(409);
  });
});

describe('the streamed spoken answer', () => {
  const hive = () => ({ state: { crew: [{ id: 'mel', name: 'Mel', role: 'lead' }], jobs: [], tasks: {}, chat: { general: [] } }, chat: vi.fn(() => 'm_1'), _inJob: () => false });

  it('a request comes back for the yes and never starts a job here', async () => {
    const h = hive();
    const scheduler = { hasBrain: true, turn: vi.fn() };
    const r = await new VoiceReplies({ hive: h, scheduler, bus: bus() }).reply({ text: 'create a landing page for a bakery', lang: 'en', replyId: 'r1' });
    expect(r).toEqual({ kind: 'request', request: 'create a landing page for a bakery' });
    expect(scheduler.turn).not.toHaveBeenCalled();
    expect(voiceIntent('how does the preview work?', 'en').kind).toBe('talk');
  });

  it('streams tokens as voice.token frames and records the exchange in #general', async () => {
    const h = hive();
    const b = bus();
    const scheduler = { hasBrain: true, turn: vi.fn(async ({ options, messages }) => { options.onToken('It is '); options.onToken('live.'); expect(messages[0].content).toMatch(/spoken aloud/); return { text: 'It is live.' }; }) };
    const r = await new VoiceReplies({ hive: h, scheduler, bus: b }).reply({ text: 'how does the preview work?', lang: 'en', replyId: 'r2' });
    expect(r).toMatchObject({ kind: 'answer', text: 'It is live.' });
    expect(b.lives.filter(([t]) => t === 'voice.token').map(([, d]) => d.text)).toEqual(['It is ', 'live.']);
    expect(b.lives.at(-1)).toEqual(['voice.done', { replyId: 'r2' }]);
    expect(h.chat).toHaveBeenCalledTimes(2);
  });

  it('barge in cancels the answer at once', async () => {
    const h = hive();
    const scheduler = { hasBrain: true, turn: ({ signal }) => new Promise((res, rej) => signal.addEventListener('abort', () => rej(new Error('cancelled')))) };
    const vr = new VoiceReplies({ hive: h, scheduler, bus: bus() });
    const p = vr.reply({ text: 'tell me about the crew?', lang: 'en', replyId: 'r3', mode: 'talk' });
    await new Promise((res) => setTimeout(res, 5));
    expect(vr.cancel('r3')).toBe(true);
    expect(await p).toEqual({ kind: 'cancelled' });
  });

  it('without a model it says so', async () => {
    const r = await new VoiceReplies({ hive: hive(), scheduler: { hasBrain: false }, bus: bus() }).reply({ text: 'why?', lang: 'en', replyId: 'r4', mode: 'talk' });
    expect(r).toEqual({ kind: 'noModel' });
  });

  it('voice strings fall back to English', () => {
    expect(voiceStrings('ko')['voice.q.intro']).toBe('팀에서 질문이 있어요.');
    expect(voiceStrings('xx')['voice.q.intro']).toBe('The crew has a question.');
  });
});
