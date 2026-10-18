// The job worker (PLAN section 6): answers job.offer from peers that hold a compute.inference grant
// issued by this engine, inside the owner's ShareSettings, with a lease, heartbeats, a hard deadline,
// a real cancel (the AbortController reaches the brain), revoke and expiry.
// Only the "inference" job type exists. No tools, files, shell, network, memory or workspace here.
// The audit entry and the job record keep counts only, never the prompt text.
import { CAPABILITY, TIMES, VRAM_RESERVE, ComputeError, newLeaseId } from './types.js';
import { readOffer, readInferenceInput, readCancel } from './wire.js';
import { insideHours } from './share.js';
import { sameModel, catalogOf, kvCache, modelBytes, modelVram } from './estimate.js';

const RAM_RESERVE = 2 * 1024 ** 3;
const OFFERS_PER_MINUTE = 30;

/**
 * Brains a peer job may run on: the local runtime, a local Ollama or LM Studio, or an OpenAI compatible
 * server on this machine. Never a cloud provider, never another peer.
 */
export function servesPeers(brain) {
  if (!brain || brain.kind !== 'local') return false;
  const info = brain.info?.() || {};
  if (info.backend === 'local' || info.backend === 'ollama' || info.backend === 'lmstudio') return true;
  if (info.backend === 'openai' && typeof info.url === 'string') {
    try { return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(new URL(info.url).hostname); } catch { return false; }
  }
  return false;
}

/** How a runtime error reads as a JobErrorCode. */
export function errorCode(err) {
  const msg = String(err?.message || err || '');
  if (err?.code === 'invalid_json') return 'bad_output';
  if (err?.code === 'no_memory' || /out of memory|\boom\b|cudaMalloc|failed to allocate|insufficient memory/i.test(msg)) return 'oom';
  return 'crashed';
}

/**
 * @typedef {Object} ComputeLink   what the p2p session layer (Stream 2) gives the compute plane; docs/1.0/protocol/compute.md
 * @property {string} selfId
 * @property {(peerId: string, type: string, body: object) => boolean} send
 * @property {(fn: (peerId: string, type: string, body: any) => void) => () => void} onMessage
 * @property {(peerId: string, capability: string) => boolean} hasGrant      a valid grant this engine issued to peerId
 * @property {(peerId: string, capability: string) => boolean} holdsGrant    a valid grant peerId issued to this engine
 * @property {() => Array<{ peerId: string, name: string, online: boolean, blocked?: boolean, rttMs?: number }>} peers
 * @property {(fn: (ev: { type: string, peerId: string, capability?: string }) => void) => () => void} onPeer
 * @property {(entry: object) => void} [audit]
 */

export class ComputeWorker {
  /**
   * @param {{
   *   link: ComputeLink,
   *   getShare: () => import('./types.js').ShareSettings,
   *   getResource: () => any,                       the last probe sample
   *   serving: () => null | { brainId: string, model: string, device: 'gpu'|'cpu', gpuIndex?: number, vramBytes?: number, bytes?: number, threads?: number | null, limitThreads?: ((n: number) => (() => void) | null) },
   *   runTurn: (req: object) => Promise<any>,       Scheduler.turn of src/crew/scheduler.js
   *   bus?: { emit: Function, live: Function },
   *   jobLog?: { append: (rec: object) => void },
   *   now?: () => number
   * }} opts
   */
  constructor(opts) {
    this.link = opts.link;
    this.getShare = opts.getShare;
    this.getResource = opts.getResource || (() => null);
    this.serving = opts.serving;
    this.runTurn = opts.runTurn;
    this.bus = opts.bus || null;
    this.jobLog = opts.jobLog || null;
    this.now = opts.now || Date.now;
    /** @type {Map<string, any>} running jobs by id */
    this.jobs = new Map();
    /** @type {Map<string, number[]>} offer times per peer, for the rate limit */
    this.offers = new Map();
    /** @type {Map<string, any>} peers whose session closed: grace timers */
    this.grace = new Map();
    this.counts = { served: 0, refused: 0 };
    this._off = [];
    if (this.link) {
      this._off.push(this.link.onMessage((peerId, type, body) => this.handle(peerId, type, body)));
      this._off.push(this.link.onPeer((ev) => this.onPeer(ev)));
    }
  }

  /** Running peer jobs, by device. */
  busy() {
    let gpu = 0;
    let cpu = 0;
    for (const j of this.jobs.values()) j.device === 'gpu' ? gpu++ : cpu++;
    return { jobs: gpu + cpu, gpu, cpu };
  }

  handle(peerId, type, body) {
    if (type === 'job.offer') return this.offer(peerId, body);
    if (type === 'job.cancel') {
      let jobId;
      try { ({ jobId } = readCancel(body)); } catch { return; }
      const j = this.jobs.get(jobId);
      if (j && j.requester === peerId) this._abort(j, 'cancelled', 'cancelled by the requester');
    }
  }

  onPeer(ev) {
    if (!ev?.peerId) return;
    if (ev.type === 'offline') {
      if (!this._jobsOf(ev.peerId).length || this.grace.has(ev.peerId)) return;
      const t = setTimeout(() => {
        this.grace.delete(ev.peerId);
        for (const j of this._jobsOf(ev.peerId)) this._abort(j, 'disconnected', 'the requester disconnected');
      }, TIMES.resumeGraceMs);
      t.unref?.();
      this.grace.set(ev.peerId, t);
    } else if (ev.type === 'online' || ev.type === 'resumed') {
      clearTimeout(this.grace.get(ev.peerId));
      this.grace.delete(ev.peerId);
    } else if ((ev.type === 'grant.revoked' || ev.type === 'grant.expired' || ev.type === 'blocked') && (!ev.capability || ev.capability === CAPABILITY)) {
      const why = ev.type === 'grant.expired' ? 'the compute.inference grant expired' : ev.type === 'blocked' ? 'the peer was blocked' : 'the compute.inference grant was revoked';
      for (const j of this._jobsOf(ev.peerId)) this.revoke(j.id, why);
    }
  }

  _jobsOf(peerId) {
    return [...this.jobs.values()].filter((j) => j.requester === peerId);
  }

  _reject(peerId, jobId, code, detail, extra = {}) {
    this.counts.refused++;
    this.link.send(peerId, 'job.reject', { jobId, code, detail });
    this.bus?.emit('job.refused', { jobId, peerId, code, detail, ...extra });
    if (extra.audit) this.link.audit?.({ kind: 'compute.job.refused', requester: peerId, jobId, code, detail });
    return { ok: false, code, detail };
  }

  _rate(peerId) {
    const now = this.now();
    const list = (this.offers.get(peerId) || []).filter((t) => now - t < 60_000);
    list.push(now);
    this.offers.set(peerId, list);
    return list.length <= OFFERS_PER_MINUTE;
  }

  /**
   * Checks an offer against every rule of PLAN sections 5 and 6, then leases it and runs it.
   * @returns {{ ok: boolean, code?: string, detail?: string, lease?: any }}
   */
  offer(peerId, body) {
    let job;
    try {
      job = readOffer(body);
    } catch (err) {
      const jobId = err.jobId || (typeof body?.job?.id === 'string' ? body.job.id.slice(0, 40) : '');
      // A job type outside the allowlist is refused and written to the audit log.
      return this._reject(peerId, jobId, 'bad_input', err.message, { audit: !!err.disallowedType });
    }
    if (!this.link.hasGrant(peerId, CAPABILITY)) return this._reject(peerId, job.id, 'not_granted', 'you do not hold compute.inference on this machine');
    // The limits written in this peer's own grant, on top of the machine wide share settings.
    const gl = this.link.grantLimits?.(peerId, CAPABILITY) || {};
    if (!this._rate(peerId)) return this._reject(peerId, job.id, 'rate_limited', `at most ${OFFERS_PER_MINUTE} offers a minute`);
    if (this.jobs.has(job.id)) return this._reject(peerId, job.id, 'bad_input', 'a job with this id is already running');
    const share = this.getShare();
    if (Array.isArray(share.peers) && !share.peers.includes(peerId)) return this._reject(peerId, job.id, 'not_granted', 'this machine shares only with listed peers');
    if (!share.enabled) return this._reject(peerId, job.id, 'sharing_off', 'this machine does not share its GPU or CPU');
    if (!insideHours(share, new Date(this.now()))) return this._reject(peerId, job.id, 'outside_hours', `this machine shares from ${share.hours.from} to ${share.hours.to} only`);
    let input;
    try {
      input = readInferenceInput(job.input, { maxTokensCap: Math.min(share.maxTokensPerJob, Number.isInteger(gl.maxTokensPerJob) ? gl.maxTokensPerJob : Infinity) });
    } catch (err) {
      return this._reject(peerId, job.id, 'bad_input', err.message);
    }
    const srv = this.serving();
    if (!srv) return this._reject(peerId, job.id, 'model_missing', 'no model is loaded on this machine');
    const device = srv.device;
    if (device === 'gpu' && !(share.gpu.enabled && share.gpu.remoteInference)) return this._reject(peerId, job.id, 'sharing_off', share.gpu.enabled ? 'remote inference on the GPU is off' : 'GPU sharing is off');
    if (device === 'cpu' && !share.cpu.enabled) return this._reject(peerId, job.id, 'sharing_off', 'CPU sharing is off');
    // The model allowlist: the served model must be listed; a named model must be the served one.
    const listed = share.modelAllowlist.some((m) => sameModel(m, srv.model));
    if (input.model !== 'any-allowed') {
      if (!share.modelAllowlist.some((m) => sameModel(m, input.model))) return this._reject(peerId, job.id, 'model_not_allowed', 'that model is not on the allowlist of this machine');
      if (!sameModel(input.model, srv.model)) {
        const builtIn = !!catalogOf(input.model);
        const why = share.modelDownload && builtIn
          ? 'that model is not loaded here, and downloading a model for a peer is not available in this build'
          : 'that model is not loaded on this machine';
        return this._reject(peerId, job.id, 'model_missing', why);
      }
    } else if (!listed) {
      return this._reject(peerId, job.id, 'model_not_allowed', 'the loaded model is not on the allowlist of this machine');
    }
    if (Array.isArray(gl.models) && gl.models.length && !gl.models.some((m) => sameModel(m, srv.model))) return this._reject(peerId, job.id, 'model_not_allowed', 'your grant on this machine does not cover the loaded model');
    if (Number.isInteger(gl.maxConcurrentJobs) && this._jobsOf(peerId).length >= gl.maxConcurrentJobs) return this._reject(peerId, job.id, 'busy', `your grant allows ${gl.maxConcurrentJobs} job${gl.maxConcurrentJobs === 1 ? '' : 's'} at a time`);
    const busy = this.busy();
    if (device === 'gpu' && busy.gpu >= share.gpu.maxConcurrentJobs) return this._reject(peerId, job.id, 'busy', `already running ${busy.gpu} peer job${busy.gpu === 1 ? '' : 's'}, the limit`);
    if (device === 'cpu' && busy.cpu >= 1) return this._reject(peerId, job.id, 'busy', 'already running a CPU peer job');
    // Memory, from the live probe.
    const promptChars = input.messages.reduce((n, m) => n + m.content.length, 0);
    const tokens = Math.ceil(promptChars / 4) + input.maxTokens;
    const res = this.getResource();
    let held;
    if (device === 'gpu') {
      held = srv.vramBytes ?? modelVram(srv.model, 4096, srv.bytes) ?? 0;
      const g = res?.gpus?.[srv.gpuIndex ?? 0];
      const free = g?.vramFreeBytes;
      const extra = kvCache(srv.model, tokens);
      if (share.gpu.maxVramBytes != null && held > share.gpu.maxVramBytes) return this._reject(peerId, job.id, 'vram', `the model holds ${(held / 1024 ** 3).toFixed(1)} GB of VRAM, over the ${(share.gpu.maxVramBytes / 1024 ** 3).toFixed(1)} GB this machine lends`);
      if (free == null && share.gpu.maxVramBytes == null) return this._reject(peerId, job.id, 'vram', 'free VRAM is not measured on this machine, so the owner must set a VRAM limit (hivedesk share --max-vram)');
      if (free != null && extra > free - VRAM_RESERVE) return this._reject(peerId, job.id, 'vram', `${(free / 1024 ** 3).toFixed(1)} GB of VRAM free, and 1 GB stays for the owner`);
    } else {
      held = (modelBytes(srv.model, srv.bytes) || 0) + kvCache(srv.model, tokens);
      const free = res?.ram?.freeBytes;
      if (share.cpu.maxRamBytes != null && held > share.cpu.maxRamBytes) return this._reject(peerId, job.id, 'ram', `the job needs ${(held / 1024 ** 3).toFixed(1)} GB of RAM, over the ${(share.cpu.maxRamBytes / 1024 ** 3).toFixed(1)} GB this machine lends`);
      if (free != null && kvCache(srv.model, tokens) > free - RAM_RESERVE) return this._reject(peerId, job.id, 'ram', `${(free / 1024 ** 3).toFixed(1)} GB of RAM free, and 2 GB stay for the owner`);
      if (srv.threads != null && srv.threads > share.cpu.maxThreads && typeof srv.limitThreads !== 'function') {
        return this._reject(peerId, job.id, 'busy', `the runtime uses ${srv.threads} threads and cannot be capped at ${share.cpu.maxThreads}`);
      }
    }
    const now = this.now();
    const maxSec = Math.min(job.maxSeconds ?? Infinity, share.gpu.maxJobSeconds, Number.isInteger(gl.maxJobSeconds) ? gl.maxJobSeconds : Infinity);
    const lease = {
      id: newLeaseId(), jobId: job.id, worker: this.link.selfId, requester: peerId,
      grantedAt: now, expiresAt: now + TIMES.leaseMs, hardDeadline: now + maxSec * 1000,
      limits: { maxTokens: input.maxTokens, vramBytes: device === 'gpu' ? held : 0, model: srv.model },
      state: 'active'
    };
    if (!this.link.send(peerId, 'job.accept', { jobId: job.id, lease })) return { ok: false, code: 'disconnected', detail: 'the session closed' };
    this._run({ ...job, input }, lease, srv, share);
    return { ok: true, lease };
  }

  _run(job, lease, srv, share) {
    const ctrl = new AbortController();
    const j = {
      id: job.id, requester: lease.requester, device: srv.device, model: srv.model, lease, ctrl,
      text: '', tokens: 0, chars: job.input.messages.reduce((n, m) => n + m.content.length, 0),
      started: this.now(), abortCode: null, abortWhy: '', pending: '', flushTimer: null, unsent: 0
    };
    this.jobs.set(job.id, j);
    this.bus?.emit('job.leased', { jobId: job.id, peerId: lease.requester, leaseId: lease.id, model: srv.model, device: srv.device, hardDeadline: lease.hardDeadline });

    const send = (type, body) => this.link.send(lease.requester, type, body);
    const flush = () => {
      j.flushTimer = null;
      if (!j.pending) return;
      const text = j.pending;
      j.pending = '';
      send('job.token', { jobId: job.id, text });
    };
    // The hard deadline: min(job maxSeconds, share.maxJobSeconds) from the lease.
    const deadline = setTimeout(() => this._abort(j, 'timeout', 'the job reached its time limit'), Math.max(0, lease.hardDeadline - this.now()));
    deadline.unref?.();
    // Heartbeats renew the lease while the requester can be reached; 15 s without a delivered heartbeat expires it.
    let lastDelivered = this.now();
    const beat = setInterval(() => {
      const ok = send('job.heartbeat', { jobId: job.id, leaseId: lease.id, tokens: j.tokens, vramBytes: lease.limits.vramBytes });
      const now = this.now();
      if (ok) { lastDelivered = now; lease.expiresAt = now + TIMES.leaseMs; }
      // A session known to be closed is the grace timer's case (disconnected); silence is the lease's.
      else if (!this.grace.has(lease.requester) && now - lastDelivered >= TIMES.leaseMs) this._abort(j, 'lease_expired', 'the lease expired');
    }, TIMES.heartbeatMs);
    beat.unref?.();

    let restoreThreads = null;
    const eligible = (brainId) => brainId === srv.brainId;
    const turn = this.runTurn({
      workerId: `peer:${lease.requester.slice(0, 12)}`,
      lane: 'peer',
      jobId: undefined,
      noRetry: true,
      eligible,
      signal: ctrl.signal,
      onStart: () => {
        if (srv.device === 'cpu' && typeof srv.limitThreads === 'function') restoreThreads = srv.limitThreads(share.cpu.maxThreads);
        this.bus?.emit('job.running', { jobId: job.id, peerId: lease.requester });
      },
      messages: job.input.messages,
      options: {
        maxTokens: lease.limits.maxTokens,
        ...(job.input.temperature !== undefined ? { temperature: job.input.temperature } : {}),
        ...(job.input.schema ? { schema: job.input.schema } : {}),
        onToken: (text) => {
          if (ctrl.signal.aborted || typeof text !== 'string' || !text) return;
          j.text += text;
          j.tokens++;
          j.pending += text;
          if (!j.flushTimer) { j.flushTimer = setTimeout(flush, TIMES.tokenFlushMs); j.flushTimer.unref?.(); }
        }
      }
    });

    Promise.resolve(turn).then((result) => {
      if (j.abortCode) return this._finish(j, j.abortCode, result);
      flush();
      const out = {
        text: String(result?.text ?? ''), promptTokens: result?.promptTokens || 0,
        completionTokens: result?.completionTokens || j.tokens, ms: this.now() - j.started, model: srv.model
      };
      if (result?.json !== undefined) out.json = result.json;
      send('job.result', { jobId: job.id, result: out });
      this._finish(j, 'completed', out);
    }, (err) => {
      flush();
      const code = j.abortCode || errorCode(err);
      if (code !== 'revoked' && code !== 'disconnected') {
        send('job.error', { jobId: job.id, code, message: j.abortWhy || String(err?.message || err).slice(0, 300), ...(j.text ? { partial: { text: j.text, completionTokens: j.tokens } } : {}) });
      }
      this._finish(j, code);
    }).finally(() => {
      clearTimeout(deadline);
      clearInterval(beat);
      clearTimeout(j.flushTimer);
      try { restoreThreads?.(); } catch { /* ignore */ }
    });
  }

  _abort(j, code, why) {
    if (j.abortCode) return;
    j.abortCode = code;
    j.abortWhy = why;
    j.ctrl.abort(new ComputeError(code, why));
  }

  /** The owner's Stop for one job: job.revoke to the requester, then the turn is aborted. */
  revoke(jobId, reason = 'stopped by the owner') {
    const j = this.jobs.get(jobId);
    if (!j) return false;
    j.lease.state = 'revoked';
    this.link.send(j.requester, 'job.revoke', { jobId, reason });
    this._abort(j, 'revoked', reason);
    return true;
  }

  /** Stop every peer job (the owner turned sharing off, or pressed Stop all). */
  revokeAll(reason = 'stopped by the owner') {
    let n = 0;
    for (const id of [...this.jobs.keys()]) if (this.revoke(id, reason)) n++;
    return n;
  }

  /** Called when ShareSettings change: running jobs that are no longer allowed are revoked. */
  applyShare(share) {
    for (const j of [...this.jobs.values()]) {
      const allowed = share.enabled && (j.device === 'gpu' ? share.gpu.enabled && share.gpu.remoteInference : share.cpu.enabled) &&
        share.modelAllowlist.some((m) => sameModel(m, j.model)) && (!Array.isArray(share.peers) || share.peers.includes(j.requester));
      if (!allowed) this.revoke(j.id, 'the owner changed what this machine shares');
    }
  }

  _finish(j, outcome, result) {
    if (!this.jobs.has(j.id)) return;
    this.jobs.delete(j.id);
    if (j.lease.state === 'active') j.lease.state = outcome === 'lease_expired' ? 'expired' : 'released';
    const ms = this.now() - j.started;
    const rec = {
      jobId: j.id, requester: j.requester, model: j.model, device: j.device, leaseId: j.lease.id,
      charsIn: j.chars, tokensOut: result?.completionTokens ?? j.tokens, ms, outcome
    };
    if (outcome === 'completed') this.counts.served++;
    this.bus?.emit('job.served', rec);
    this.link.audit?.({ kind: 'compute.job.served', ...rec });
    try { this.jobLog?.append({ role: 'worker', ...rec, endedAt: new Date(this.now()).toISOString() }); } catch { /* the log is best effort */ }
  }

  close() {
    this.revokeAll('the engine is shutting down');
    for (const t of this.grace.values()) clearTimeout(t);
    this.grace.clear();
    for (const off of this._off) try { off?.(); } catch { /* ignore */ }
  }
}
