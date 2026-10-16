// A remote brain reached through a WebSocket client (the lend UI). PROTOCOL.md section 6.
import { validate, extractJson } from './schema.js';

export const RELAY_TIMEOUT = 180_000;
let n = 0;

/**
 * @param {{ id: string, label: string, model?: string, send: (frame: object) => void, timeoutMs?: number }} opts
 */
export function createRelayBrain(opts) {
  /** @type {Map<string, { resolve: Function, reject: Function, onToken?: Function, timer: any, started: number }>} */
  const pending = new Map();
  const timeoutMs = opts.timeoutMs || RELAY_TIMEOUT;

  const brain = {
    id: opts.id,
    label: opts.label,
    kind: 'remote',
    info: () => ({ backend: 'remote', model: opts.model, label: opts.label }),
    chat(messages, options = {}) {
      const requestId = `r_${Date.now().toString(36)}_${++n}`;
      const wire = {};
      for (const k of ['schema', 'maxTokens', 'temperature']) if (options[k] !== undefined) wire[k] = options[k];
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          try { opts.send({ kind: 'brain.cancel', brainId: opts.id, requestId }); } catch { /* closed */ }
          reject(Object.assign(new Error('the remote brain did not answer in time'), { code: 'timeout' }));
        }, timeoutMs);
        timer.unref?.();
        pending.set(requestId, { resolve, reject, onToken: options.onToken, timer, started: Date.now(), schema: options.schema });
        options.signal?.addEventListener('abort', () => {
          if (!pending.has(requestId)) return;
          clearTimeout(timer);
          pending.delete(requestId);
          try { opts.send({ kind: 'brain.cancel', brainId: opts.id, requestId }); } catch { /* closed */ }
          reject(new Error('aborted'));
        }, { once: true });
        try {
          opts.send({ kind: 'brain.request', brainId: opts.id, requestId, messages, options: wire });
        } catch (err) {
          clearTimeout(timer);
          pending.delete(requestId);
          reject(err);
        }
      });
    },
    /** Called by the server on a `brain.respond` command. */
    respond(requestId, ok, result, error) {
      const p = pending.get(requestId);
      if (!p) return false;
      clearTimeout(p.timer);
      pending.delete(requestId);
      if (!ok) {
        p.reject(new Error(error || 'the remote brain failed'));
        return true;
      }
      const r = result || {};
      const text = typeof r.text === 'string' ? r.text : '';
      const out = {
        text,
        promptTokens: Number(r.promptTokens) || 0,
        completionTokens: Number(r.completionTokens) || 0,
        ms: Number(r.ms) || Date.now() - p.started,
        model: r.model || opts.model
      };
      if (p.schema) {
        const json = r.json !== undefined ? r.json : extractJson(text);
        const errors = json === undefined ? ['not JSON'] : validate(p.schema, json);
        if (errors.length) {
          p.reject(Object.assign(new Error(`remote answer did not match the schema: ${errors[0]}`), { code: 'invalid_json' }));
          return true;
        }
        out.json = json;
      }
      p.resolve(out);
      return true;
    },
    token(requestId, text) {
      const p = pending.get(requestId);
      if (p && p.onToken && typeof text === 'string') p.onToken(text);
    },
    /** Rejects everything pending (the socket closed). */
    async close() {
      for (const [id, p] of pending) {
        clearTimeout(p.timer);
        p.reject(new Error('the remote brain disconnected'));
        pending.delete(id);
      }
    },
    get pendingCount() { return pending.size; }
  };
  return brain;
}
