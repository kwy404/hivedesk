// HTTP and WebSocket server: 127.0.0.1 only, a per run token on every request, static UI, REST and commands.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { acceptUpgrade, rejectUpgrade } from './ws.js';
import { createRelayBrain } from './brain/relay.js';
import { PROTOCOL } from './replay/reduce.js';
import { marks } from './replay/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = path.resolve(HERE, '..');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.ogg': 'audio/ogg', '.webm': 'video/webm', '.mp4': 'video/mp4', '.map': 'application/json'
};

export class CommandError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function safeJoin(root, rel) {
  let decoded;
  try { decoded = decodeURIComponent(rel); } catch { return null; }
  if (decoded.includes('\0')) return null;
  const abs = path.resolve(root, '.' + path.posix.normalize('/' + decoded.replace(/\\/g, '/')));
  const r = path.relative(root, abs);
  if (r.startsWith('..') || path.isAbsolute(r)) return null;
  return abs;
}

function tokenEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

/**
 * @param {{
 *   bus: import('./bus.js').EventBus, hive: import('./crew/engine.js').Hive, scheduler: import('./crew/scheduler.js').Scheduler,
 *   approvals: import('./tools/approvals.js').Approvals, playbooks: import('./playbooks/index.js').PlaybookStore,
 *   toolbox: import('./tools/index.js').ToolBox, brains?: import('./brain/manager.js').BrainManager,
 *   doctor?: () => Promise<any>, token?: string, port?: number, host?: string, uiDir?: string, assetsDir?: string,
 *   demo?: boolean, lend?: boolean, version?: string, dir?: string
 * }} opts
 */
export function createServer(opts) {
  const { bus, hive, scheduler, approvals, playbooks, toolbox } = opts;
  const token = opts.token || crypto.randomBytes(16).toString('hex');
  const host = opts.host || '127.0.0.1';
  const uiDir = opts.uiDir || path.join(PACKAGE_ROOT, 'ui');
  const assetsDir = opts.assetsDir || path.join(PACKAGE_ROOT, 'assets');
  const version = opts.version || '0.0.0';
  const clients = new Set();
  const routes = [];
  const commands = new Map();
  let port = 0;
  let clientSeq = 0;

  const meta = () => ({ protocol: PROTOCOL, version, demo: !!opts.demo, lend: !!opts.lend });

  function allowedHost(req) {
    const h = String(req.headers.host || '');
    return h === `127.0.0.1:${port}` || h === `localhost:${port}` || h === `[::1]:${port}`;
  }

  function authed(req, url) {
    const q = url.searchParams.get('t');
    if (q && tokenEquals(q, token)) return 'query';
    const auth = String(req.headers.authorization || '');
    if (auth.startsWith('Bearer ') && tokenEquals(auth.slice(7), token)) return 'header';
    const c = readCookie(req, 'hivedesk_token');
    if (c && tokenEquals(c, token)) return 'cookie';
    return null;
  }

  function send(res, status, body, headers = {}) {
    const isBuf = Buffer.isBuffer(body);
    const text = isBuf || typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, {
      'content-type': isBuf || typeof body === 'string' ? headers['content-type'] || 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      ...headers
    });
    res.end(text);
  }

  function sendError(res, status, code, message) {
    send(res, status, { error: { code, message } });
  }

  function serveFile(res, abs, extraHeaders = {}) {
    let st;
    try { st = fs.statSync(abs); } catch { return false; }
    if (st.isDirectory()) {
      abs = path.join(abs, 'index.html');
      try { st = fs.statSync(abs); } catch { return false; }
    }
    if (!st.isFile()) return false;
    const type = TYPES[path.extname(abs).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'content-length': st.size, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff', ...extraHeaders });
    fs.createReadStream(abs).pipe(res);
    return true;
  }

  function fallbackPage() {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>hivedesk</title>
<style>body{background:#141210;color:#F2E9DA;font:16px system-ui,sans-serif;margin:0;padding:40px 16px}main{max-width:640px;margin:0 auto}code{color:#FFB531}</style></head>
<body><main><h1>hivedesk engine is running</h1><p>The desktop UI files were not found in <code>ui/</code>. The engine API is up: <code>/api/state</code>, <code>/ws</code>.</p></main></body></html>`;
  }

  async function readBody(req, limit = 1024 * 1024) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) { reject(new CommandError('bad_request', 'body too large')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  // ---- commands ----
  function command(type, handler) {
    commands.set(type, handler);
  }

  async function runCommand(type, data, client) {
    const handler = commands.get(type);
    if (!handler) throw new CommandError('bad_request', `unknown command: ${type}`);
    return handler(data && typeof data === 'object' ? data : {}, client);
  }

  const need = (cond, msg) => { if (!cond) throw new CommandError('bad_request', msg); };

  command('ping', () => ({ pong: true, ts: new Date().toISOString() }));
  command('job.create', (d) => {
    need(typeof d.request === 'string' && d.request.trim(), 'request is required');
    const { jobId } = hive.createJob({ request: d.request, approval: typeof d.approval === 'boolean' ? d.approval : undefined, refine: typeof d.refine === 'boolean' ? d.refine : undefined, playbookId: d.playbookId });
    return { jobId };
  });
  command('job.cancel', (d) => { hive.cancelJob(d.jobId); return {}; });
  command('chat.send', (d) => ({ id: hive.userChat(d.channel, d.text) }));
  command('approval.resolve', (d) => {
    need(typeof d.approvalId === 'string', 'approvalId is required');
    if (!approvals.resolve(d.approvalId, !!d.approved, d.note, 'user')) throw new CommandError('not_found', 'no pending approval with that id');
    return {};
  });
  command('crew.hire', (d) => ({ worker: hive.hire(d) }));
  command('crew.update', (d) => ({ worker: hive.updateWorker(d.workerId, d) }));
  command('crew.fire', (d) => { hive.fire(d.workerId); return {}; });
  command('task.retry', (d) => hive.retryTask(d.taskId));
  command('brief.approve', (d) => hive.approveBrief(d.jobId, { use: d.use, text: d.text }));
  command('playbook.save', (d) => hive.savePlaybook(d.jobId));
  command('task.reassign', (d) => hive.reassignTask(d.taskId, d.workerId));
  command('task.cancel', (d) => hive.cancelTask(d.taskId));
  command('settings.set', (d) => ({ settings: hive.setSettings(d) }));
  command('brain.probe', async () => {
    if (!opts.brains) return { hardware: null, options: [], recommended: null };
    return opts.brains.probe();
  });
  command('brain.select', (d) => {
    if (!opts.brains) throw new CommandError('conflict', 'the brain cannot be changed in this mode');
    return { status: opts.brains.select(d) };
  });
  command('brain.download', (d) => {
    if (!opts.brains) throw new CommandError('conflict', 'downloads are off in this mode');
    opts.brains.download(d.model);
    return {};
  });
  command('brain.attach', (d, client) => {
    if (!client) throw new CommandError('bad_request', 'brain.attach needs a WebSocket');
    const id = `b_remote_${++clientSeq}`;
    const brain = createRelayBrain({
      id,
      label: String(d.label || 'Friend').slice(0, 60),
      model: typeof d.model === 'string' ? d.model.slice(0, 120) : undefined,
      send: (frame) => { if (!client.conn.sendJson(frame)) throw new Error('the remote brain disconnected'); }
    });
    client.brains.set(id, brain);
    scheduler.addBrain(brain);
    return { brainId: id };
  });
  command('brain.respond', (d, client) => {
    for (const b of client?.brains.values() || []) if (b.respond(d.requestId, !!d.ok, d.result, d.error)) return {};
    throw new CommandError('not_found', 'no pending request with that id');
  });
  command('brain.token', (d, client) => {
    for (const b of client?.brains.values() || []) b.token(d.requestId, d.text);
    return undefined;
  });
  command('brain.detach', (d, client) => {
    if (!client?.brains.has(d.brainId)) throw new CommandError('not_found', 'no such brain on this connection');
    client.brains.delete(d.brainId);
    scheduler.removeBrain(d.brainId, 'detached');
    return {};
  });
  command('brain.chat', async (d, client) => {
    if (!opts.lend) throw new CommandError('not_lending', 'start hivedesk with --lend to serve model requests');
    need(Array.isArray(d.messages) && d.messages.length, 'messages are required');
    const messages = d.messages.filter((m) => m && ['system', 'user', 'assistant'].includes(m.role) && typeof m.content === 'string').map((m) => ({ role: m.role, content: m.content.slice(0, 200_000) }));
    const o = d.options || {};
    const options = {};
    if (o.schema && typeof o.schema === 'object') options.schema = o.schema;
    if (Number.isFinite(o.maxTokens)) options.maxTokens = Math.min(Math.max(1, o.maxTokens), 8192);
    if (Number.isFinite(o.temperature)) options.temperature = Math.min(Math.max(0, o.temperature), 2);
    const requestId = typeof d.requestId === 'string' ? d.requestId.slice(0, 64) : `lend_${Date.now().toString(36)}`;
    const promptChars = messages.reduce((n, m) => n + m.content.length, 0);
    const started = Date.now();
    const result = await scheduler.turn({ workerId: `lend:${client ? client.id : 'rest'}`, messages, options });
    bus.emit('brain.served', { requestId, promptChars, completionTokens: result.completionTokens, ms: Date.now() - started });
    return result;
  });
  command('events.since', (d) => {
    const events = bus.since(Number(d.seq) || 0, Math.min(Number(d.limit) || 1000, 5000));
    return { events, lastSeq: bus.seq };
  });
  command('replay.at', (d) => ({ state: bus.stateAt(Number(d.seq) || 0) }));
  command('replay.marks', () => ({ marks: marks(bus.events), lastSeq: bus.seq }));
  command('files.list', () => ({ files: toolbox.ws.list() }));
  command('files.read', (d) => {
    try { return { path: d.path, content: toolbox.ws.read(d.path) }; } catch (e) { throw new CommandError(e.code === 'not_found' ? 'not_found' : 'bad_request', e.message); }
  });
  command('playbook.list', () => ({ playbooks: playbooks.list() }));
  command('playbook.delete', (d) => {
    if (!playbooks.delete(d.playbookId)) throw new CommandError('not_found', 'no such playbook');
    bus.emit('playbook.deleted', { playbookId: d.playbookId });
    return {};
  });
  command('doctor', async () => (opts.doctor ? opts.doctor() : { ok: true, checks: [] }));

  // ---- REST ----
  function route(method, p, handler) {
    routes.push({ method, path: p, handler });
  }

  async function handleApi(req, res, url) {
    const p = url.pathname;
    const custom = routes.find((r) => r.method === req.method && r.path === p);
    if (custom) return custom.handler(req, res, url);
    if (req.method === 'GET') {
      switch (p) {
        case '/api/health': return send(res, 200, { ok: true, ...meta() });
        case '/api/state': return send(res, 200, bus.state);
        case '/api/events': {
          const since = Number(url.searchParams.get('since')) || 0;
          const limit = Math.min(Number(url.searchParams.get('limit')) || 500, 5000);
          return send(res, 200, { events: bus.since(since, limit), lastSeq: bus.seq });
        }
        case '/api/replay': return send(res, 200, bus.stateAt(Number(url.searchParams.get('seq')) || 0));
        case '/api/files': return send(res, 200, { files: toolbox.ws.list() });
        case '/api/file': {
          try {
            return send(res, 200, { path: url.searchParams.get('path'), content: toolbox.ws.read(url.searchParams.get('path') || '') });
          } catch (e) {
            return sendError(res, e.code === 'not_found' ? 404 : 400, e.code === 'not_found' ? 'not_found' : 'bad_request', e.message);
          }
        }
        case '/api/playbooks': return send(res, 200, { playbooks: playbooks.list() });
        case '/api/doctor': return send(res, 200, opts.doctor ? await opts.doctor() : { ok: true, checks: [] });
        default: return sendError(res, 404, 'not_found', `no route ${p}`);
      }
    }
    if (req.method === 'POST' && p === '/api/command') {
      let body;
      try { body = JSON.parse(await readBody(req) || '{}'); } catch { return sendError(res, 400, 'bad_request', 'invalid JSON'); }
      try {
        const result = await runCommand(String(body.type || ''), body.data, null);
        return send(res, 200, { ok: true, result: result === undefined ? {} : result });
      } catch (err) {
        return send(res, statusFor(err), { ok: false, error: { code: err.code && typeof err.code === 'string' ? mapCode(err.code) : 'internal', message: String(err.message || err) } });
      }
    }
    return sendError(res, 405, 'bad_request', 'method not allowed');
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
      if (!allowedHost(req)) return sendError(res, 403, 'forbidden', 'bad Host header');
      // The preview is read only and sandboxed (an opaque origin), so it works inside the iframe without the cookie.
      if (url.pathname === '/preview' || url.pathname.startsWith('/preview/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(res, 405, 'bad_request', 'method not allowed');
        if (url.pathname === '/preview') return send(res, 302, '', { location: '/preview/' });
        const rel = url.pathname.slice('/preview/'.length);
        let abs;
        try { abs = rel ? toolbox.ws.resolve(decodeURIComponent(rel)) : toolbox.ws.root; } catch { return sendError(res, 403, 'forbidden', 'path not allowed'); }
        const csp = { 'content-security-policy': "sandbox allow-scripts allow-forms allow-popups allow-modals; connect-src 'none'" };
        if (serveFile(res, abs, csp)) return;
        return send(res, 404, '<!doctype html><title>Nothing here yet</title><p style="font-family:system-ui">Nothing here yet. The crew has not written this file.</p>', { 'content-type': 'text/html; charset=utf-8', ...csp });
      }
      const how = authed(req, url);
      if (!how) return sendError(res, 401, 'unauthorized', 'missing or wrong token; open the URL printed by hivedesk');
      const cookie = how === 'query' ? { 'set-cookie': `hivedesk_token=${token}; HttpOnly; SameSite=Strict; Path=/` } : {};
      if (url.pathname.startsWith('/api/')) {
        for (const [k, v] of Object.entries(cookie)) res.setHeader(k, v);
        return await handleApi(req, res, url);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(res, 405, 'bad_request', 'method not allowed');
      if (url.pathname === '/lib/reduce.js') return serveFile(res, path.join(HERE, 'replay', 'reduce.js'), cookie) || sendError(res, 404, 'not_found', 'missing');
      if (url.pathname.startsWith('/assets/')) {
        const abs = safeJoin(assetsDir, url.pathname.slice('/assets/'.length));
        if (abs && serveFile(res, abs, cookie)) return;
        return sendError(res, 404, 'not_found', 'no such asset');
      }
      const abs = safeJoin(uiDir, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
      if (abs && serveFile(res, abs, cookie)) return;
      if (url.pathname === '/' || url.pathname === '/index.html') return send(res, 200, fallbackPage(), { 'content-type': 'text/html; charset=utf-8', ...cookie });
      return sendError(res, 404, 'not_found', 'no such file');
    } catch (err) {
      if (!res.headersSent) sendError(res, 500, 'internal', String(err?.message || err));
      else res.end();
    }
  });

  // ---- WebSocket ----
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    if (url.pathname !== '/ws') return rejectUpgrade(socket, 403, 'unknown path');
    if (!allowedHost(req)) return rejectUpgrade(socket, 403, 'bad Host header');
    const origin = req.headers.origin;
    if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}` && origin !== `http://[::1]:${port}`) {
      return rejectUpgrade(socket, 403, 'bad Origin');
    }
    if (!authed(req, url)) return rejectUpgrade(socket, 401, 'missing or wrong token');
    const conn = acceptUpgrade(req, socket, head);
    if (!conn) return;
    const client = { id: `c${++clientSeq}`, conn, brains: new Map() };
    clients.add(client);
    conn.sendJson({ kind: 'hello', ...meta(), lastSeq: bus.seq, state: bus.state });
    conn.on('message', async (text) => {
      let msg;
      try { msg = JSON.parse(text); } catch { return conn.sendJson({ kind: 'reply', id: null, ok: false, error: { code: 'bad_request', message: 'invalid JSON' } }); }
      if (!msg || msg.kind !== 'command') return conn.sendJson({ kind: 'reply', id: msg?.id ?? null, ok: false, error: { code: 'bad_request', message: 'expected { kind: "command" }' } });
      try {
        const result = await runCommand(String(msg.type || ''), msg.data, client);
        if (msg.type === 'brain.token') return;
        conn.sendJson({ kind: 'reply', id: msg.id ?? null, ok: true, result: result === undefined ? {} : result });
      } catch (err) {
        conn.sendJson({ kind: 'reply', id: msg.id ?? null, ok: false, error: { code: err.code && typeof err.code === 'string' ? mapCode(err.code) : 'internal', message: String(err.message || err) } });
      }
    });
    conn.on('close', () => {
      clients.delete(client);
      for (const id of client.brains.keys()) scheduler.removeBrain(id, 'disconnected');
      client.brains.clear();
    });
    conn.on('error', () => {});
    opts.onClient?.(client);
  });

  const offEvent = bus.on((event) => {
    const frame = JSON.stringify({ kind: 'event', event });
    for (const c of clients) c.conn.send(frame);
  });
  const offLive = bus.onLive((type, data) => {
    const frame = JSON.stringify({ kind: 'live', type, data });
    for (const c of clients) c.conn.send(frame);
  });
  const pinger = setInterval(() => { for (const c of clients) c.conn.ping(); }, 20_000);
  pinger.unref?.();

  return {
    token,
    route,
    command,
    runCommand,
    clients,
    get port() { return port; },
    get url() { return `http://127.0.0.1:${port}/?t=${token}`; },
    previewUrl: () => (port ? `http://127.0.0.1:${port}/preview/` : null),
    listen(p = opts.port || 0) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(p, host, () => {
          server.off('error', reject);
          port = server.address().port;
          resolve(port);
        });
      });
    },
    async close() {
      clearInterval(pinger);
      offEvent();
      offLive();
      for (const c of clients) c.conn.close(1001, 'server stopping');
      const closed = new Promise((resolve) => server.close(() => resolve()));
      server.closeAllConnections?.();
      for (const c of clients) c.conn.socket.destroy();
      await closed;
    },
    http: server
  };
}

// Known codes from PROTOCOL.md plus any short snake_case code a plug-in throws (rate_limited, stopped, ...).
function mapCode(code) {
  if (code === 'path_denied' || code === 'invalid_json') return 'bad_request';
  return typeof code === 'string' && /^[a-z][a-z_]{1,40}$/.test(code) ? code : 'internal';
}

function statusFor(err) {
  switch (mapCode(err.code)) {
    case 'bad_request': return 400;
    case 'not_found': return 404;
    case 'conflict': return 409;
    case 'not_lending': return 409;
    case 'busy': return 429;
    case 'unauthorized': return 401;
    case 'internal': return 500;
    case 'rate_limited': return 429;
    default: return 400;
  }
}
