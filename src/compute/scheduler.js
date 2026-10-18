// The resource scheduler (PLAN section 7): where a job runs, across the local GPUs, the local CPU and
// every peer that granted this engine compute.inference, with a reason people can read.
// `decide()` is pure and table tested; `ResourceScheduler` only keeps the numbers it is fed.
import { TIMES, VRAM_RESERVE } from './types.js';
import { kvCache, modelVram, modelBytes, modelLabel, sameModel, promptTokensOf, SpeedTable, fmtGB, fmtSeconds } from './estimate.js';

const RAM_RESERVE = 2 * 1024 ** 3;
/** Rough wait per turn ahead in a queue, until a measured average exists. */
const SEED_TURN_MS = 8000;
const PRIORITY_FACTOR = { interactive: 1, normal: 1, background: 1 };

/**
 * @typedef {Object} LocalState
 * @property {any} resource                     the probe sample (ResourceProbe.sample)
 * @property {null | { device: 'gpu'|'cpu', gpuIndex?: number, model: string, bytes?: number, threads?: number }} brain  the loaded local model
 * @property {{ waiting: number, running: number, avgTurnMs?: number }} [queue]
 *
 * @typedef {Object} PeerState
 * @property {string} peerId
 * @property {string} name
 * @property {boolean} online
 * @property {boolean} [blocked]
 * @property {number} [rttMs]
 * @property {boolean} granted                  holds a valid, unexpired compute.inference grant from that peer
 * @property {boolean} [revoked]                the peer revoked one of our jobs in this session
 * @property {any} [advert]                     its last resource.advert, with receivedAt
 *
 * @typedef {Object} DecideInput
 * @property {{ input: { model: string, messages: any[], maxTokens: number }, priority?: string, deadlineMs?: number, onlyLocal?: boolean, exclude?: string[] }} job
 * @property {LocalState} local
 * @property {PeerState[]} peers
 * @property {Record<string, { failures: number, total: number, unhealthyUntil?: number }>} [outcomes]
 * @property {SpeedTable} [speeds]
 * @property {number} now
 */

const ANY = 'any-allowed';
const wants = (job, model) => job.input.model === ANY || !job.input.model || sameModel(job.input.model, model);

function estimate({ speeds, key, model, device, promptTokens, maxTokens, waitMs = 0, rttMs = 0 }) {
  const sp = (speeds || new SpeedTable()).get(key, model, device);
  return Math.round(waitMs + (promptTokens / sp.pp) * 1000 + ((maxTokens * 0.6) / sp.tg) * 1000 + 2 * rttMs);
}

function where(c) {
  if (c.peer) return `${c.peer.name}, ${c.device === 'gpu' ? 'GPU' : 'CPU'}`;
  if (c.device === 'gpu') return c.multi ? `Your ${c.gpu?.name || 'GPU'}` : 'Your GPU';
  return 'Your CPU';
}

/** Which rejected candidate explains the choice best: a real limit first, a plain "not loaded there" last. */
const REJECT_RANK = { vram: 0, ram: 1, too_long: 2, busy: 3, outside_hours: 4, sharing_off: 5, model_not_allowed: 6, model_missing: 7, not_granted: 8 };

/** Candidates with hard filters applied. Each has key, kind, device, ok, code, detail, estimateMs, plus facts for the reason. */
export function candidates(input) {
  const { job, local, peers = [], speeds, now } = input;
  const promptTokens = promptTokensOf(job.input.messages);
  const maxTokens = job.input.maxTokens || 1024;
  const tokens = promptTokens + maxTokens;
  const deadline = job.deadlineMs ?? Infinity;
  const exclude = new Set(job.exclude || []);
  const out = [];

  // ---- local GPUs and the local CPU ----
  const res = local?.resource;
  const brain = local?.brain || null;
  const q = local?.queue || { waiting: 0, running: 0 };
  const turnMs = q.avgTurnMs || SEED_TURN_MS;
  const localWait = q.waiting * turnMs + (q.running ? turnMs / 2 : 0);
  const gpus = res?.gpus || [];
  const localTargets = gpus.map((g, i) => ({ key: `local-gpu:${i}`, kind: 'local-gpu', device: 'gpu', gpuIndex: i, gpu: g, multi: gpus.length > 1 }));
  localTargets.push({ key: 'local-cpu', kind: 'local-cpu', device: 'cpu' });
  for (const t of localTargets) {
    const c = { ...t, local: true, ok: false };
    const model = brain?.model || (job.input.model !== ANY ? job.input.model : null);
    c.model = model;
    const hosts = brain && brain.device === t.device && (t.device === 'cpu' || (brain.gpuIndex ?? 0) === t.gpuIndex);
    if (model) c.estimateMs = estimate({ speeds, key: t.key, model, device: t.device, promptTokens, maxTokens, waitMs: localWait });
    if (t.device === 'gpu') {
      c.free = t.gpu.vramFreeBytes;
      c.total = t.gpu.vramTotalBytes;
      c.need = model ? (hosts ? kvCache(model, tokens) : modelVram(model, 4096, brain?.bytes)) : null;
    }
    if (exclude.has(t.key)) { c.code = 'busy'; c.detail = 'was just tried'; out.push(c); continue; }
    if (!brain) { c.code = 'model_missing'; c.detail = 'has no model loaded'; out.push(c); continue; }
    if (!hosts) {
      c.code = 'model_missing';
      if (t.device === 'gpu' && c.need != null && c.free != null && c.need > c.free - VRAM_RESERVE) {
        c.detail = `has ${fmtGB(c.free)} GB free and ${modelLabel(model)} needs ${fmtGB(c.need)} GB`;
        c.code = 'vram';
      } else {
        c.detail = brain.device === 'gpu' ? 'is not where your model is loaded (it runs on the GPU)' : 'is not where your model is loaded (it runs on the CPU)';
      }
      out.push(c);
      continue;
    }
    if (!wants(job, brain.model)) { c.code = 'model_missing'; c.detail = `runs ${modelLabel(brain.model)}, not ${modelLabel(job.input.model)}`; out.push(c); continue; }
    if (job.priority === 'background' && (q.running > 0 || q.waiting > 0)) { c.code = 'busy'; c.detail = 'is busy with your own work, and background jobs never displace it'; out.push(c); continue; }
    if (c.estimateMs > deadline) { c.code = 'too_long'; c.detail = `would take about ${fmtSeconds(c.estimateMs)}, over the deadline`; out.push(c); continue; }
    c.ok = true;
    out.push(c);
  }

  // ---- peers ----
  for (const p of peers) {
    if (!p.online) continue;
    const ad = p.advert;
    const devices = [];
    if (ad?.gpus?.length) ad.gpus.forEach((g, i) => devices.push({ device: 'gpu', gpuIndex: i, gpu: g }));
    devices.push({ device: 'cpu' });
    for (const d of devices) {
      const key = d.device === 'gpu' ? `peer-gpu:${p.peerId}:${d.gpuIndex}` : `peer-cpu:${p.peerId}`;
      const c = { key, kind: d.device === 'gpu' ? 'peer-gpu' : 'peer-cpu', device: d.device, gpuIndex: d.gpuIndex, peer: p, ok: false };
      const serving = ad?.serving || null;
      const model = serving?.model || (job.input.model !== ANY ? job.input.model : null);
      c.model = model;
      const hosts = serving && serving.device === d.device && (d.device === 'cpu' || (serving.gpuIndex ?? 0) === d.gpuIndex);
      const share = ad?.share;
      if (model) c.estimateMs = estimate({ speeds, key, model, device: d.device, promptTokens, maxTokens, rttMs: p.rttMs || 0, waitMs: ((ad?.busy?.turns || 0) + (ad?.busy?.jobs || 0)) * SEED_TURN_MS });
      if (d.device === 'gpu') { c.free = d.gpu.vramFreeBytes; c.total = d.gpu.vramTotalBytes; c.need = model ? kvCache(model, tokens) : null; }
      const reject = (code, detail) => { c.code = code; c.detail = detail; out.push(c); };
      if (exclude.has(key)) { reject('busy', 'was just tried'); continue; }
      if (job.onlyLocal) { reject('not_granted', 'is not used: this agent thinks only on its own machine'); continue; }
      if (p.blocked) { reject('not_granted', 'is blocked'); continue; }
      if (!p.granted) { reject('not_granted', 'has not granted you compute.inference'); continue; }
      if (p.revoked) { reject('not_granted', 'stopped one of your jobs in this session'); continue; }
      if (!ad || !(now - (ad.receivedAt ?? ad.sampledAt ?? 0) <= TIMES.advertMaxAgeMs)) { reject('sharing_off', 'has not reported its resources in the last 15 s'); continue; }
      if (d.device === 'gpu' && !(share?.gpu?.enabled && share?.gpu?.remoteInference)) { reject('sharing_off', 'does not share its GPU'); continue; }
      if (d.device === 'cpu' && !share?.cpu?.enabled) { reject('sharing_off', 'does not share its CPU'); continue; }
      if (ad.insideHours === false) { reject('outside_hours', 'is outside its sharing hours'); continue; }
      if (!serving) { reject('model_missing', 'has no model loaded'); continue; }
      if (!hosts) { reject('model_missing', `is not where its model runs (${serving.device === 'gpu' ? 'GPU' : 'CPU'})`); continue; }
      const allow = share.modelAllowlist || [];
      if (!allow.some((m) => sameModel(m, serving.model))) { reject('model_not_allowed', `does not allow ${modelLabel(serving.model)} for peers`); continue; }
      if (!wants(job, serving.model)) { reject('model_missing', `runs ${modelLabel(serving.model)}, not ${modelLabel(job.input.model)}`); continue; }
      const maxJobs = d.device === 'gpu' ? share.gpu.maxConcurrentJobs : 1;
      if ((ad.busy?.jobs || 0) >= maxJobs) { reject('busy', `runs ${ad.busy.jobs} peer job${ad.busy.jobs === 1 ? '' : 's'}, its limit`); continue; }
      if (d.device === 'gpu') {
        const held = serving.vramBytes ?? modelVram(serving.model, 4096, serving.bytes);
        if (share.gpu.maxVramBytes != null && held != null && held > share.gpu.maxVramBytes) { reject('vram', `lends at most ${fmtGB(share.gpu.maxVramBytes)} GB and ${modelLabel(serving.model)} holds ${fmtGB(held)} GB`); continue; }
        if (c.free != null && c.need > c.free - VRAM_RESERVE) { reject('vram', `has ${fmtGB(c.free)} GB free, too little for this job`); continue; }
      } else {
        const held = (modelBytes(serving.model, serving.bytes) || 0) + kvCache(serving.model, tokens);
        if (share.cpu.maxRamBytes != null && held > share.cpu.maxRamBytes) { reject('ram', `lends at most ${fmtGB(share.cpu.maxRamBytes)} GB of RAM and the job needs ${fmtGB(held)} GB`); continue; }
        const freeRam = ad.ram?.freeBytes;
        if (freeRam != null && kvCache(serving.model, tokens) > freeRam - RAM_RESERVE) { reject('ram', `has ${fmtGB(freeRam)} GB of RAM free, too little for this job`); continue; }
      }
      const limitMs = Math.min(deadline, (share.gpu?.maxJobSeconds ?? 120) * 1000);
      if (c.estimateMs > limitMs) { reject('too_long', `would take about ${fmtSeconds(c.estimateMs)}, over ${limitMs === deadline ? 'the deadline' : `its ${share.gpu.maxJobSeconds} s limit`}`); continue; }
      c.ok = true;
      out.push(c);
    }
  }
  return out;
}

function score(c, job, outcomes, now) {
  const o = outcomes?.[c.key];
  const failRate = o && o.total ? o.failures / o.total : 0;
  let s = c.estimateMs * (PRIORITY_FACTOR[job.priority] || 1) * (1 + 0.5 * failRate);
  if (c.local) s *= 0.85;
  if (o?.unhealthyUntil && o.unhealthyUntil > now) s *= 2;
  if (job.priority === 'background' && c.peer && (c.peer.advert?.busy?.jobs || c.peer.advert?.busy?.turns)) s *= 1.5;
  return Math.round(s);
}

function winnerSentence(c) {
  const label = modelLabel(c.model);
  const secs = `about ${fmtSeconds(c.estimateMs)}`;
  if (c.device === 'gpu') {
    if (c.free != null && c.total != null) return `${where(c)}: ${label} fits in ${fmtGB(c.free)} of ${fmtGB(c.total)} GB free, ${secs}.`;
    return `${where(c)}: ${label}, ${secs} (free VRAM not measured).`;
  }
  return `${where(c)}: ${label}, ${secs}.`;
}

function otherClause(c) {
  const name = c.peer ? `${c.peer.name} (${c.device === 'gpu' ? 'GPU' : 'CPU'})` : where(c).replace(/^Your/, 'your');
  if (c.ok) return `${name} would take about ${fmtSeconds(c.estimateMs)}`;
  return `${name} ${c.detail}`;
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * @param {DecideInput} input
 * @returns {import('./types.js').SchedulerDecision & { ok: boolean }}
 */
export function decide(input) {
  const { job, outcomes, now } = input;
  const list = candidates(input);
  for (const c of list) if (c.ok) c.score = score(c, job, outcomes, now);
  const ok = list.filter((c) => c.ok).sort((a, b) => a.score - b.score || (a.local === b.local ? 0 : a.local ? -1 : 1) || (a.peer?.rttMs ?? 0) - (b.peer?.rttMs ?? 0) || a.key.localeCompare(b.key));
  const summary = list.map((c) => ({ target: c.key, ok: c.ok, ...(c.code ? { code: c.code } : {}), ...(c.detail ? { detail: c.detail } : {}), ...(c.estimateMs != null ? { estimateMs: c.estimateMs } : {}), ...(c.score != null ? { score: c.score } : {}) }));
  // Only GPUs that matter in a sentence: skip local GPUs that are not where anything could run (an
  // integrated GPU next to the discrete one) unless they are the only alternative.
  const informative = (c) => c.code !== 'model_missing' || c.estimateMs != null;
  if (!ok.length) {
    const why = list.filter(informative).sort((a, b) => REJECT_RANK[a.code] - REJECT_RANK[b.code]).slice(0, 3).map(otherClause);
    return {
      ok: false, target: null, estimateMs: 0, decidedAt: now, candidates: summary,
      reason: `No machine can run this now${why.length ? `: ${why.join('; ')}` : ''}.`
    };
  }
  const win = ok[0];
  const others = [];
  const bestRejected = list.filter((c) => !c.ok && informative(c) && c.code !== 'not_granted')
    .sort((a, b) => REJECT_RANK[a.code] - REJECT_RANK[b.code] || (a.local === b.local ? 0 : a.local ? -1 : 1))[0];
  if (bestRejected) others.push(otherClause(bestRejected));
  const runnerUp = ok[1];
  if (runnerUp) others.push(otherClause(runnerUp));
  const tail = others.length ? ` ${cap(others.join('; '))}.` : '';
  return {
    ok: true,
    target: { kind: win.kind, ...(win.peer ? { peerId: win.peer.peerId } : {}), ...(win.gpuIndex != null ? { gpuIndex: win.gpuIndex } : {}), model: win.model },
    key: win.key,
    estimateMs: win.estimateMs,
    reason: winnerSentence(win) + tail,
    candidates: summary,
    decidedAt: now
  };
}

/** Keeps the numbers decide() needs: adverts, outcomes per target, measured speeds, revokes in this session. */
export class ResourceScheduler {
  constructor(opts = {}) {
    this.now = opts.now || Date.now;
    this.speeds = new SpeedTable();
    /** @type {Record<string, { failures: number, total: number, unhealthyUntil?: number }>} */
    this.outcomes = {};
    /** @type {Map<string, any>} */
    this.adverts = new Map();
    /** @type {Set<string>} peers that revoked a job of ours in this session */
    this.revokedBy = new Set();
  }

  advert(peerId, resource) {
    this.adverts.set(peerId, { ...resource, receivedAt: this.now() });
  }

  forget(peerId) {
    this.adverts.delete(peerId);
  }

  /** @param {string} key target key @param {string} outcome 'completed' or a failure code */
  record(key, outcome) {
    const o = (this.outcomes[key] ||= { failures: 0, total: 0 });
    o.total++;
    if (outcome !== 'completed') o.failures++;
    if (outcome === 'crashed' || outcome === 'oom') o.unhealthyUntil = this.now() + TIMES.unhealthyMs;
    // Keep the rate recent: halve old counts past 20 jobs.
    if (o.total > 20) { o.total = Math.ceil(o.total / 2); o.failures = Math.ceil(o.failures / 2); }
  }

  revoked(peerId) {
    this.revokedBy.add(peerId);
  }

  /** @param {Omit<DecideInput, 'outcomes' | 'speeds' | 'now'>} input */
  decide(input) {
    const peers = (input.peers || []).map((p) => ({ ...p, advert: p.advert ?? this.adverts.get(p.peerId), revoked: p.revoked || this.revokedBy.has(p.peerId) }));
    return decide({ ...input, peers, outcomes: this.outcomes, speeds: this.speeds, now: this.now() });
  }
}
