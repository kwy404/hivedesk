// Two engines' p2p ports in one process, for the remote desktop tests (the "inproc" transport of
// docs/1.0/PLAN.md section 3.4). It implements the port of src/remote/port.js the way src/p2p/ will:
// grants issued by a person, checked with expiry, revocable, a hash chained audit log per engine.
// Messages are JSON round tripped and delivered on a microtask, like a real transport.

import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

export function createInprocPair({ now = () => Date.now(), names = ['Hana', 'Rita'], checkExpiry = true } = {}) {
  let sessionSeq = 0;
  const hold = { paused: false, queue: [], drop: null };

  function engine(peerId, name, publicKey) {
    const e = {
      peerId, name, publicKey, trust: 'known',
      handlers: [], sessionFns: [], requestFns: [], changeFns: [],
      grants: new Map(), held: new Map(), audit: [], sent: [],
      sessions: new Map(), other: null
    };
    const deliver = (sessionId, stream, type, body) => {
      const s = e.sessions.get(sessionId);
      if (!s || s.state !== 'open') return false;
      const target = e.other;
      const ts = target.sessions.get(sessionId);
      if (!ts || ts.state !== 'open') return false;
      const msg = { t: type, ts: now(), body: JSON.parse(JSON.stringify(body)) };
      e.sent.push({ sessionId, stream, ...msg });
      const run = () => {
        if (hold.drop?.(type, msg.body, stream)) return;
        if (ts.state !== 'open') return;
        for (const h of target.handlers) if (type.startsWith(h.prefix)) h.fn(ts, msg);
      };
      if (hold.paused && stream === 2) hold.queue.push(run);
      else queueMicrotask(run);
      return true;
    };
    e.port = {
      localPeerId: peerId,
      get localPublicKey() { return e.publicKey; },
      knownPeers: () => [{ peerId: e.other.peerId, publicKey: e.other.publicKey, name: e.other.name }],
      session: (id) => e.sessions.get(id) || null,
      peer: (id) => (id === e.other.peerId ? { peerId: id, name: e.other.name, publicKey: e.other.publicKey, trust: e.trust, words: ['apple', 'river', 'stone', 'cloud', 'maple', 'tiger'] } : null),
      send: deliver,
      onMessage: (prefix, fn) => { const h = { prefix, fn }; e.handlers.push(h); return () => { e.handlers = e.handlers.filter((x) => x !== h); }; },
      onSession: (fn) => { e.sessionFns.push(fn); return () => { e.sessionFns = e.sessionFns.filter((x) => x !== fn); }; },
      caps: {
        grant(toPeer, capability, o) {
          const g = {
            id: `gr_${crypto.randomBytes(6).toString('hex')}`, peerId: toPeer, capability: { name: capability.name, limits: capability.limits },
            grantedBy: 'user', grantedAt: new Date(now()).toISOString(), expiresAt: o.expiresAt, scope: o.scope, sessionId: o.sessionId
          };
          e.grants.set(g.id, g);
          for (const fn of e.changeFns) fn({ kind: 'granted', grant: g, here: true });
          // The remote learns what it holds (cap.grant on the wire).
          queueMicrotask(() => { e.other.held.set(g.id, g); for (const fn of e.other.changeFns) fn({ kind: 'granted', grant: g, here: false }); });
          return g;
        },
        revoke(id, reason) {
          const g = e.grants.get(id);
          if (!g || g.revokedAt) return;
          g.revokedAt = new Date(now()).toISOString();
          g.revokeReason = reason;
          for (const fn of e.changeFns) fn({ kind: 'revoked', grant: g, here: true });
          queueMicrotask(() => { e.other.held.delete(id); for (const fn of e.other.changeFns) fn({ kind: 'revoked', grant: g, here: false }); });
        },
        find(toPeer, capName) {
          for (const g of e.grants.values()) {
            if (g.peerId !== toPeer || g.capability.name !== capName || g.revokedAt) continue;
            if (checkExpiry && g.expiresAt && Date.parse(g.expiresAt) <= now()) continue;
            return g;
          }
          return null;
        },
        held: (sessionId, capName) => [...e.held.values()].find((g) => g.sessionId === sessionId && g.capability.name === capName && !g.revokedAt) || null,
        request(sessionId, capability, reason) {
          const ts = e.other.sessions.get(sessionId);
          if (!ts) return;
          queueMicrotask(() => { for (const fn of e.other.requestFns) fn(ts, { capability: JSON.parse(JSON.stringify({ name: capability.name, limits: capability.limits })), reason }); });
        },
        onRequest: (fn) => { e.requestFns.push(fn); return () => { e.requestFns = e.requestFns.filter((x) => x !== fn); }; },
        onChange: (fn) => { e.changeFns.push(fn); return () => { e.changeFns = e.changeFns.filter((x) => x !== fn); }; }
      },
      audit: {
        append(entry) {
          const prevHash = e.audit.length ? e.audit[e.audit.length - 1].hash : '0'.repeat(64);
          const line = { seq: e.audit.length + 1, ts: new Date(now()).toISOString(), prevHash, entry };
          line.hash = crypto.createHash('sha256').update(prevHash + JSON.stringify(entry)).digest('hex');
          e.audit.push(line);
          return { hash: line.hash };
        }
      }
    };
    return e;
  }

  const key = (seed) => crypto.createHash('sha256').update(seed).digest().toString('base64url');
  const host = engine('hd1hanahost000000000000000000000000000000000000000', names[0], key('hana'));
  const viewer = engine('hd1ritaviewer00000000000000000000000000000000000000', names[1], key('rita'));
  host.other = viewer;
  viewer.other = host;

  function open() {
    const id = `ss_test${++sessionSeq}`;
    const hs = { id, peerId: viewer.peerId, role: 'host', state: 'open' };
    const vs = { id, peerId: host.peerId, role: 'guest', state: 'open' };
    host.sessions.set(id, hs);
    viewer.sessions.set(id, vs);
    for (const fn of host.sessionFns) fn('open', hs);
    for (const fn of viewer.sessionFns) fn('open', vs);
    return id;
  }

  function close(id) {
    for (const e of [host, viewer]) {
      const s = e.sessions.get(id);
      if (!s) continue;
      s.state = 'closed';
      e.sessions.delete(id);
      for (const fn of e.sessionFns) fn('close', s);
    }
  }

  // Rendezvous by address topic: only a listening engine answers a dial.
  const listening = new Map();
  for (const e of [host, viewer]) {
    e.port.listenAddress = (topic, on) => { if (on) listening.set(topic, e); else listening.delete(topic); };
    e.port.dialAddress = async (topic) => {
      const t = listening.get(topic);
      if (!t || t === e) throw Object.assign(new Error('nobody answers at that address'), { code: 'not_found' });
      return { sessionId: open() };
    };
  }

  return {
    host, viewer, open, close, hold, listening,
    resume() { hold.paused = false; const q = hold.queue.splice(0); for (const run of q) queueMicrotask(run); },
    auditKinds: (e) => e.audit.map((l) => l.entry.kind)
  };
}

/** Lets queued microtasks and a few promise turns run. */
export async function flush(n = 20) {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
}

/** A recording fake of the native helper (WinHelper and X11Helper share these methods and events). */

export class FakeHelper extends EventEmitter {
  constructor() {
    super();
    this.calls = [];
    this.closed = false;
  }
  move(px, py) { this.calls.push(['move', px, py]); return true; }
  button(b, down) { this.calls.push(['button', b, down]); return true; }
  wheel(dx, dy) { this.calls.push(['wheel', dx, dy]); return true; }
  key(entry, down) { this.calls.push(['key', entry.vk, !!entry.ext, down]); return true; }
  release() { this.calls.push(['release']); return true; }
  indicator(mode, text) { this.calls.push(['indicator', mode, text]); return true; }
  ping() { return true; }
  clipWatch(on) { this.calls.push(['clipWatch', on]); return true; }
  clipSet(item) { this.calls.push(['clipSet', item]); this.clipboard = item; return true; }
  close() { this.closed = true; this.calls.push(['close']); }
  ready(displays = [{ x: 0, y: 0, w: 1920, h: 1080, primary: true }], hotkey = true) { this.emit('ready', { t: 'ready', displays, hotkey }); }
  lock(locked) { this.emit('lock', { t: 'lock', locked, source: 'fake' }); }
}

/** A manual clock with timers, so expiry is tested without waiting. */
export function manualClock(start = Date.parse('2026-10-17T12:00:00Z')) {
  let t = start;
  let seq = 0;
  const timers = new Map();
  const clock = {
    now: () => t,
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { at: t + Math.max(0, ms), fn }); return { id, unref() {} }; },
    clearTimeout: (h) => { if (h) timers.delete(h.id); },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]);
        t = next[1].at;
        next[1].fn();
      }
      t = end;
    }
  };
  return clock;
}
