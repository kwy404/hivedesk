// A fake brain for tests and the demo. It never loads a model.
import { estimateTokens, messagesChars } from './types.js';

/**
 * @param {{
 *   id?: string, label?: string,
 *   respond: (messages: import('./types.js').Message[], options: any, n: number) => any | Promise<any>,
 *   delayMs?: number, tokenDelayMs?: number, model?: string
 * }} opts
 *  `respond` returns a string or an object (sent as JSON text).
 * @returns {import('./types.js').Brain & { calls: any[] }}
 */
export function createFakeBrain(opts) {
  const calls = [];
  let n = 0;
  const brain = {
    id: opts.id || 'fake',
    label: opts.label || 'Scripted fake brain',
    kind: 'local',
    calls,
    info: () => ({ backend: 'fake', model: opts.model || 'scripted' }),
    async chat(messages, options = {}) {
      const started = Date.now();
      calls.push({ messages, options: { schema: options.schema, maxTokens: options.maxTokens } });
      const out = await opts.respond(messages, options, n++);
      const text = typeof out === 'string' ? out : JSON.stringify(out);
      if (opts.delayMs) await sleep(opts.delayMs, options.signal);
      if (options.onToken) {
        const step = Math.max(8, Math.ceil(text.length / 24));
        for (let i = 0; i < text.length; i += step) {
          if (options.signal?.aborted) break;
          options.onToken(text.slice(i, i + step));
          if (opts.tokenDelayMs) await sleep(opts.tokenDelayMs, options.signal);
        }
      }
      if (options.signal?.aborted) throw new Error('aborted');
      const result = {
        text,
        promptTokens: estimateTokens('x'.repeat(messagesChars(messages))),
        completionTokens: estimateTokens(text),
        ms: Math.max(1, Date.now() - started),
        model: opts.model || 'scripted'
      };
      if (options.schema) {
        try { result.json = typeof out === 'string' ? JSON.parse(out) : out; } catch { /* the caller validates */ }
      }
      return result;
    }
  };
  return brain;
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}
