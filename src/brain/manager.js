// Picks, installs, downloads and loads the brain with no questions asked (FIRST-RUN.md), and reports every step as events.
import fs from 'node:fs';
import path from 'node:path';
import { detectHardware, formatBytes, diskFree } from './hardware.js';
import { MODELS, modelById, isCached, modelPath, modelParts, downloadModel, DownloadError, modelsDir } from './models.js';
import { loadRuntime, findRuntime, RUNTIME_PACKAGE } from './runtime.js';
import { createLocalBrain } from './local.js';
import { createCloudBrain, PROVIDERS, listModels, testConnection } from './cloud.js';
import { KeyStore } from './keys.js';
import { createOllamaBrain, createOpenAIBrain, probeOllama, probeLmStudio, pickServerModel, OLLAMA_URL, LMSTUDIO_URL } from './http.js';
import { resolvePick, pick as catalogPick, allPicks } from './catalog/index.js';
import { recommend, explainText } from './catalog/recommend.js';
import { ConsentStore, downloadGate } from './catalog/consent.js';
import { RouterSettings, ModelPool, createAutoBrain } from './rotation.js';
import { route as routeTurn } from './catalog/router.js';

/** A legacy MODELS entry (Q4_K_M) as its catalog pick, so ids, files and checksums are the same everywhere. */
export function asPick(m) {
  if (!m) return null;
  if (m.quant && Array.isArray(m.files)) return m;
  return resolvePick(`${m.id}:Q4_K_M`) || m;
}

/** The free disk now (it shrinks as models download), never more than the hardware probe saw. */
function freshFree(dir, probed) {
  const now = diskFree(fs.existsSync(dir) ? dir : path.dirname(dir));
  if (now == null) return probed ?? null;
  return probed == null ? now : Math.min(now, probed);
}

/** The numbers a translated download error shows (HTTP status, seconds to wait, space needed and free). */
function dlFacts(e) {
  const out = {};
  for (const k of ['status', 'retryAfter', 'need', 'free']) if (e?.[k] != null) out[k] = e[k];
  return out;
}

/** What the UI and the log show about a pick before a download. */
export function pickInfo(m) {
  return {
    model: m.name, id: m.id, file: m.file, url: m.url, bytes: m.bytes, source: m.source,
    ...(m.license ? { license: { id: m.license.id, name: m.license.name, url: m.license.url || null, notes: m.license.notes || null, commercial: m.license.commercial ?? null } } : {}),
    ...(m.files?.length > 1 ? { parts: m.files.length } : {})
  };
}

/** The next smaller entry of the same family on the GPU: a cached one first, else the next size down at Q4_K_M. */
export function smallerPick(p, isCachedFn = () => false) {
  const fam = allPicks().filter((x) => x.family === p.family && x.bytes < p.bytes && x.params < p.params);
  if (!fam.length) return null;
  const cached = fam.filter((x) => isCachedFn(x)).sort((a, b) => b.bytes - a.bytes)[0];
  if (cached) return cached;
  return fam.filter((x) => x.quant === 'Q4_K_M').sort((a, b) => b.bytes - a.bytes)[0] || null;
}

export class BrainManager {
  /**
   * @param {{
   *   bus: import('../bus.js').EventBus, scheduler: import('../crew/scheduler.js').Scheduler, home: string,
   *   flags?: { brain?: string, model?: string, url?: string, key?: string, noDownload?: boolean, gpu?: boolean, ctx?: number, gpuLayers?: 'max' },
   *   log?: (line: string) => void, progress?: (text: string | null) => void,
   *   fetchImpl?: typeof fetch, loadRuntimeImpl?: typeof loadRuntime, createLocalImpl?: typeof createLocalBrain, hardware?: any,
   *   isCachedImpl?: typeof isCached
   * }} opts
   */
  constructor(opts) {
    this.bus = opts.bus;
    this.scheduler = opts.scheduler;
    this.home = opts.home;
    this.flags = { ...(opts.flags || {}) };
    this.log = opts.log || (() => {});
    this.progress = opts.progress || (() => {});
    this.fetch = opts.fetchImpl || fetch;
    this.loadRuntime = opts.loadRuntimeImpl || loadRuntime;
    this.createLocal = opts.createLocalImpl || createLocalBrain;
    this.hardware = opts.hardware || null;
    this.isCached = opts.isCachedImpl || isCached;
    this.brain = null;
    this.running = null;
    this.key = this.flags.key || process.env.HIVEDESK_API_KEY || '';
    this.keys = opts.keyStore || new KeyStore(opts.home);
    /** brainId -> brain, for workers that use another brain than the main one */
    this.workerBrains = new Map();
    this.downloadCtrl = null;
    this.consent = opts.consentStore || new ConsentStore(opts.home);
    /** Picks named on the command line or chosen in the wizard ("Download it now?"): an explicit yes. */
    this.cliConsent = new Set();
    for (const spec of [this.flags.modelId, this.flags.model]) {
      const p = spec ? asPick(modelById(spec)) || resolvePick(spec) : null;
      if (p) this.cliConsent.add(p.id);
    }
    /** The pick waiting for a yes (shown by the consent card and the first launch dialog). */
    this.pending = null;
    this.currentPick = null;
    /** Automatic rotation (on by default): pins per role, overrides per task, how many models stay loaded. */
    this.router = opts.routerSettings || new RouterSettings(opts.home);
    this.pool = null;
  }

  status(state, data = {}) {
    const d = { state, backend: data.backend || this.bus.state.brain?.backend || 'none', ...data };
    this.bus.emit('brain.status', d);
    const line = { none: 'no model yet', needs_download: 'model download needed', downloading: 'downloading the model', loading: 'loading the model', ready: 'model ready', error: 'model error' }[state];
    this.log(`${line}${d.model ? ': ' + d.model : ''}${d.detail ? ' (' + d.detail + ')' : ''}`);
    if (d.hint) this.log(`  ${d.hint}`);
  }

  /** Runs the whole pipeline once; concurrent calls share it. */
  start(override) {
    if (override) this.flags = { ...this.flags, ...override };
    if (!this.running) {
      this.running = this._start().catch((err) => {
        this.status('error', { detail: String(err.message || err), hint: err.hint });
      }).finally(() => { this.running = null; });
    }
    return this.running;
  }

  async _detach() {
    if (this.brain) {
      this.scheduler.removeBrain(this.brain.id, 'switched');
      this.brain = null;
    }
  }

  attach(brain, data) {
    this.brain = brain;
    this.scheduler.addBrain(brain);
    this.status('ready', data);
  }

  async hw() {
    if (!this.hardware) this.hardware = await detectHardware({ dir: this.home, home: this.home });
    if (!this._hwShown) {
      this._hwShown = true;
      const h = this.hardware;
      this.bus.emit('hardware.detected', h);
      this.log(`hardware: ${h.cpus} CPU threads, ${formatBytes(h.ramBytes)} RAM, ${h.gpu ? `${h.gpu.name} with ${formatBytes(h.gpu.vramBytes)} VRAM` : 'no GPU found'}, ${formatBytes(h.diskFreeBytes)} free disk`);
    }
    return this.hardware;
  }

  async _start() {
    const f = this.flags;
    await this._detach();
    if (f.brain === 'ollama') return this._ollama(f.url || OLLAMA_URL, f.model, true);
    if (f.brain === 'lmstudio') return this._lmstudio(f.url || LMSTUDIO_URL, f.model, true);
    if (f.brain === 'openai' && (f.url || this.key)) return this._openai();
    if (PROVIDERS[f.brain]) return this._cloud(f.brain, f.model);
    if (f.model && (!f.brain || f.brain === 'local')) return this._localFromFlag(f.model);
    if (f.modelId) return this._localAuto(asPick(modelById(f.modelId)) || resolvePick(f.modelId) || undefined);
    // Auto: a running model server first.
    if (f.brain !== 'local') {
      if (await this._ollama(OLLAMA_URL, undefined, false)) return;
      if (await this._lmstudio(LMSTUDIO_URL, undefined, false)) return;
    }
    return this._localAuto();
  }

  async _ollama(url, model, required) {
    const models = await probeOllama(url, this.fetch);
    if (!models || !models.length) {
      if (required) this.status('error', { backend: 'ollama', detail: models ? 'Ollama has no models' : `Ollama is not running at ${url}`, hint: models ? 'Run "ollama pull qwen2.5-coder:7b" and try again.' : 'Start Ollama, or run hivedesk without --brain to use the built in local model.' });
      return false;
    }
    const name = model && models.includes(model) ? model : pickServerModel(models);
    this.log(`using Ollama at ${url} with ${name}`);
    this.attach(createOllamaBrain({ url, model: name, id: 'ollama', fetchImpl: this.fetch }), { backend: 'ollama', model: name, detail: url });
    return true;
  }

  async _lmstudio(url, model, required) {
    const models = await probeLmStudio(url, this.fetch);
    if (!models || !models.length) {
      if (required) this.status('error', { backend: 'lmstudio', detail: models ? 'LM Studio has no model loaded' : `LM Studio is not running at ${url}`, hint: 'Start the LM Studio server and load a model, or run hivedesk without --brain.' });
      return false;
    }
    const name = model && models.includes(model) ? model : pickServerModel(models);
    this.log(`using LM Studio at ${url} with ${name}`);
    this.attach(createOpenAIBrain({ url, model: name, id: 'lmstudio', backend: 'lmstudio', fetchImpl: this.fetch }), { backend: 'lmstudio', model: name, detail: url });
    return true;
  }

  async _openai() {
    const url = this.flags.url;
    const model = this.flags.model;
    if (!url || !model) {
      this.status('error', { backend: 'openai', detail: 'an endpoint needs a URL and a model name', hint: 'Use --brain openai --url <base url> --model <name> and put the key in HIVEDESK_API_KEY.' });
      return false;
    }
    this.attach(createOpenAIBrain({ url, model, key: this.key, id: 'openai', backend: 'openai', fetchImpl: this.fetch }), { backend: 'openai', model, detail: url });
    return true;
  }

  async _localFromFlag(spec) {
    // --model 7b, 3b, 1.5b, 0.5b or 14b: that catalog model, downloaded when needed.
    // 7b, 3b (Q4_K_M), or a catalog entry such as qwen2.5-coder-7b:Q3_K_M.
    const short = asPick(modelById(spec)) || (/^[\w.-]+[:@][\w]+$/.test(spec) ? resolvePick(spec) : null);
    if (short) return this._localAuto(short);
    if (/^(hf:|https?:)/i.test(spec)) {
      const known = resolvePick(spec);
      if (known) { this.cliConsent.add(known.id); return this._localAuto(known); }
      this.status('error', { backend: 'local', detail: `only GGUF files listed in the catalog can be downloaded by URI: ${spec}`, hint: 'Download the file yourself and pass its path to --model.' });
      return;
    }
    const p = path.resolve(spec);
    if (!fs.existsSync(p)) {
      this.status('error', { backend: 'local', detail: `model file not found: ${p}`, hint: 'Check the path given to --model.' });
      return;
    }
    const runtime = await this._runtime();
    if (!runtime) return;
    await this._load(runtime, p, path.basename(p), this.flags.gpu !== false, null);
  }

  /** The catalog picks already in the cache. */
  installedPicks() {
    return allPicks().filter((p) => this.isCached(this.home, p) || (p.quant === 'Q4_K_M' && MODELS.some((m) => p.modelId === m.id && this.isCached(this.home, m))));
  }

  /** The recommendation for this machine (Settings, Models, the first launch dialog). */
  async analyze(opts = {}) {
    const hw = await this.hw();
    const installed = this.installedPicks().map((p) => p.id);
    const ctx = Number(opts.ctx) || this.flags.ctx || contextFor(hw, null, !!hw.gpu && this.flags.gpu !== false);
    const r = recommend(hw, { ctx, task: opts.task || 'coding', installed, current: this.currentPick?.id || null, gpu: this.flags.gpu });
    return { ...r, installed, selected: this.consent.data.selected || null, current: r.current, firstLaunch: this.consent.firstLaunch, pending: this.pending ? pickInfo(this.pending) : null, brain: { state: this.bus.state.brain?.state || 'none', backend: this.bus.state.brain?.backend || null }, queue: this.queueState(), disk: this.disk() };
  }

  /** Auto pick by hardware (or the forced pick), download only with consent, load. */
  async _localAuto(forced) {
    const hw = await this.hw();
    const cachedIds = new Set(this.installedPicks().map((p) => p.id));
    let model = forced ? asPick(forced) : null;
    let reason;
    let onGpu;
    let warning = null;
    if (model) {
      onGpu = this.flags.gpu !== false && !!hw.gpu && (hw.gpu.vramBytes || 0) >= 3.8e9;
      reason = `${model.name} chosen with --model or in Settings, ${onGpu ? 'on the GPU' : 'on the CPU'}.`;
    } else {
      const ctx = this.flags.ctx || contextFor(hw, null, !!hw.gpu && this.flags.gpu !== false);
      const r = recommend(hw, { ctx, task: 'coding', installed: [...cachedIds], gpu: this.flags.gpu });
      const ok = r.options.filter((o) => o.runnable);
      const sel = this.consent.data.selected;
      // The user's last choice, else the best model already downloaded, else the recommendation (which needs a yes).
      const best = (sel && cachedIds.has(sel) && ok.find((o) => o.id === sel)) || ok.find((o) => cachedIds.has(o.id)) || r.recommended;
      if (!best) {
        this.status('error', { backend: 'local', detail: 'no model in the catalog fits this machine', hint: 'Free some disk or RAM, use --model with a GGUF file, or use Ollama, LM Studio or a cloud key.' });
        return;
      }
      model = catalogPick(best.modelId, best.quant);
      onGpu = best.where === 'gpu' || best.where === 'partial';
      const gpuName = hw.gpu?.name && onGpu ? `${hw.gpu.name} (${(hw.gpu.vramBytes / 1e9).toFixed(1)} GB VRAM) found` : hw.gpu ? `${hw.gpu.name || 'The GPU'} is too small for it` : 'No usable GPU';
      const shown = best.id === r.recommended?.id ? r.recommended : { ...best, why: [{ k: 'installed' }, { k: best.measured ? 'measured' : 'estimated', tps: best.tps }] };
      reason = `${gpuName}: using ${explainText(shown)}.`;
      if (best.quality < 30) warning = 'Results with this small model will be basic. For better work, use Ollama, LM Studio or an endpoint with a key (--brain).';
    }
    this.bus.emit('brain.choice', {
      model: model.name, id: model.id, file: model.file, bytes: model.bytes, source: model.source, license: model.license?.id || null,
      gpu: onGpu, reason, ...(warning ? { warning } : {})
    });
    this.log(reason);
    if (warning) this.log(warning);
    // Model first (it may wait for a yes), then the runtime.
    const file = await this._ensureModel(model, forced ? 'user' : 'auto');
    if (!file) return;
    const runtime = await this._runtime();
    if (!runtime) return;
    await this._load(runtime, file, model.name, onGpu, model);
  }

  async _runtime() {
    try {
      const had = await findRuntime(this.home);
      if (!had) this.bus.emit('brain.runtime', { state: 'installing', package: RUNTIME_PACKAGE });
      const r = await this.loadRuntime(this.home, {
        onInstall: () => this.log(`installing the local runtime (${RUNTIME_PACKAGE}) into ${path.join(this.home, 'runtime')}`),
        onLine: (line) => this.bus.live('brain.runtime.progress', { line })
      });
      if (!r) throw new Error('runtime not available');
      this.bus.emit('brain.runtime', { state: 'ready', package: RUNTIME_PACKAGE, version: r.version, path: r.entry });
      return r;
    } catch (err) {
      const code = `runtime_${err.code || 'install_failed'}`;
      this.bus.emit('brain.runtime', { state: 'failed', package: RUNTIME_PACKAGE, message: String(err.message), hint: err.hint, code });
      this.status('error', { backend: 'local', code, detail: String(err.message), hint: err.hint || 'Run hivedesk --doctor, or use --brain ollama or --brain lmstudio.' });
      return null;
    }
  }

  /** Returns the model path, downloading it when needed and allowed; null when it is not available. */
  async _ensureModel(model, trigger = 'user') {
    model = asPick(model);
    const target = modelPath(this.home, model);
    if (this.isCached(this.home, model)) return target;
    // The legacy entry for the same file (MODELS) counts as cached.
    const legacy = MODELS.find((m) => m.file === model.file && (model.files?.length || 1) === 1);
    if (legacy && this.isCached(this.home, legacy)) return modelPath(this.home, legacy);
    const info = pickInfo(model);
    this.bus.emit('brain.download.required', info);
    const gate = downloadGate(model, { store: this.consent, cli: this.cliConsent, noDownload: this.flags.noDownload });
    if (!gate.ok) {
      this.pending = model;
      const hint = gate.reason === 'no_download'
        ? 'Started with --no-download: press Download in Settings, or use --model, or Ollama or LM Studio.'
        : 'Nothing is downloaded without your yes: answer in the app (it shows the size, the source and the license), or start with --model <name>.';
      // trigger: 'auto' (the start picked it), 'user' (chosen in Settings or Models), 'fallback' (a step down).
      this.bus.emit('models.consent.required', { ...info, reason: gate.reason, trigger });
      this.status('needs_download', { backend: 'local', model: model.name, detail: `${formatBytes(model.bytes)} from ${model.source}${model.license ? `, ${model.license.name}` : ''}`, hint, consent: gate.reason === 'needs_consent' });
      return null;
    }
    this.pending = null;
    this.status('downloading', { backend: 'local', model: model.name, detail: `${formatBytes(model.bytes)} from ${model.source}` });
    this.bus.emit('brain.download.started', { ...info, path: target });
    this.log(`downloading ${model.name}, ${formatBytes(model.bytes)}, from ${model.source}${model.license ? ` (${model.license.name})` : ''}`);
    const started = Date.now();
    this.downloadCtrl = new AbortController();
    try {
      const out = await downloadModel(model, {
        home: this.home,
        fetchImpl: this.fetch,
        freeBytes: freshFree(modelsDir(this.home), this.hardware?.diskFreeBytes),
        signal: this.downloadCtrl.signal,
        onProgress: ({ received, total, bps, part, parts }) => {
          this.bus.live('brain.download.progress', { model: model.name, id: model.id, received, total, bps, ...(parts ? { part, parts } : {}) });
          this.progress(bar(model.name, received, total, bps));
        }
      });
      this.progress(null);
      this.bus.emit('brain.download.finished', { model: model.name, id: model.id, path: out, bytes: model.bytes, ms: Date.now() - started });
      return out;
    } catch (err) {
      this.progress(null);
      const e = err instanceof DownloadError ? err : new DownloadError('io', String(err.message || err), 'Press Retry.');
      if (e.code === 'checksum' && !this._retriedChecksum) {
        this._retriedChecksum = true;
        this.log('checksum mismatch, downloading again');
        return this._ensureModel(model, trigger);
      }
      const facts = dlFacts(e);
      this.bus.emit('brain.download.failed', { model: model.name, id: model.id, code: e.code, message: e.message, hint: e.hint, ...facts });
      this.status('error', { backend: 'local', model: model.name, code: e.code, detail: e.message, hint: e.hint, ...facts });
      return null;
    } finally {
      this.downloadCtrl = null;
    }
  }

  async _load(runtime, file, name, gpu, model) {
    this.status('loading', { backend: 'local', model: name, detail: gpu ? 'GPU' : 'CPU' });
    try {
      this.currentPick = model ? asPick(model) : resolvePick(String(file).split(/[\\/]/).pop());
      const brain = await this.createLocal({ mod: runtime.mod, modelPath: file, gpu, name, contextSize: this.flags.ctx || contextFor(this.hardware, file, gpu), id: 'local', ...(this.flags.gpuLayers ? { gpuLayers: this.flags.gpuLayers } : {}) });
      const info = brain.info?.() || {};
      const onGpu = info.gpu && info.gpu !== 'cpu' && info.gpu !== false;
      const layers = info.totalLayers ? `${info.gpuLayers} of ${info.totalLayers}` : `${info.gpuLayers}`;
      this.runtimeMod = runtime.mod;
      this.attach(this._rotating(brain, gpu, info.contextSize), { backend: 'local', model: name, detail: onGpu ? `${info.gpu}, ${layers} layers on the GPU` : 'CPU', ctx: info.contextSize, auto: this.router.data.auto });
      return true;
    } catch (err) {
      if (err.code === 'no_memory' || !gpu) {
        this.status('error', { backend: 'local', model: name, code: err.code === 'no_memory' ? 'no_memory' : 'load_failed', detail: `could not load the model: ${err.message}`, hint: err.hint || 'Try a smaller model, close other apps to free memory, or use Ollama or LM Studio.' });
        return false;
      }
      // The GPU works but the model does not fit in its VRAM: the next smaller model, still on the GPU.
      const vramFull = /VRAM|layers fit|too large/i.test(String(err.message));
      if (vramFull) {
        const known = model ? asPick(model) : resolvePick(String(file).split(/[\\/]/).pop());
        const smaller = known ? smallerPick(known, (p) => this.isCached(this.home, p)) : null;
        if (smaller && smaller.bytes >= 1e9) {
          this.bus.emit('brain.fallback', {
            from: { backend: 'local', model: name, gpu: true },
            to: { backend: 'local', model: smaller.name, gpu: true },
            reason: `the model does not fit in the GPU memory: ${String(err.message).slice(0, 200)}`
          });
          this.log(`${name} does not fit in the GPU memory (${err.message}); trying ${smaller.name} on the GPU`);
          const f3 = await this._ensureModel(smaller, 'fallback');
          if (!f3) return false;
          return this._load(runtime, f3, smaller.name, true, smaller);
        }
      }
      // The GPU could not take the model: the 1.5B model on the CPU (small enough for most machines).
      const small = asPick(modelById('qwen2.5-coder-1.5b'));
      const same = model && model.id === small.id;
      this.bus.emit('brain.fallback', {
        from: { backend: 'local', model: name, gpu: true },
        to: { backend: 'local', model: small.name, gpu: false },
        reason: `the GPU could not load the model: ${String(err.message).slice(0, 200)}`
      });
      this.log(`GPU failed (${err.message}); trying ${small.name} on the CPU`);
      const f2 = same ? file : await this._ensureModel(small, 'fallback');
      if (!f2) return false;
      return this._load(runtime, f2, small.name, false, small);
    }
  }

  /** A cloud provider as the main brain, with the key from the key store (or --key / HIVEDESK_API_KEY). */
  async _cloud(provider, model) {
    const saved = this.keys.get(provider) || {};
    const key = saved.key || (this.flags.brain === provider ? this.key : '');
    if (!key && provider !== 'compatible') {
      this.status('error', { backend: provider, detail: `no API key for ${PROVIDERS[provider].label}`, hint: 'Add the key in Settings, Providers, or choose a local model.' });
      return false;
    }
    const m = model || saved.model || PROVIDERS[provider].models[0];
    if (!m) {
      this.status('error', { backend: provider, detail: 'no model name', hint: 'Pick a model in Settings, Providers.' });
      return false;
    }
    const brain = createCloudBrain(provider, { key, model: m, baseUrl: saved.baseUrl, fetchImpl: this.fetch, id: 'main' });
    this.log(`using ${PROVIDERS[provider].label} with ${m}: prompts and file contents sent to it leave this machine and are billed to your account`);
    this.attach(brain, { backend: provider, model: m, detail: 'cloud' });
    return true;
  }

  /** Providers as the UI may see them (never the keys). */
  providers() {
    return this.keys.publicView();
  }

  setProvider(provider, data) {
    const view = this.keys.set(provider, data);
    this.bus.emit('providers.changed', { providers: this.providers() });
    return view;
  }

  removeProvider(provider) {
    const had = this.keys.remove(provider);
    for (const [id, b] of this.workerBrains) if (b.provider === provider) { this.scheduler.removeBrain(id, 'key removed'); this.workerBrains.delete(id); }
    this.bus.emit('providers.changed', { providers: this.providers() });
    return had;
  }

  async testProvider(provider, model) {
    const s = this.keys.get(provider) || {};
    if (!s.key && provider !== 'compatible') return { ok: false, code: 'auth', error: 'no key saved for this provider' };
    return testConnection(provider, { key: s.key, model: model || s.model, baseUrl: s.baseUrl, fetchImpl: this.fetch });
  }

  async providerModels(provider) {
    const s = this.keys.get(provider) || {};
    return listModels(provider, { key: s.key, baseUrl: s.baseUrl, fetchImpl: this.fetch });
  }

  /**
   * Per worker brains: { mel: '<provider id>', dev: 'default' }. Each provider named gets one extra brain that only
   * serves the workers that chose it; everyone else keeps the main brain.
   */
  applyWorkerBrains(map = {}) {
    const wanted = new Map(); // provider -> Set(workers)
    for (const [workerId, choice] of Object.entries(map || {})) {
      if (!choice || choice === 'default' || !PROVIDERS[choice]) { this.scheduler.setPreference(workerId, null); continue; }
      if (!wanted.has(choice)) wanted.set(choice, new Set());
      wanted.get(choice).add(workerId);
    }
    for (const [id, b] of this.workerBrains) {
      if (!wanted.has(b.provider)) { this.scheduler.removeBrain(id, 'not used'); this.workerBrains.delete(id); }
    }
    const problems = [];
    for (const [provider, workers] of wanted) {
      const id = `cloud:${provider}`;
      let brain = this.workerBrains.get(id);
      if (!brain) {
        const s = this.keys.get(provider) || {};
        if (!s.key && provider !== 'compatible') { problems.push(`${PROVIDERS[provider].label} has no key`); for (const w of workers) this.scheduler.setPreference(w, null); continue; }
        brain = createCloudBrain(provider, { key: s.key, model: s.model || PROVIDERS[provider].models[0], baseUrl: s.baseUrl, fetchImpl: this.fetch, id });
        this.workerBrains.set(id, brain);
        this.scheduler.addBrain(brain);
      }
      brain.only = workers;
      for (const w of workers) this.scheduler.setPreference(w, id);
    }
    return { problems };
  }

  /** The command `brain.select`. */
  select(choice = {}) {
    const backend = choice.backend;
    if (!['local', 'ollama', 'lmstudio', 'openai', 'fake', ...Object.keys(PROVIDERS)].includes(backend)) throw Object.assign(new Error('unknown backend'), { code: 'bad_request' });
    if (backend === 'fake') throw Object.assign(new Error('the fake brain is only for --demo and tests'), { code: 'bad_request' });
    if (typeof choice.key === 'string' && choice.key) this.key = choice.key;
    const shown = { backend };
    if (choice.model) shown.model = choice.model;
    if (choice.url) shown.url = choice.url;
    if (this.key && backend === 'openai') shown.key = 'set';
    this.bus.emit('settings.changed', { brain: shown });
    const next = { brain: backend, model: undefined, modelId: undefined, url: choice.url };
    if (backend === 'local' && choice.model) {
      const m = asPick(modelById(choice.model) || MODELS.find((x) => x.name === choice.model)) || resolvePick(choice.model);
      if (m) next.modelId = m.id;
      else next.model = choice.model;
    } else if (choice.model) {
      next.model = choice.model;
    }
    this.flags = { ...this.flags, ...next };
    this.start();
    return this.bus.state.brain;
  }

  /**
   * The command `brain.download`: start or retry the download. Without a yes for that file it only opens the
   * consent card (models.consent.required); the yes is `models.consent`.
   */
  download(modelId) {
    this.flags.noDownload = false;
    const m = modelId ? asPick(modelById(modelId) || MODELS.find((x) => x.name === modelId)) || resolvePick(modelId) || allPicks().find((x) => x.name === modelId) : null;
    if (m) this.flags = { ...this.flags, brain: 'local', modelId: m.id, model: undefined };
    this.start();
  }

  /**
   * The command `models.consent`: the user said yes to this file (the dialog showed its size, source and
   * license). Remembers the yes and the choice, then downloads (with resume and SHA-256) and loads it.
   * @param {{ id: string, via?: 'dialog' | 'models' | 'card', answer?: string }} d
   */
  consentTo(d = {}) {
    const p = resolvePick(String(d.id || ''));
    if (!p) throw Object.assign(new Error('no such model in the catalog'), { code: 'not_found' });
    const via = ['dialog', 'models', 'card'].includes(d.via) ? d.via : 'models';
    this.consent.grant(p, via);
    if (d.answer && d.answer !== 'later') this.consent.answerFirstLaunch(d.answer);
    this.consent.select(p.id);
    this.bus.emit('models.consent.given', { id: p.id, via, license: p.license?.id || null, bytes: p.bytes });
    this.flags = { ...this.flags, brain: 'local', modelId: p.id, model: undefined, noDownload: false };
    this.start();
    return { id: p.id };
  }

  /** "Agora não": nothing downloads, the dialog does not open by itself again; Settings, Models still offers it. */
  later() {
    this.consent.answerFirstLaunch('later');
    this.bus.emit('models.consent.declined', { id: this.pending?.id || null });
    return { firstLaunch: this.consent.firstLaunch };
  }

  cancelDownload(id) {
    if (id && this.installing?.id === id) { this.installing.ctrl.abort(); return { cancelled: true }; }
    if (id && this.installQueue?.some((q) => q.id === id)) {
      this.installQueue = this.installQueue.filter((q) => q.id !== id);
      this.bus.emit('models.install.cancelled', { id });
      return { cancelled: true };
    }
    const had = !!this.downloadCtrl;
    this.downloadCtrl?.abort();
    return { cancelled: had };
  }

  /**
   * The command models.install: the yes for one file, then a download in the background queue, one at a
   * time, without switching the model in use (the Models window installs several).
   */
  install(id) {
    const p = resolvePick(String(id || ''));
    if (!p) throw Object.assign(new Error('no such model in the catalog'), { code: 'not_found' });
    this.consent.grant(p, 'models');
    this.installQueue ||= [];
    if (this.isCached(this.home, p)) return { id: p.id, installed: true };
    if (this.installing?.id === p.id || this.installQueue.some((q) => q.id === p.id)) return { id: p.id, queued: true };
    this.installQueue.push({ id: p.id, at: Date.now() });
    this.bus.emit('models.install.queued', { id: p.id, model: p.name, bytes: p.bytes, position: this.installQueue.length });
    this._pumpInstalls();
    return { id: p.id, queued: true, position: this.installQueue.length };
  }

  async _pumpInstalls() {
    if (this.installing || !this.installQueue?.length) return;
    const next = this.installQueue.shift();
    const p = resolvePick(next.id);
    if (!p || this.flags.noDownload) return this._pumpInstalls();
    const ctrl = new AbortController();
    this.installing = { id: p.id, ctrl, received: 0, total: p.bytes };
    this.bus.emit('models.install.started', { id: p.id, model: p.name, bytes: p.bytes, source: p.source });
    const started = Date.now();
    try {
      await downloadModel(p, {
        home: this.home, fetchImpl: this.fetch, signal: ctrl.signal,
        onProgress: ({ received, total, bps, part, parts }) => {
          Object.assign(this.installing, { received, total, bps });
          this.bus.live('models.install.progress', { id: p.id, received, total, bps, ...(parts ? { part, parts } : {}) });
        }
      });
      this._installedCache = null;
      this.bus.emit('models.install.finished', { id: p.id, model: p.name, bytes: p.bytes, ms: Date.now() - started });
    } catch (err) {
      this.bus.emit(ctrl.signal.aborted ? 'models.install.cancelled' : 'models.install.failed', { id: p.id, model: p.name, code: err.code || 'io', message: String(err.message || err).slice(0, 300), hint: err.hint, ...dlFacts(err) });
    } finally {
      this.installing = null;
      this._pumpInstalls();
    }
  }

  queueState() {
    return {
      current: this.installing ? { id: this.installing.id, received: this.installing.received, total: this.installing.total } : null,
      waiting: (this.installQueue || []).map((q) => q.id)
    };
  }

  /** Disk use of the model folder: every installed file, the total, and the free space. */
  disk() {
    const dir = modelsDir(this.home);
    let total = 0;
    const files = [];
    try {
      for (const name of fs.readdirSync(dir)) {
        if (!/\.gguf(\.part)?$/i.test(name)) continue;
        const bytes = fs.statSync(path.join(dir, name)).size;
        total += bytes;
        files.push({ file: name, bytes, partial: name.endsWith('.part') });
      }
    } catch { /* no folder yet */ }
    return { dir, total, files, free: diskFree(fs.existsSync(dir) ? dir : this.home) };
  }

  /** Switch to an installed model (or ask for the yes when it is not downloaded). */
  switchTo(id) {
    const p = resolvePick(String(id || ''));
    if (!p) throw Object.assign(new Error('no such model in the catalog'), { code: 'not_found' });
    if (this.isCached(this.home, p)) this.consent.select(p.id);
    this.flags = { ...this.flags, brain: 'local', modelId: p.id, model: undefined };
    this.start();
    return { id: p.id, installed: this.isCached(this.home, p) };
  }

  /** Deletes the files of a downloaded model (and any partial download). Not the one in use. */
  async deleteModel(id) {
    const p = resolvePick(String(id || ''));
    if (!p) throw Object.assign(new Error('no such model in the catalog'), { code: 'not_found' });
    const loaded = this.pool?.resident.get(p.id);
    if (loaded?.busy || (!this.pool && this.currentPick?.id === p.id && this.brain)) throw Object.assign(new Error('this model is in use: switch to another one first'), { code: 'conflict' });
    if (loaded) {
      if (this.pool.resident.size <= 1) throw Object.assign(new Error('this is the only loaded model: switch to another one first'), { code: 'conflict' });
      await this.pool._unload(p.id, 'deleted');
    }
    let freed = 0;
    for (const part of modelParts(p)) {
      for (const f of [path.join(modelsDir(this.home), part.file), path.join(modelsDir(this.home), part.file + '.part')]) {
        try { freed += fs.statSync(f).size; fs.rmSync(f, { force: true }); } catch { /* not there */ }
      }
    }
    this.consent.revoke(p.id);
    if (this.consent.data.selected === p.id) this.consent.select(null);
    this.bus.emit('models.deleted', { id: p.id, freed });
    return { id: p.id, freed };
  }

  /** The command `brain.probe`. */
  async probe() {
    const hw = await this.hw();
    const [ollama, lms] = await Promise.all([probeOllama(OLLAMA_URL, this.fetch), probeLmStudio(LMSTUDIO_URL, this.fetch)]);
    const a = await this.analyze();
    const rec = a.recommended;
    const runtime = await findRuntime(this.home);
    const installed = new Set(a.installed);
    const local = [...MODELS.map((m) => asPick(m))];
    for (const id of [rec?.id, ...a.installed]) if (id && !local.some((p) => p.id === id)) local.push(resolvePick(id));
    const options = [
      ...local.filter(Boolean).sort((x, y) => x.bytes - y.bytes).map((m) => ({
        backend: 'local', label: m.name, model: m.id, available: true, bytes: m.bytes, recommended: m.id === rec?.id, license: m.license?.id,
        reason: `${installed.has(m.id) ? 'downloaded' : formatBytes(m.bytes) + ' download'}${runtime ? '' : ', runtime install needed'}`
      })),
      { backend: 'ollama', label: 'Ollama', url: OLLAMA_URL, model: pickServerModel(ollama || []) || undefined, available: !!(ollama && ollama.length), reason: ollama ? (ollama.length ? `${ollama.length} models` : 'no models') : 'not running' },
      { backend: 'lmstudio', label: 'LM Studio', url: LMSTUDIO_URL, model: pickServerModel(lms || []) || undefined, available: !!(lms && lms.length), reason: lms ? (lms.length ? `${lms.length} models` : 'no model loaded') : 'not running' },
      { backend: 'openai', label: 'OpenAI compatible endpoint', available: true, reason: 'needs a URL, a model name and a key' }
    ];
    return { hardware: hw, options, recommended: rec ? { backend: 'local', model: rec.id, label: rec.name, reason: explainText(rec), gpu: rec.where === 'gpu' || rec.where === 'partial', ...(a.warning === 'basic' ? { warning: 'Results with this small model will be basic.' } : {}) } : null };
  }

  cachedModels() {
    const dir = modelsDir(this.home);
    try { return fs.readdirSync(dir).filter((f) => f.endsWith('.gguf')); } catch { return []; }
  }

  /**
   * With automatic rotation on, the loaded model goes into a pool and the scheduler gets the automatic
   * brain, which picks a model per turn by role and task (src/brain/rotation.js). Off: the model itself.
   */
  _rotating(brain, gpu, ctx) {
    if (!this.router.data.auto || !this.currentPick?.quant) { this.pool = null; return brain; }
    const pool = new ModelPool({
      hw: this.hardware, bus: this.bus, log: this.log, maxResident: () => this.router.data.maxResident,
      load: (p, o) => this._loadPick(p, o)
    });
    pool.adopt(this.currentPick, brain, { where: gpu ? 'gpu' : 'cpu', ctx: ctx || this.flags.ctx || contextFor(this.hardware, null, gpu) });
    this.pool = pool;
    let cache = null;
    let cacheAt = 0;
    return createAutoBrain({
      pool, settings: this.router, bus: this.bus, hw: this.hardware, log: this.log,
      defaultCtx: this.flags.ctx || contextFor(this.hardware, null, gpu),
      installed: () => {
        if (!cache || Date.now() - cacheAt > 5000) { cache = this.installedPicks().map((p) => p.id); cacheAt = Date.now(); }
        return cache;
      },
      fallback: () => this.consent.data.selected || this.currentPick?.id || null,
      worker: (id) => (this.bus.state.crew || []).find((w) => w.id === id) || null,
      peek: () => this.scheduler.queueState?.().waiting?.[0] || null
    });
  }

  /** Loads one more installed model for the pool (never downloads: the router only picks installed models). */
  async _loadPick(p, { gpu, ctx }) {
    const legacy = MODELS.find((m) => m.file === p.file && (p.files?.length || 1) === 1);
    const file = this.isCached(this.home, p) ? modelPath(this.home, p) : legacy && this.isCached(this.home, legacy) ? modelPath(this.home, legacy) : null;
    if (!file) throw Object.assign(new Error(`${p.name} is not downloaded`), { code: 'not_installed' });
    const mod = this.runtimeMod || (await this._runtime())?.mod;
    if (!mod) throw new Error('the local runtime is not available');
    return this.createLocal({ mod, modelPath: file, gpu, name: p.name, contextSize: ctx, id: `local:${p.id}` });
  }

  /** The command models.router.set: automatic on or off, pins per role, overrides per task, models kept loaded. */
  setRouter(patch = {}) {
    const before = this.router.data.auto;
    const data = this.router.set(patch);
    this.bus.emit('models.router.changed', data);
    // Switching automatic on or off swaps the brain the scheduler sees: reload once.
    if (before !== data.auto && this.brain && this.brain.kind === 'local') this.start();
    return data;
  }

  routerState() {
    return { ...this.router.data, resident: this.pool ? this.pool.list() : [], failures: this.brain?.failures || {}, preview: this.routerPreview() };
  }

  /** What each crew member would use now, and why (the Models window shows it). */
  routerPreview() {
    if (!this.brain?.decide) {
      // No local model is loaded yet: what the router would pick among the installed models.
      if (!this.hardware) return [];
      const installed = this.installedPicks().map((p) => p.id);
      if (!installed.length) return [];
      const ctx = this.flags.ctx || contextFor(this.hardware, null, !!this.hardware.gpu);
      const crew = [['mel', 'Mel', 'plan'], ['dev', 'Dev', 'code'], ['designer', 'Designer', 'design'], ['qa', 'QA', 'review'], ['writer', 'Writer', 'write'], ['chat', 'Chat', 'chat']];
      return crew.map(([workerId, name, profile]) => {
        const d = routeTurn({ profile, ctx, hw: this.hardware, installed, pin: this.router.data.pins[workerId] || null, worker: name });
        return { workerId, name, id: d.choice?.id || null, model: d.choice?.name || null, where: d.choice?.where || null, reason: d.reason, why: d.why };
      });
    }
    const crew = (this.bus.state.crew || []).length ? this.bus.state.crew : [{ id: 'mel' }, { id: 'dev' }, { id: 'designer' }, { id: 'qa' }, { id: 'writer' }];
    const rows = crew.map((w) => {
      const d = this.brain.decide({ workerId: w.id, kind: 'job' }, [], { maxTokens: 1024 });
      return { workerId: w.id, name: w.name || w.id, id: d.choice?.id || null, model: d.choice?.name || null, where: d.choice?.where || null, reason: d.reason, why: d.why };
    });
    const chat = this.brain.decide({ workerId: 'mel' }, [], { maxTokens: 600 });
    rows.push({ workerId: 'chat', name: 'Chat', id: chat.choice?.id || null, model: chat.choice?.name || null, where: chat.choice?.where || null, reason: chat.reason, why: chat.why });
    return rows;
  }

  async close() {
    this.downloadCtrl?.abort();
  }
}

/**
 * Context size for the local model: 4096 tokens, or 8192 on a GPU with 8 GB of VRAM or more.
 * On a 6 GB card a 7B model only fits fully on the GPU with 4096 (with 8192 some layers stay on the CPU and
 * generation drops from about 11 to under 2 tokens per second, measured on a GTX 1060 6GB), and a small
 * context keeps the RAM use low on the CPU.
 */
export function contextFor(hw, file, gpu) {
  const vram = hw?.gpu?.vramBytes || 0;
  return gpu && vram >= 7.5e9 ? 8192 : 4096;
}

export function bar(name, received, total, bps) {
  const pct = total ? Math.min(100, (received / total) * 100) : 0;
  const width = 24;
  const fill = Math.round((pct / 100) * width);
  const eta = bps > 0 ? Math.round((total - received) / bps) : null;
  const etaText = eta == null ? '' : eta > 90 ? ` ${Math.round(eta / 60)} min left` : ` ${eta} s left`;
  return `${name} [${'#'.repeat(fill)}${'.'.repeat(width - fill)}] ${pct.toFixed(1)}% ${formatBytes(received)} of ${formatBytes(total)}${bps ? ' at ' + formatBytes(bps) + '/s' : ''}${etaText}`;
}
