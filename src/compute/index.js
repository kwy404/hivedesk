// The compute plane plug-in (PLAN sections 6, 7, 8 and 10). Stream 1's engine calls register(ctx) at start.
// It owns: the resource probe and its throttled events, ShareSettings (reloaded when `hivedesk share` writes
// them), the job worker, the requester brain and the resource scheduler.
//
// ctx: {
//   bus, scheduler,                      the event bus and the crew scheduler (src/crew/scheduler.js)
//   server: { command, route },          engine commands; only local token holders reach them (Stream 1 router)
//   home,                                ~/.hivedesk
//   link?,                               the p2p ComputeLink from Stream 2 (src/compute/worker.js typedef); without it
//                                        the plane runs local only and says so
//   viewers?: () => number,              windows open now (2 s sampling while one is open, 15 s otherwise)
//   probe?, now?                         for tests
// }
import fs from 'node:fs';
import path from 'node:path';
import { CAPABILITY } from './types.js';
import { ResourceProbe, significantChange } from './probe.js';
import { loadShare, saveShare, patchShare, describeShare, insideHours, settingsFile, defaultShare } from './share.js';
import { ComputeWorker, servesPeers } from './worker.js';
import { Requester } from './requester.js';
import { ResourceScheduler } from './scheduler.js';
import { JobLog } from './jobs-log.js';
import { readAdvert } from './wire.js';
import { modelVram, promptTokensOf } from './estimate.js';

export const FAST_MS = 2000;
export const SLOW_MS = 15000;
const WATCH_MS = 30_000;
const CHANGED_MIN_MS = 10_000;
const SHARE_POLL_MS = 5000;

class CommandFail extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/** The loaded local brain as the scheduler and the worker see it, or null. */
export function localServing(scheduler, resource) {
  for (const [brainId, slot] of scheduler?.brains || []) {
    const b = slot.brain;
    if (!servesPeers(b)) continue;
    const info = b.info?.() || {};
    const gpus = resource?.gpus || [];
    let device;
    let gpuIndex;
    if (info.backend === 'local') {
      device = !info.gpu || info.gpu === 'cpu' ? 'cpu' : 'gpu';
      if (device === 'gpu') {
        const vendor = info.gpu === 'cuda' ? 'nvidia' : info.gpu === 'metal' ? 'apple' : null;
        const i = gpus.findIndex((g) => (vendor ? g.vendor === vendor : !g.integrated));
        gpuIndex = i === -1 ? 0 : i;
      }
    } else {
      // Ollama, LM Studio or a local endpoint choose their own device: the discrete GPU when there is one.
      const i = gpus.findIndex((g) => !g.integrated);
      device = i === -1 ? 'cpu' : 'gpu';
      gpuIndex = i === -1 ? undefined : i;
    }
    const bytes = Number.isFinite(info.fileBytes) ? info.fileBytes : undefined;
    return {
      // modelId: the catalog id when the brain knows it (the rotation brain), so the allowlist and the adverts match.
      brainId, model: info.modelId || info.model || brainId, device, gpuIndex, bytes, backend: info.backend,
      vramBytes: device === 'gpu' ? (bytes ? Math.round(bytes * 1.05 + (info.contextVram || 0)) : modelVram(info.model || '', info.contextSize || 4096)) : 0,
      threads: typeof b.threads === 'function' ? b.threads() : null,
      limitThreads: typeof b.limitThreads === 'function' ? (n) => b.limitThreads(n) : null,
      vramState: typeof b.vramState === 'function' ? () => b.vramState() : null
    };
  }
  return null;
}

const COMPUTE_BRAIN = 'compute';

export default function register(ctx) {
  const { bus, scheduler, server, home } = ctx;
  const link = ctx.link || null;
  const now = ctx.now || Date.now;
  const probe = ctx.probe || new ResourceProbe();
  const jobLog = new JobLog(home ? path.join(home, 'jobs') : null);
  const resources = new ResourceScheduler({ now });
  let share = home ? loadShare(home) : defaultShare();
  let resource = null;
  let lastLogged = null;
  let lastLoggedAt = 0;
  let watchUntil = 0;
  let timer = null;
  let shareTimer = null;
  let shareMtime = null;   // null: not looked yet; -1: no file
  let closed = false;

  const serving = () => localServing(scheduler, resource);
  const queue = () => {
    const q = scheduler?.queueState?.() || { running: [], waiting: [] };
    return { running: q.running.filter((r) => r.lane !== 'peer').length, waiting: q.waiting.filter((w) => w.lane !== 'peer').length };
  };

  const worker = link ? new ComputeWorker({
    link, bus, jobLog, now,
    getShare: () => share,
    getResource: () => resource,
    serving,
    runTurn: (req) => scheduler.turn(req)
  }) : null;

  const requester = new Requester({
    link, resources, bus, jobLog, now,
    localState: () => {
      const s = serving();
      return { resource, brain: s ? { device: s.device, gpuIndex: s.gpuIndex, model: s.model, bytes: s.bytes } : null, queue: queue() };
    },
    runLocal: (req) => scheduler.turn({ ...req, eligible: (id, b) => id !== COMPUTE_BRAIN && servesPeers(b) })
  });
  /**
   * A brain whose turns run only on one peer, as compute.inference jobs it granted this engine
   * (the agents a friend brings to the City think on the friend's machine). Without a grant the
   * jobs wait for a resource and fail with the reason, which is the honest state.
   */
  const peerBrains = new Map(); // peerId -> brain id
  function peerBrainId(peerId) {
    if (!link || !scheduler || typeof peerId !== 'string' || !/^hd1[a-z2-7]{49}$/.test(peerId)) return null;
    let id = peerBrains.get(peerId);
    if (id && scheduler.brains.has(id)) return id;
    id = `compute:${peerId.slice(3, 13)}`;
    const base = requester.brain(id);
    const name = link.peers().find((p) => p.peerId === peerId)?.name;
    scheduler.addBrain({ ...base, label: name ? `${String(name).slice(0, 40)} (compute)` : 'Friend compute', chat: (messages, options = {}) => requester.chat(messages, { ...options, onlyPeer: peerId }) });
    peerBrains.set(peerId, id);
    return id;
  }

  /** The compute brain joins the crew's pool only while some peer lets this engine use it. */
  function syncComputeBrain() {
    if (!link || !scheduler) return;
    const usable = link.peers().some((p) => p.online && !p.blocked && link.holdsGrant(p.peerId, CAPABILITY));
    const has = scheduler.brains.has(COMPUTE_BRAIN);
    if (usable && !has) scheduler.addBrain(requester.brain(COMPUTE_BRAIN));
    else if (!usable && has) scheduler.removeBrain(COMPUTE_BRAIN, 'no peer shares compute with you now');
  }

  function advertBody() {
    const s = serving();
    const busy = worker?.busy() || { jobs: 0 };
    const q = queue();
    return {
      sampledAt: resource?.sampledAt || now(),
      cpu: resource?.cpu || null, ram: resource?.ram || null,
      gpus: (resource?.gpus || []).map((g) => ({ index: g.index, name: g.name, vendor: g.vendor, vramTotalBytes: g.vramTotalBytes, vramFreeBytes: g.vramFreeBytes, utilPct: g.utilPct, source: g.source })),
      models: s ? [{ id: s.model, bytes: s.bytes || 0, loaded: true }] : [],
      serving: s ? { model: s.model, device: s.device, gpuIndex: s.gpuIndex ?? 0, vramBytes: s.vramBytes, ...(s.bytes ? { bytes: s.bytes } : {}) } : null,
      share: { gpu: share.gpu, cpu: { enabled: share.cpu.enabled, maxThreads: share.cpu.maxThreads, maxRamBytes: share.cpu.maxRamBytes }, maxTokensPerJob: share.maxTokensPerJob, modelAllowlist: share.modelAllowlist },
      insideHours: insideHours(share, new Date(now())),
      busy: { jobs: busy.jobs, turns: q.running + q.waiting }
    };
  }

  function sendAdverts() {
    if (!link) return;
    const body = advertBody();
    for (const p of link.peers()) {
      if (p.online && !p.blocked && link.hasGrant(p.peerId, CAPABILITY)) {
        try { link.send(p.peerId, 'resource.advert', body); } catch { /* closed */ }
      }
    }
  }

  async function tick() {
    timer = null;
    if (closed) return;
    try {
      const s = serving();
      if (s?.vramState) probe.setRuntime(s.vramState, s.device === 'gpu' ? s.gpuIndex : null);
      resource = await probe.sample();
      if (closed) return;
      const full = { machine: 'local', ...resource, share, serving: s ? { model: s.model, device: s.device, gpuIndex: s.gpuIndex } : null, busy: { jobs: worker?.busy().jobs || 0, turns: queue().running + queue().waiting } };
      bus?.live('resources.sample', full);
      if (significantChange(lastLogged, resource) && now() - lastLoggedAt >= CHANGED_MIN_MS) {
        lastLogged = resource;
        lastLoggedAt = now();
        bus?.emit('resources.changed', {
          cpu: { model: resource.cpu.model, cores: resource.cpu.cores, threads: resource.cpu.threads, avx2: resource.cpu.avx2 },
          ram: resource.ram,
          gpus: resource.gpus.map((g) => ({ index: g.index, name: g.name, vendor: g.vendor, vramTotalBytes: g.vramTotalBytes, vramFreeBytes: g.vramFreeBytes, source: g.source }))
        });
      }
      sendAdverts();
      requester.resourcesChanged();
    } catch { /* the next tick tries again */ }
    schedule();
  }

  function schedule() {
    if (closed || timer) return;
    const fast = now() < watchUntil || (ctx.viewers?.() || 0) > 0;
    timer = setTimeout(tick, fast ? FAST_MS : SLOW_MS);
    timer.unref?.();
  }

  function setShare(next, why = 'changed') {
    share = next;
    worker?.applyShare(share);
    bus?.emit('share.changed', { share, why });
    sendAdverts();
  }

  /** `hivedesk share` in another terminal writes settings.json; a running engine picks it up. */
  function pollShare() {
    shareTimer = null;
    if (closed || !home) return;
    let m = -1;
    try { m = fs.statSync(settingsFile(home)).mtimeMs; } catch { /* no file yet */ }
    if (m !== shareMtime) {
      const first = shareMtime === null;
      shareMtime = m;
      if (!first) setShare(loadShare(home), 'settings file');
    }
    shareTimer = setTimeout(pollShare, ctx.sharePollMs || SHARE_POLL_MS);
    shareTimer.unref?.();
  }

  const offs = [];
  if (link) {
    offs.push(link.onMessage((peerId, type, body) => {
      if (type !== 'resource.advert') return;
      try {
        const ad = readAdvert(body);
        resources.advert(peerId, ad);
        const name = link.peers().find((p) => p.peerId === peerId)?.name || 'a peer';
        bus?.live('resources.peer', { peerId, name, reportedBy: name, ...ad });
        requester.resourcesChanged();
      } catch { /* dropped */ }
    }));
    offs.push(link.onPeer((ev) => {
      syncComputeBrain();
      if (ev?.type === 'online') sendAdverts();
    }));
  }

  const cmd = (type, fn) => server?.command?.(type, fn);
  cmd('compute.share.get', () => ({ share, lines: describeShare(share) }));
  cmd('compute.share.set', (d) => {
    const next = patchShare(share, d?.change ?? d);
    const saved = home ? saveShare(home, next) : next;
    try { shareMtime = fs.statSync(settingsFile(home)).mtimeMs; } catch { /* none */ }
    setShare(saved, 'window');
    return { share: saved, lines: describeShare(saved) };
  });
  cmd('compute.resources', () => {
    // The Machines panel asks every few seconds while it is open: sample fast for the next 30 s.
    const wasSlow = now() >= watchUntil;
    watchUntil = now() + WATCH_MS;
    if (wasSlow && timer) { clearTimeout(timer); timer = null; schedule(); }
    const peers = link ? link.peers().map((p) => ({ peerId: p.peerId, name: p.name, online: p.online, advert: resources.adverts.get(p.peerId) || null, reportedBy: p.name })) : [];
    const s = serving();
    return { local: resource ? { machine: 'local', ...resource, share, serving: s ? { model: s.model, device: s.device, gpuIndex: s.gpuIndex } : null, busy: { jobs: worker?.busy().jobs || 0 } } : null, peers, p2p: !!link };
  });
  cmd('compute.decide', (d) => {
    const messages = [{ role: 'user', content: String(d?.prompt ?? '').slice(0, 120000) || 'x'.repeat(Math.max(1, Number(d?.promptChars) || 400)) }];
    const decision = requester._decide({ input: { model: String(d?.model || 'any-allowed'), messages, maxTokens: Math.max(1, Math.min(8192, Number(d?.maxTokens) || 1024)) }, priority: ['interactive', 'normal', 'background'].includes(d?.priority) ? d.priority : 'normal' });
    return { decision, promptTokens: promptTokensOf(messages) };
  });
  cmd('compute.jobs', () => ({ jobs: requester.list(), serving: worker ? [...worker.jobs.values()].map((j) => ({ jobId: j.id, peerId: j.requester, model: j.model, device: j.device, lease: { id: j.lease.id, expiresAt: j.lease.expiresAt, hardDeadline: j.lease.hardDeadline, limits: j.lease.limits }, tokens: j.tokens })) : [], recent: jobLog.recent(30) }));
  cmd('compute.job.choose', (d) => requester.choose(String(d?.jobId || ''), String(d?.choice || '')));
  cmd('compute.job.cancel', (d) => ({ ok: requester.cancel(String(d?.jobId || '')) }));
  cmd('compute.job.stop', (d) => {
    if (!worker) throw new CommandFail('not_available', 'peer to peer is not available in this build, so no peer jobs run here');
    if (d?.all) return { stopped: worker.revokeAll('stopped by the owner') };
    return { stopped: worker.revoke(String(d?.jobId || ''), 'stopped by the owner') ? 1 : 0 };
  });
  server?.route?.('GET', '/api/compute/resources', (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ local: resource, share, p2p: !!link }));
  });

  tick();
  pollShare();
  syncComputeBrain();

  return {
    probe, resources, requester, worker, jobLog, peerBrainId,
    get share() { return share; },
    get resource() { return resource; },
    setShare,
    sample: tick,
    close() {
      closed = true;
      clearTimeout(timer);
      clearTimeout(shareTimer);
      for (const off of offs) try { off?.(); } catch { /* ignore */ }
      worker?.close();
      requester.close();
      probe.close?.();
      if (scheduler?.brains?.has(COMPUTE_BRAIN)) scheduler.removeBrain(COMPUTE_BRAIN, 'shutdown');
      for (const id of peerBrains.values()) if (scheduler?.brains?.has(id)) scheduler.removeBrain(id, 'shutdown');
    }
  };
}
