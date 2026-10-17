// Lend your PC, server side (PROTOCOL.md section 6, "Server side plug-in").
// The engine calls register() at start. On a hivedesk started with --lend it adds:
//   lend.chat    the guarded way for the friend's browser to run one turn on the local brain
//   lend.cancel  aborts the running lent turn (the host cancelled it)
//   lend.grant   what one pairing lends: { minutes, turns, models, cloud } (guard.js)
//   brain.chat   the engine's older entry, routed through the same guard
//   lend.log     the friend's browser records what it did with a request (counts only)
//   lend.stop    stop lending: every later lend.chat is refused
//   lend.resume  lend again after a stop (a new pairing in the same run)
//   lend.status  counters for the Lend screen
//   lend.enable  lend from a hivedesk started without --lend (a Code together guest who
//                also lends its brain to the host); only this PC's own browser can send it
//   GET /api/lend the same counters over REST
// It also loads Code together (src/collab/), which adds files.write for the Code editor.
// On the host nothing is needed here: the remote brain rides the engine's brain.attach,
// brain.request and brain.respond frames.

import { createLendGuard, lendable } from './guard.js';
import registerCollab from '../collab/index.js';

const LOG_STATUSES = new Set(['running', 'done', 'refused', 'failed', 'cancelled', 'stopped']);
const num = (v) => (Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined);

/**
 * Picks the local brain's chat function from whatever the engine hands the plug-in.
 * The chat takes (messages, options, { signal, accept }): signal aborts the turn, accept(brain)
 * says which brains may run it (guard.js: local models of this PC, the allowlist, cloud only when granted).
 */
export function findLocalChat(ctx) {
  const candidates = [ctx.chatLocal, ctx.brain, ctx.localBrain, ctx.scheduler?.localBrain, ctx.scheduler?.local];
  for (const c of candidates) {
    if (typeof c === 'function') return c;
    if (c && typeof c.chat === 'function') {
      const chat = (messages, options, run = {}) => c.chat(messages, run.signal ? { ...options, signal: run.signal } : options);
      chat.brains = () => [c];
      return chat;
    }
  }
  // The engine's own scheduler: a lent turn waits in the same fair queue as the friend's crew,
  // and runs only on a brain the grant accepts.
  if (typeof ctx.scheduler?.turn === 'function') {
    const chat = (messages, options, run = {}) => ctx.scheduler.turn({ workerId: 'lend:friend', messages, options, signal: run.signal, accept: run.accept });
    if (ctx.scheduler.brains instanceof Map) chat.brains = () => [...ctx.scheduler.brains.values()].map((slot) => slot.brain);
    return chat;
  }
  if (typeof ctx.scheduler?.getLocalBrain === 'function') {
    return async (messages, options, run = {}) => {
      const brain = await ctx.scheduler.getLocalBrain();
      if (!brain) throw Object.assign(new Error('No local model is ready'), { code: 'busy' });
      if (run.accept && !run.accept(brain)) throw Object.assign(new Error('No local model on this PC is allowed for lending'), { code: 'no_model' });
      return brain.chat(messages, run.signal ? { ...options, signal: run.signal } : options);
    };
  }
  return null;
}

export { lendable };

/** Keeps only counts and short codes from a browser log entry. Prompt text never reaches the log. */
export function cleanLogEntry(e) {
  if (!e || typeof e !== 'object' || !LOG_STATUSES.has(e.status)) return null;
  const out = { id: String(e.id ?? '-').slice(0, 64), status: e.status };
  for (const k of ['messages', 'chars', 'maxTokens', 'completionTokens', 'ms']) {
    const v = num(e[k]);
    if (v !== undefined) out[k] = v;
  }
  if (typeof e.reason === 'string') out.reason = e.reason.slice(0, 40);
  if (e.status === 'stopped' && typeof e.message === 'string') out.message = e.message.slice(0, 200);
  return out;
}

export default function register(ctx) {
  const { bus, server, config = {} } = ctx;
  const emit = (type, data) => bus?.emit?.(type, data);
  const chat = findLocalChat(ctx);
  const guard = createLendGuard({ chat, emit, grant: config.lendGrant });
  // guarded: lend.chat can reach the local brain. When false the browser uses the engine's brain.chat.
  let lending = !!config.lend;
  const status = () => ({ lend: lending, guarded: !!chat, ...guard.status() });

  const onlyLend = () => {
    if (!lending) throw Object.assign(new Error('This hivedesk was not started with --lend'), { code: 'not_lending' });
  };

  server?.command?.('lend.status', () => status());
  server?.command?.('lend.enable', () => {
    lending = true;
    guard.resume();
    return status();
  });
  server?.command?.('lend.chat', (data) => {
    onlyLend();
    return guard.handle(data);
  });
  // The older entry the Lend screen used when it was not guarded: the same checks now.
  server?.command?.('brain.chat', (data) => {
    onlyLend();
    return guard.handle(data);
  });
  server?.command?.('lend.cancel', (data) => {
    onlyLend();
    return { cancelled: guard.cancel(typeof data?.requestId === 'string' ? data.requestId.slice(0, 64) : null) };
  });
  server?.command?.('lend.grant', (data) => {
    onlyLend();
    return { grant: guard.setGrant(data) };
  });
  server?.command?.('lend.log', (data) => {
    onlyLend();
    const entry = cleanLogEntry(data);
    if (entry && entry.status !== 'running') emit('lend.request', entry);
    return {};
  });
  server?.command?.('lend.stop', (data) => {
    onlyLend();
    guard.stop(typeof data?.reason === 'string' ? data.reason.slice(0, 200) : 'stopped');
    return status();
  });
  server?.command?.('lend.resume', () => {
    onlyLend();
    guard.resume();
    return status();
  });
  server?.route?.('GET', '/api/lend', (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(status()));
  });
  registerCollab(ctx);
  return { guard, status };
}
