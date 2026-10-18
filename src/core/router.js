// The command router (PLAN.md section 1.3): one place maps a command to its handler and checks
// authz(origin, command) in Node. The browser's roles.js check is a UX hint only.
//   user    a local token holder: the person at this machine. Every command.
//   system  the engine itself. Every command.
//   crew    an agent of this engine. Every command (in process only).
//   peer    another engine, through src/p2p/ with a verified peerId. Only commands that name a capability,
//           and only while the grant checker (set by src/p2p/) says this peer holds that capability.
import { validate } from './schema.js';
import { normalizeOrigin, runWithOrigin } from './origin.js';

export class CommandError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * The capability a peer needs for the 0.2 commands that a peer may ever send (PLAN.md section 2, CapabilityName).
 * A module can set its own with the `peer` field of the command spec. Commands not listed here are local only.
 */
export const DEFAULT_PEER_CAPS = Object.freeze({
  ping: 'city.view',
  'city.state': 'city.view',
  'city.sync': 'city.view',
  'city.presence': 'city.view',
  'tasks.list': 'city.view',
  'tasks.get': 'city.view',
  'city.task.create': 'city.member',
  'city.task.assign': 'city.member',
  'city.task.move': 'city.member',
  'city.task.approve': 'city.member',
  'city.task.reject': 'city.member',
  'city.task.retry': 'city.member',
  'city.task.cancel': 'city.member',
  'city.agent.update': 'city.member',
  'city.agent.move': 'city.member',
  'city.agent.retire': 'city.member',
  'city.agent.wake': 'city.member',
  'city.agent.memory.list': 'city.member',
  'city.agent.memory.add': 'city.member',
  'city.agent.memory.update': 'city.member',
  'city.agent.memory.delete': 'city.member',
  'city.machine.join': 'city.member',
  'city.machine.update': 'city.member',
  'city.machine.leave': 'city.member',
  'city.borrow.request': 'city.member',
  'city.borrow.answer': 'city.member',
  'city.borrow.stop': 'city.member',
  'tasks.create': 'city.member',
  'tasks.retry': 'city.member',
  'tasks.cancel': 'city.member',
  'chat.send': 'chat',
  'files.list': 'workspace.read',
  'files.read': 'workspace.read'
});

/** The commands a peer with only city.view may send (src/p2p/ takes them as its viewCommands). */
export const PEER_VIEW_COMMANDS = Object.freeze(Object.entries(DEFAULT_PEER_CAPS).filter(([, c]) => c === 'city.view').map(([t]) => t));

/** Command families no peer may ever reach, whatever their spec says (the owner's own controls). */
export const LOCAL_ONLY_PREFIXES = Object.freeze(['compute.', 'store.', 'brain.', 'provider.', 'settings.']);
const localOnly = (type) => LOCAL_ONLY_PREFIXES.some((p) => type.startsWith(p));

const PEER_WINDOW_MS = 10_000;
const PEER_COMMANDS = 40;

/**
 * @typedef {{
 *   peer?: string | null | ((data: object) => string | null),
 *   schema?: object,
 *   local?: boolean,
 *   noRate?: boolean
 * }} CommandSpec
 * peer: the capability a peer needs (null: never a peer). Without the field, DEFAULT_PEER_CAPS decides.
 * local: true refuses every origin except user and system, even with a capability listed.
 * schema: the data schema (src/core/schema.js); a mismatch is a bad_request before the handler runs.
 */

/**
 * @param {{ now?: () => number }} [opts]
 */
export function createRouter(opts = {}) {
  const now = opts.now || Date.now;
  /** @type {Map<string, { handler: Function, spec: CommandSpec }>} */
  const commands = new Map();
  /** @type {(peerId: string, capability: string, ctx: { type: string, data: object }) => boolean} */
  let grantChecker = () => false;
  const rates = new Map();
  const listeners = new Set();
  let seq = 0;

  function register(type, handler, spec = {}) {
    if (typeof type !== 'string' || !/^[a-z][a-zA-Z0-9_.-]{0,80}$/.test(type)) throw new Error(`bad command name ${type}`);
    if (typeof handler !== 'function') throw new Error(`command ${type} needs a handler`);
    commands.set(type, { handler, spec: spec || {} });
  }

  /** The capability a peer needs for this command, or null when no peer may send it. */
  function capabilityFor(type, data) {
    const entry = commands.get(type);
    if (!entry) return null;
    const { spec } = entry;
    if (spec.local || localOnly(type)) return null;
    const p = 'peer' in spec ? spec.peer : DEFAULT_PEER_CAPS[type] ?? null;
    if (typeof p === 'function') {
      try { return p(data) || null; } catch { return null; }
    }
    return typeof p === 'string' ? p : null;
  }

  /**
   * @returns {{ ok: true, capability?: string } | { ok: false, code: string, message: string, capability?: string }}
   */
  function authz(origin, type, data = {}) {
    const o = normalizeOrigin(origin);
    if (!commands.has(type)) return { ok: false, code: 'bad_request', message: `unknown command: ${type}` };
    if (o.kind === 'user' || o.kind === 'system' || o.kind === 'crew') return { ok: true };
    const capability = capabilityFor(type, data);
    if (!capability) return { ok: false, code: 'forbidden', message: `${type} is not open to peers` };
    let granted = false;
    try { granted = grantChecker(o.peerId, capability, { type, data }) === true; } catch { granted = false; }
    if (!granted) return { ok: false, code: 'not_granted', message: `${type} needs the ${capability} capability`, capability };
    return { ok: true, capability };
  }

  function rateOk(peerId) {
    const t = now();
    const list = (rates.get(peerId) || []).filter((x) => t - x < PEER_WINDOW_MS);
    if (list.length >= PEER_COMMANDS) { rates.set(peerId, list); return false; }
    list.push(t);
    rates.set(peerId, list);
    return true;
  }

  function notify(rec) {
    for (const fn of listeners) { try { fn(rec); } catch { /* an audit listener must not break a command */ } }
  }

  /**
   * Runs a command. The handler gets (data, client, ctx) with ctx = { origin, commandId, capability }.
   * Events the handler emits carry the origin, and the command id as their cause.
   * @param {string} type
   * @param {any} data
   * @param {{ origin?: object, client?: any, peerName?: string }} [ctx]
   */
  async function dispatch(type, data, ctx = {}) {
    const origin = normalizeOrigin(ctx.origin || { kind: 'user' });
    let d = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    const decision = authz(origin, type, d);
    const commandId = `cm_${(++seq).toString(36)}`;
    const record = { commandId, type, origin, ts: new Date(now()).toISOString() };
    if (!decision.ok) {
      notify({ ...record, ok: false, code: decision.code });
      throw new CommandError(decision.code, decision.message);
    }
    if (origin.kind === 'peer') {
      if (!commands.get(type).spec.noRate && !rateOk(origin.peerId)) {
        notify({ ...record, ok: false, code: 'rate_limited' });
        throw new CommandError('rate_limited', 'too many commands, wait a few seconds');
      }
      // The identity of a peer comes from its verified session, never from the data it sends.
      const { as: _ignored, ...rest } = d;
      d = { ...rest, as: { id: origin.peerId, name: typeof ctx.peerName === 'string' ? ctx.peerName.slice(0, 40) : 'Friend', verified: true } };
    }
    const { handler, spec } = commands.get(type);
    if (spec.schema) {
      const errors = validate(spec.schema, d, type);
      if (errors.length) {
        notify({ ...record, ok: false, code: 'bad_request' });
        throw new CommandError('bad_request', errors.slice(0, 3).join('; '));
      }
    }
    try {
      const result = await runWithOrigin(origin, () => handler(d, ctx.client || null, { origin, commandId, capability: decision.capability }), commandId);
      notify({ ...record, ok: true });
      return result;
    } catch (err) {
      notify({ ...record, ok: false, code: typeof err?.code === 'string' ? err.code : 'internal' });
      throw err;
    }
  }

  return {
    register,
    dispatch,
    authz,
    capabilityFor,
    has: (type) => commands.has(type),
    list: () => [...commands.keys()].sort().map((type) => ({ type, peer: capabilityFor(type, {}) })),
    /** Set by src/p2p/: does this peer hold this capability right now (granted, not expired, not revoked)? */
    setGrantChecker(fn) { grantChecker = typeof fn === 'function' ? fn : () => false; },
    /** Every dispatched command, allowed or refused, for the audit log. Returns an unsubscribe function. */
    onCommand(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  };
}
