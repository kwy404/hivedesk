// WebSocket client for the hivedesk engine (PROTOCOL.md sections 1, 2 and 4).

const listeners = new Map();
let ws = null;
let seq = 0;
let retry = 0;
let retryTimer = null;
const pending = new Map();
const outbox = [];

function readToken() {
  const url = new URL(location.href);
  const t = url.searchParams.get('t');
  if (t) {
    try { sessionStorage.setItem('hivedesk.token', t); } catch {}
    // The server set an HttpOnly cookie on this request, so the token can leave the address bar.
    url.searchParams.delete('t');
    history.replaceState(null, '', url.pathname + url.search + url.hash);
    return t;
  }
  try { return sessionStorage.getItem('hivedesk.token') || ''; } catch { return ''; }
}

export const token = readToken();

/** Adds the token to a same-origin URL (the cookie covers most requests, this covers the rest). */
export function withToken(path) {
  if (!token) return path;
  const u = new URL(path, location.origin);
  u.searchParams.set('t', token);
  return u.pathname + u.search;
}

export function on(kind, fn) {
  if (!listeners.has(kind)) listeners.set(kind, new Set());
  listeners.get(kind).add(fn);
  return () => listeners.get(kind).delete(fn);
}

function emit(kind, payload) {
  for (const fn of listeners.get(kind) || []) {
    try { fn(payload); } catch (err) { console.error(err); }
  }
}

export const connection = { state: 'connecting', attempts: 0, nextRetryAt: 0 };

function setState(s, extra = {}) {
  Object.assign(connection, { state: s }, extra);
  emit('connection', { ...connection });
}

export function connect() {
  clearTimeout(retryTimer);
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${proto}//${location.host}/ws${token ? `?t=${encodeURIComponent(token)}` : ''}`;
  setState(connection.attempts ? 'reconnecting' : 'connecting');
  try { ws = new WebSocket(url); } catch (err) { scheduleRetry(); return; }
  ws.addEventListener('open', () => {
    retry = 0;
    connection.attempts = 0;
    setState('open');
    while (outbox.length) ws.send(outbox.shift());
  });
  ws.addEventListener('message', (e) => {
    let frame;
    try { frame = JSON.parse(e.data); } catch { return; }
    if (!frame || typeof frame !== 'object') return;
    if (frame.kind === 'reply') {
      const p = pending.get(frame.id);
      if (p) {
        pending.delete(frame.id);
        clearTimeout(p.timer);
        if (frame.ok) p.resolve(frame.result ?? {});
        else p.reject(Object.assign(new Error(frame.error?.message || 'Command failed'), { code: frame.error?.code || 'internal' }));
      }
    }
    emit('frame', frame);
    emit(frame.kind, frame);
  });
  ws.addEventListener('close', () => {
    ws = null;
    for (const [id, p] of pending) {
      if (p.sentWhileOpen) { clearTimeout(p.timer); p.reject(Object.assign(new Error('Lost the connection before the engine answered.'), { code: 'offline' })); pending.delete(id); }
    }
    checkAuthThenRetry();
  });
}

async function checkAuthThenRetry() {
  try {
    const r = await fetch('/api/health', { headers: token ? { Authorization: `Bearer ${token}` } : {}, cache: 'no-store' });
    if (r.status === 401) { setState('unauthorized'); return; }
  } catch {}
  scheduleRetry();
}

function scheduleRetry() {
  retry = Math.min(retry + 1, 6);
  const delay = Math.min(10000, 500 * 2 ** (retry - 1));
  connection.attempts++;
  setState('offline', { nextRetryAt: Date.now() + delay });
  retryTimer = setTimeout(connect, delay);
}

export function retryNow() { clearTimeout(retryTimer); connect(); }

/** Sends a raw frame (used by the lend window for brain.token, which has no reply). */
export function sendRaw(frame) {
  const s = JSON.stringify(frame);
  if (ws && ws.readyState === 1) ws.send(s);
  else outbox.push(s);
}

/**
 * Sends a command and resolves with its result. Rejects with err.code from the engine.
 * @param {string} type
 * @param {object} [data]
 * @param {{ timeout?: number }} [opts]
 */
export function command(type, data = {}, { timeout = 30000 } = {}) {
  const id = `c${++seq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Object.assign(new Error('The engine did not answer in time.'), { code: 'timeout' }));
    }, timeout);
    const open = ws && ws.readyState === 1;
    pending.set(id, { resolve, reject, timer, sentWhileOpen: open });
    sendRaw({ kind: 'command', id, type, data });
  });
}

export function isOpen() { return !!ws && ws.readyState === 1; }
