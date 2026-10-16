// One structured model turn for Mel, through the shared fair scheduler, with a time limit.
// Resolves to the parsed JSON, or null when no model is ready, it is too slow or it fails:
// every caller has a rule based fallback, so the model is a help, never a requirement.

export function melAsk(scheduler, { timeoutMs = 45_000, maxTokens = 500 } = {}) {
  if (!scheduler || typeof scheduler.turn !== 'function') return null;
  return async (messages, schema) => {
    if (!scheduler.hasBrain) return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    timer.unref?.();
    try {
      const r = await scheduler.turn({ workerId: 'mel', messages, options: { schema, maxTokens, temperature: 0.2 }, signal: ctrl.signal });
      if (r?.json !== undefined) return r.json;
      try { return JSON.parse(r?.text || ''); } catch { return null; }
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}
