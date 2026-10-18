// Every wait has a deadline (PLAN.md section 8). Nothing loads forever.

export class DeadlineError extends Error {
  constructor(message = 'the deadline passed', code = 'timeout') {
    super(message);
    this.code = code;
  }
}

/**
 * A deadline `ms` from now.
 * @param {number} ms
 * @param {{ now?: () => number }} [opts]
 */
export function createDeadline(ms, opts = {}) {
  const now = opts.now || Date.now;
  const span = Math.max(0, Number(ms) || 0);
  const at = now() + span;
  return {
    at,
    ms: span,
    iso: new Date(at).toISOString(),
    remaining: () => Math.max(0, at - now()),
    expired: () => now() >= at
  };
}

/** The ISO time `ms` from now, for `waitingFor.deadline` in tasks. */
export function isoIn(ms, now = Date.now) {
  return new Date(now() + Math.max(0, Number(ms) || 0)).toISOString();
}

/** Milliseconds left until an ISO deadline (0 when passed, Infinity when there is none). */
export function msUntil(iso, now = Date.now) {
  if (!iso) return Infinity;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, t - now()) : Infinity;
}

/**
 * Runs `work` with a deadline. `work` gets an AbortSignal that aborts at the deadline or when `signal` aborts.
 * Rejects with a DeadlineError (code "timeout") when the deadline passes first.
 * @template T
 * @param {(signal: AbortSignal) => Promise<T> | T} work
 * @param {number} ms
 * @param {{ signal?: AbortSignal, message?: string, code?: string }} [opts]
 * @returns {Promise<T>}
 */
export function withDeadline(work, ms, opts = {}) {
  const ctrl = new AbortController();
  const outer = opts.signal;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      outer?.removeEventListener?.('abort', onAbort);
      fn(v);
    };
    const timer = setTimeout(() => {
      const err = new DeadlineError(opts.message || `no answer within ${Math.round(ms / 1000)} s`, opts.code || 'timeout');
      ctrl.abort(err);
      finish(reject, err);
    }, Math.max(0, ms));
    timer.unref?.();
    const onAbort = () => {
      const err = new DeadlineError('cancelled', 'cancelled');
      ctrl.abort(err);
      finish(reject, err);
    };
    if (outer) {
      if (outer.aborted) return onAbort();
      outer.addEventListener('abort', onAbort, { once: true });
    }
    Promise.resolve().then(() => work(ctrl.signal)).then((v) => finish(resolve, v), (err) => finish(reject, err));
  });
}
