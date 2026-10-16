// The friend's last line of defense, inside the friend's own hivedesk server (started with
// --lend). The friend's browser already checks every request, but the server checks again
// before the local brain runs: same frame limits, same rate limit, one turn at a time, and
// nothing runs after lending was stopped. Only the counts are logged, never the prompt text.

import { LIMITS, readMessages, readOptions, readResult, promptChars } from '../../ui/lend/core/frames.js';
import { RateLimiter, DEFAULT_RATE } from '../../ui/lend/core/ratelimit.js';

export class GuardError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GuardError';
    this.code = code;
  }
}

/**
 * chat: (messages, options) => Promise<ChatResult>, the friend's local brain.
 * emit: (type, data) => void, appends a lend.* event.
 */
export function createLendGuard({ chat, emit = () => {}, limits = LIMITS, rate = DEFAULT_RATE, now = () => Date.now() }) {
  const limiter = new RateLimiter({ ...rate, now });
  let lending = true;
  let busy = false;
  let served = 0;
  let refused = 0;

  const refuse = (code, message, extra) => {
    refused++;
    emit('lend.refused', { reason: code, ...extra });
    throw new GuardError(code, message);
  };

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
    if (busy) return refuse('busy', 'One request at a time', extra);
    const gate = limiter.take(chars);
    if (!gate.ok) return refuse('rate_limited', `Rate limit reached (${gate.reason}), retry in ${Math.ceil(gate.retryInMs / 1000)} s`, extra);
    busy = true;
    const started = now();
    try {
      const result = readResult(await chat(messages, options), limits);
      served++;
      emit('lend.served', { ...extra, completionTokens: result.completionTokens, ms: result.ms || now() - started });
      return result;
    } finally {
      busy = false;
    }
  }

  return {
    handle,
    stop(reason = 'stopped') {
      if (!lending) return;
      lending = false;
      emit('lend.stopped', { reason });
    },
    resume() {
      if (lending) return;
      lending = true;
      emit('lend.resumed', {});
    },
    status: () => ({ lending, busy, served, refused, usage: limiter.usage(), perMinute: limiter.perMinute, limits: { promptChars: limits.promptChars, maxTokens: limits.maxTokens } }),
  };
}
