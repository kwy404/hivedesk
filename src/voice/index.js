// The voice plug-in of the engine (loaded by src/index.js like the GitHub and extensions plug-ins).
//
// Commands (PROTOCOL.md style, local user only; a Code together guest never reaches them):
//   voice.status   {}                          engines, models, voices, what is installed, the recommendation
//   voice.strings  { lang }                    the voice strings (i18n/parts/voice.<lang>.json over English)
//   voice.consent  { id, yes: true }           the yes for one package (size, source, license shown): download it
//   voice.cancel   { id }                      stop a download (the .part stays for resume)
//   voice.remove   { id }                      delete a downloaded package and its yes
//   voice.select   { stt?: { model?, runtime? }, tts?: { locale, voice } }
//   voice.reply    { text, lang, replyId, mode? }   a request back for confirmation, or a streamed answer
//   voice.reply.cancel { replyId }             barge in: stop the answer now
//   voice.stt.stop {}                          stop the whisper process now (frees its memory)
// Routes (the same token as every /api call; audio goes to this engine on 127.0.0.1 only):
//   POST /api/voice/stt?lang=<locale>   body: 16 kHz mono WAV    -> { text, ms, model, device }
//   POST /api/voice/tts                 body: { text, lang, rate? } -> audio/wav from Piper
// Live frames: voice.token { replyId, text }, voice.done { replyId }, voice.download { id, received, total, bps, done?, error? }
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectHardware, formatBytes } from '../brain/hardware.js';
import { CODES } from '../../i18n/index.js';
import { STT_MODELS, TTS_VOICES, WHISPER_LANG, anyById, recommendStt, sttModel, sttRuntimesFor, ttsRuntimeFor, ttsVoice, ttsVoiceById } from './catalog.js';
import { VoiceStore } from './store.js';
import { WhisperServer, systemWhisper } from './whisper.js';
import { piperSpeak, MAX_TTS_CHARS } from './piper.js';
import { readWav, MAX_STT_BYTES } from './wav.js';
import { VoiceReplies } from './reply.js';

const PARTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'i18n', 'parts');

export class VoiceError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/** The voice strings for a locale: the part file of the locale over the English one. */
export function voiceStrings(lang, dir = PARTS) {
  const read = (code) => { try { return JSON.parse(fs.readFileSync(path.join(dir, `voice.${code}.json`), 'utf8')); } catch { return {}; } };
  const code = CODES.includes(lang) ? lang : 'en';
  return { ...read('en'), ...(code === 'en' ? {} : read(code)) };
}

/**
 * The engine side of voice mode, without the HTTP server (unit tested in test/voice/engine.test.js).
 * @param {{ home: string, bus: any, hive?: any, scheduler?: any, toolbox?: any, hardware?: () => Promise<any>, fetchImpl?: typeof fetch, spawnImpl?: any, env?: object }} o
 */
export function createVoiceEngine(o) {
  const store = new VoiceStore(o.home);
  const replies = o.hive && o.scheduler ? new VoiceReplies({ hive: o.hive, scheduler: o.scheduler, bus: o.bus, toolbox: o.toolbox }) : null;
  const downloads = new Map();
  let hw = null;
  let whisper = null;
  const hardware = async () => { hw ||= await (o.hardware ? o.hardware() : detectHardware({ home: o.home })).catch(() => ({})); return hw; };

  function sttRuntime() {
    const builds = sttRuntimesFor();
    const chosen = builds.find((b) => b.id === store.settings.stt?.runtime && store.installed(b)) || builds.find((b) => store.installed(b));
    if (chosen) return { id: chosen.id, binary: store.binaryOf(chosen), gpu: chosen.gpu === 'cuda', source: 'download' };
    const sys = systemWhisper(o.env || process.env);
    // A whisper-server the user installed (Homebrew on macOS builds it with Metal) decides its own device.
    if (sys) return { id: 'system', binary: sys, gpu: process.platform === 'darwin', source: 'system' };
    return null;
  }

  function sttModelInstalled() {
    const want = sttModel(store.settings.stt?.model);
    if (want && store.installed(want)) return want;
    return ['base', 'tiny', 'small'].map(sttModel).find((m) => store.installed(m)) || null;
  }

  function ttsReady(locale) {
    const rt = ttsRuntimeFor();
    const id = store.settings.tts?.voices?.[locale];
    const v = (id && ttsVoiceById(id)) || ttsVoice(locale);
    if (!rt || !v || !store.installed(rt) || !store.installed(v)) return null;
    return { binary: store.binaryOf(rt), model: store.pathOf(v, 0), config: store.pathOf(v, 1), voice: v.id };
  }

  const pkgInfo = (p, extra = {}) => ({
    id: p.id, kind: p.kind, name: p.name, bytes: p.bytes, size: formatBytes(p.bytes), source: p.source, license: p.license,
    installed: store.installed(p), consented: store.hasConsent(p), downloading: downloads.has(p.id) ? downloads.get(p.id).progress : null, ...extra
  });

  async function status() {
    const h = await hardware();
    const rt = sttRuntime();
    // with a CPU build installed, recommend for the CPU (the GPU build stays on offer)
    const rec = recommendStt(rt && !rt.gpu && rt.source === 'download' ? { ...h, gpu: null } : h);
    if (rt && !rt.gpu && rt.source === 'download') rec.gpuRuntime = recommendStt(h).gpuRuntime;
    const model = sttModelInstalled();
    const ttsRt = ttsRuntimeFor();
    return {
      hardware: { cpus: h.cpus || null, ramBytes: h.ramBytes || null, freeRamBytes: h.freeRamBytes || null, gpu: h.gpu ? { name: h.gpu.name, backend: h.gpu.backend || null } : null, os: h.os || process.platform },
      stt: {
        ready: !!(rt && model),
        recommended: rec,
        runtime: rt ? { id: rt.id, source: rt.source, device: rt.gpu ? 'gpu' : 'cpu' } : null,
        model: model?.id || null,
        running: !!whisper?.running,
        models: STT_MODELS.map((m) => pkgInfo(m, { ram: m.ram, ramText: formatBytes(m.ram), quality: m.quality, cpuRtf: m.cpuRtf, recommended: m.id === rec.model, selected: m.id === (model?.id || null) })),
        runtimes: sttRuntimesFor().map((r) => pkgInfo(r, { gpu: r.gpu, recommended: r.id === (rec.device === 'gpu' && rec.gpuRuntime ? rec.gpuRuntime : rec.runtime) })),
        system: systemWhisper(o.env || process.env) ? true : false
      },
      tts: {
        runtime: ttsRt ? pkgInfo(ttsRt) : null,
        voices: TTS_VOICES.map((v) => pkgInfo(v, { locale: v.locale, selected: store.settings.tts?.voices?.[v.locale] === v.id || (!store.settings.tts?.voices?.[v.locale]) })),
        ready: CODES.filter((c) => !!ttsReady(c))
      }
    };
  }

  function consent(d) {
    const p = anyById(String(d.id || ''));
    if (!p) throw new VoiceError('not_found', 'no such voice package');
    if (d.yes !== true) throw new VoiceError('bad_request', 'voice.consent needs yes: true from the user');
    if (p.platform && (p.platform !== process.platform || p.arch !== process.arch)) throw new VoiceError('bad_request', 'that build is for another platform');
    store.grant(p);
    o.bus.emit('voice.consent.given', { id: p.id, kind: p.kind, bytes: p.bytes });
    if (store.installed(p)) return { id: p.id, installed: true };
    if (downloads.has(p.id)) return { id: p.id, downloading: true };
    const ctrl = new AbortController();
    const job = { ctrl, progress: { received: 0, total: p.bytes, bps: 0 } };
    downloads.set(p.id, job);
    const onProgress = (pr) => { job.progress = pr; o.bus.live('voice.download', { id: p.id, ...pr }); };
    job.promise = store.install(p, { onProgress, signal: ctrl.signal, fetchImpl: o.fetchImpl, untar: o.untar })
      .then(() => {
        if (p.kind === 'stt') store.set({ stt: { ...(store.settings.stt || {}), model: p.id } });
        if (p.kind === 'stt-runtime') { store.set({ stt: { ...(store.settings.stt || {}), runtime: p.id } }); whisper?.stop(); whisper = null; }
        o.bus.emit('voice.installed', { id: p.id, kind: p.kind });
        o.bus.live('voice.download', { id: p.id, received: p.bytes, total: p.bytes, done: true });
      })
      .catch((err) => o.bus.live('voice.download', { id: p.id, error: String(err.message || err), code: err.code || 'failed' }))
      .finally(() => downloads.delete(p.id));
    return { id: p.id, downloading: true };
  }

  function select(d) {
    if (d.stt && typeof d.stt === 'object') {
      const next = { ...(store.settings.stt || {}) };
      if (d.stt.model != null) { if (!sttModel(d.stt.model)) throw new VoiceError('bad_request', 'unknown model'); next.model = d.stt.model; }
      if (d.stt.runtime != null) { if (!sttRuntimesFor().some((r) => r.id === d.stt.runtime)) throw new VoiceError('bad_request', 'unknown build'); next.runtime = d.stt.runtime; }
      store.set({ stt: next });
      whisper?.stop();
      whisper = null;
    }
    if (d.tts && typeof d.tts === 'object') {
      const v = ttsVoiceById(String(d.tts.voice || ''));
      if (!v || v.locale !== d.tts.locale) throw new VoiceError('bad_request', 'unknown voice for that language');
      store.set({ tts: { ...(store.settings.tts || {}), voices: { ...(store.settings.tts?.voices || {}), [v.locale]: v.id } } });
    }
    return {};
  }

  /** Speech to text of one turn, on this computer. */
  async function transcribe(wav, lang) {
    const info = readWav(wav);
    if (info.seconds < 0.15) return { text: '', ms: 0, model: null, device: null };
    const rt = sttRuntime();
    const model = sttModelInstalled();
    if (!rt || !model) throw new VoiceError('needs_download', 'the local speech model is not installed');
    if (!whisper || !whisper.same(rt.binary, store.pathOf(model), rt.gpu)) {
      whisper?.stop();
      whisper = new WhisperServer({ binary: rt.binary, model: store.pathOf(model), gpu: rt.gpu, spawnImpl: o.spawnImpl, fetchImpl: o.fetchImpl });
    }
    const r = await whisper.transcribe(wav, WHISPER_LANG[lang] || 'auto');
    return { ...r, model: model.id };
  }

  async function speak(d) {
    const lang = CODES.includes(d.lang) ? d.lang : 'en';
    const ready = ttsReady(lang);
    if (!ready) throw new VoiceError('needs_download', 'no local voice is installed for this language');
    const text = String(d.text || '').slice(0, MAX_TTS_CHARS);
    const rate = Number(d.rate) || 1;
    return piperSpeak({ binary: ready.binary, model: ready.model, config: ready.config, text, lengthScale: 1 / rate, spawnImpl: o.spawnImpl });
  }

  return {
    store, status, consent, select, transcribe, speak, voiceStrings,
    cancel(id) { const j = downloads.get(String(id || '')); if (!j) return false; j.ctrl.abort(); return true; },
    remove(id) {
      const p = anyById(String(id || ''));
      if (!p) throw new VoiceError('not_found', 'no such voice package');
      if (downloads.has(p.id)) throw new VoiceError('conflict', 'it is still downloading');
      if (p.kind === 'stt' || p.kind === 'stt-runtime') { whisper?.stop(); whisper = null; }
      store.remove(p);
      o.bus.emit('voice.removed', { id: p.id, kind: p.kind });
      return {};
    },
    reply(d) {
      if (!replies) throw new VoiceError('conflict', 'the crew is not running');
      const replyId = /^[\w-]{1,40}$/.test(String(d.replyId || '')) ? d.replyId : `r_${Date.now().toString(36)}`;
      return replies.reply({ text: d.text, lang: CODES.includes(d.lang) ? d.lang : 'en', replyId, mode: d.mode === 'talk' ? 'talk' : 'auto' });
    },
    cancelReply(id) { return replies ? replies.cancel(String(id || '')) : false; },
    stopStt() { whisper?.stop(); whisper = null; return {}; },
    downloads,
    close() { whisper?.stop(); for (const j of downloads.values()) j.ctrl.abort(); }
  };
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const tooLarge = () => new VoiceError('too_large', 'the audio is too long (30 seconds at most)');
    if (Number(req.headers?.['content-length']) > limit) { req.resume(); reject(tooLarge()); return; }
    let size = 0;
    let over = false;
    const chunks = [];
    req.on('data', (c) => {
      if (over) return; // drain the rest so the answer still reaches the window
      size += c.length;
      if (size > limit) { over = true; chunks.length = 0; reject(tooLarge()); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!over) resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

const STATUS = { bad_request: 400, not_found: 404, conflict: 409, needs_download: 409, too_large: 413, forbidden: 403, timeout: 504 };

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(body));
}

function localOnly(d) {
  if (d && typeof d === 'object' && d.as) throw new VoiceError('forbidden', 'voice mode is for the person at this computer');
}

/** Registers the commands and routes on the engine's server. */
export function registerVoice({ server, engine, CommandErr = VoiceError }) {
  const wrap = (fn) => async (d) => {
    localOnly(d);
    try { return await fn(d || {}); } catch (err) {
      throw new CommandErr(['bad_request', 'not_found', 'conflict', 'forbidden', 'timeout'].includes(err.code) ? err.code : err.code === 'needs_download' ? 'conflict' : 'internal', String(err.message || err));
    }
  };
  server.command('voice.status', wrap(() => engine.status()));
  server.command('voice.strings', wrap((d) => ({ strings: engine.voiceStrings(String(d.lang || 'en')) })));
  server.command('voice.consent', wrap((d) => engine.consent(d)));
  server.command('voice.cancel', wrap((d) => ({ cancelled: engine.cancel(d.id) })));
  server.command('voice.remove', wrap((d) => engine.remove(d.id)));
  server.command('voice.select', wrap((d) => engine.select(d)));
  server.command('voice.reply', wrap((d) => engine.reply(d)));
  server.command('voice.reply.cancel', wrap((d) => ({ cancelled: engine.cancelReply(d.replyId) })));
  server.command('voice.stt.stop', wrap(() => engine.stopStt()));

  server.route('POST', '/api/voice/stt', async (req, res, url) => {
    try {
      const wav = await readBody(req, MAX_STT_BYTES);
      const r = await engine.transcribe(wav, url.searchParams.get('lang') || 'en');
      sendJson(res, 200, r);
    } catch (err) {
      sendJson(res, STATUS[err.code] || 500, { error: { code: err.code || 'internal', message: String(err.message || err) } });
    }
  });
  server.route('POST', '/api/voice/tts', async (req, res) => {
    try {
      const body = JSON.parse(String(await readBody(req, 8192)) || '{}');
      const wav = await engine.speak(body);
      res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': wav.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(wav);
    } catch (err) {
      sendJson(res, STATUS[err.code] || (err instanceof SyntaxError ? 400 : 500), { error: { code: err.code || 'internal', message: String(err.message || err) } });
    }
  });
}

/** The plug-in entry: same shape as src/github/index.js. */
export default function voicePlugin({ bus, hive, scheduler, toolbox, server, config = {} }) {
  if (!config.home) return null;
  const engine = createVoiceEngine({ home: config.home, bus, hive, scheduler, toolbox });
  registerVoice({ server, engine });
  return engine;
}
