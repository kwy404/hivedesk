// The p2p port of pooled models (src/brain/pool/p2p.js) over this engine's P2PNode: the lease
// messages and a multiplexed byte stream that carries llama.cpp RPC inside the encrypted session.
//
// Borrower to lender (the lender checks compute.pool before any handler runs):
//   pool.lease.ask   { id, kind: 'gpu' | 'cpu', model, bytes, minutes }      control
//   pool.lease.end   { leaseId, reason }                                     control
//   pool.open        { leaseId, ch }                                         compute
//   pool.up          { leaseId, ch, b64 }      bytes toward the lender's rpc-server
//   pool.ack         { leaseId, ch, bytes }    flow control for pool.down
//   pool.close       { leaseId, ch, why }
// Lender to borrower (answers; the borrower matches them to its own leases with that peer):
//   pool.lease.ok    { id, leaseId, kind, limits, expiresAt }
//   pool.lease.no    { id, code, message }
//   pool.revoked     { leaseId, reason }      the lease ended on the lender (revoke, expiry, limit)
//   pool.down        { leaseId, ch, b64 }      bytes from the lender's rpc-server
//   pool.dack        { leaseId, ch, bytes }
//   pool.dclose      { leaseId, ch, why }
// Data chunks are at most 256 KB (base64 under 350,000 characters), below the session frame size.

import { registerMessage, MessageError, STREAM } from './messages.js';

const KB = 1024;
const CHUNK_B64 = 350_000;
const LEASE_RE = /^ls_[0-9a-f]{12}$/;
const ID_RE = /^pq_[0-9a-f]{12}$/;

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : undefined);
const int = (v, min, max) => (Number.isInteger(v) && v >= min && v <= max ? v : undefined);
const leaseOf = (b) => (typeof b?.leaseId === 'string' && LEASE_RE.test(b.leaseId) ? b.leaseId : undefined);
const kindOf = (v) => (v === 'gpu' || v === 'cpu' ? v : undefined);
const chan = (b) => ({ leaseId: leaseOf(b), ch: int(b?.ch, 0, 1e6) });
// A tunnel chunk over its bound (or not base64) is refused with bad_input, never dropped or cut (src/p2p/messages.js).
const data = (b) => {
  if (typeof b?.b64 !== 'string' || b.b64.length > CHUNK_B64 || !/^[A-Za-z0-9+/=]*$/.test(b.b64)) throw new MessageError('bad_input', `a pool chunk is base64 of at most ${CHUNK_B64} characters`);
  return { ...chan(b), b64: b.b64 };
};
const ack = (b) => ({ ...chan(b), bytes: int(b?.bytes, 0, 1 << 30) });
const close = (b) => ({ ...chan(b), why: str(b?.why, 80) || 'closed' });

const CTRL = STREAM.CONTROL;
const COMP = STREAM.COMPUTE;
registerMessage('pool.lease.ask', { stream: CTRL, cap: 'compute.pool', max: 4 * KB, rate: [10, 60_000], refuse: (b) => (b.id ? ['pool.lease.no', { id: b.id, code: 'not_granted', message: 'you do not hold compute.pool on this machine' }] : null), normalize: (b) => ({ id: ID_RE.test(b?.id || '') ? b.id : undefined, kind: kindOf(b?.kind), model: str(b?.model, 120), bytes: int(b?.bytes, 0, 2 ** 46), minutes: int(b?.minutes, 1, 480) }) });
registerMessage('pool.lease.end', { stream: CTRL, cap: 'compute.pool', max: 2 * KB, normalize: (b) => ({ leaseId: leaseOf(b), reason: str(b?.reason, 80) || 'released' }) });
registerMessage('pool.lease.ok', { stream: CTRL, reply: true, max: 4 * KB, normalize: (b) => ({ id: ID_RE.test(b?.id || '') ? b.id : undefined, leaseId: leaseOf(b), kind: kindOf(b?.kind), limits: { vramBytes: int(b?.limits?.vramBytes, 0, 2 ** 46), ramBytes: int(b?.limits?.ramBytes, 0, 2 ** 46), threads: int(b?.limits?.threads, 0, 1024) }, expiresAt: str(b?.expiresAt, 40) }) });
registerMessage('pool.lease.no', { stream: CTRL, reply: true, max: 4 * KB, normalize: (b) => ({ id: ID_RE.test(b?.id || '') ? b.id : undefined, code: str(b?.code, 40) || 'refused', message: str(b?.message, 300) || '' }) });
registerMessage('pool.revoked', { stream: CTRL, reply: true, max: 2 * KB, normalize: (b) => ({ leaseId: leaseOf(b), reason: str(b?.reason, 80) || 'revoked' }) });
registerMessage('pool.open', { stream: COMP, cap: 'compute.pool', max: 1 * KB, rate: [64, 10_000], normalize: chan });
registerMessage('pool.up', { stream: COMP, cap: 'compute.pool', max: 360 * KB, rate: [4000, 1000], normalize: data });
registerMessage('pool.ack', { stream: COMP, cap: 'compute.pool', max: 1 * KB, rate: [8000, 1000], normalize: ack });
registerMessage('pool.close', { stream: COMP, cap: 'compute.pool', max: 1 * KB, rate: [64, 1000], normalize: close });
registerMessage('pool.down', { stream: COMP, reply: true, max: 360 * KB, rate: [4000, 1000], normalize: data });
registerMessage('pool.dack', { stream: COMP, reply: true, max: 1 * KB, rate: [8000, 1000], normalize: ack });
registerMessage('pool.dclose', { stream: COMP, reply: true, max: 1 * KB, rate: [64, 1000], normalize: close });

export const POOL_TYPES = Object.freeze(['pool.lease.ask', 'pool.lease.end', 'pool.lease.ok', 'pool.lease.no', 'pool.revoked', 'pool.open', 'pool.up', 'pool.ack', 'pool.close', 'pool.down', 'pool.dack', 'pool.dclose']);

/** The tunnel frame kinds of src/brain/pool/tunnel.js, per direction. */
export const UP = Object.freeze({ open: 'pool.open', data: 'pool.up', ack: 'pool.ack', end: 'pool.close' });
export const DOWN = Object.freeze({ data: 'pool.down', ack: 'pool.dack', end: 'pool.dclose' });
const FRAME_OF = { 'pool.open': 'open', 'pool.up': 'data', 'pool.ack': 'ack', 'pool.close': 'end', 'pool.down': 'data', 'pool.dack': 'ack', 'pool.dclose': 'end' };

/**
 * @param {import('./node.js').P2PNode} node a started node
 * @returns {{ selfId: string, send(peerId, type, body): boolean, on(fn): () => void, can(peerId, cap): any, held(peerId): any[],
 *   peers(): any[], rttMs(peerId): number | null, transport(peerId): string | null, onPeer(fn): () => void, audit(entry): void,
 *   toFrame(type, body): object | null, close(): void }}
 */
export function createPoolPort(node) {
  const fns = new Set();
  const peerFns = new Set();
  const offs = [];
  for (const type of POOL_TYPES) {
    offs.push(node.handle(type, (msg, ctx) => {
      for (const fn of [...fns]) {
        try { fn(ctx.peerId, type, msg.body, ctx); } catch { /* one listener never breaks another */ }
      }
    }));
  }
  const on = (ev, fn) => { node.on(ev, fn); offs.push(() => node.off(ev, fn)); };
  const peerEvent = (e) => { for (const fn of [...peerFns]) { try { fn(e); } catch { /* ignore */ } } };
  on('peer.offline', (e) => peerEvent({ type: 'offline', peerId: e.peerId }));
  on('peer.blocked', (e) => peerEvent({ type: 'blocked', peerId: e.peerId }));
  on('grant.revoked', ({ grant, reason }) => peerEvent({ type: 'grant.ended', peerId: grant.peerId, capability: grant.capability.name, reason }));
  on('held.revoked', (e) => peerEvent({ type: 'held.ended', peerId: e.peerId, capability: e.capability, reason: e.reason }));
  return {
    get selfId() { return node.identity.peerId; },
    send(peerId, type, body) {
      try { node.send(peerId, type, body); return true; } catch { return false; }
    },
    on(fn) { fns.add(fn); return () => fns.delete(fn); },
    onPeer(fn) { peerFns.add(fn); return () => peerFns.delete(fn); },
    /** A grant this engine gave the peer (lender side). */
    can: (peerId, cap) => node.can(peerId, cap),
    /** Grants the peer gave this engine (borrower side). */
    held: (peerId) => node.held(peerId),
    peers: () => node.listPeers().map((p) => ({ peerId: p.identity.peerId, name: p.identity.name, online: p.online, blocked: p.trust === 'blocked' })),
    rttMs(peerId) {
      const r = node.sessionOf(peerId);
      return r && Number.isFinite(r.session.conn.rttMs) ? r.session.conn.rttMs : null;
    },
    transport(peerId) {
      const r = node.sessionOf(peerId);
      return r ? String(r.session.conn.transport || '') : null;
    },
    audit(entry) { node._audit({ ...entry, type: String(entry.type || 'pool') }); },
    /** A p2p body as a tunnel frame ({ k, lease, ch, b64?, bytes?, why? }), or null when malformed. */
    toFrame(type, body) {
      const k = FRAME_OF[type];
      if (!k || !body?.leaseId || !Number.isInteger(body.ch)) return null;
      if (k === 'data' && typeof body.b64 !== 'string') return null;
      return { k, lease: body.leaseId, ch: body.ch, ...(k === 'data' ? { b64: body.b64 } : {}), ...(k === 'ack' ? { bytes: body.bytes || 0 } : {}), ...(k === 'end' ? { why: body.why } : {}) };
    },
    close() {
      for (const off of offs.splice(0)) off();
      fns.clear();
      peerFns.clear();
    }
  };
}
