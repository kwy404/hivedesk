// The friend's last line of defense, inside the friend's own hivedesk server (started with
// --lend). The friend's browser already checks every request, but the server checks again
// before the local brain runs: same frame limits, same rate limit, one turn at a time, and
// nothing runs after lending was stopped. Only the counts are logged, never the prompt text.
//
// A grant (0.2.1) is what the friend agreed to lend in one pairing: a lease of at most `minutes`
// and `turns`, the models allowed (empty: any local model) and whether a cloud provider key of the
// friend may be used (off unless the friend turns it on for this grant). A lent turn never runs
// on a brain that is itself borrowed. Cancel and stop abort the running turn.

import { LIMITS, readMessages, readOptions, readResult, promptChars } from '../../ui/lend/core/frames.js';
import { RateLimiter, DEFAULT_RATE } from '../../ui/lend/core/ratelimit.js';

export class GuardError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GuardError';
    this.code = code;
  }
}

export const DEFAULT_GRANT = Object.freeze({ minutes: 60, turns: 200, models: Object.freeze([]), cloud: false });
const MAX_GRANT = { minutes: 24 * 60, turns: 5000 };

const clampInt = (v, min, max, dflt) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : dflt;
};

/** A clean grant from what the friend asked for, over the defaults. */
export function cleanGrant(g = {}, base = DEFAULT_GRANT) {
  const src = g && typeof g === 'object' ? g : {};
  const models = Array.isArray(src.models) ? src.models : base.models;
  return {
    minutes: clampInt(src.minutes, 1, MAX_GRANT.minutes, base.minutes),
    turns: clampInt(src.turns, 1, MAX_GRANT.turns, base.turns),
    models: [...new Set(models.map((m) => String(m ?? '').trim().slice(0, 120)).filter(Boolean))].slice(0, 16),
    cloud: typeof src.cloud === 'boolean' ? src.cloud : !!base.cloud
  };
}

/** The model name of a brain, for the allowlist. */
export function brainModel(brain) {
  try { return String(brain?.info?.()?.model || brain?.model || '').trim(); } catch { return ''; }
}

/** Can this brain take a lent turn under this grant? */
export function lendable(brain, grant) {
  if (!brain || brain.kind === 'remote') return false;
  if (brain.kind === 'cloud' && !grant.cloud) return false;
  if (grant.models.length && !grant.models.includes(brainModel(brain))) return false;
  return true;
}

/**
 * chat: (messages, options, { signal, accept }) => Promise<ChatResult>, the friend's local brain.
 *   chat.brains, when present, lists the brains it may pick from (to refuse early when none fits).
 * emit: (type, data) => void, appends a lend.* event.
 */
export function createLendGuard({ chat, emit = () => {}, limits = LIMITS, rate = DEFAULT_RATE, now = () => Date.now(), grant = DEFAULT_GRANT, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const limiter = new RateLimiter({ ...rate, now });
  let lending = true;
  let busy = null; // { requestId, ctrl }
  let served = 0;
  let refused = 0;
  let current = cleanGrant(grant);
  let lease = null; // { startedAt, expiresAt, turns, ended: null | 'time' | 'turns' }
  let leaseTimer = null;

  const refuse = (code, message, extra) => {
    refused++;
    emit('lend.refused', { reason: code, ...extra });
    throw new GuardError(code, message);
  };

  const endLease = (reason) => {
    if (!lease || lease.ended) return;
    lease.ended = reason;
    clearTimer(leaseTimer);
    leaseTimer = null;
    busy?.ctrl.abort();
    emit('lend.expired', { reason, turns: lease.turns });
  };

  const startLease = () => {
    clearTimer(leaseTimer);
    const t = now();
    lease = { startedAt: t, expiresAt: t + current.minutes * 60_000, turns: 0, ended: null };
    leaseTimer = setTimer(() => endLease('time'), current.minutes * 60_000);
    leaseTimer?.unref?.();
  };

  const dropLease = () => {
    clearTimer(leaseTimer);
    leaseTimer = null;
    lease = null;
  };

  const accept = (brain) => lendable(brain, current);

  async function handle(data) {
    if (typeof chat !== 'function') throw new GuardError('not_lending', 'No local brain to lend');
    let messages;
    let options;
    try {
      messages = readMessages(data?.messages, limits);
      options = readOptions(data?.options, limits);
    } catch (err) {
      return refuse(err.code || 'bad_request', err.message, {});
    }
    const chars = promptChars(messages);
    const extra = { messages: messages.length, chars };
    if (!lending) return refuse('stopped', 'Lending is stopped', extra);
    if (!lease) startLease();
    if (!lease.ended && now() >= lease.expiresAt) endLease('time');
    if (!lease.ended && lease.turns >= current.turns) endLease('turns');
    if (lease.ended) return refuse('expired', `This lend ended (${lease.ended === 'time' ? `${current.minutes} minutes` : `${current.turns} turns`}); pair again to lend more`, extra);
    if (busy) return refuse('busy', 'One request at a time', extra);
    if (typeof chat.brains === 'function' && !chat.brains().some(accept)) {
      return refuse('no_model', current.cloud ? 'No model on this PC is allowed for lending' : 'No local model on this PC is allowed for lending (cloud keys are not lent)', extra);
    }
    const gate = limiter.take(chars);
    if (!gate.ok) return refuse('rate_limited', `Rate limit reached (${gate.reason}), retry in ${Math.ceil(gate.retryInMs / 1000)} s`, extra);
    const job = { requestId: typeof data?.requestId === 'string' ? data.requestId.slice(0, 64) : null, ctrl: new AbortController() };
    busy = job;
    lease.turns++;
    const started = now();
    try {
      const raw = await chat(messages, options, { signal: job.ctrl.signal, accept });
      if (job.ctrl.signal.aborted) throw new GuardError('cancelled', 'The request was cancelled');
      const result = readResult(raw, limits);
      served++;
      emit('lend.served', { ...extra, completionTokens: result.completionTokens, ms: result.ms || now() - started });
      return result;
    } catch (err) {
      if (job.ctrl.signal.aborted) {
        emit('lend.cancelled', extra);
        throw err instanceof GuardError ? err : new GuardError('cancelled', 'The request was cancelled');
      }
      throw err;
    } finally {
      if (busy === job) busy = null;
    }
  }

  return {
    handle,
    /** Aborts the running turn (when requestId is missing or matches it). */
    cancel(requestId) {
      if (!busy) return false;
      if (requestId && busy.requestId && busy.requestId !== requestId) return false;
      busy.ctrl.abort();
      return true;
    },
    stop(reason = 'stopped') {
      busy?.ctrl.abort();
      if (!lending) return;
      lending = false;
      dropLease();
      emit('lend.stopped', { reason });
    },
    resume() {
      if (lending) return;
      lending = true;
      dropLease();
      emit('lend.resumed', {});
    },
    /** Sets what the next lease lends (minutes, turns, models, cloud); a running lease starts over. */
    setGrant(g) {
      current = cleanGrant(g, current);
      dropLease();
      emit('lend.grant', { minutes: current.minutes, turns: current.turns, models: current.models.length, cloud: current.cloud });
      return { ...current, models: [...current.models] };
    },
    grant: () => ({ ...current, models: [...current.models] }),
    close() { busy?.ctrl.abort(); dropLease(); },
    status: () => ({
      lending, busy: !!busy, served, refused, usage: limiter.usage(), perMinute: limiter.perMinute,
      limits: { promptChars: limits.promptChars, maxTokens: limits.maxTokens },
      grant: { ...current, models: [...current.models] },
      lease: lease ? { turns: lease.turns, expiresAt: new Date(lease.expiresAt).toISOString(), ended: lease.ended } : null
    }),
  };
}
