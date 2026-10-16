// Rate limit for lent model turns: a sliding window over the last minute that counts requests
// and prompt characters. The friend's side checks every request before it reaches the brain,
// in the browser and again in the friend's hivedesk server, so a host cannot flood the PC.

export const DEFAULT_RATE = Object.freeze({ perMinute: 20, charsPerMinute: 400000, windowMs: 60000 });

export class RateLimiter {
  constructor({ perMinute = DEFAULT_RATE.perMinute, charsPerMinute = DEFAULT_RATE.charsPerMinute, windowMs = DEFAULT_RATE.windowMs, now = () => Date.now() } = {}) {
    this.perMinute = perMinute;
    this.charsPerMinute = charsPerMinute;
    this.windowMs = windowMs;
    this.now = now;
    this.hits = []; // [{ at, cost }], oldest first
  }

  _trim(t) {
    while (this.hits.length && this.hits[0].at <= t - this.windowMs) this.hits.shift();
  }

  /** Usage inside the current window. */
  usage() {
    this._trim(this.now());
    return { requests: this.hits.length, chars: this.hits.reduce((n, h) => n + h.cost, 0) };
  }

  /**
   * Takes one request of `cost` prompt characters. Returns { ok: true } and records it, or
   * { ok: false, reason: 'requests' | 'chars', retryInMs } and records nothing.
   */
  take(cost = 0) {
    const t = this.now();
    this._trim(t);
    const used = this.hits.reduce((n, h) => n + h.cost, 0);
    const retry = () => Math.max(1, (this.hits[0]?.at ?? t) + this.windowMs - t);
    if (this.hits.length >= this.perMinute) return { ok: false, reason: 'requests', retryInMs: retry() };
    if (cost > this.charsPerMinute) return { ok: false, reason: 'chars', retryInMs: this.windowMs };
    if (used + cost > this.charsPerMinute) {
      let freed = used;
      let at = t;
      for (const h of this.hits) {
        freed -= h.cost;
        at = h.at + this.windowMs;
        if (freed + cost <= this.charsPerMinute) break;
      }
      return { ok: false, reason: 'chars', retryInMs: Math.max(1, at - t) };
    }
    this.hits.push({ at: t, cost });
    return { ok: true };
  }
}
