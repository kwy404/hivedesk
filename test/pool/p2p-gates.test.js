// The gates of pooled models over p2p, with fakes (no process, no session): which grants a lease needs,
// the limits it takes from them, the revoke that ends it at once, the wire messages, and the meter that
// counts only what friends granted, over their real round trip.
import { describe, it, expect } from 'vitest';
import { createPoolLink, heldShare, poolPeers } from '../../src/brain/pool/p2p.js';
import { messageSpec, readMessage, STREAM } from '../../src/p2p/messages.js';
import { POOL_TYPES } from '../../src/p2p/pool-port.js';
import { normalizeCapability, CAPABILITY_NAMES } from '../../src/p2p/caps.js';
import { poolMeter } from '../../src/brain/catalog/pool.js';
import { pick } from '../../src/brain/catalog/index.js';

const GB = 1024 ** 3;
const grant = (name, limits) => ({ capability: { name, limits } });

function fakePort(grants = {}) {
  const sent = [];
  const audits = [];
  let onMsg = null;
  let onPeer = null;
  return {
    sent, audits,
    selfId: 'me',
    send: (peerId, type, body) => { sent.push({ peerId, type, body }); return true; },
    on: (fn) => { onMsg = fn; return () => {}; },
    onPeer: (fn) => { onPeer = fn; return () => {}; },
    can: (peerId, cap) => grants[peerId]?.[cap] || null,
    held: () => [],
    peers: () => [],
    rttMs: () => 1,
    transport: () => 'ws-lan',
    audit: (e) => audits.push(e),
    toFrame: () => null,
    deliver: (peerId, type, body) => onMsg(peerId, type, body),
    peerEvent: (e) => onPeer(e)
  };
}

function fakeLender() {
  const calls = [];
  const leases = new Map();
  return {
    calls, leases,
    leaseGranted(req) { calls.push(['lease', req]); const l = { id: 'ls_aaaaaaaaaaaa', kind: req.kind, limits: req.limits, expiresAt: new Date().toISOString(), peerId: req.peerId }; leases.set(l.id, l); return l; },
    async start(id) { calls.push(['start', id]); return { port: 1 }; },
    revoke(id, why) { calls.push(['revoke', id, why]); return leases.delete(id); },
    leasesOf(peerId) { return [...leases.values()].filter((l) => l.peerId === peerId); }
  };
}

const bus = () => { const fns = new Set(); return { on: (fn) => { fns.add(fn); return () => fns.delete(fn); }, emit: (type, data) => { for (const fn of fns) fn({ type, data }); } }; };
const link = (port, lender) => createPoolLink({ port, lender, bus: bus(), scheduler: { addBrain() {}, removeBrain() {} }, freshHw: async () => ({}), flag: () => true, binaries: async () => null });
const flush = () => new Promise((r) => setTimeout(r, 10));
const ask = (kind, extra = {}) => ({ id: 'pq_000000000001', kind, model: 'qwen2.5-coder-0.5b:Q4_K_M', ...extra });

describe('lending under p2p grants', () => {
  it('a GPU lease needs compute.gpu beside compute.pool, a CPU lease needs compute.cpu and compute.ram', async () => {
    const port = fakePort({ p1: { 'compute.pool': grant('compute.pool', { maxLeaseMinutes: 30, maxLeases: 1 }) } });
    const lender = fakeLender();
    link(port, lender);
    port.deliver('p1', 'pool.lease.ask', ask('gpu'));
    port.deliver('p1', 'pool.lease.ask', ask('cpu'));
    await flush();
    expect(port.sent.map((m) => [m.type, m.body.code])).toEqual([['pool.lease.no', 'not_granted'], ['pool.lease.no', 'not_granted']]);
    expect(lender.calls).toEqual([]);
    expect(port.audits.every((a) => a.type === 'pool.lease.refused')).toBe(true);
  });

  it('takes the limits from the grants, refuses a share above them, and starts rpc-server only then', async () => {
    const port = fakePort({ p1: {
      'compute.pool': grant('compute.pool', { maxLeaseMinutes: 20, maxLeases: 1 }),
      'compute.cpu': grant('compute.cpu', { maxThreads: 3 }),
      'compute.ram': grant('compute.ram', { maxBytes: 2 * GB })
    } });
    const lender = fakeLender();
    link(port, lender);
    port.deliver('p1', 'pool.lease.ask', ask('cpu', { bytes: 3 * GB }));
    await flush();
    expect(port.sent.at(-1)).toMatchObject({ type: 'pool.lease.no', body: { code: 'ram' } });
    port.deliver('p1', 'pool.lease.ask', ask('cpu', { bytes: 1 * GB, minutes: 400 }));
    await flush();
    expect(lender.calls[0]).toEqual(['lease', { peerId: 'p1', kind: 'cpu', limits: { threads: 3, ramBytes: 2 * GB }, minutes: 20, maxLeases: 1 }]);
    expect(lender.calls[1]).toEqual(['start', 'ls_aaaaaaaaaaaa']);
    expect(port.sent.at(-1)).toMatchObject({ type: 'pool.lease.ok', body: { leaseId: 'ls_aaaaaaaaaaaa', kind: 'cpu' } });
    expect(port.audits.at(-1)).toMatchObject({ type: 'pool.lease', peerId: 'p1', leaseId: 'ls_aaaaaaaaaaaa' });
  });

  it('a revoked or expired pool grant, a block or a closed session ends the leases of that peer at once', async () => {
    const g = { 'compute.pool': grant('compute.pool', {}), 'compute.gpu': grant('compute.gpu', { maxVramBytes: 4 * GB }) };
    const port = fakePort({ p1: g, p2: g });
    const lender = fakeLender();
    link(port, lender);
    port.deliver('p1', 'pool.lease.ask', ask('gpu'));
    await flush();
    port.peerEvent({ type: 'grant.ended', peerId: 'p2', capability: 'compute.gpu', reason: 'revoked' });
    expect(lender.calls.filter((c) => c[0] === 'revoke')).toEqual([]);
    port.peerEvent({ type: 'grant.ended', peerId: 'p1', capability: 'city.view', reason: 'revoked' });
    expect(lender.calls.filter((c) => c[0] === 'revoke')).toEqual([]);
    port.peerEvent({ type: 'grant.ended', peerId: 'p1', capability: 'compute.gpu', reason: 'revoked' });
    expect(lender.calls.filter((c) => c[0] === 'revoke')).toEqual([['revoke', 'ls_aaaaaaaaaaaa', 'grant_revoked']]);
    port.deliver('p1', 'pool.lease.ask', ask('gpu'));
    await flush();
    port.peerEvent({ type: 'offline', peerId: 'p1' });
    expect(lender.calls.filter((c) => c[0] === 'revoke').at(-1)).toEqual(['revoke', 'ls_aaaaaaaaaaaa', 'offline']);
  });

  it('ignores stream bytes for a lease the peer does not hold', async () => {
    const port = fakePort({});
    const lender = fakeLender();
    link(port, lender);
    expect(() => port.deliver('p9', 'pool.up', { leaseId: 'ls_aaaaaaaaaaaa', ch: 0, b64: 'AA==' })).not.toThrow();
    expect(port.sent).toEqual([]);
  });

  it('the borrower refuses to start while the experimental flag is off', async () => {
    const l = createPoolLink({ port: fakePort(), lender: fakeLender(), bus: bus(), scheduler: {}, freshHw: async () => ({}), flag: () => false, binaries: async () => null });
    await expect(l.start({ pick: pick('qwen2.5-coder-0.5b', 'Q4_K_M'), peers: [] })).rejects.toThrow(/experimental and off/);
  });
});

describe('the pool messages on the wire', () => {
  it('registers every pool type on its stream, with compute.pool on what the borrower sends', () => {
    for (const t of POOL_TYPES) expect(messageSpec(t), t).toBeTruthy();
    for (const t of ['pool.lease.ask', 'pool.lease.end', 'pool.open', 'pool.up', 'pool.ack', 'pool.close']) expect(messageSpec(t).cap, t).toBe('compute.pool');
    for (const t of ['pool.lease.ok', 'pool.lease.no', 'pool.revoked', 'pool.down', 'pool.dack', 'pool.dclose']) expect(messageSpec(t).cap, t).toBeNull();
    expect(messageSpec('pool.up').stream).toBe(STREAM.COMPUTE);
    expect(messageSpec('pool.lease.ask').stream).toBe(STREAM.CONTROL);
    expect(messageSpec('pool.lease.ask').refuse({ id: 'pq_000000000001' })[0]).toBe('pool.lease.no');
  });

  it('keeps only well formed chunks: a lease id, a channel, base64 under the size cap', () => {
    const m = (body, t = 'pool.up') => readMessage({ t, ts: 1, body }, STREAM.COMPUTE, 100).body;
    expect(m({ leaseId: 'ls_aaaaaaaaaaaa', ch: 2, b64: 'QUJD' })).toEqual({ leaseId: 'ls_aaaaaaaaaaaa', ch: 2, b64: 'QUJD' });
    expect(m({ leaseId: 'bad', ch: 2, b64: 'QUJD' }).leaseId).toBeUndefined();
    // A chunk over the cap or not base64 is refused with bad_input, never dropped from the stream.
    expect(() => m({ leaseId: 'ls_aaaaaaaaaaaa', ch: 2, b64: 'x'.repeat(400_000) })).toThrow(expect.objectContaining({ code: 'bad_input' }));
    expect(() => m({ leaseId: 'ls_aaaaaaaaaaaa', ch: 2, b64: '<script>' })).toThrow(expect.objectContaining({ code: 'bad_input' }));
    expect(() => readMessage({ t: 'pool.up', ts: 1, body: {} }, STREAM.CONTROL, 10)).toThrow(/stream/);
  });

  it('compute.pool is a capability with lease limits', () => {
    expect(CAPABILITY_NAMES).toContain('compute.pool');
    expect(normalizeCapability({ name: 'compute.pool', limits: { maxLeaseMinutes: 9999, maxLeases: 0 } }).limits).toEqual({ maxLeaseMinutes: 480, maxLeases: 1 });
  });
});

describe('the meter counts what friends granted, over their link', () => {
  const giant = pick('qwen2.5-coder-32b', 'Q4_K_M');
  const hw = { gpu: { name: 'NVIDIA GeForce GTX 1060 6GB', vramBytes: 6.44e9, backend: 'cuda' }, ramBytes: 16e9, cpu: { cores: 4, avx2: true } };
  const held = (vram) => [grant('compute.pool', { maxLeaseMinutes: 60, maxLeases: 1 }), grant('compute.gpu', { maxVramBytes: vram })];

  it('reads the held grants: no compute.pool, no share; CPU needs compute.cpu and compute.ram', () => {
    expect(heldShare([grant('compute.gpu', { maxVramBytes: 8 * GB })])).toBeNull();
    expect(heldShare(held(8 * GB)).gpu).toEqual({ enabled: true, maxVramBytes: 8 * GB });
    expect(heldShare([grant('compute.pool', {}), grant('compute.cpu', { maxThreads: 4 })]).cpu.enabled).toBe(false);
  });

  it('only online peers that granted compute.pool count, and a link on the LAN is faster than a far one', () => {
    const peers = [{ peerId: 'a', name: 'Ana', online: true }, { peerId: 'b', name: 'Bia', online: true }, { peerId: 'c', name: 'Cai', online: false }];
    const port = { peers: () => peers, held: (id) => (id === 'a' || id === 'c' ? held(12 * GB) : []), rttMs: () => 2, transport: () => 'ws-lan' };
    const list = poolPeers(port);
    expect(list.map((p) => p.id)).toEqual(['a']);
    expect(list[0]).toMatchObject({ granted: true, network: 'lan', rttMs: 2 });
    const near = poolMeter(giant, 4096, { ...hw, ramBytes: 4e9 }, [{ ...list[0], share: heldShare(held(16 * GB)) }]);
    const far = poolMeter(giant, 4096, { ...hw, ramBytes: 4e9 }, [{ ...list[0], network: 'internet', rttMs: 150, share: heldShare(held(16 * GB)) }]);
    expect(near.unlocked).toBe(true);
    expect(far.tps).toBeLessThan(near.tps);
    // A granted share is not clamped by hardware the borrower cannot see.
    expect(near.peers[0].vram).toBe(16 * GB);
  });

  it('is locked while the granted memory does not fit the model', () => {
    const m = poolMeter(giant, 4096, { ...hw, ramBytes: 4e9 }, [{ id: 'a', name: 'Ana', online: true, granted: true, network: 'lan', rttMs: 2, share: heldShare(held(4 * GB)) }]);
    expect(m.unlocked).toBe(false);
    expect(m.missing).toBeGreaterThan(0);
  });
});
