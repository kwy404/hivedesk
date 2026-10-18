// Who caused an event or a command (PLAN.md section 1.3).
// origin: { kind: "user" | "crew" | "system" | "peer", peerId?, agentId? }
// Old events without an origin replay as "system".
import { AsyncLocalStorage } from 'node:async_hooks';

export const ORIGIN_KINDS = Object.freeze(['user', 'crew', 'system', 'peer']);
export const SYSTEM = Object.freeze({ kind: 'system' });
export const USER = Object.freeze({ kind: 'user' });

const ID = /^[A-Za-z0-9_.:-]{1,80}$/;

/** A clean origin: unknown kinds become system, ids are short safe strings, other fields are dropped. */
export function normalizeOrigin(o) {
  if (!o || typeof o !== 'object' || !ORIGIN_KINDS.includes(o.kind)) return { kind: 'system' };
  const out = { kind: o.kind };
  if (o.kind === 'peer') {
    if (typeof o.peerId !== 'string' || !ID.test(o.peerId)) return { kind: 'system' };
    out.peerId = o.peerId;
  }
  if (typeof o.agentId === 'string' && ID.test(o.agentId)) out.agentId = o.agentId;
  return out;
}

export const userOrigin = () => ({ kind: 'user' });
export const crewOrigin = (agentId) => normalizeOrigin({ kind: 'crew', agentId });
export const peerOrigin = (peerId, agentId) => normalizeOrigin({ kind: 'peer', peerId, agentId });

/** The origin of a logged event; events written before 1.0 have none and count as system. */
export function originOf(event) {
  return event && event.origin ? normalizeOrigin(event.origin) : { kind: 'system' };
}

/** A short label for history lines: "user", "system", "crew:dev", "peer:hd1abc". */
export function originLabel(o) {
  const x = normalizeOrigin(o);
  if (x.kind === 'peer') return `peer:${x.peerId}${x.agentId ? `/${x.agentId}` : ''}`;
  if (x.kind === 'crew') return x.agentId ? `crew:${x.agentId}` : 'crew';
  return x.kind;
}

// ---- the current origin of async work ----
// The command router runs a handler inside runWithOrigin; every event emitted by that handler,
// and by the async work it starts, carries the origin and the cause unless the emitter says otherwise.
const als = new AsyncLocalStorage();

/**
 * @template T
 * @param {{ kind: string, peerId?: string, agentId?: string }} origin
 * @param {() => T} fn
 * @param {number | string} [cause] the seq of the event, or the id of the command, that caused this work
 * @returns {T}
 */
export function runWithOrigin(origin, fn, cause) {
  const ctx = { origin: normalizeOrigin(origin) };
  if (cause !== undefined && cause !== null) ctx.cause = cause;
  return als.run(ctx, fn);
}

/** @returns {{ origin: object, cause?: number | string } | undefined} */
export function currentContext() {
  return als.getStore();
}
