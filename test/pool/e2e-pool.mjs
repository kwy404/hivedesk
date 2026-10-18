// End to end check of a pooled model on one PC: two engines (a lender and a borrower) with their own
// homes, the official llama.cpp build (pinned, SHA-256 checked), rpc-server on the lender with a CPU
// share, llama-server on the borrower, and the tunnel frames carried by a relay that stands in for the
// two browsers and the peer channel. Not part of the unit tests: it runs real processes.
//
// Usage: node test/pool/e2e-pool.mjs [model id]     default qwen2.5-coder-0.5b:Q4_K_M (must be downloaded)
// Needs about 1.5 GB of free RAM. Loads no GPU.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startHive } from '../../src/index.js';
import { installBuild, platformKey, buildDir } from '../../src/brain/pool/release.js';
import { resolvePick } from '../../src/brain/catalog/index.js';
import { modelPath, isCached } from '../../src/brain/models.js';

const REAL_HOME = process.env.HIVEDESK_HOME || path.join(os.homedir(), '.hivedesk');
const MODEL = process.argv[2] || 'qwen2.5-coder-0.5b:Q4_K_M';
const failures = [];
const check = (ok, label) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`); if (!ok) failures.push(label); };

if (os.freemem() < 1.5e9) { console.error(`only ${(os.freemem() / 1e9).toFixed(1)} GB of RAM free; try later`); process.exit(2); }
const pick = resolvePick(MODEL);
if (!pick || !isCached(REAL_HOME, pick)) { console.error(`${MODEL} is not downloaded in ${REAL_HOME}`); process.exit(2); }

// The build: installed once in the real home (download, SHA-256, unpack), then copied to the two homes.
const key = platformKey({ os: process.platform, arch: process.arch, gpu: null }, 'cpu');
const t0 = Date.now();
await installBuild(REAL_HOME, key, { consented: true });
console.log(`llama.cpp ${key} ready in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hivedesk-pool-'));
const homeA = path.join(root, 'lender-home');
const homeB = path.join(root, 'borrower-home');
for (const h of [homeA, homeB]) fs.cpSync(buildDir(REAL_HOME, key), buildDir(h, key), { recursive: true });
fs.mkdirSync(path.join(homeB, 'models'), { recursive: true });
fs.linkSync(modelPath(REAL_HOME, pick), modelPath(homeB, pick));

const quiet = { log: () => {}, city: false, memoryHome: null };
const A = await startHive({ dir: path.join(root, 'a'), home: homeA, flags: { brain: 'local', noDownload: true }, ...quiet });
const B = await startHive({ dir: path.join(root, 'b'), home: homeB, flags: { brain: 'local', noDownload: true }, ...quiet });

/** A WebSocket client of one engine: commands, and the pool frames it pushes. */
async function client(app) {
  const ws = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws?t=${app.server.token}`);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0;
  const waiting = new Map();
  const c = { ws, onPool: null, sent: 0 };
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.kind === 'reply' && waiting.has(msg.id)) { const w = waiting.get(msg.id); waiting.delete(msg.id); msg.ok ? w.res(msg.result) : w.rej(Object.assign(new Error(msg.error.message), { code: msg.error.code })); }
    else if (msg.kind === 'pool') c.onPool?.(msg.frame);
  };
  c.cmd = (type, data = {}) => new Promise((res, rej) => { const id = `q${++seq}`; waiting.set(id, { res, rej }); ws.send(JSON.stringify({ kind: 'command', id, type, data })); });
  c.frame = (f) => { c.sent++; ws.send(JSON.stringify({ kind: 'command', id: `f${++seq}`, type: 'pool.frame', data: f })); };
  return c;
}

const ca = await client(A);
const cb = await client(B);
// The relay: what one engine sends goes to the other, as the two browsers would over the peer channel.
ca.onPool = (f) => cb.frame(f);
cb.onPool = (f) => ca.frame(f);

try {
  // Off by default, and no lease without a share and the allowlist.
  const before = await ca.cmd('pool.share.get');
  check(before.share.gpu.enabled === false && before.share.cpu.enabled === false && before.experimental === false, 'sharing and the experimental flag are off by default');
  check((await ca.cmd('pool.lend.request', { peerId: 'peer-b', kind: 'cpu' })).refused === 'sharing_off', 'no lease while CPU sharing is off');
  await ca.cmd('pool.share.set', { share: { cpu: { enabled: true, maxThreads: 2, maxRamBytes: 2e9, maxMinutes: 10, maxJobs: 1 } }, peers: ['peer-b'] });
  check((await ca.cmd('pool.lend.request', { peerId: 'stranger', kind: 'cpu' })).refused === 'not_granted', 'a peer off the allowlist is refused');
  check((await ca.cmd('pool.lend.request', { peerId: 'peer-b', kind: 'gpu' })).refused === 'sharing_off', 'the GPU share is separate and still off');
  const { lease } = await ca.cmd('pool.lend.request', { peerId: 'peer-b', kind: 'cpu', minutes: 10 });
  check(!!lease && lease.limits.threads === 2, `a CPU lease with limits (${lease?.id})`);
  check((await ca.cmd('pool.lend.request', { peerId: 'peer-b', kind: 'cpu' })).refused === 'busy', 'one concurrent CPU job at most');
  await ca.cmd('pool.lend.start', { leaseId: lease.id });
  check(true, 'rpc-server started on the lender, on 127.0.0.1 only');

  // The borrower: experimental flag, then the session through the tunnel.
  await cb.cmd('pool.session.start', { id: MODEL, ctx: 2048, leases: [{ lease: lease.id, peerId: 'peer-a', bytes: 2e9 }] }).then(
    () => check(false, 'the session must refuse while the flag is off'), (e) => check(e.code === 'conflict', 'no pooled session while the experimental flag is off'));
  await cb.cmd('pool.flag.set', { on: true });
  const t1 = Date.now();
  const s = await cb.cmd('pool.session.start', { id: MODEL, ctx: 2048, leases: [{ lease: lease.id, peerId: 'peer-a', bytes: 2e9 }] });
  const loadS = (Date.now() - t1) / 1000;
  check(s.workers === 1, `the pooled model loaded through the tunnel in ${loadS.toFixed(1)} s (${(ca.sent + cb.sent)} frames)`);

  // A real turn on the borrower's scheduler, computed by the lender's rpc-server.
  const t2 = Date.now();
  const r = await B.scheduler.turn({ workerId: 'dev', messages: [{ role: 'user', content: 'Write one short sentence about bread.' }], options: { maxTokens: 40, temperature: 0 } });
  const ms = Date.now() - t2;
  check(typeof r.text === 'string' && r.text.trim().length > 0, `a turn answered: "${String(r.text).trim().slice(0, 60)}" (${r.completionTokens} tokens in ${(ms / 1000).toFixed(1)} s)`);
  check(r.remote?.label?.includes('Pooled'), 'the answer is marked remote (its tool calls wait for the host)');

  // Real cancel: the turn stops, the session stays.
  const ctrl = new AbortController();
  const p = B.scheduler.turn({ workerId: 'dev', messages: [{ role: 'user', content: 'Count from 1 to 500, one number per line.' }], options: { maxTokens: 1500 }, signal: ctrl.signal });
  setTimeout(() => ctrl.abort(), 1500);
  const tc = Date.now();
  await p.then(() => check(false, 'the cancelled turn must not finish'), () => check(Date.now() - tc < 10_000, `cancel stopped the turn in ${((Date.now() - tc) / 1000).toFixed(1)} s`));
  const again = await B.scheduler.turn({ workerId: 'dev', messages: [{ role: 'user', content: 'Say OK.' }], options: { maxTokens: 8 } });
  check(again.text.length > 0, 'the session still answers after a cancel');

  // Revoke on the lender: rpc-server is killed, the borrower's next turn fails.
  await ca.cmd('pool.lend.revoke', { leaseId: lease.id });
  const ended = A.bus.events.find((e) => e.type === 'pool.lend.ended');
  check(ended?.data.why === 'revoked', 'revoke ends the lease and kills rpc-server');
  const after = await B.scheduler.turn({ workerId: 'dev', messages: [{ role: 'user', content: 'Say OK.' }], options: { maxTokens: 8 } }).then(() => 'answered', () => 'failed');
  check(after === 'failed', 'after a revoke the pooled model no longer answers');
  await cb.cmd('pool.session.stop');
} catch (err) {
  check(false, String(err.stack || err.message || err));
} finally {
  ca.ws.close();
  cb.ws.close();
  await A.close();
  await B.close();
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* a process may still hold a file */ }
}
process.exit(failures.length ? 1 : 0);
