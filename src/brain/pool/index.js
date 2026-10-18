// Pooled giant models over llama.cpp RPC (experimental, off by default): the engine commands.
//
// The engines do not talk to each other directly. Each engine speaks to its own browser over its
// authenticated WebSocket, and the browsers carry the tunnel frames over the paired peer channel:
//   lender engine  <-WS->  lender browser  <-peer channel->  borrower browser  <-WS->  borrower engine
// Tunnel frames leave an engine as { kind: 'pool', frame } on the WebSocket of the client that opened
// the tunnel, and come in as the command pool.frame. A relay is anything that forwards them; the test
// relay (test/pool/e2e-pool.mjs) joins two engines on one PC.
//
// Lender commands (the person at the lender PC, never a guest: the 0.2.1 policy does not list them):
//   pool.share.get / pool.share.set { share, peers }     GPU and CPU shares with limits, the allowlist
//   pool.lend.request { peerId, kind, minutes }          a lease, or a refusal code
//   pool.lend.start   { leaseId }                         starts rpc-server, opens the dial end of the tunnel
//   pool.lend.revoke  { leaseId } / pool.lend.stop        ends leases now (kills rpc-server)
// Borrower commands:
//   pool.flag.set { on }                                  the experimental flag (off by default)
//   pool.session.start { id, ctx, leases: [{ lease, peerId, bytes }] }   opens the listen ends, starts llama-server
//   pool.session.stop
// Both:
//   pool.build.status { kind } / pool.build.install { kind, yes: true }   the pinned llama.cpp build, with consent
//   pool.frame { lease, k, ch, ... }                      a tunnel frame from the relay
import fs from 'node:fs';
import path from 'node:path';
import { RpcLender, LendError } from './lender.js';
import { ListenEnd, DialEnd } from './tunnel.js';
import { PooledSession } from './session.js';
import { RELEASE, platformKey, installed, installBuild } from './release.js';
import { resolvePick } from '../catalog/index.js';
import { modelPath, isCached } from '../models.js';
import { poolMeter } from '../catalog/pool.js';
import { createPoolLink } from './p2p.js';

export function registerPoolCommands(command, ctx) {
  const { bus, scheduler, CommandError } = ctx;
  const home = ctx.home;
  const hw = () => ctx.brains?.hardware || ctx.hardware || {};
  /** The hardware, detected now when the engine has not done it yet (the share limits are clamped to it). */
  const freshHw = async () => { if (!ctx.brains?.hardware && ctx.brains?.hw) await ctx.brains.hw(); lender.hw = hw(); return lender.hw; };
  const flagFile = home ? path.join(home, 'pool', 'flag.json') : null;
  let flag = false;
  try { flag = flagFile ? JSON.parse(fs.readFileSync(flagFile, 'utf8')).experimental === true : false; } catch { flag = false; }
  const binaries = async (kind) => installed(home, platformKey(hw(), kind));
  const lender = new RpcLender({ home, hw: hw(), bus, binaries, log: ctx.log });
  /** lease id -> { end, client } */
  const tunnels = new Map();
  let session = null;

  const err = (e) => (e instanceof CommandError ? e : new CommandError(e.code && /^[a-z_]+$/.test(e.code) ? (['not_found', 'conflict', 'bad_request', 'forbidden'].includes(e.code) ? e.code : 'conflict') : 'internal', String(e.message || e)));
  const wrap = (fn) => async (d, client) => { try { return await fn(d || {}, client); } catch (e) { throw err(e); } };
  const sendTo = (client) => (frame) => { if (!client?.conn?.sendJson({ kind: 'pool', frame })) throw new Error('the relay went away'); };

  command('pool.share.get', wrap(() => ({ ...lender.settings(), experimental: flag, build: RELEASE.tag })));
  command('pool.share.set', wrap(async (d) => { await freshHw(); return lender.configure({ share: d.share, peers: d.peers }); }));
  command('pool.lend.request', wrap(async (d) => {
    await freshHw();
    try { return { lease: lender.lease({ peerId: d.peerId, kind: d.kind, minutes: d.minutes }) }; } catch (e) {
      if (e instanceof LendError) return { refused: e.code, message: e.message };
      throw e;
    }
  }));
  command('pool.lend.start', wrap(async (d, client) => {
    if (!client) throw new CommandError('bad_request', 'pool.lend.start needs the WebSocket of the relay');
    const { port } = await lender.start(String(d.leaseId || ''));
    const end = new DialEnd({ lease: String(d.leaseId), port, send: sendTo(client) });
    tunnels.set(end.lease, { end, client });
    return { leaseId: end.lease, build: RELEASE.tag };
  }));
  command('pool.lend.revoke', wrap((d) => {
    const id = String(d.leaseId || '');
    tunnels.get(id)?.end.close();
    tunnels.delete(id);
    return { revoked: lender.revoke(id, 'revoked') };
  }));
  command('pool.lend.stop', wrap(() => {
    for (const [id, t] of tunnels) if (t.end instanceof DialEnd) { t.end.close(); tunnels.delete(id); }
    lender.stopAll('stopped');
    return lender.settings();
  }));
  command('pool.flag.set', wrap((d) => {
    flag = d.on === true;
    if (flagFile) { try { fs.mkdirSync(path.dirname(flagFile), { recursive: true }); fs.writeFileSync(flagFile, JSON.stringify({ experimental: flag })); } catch { /* read only */ } }
    if (!flag && session) stopSession('the experimental flag was turned off');
    bus.emit('pool.flag', { experimental: flag });
    return { experimental: flag };
  }));
  command('pool.build.status', wrap((d) => {
    const key = platformKey(hw(), d.kind === 'cpu' ? 'cpu' : 'gpu');
    const files = RELEASE.platforms[key] || [];
    return { tag: RELEASE.tag, key, installed: !!installed(home, key), bytes: files.reduce((n, f) => n + f.bytes, 0), files: files.map((f) => ({ name: f.name, bytes: f.bytes })), source: RELEASE.source, license: RELEASE.license };
  }));
  command('pool.build.install', wrap(async (d) => {
    if (d.yes !== true) throw new CommandError('bad_request', 'pool.build.install needs yes: true from the user');
    const key = platformKey(hw(), d.kind === 'cpu' ? 'cpu' : 'gpu');
    bus.emit('pool.build.installing', { tag: RELEASE.tag, key });
    const r = await installBuild(home, key, { consented: true, onProgress: (p) => bus.live('pool.build.progress', { key, ...p }) });
    bus.emit('pool.build.installed', { tag: r.tag, key });
    return { tag: r.tag, key, installed: true };
  }));
  command('pool.session.start', wrap(async (d, client) => {
    if (!flag) throw new CommandError('conflict', 'pooled models are experimental and off: turn them on first');
    if (!client) throw new CommandError('bad_request', 'pool.session.start needs the WebSocket of the relay');
    if (session) throw new CommandError('conflict', 'a pooled model is already running');
    const p = resolvePick(String(d.id || ''));
    if (!p) throw new CommandError('not_found', 'no such model in the catalog');
    if (!isCached(home, p)) throw new CommandError('conflict', `${p.name} is not downloaded`);
    const bins = await binaries('gpu') || await binaries('cpu');
    if (!bins?.server) throw new CommandError('conflict', 'llama.cpp is not installed on this PC');
    const leases = Array.isArray(d.leases) ? d.leases.filter((l) => typeof l?.lease === 'string').slice(0, 8) : [];
    if (!leases.length) throw new CommandError('bad_request', 'a pooled model needs at least one lender lease');
    const ends = [];
    for (const l of leases) {
      const end = new ListenEnd({ lease: l.lease, send: sendTo(client) });
      tunnels.set(end.lease, { end, client });
      ends.push({ end, port: await end.listen(), bytes: Number(l.bytes) || 0 });
    }
    const total = ends.reduce((n, e) => n + e.bytes, 0);
    const split = total > 0 ? ends.map((e) => e.bytes / total) : undefined;
    const ctxSize = Number(d.ctx) || 4096;
    const meter = poolMeter(p, ctxSize, hw(), []);
    session = new PooledSession({ server: bins.server, model: modelPath(home, p), name: p.name, rpcPorts: ends.map((e) => e.port), ctx: ctxSize, split, bus, log: ctx.log, loadTimeoutMs: Number(d.loadTimeoutMs) || undefined });
    session.ends = ends.map((e) => e.end);
    bus.emit('pool.session.loading', { id: p.id, workers: ends.length, need: meter.need });
    try {
      const brain = await session.start();
      scheduler.addBrain(brain);
      return { id: p.id, brainId: brain.id, workers: ends.length, experimental: true };
    } catch (e) {
      stopSession(String(e.message || e));
      throw e;
    }
  }));
  function stopSession(why) {
    if (!session) return false;
    const s = session;
    session = null;
    if (s.brain) scheduler.removeBrain(s.brain.id, why);
    s.stop();
    for (const e of s.ends || []) { e.close(); tunnels.delete(e.lease); }
    bus.emit('pool.session.stopped', { why });
    return true;
  }
  command('pool.session.stop', wrap(() => ({ stopped: stopSession('stopped') })));
  command('pool.frame', wrap((d) => {
    const t = tunnels.get(String(d.lease || ''));
    if (!t) return { ok: false };
    return { ok: t.end.receive(d) };
  }));

  // ---- between friends' PCs over the 1.0 p2p plane (src/p2p/pool-port.js, ./p2p.js) ----
  let link = null;
  /** Called by the engine once its p2p node exists. */
  function attachP2P(port) {
    if (link || !port) return link;
    link = createPoolLink({ port, lender, bus, scheduler, freshHw, flag: () => flag, binaries, log: ctx.log });
    return link;
  }
  const needLink = () => { if (!link) throw new CommandError('conflict', 'pooling between PCs needs the p2p plane'); return link; };
  /** The meter with the friends who granted pooling (or none), and whether it can really run now. */
  async function meterFor(p, ctxSize) {
    const h = await freshHw();
    const meter = link ? link.meter(p, ctxSize, h) : poolMeter(p, ctxSize, h, []);
    const build = !!(await binaries('gpu')) || !!(await binaries('cpu'));
    const model = isCached(home, p);
    const runnable = !!link && flag && meter.unlocked && build && model;
    return { ...meter, runnable, execution: flag ? 'experimental' : 'off', needs: runnable ? [] : [!flag ? 'flag' : null, !build ? 'build' : null, !model ? 'model' : null, !meter.unlocked ? 'peers' : null].filter(Boolean) };
  }
  command('pool.p2p.start', wrap(async (d) => {
    const l = needLink();
    const p = resolvePick(String(d.id || ''));
    if (!p) throw new CommandError('not_found', 'no such model in the catalog');
    if (!isCached(home, p)) throw new CommandError('conflict', `${p.name} is not downloaded`);
    const ctxSize = Number(d.ctx) || 4096;
    let peers = Array.isArray(d.peers) ? d.peers.filter((x) => typeof x?.peerId === 'string' && (x.kind === 'gpu' || x.kind === 'cpu')).slice(0, 8) : null;
    let localShare = Number.isFinite(d.localShare) ? Math.min(0.9, Math.max(0, d.localShare)) : undefined;
    if (!peers) {
      // The meter's plan: which friend holds how many bytes of the weights, and what stays here.
      const m = await meterFor(p, ctxSize);
      if (!m.unlocked) throw new CommandError('conflict', 'the friends who granted pooling do not have enough memory for this model');
      peers = m.plan.filter((x) => x.who !== 'me').map((x) => ({ peerId: x.who, kind: x.kind, bytes: x.bytes }));
      const mine = m.plan.filter((x) => x.who === 'me').reduce((n, x) => n + x.bytes, 0);
      if (localShare === undefined) localShare = p.bytes ? mine / p.bytes : 0;
    }
    if (!peers.length) throw new CommandError('bad_request', 'a pooled model needs at least one friend');
    for (const x of peers) if (!x.bytes) x.bytes = Math.round(p.bytes / peers.length);
    return l.start({ pick: p, modelFile: modelPath(home, p), ctx: ctxSize, peers, localShare: localShare || undefined, loadTimeoutMs: Number(d.loadTimeoutMs) || undefined });
  }));
  command('pool.p2p.stop', wrap(() => ({ stopped: needLink().stop('stopped') })));
  command('pool.p2p.status', wrap(() => ({ attached: !!link, experimental: flag, ...(link ? link.leases() : { lent: [], borrowed: [] }), running: !!link?.session })));
  if (ctx.brains) ctx.brains.pool = { meterFor, get link() { return link; } };

  return {
    lender,
    attachP2P,
    meterFor,
    get link() { return link; },
    get session() { return session; },
    clientGone(client) {
      for (const [id, t] of tunnels) {
        if (t.client !== client) continue;
        t.end.close();
        tunnels.delete(id);
        if (t.end instanceof DialEnd) lender.revoke(id, 'disconnected');
      }
      if (session && session.ends?.some((e) => e.closed)) stopSession('the relay disconnected');
    },
    close() { link?.close(); stopSession('shutdown'); lender.stopAll('shutdown'); }
  };
}
