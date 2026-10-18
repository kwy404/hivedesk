// A pooled model between two real engines over the 1.0 p2p plane (ws-lan on localhost): pairing with
// the pool grants, a lease, llama-server on the borrower with half of the layers on the lender's
// rpc-server through the encrypted session, a turn, a cancel, and a revoke that ends it at once.
// Runs real llama.cpp processes: it needs the pinned CPU build and Qwen2.5-Coder 0.5B Q4_K_M in the
// real hivedesk home (test/pool/e2e-pool.mjs installs the build); otherwise it is skipped.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startHive } from '../../src/index.js';
import { platformKey, buildDir, installed } from '../../src/brain/pool/release.js';
import { pick } from '../../src/brain/catalog/index.js';
import { modelPath, isCached } from '../../src/brain/models.js';
import { tmpDir, waitFor } from '../helpers.js';

const REAL = process.env.HIVEDESK_HOME || path.join(os.homedir(), '.hivedesk');
const KEY = platformKey({ os: process.platform, arch: process.arch, gpu: null }, 'cpu');
const MODEL = pick('qwen2.5-coder-0.5b', 'Q4_K_M');
const ready = !!installed(REAL, KEY) && isCached(REAL, MODEL) && os.freemem() > 1.2e9 && !process.env.HIVEDESK_SKIP_PROCESS_TESTS;
const cmd = (app, type, data = {}) => app.router.dispatch(type, data, { origin: { kind: 'user' } });
const GB = 1024 ** 3;

function homeWith({ build, model }) {
  const h = tmpDir();
  if (build) fs.cpSync(buildDir(REAL, KEY), buildDir(h, KEY), { recursive: true });
  if (model) { fs.mkdirSync(path.join(h, 'models'), { recursive: true }); fs.linkSync(modelPath(REAL, MODEL), modelPath(h, MODEL)); }
  return h;
}

describe.skipIf(!ready)('a pooled model between two engines over p2p', () => {
  it('leases under the pool grants, splits the layers over the session, answers, cancels and stops at once on revoke', async () => {
    const flags = { brain: 'local', noDownload: true };
    const lender = await startHive({ dir: tmpDir(), home: homeWith({ build: true }), name: 'Rita PC', flags, log: () => {} });
    const borrower = await startHive({ dir: tmpDir(), home: homeWith({ build: true, model: true }), name: 'Alex PC', flags, log: () => {} });
    try {
      // Pair over ws-lan; the lender grants nothing at first.
      const lan = await cmd(lender, 'p2p.lan.listen', { host: '127.0.0.1', port: 0 });
      const inv = await cmd(lender, 'p2p.invite.create', { caps: [{ name: 'city.view' }] });
      const join = await cmd(borrower, 'p2p.join', { words: inv.words.join(' '), via: 'lan', address: `127.0.0.1:${lan.port}` });
      expect(join.phase).toBe('sas');
      const req = await waitFor(async () => (await cmd(lender, 'p2p.join.requests')).requests[0]);
      await cmd(lender, 'p2p.join.answer', { requestId: req.requestId || req.id, accept: true, sasMatches: true, caps: [{ name: 'city.view' }] });
      const lenderId = lender.p2p.node().info().peerId;
      const borrowerId = borrower.p2p.node().info().peerId;
      await waitFor(() => borrower.p2p.node().held(lenderId).length);
      await cmd(borrower, 'pool.flag.set', { on: true });
      const peers = [{ peerId: lenderId, kind: 'cpu', bytes: Math.round(MODEL.bytes / 2) }];

      // No grant, no lease: the node refuses pool.lease.ask before any handler runs.
      await expect(cmd(borrower, 'pool.p2p.start', { id: MODEL.id, ctx: 2048, peers, localShare: 0.5 })).rejects.toThrow(/refused|not_granted|timeout/);
      // compute.pool alone is not enough: the CPU and RAM grants set the limits.
      await cmd(lender, 'p2p.grant', { peerId: borrowerId, capability: { name: 'compute.pool', limits: { maxLeaseMinutes: 10, maxLeases: 1 } } });
      await waitFor(() => borrower.p2p.node().held(lenderId).some((g) => g.capability.name === 'compute.pool'));
      await expect(cmd(borrower, 'pool.p2p.start', { id: MODEL.id, ctx: 2048, peers, localShare: 0.5 })).rejects.toThrow(/not_granted/);
      await cmd(lender, 'p2p.grant', { peerId: borrowerId, capability: { name: 'compute.cpu', limits: { maxThreads: 2 } } });
      const ram = await cmd(lender, 'p2p.grant', { peerId: borrowerId, capability: { name: 'compute.ram', limits: { maxBytes: 2 * GB } } });
      await waitFor(() => borrower.p2p.node().held(lenderId).length >= 4);

      // The meter now counts the friend's granted RAM over the real link.
      const meter = await cmd(borrower, 'models.pool', { id: MODEL.id, ctx: 2048 });
      expect(meter.peers.find((x) => x.id === lenderId)).toMatchObject({ ram: 2 * GB, threads: 2 });
      expect(meter.execution).toBe('experimental');

      // The lease and the split: half of the layers on the lender, through the session.
      const t0 = Date.now();
      const s = await cmd(borrower, 'pool.p2p.start', { id: MODEL.id, ctx: 2048, peers, localShare: 0.5, loadTimeoutMs: 180_000 });
      expect(s).toMatchObject({ lenders: 1, brainId: 'pooled' });
      expect(s.ngl).toBeLessThan(MODEL.arch.layers + 1);
      const lease = s.leases[0].leaseId;
      expect((await cmd(lender, 'pool.p2p.status')).lent).toEqual([{ leaseId: lease, peerId: borrowerId }]);
      const loadMs = Date.now() - t0;

      const t1 = Date.now();
      const r = await borrower.scheduler.turn({ workerId: 'dev', messages: [{ role: 'user', content: 'Write one short sentence about bread.' }], options: { maxTokens: 24, temperature: 0 } });
      expect(r.text.trim().length).toBeGreaterThan(0);
      expect(r.remoteOrigin).toBe(lenderId);
      const turnMs = Date.now() - t1;

      // Cancel: the turn stops at once and the model stays.
      const ctrl = new AbortController();
      const long = borrower.scheduler.turn({ workerId: 'dev', messages: [{ role: 'user', content: 'Count from 1 to 400, one number per line.' }], options: { maxTokens: 1200 }, signal: ctrl.signal });
      setTimeout(() => ctrl.abort(), 1000);
      const tc = Date.now();
      await expect(long).rejects.toThrow();
      expect(Date.now() - tc).toBeLessThan(10_000);
      const again = await borrower.scheduler.turn({ workerId: 'dev', messages: [{ role: 'user', content: 'Say OK.' }], options: { maxTokens: 6 } });
      expect(again.text.length).toBeGreaterThan(0);

      // Revoke on the lender: rpc-server is killed, the stream closed, the borrower's pooled brain gone.
      await cmd(lender, 'p2p.revoke', { grantId: ram.grant.id, reason: 'done' });
      await waitFor(() => !borrower.scheduler.brains.has('pooled'), { timeout: 10_000 });
      expect((await cmd(lender, 'pool.p2p.status')).lent).toEqual([]);
      const lAudit = lender.p2p.node().audit.tail(100).map((a) => a.entry.type);
      expect(lAudit).toEqual(expect.arrayContaining(['pool.lease.refused', 'pool.lease', 'revoke', 'pool.lease.ended']));
      const bAudit = borrower.p2p.node().audit.tail(100).map((a) => a.entry.type);
      expect(bAudit).toEqual(expect.arrayContaining(['pool.session', 'pool.session.stopped']));
      console.log(`pooled over p2p: load ${(loadMs / 1000).toFixed(1)} s, first turn ${r.completionTokens} tokens in ${(turnMs / 1000).toFixed(1)} s`);
    } finally {
      await borrower.close();
      await lender.close();
    }
  }, 300_000);
});
