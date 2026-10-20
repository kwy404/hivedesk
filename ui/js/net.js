// WebSocket client for the hivedesk engine (PROTOCOL.md sections 1, 2 and 4).

import { t as tr } from './i18n.js';

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
  if (remote && s !== 'open') return; // the local socket's state does not matter while the host's session is shown
  Object.assign(connection, { state: s }, extra);
  emit('connection', { ...connection });
}

export function connect() {
  clearTimeout(retryTimer);
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${proto}//${location.host}/ws${token ? `?t=${encodeURIComponent(token)}` : ''}`;
  setState(connection.attempts ? 'reconnecting' : 'connecting');
  try { ws = new WebSocket(url); } catch (err) { scheduleRetry(); return; }
  // A socket that neither opens nor fails (a port that swallows the handshake) is closed after a while,
  // so the close handler retries instead of waiting on it forever.
  const sock = ws;
  const openTimer = setTimeout(() => { if (sock.readyState === 0) { try { sock.close(); } catch {} } }, 10000);
  ws.addEventListener('open', () => {
    clearTimeout(openTimer);
    retry = 0;
    connection.attempts = 0;
    setState('open');
    while (outbox.length) ws.send(outbox.shift());
  });
  ws.addEventListener('message', (e) => {
    if (remote) return; // Code together: this desktop shows the host's session (useRemote below)
    let frame;
    try { frame = JSON.parse(e.data); } catch { return; }
    if (!frame || typeof frame !== 'object') return;
    if (frame.kind === 'reply') {
      const p = pending.get(frame.id);
      if (p) {
        pending.delete(frame.id);
        clearTimeout(p.timer);
        if (frame.ok) p.resolve(frame.result ?? {});
        else p.reject(Object.assign(new Error(frame.error?.message || tr('net.commandFailed')), { code: frame.error?.code || 'internal' }));
      }
    }
    emit('frame', frame);
    emit(frame.kind, frame);
  });
  ws.addEventListener('close', () => {
    clearTimeout(openTimer);
    ws = null;
    for (const [id, p] of pending) {
      if (p.sentWhileOpen) { clearTimeout(p.timer); p.reject(Object.assign(new Error(tr('net.lostBeforeAnswer')), { code: 'offline' })); pending.delete(id); }
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
  if (remote) { remote.send(frame); return; }
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
      reject(Object.assign(new Error(tr('net.timeout')), { code: 'timeout' }));
    }, timeout);
    const open = ws && ws.readyState === 1;
    pending.set(id, { resolve, reject, timer, sentWhileOpen: open });
    sendRaw({ kind: 'command', id, type, data });
  });
}

export function isOpen() { return !!remote || (!!ws && ws.readyState === 1); }

/* ---------- Code together hook (ui/lend/collab/client.js) ----------
   A guest's desktop renders the host's session as if it were local: while a remote transport is
   set, frames come from it (transport.onFrame) and commands go to it (transport.send) instead of
   this PC's engine. useRemote(null) returns to the local engine. */
let remote = null;

function dispatch(frame) {
  if (!frame || typeof frame !== 'object') return;
  if (frame.kind === 'reply') {
    const p = pending.get(frame.id);
    if (p) {
      pending.delete(frame.id);
      clearTimeout(p.timer);
      if (frame.ok) p.resolve(frame.result ?? {});
      else p.reject(Object.assign(new Error(frame.error?.message || tr('net.commandFailed')), { code: frame.error?.code || 'internal' }));
    }
  }
  emit('frame', frame);
  emit(frame.kind, frame);
}

export function useRemote(transport) {
  for (const [id, p] of pending) { clearTimeout(p.timer); p.reject(Object.assign(new Error(tr('net.lostBeforeAnswer')), { code: 'offline' })); pending.delete(id); }
  remote = transport || null;
  if (remote) {
    remote.onFrame = (frame) => { if (remote === transport) dispatch(frame); };
    setState('open');
    return;
  }
  // Back to this PC's engine: a fresh socket brings a fresh hello.
  if (ws) { try { ws.close(); } catch {} } else connect();
}

export const isRemote = () => !!remote;
