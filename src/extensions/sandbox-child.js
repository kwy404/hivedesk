// The extension sandbox process. Started by sandbox.js with Node's permission model (no file
// system, no child processes, no workers, no addons) and a small heap. Extension code runs
// inside a vm context with no require, no process and no import outside its own files; the
// only way out is the `api` object, whose calls travel to the engine and are checked there.
import vm from 'node:vm';

const exts = new Map(); // extId -> { ns, context }
const pending = new Map(); // capability call id -> { resolve, reject }
let capSeq = 0;

const send = (msg) => { try { process.send(msg); } catch { /* the parent is gone */ } };

function resolveSpec(from, spec) {
  if (!spec.startsWith('./') && !spec.startsWith('../')) return null;
  const base = from.split('/').slice(0, -1);
  for (const part of spec.split('/')) {
    if (part === '.' || part === '') continue;
    if (part === '..') { if (!base.length) return null; base.pop(); } else base.push(part);
  }
  return base.join('/');
}

function makeApi(extId) {
  const cap = (name, args) => new Promise((resolve, reject) => {
    const id = `k${++capSeq}`;
    pending.set(id, { resolve, reject });
    send({ t: 'cap', id, extId, cap: name, args: args === undefined ? {} : JSON.parse(JSON.stringify(args)) });
  });
  return Object.freeze({
    workspace: Object.freeze({
      list: () => cap('workspace.list'),
      read: (path) => cap('workspace.read', { path }),
      write: (path, content) => cap('workspace.write', { path, content })
    }),
    http: Object.freeze({ get: (url, opts) => cap('http.get', { url, ...(opts || {}) }) }),
    storage: Object.freeze({ get: (key) => cap('storage.get', { key }), set: (key, value) => cap('storage.set', { key, value }) }),
    notify: (title, body) => cap('notify', { title, body }),
    chat: (text) => cap('crew.chat', { text }),
    ask: (prompt, schema) => cap('brain.ask', { prompt, schema })
  });
}

async function load(msg) {
  const { extId, files, entry } = msg;
  const logs = [];
  const log = (level) => (...a) => send({ t: 'log', extId, level, text: a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ').slice(0, 2000) });
  const context = vm.createContext({ console: Object.freeze({ log: log('info'), info: log('info'), warn: log('warn'), error: log('error') }) }, {
    name: `extension:${extId}`,
    codeGeneration: { strings: false, wasm: false }
  });
  const cache = new Map();
  const build = (rel) => {
    if (cache.has(rel)) return cache.get(rel);
    if (typeof files[rel] !== 'string') throw new Error(`${extId}: module ${rel} is not in the extension`);
    const mod = new vm.SourceTextModule(files[rel], { context, identifier: `ext://${extId}/${rel}` });
    cache.set(rel, mod);
    return mod;
  };
  const root = build(entry);
  await root.link((spec, ref) => {
    const from = ref.identifier.replace(`ext://${extId}/`, '');
    const target = resolveSpec(from, spec);
    if (!target) throw new Error(`${extId}: "${spec}" cannot be imported; extensions only import their own files`);
    return build(target);
  });
  await root.evaluate({ timeout: 2000 });
  const ns = root.namespace;
  const tools = (ns.default && typeof ns.default === 'object' && ns.default.tools) || ns.tools || {};
  exts.set(extId, { tools, api: makeApi(extId), logs });
  return Object.keys(tools).filter((k) => typeof tools[k] === 'function');
}

process.on('message', async (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.t === 'capResult') {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result); else p.reject(new Error(msg.error || 'denied'));
    return;
  }
  if (msg.t === 'load') {
    try { send({ t: 'reply', id: msg.id, ok: true, result: { tools: await load(msg) } }); } catch (err) { send({ t: 'reply', id: msg.id, ok: false, error: String(err?.message || err) }); }
    return;
  }
  if (msg.t === 'unload') { exts.delete(msg.extId); send({ t: 'reply', id: msg.id, ok: true, result: {} }); return; }
  if (msg.t === 'call') {
    try {
      const ext = exts.get(msg.extId);
      if (!ext) throw new Error(`extension ${msg.extId} is not loaded`);
      const fn = ext.tools[msg.tool];
      if (typeof fn !== 'function') throw new Error(`${msg.extId} has no tool ${msg.tool}`);
      const out = await fn(msg.args || {}, ext.api);
      const result = out === undefined ? null : JSON.parse(JSON.stringify(out));
      send({ t: 'reply', id: msg.id, ok: true, result });
    } catch (err) {
      send({ t: 'reply', id: msg.id, ok: false, error: String(err?.message || err).slice(0, 2000) });
    }
  }
});

send({ t: 'ready', permission: typeof process.permission?.has === 'function' ? !process.permission.has('fs.read', '/') : false });
