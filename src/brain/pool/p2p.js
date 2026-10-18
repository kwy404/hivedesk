// Pooled giant models between friends over the 1.0 p2p plane (src/p2p/pool-port.js): the lender lends
// rpc-server under its grants, the borrower runs llama-server with --rpc to loopback ports whose bytes
// travel inside the encrypted session.
//
// Gates (default off: nothing is granted until a person grants it):
//   * the lender gave the borrower compute.pool (maxLeaseMinutes, maxLeases) and compute.gpu (VRAM), or
//     compute.cpu with compute.ram (threads, RAM); the node checks compute.pool before any pool.* handler
//     runs, this file checks the resource grant and takes its limits, clamped to the machine;
//   * the borrower turned the experimental flag on, and has the model and the pinned llama.cpp build.
// Revoke: a revoked or expired grant, a block or a session that closes ends the lease at once:
// rpc-server is killed, the stream closed, and the borrower stops llama-server. Every lease, refusal and
// end is in the hash chained audit log of both engines.
import { DialEnd, ListenEnd } from './tunnel.js';
import { PooledSession } from './session.js';
import { LendError } from './lender.js';
import { UP, DOWN } from '../../p2p/pool-port.js';
import { poolMeter } from '../catalog/pool.js';
import crypto from 'node:crypto';

const POOL_CAPS = new Set(['compute.pool', 'compute.gpu', 'compute.cpu', 'compute.ram']);
const ASK_MS = 30_000;

/** What a peer granted this engine for pooling, from the grants it announced (borrower side). */
export function heldShare(held = []) {
  const lim = (name) => held.find((g) => g.capability?.name === name)?.capability.limits || null;
  const pool = lim('compute.pool');
  const gpu = lim('compute.gpu');
  const cpu = lim('compute.cpu');
  const ram = lim('compute.ram');
  if (!pool) return null;
  return {
    pool,
    gpu: gpu ? { enabled: true, maxVramBytes: gpu.maxVramBytes || 0 } : { enabled: false, maxVramBytes: 0 },
    cpu: cpu && ram ? { enabled: true, maxThreads: cpu.maxThreads || 1, maxRamBytes: ram.maxBytes || 0 } : { enabled: false, maxThreads: 0, maxRamBytes: 0 }
  };
}

/** City peers as the pool meter reads them: only online peers that granted compute.pool, with the link's round trip. */
export function poolPeers(port) {
  const out = [];
  for (const p of port.peers()) {
    if (!p.online || p.blocked) continue;
    const share = heldShare(port.held(p.peerId));
    if (!share) continue;
    const rtt = port.rttMs(p.peerId);
    out.push({ id: p.peerId, name: p.name, online: true, granted: true, share, rttMs: rtt, network: port.transport(p.peerId) === 'ws-lan' || (rtt != null && rtt < 10) ? 'lan' : 'internet' });
  }
  return out;
}

/**
 * @param {{ port: ReturnType<typeof import('../../p2p/pool-port.js').createPoolPort>, lender: import('./lender.js').RpcLender,
 *   bus: any, scheduler: any, freshHw: () => Promise<any>, flag: () => boolean,
 *   binaries: (kind: 'gpu'|'cpu') => Promise<{ rpc?: string, server?: string } | null>, log?: (s: string) => void }} o
 */
export function createPoolLink(o) {
  const port = o.port;
  const log = o.log || (() => {});
  /** lender side: leaseId -> { peerId, dial } */
  const lent = new Map();
  /** borrower side: request id -> { resolve, timer, peerId } */
  const asks = new Map();
  /** borrower side: leaseId -> { peerId, listen } */
  const borrowed = new Map();
  let session = null;
  const audit = (entry) => { try { port.audit(entry); } catch { /* the log must not break the pool */ } };
  const offs = [];

  // ---------------------------------------------------------------- lender

  async function onAsk(peerId, b) {
    const no = (code, message) => {
      audit({ type: 'pool.lease.refused', peerId, kind: b.kind || null, code });
      port.send(peerId, 'pool.lease.no', { id: b.id, code, message });
    };
    if (!b.id || !b.kind) return no('bad_input', 'id and kind are required');
    const pool = port.can(peerId, 'compute.pool');
    const res = port.can(peerId, b.kind === 'gpu' ? 'compute.gpu' : 'compute.cpu');
    const ram = b.kind === 'cpu' ? port.can(peerId, 'compute.ram') : null;
    if (!pool || !res || (b.kind === 'cpu' && !ram)) return no('not_granted', b.kind === 'gpu' ? 'pooling needs compute.pool and compute.gpu' : 'pooling needs compute.pool, compute.cpu and compute.ram');
    const pl = pool.capability.limits || {};
    const lim = res.capability.limits || {};
    const limits = b.kind === 'gpu' ? { vramBytes: lim.maxVramBytes } : { threads: lim.maxThreads, ramBytes: ram.capability.limits?.maxBytes };
    if (b.bytes && b.kind === 'gpu' && b.bytes > limits.vramBytes) return no('vram', 'the share asked for is larger than the VRAM granted');
    if (b.bytes && b.kind === 'cpu' && b.bytes > limits.ramBytes) return no('ram', 'the share asked for is larger than the RAM granted');
    await o.freshHw();
    let lease;
    try {
      lease = o.lender.leaseGranted({ peerId, kind: b.kind, limits, minutes: Math.min(b.minutes || pl.maxLeaseMinutes || 60, pl.maxLeaseMinutes || 60), maxLeases: pl.maxLeases || 1 });
    } catch (err) {
      return no(err instanceof LendError ? err.code : 'failed', err.message);
    }
    try {
      const { port: rpcPort } = await o.lender.start(lease.id);
      const dial = new DialEnd({ lease: lease.id, port: rpcPort, send: (f) => {
        const t = DOWN[f.k];
        if (t && !port.send(peerId, t, { leaseId: f.lease, ch: f.ch, ...(f.b64 !== undefined ? { b64: f.b64 } : {}), ...(f.bytes !== undefined ? { bytes: f.bytes } : {}), ...(f.why ? { why: f.why } : {}) })) throw new Error('the session closed');
      } });
      lent.set(lease.id, { peerId, dial });
    } catch (err) {
      o.lender.revoke(lease.id, 'crashed');
      return no('crashed', String(err.message || err).slice(0, 200));
    }
    audit({ type: 'pool.lease', peerId, leaseId: lease.id, kind: lease.kind, limits: lease.limits, expiresAt: lease.expiresAt, model: b.model || null });
    port.send(peerId, 'pool.lease.ok', { id: b.id, leaseId: lease.id, kind: lease.kind, limits: lease.limits, expiresAt: lease.expiresAt });
  }

  /** The lender ended a lease (revoke, expiry, a limit, a crash): close the stream and tell the borrower. */
  function lenderEnded(leaseId, why) {
    const e = lent.get(leaseId);
    if (!e) return;
    lent.delete(leaseId);
    e.dial.close();
    port.send(e.peerId, 'pool.revoked', { leaseId, reason: why });
    audit({ type: 'pool.lease.ended', peerId: e.peerId, leaseId, reason: why });
  }
  offs.push(o.bus.on((ev) => { if (ev.type === 'pool.lend.ended') lenderEnded(ev.data.id, ev.data.why); }));

  // ---------------------------------------------------------------- borrower

  function ask(peerId, body) {
    const id = `pq_${crypto.randomBytes(6).toString('hex')}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { asks.delete(id); resolve({ ok: false, code: 'timeout', message: 'the friend did not answer' }); }, ASK_MS);
      timer.unref?.();
      asks.set(id, { resolve, timer, peerId });
      if (!port.send(peerId, 'pool.lease.ask', { id, ...body })) { clearTimeout(timer); asks.delete(id); resolve({ ok: false, code: 'offline', message: 'no open session with this friend' }); }
    });
  }

  function stopSession(why) {
    if (!session) return false;
    const s = session;
    session = null;
    if (s.brain) o.scheduler.removeBrain(s.brain.id, why);
    s.stop();
    for (const [leaseId, b] of borrowed) {
      b.listen.close();
      port.send(b.peerId, 'pool.lease.end', { leaseId, reason: why.slice(0, 80) });
    }
    borrowed.clear();
    audit({ type: 'pool.session.stopped', reason: why.slice(0, 80) });
    o.bus.emit('pool.session.stopped', { why });
    return true;
  }

  /**
   * Starts a pooled model: asks each friend for a lease, opens the loopback ends, runs llama-server.
   * @param {{ pick: any, modelFile: string, ctx: number, peers: Array<{ peerId: string, kind: 'gpu'|'cpu', bytes: number }>, localShare?: number }} req
   */
  async function start(req) {
    if (!o.flag()) throw Object.assign(new Error('pooled models are experimental and off: turn them on first'), { code: 'conflict' });
    if (session) throw Object.assign(new Error('a pooled model is already running'), { code: 'conflict' });
    const bins = (await o.binaries('gpu')) || (await o.binaries('cpu'));
    if (!bins?.server) throw Object.assign(new Error('llama.cpp is not installed on this PC'), { code: 'conflict' });
    const granted = [];
    try {
      for (const p of req.peers) {
        const r = await ask(p.peerId, { kind: p.kind, model: req.pick.id, bytes: Math.round(p.bytes || 0), minutes: req.minutes });
        if (!r.ok) throw Object.assign(new Error(`${p.peerId.slice(0, 12)} refused: ${r.code} ${r.message || ''}`.trim()), { code: 'refused', refusal: r.code });
        const listen = new ListenEnd({ lease: r.leaseId, send: (f) => {
          const t = UP[f.k];
          if (t && !port.send(p.peerId, t, { leaseId: f.lease, ch: f.ch, ...(f.b64 !== undefined ? { b64: f.b64 } : {}), ...(f.bytes !== undefined ? { bytes: f.bytes } : {}), ...(f.why ? { why: f.why } : {}) })) throw new Error('the session closed');
        } });
        borrowed.set(r.leaseId, { peerId: p.peerId, listen });
        granted.push({ peerId: p.peerId, leaseId: r.leaseId, port: await listen.listen(), bytes: p.bytes || 0 });
      }
    } catch (err) {
      for (const [leaseId, b] of borrowed) { b.listen.close(); port.send(b.peerId, 'pool.lease.end', { leaseId, reason: 'start failed' }); }
      borrowed.clear();
      throw err;
    }
    const total = granted.reduce((n, g) => n + g.bytes, 0);
    const split = granted.length > 1 && total > 0 ? granted.map((g) => g.bytes / total) : undefined;
    // The borrower keeps localShare of the layers on its own device; the rest go to the lenders.
    const layers = (req.pick.arch?.layers || 32) + 1;
    const ngl = req.localShare ? Math.max(1, Math.round(layers * (1 - req.localShare))) : 999;
    session = new PooledSession({ server: bins.server, model: req.modelFile, name: req.pick.name, rpcPorts: granted.map((g) => g.port), ctx: req.ctx, split, ngl, bus: o.bus, log, loadTimeoutMs: req.loadTimeoutMs });
    const s = session;
    audit({ type: 'pool.session', model: req.pick.id, lenders: granted.map((g) => g.peerId), leases: granted.map((g) => g.leaseId) });
    try {
      const brain = await s.start();
      if (session !== s) throw new Error('the pooled model was stopped while it loaded');
      const chat = brain.chat.bind(brain);
      // Friends compute part of every answer: their output is untrusted, like any remote output.
      brain.chat = async (...args) => ({ ...(await chat(...args)), remoteOrigin: granted[0].peerId, pooled: granted.map((g) => g.peerId) });
      o.scheduler.addBrain(brain);
      return { model: req.pick.id, lenders: granted.length, leases: granted.map((g) => ({ peerId: g.peerId, leaseId: g.leaseId })), brainId: brain.id, ngl };
    } catch (err) {
      stopSession(`failed: ${String(err.message || err).slice(0, 60)}`);
      throw err;
    }
  }

  // ---------------------------------------------------------------- messages

  offs.push(port.on((peerId, type, b) => {
    switch (type) {
      case 'pool.lease.ask':
        onAsk(peerId, b).catch((err) => log(`pool lease failed: ${err.message}`));
        return;
      case 'pool.lease.end': {
        const e = lent.get(b.leaseId);
        if (e && e.peerId === peerId) o.lender.revoke(b.leaseId, b.reason === 'released' ? 'released' : 'released');
        return;
      }
      case 'pool.open': case 'pool.up': case 'pool.ack': case 'pool.close': {
        const e = lent.get(b.leaseId);
        if (!e || e.peerId !== peerId) return;
        const f = port.toFrame(type, b);
        if (f) e.dial.receive(f);
        return;
      }
      case 'pool.lease.ok': case 'pool.lease.no': {
        const a = asks.get(b.id);
        if (!a || a.peerId !== peerId) return;
        asks.delete(b.id);
        clearTimeout(a.timer);
        a.resolve(type === 'pool.lease.ok' && b.leaseId ? { ok: true, leaseId: b.leaseId, limits: b.limits, expiresAt: b.expiresAt } : { ok: false, code: b.code || 'refused', message: b.message || '' });
        return;
      }
      case 'pool.down': case 'pool.dack': case 'pool.dclose': {
        const e = borrowed.get(b.leaseId);
        if (!e || e.peerId !== peerId) return;
        const f = port.toFrame(type, b);
        if (f) e.listen.receive(f);
        return;
      }
      case 'pool.revoked': {
        const e = borrowed.get(b.leaseId);
        if (!e || e.peerId !== peerId) return;
        audit({ type: 'pool.lease.revoked', peerId, leaseId: b.leaseId, reason: b.reason });
        stopSession(`the friend ended the lease: ${b.reason}`);
        return;
      }
      default:
    }
  }));

  offs.push(port.onPeer((e) => {
    // Lender: a pool grant revoked or expired, a block, or the session gone ends this peer's leases now.
    if (e.type === 'offline' || e.type === 'blocked' || (e.type === 'grant.ended' && POOL_CAPS.has(e.capability))) {
      for (const l of o.lender.leasesOf(e.peerId)) o.lender.revoke(l.id, e.type === 'grant.ended' ? `grant_${e.reason === 'expired' ? 'expired' : 'revoked'}` : e.type);
    }
    // Borrower: the friend took back what it granted, or went away.
    if (session && [...borrowed.values()].some((b) => b.peerId === e.peerId) && (e.type === 'offline' || e.type === 'blocked' || (e.type === 'held.ended' && POOL_CAPS.has(e.capability)))) {
      stopSession(e.type === 'held.ended' ? 'the friend revoked its grant' : 'the friend went offline');
    }
  }));

  return {
    start,
    stop: (why = 'stopped') => stopSession(why),
    get session() { return session; },
    leases: () => ({ lent: [...lent.entries()].map(([leaseId, e]) => ({ leaseId, peerId: e.peerId })), borrowed: [...borrowed.entries()].map(([leaseId, e]) => ({ leaseId, peerId: e.peerId })) }),
    /** The meter with the friends who granted pooling, over their real links. */
    meter: (pick, ctx, hw) => poolMeter(pick, ctx, hw, poolPeers(port)),
    close() {
      stopSession('shutdown');
      for (const [id] of lent) o.lender.revoke(id, 'shutdown');
      for (const off of offs.splice(0)) { try { off(); } catch { /* ignore */ } }
    }
  };
}
