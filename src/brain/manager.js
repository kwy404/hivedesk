// Picks, installs, downloads and loads the brain with no questions asked (FIRST-RUN.md), and reports every step as events.
import fs from 'node:fs';
import path from 'node:path';
import { detectHardware, formatBytes, diskFree } from './hardware.js';
import { MODELS, modelById, pickModel, smallerModel, isCached, modelPath, downloadModel, DownloadError, modelsDir } from './models.js';
import { loadRuntime, findRuntime, RUNTIME_PACKAGE } from './runtime.js';
import { createLocalBrain } from './local.js';
import { createOllamaBrain, createOpenAIBrain, probeOllama, probeLmStudio, pickServerModel, OLLAMA_URL, LMSTUDIO_URL } from './http.js';

export class BrainManager {
  /**
   * @param {{
   *   bus: import('../bus.js').EventBus, scheduler: import('../crew/scheduler.js').Scheduler, home: string,
   *   flags?: { brain?: string, model?: string, url?: string, key?: string, noDownload?: boolean, gpu?: boolean, ctx?: number },
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
    this.downloadCtrl = null;
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
    if (!this.hardware) this.hardware = await detectHardware({ dir: this.home });
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
    if (f.brain === 'openai') return this._openai();
    if (f.model && (!f.brain || f.brain === 'local')) return this._localFromFlag(f.model);
    if (f.modelId) return this._localAuto(modelById(f.modelId) || undefined);
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
    if (/^(hf:|https?:)/i.test(spec)) {
      const known = MODELS.find((m) => spec.includes(m.file) || spec.includes(m.repo));
      if (known) return this._localAuto(known);
      this.status('error', { backend: 'local', detail: `only the listed Qwen2.5-Coder GGUF files can be downloaded by URI: ${spec}`, hint: 'Download the file yourself and pass its path to --model.' });
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

  /** Auto pick by hardware, download when needed, load. */
  async _localAuto(forced) {
    const hw = await this.hw();
    let model = forced || pickModel(hw, { gpu: this.flags.gpu });
    // Not enough disk: step down to a model that fits.
    if (!this.isCached(this.home, model)) {
      const free = hw.diskFreeBytes ?? diskFree(fs.existsSync(this.home) ? this.home : path.dirname(this.home));
      let m = model;
      while (m && free != null && free < m.bytes + 100e6 && !this.isCached(this.home, m)) m = smallerModel(m);
      if (!m) {
        this.status('error', { backend: 'local', model: model.name, detail: `not enough disk space: ${formatBytes(free)} free, the smallest model needs ${formatBytes(MODELS[0].bytes)}`, hint: 'Free some space, use --model with a GGUF file you already have, or run Ollama or LM Studio.' });
        return;
      }
      if (m !== model) {
        this.bus.emit('brain.fallback', { from: { backend: 'local', model: model.name }, to: { backend: 'local', model: m.name }, reason: `not enough disk space for ${model.name}` });
        this.log(`not enough disk for ${model.name}, using ${m.name}`);
        model = m;
      }
    }
    // Runtime and model in parallel.
    const [runtime, file] = await Promise.all([this._runtime(), this._ensureModel(model)]);
    if (!runtime || !file) return;
    await this._load(runtime, file, model.name, this.flags.gpu !== false && !!hw.gpu, model);
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
      this.bus.emit('brain.runtime', { state: 'failed', package: RUNTIME_PACKAGE, message: String(err.message), hint: err.hint });
      this.status('error', { backend: 'local', detail: String(err.message), hint: err.hint || 'Run hivedesk --doctor, or use --brain ollama or --brain lmstudio.' });
      return null;
    }
  }

  /** Returns the model path, downloading it when needed; null when it is not available. */
  async _ensureModel(model) {
    const target = modelPath(this.home, model);
    if (this.isCached(this.home, model)) return target;
    const info = { model: model.name, file: model.file, url: model.url, bytes: model.bytes, source: model.source };
    this.bus.emit('brain.download.required', info);
    if (this.flags.noDownload) {
      this.status('needs_download', { backend: 'local', model: model.name, detail: `${formatBytes(model.bytes)} from ${model.source}`, hint: 'Started with --no-download: press Download in Settings, or use --model, or Ollama or LM Studio.' });
      return null;
    }
    this.status('downloading', { backend: 'local', model: model.name, detail: `${formatBytes(model.bytes)} from ${model.source}` });
    this.bus.emit('brain.download.started', { ...info, path: target });
    this.log(`downloading ${model.name}, ${formatBytes(model.bytes)}, from ${model.source}`);
    const started = Date.now();
    this.downloadCtrl = new AbortController();
    try {
      const out = await downloadModel(model, {
        home: this.home,
        fetchImpl: this.fetch,
        freeBytes: this.hardware?.diskFreeBytes,
        signal: this.downloadCtrl.signal,
        onProgress: ({ received, total, bps }) => {
          this.bus.live('brain.download.progress', { model: model.name, received, total, bps });
          this.progress(bar(model.name, received, total, bps));
        }
      });
      this.progress(null);
      this.bus.emit('brain.download.finished', { model: model.name, path: out, bytes: model.bytes, ms: Date.now() - started });
      return out;
    } catch (err) {
      this.progress(null);
      const e = err instanceof DownloadError ? err : new DownloadError('io', String(err.message || err), 'Press Retry.');
      if (e.code === 'checksum' && !this._retriedChecksum) {
        this._retriedChecksum = true;
        this.log('checksum mismatch, downloading again');
        return this._ensureModel(model);
      }
      this.bus.emit('brain.download.failed', { model: model.name, code: e.code, message: e.message, hint: e.hint });
      this.status('error', { backend: 'local', model: model.name, detail: e.message, hint: e.hint });
      return null;
    } finally {
      this.downloadCtrl = null;
    }
  }

  async _load(runtime, file, name, gpu, model) {
    this.status('loading', { backend: 'local', model: name, detail: gpu ? 'GPU' : 'CPU' });
    try {
      const brain = await this.createLocal({ mod: runtime.mod, modelPath: file, gpu, name, contextSize: this.flags.ctx, id: 'local' });
      const info = brain.info?.() || {};
      this.attach(brain, { backend: 'local', model: name, detail: info.gpu && info.gpu !== 'cpu' && info.gpu !== false ? `${info.gpu}, ${info.gpuLayers} GPU layers` : 'CPU', ctx: info.contextSize });
      return true;
    } catch (err) {
      if (!gpu) {
        this.status('error', { backend: 'local', model: name, detail: `could not load the model: ${err.message}`, hint: 'Try a smaller model, close other apps to free memory, or use Ollama or LM Studio.' });
        return false;
      }
      // GPU init failed: CPU with the next smaller model (down to 1.5B).
      const smaller = model ? smallerModel(model) || model : null;
      this.bus.emit('brain.fallback', {
        from: { backend: 'local', model: name, gpu: true },
        to: { backend: 'local', model: smaller ? smaller.name : name, gpu: false },
        reason: `the GPU failed to load the model: ${String(err.message).slice(0, 200)}`
      });
      this.log(`GPU failed (${err.message}); trying the CPU${smaller && smaller !== model ? ' with ' + smaller.name : ''}`);
      if (!smaller) return this._load(runtime, file, name, false, null);
      const f2 = await this._ensureModel(smaller);
      if (!f2) return false;
      return this._load(runtime, f2, smaller.name, false, null);
    }
  }

  /** The command `brain.select`. */
  select(choice = {}) {
    const backend = choice.backend;
    if (!['local', 'ollama', 'lmstudio', 'openai', 'fake'].includes(backend)) throw Object.assign(new Error('unknown backend'), { code: 'bad_request' });
    if (backend === 'fake') throw Object.assign(new Error('the fake brain is only for --demo and tests'), { code: 'bad_request' });
    if (typeof choice.key === 'string' && choice.key) this.key = choice.key;
    const shown = { backend };
    if (choice.model) shown.model = choice.model;
    if (choice.url) shown.url = choice.url;
    if (this.key && backend === 'openai') shown.key = 'set';
    this.bus.emit('settings.changed', { brain: shown });
    const next = { brain: backend, model: undefined, modelId: undefined, url: choice.url };
    if (backend === 'local' && choice.model) {
      const m = modelById(choice.model) || MODELS.find((x) => x.name === choice.model);
      if (m) next.modelId = m.id;
      else next.model = choice.model;
    } else if (choice.model) {
      next.model = choice.model;
    }
    this.flags = { ...this.flags, ...next };
    this.start();
    return this.bus.state.brain;
  }

  /** The command `brain.download`: start or retry the automatic download. */
  download(modelId) {
    this.flags.noDownload = false;
    const m = modelId ? modelById(modelId) || MODELS.find((x) => x.name === modelId) : null;
    if (m) this.flags = { ...this.flags, brain: 'local', modelId: m.id, model: undefined };
    this.start();
  }

  /** The command `brain.probe`. */
  async probe() {
    const hw = await this.hw();
    const [ollama, lms] = await Promise.all([probeOllama(OLLAMA_URL, this.fetch), probeLmStudio(LMSTUDIO_URL, this.fetch)]);
    const rec = pickModel(hw, { gpu: this.flags.gpu });
    const runtime = await findRuntime(this.home);
    const options = [
      ...MODELS.map((m) => ({
        backend: 'local', label: m.name, model: m.id, available: true,
        reason: `${this.isCached(this.home, m) ? 'downloaded' : formatBytes(m.bytes) + ' download'}${runtime ? '' : ', runtime install needed'}`
      })),
      { backend: 'ollama', label: 'Ollama', url: OLLAMA_URL, model: pickServerModel(ollama || []) || undefined, available: !!(ollama && ollama.length), reason: ollama ? (ollama.length ? `${ollama.length} models` : 'no models') : 'not running' },
      { backend: 'lmstudio', label: 'LM Studio', url: LMSTUDIO_URL, model: pickServerModel(lms || []) || undefined, available: !!(lms && lms.length), reason: lms ? (lms.length ? `${lms.length} models` : 'no model loaded') : 'not running' },
      { backend: 'openai', label: 'OpenAI compatible endpoint', available: true, reason: 'needs a URL, a model name and a key' }
    ];
    return { hardware: hw, options, recommended: { backend: 'local', model: rec.id, label: rec.name } };
  }

  cachedModels() {
    const dir = modelsDir(this.home);
    try { return fs.readdirSync(dir).filter((f) => f.endsWith('.gguf')); } catch { return []; }
  }

  async close() {
    this.downloadCtrl?.abort();
  }
}

export function bar(name, received, total, bps) {
  const pct = total ? Math.min(100, (received / total) * 100) : 0;
  const width = 24;
  const fill = Math.round((pct / 100) * width);
  const eta = bps > 0 ? Math.round((total - received) / bps) : null;
  const etaText = eta == null ? '' : eta > 90 ? ` ${Math.round(eta / 60)} min left` : ` ${eta} s left`;
  return `${name} [${'#'.repeat(fill)}${'.'.repeat(width - fill)}] ${pct.toFixed(1)}% ${formatBytes(received)} of ${formatBytes(total)}${bps ? ' at ' + formatBytes(bps) + '/s' : ''}${etaText}`;
}
