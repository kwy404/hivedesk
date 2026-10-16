// The extension host: install (folder, zip, URL), permission approval, enable and disable,
// uninstall, the capability gate every extension call goes through, and hot reload for
// extensions in development.
import fs from 'node:fs';
import path from 'node:path';
import { MANIFEST_FILE, validateManifest, describePermission, hostAllowed, ROLE_TOOLS } from './manifest.js';
import { Sandbox } from './sandbox.js';
import { toolHook } from './engine-hook.js';
import { readZip, MAX_BYTES, MAX_FILES } from './zip.js';
import { validate } from '../brain/schema.js';

const SKIP = new Set(['node_modules', '.git', '.hivedesk']);
const CODE = /\.m?js$/;
const STORAGE_CAP = 64 * 1024;
const HTTP_CAP = 512 * 1024;
const READ_CAP = 256 * 1024;

export class ExtError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const fail = (code, message) => { throw new ExtError(code, message); };

/** Joins a relative path under root, refusing anything that leaves it. */
export function inside(root, rel) {
  const clean = String(rel || '').replace(/\\/g, '/');
  if (!clean || clean.startsWith('/') || /^[A-Za-z]:/.test(clean) || clean.split('/').includes('..') || clean.includes('\0')) return null;
  const abs = path.resolve(root, clean);
  const r = path.relative(root, abs);
  return r && !r.startsWith('..') && !path.isAbsolute(r) ? abs : null;
}

/** Lists the files of an extension folder: relative path -> absolute path. */
export function walkFolder(dir) {
  const out = new Map();
  let bytes = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const abs = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { walk(abs); continue; }
      if (!e.isFile()) continue;
      bytes += fs.statSync(abs).size;
      if (out.size >= MAX_FILES) throw new ExtError('bad_request', `the extension has more than ${MAX_FILES} files`);
      if (bytes > MAX_BYTES) throw new ExtError('bad_request', `the extension is larger than ${MAX_BYTES / 1024 / 1024} MB`);
      out.set(path.relative(dir, abs).split(path.sep).join('/'), abs);
    }
  };
  walk(dir);
  return out;
}

export function readManifest(dir) {
  const file = path.join(dir, MANIFEST_FILE);
  if (!fs.existsSync(file)) return { ok: false, errors: [`${MANIFEST_FILE} is missing`], warnings: [], manifest: null, raw: null };
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { return { ok: false, errors: [`${MANIFEST_FILE} is not valid JSON: ${err.message}`], warnings: [], manifest: null, raw: null }; }
  const v = validateManifest(raw, { files: (rel) => { const abs = inside(dir, rel); return !!abs && fs.existsSync(abs); } });
  return { ...v, raw };
}

export class ExtensionHost {
  /**
   * @param {{
   *   bus: import('../bus.js').EventBus, toolbox: import('../tools/index.js').ToolBox,
   *   hive?: import('../crew/engine.js').Hive, scheduler?: import('../crew/scheduler.js').Scheduler,
   *   home: string, builtinDir?: string, fetch?: typeof fetch, watch?: boolean, sandbox?: { idleMs?: number, timeoutMs?: number }
   * }} opts
   */
  constructor(opts) {
    this.bus = opts.bus;
    this.toolbox = opts.toolbox;
    this.hive = opts.hive || null;
    this.scheduler = opts.scheduler || null;
    this.fetch = opts.fetch || globalThis.fetch;
    this.watchDev = opts.watch !== false;
    this.root = path.join(opts.home, 'extensions');
    this.dirs = { installed: path.join(this.root, 'installed'), dev: path.join(this.root, 'dev'), data: path.join(this.root, 'data') };
    for (const d of Object.values(this.dirs)) fs.mkdirSync(d, { recursive: true });
    this.regFile = path.join(this.root, 'registry.json');
    this.builtinDir = opts.builtinDir || null;
    /** @type {Record<string, any>} */
    this.reg = {};
    try { this.reg = JSON.parse(fs.readFileSync(this.regFile, 'utf8')) || {}; } catch { this.reg = {}; }
    /** @type {Map<string, { manifest: any, dir: string, errors: string[], warnings: string[] }>} */
    this.exts = new Map();
    this.active = new Map(); // id -> { tools: string[] }
    this.watchers = new Map();
    this.ctx = new Map();
    this.hook = toolHook(this.toolbox);
    this.sandbox = new Sandbox({
      onCapability: (id, cap, args) => this.capability(id, cap, args),
      onLog: (id, level, text) => this.bus.live('extension.log', { id, level, text }),
      ...(opts.sandbox || {})
    });
  }

  save() {
    const tmp = this.regFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.reg, null, 2));
    fs.renameSync(tmp, this.regFile);
  }

  /** Reads every known extension and activates the enabled ones. */
  start() {
    if (this.builtinDir && fs.existsSync(this.builtinDir)) {
      for (const e of fs.readdirSync(this.builtinDir, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const dir = path.join(this.builtinDir, e.name);
        const m = readManifest(dir);
        const id = m.manifest?.id || m.raw?.id || e.name;
        if (!this.reg[id]) this.reg[id] = { source: 'builtin', enabled: false, pending: true, granted: [], installedAt: new Date().toISOString() };
        if (this.reg[id].source === 'builtin') this.reg[id].dir = dir;
      }
    }
    for (const [id, r] of Object.entries(this.reg)) {
      if (!r.dir || !fs.existsSync(r.dir)) { delete this.reg[id]; continue; }
      this.refresh(id);
    }
    this.save();
    for (const [id, r] of Object.entries(this.reg)) {
      if (r.enabled && !r.pending) {
        try { this.activate(id); } catch (err) { this.bus.live('extension.log', { id, level: 'error', text: `could not start: ${err.message}` }); }
      }
      if (r.source === 'dev') this._watch(id);
    }
    return this;
  }

  refresh(id) {
    const r = this.reg[id];
    const m = readManifest(r.dir);
    this.exts.set(id, { manifest: m.manifest, raw: m.raw, dir: r.dir, errors: m.errors, warnings: m.warnings });
    return this.exts.get(id);
  }

  /** What the Extensions window shows. */
  summary(id) {
    const r = this.reg[id];
    const e = this.exts.get(id) || this.refresh(id);
    const m = e.manifest;
    const raw = e.raw || {};
    return {
      id, source: r.source, enabled: !!r.enabled, pending: !!r.pending, dev: r.source === 'dev',
      name: m?.name || raw.name || id, version: m?.version || raw.version || '', author: m?.author || (typeof raw.author === 'string' ? raw.author : '') || '',
      description: m?.description || raw.description || '', url: r.url,
      permissions: (m?.permissions || []).map(describePermission), granted: r.granted || [],
      contributes: m ? {
        tools: m.contributes.tools.map((t) => ({ id: t.id, name: `${id}.${t.id}`, description: t.description })),
        roles: m.contributes.roles.map((x) => ({ id: x.id, name: x.name, role: x.role, workerId: r.workers?.[x.id] || null })),
        widgets: m.contributes.widgets,
        commands: m.contributes.commands,
        themes: m.contributes.themes
      } : { tools: [], roles: [], widgets: [], commands: [], themes: [] },
      errors: e.errors, warnings: e.warnings, installedAt: r.installedAt, path: r.source === 'dev' ? r.dir : undefined
    };
  }

  list() { return Object.keys(this.reg).sort().map((id) => this.summary(id)); }

  get(id) {
    if (!this.reg[id]) fail('not_found', `no extension ${id}`);
    return this.reg[id];
  }

  /* ---------- install ---------- */

  /**
   * Stages an extension: copies it under ~/.hivedesk/extensions/installed/<id>, validates it and
   * waits for the user to approve its permissions. Nothing runs before that.
   * @param {{ path?: string, zipBase64?: string, url?: string }} src
   */
  async install(src = {}) {
    let files; // Map rel -> Buffer
    let source;
    if (typeof src.url === 'string' && src.url) {
      files = await this._download(src.url);
      source = 'url';
    } else if (typeof src.zipBase64 === 'string' && src.zipBase64) {
      files = readZip(Buffer.from(src.zipBase64, 'base64'));
      source = 'zip';
    } else if (typeof src.path === 'string' && src.path.trim()) {
      const p = path.resolve(src.path.trim());
      if (!fs.existsSync(p)) fail('not_found', `nothing at ${p}`);
      if (fs.statSync(p).isDirectory()) {
        files = new Map([...walkFolder(p)].map(([rel, abs]) => [rel, fs.readFileSync(abs)]));
        source = 'folder';
      } else if (/\.zip$/i.test(p)) {
        files = readZip(fs.readFileSync(p));
        source = 'zip';
      } else fail('bad_request', 'choose an extension folder or a .zip file');
    } else fail('bad_request', 'give a folder, a .zip or a URL');

    if (!files.has(MANIFEST_FILE)) fail('bad_request', `${MANIFEST_FILE} is missing at the top of the extension`);
    let raw;
    try { raw = JSON.parse(files.get(MANIFEST_FILE).toString('utf8')); } catch (err) { fail('bad_request', `${MANIFEST_FILE} is not valid JSON: ${err.message}`); }
    const v = validateManifest(raw, { files: (rel) => files.has(rel) });
    if (!v.ok) fail('bad_request', `the manifest has problems:\n- ${v.errors.join('\n- ')}`);
    const id = v.manifest.id;
    const prev = this.reg[id];
    if (prev && prev.source === 'builtin') fail('conflict', `${id} is a built-in extension; give yours another id`);
    if (prev && prev.source === 'dev') fail('conflict', `${id} is an extension in development; give it another id or remove it first`);
    if (prev?.enabled) this.deactivate(id);
    const dir = path.join(this.dirs.installed, id);
    fs.rmSync(dir, { recursive: true, force: true });
    for (const [rel, data] of files) {
      const abs = inside(dir, rel);
      if (!abs) fail('bad_request', `unsafe path ${rel}`);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, data);
    }
    this.reg[id] = {
      source, dir, enabled: false, pending: true, granted: [], installedAt: new Date().toISOString(),
      ...(source === 'url' ? { url: String(src.url).slice(0, 500) } : {}),
      ...(prev?.workers ? { workers: prev.workers } : {})
    };
    this.save();
    this.refresh(id);
    const summary = this.summary(id);
    this.bus.emit('extension.installed', { id, name: summary.name, version: summary.version, source, permissions: v.manifest.permissions });
    return { extension: summary, warnings: v.warnings, needsApproval: true, risk: source === 'url' ? 'url' : 'local' };
  }

  async _download(url) {
    let u;
    try { u = new URL(url); } catch { fail('bad_request', 'that is not a URL'); }
    if (u.protocol !== 'https:') fail('bad_request', 'only https:// URLs can be installed');
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20_000);
    try {
      const res = await this.fetch(u.href, { signal: ctrl.signal, redirect: 'follow' });
      if (!res.ok) fail('bad_request', `the download answered ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_BYTES) fail('bad_request', 'the download is larger than 5 MB');
      return readZip(buf);
    } catch (err) {
      if (err instanceof ExtError) throw err;
      fail('bad_request', `could not download the extension: ${err.message}`);
    } finally { clearTimeout(t); }
  }

  /** Registers a folder under ~/.hivedesk/extensions/dev (made by the crew or by hand). */
  addDev(name) {
    const dir = inside(this.dirs.dev, name);
    if (!dir || !fs.existsSync(path.join(dir, MANIFEST_FILE))) fail('not_found', `no extension folder ${name} in ${this.dirs.dev}`);
    const m = readManifest(dir);
    const id = m.manifest?.id || m.raw?.id;
    if (!id) fail('bad_request', `the manifest has problems:\n- ${m.errors.join('\n- ')}`);
    const prev = this.reg[id];
    if (prev && prev.source !== 'dev') fail('conflict', `an extension with the id ${id} is already installed`);
    if (prev?.enabled) this.deactivate(id);
    this.reg[id] = { source: 'dev', dir, enabled: false, pending: true, granted: prev?.granted || [], installedAt: prev?.installedAt || new Date().toISOString(), ...(prev?.workers ? { workers: prev.workers } : {}) };
    this.save();
    this.refresh(id);
    this._watch(id);
    const summary = this.summary(id);
    this.bus.emit('extension.installed', { id, name: summary.name, version: summary.version, source: 'dev', permissions: summary.permissions.map((p) => p.permission) });
    return { extension: summary, warnings: m.warnings, errors: m.errors, needsApproval: true, risk: 'local' };
  }

  /**
   * The user's answer to the permission prompt. `grant` defaults to everything requested.
   * URL installs also need `acceptRisk: true` (the strong warning in the UI).
   */
  approve(id, { grant, acceptRisk } = {}) {
    const r = this.get(id);
    const e = this.refresh(id);
    if (!e.manifest) fail('bad_request', `the manifest has problems:\n- ${e.errors.join('\n- ')}`);
    if (r.source === 'url' && acceptRisk !== true) fail('bad_request', 'this extension came from a URL: confirm that you trust its author first');
    const requested = e.manifest.permissions;
    r.granted = Array.isArray(grant) ? requested.filter((p) => grant.includes(p)) : [...requested];
    r.pending = false;
    r.enabled = true;
    r.approvedAt = new Date().toISOString();
    this.save();
    this.activate(id);
    return this.summary(id);
  }

  enable(id) {
    const r = this.get(id);
    if (r.pending) fail('conflict', 'approve its permissions first');
    if (r.enabled) return this.summary(id);
    r.enabled = true;
    this.save();
    this.activate(id);
    return this.summary(id);
  }

  disable(id) {
    const r = this.get(id);
    if (!r.enabled) return this.summary(id);
    this.deactivate(id);
    r.enabled = false;
    this.save();
    this.bus.emit('extension.disabled', { id });
    return this.summary(id);
  }

  /** Takes one permission back. The extension keeps running without it. */
  revoke(id, permission) {
    const r = this.get(id);
    r.granted = (r.granted || []).filter((p) => p !== permission);
    this.save();
    if (r.enabled) { this.deactivate(id); this.activate(id); }
    this.bus.emit('extension.revoked', { id, permission });
    return this.summary(id);
  }

  uninstall(id, { deleteFiles = false } = {}) {
    const r = this.get(id);
    if (r.source === 'builtin') fail('conflict', 'built-in extensions can be disabled, not removed');
    if (r.enabled) this.deactivate(id);
    this._unwatch(id);
    if (r.source !== 'dev' || deleteFiles) fs.rmSync(r.dir, { recursive: true, force: true });
    fs.rmSync(path.join(this.dirs.data, `${id}.json`), { force: true });
    delete this.reg[id];
    this.exts.delete(id);
    this.save();
    this.bus.emit('extension.uninstalled', { id });
    return {};
  }

  /* ---------- running ---------- */

  toolName(id, toolId) { return `${id}.${toolId}`; }

  activate(id) {
    const r = this.get(id);
    const e = this.refresh(id);
    if (!e.manifest) fail('bad_request', `the manifest has problems:\n- ${e.errors.join('\n- ')}`);
    if (this.active.has(id)) this.deactivate(id);
    const m = e.manifest;
    const granted = new Set(r.granted || []);
    if (m.main) {
      const code = {};
      let bytes = 0;
      for (const [rel, abs] of walkFolder(e.dir)) {
        if (!CODE.test(rel)) continue;
        code[rel] = fs.readFileSync(abs, 'utf8');
        bytes += code[rel].length;
      }
      if (bytes > 1024 * 1024) fail('bad_request', 'the extension code is larger than 1 MB');
      this.sandbox.set(id, code, m.main);
    }
    const tools = [];
    for (const t of m.contributes.tools) {
      const name = this.toolName(id, t.id);
      this.hook.add(name, { description: `${t.description} (extension ${m.name})`, parameters: t.parameters, destructive: t.destructive }, (args, ctx) => this.callTool(id, t.id, args, ctx));
      tools.push(name);
    }
    this.active.set(id, { tools });
    // Workers from the extension: only with crew.roles, and only the tools whose permission was granted.
    if (this.hive && m.contributes.roles.length && granted.has('crew.roles')) {
      r.workers = r.workers || {};
      for (const role of m.contributes.roles) {
        const toolsOf = role.tools.filter((x) => (ROLE_TOOLS[x] ? granted.has(ROLE_TOOLS[x]) : true)).map((x) => (ROLE_TOOLS[x] ? x : this.toolName(id, x)));
        const spec = { name: role.name, role: role.role, prompt: role.prompt, color: role.color, avatar: role.avatar, tools: toolsOf.length ? toolsOf : ['list_files'] };
        const existing = r.workers[role.id] && this.hive.state.crew.find((w) => w.id === r.workers[role.id]);
        if (existing) {
          // hireWorker filters tools by the engine list, so update keeps the extension tools.
          this.bus.emit('crew.updated', { worker: { ...existing, ...spec, extension: id } });
        } else {
          const w = this.hive.hire(spec);
          if (spec.tools.some((x) => !w.tools.includes(x))) this.bus.emit('crew.updated', { worker: { ...w, tools: spec.tools, extension: id } });
          r.workers[role.id] = w.id;
        }
      }
      this.save();
    }
    this.bus.emit('extension.enabled', { id, tools, granted: [...granted] });
  }

  deactivate(id) {
    const a = this.active.get(id);
    if (a) for (const name of a.tools) this.hook.remove(name);
    this.active.delete(id);
    this.sandbox.remove(id);
    const r = this.reg[id];
    if (r?.workers && this.hive) {
      for (const wid of Object.values(r.workers)) {
        if (this.hive.state.crew.some((w) => w.id === wid)) { try { this.hive.fire(wid); } catch { /* already gone */ } }
      }
      r.workers = {};
      this.save();
    }
  }

  /** Runs one tool of an extension in the sandbox. Workers, widgets and palette commands all come here. */
  async callTool(id, toolId, args = {}, ctx = {}) {
    const r = this.reg[id];
    if (!r || !r.enabled || r.pending || !this.active.has(id)) fail('conflict', `extension ${id} is not enabled`);
    const m = this.exts.get(id)?.manifest;
    const def = m?.contributes.tools.find((t) => t.id === toolId);
    if (!def) fail('not_found', `${id} has no tool ${toolId}`);
    const errors = validate(def.parameters, args);
    if (errors.length) fail('bad_request', `bad arguments for ${id}.${toolId}: ${errors.join('; ')}`);
    this.ctx.set(id, ctx);
    const out = await this.sandbox.call(id, toolId, args);
    return typeof out === 'string' ? out : JSON.stringify(out);
  }

  _need(id, permission, cap) {
    const r = this.reg[id];
    if (!r || !r.enabled) throw new ExtError('conflict', `extension ${id} is not enabled`);
    if (!(r.granted || []).includes(permission)) {
      this.bus.emit('extension.denied', { id, permission, cap });
      throw new ExtError('denied', `permission denied: ${id} was not given "${permission}"`);
    }
  }

  /**
   * The capability gate. Extension code reaches the engine only through these calls.
   * @param {string} id
   * @param {string} cap
   * @param {any} args
   */
  async capability(id, cap, args = {}) {
    const ctx = this.ctx.get(id) || {};
    switch (cap) {
      case 'workspace.list':
        this._need(id, 'workspace.read', cap);
        return this.toolbox.ws.list();
      case 'workspace.read': {
        this._need(id, 'workspace.read', cap);
        const text = this.toolbox.ws.read(String(args.path || ''));
        return text.length > READ_CAP ? text.slice(0, READ_CAP) : text;
      }
      case 'workspace.write': {
        this._need(id, 'workspace.write', cap);
        const p = String(args.path || '');
        const out = await this.toolbox.execute('write_file', { path: p, content: String(args.content ?? '') }, {
          jobId: ctx.jobId, taskId: ctx.taskId, workerId: ctx.workerId || `ext:${id}`,
          preexisting: this.toolbox.ws.exists(p) ? new Set([p.replace(/\\/g, '/').replace(/^\.\//, '')]) : new Set(), approval: ctx.approval
        });
        if (!out.ok) throw new Error(out.error);
        return out.result;
      }
      case 'http.get': return this._httpGet(id, args);
      case 'storage.get': {
        this._need(id, 'storage', cap);
        const data = this._storage(id);
        return args.key == null ? data : data[String(args.key)] ?? null;
      }
      case 'storage.set': {
        this._need(id, 'storage', cap);
        const data = this._storage(id);
        data[String(args.key)] = args.value === undefined ? null : args.value;
        const text = JSON.stringify(data);
        if (text.length > STORAGE_CAP) throw new Error('storage is full (64 KB)');
        fs.writeFileSync(path.join(this.dirs.data, `${id}.json`), text);
        return true;
      }
      case 'notify': {
        this._need(id, 'notify', cap);
        const name = this.exts.get(id)?.manifest?.name || id;
        this.bus.live('extension.notify', { id, name, title: String(args.title || name).slice(0, 120), body: String(args.body || '').slice(0, 500) });
        return true;
      }
      case 'crew.chat': {
        this._need(id, 'crew.chat', cap);
        const name = this.exts.get(id)?.manifest?.name || id;
        const text = `[${name}] ${String(args.text || '').slice(0, 1000)}`;
        if (this.hive) this.hive.chat('system', text, ctx.taskId, 'general', ctx.jobId);
        return true;
      }
      case 'brain.ask': {
        this._need(id, 'brain.ask', cap);
        if (!this.scheduler?.hasBrain) throw new Error('no model yet');
        const options = { maxTokens: 800, temperature: 0.3 };
        if (args.schema && typeof args.schema === 'object') options.schema = args.schema;
        const r = await this.scheduler.turn({ workerId: `ext:${id}`, jobId: ctx.jobId, messages: [{ role: 'user', content: String(args.prompt || '').slice(0, 8000) }], options });
        return options.schema ? r.json ?? null : r.text;
      }
      default:
        throw new ExtError('denied', `unknown capability ${cap}`);
    }
  }

  _storage(id) {
    try { return JSON.parse(fs.readFileSync(path.join(this.dirs.data, `${id}.json`), 'utf8')) || {}; } catch { return {}; }
  }

  async _httpGet(id, args) {
    const r = this.reg[id];
    if (!r?.enabled) throw new ExtError('conflict', `extension ${id} is not enabled`);
    let url = String(args.url || '');
    for (let hop = 0; hop < 4; hop++) {
      let u;
      try { u = new URL(url); } catch { throw new Error('http.get needs a full https:// URL'); }
      if (u.protocol !== 'https:') throw new Error('http.get only allows https:// URLs');
      if (!hostAllowed(r.granted || [], u.href)) {
        this.bus.emit('extension.denied', { id, permission: `http.get:${u.hostname}`, cap: 'http.get' });
        throw new ExtError('denied', `permission denied: ${id} may not download from ${u.hostname}`);
      }
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 10_000);
      let res;
      try {
        res = await this.fetch(u.href, { signal: ctrl.signal, redirect: 'manual', headers: { accept: 'application/json, text/plain, text/html;q=0.8, */*;q=0.5', 'user-agent': 'hivedesk-extension' } });
      } finally { clearTimeout(t); }
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { url = new URL(res.headers.get('location'), u).href; continue; }
      const buf = Buffer.from(await res.arrayBuffer());
      const text = buf.subarray(0, HTTP_CAP).toString('utf8');
      const type = res.headers.get('content-type') || '';
      let json;
      if (/json/.test(type)) { try { json = JSON.parse(text); } catch { /* not JSON after all */ } }
      return { status: res.status, contentType: type, text, ...(json !== undefined ? { json } : {}), truncated: buf.length > HTTP_CAP };
    }
    throw new Error('too many redirects');
  }

  /** Files a widget iframe needs: its HTML and the scripts and styles it links to. */
  widget(id, widgetId) {
    const r = this.get(id);
    if (!r.enabled) fail('conflict', `extension ${id} is not enabled`);
    const e = this.exts.get(id);
    const w = e?.manifest?.contributes.widgets.find((x) => x.id === widgetId);
    if (!w) fail('not_found', `${id} has no widget ${widgetId}`);
    const htmlAbs = inside(e.dir, w.entry);
    const html = fs.readFileSync(htmlAbs, 'utf8');
    const base = path.posix.dirname(w.entry);
    const files = {};
    for (const m of html.matchAll(/<(?:script[^>]*\ssrc|link[^>]*\shref)=["']([^"':]+)["']/gi)) {
      const rel = path.posix.normalize(path.posix.join(base === '.' ? '' : base, m[1]));
      const abs = inside(e.dir, rel);
      if (abs && /\.(m?js|css)$/.test(rel) && fs.existsSync(abs) && fs.statSync(abs).size <= 512 * 1024) files[m[1]] = fs.readFileSync(abs, 'utf8');
    }
    return { id, widget: w, html, files, granted: r.granted || [], name: e.manifest.name };
  }

  /** Theme files of enabled extensions, for the theme gallery. */
  themeFiles() {
    const out = [];
    for (const [id, r] of Object.entries(this.reg)) {
      if (!r.enabled) continue;
      const e = this.exts.get(id);
      for (const rel of e?.manifest?.contributes.themes || []) {
        const abs = inside(e.dir, rel);
        try { out.push({ extension: id, data: JSON.parse(fs.readFileSync(abs, 'utf8')) }); } catch { /* skipped, shown as an error in the list */ }
      }
    }
    return out;
  }

  /* ---------- hot reload ---------- */

  _watch(id) {
    if (!this.watchDev || this.watchers.has(id)) return;
    const r = this.reg[id];
    let timer = null;
    try {
      const w = fs.watch(r.dir, { recursive: true }, () => {
        clearTimeout(timer);
        timer = setTimeout(() => this.reload(id), 250);
        timer.unref?.();
      });
      w.on('error', () => this._unwatch(id));
      w.unref?.();
      this.watchers.set(id, w);
    } catch { /* no watcher on this platform: the Reload button still works */ }
  }

  _unwatch(id) {
    const w = this.watchers.get(id);
    if (w) { try { w.close(); } catch { /* closed */ } }
    this.watchers.delete(id);
  }

  /** Reads the folder again; a running extension restarts with the new code. */
  reload(id) {
    const r = this.reg[id];
    if (!r) return null;
    const before = new Set(this.exts.get(id)?.manifest?.permissions || []);
    const e = this.refresh(id);
    if (!e.manifest) {
      this.bus.emit('extension.reloaded', { id, ok: false, errors: e.errors });
      return this.summary(id);
    }
    const added = e.manifest.permissions.filter((p) => !before.has(p) && !(r.granted || []).includes(p));
    if (added.length && !r.pending) {
      // New permissions always go back to the user.
      if (r.enabled) this.deactivate(id);
      r.enabled = false;
      r.pending = true;
      this.save();
      this.bus.emit('extension.reloaded', { id, ok: true, needsApproval: true, added });
      return this.summary(id);
    }
    if (r.enabled) {
      try { this.activate(id); } catch (err) { this.bus.emit('extension.reloaded', { id, ok: false, errors: [err.message] }); return this.summary(id); }
    }
    this.bus.emit('extension.reloaded', { id, ok: true });
    return this.summary(id);
  }

  close() {
    for (const id of [...this.watchers.keys()]) this._unwatch(id);
    for (const id of [...this.active.keys()]) {
      const a = this.active.get(id);
      for (const name of a.tools) this.hook.remove(name);
    }
    this.active.clear();
    this.sandbox.stop();
  }
}
