// The p2p port of the remote desktop module (src/remote/port.js) over this engine's P2PNode.
// src/remote/ never sees keys, transports or the peer store; it asks this port. Every message it
// sends travels inside the encrypted session; every grant is made by the node (only a person
// grants: the remote desktop calls caps.grant right after the host's click) and audited there.
//
// Message types of docs/1.0/protocol/remote.md section 2 are registered here with their stream,
// size cap and rate. The session carries frames up to about 1.2 MB, so a clipboard text or image
// above that is cut into remote.part messages on stream 2 and joined again on the other side
// before any handler sees it (at most 16 MB, two at a time per session, 60 s to arrive).
//
// Dial by address (src/remote/address.js): listenAddress() lets incoming handshakes on this
// machine's address in (rate limited in the node), dialAddress() meets the other machine over
// the LAN when the caller names a LAN address, or through this engine's window on the public
// relays (browser-pipe: the window gets the meeting point as the live frame p2p.dial.pipe).

import crypto from 'node:crypto';
import { registerMessage, messageTypes, checkedJson, STREAM } from './messages.js';
import { normalizeCapability } from './caps.js';
import { connectLan } from './transport/ws-lan.js';

const KB = 1024;
const MB = 1024 * KB;
const PART_CHARS = 900 * KB;            // the data of one remote.part (base64url text)
const DIRECT_MAX = 1100 * KB;           // larger bodies go in parts
const JOIN_MAX = { 'clip.text': 3.5 * MB, 'clip.image': 12 * MB };
const JOIN_TTL_MS = 60_000;
const JOINS_PER_SESSION = 2;
const DIAL_WAIT_MS = 60_000;

/** checkedJson with a larger bound for strings: clipboard text, images and file chunks are long; refused when over, never cut. */
const long = (maxString) => (b) => checkedJson(b, { string: maxString, items: 2000 });

// ---- the message table entries of the remote desktop (remote.*, clip.*, file.*) ----
const control = (type, max, rate) => registerMessage(type, { stream: STREAM.CONTROL, max, ...(rate ? { rate } : {}) });
control('remote.ready', 32 * KB);
control('remote.refused', 2 * KB);
control('remote.unattended', 2 * KB, [5, 60_000]);
control('remote.input', 64 * KB, [60, 1000]);
control('remote.state', 32 * KB, [20, 1000]);
control('remote.screen', 4 * KB, [10, 1000]);
control('remote.quality', 2 * KB, [10, 1000]);
control('remote.chat', 16 * KB, [10, 1000]);
control('remote.stop', 2 * KB);
registerMessage('clip.files', { stream: STREAM.CONTROL, max: 1 * MB, rate: [10, 10_000], normalize: long(4 * KB) });
control('clip.files.get', 2 * KB, [10, 10_000]);
control('file.offer', 16 * KB, [20, 10_000]);
for (const t of ['file.answer', 'file.ack', 'file.pause', 'file.done', 'file.cancel']) control(t, 4 * KB, [400, 1000]);
registerMessage('remote.ice', { stream: STREAM.MEDIA, max: 8 * KB, rate: [300, 10_000] });
registerMessage('clip.text', { stream: STREAM.COMPUTE, max: 1200 * KB, rate: [20, 10_000], normalize: long(1200 * KB) });
registerMessage('clip.image', { stream: STREAM.COMPUTE, max: 1200 * KB, rate: [20, 10_000], normalize: long(1200 * KB) });
registerMessage('file.chunk', { stream: STREAM.COMPUTE, max: 96 * KB, rate: [400, 1000], normalize: long(96 * KB) });
registerMessage('remote.part', { stream: STREAM.COMPUTE, max: 1000 * KB, rate: [64, 1000], normalize: long(PART_CHARS) });
registerMessage('remote.sdp', { stream: STREAM.MEDIA, max: 40 * KB, rate: [30, 10_000], normalize: long(36 * KB) });

const PREFIXES = ['remote.', 'clip.', 'file.'];
const typesOf = (prefix) => messageTypes().filter((t) => t.startsWith(prefix) && t !== 'remote.part');

/**
 * @param {import('./node.js').P2PNode} node a started node
 * @param {{ live?: (type: string, data: object) => void, pipes?: any }} [opts]
 *   live: this engine's live frames (for the window half of browser-pipe dials)
 */
export function createRemotePort(node, opts = {}) {
  const handlers = new Map(); // prefix -> Set(fn)
  const sessionFns = new Set();
  const requestFns = new Set();
  const changeFns = new Set();
  const offs = [];
  const joins = new Map(); // sessionId -> Map(id -> { t, n, got, size, at })
  const dials = new Map(); // dialId -> { resolve, reject, timer }

  const rec = (sessionId) => {
    const r = node.sessions.get(sessionId);
    return r && r.session.state === 'open' && r.accepted ? r : null;
  };
  const view = (r) => ({ id: r.session.id, peerId: r.peerId, role: r.session.role === 'host' ? 'host' : 'guest', state: r.session.state === 'open' ? 'open' : 'closed', ...(r.sas ? { sas: r.sas } : {}), via: r.via });
  const deliver = (r, msg) => {
    const s = view(r);
    for (const [prefix, set] of handlers) {
      if (!msg.t.startsWith(prefix)) continue;
      for (const fn of [...set]) {
        try { fn(s, msg); } catch { /* one handler never breaks another */ }
      }
    }
  };
  const on = (ev, fn) => {
    node.on(ev, fn);
    offs.push(() => node.off(ev, fn));
  };

  // Every remote, clipboard and file type goes to the prefix handlers, in order per session.
  for (const prefix of PREFIXES) {
    for (const type of typesOf(prefix)) {
      offs.push(node.handle(type, (msg, ctx) => {
        const r = node.sessions.get(ctx.sessionId);
        if (r) deliver(r, { t: msg.t, ts: msg.ts, body: msg.body });
      }));
    }
  }
  // Parts of a large clipboard item.
  offs.push(node.handle('remote.part', (msg, ctx) => {
    const b = msg.body || {};
    const r = node.sessions.get(ctx.sessionId);
    if (!r || typeof b.id !== 'string' || !/^[a-f0-9]{16}$/.test(b.id) || !JOIN_MAX[b.t]) return;
    const n = Number(b.n);
    const i = Number(b.i);
    if (!Number.isInteger(n) || n < 2 || n > Math.ceil((JOIN_MAX[b.t] * 1.4) / PART_CHARS) + 1 || !Number.isInteger(i) || i < 0 || i >= n || typeof b.data !== 'string') return;
    let mine = joins.get(ctx.sessionId);
    if (!mine) joins.set(ctx.sessionId, (mine = new Map()));
    const now = Date.now();
    for (const [id, j] of mine) if (now - j.at > JOIN_TTL_MS) mine.delete(id);
    let j = mine.get(b.id);
    if (!j) {
      if (mine.size >= JOINS_PER_SESSION) return;
      j = { t: b.t, n, got: new Array(n), count: 0, size: 0, at: now };
      mine.set(b.id, j);
    }
    if (j.t !== b.t || j.n !== n || j.got[i] !== undefined) return;
    j.size += b.data.length;
    if (j.size > JOIN_MAX[b.t] * 1.4) { mine.delete(b.id); return; }
    j.got[i] = b.data;
    if (++j.count < n) return;
    mine.delete(b.id);
    let body;
    try {
      body = JSON.parse(Buffer.from(j.got.join(''), 'base64url').toString('utf8'));
    } catch { return; }
    if (!body || typeof body !== 'object') return;
    deliver(r, { t: j.t, ts: msg.ts, body });
  }));

  on('peer.online', (e) => {
    const r = node.sessions.get(e.sessionId);
    if (!r) return;
    for (const fn of [...sessionFns]) { try { fn('open', view(r)); } catch { /* ignore */ } }
  });
  on('peer.offline', (e) => {
    joins.delete(e.sessionId);
    const s = { id: e.sessionId, peerId: e.peerId, role: 'guest', state: 'closed' };
    for (const fn of [...sessionFns]) { try { fn('close', s); } catch { /* ignore */ } }
  });
  on('cap.request', (req) => {
    const r = node.sessionOf(req.peerId);
    if (!r) return;
    for (const fn of [...requestFns]) { try { fn(view(r), { capability: req.capability, reason: req.reason }); } catch { /* ignore */ } }
  });
  const change = (c) => { for (const fn of [...changeFns]) { try { fn(c); } catch { /* ignore */ } } };
  on('grant.created', (g) => change({ kind: 'granted', grant: g, here: true }));
  on('grant.revoked', ({ grant }) => change({ kind: 'revoked', grant, here: true }));
  on('held.granted', ({ grant }) => change({ kind: 'granted', grant, here: false }));
  on('held.revoked', (e) => change({ kind: 'revoked', grant: { id: e.grantId, peerId: e.peerId, capability: { name: e.capability } }, here: false }));

  function send(sessionId, stream, type, body) {
    const r = rec(sessionId);
    if (!r) return false;
    try {
      if (JOIN_MAX[type]) {
        const text = JSON.stringify(body ?? {});
        if (text.length > DIRECT_MAX) {
          if (text.length > JOIN_MAX[type]) return false;
          const data = Buffer.from(text, 'utf8').toString('base64url');
          const id = crypto.randomBytes(8).toString('hex');
          const n = Math.ceil(data.length / PART_CHARS);
          for (let i = 0; i < n; i++) r.session.send('remote.part', { id, t: type, i, n, data: data.slice(i * PART_CHARS, (i + 1) * PART_CHARS) });
          return true;
        }
      }
      r.session.send(type, body ?? {});
      return true;
    } catch {
      return false;
    }
  }

  /** The window brings a data channel for a dial by address (p2p.pipe.open { dialId }). */
  function pipeArrived(dialId, conn) {
    const d = dials.get(dialId);
    if (!d) return false;
    dials.delete(dialId);
    clearTimeout(d.timer);
    d.resolve(conn);
    return true;
  }

  async function dialAddress(_topic, o = {}) {
    const address = String(o.address || '');
    let conn;
    if (typeof o.lan === 'string' && o.lan) {
      conn = await connectLan(o.lan);
    } else {
      if (!opts.live) throw Object.assign(new Error('no window to meet the other machine on the relays; open hivedesk or give a LAN address'), { code: 'conflict' });
      const dialId = 'dl_' + crypto.randomBytes(8).toString('hex');
      const rv = node.addressRendezvous(address);
      conn = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { dials.delete(dialId); reject(Object.assign(new Error('nobody answered at that address'), { code: 'not_found' })); }, o.waitMs || DIAL_WAIT_MS);
        timer.unref?.();
        dials.set(dialId, { resolve, reject, timer });
        opts.live('p2p.dial.pipe', { dialId, rendezvous: rv });
      });
    }
    const r = await node.dialAddress(address, conn);
    return { sessionId: r.sessionId, host: r.host, sas: r.sas };
  }

  return {
    get localPeerId() { return node.identity.peerId; },
    get localPublicKey() { return node.identity.publicKey; },
    knownPeers: () => node.listPeers().filter((p) => p.trust === 'known').map((p) => ({ peerId: p.identity.peerId, publicKey: p.identity.publicKey, name: p.identity.name })),
    session: (id) => { const r = rec(id); return r ? view(r) : null; },
    peer(peerId) {
      const p = node.peers.get(peerId);
      if (!p) return null;
      const r = node.sessionOf(peerId);
      return { peerId, name: p.identity.name, words: p.identity.fingerprint?.words || [], short: p.identity.fingerprint?.short, publicKey: p.identity.publicKey, trust: p.trust, ...(r?.sas ? { sas: r.sas } : {}) };
    },
    send,
    onMessage(prefix, fn) {
      if (!handlers.has(prefix)) handlers.set(prefix, new Set());
      handlers.get(prefix).add(fn);
      return () => handlers.get(prefix)?.delete(fn);
    },
    onSession(fn) { sessionFns.add(fn); return () => sessionFns.delete(fn); },
    caps: {
      grant(peerId, capability, o = {}) {
        const exp = Date.parse(o.expiresAt || '');
        const minutes = Number.isFinite(exp) ? Math.max(1, Math.round((exp - Date.now()) / 60_000)) : undefined;
        const cap = normalizeCapability(capability);
        // remote.view and remote.control last 5, 15 or 60 minutes (src/p2p/caps.js choices).
        const m = minutes !== undefined && cap.name.startsWith('remote.') ? [5, 15, 60].reduce((a, b) => (Math.abs(b - minutes) < Math.abs(a - minutes) ? b : a)) : minutes;
        return node.grant(peerId, cap, { minutes: m, scope: 'session' });
      },
      revoke(grantId, reason) { try { node.revoke(grantId, reason); } catch { /* already gone */ } },
      find(peerId, name) {
        const g = node.can(peerId, name);
        return g && (!g.expiresAt || Date.parse(g.expiresAt) > Date.now()) ? g : null;
      },
      held(sessionId, name) {
        const r = rec(sessionId);
        if (!r) return null;
        return node.held(r.peerId).find((g) => g.capability.name === name) || null;
      },
      request(sessionId, capability, reason) {
        const r = rec(sessionId);
        if (!r) return;
        node.requestCapability(r.peerId, normalizeCapability(capability), reason);
      },
      onRequest(fn) { requestFns.add(fn); return () => requestFns.delete(fn); },
      onChange(fn) { changeFns.add(fn); return () => changeFns.delete(fn); },
    },
    audit: {
      append(entry) {
        const e = entry && typeof entry === 'object' ? entry : {};
        return node._audit({ ...e, type: String(e.kind || e.type || 'remote').slice(0, 40) });
      },
    },
    listenAddress(_topic, on) { node.listenAddress(on === true); },
    dialAddress,
    pipeArrived,
    close() {
      for (const off of offs.splice(0)) { try { off(); } catch { /* closing */ } }
      for (const d of dials.values()) { clearTimeout(d.timer); d.reject(Object.assign(new Error('closed'), { code: 'closed' })); }
      dials.clear();
    },
  };
}
