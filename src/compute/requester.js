// The requester (PLAN section 6): a Brain whose chat() creates a Job, asks the resource scheduler where it
// should run, runs it there (the local brain through the crew scheduler, or a peer through job.offer),
// and resolves with the result. Failures follow the matrix of PLAN section 8: one automatic retry where
// the table says so, otherwise the job waits for a person's choice (Retry locally, Retry another peer,
// Use partial, Cancel) with a deadline, so nothing waits forever.
import { CAPABILITY, TIMES, FINAL_STATES, ComputeError, newJobId } from './types.js';
import { readAccept, readReject, readHeartbeat, readToken, readResult, readError, readRevoke, compactSchema } from './wire.js';
import { validate, extractJson, describeSchema } from '../brain/schema.js';

/** How long a failed job waits for a choice before it fails for good. */
export const CHOICE_WAIT_MS = 60_000;
/** How long a job with no candidate waits for a resource to change. */
export const RESOURCE_WAIT_MS = 30_000;
const OFFER_ANSWER_MS = 10_000;

const iso = (ms) => new Date(ms).toISOString();

/** The buttons a failed job offers, by failure (PLAN section 8). */
export function choicesFor(code, { canLocal, canPeer, hasPartial, allowPartial }) {
  const out = [];
  if (canLocal) out.push('retry-local');
  if (canPeer && code !== 'revoked') out.push('retry-peer');
  if (hasPartial && allowPartial) out.push('use-partial');
  out.push('cancel');
  return out;
}

export class Requester {
  /**
   * @param {{
   *   link?: import('./worker.js').ComputeLink | null,     null: no p2p in this build, local targets only
   *   resources: import('./scheduler.js').ResourceScheduler,
   *   localState: () => import('./scheduler.js').LocalState,
   *   runLocal: (req: object) => Promise<any>,            Scheduler.turn limited to the local brains
   *   bus?: { emit: Function, live: Function },
   *   jobLog?: { append: (rec: object) => void },
   *   now?: () => number,
   *   choiceWaitMs?: number, resourceWaitMs?: number, offerAnswerMs?: number
   * }} opts
   */
  constructor(opts) {
    this.link = opts.link || null;
    this.resources = opts.resources;
    this.localState = opts.localState;
    this.runLocal = opts.runLocal;
    this.bus = opts.bus || null;
    this.jobLog = opts.jobLog || null;
    this.now = opts.now || Date.now;
    this.choiceWaitMs = opts.choiceWaitMs ?? CHOICE_WAIT_MS;
    this.resourceWaitMs = opts.resourceWaitMs ?? RESOURCE_WAIT_MS;
    this.offerAnswerMs = opts.offerAnswerMs ?? OFFER_ANSWER_MS;
    /** @type {Map<string, any>} every job of this run, by id (final ones are kept, newest 200) */
    this.jobs = new Map();
    /** @type {Map<string, any>} the attempt running on a peer, by job id */
    this.remote = new Map();
    /** @type {Map<string, { resolve: Function, timer: any }>} jobs waiting for a person's choice */
    this.waitingChoice = new Map();
    this.resourceWaiters = new Set();
    this._off = [];
    if (this.link) {
      this._off.push(this.link.onMessage((peerId, type, body) => this.handle(peerId, type, body)));
      this._off.push(this.link.onPeer((ev) => this.onPeer(ev)));
    }
  }

  /** A Brain (src/brain/types.js) the crew scheduler can hold like any other. */
  brain(id = 'compute') {
    return {
      id,
      label: 'Hive compute',
      kind: 'remote',
      turnMeta: true,
      info: () => ({ backend: 'compute', model: 'scheduled' }),
      chat: (messages, options = {}) => this.chat(messages, options)
    };
  }

  /** Tell waiting jobs that a resource changed (an advert came in, the local model changed). */
  resourcesChanged() {
    for (const fn of [...this.resourceWaiters]) fn();
  }

  _peerStates() {
    if (!this.link) return [];
    return this.link.peers().map((p) => ({ ...p, granted: this.link.holdsGrant(p.peerId, CAPABILITY) }));
  }

  _decide(job, extra = {}) {
    return this.resources.decide({
      job: { input: job.input, priority: job.priority, deadlineMs: job.deadlineMs, onlyLocal: job.onlyLocal || extra.onlyLocal, exclude: [...(extra.exclude || [])] },
      // onlyPeer: a friend's agent thinks only on its own machine (City membership), never here.
      local: extra.onlyPeers || job.onlyPeer ? { ...this.localState(), brain: null } : this.localState(),
      peers: extra.onlyLocal ? [] : this._peerStates().filter((p) => !job.onlyPeer || p.peerId === job.onlyPeer)
    });
  }

  _set(job, state, extra = {}) {
    job.state = state;
    Object.assign(job, extra);
    this.bus?.emit('job.state', { jobId: job.id, state, ...(job.error ? { error: job.error } : {}), ...(job.choices ? { choices: job.choices } : {}), ...(job.choiceDeadline ? { choiceDeadline: iso(job.choiceDeadline) } : {}), ...(job.waiting ? { waiting: job.waiting } : {}), ...(extra.usedPartial ? { usedPartial: true } : {}) });
  }

  /**
   * @param {any[]} messages
   * @param {{ schema?: object, maxTokens?: number, temperature?: number, signal?: AbortSignal, onToken?: (t: string) => void,
   *           model?: string, priority?: 'interactive'|'normal'|'background', taskId?: string, agentId?: string,
   *           onlyLocal?: boolean, autoRetry?: boolean, allowPartial?: boolean, deadlineMs?: number, workerId?: string }} [options]
   */
  async chat(messages, options = {}) {
    const now = this.now();
    const turn = options.turn && typeof options.turn === 'object' ? options.turn : {};
    const taskId = options.taskId || (typeof turn.taskId === 'string' ? turn.taskId : undefined);
    const agentId = options.agentId || (typeof turn.workerId === 'string' ? turn.workerId : undefined);
    const crewJobId = typeof turn.jobId === 'string' ? turn.jobId : undefined;
    const job = {
      id: newJobId(), type: 'inference', requester: this.link?.selfId || 'local', worker: null,
      ...(taskId ? { taskId } : {}), ...(agentId ? { agentId } : {}), ...(crewJobId ? { crewJobId } : {}),
      input: {
        model: options.model || 'any-allowed',
        messages: messages.map((m) => ({ role: m.role, content: String(m.content ?? '') })),
        maxTokens: options.maxTokens || 1024,
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options.schema ? { schema: options.schema, format: 'json' } : {})
      },
      priority: options.priority || 'normal', state: 'queued', attempts: [], createdAt: iso(now),
      onlyLocal: !!options.onlyLocal, deadlineMs: options.deadlineMs,
      ...(typeof options.onlyPeer === 'string' ? { onlyPeer: options.onlyPeer } : {})
    };
    this.jobs.set(job.id, job);
    while (this.jobs.size > 200) {
      const old = [...this.jobs.values()].find((j) => FINAL_STATES.has(j.state));
      if (!old) break;
      this.jobs.delete(old.id);
    }
    this.bus?.emit('job.created', { jobId: job.id, model: job.input.model, priority: job.priority, ...(job.taskId ? { taskId: job.taskId } : {}), ...(job.agentId ? { agentId: job.agentId } : {}), ...(job.crewJobId ? { crewJobId: job.crewJobId } : {}) });
    const allowPartial = options.allowPartial ?? !options.schema;
    const autoRetry = options.autoRetry !== false;
    // One controller per job: the caller's signal and compute.job.cancel both end it, in any phase.
    const ctrl = new AbortController();
    job.ctrl = ctrl;
    if (options.signal?.aborted) ctrl.abort();
    options.signal?.addEventListener('abort', () => ctrl.abort(), { once: true });
    const signal = ctrl.signal;
    let route = {};
    let waitingSince = null;          // the constraints of the next attempt: { onlyLocal } or { onlyPeers, exclude }
    const exclude = new Set();
    let autoRetried = false;
    let schemaRetried = false;
    let messagesNow = job.input.messages;

    const cancelled = () => {
      this._set(job, 'cancelled', { error: { code: 'cancelled', message: 'cancelled' }, endedAt: iso(this.now()) });
      this._final(job);
      return new ComputeError('cancelled', 'cancelled', { jobId: job.id });
    };

    for (;;) {
      if (signal?.aborted) throw cancelled();
      const decision = this._decide({ ...job, input: { ...job.input, messages: messagesNow } }, { ...route, exclude: [...exclude, ...(route.exclude || [])] });
      job.decision = decision;
      this.bus?.emit('job.scheduled', { jobId: job.id, decision });
      if (!decision.ok) {
        // No candidate: wait for a resource to change, with a deadline, then fail with the reasons.
        // The deadline counts from the first refusal, so frequent resource samples cannot extend it.
        waitingSince ??= this.now();
        const left = waitingSince + this.resourceWaitMs - this.now();
        if (left > 0) {
          this._set(job, 'queued', { waiting: { kind: 'resource', reason: decision.reason, deadline: iso(waitingSince + this.resourceWaitMs) } });
          const changed = await this._waitResource(signal, left);
          if (signal?.aborted) throw cancelled();
          if (changed) continue;
        }
        const err = new ComputeError('no_candidate', decision.reason, { jobId: job.id, choices: ['open-machines', 'cancel'] });
        this._set(job, 'failed', { error: { code: 'no_candidate', message: decision.reason }, endedAt: iso(this.now()), waiting: undefined });
        this._final(job);
        throw err;
      }
      job.waiting = undefined;
      waitingSince = null;
      const key = decision.key;
      const t = decision.target;
      let outcome;
      try {
        const res = t.kind.startsWith('local')
          ? await this._runLocal(job, messagesNow, options, signal)
          : await this._runPeer(job, t.peerId, key, messagesNow, options, signal);
        // The requester always validates a schema answer itself, wherever it ran.
        if (options.schema) {
          const json = res.json !== undefined ? res.json : extractJson(res.text);
          const errors = json === undefined ? ['the answer is not valid JSON'] : validate(options.schema, json);
          if (errors.length) throw new ComputeError('bad_output', `the answer did not match the schema: ${errors.slice(0, 3).join('; ')}`, { text: res.text, schemaErrors: errors });
          res.json = json;
        }
        this.resources.record(key, 'completed');
        if (res.completionTokens && res.ms) this.resources.speeds.observe(key, res.model || t.model, t.kind.endsWith('gpu') ? 'gpu' : 'cpu', res);
        job.attempts[job.attempts.length - 1].outcome = 'completed';
        job.attempts[job.attempts.length - 1].endedAt = iso(this.now());
        job.result = { text: res.text, ...(res.json !== undefined ? { json: res.json } : {}), promptTokens: res.promptTokens || 0, completionTokens: res.completionTokens || 0, ms: res.ms || 0, model: res.model || t.model };
        this._set(job, 'completed', { endedAt: iso(this.now()), choices: undefined, error: undefined });
        this._final(job);
        return { ...job.result, jobId: job.id, ...(t.peerId ? { remoteOrigin: t.peerId } : {}) };
      } catch (err) {
        outcome = err;
      }
      const err = outcome;
      const code = err?.code || 'crashed';
      const att = job.attempts[job.attempts.length - 1];
      if (att) { att.outcome = code; att.endedAt = iso(this.now()); }
      if (code === 'cancelled' || signal?.aborted) throw cancelled();
      if (err.rejected) {
        // Refused before anything ran (busy, limits changed since its advert): the next candidate, no person needed.
        exclude.add(key);
        continue;
      }
      this.resources.record(key, code);
      if (code === 'revoked' && t.peerId) this.resources.revoked(t.peerId);
      if (err.partial?.text) job.partial = { text: err.partial.text, completionTokens: err.partial.completionTokens || 0 };
      // Automatic actions of the matrix.
      if (code === 'bad_output' && !schemaRetried && options.schema) {
        schemaRetried = true;
        messagesNow = [...job.input.messages,
          { role: 'assistant', content: String(err.text || '').slice(0, 2000) },
          { role: 'user', content: `That answer was not valid: ${(err.schemaErrors || [err.message]).slice(0, 5).join('; ')}. Answer again with only one JSON value matching this schema: ${describeSchema(options.schema)}` }];
        route = {};
        continue;
      }
      if (code === 'timeout' && autoRetry && !autoRetried) {
        autoRetried = true;
        exclude.add(key);
        route = {};
        continue;
      }
      // A choice for a person, with a deadline.
      const state = job.partial ? 'partial' : code === 'revoked' ? 'revoked' : code === 'lease_expired' ? 'expired' : 'failed';
      const canLocal = !job.onlyPeer && this._decide(job, { onlyLocal: true }).ok;
      const peerExclude = [key];
      const canPeer = !!this.link && !job.onlyLocal && this._decide(job, { onlyPeers: true, exclude: peerExclude }).ok;
      const choices = choicesFor(code, { canLocal, canPeer, hasPartial: !!job.partial, allowPartial });
      job.error = { code, message: String(err?.message || err).slice(0, 300) };
      this._set(job, state, { choices, choiceDeadline: this.now() + this.choiceWaitMs });
      const choice = await this._waitChoice(job, signal);
      job.choices = undefined;
      job.choiceDeadline = undefined;
      if (choice === 'retry-local') { route = { onlyLocal: true }; exclude.delete(key); continue; }
      if (choice === 'retry-peer') { route = { onlyPeers: true, exclude: peerExclude }; continue; }
      if (choice === 'use-partial' && job.partial) {
        this._set(job, 'partial', { endedAt: iso(this.now()), usedPartial: true });
        this._final(job);
        return { text: job.partial.text, promptTokens: 0, completionTokens: job.partial.completionTokens, ms: 0, model: t.model, partial: true, jobId: job.id, ...(t.peerId ? { remoteOrigin: t.peerId } : {}) };
      }
      if (choice === 'cancel') throw cancelled();
      // No choice before the deadline: the failure stands (the task engine decides what happens next).
      this._set(job, state, { endedAt: iso(this.now()) });
      this._final(job);
      throw new ComputeError(code, job.error.message, { jobId: job.id, partial: job.partial, choices: [] });
    }
  }

  _waitResource(signal, ms = this.resourceWaitMs) {
    return new Promise((resolve) => {
      const done = (v) => { clearTimeout(timer); this.resourceWaiters.delete(fn); signal?.removeEventListener('abort', onAbort); resolve(v); };
      const fn = () => done(true);
      const onAbort = () => done(false);
      const timer = setTimeout(() => done(false), ms);
      timer.unref?.();
      this.resourceWaiters.add(fn);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  _waitChoice(job, signal) {
    return new Promise((resolve) => {
      const done = (v) => {
        clearTimeout(timer);
        this.waitingChoice.delete(job.id);
        signal?.removeEventListener('abort', onAbort);
        resolve(v);
      };
      const onAbort = () => done('cancel');
      const timer = setTimeout(() => done(null), this.choiceWaitMs);
      timer.unref?.();
      this.waitingChoice.set(job.id, { resolve: done });
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * A person's choice for a failed job: 'retry-local', 'retry-peer', 'use-partial' or 'cancel'.
   * Cancel also works on a running job.
   */
  choose(jobId, choice) {
    const job = this.jobs.get(jobId);
    if (!job) throw new ComputeError('not_found', 'no job with that id');
    const w = this.waitingChoice.get(jobId);
    if (w) {
      if (choice !== 'cancel' && !(job.choices || []).includes(choice)) throw new ComputeError('bad_request', `"${choice}" is not one of this job's choices`);
      w.resolve(choice);
      return { ok: true };
    }
    if (choice === 'cancel') return { ok: this.cancel(jobId) };
    throw new ComputeError('bad_request', 'this job is not waiting for a choice');
  }

  /** Cancel a running job: job.cancel to the worker (stream 1, so it overtakes tokens) and the local abort. */
  cancel(jobId) {
    const job = this.jobs.get(jobId);
    if (!job || FINAL_STATES.has(job.state)) return false;
    const w = this.waitingChoice.get(jobId);
    if (w) { w.resolve('cancel'); return true; }
    job.ctrl?.abort();
    return true;
  }

  async _runLocal(job, messages, options, signal) {
    const ctrl = new AbortController();
    job.localCtrl = ctrl;
    const onAbort = () => ctrl.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    job.worker = 'local';
    job.attempts.push({ worker: 'local', startedAt: iso(this.now()), outcome: 'running' });
    this._set(job, 'running');
    let noToken = null;
    let timedOut = false;
    let text = '';
    let tokens = 0;
    const arm = () => {
      clearTimeout(noToken);
      noToken = setTimeout(() => { timedOut = true; ctrl.abort(); }, TIMES.noTokenMs);
      noToken.unref?.();
    };
    try {
      const res = await this.runLocal({
        workerId: options.workerId || `job:${job.id}`, taskId: job.taskId, messages,
        signal: ctrl.signal, noRetry: true,
        onStart: arm,
        options: {
          maxTokens: job.input.maxTokens,
          ...(job.input.temperature !== undefined ? { temperature: job.input.temperature } : {}),
          ...(job.input.schema ? { schema: job.input.schema } : {}),
          onToken: (t) => { arm(); text += t; tokens++; options.onToken?.(t); this.bus?.live('job.token', { jobId: job.id, n: tokens }); }
        }
      });
      return res;
    } catch (err) {
      const partial = text ? { text, completionTokens: tokens } : undefined;
      if (timedOut) throw new ComputeError('timeout', 'no token for 30 s', { partial });
      if (ctrl.signal.aborted) throw new ComputeError('cancelled', 'cancelled', { partial });
      const code = err?.code === 'invalid_json' ? 'bad_output' : err?.code === 'no_memory' || /out of memory/i.test(String(err?.message)) ? 'oom' : 'crashed';
      throw new ComputeError(code, String(err?.message || err), { partial, text: err?.text });
    } finally {
      clearTimeout(noToken);
      signal?.removeEventListener('abort', onAbort);
      job.localCtrl = null;
    }
  }

  _runPeer(job, peerId, key, messages, options, signal) {
    return new Promise((resolve, reject) => {
      const att = { worker: peerId, startedAt: iso(this.now()), outcome: 'offered' };
      job.attempts.push(att);
      job.worker = peerId;
      const r = { peerId, key, text: '', tokens: 0, lease: null, timers: {}, settled: false };
      const clear = () => { for (const t of Object.values(r.timers)) { clearTimeout(t); clearInterval(t); } };
      const partial = () => (r.text ? { text: r.text, completionTokens: r.tokens } : undefined);
      r.fail = (err) => {
        if (r.settled) return;
        r.settled = true;
        clear();
        this.remote.delete(job.id);
        signal?.removeEventListener('abort', onAbort);
        if (err.code === 'cancelled' || err.code === 'timeout' || err.code === 'lease_expired') {
          try { this.link.send(peerId, 'job.cancel', { jobId: job.id }); } catch { /* closed */ }
        }
        if (!err.partial && r.text) err.partial = partial();
        reject(err);
      };
      r.ok = (res) => {
        if (r.settled) return;
        r.settled = true;
        clear();
        this.remote.delete(job.id);
        signal?.removeEventListener('abort', onAbort);
        resolve(res);
      };
      const onAbort = () => r.fail(new ComputeError('cancelled', 'cancelled'));
      signal?.addEventListener('abort', onAbort, { once: true });
      const armNoToken = r.armNoToken = () => { clearTimeout(r.timers.noToken); r.timers.noToken = setTimeout(() => r.fail(new ComputeError('timeout', 'no token from the peer for 30 s')), TIMES.noTokenMs); r.timers.noToken.unref?.(); };
      const armLease = r.armLease = () => { clearTimeout(r.timers.lease); r.timers.lease = setTimeout(() => r.fail(new ComputeError('lease_expired', 'no heartbeat from the peer for 15 s')), TIMES.leaseMs); r.timers.lease.unref?.(); };
      r.onAccept = (lease) => {
        r.lease = lease;
        att.leaseId = lease.id;
        att.outcome = 'running';
        clearTimeout(r.timers.answer);
        this._set(job, 'leased', { lease: { id: lease.id, expiresAt: lease.expiresAt, hardDeadline: lease.hardDeadline, limits: lease.limits } });
        armLease();
        armNoToken();
        // The worker's hard deadline plus a little slack for the network.
        const left = Math.max(0, lease.hardDeadline - this.now()) + 5000;
        r.timers.hard = setTimeout(() => r.fail(new ComputeError('timeout', 'the job passed the lease deadline')), left);
        r.timers.hard.unref?.();
      };
      r.onHeartbeat = () => { armLease(); if (job.state === 'leased') this._set(job, 'running'); };
      r.onToken = (text) => {
        armNoToken();
        armLease();
        if (job.state !== 'running') this._set(job, 'running');
        r.text += text;
        r.tokens++;
        options.onToken?.(text);
        this.bus?.live('job.token', { jobId: job.id, peerId, n: r.tokens });
      };
      this.remote.set(job.id, r);
      this._set(job, 'offered');
      // The worker gets the compact schema (no descriptions); the answer is validated here against the full one.
      const input = { ...job.input, messages, ...(job.input.schema ? { schema: compactSchema(job.input.schema) } : {}) };
      const sent = this.link.send(peerId, 'job.offer', { job: { id: job.id, type: 'inference', input, priority: job.priority, ...(job.taskId ? { taskId: job.taskId } : {}), ...(job.agentId ? { agentId: job.agentId } : {}) } });
      if (!sent) return r.fail(new ComputeError('disconnected', 'the session to the peer is closed'));
      r.timers.answer = setTimeout(() => r.fail(new ComputeError('disconnected', 'the peer did not answer the offer')), this.offerAnswerMs);
      r.timers.answer.unref?.();
    });
  }

  /** Messages from workers, routed to the attempt of their job. Anything from another peer is ignored. */
  handle(peerId, type, body) {
    let jobId;
    try { jobId = body?.jobId; } catch { return; }
    const r = this.remote.get(jobId);
    if (!r || r.peerId !== peerId) return;
    try {
      switch (type) {
        case 'job.accept': {
          const { lease } = readAccept(body);
          if (lease.jobId !== jobId) return;
          r.onAccept(lease);
          break;
        }
        case 'job.reject': {
          const m = readReject(body);
          r.fail(new ComputeError(m.code === 'busy' || m.code === 'rate_limited' ? 'busy' : m.code, `the peer refused: ${m.detail || m.code}`, { rejected: true }));
          break;
        }
        case 'job.heartbeat': {
          const m = readHeartbeat(body);
          if (r.lease && m.leaseId === r.lease.id) r.onHeartbeat(m);
          break;
        }
        case 'job.token': r.onToken(readToken(body).text); break;
        case 'job.result': {
          if (!r.lease) return;
          const { result } = readResult(body);
          r.ok(result);
          break;
        }
        case 'job.error': {
          const m = readError(body);
          r.fail(new ComputeError(m.code, m.message || m.code, m.partial ? { partial: m.partial } : {}));
          break;
        }
        case 'job.revoke': {
          const m = readRevoke(body);
          r.fail(new ComputeError('revoked', `the owner stopped the job: ${m.reason || 'revoked'}`));
          break;
        }
        default: break;
      }
    } catch { /* a malformed body is dropped */ }
  }

  onPeer(ev) {
    if (!ev?.peerId) return;
    for (const r of [...this.remote.values()]) {
      if (r.peerId !== ev.peerId) continue;
      if (ev.type === 'offline') {
        // 15 s to resume, then the job fails as disconnected (partial tokens kept). While the session is
        // known to be down, its silence is not a lease or token timeout.
        clearTimeout(r.timers.grace);
        clearTimeout(r.timers.lease);
        clearTimeout(r.timers.noToken);
        r.timers.grace = setTimeout(() => r.fail(new ComputeError('disconnected', 'the peer disconnected')), TIMES.resumeGraceMs);
        r.timers.grace.unref?.();
      } else if (ev.type === 'online' || ev.type === 'resumed') {
        clearTimeout(r.timers.grace);
        if (r.lease) { r.armLease(); r.armNoToken(); }
      } else if ((ev.type === 'grant.revoked' || ev.type === 'grant.expired' || ev.type === 'blocked') && (!ev.capability || ev.capability === CAPABILITY)) {
        r.fail(new ComputeError('revoked', ev.type === 'grant.expired' ? 'the grant to use that peer expired' : 'the peer revoked your access'));
      }
    }
    if (ev.type === 'offline') this.resources.forget?.(ev.peerId);
  }

  _final(job) {
    const rec = {
      role: 'requester', jobId: job.id, worker: job.worker, model: job.result?.model || job.input.model, state: job.state,
      attempts: job.attempts.map((a) => ({ worker: a.worker, outcome: a.outcome })), reason: job.decision?.reason,
      charsIn: job.input.messages.reduce((n, m) => n + m.content.length, 0),
      tokensOut: job.result?.completionTokens ?? job.partial?.completionTokens ?? 0,
      createdAt: job.createdAt, endedAt: job.endedAt || iso(this.now()), ...(job.error ? { error: job.error.code } : {})
    };
    this.bus?.emit('job.ended', rec);
    try { this.jobLog?.append(rec); } catch { /* best effort */ }
  }

  /** Jobs for the UI: no prompt text. */
  list() {
    return [...this.jobs.values()].map((j) => ({
      id: j.id, state: j.state, worker: j.worker, model: j.input.model, priority: j.priority, decision: j.decision,
      attempts: j.attempts, error: j.error, choices: j.choices, choiceDeadline: j.choiceDeadline ? iso(j.choiceDeadline) : undefined,
      lease: j.lease, partial: j.partial ? { completionTokens: j.partial.completionTokens, chars: j.partial.text.length } : undefined,
      createdAt: j.createdAt, endedAt: j.endedAt, taskId: j.taskId, agentId: j.agentId
    }));
  }

  close() {
    for (const r of [...this.remote.values()]) r.fail(new ComputeError('cancelled', 'shutting down'));
    for (const w of [...this.waitingChoice.values()]) w.resolve('cancel');
    for (const off of this._off) try { off?.(); } catch { /* ignore */ }
  }
}
