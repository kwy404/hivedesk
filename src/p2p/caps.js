// Capabilities and grants (PLAN 2, principle 4: default deny). Every power a peer has here is a
// Grant of one named capability, made by a person, time limited, revocable and audited.
//
// The compute resources are separate capabilities, each with its own limits:
//   compute.gpu      { maxVramBytes, gpus: ["0", "1"] (empty: any), maxUtilPct }
//   compute.cpu      { maxThreads, maxLoadPct }
//   compute.ram      { maxBytes }
//   compute.storage  { maxBytes, modelDownload }
//   compute.pool     { maxLeaseMinutes, maxLeases }   layers of a pooled model over llama.cpp RPC
// compute.inference is the right to send inference jobs; a job may only use the resources
// granted beside it (effectiveCompute below). The worker (src/compute/) enforces the numbers.

import crypto from 'node:crypto';
import { base32 } from './encoding.js';

export class CapError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CapError';
    this.code = code;
  }
}

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const GB = 1024 ** 3;

const int = (min, max, def) => ({ kind: 'int', min, max, def });
const bool = (def) => ({ kind: 'bool', def });
const list = (max, re) => ({ kind: 'list', max, re });
const id = (re) => ({ kind: 'id', re });
const oneOf = (values, def) => ({ kind: 'enum', values, def });
const CLIP_DIRS = ['off', 'to_viewer', 'to_host', 'both'];

/**
 * The catalog. standing: may outlive a session. open: on a known peer the grant may have no
 * expiry (city.view and chat only). minutes: [default, max] for the grant's lifetime;
 * choices: the only lifetimes allowed.
 */
export const CAPABILITIES = Object.freeze({
  'city.view': { standing: true, open: true, minutes: [7 * 24 * 60, 30 * 24 * 60], limits: {} },
  'city.member': { standing: true, minutes: [7 * 24 * 60, 30 * 24 * 60], limits: { maxAgents: int(0, 4, 2) } },
  'workspace.read': { standing: true, minutes: [60, 30 * 24 * 60], limits: {} },
  'workspace.propose': { standing: true, minutes: [60, 30 * 24 * 60], limits: {} },
  'compute.inference': {
    standing: true,
    minutes: [24 * 60, 30 * 24 * 60],
    limits: { maxConcurrentJobs: int(1, 4, 1), maxJobSeconds: int(10, 1800, 120), maxTokensPerJob: int(1, 8192, 2048), models: list(32, /^[\w.:/-]{1,120}$/) },
  },
  'compute.gpu': { standing: true, minutes: [24 * 60, 30 * 24 * 60], limits: { maxVramBytes: int(0, 1024 * GB, 4 * GB), gpus: list(16, /^\d{1,2}$/), maxUtilPct: int(1, 100, 100) } },
  'compute.cpu': { standing: true, minutes: [24 * 60, 30 * 24 * 60], limits: { maxThreads: int(1, 256, 2), maxLoadPct: int(1, 100, 50) } },
  'compute.ram': { standing: true, minutes: [24 * 60, 30 * 24 * 60], limits: { maxBytes: int(0, 4096 * GB, 2 * GB) } },
  'compute.storage': { standing: true, minutes: [24 * 60, 30 * 24 * 60], limits: { maxBytes: int(0, 16384 * GB, 0), modelDownload: bool(false) } },
  // compute.pool: the right to run part of a pooled model here over llama.cpp RPC (src/brain/pool/p2p.js).
  // It only works beside compute.gpu (VRAM) or compute.cpu with compute.ram (threads, RAM), which set the limits.
  'compute.pool': { standing: true, minutes: [24 * 60, 30 * 24 * 60], limits: { maxLeaseMinutes: int(5, 480, 60), maxLeases: int(1, 4, 1) } },
  chat: { standing: true, open: true, minutes: [7 * 24 * 60, 30 * 24 * 60], limits: {} },
  // A terminal share names the one terminal it opens (src/workbench/share.js).
  'terminal.share.read': { standing: false, minutes: [15, 60], limits: { terminalId: id(/^[\w-]{1,64}$/) } },
  'terminal.share.write': { standing: false, minutes: [15, 60], limits: { terminalId: id(/^[\w-]{1,64}$/) } },
  // clipboard and files: what a viewer asks for beside the screen (src/remote/desk.js); each is its own grant.
  'remote.view': { standing: false, minutes: [15, 60], choices: [5, 15, 60], limits: { clipboard: bool(false), files: bool(false) } },
  'remote.control': { standing: false, minutes: [15, 60], choices: [5, 15, 60], limits: { clipboard: bool(false), files: bool(false) } },
  'clipboard.text': { standing: false, minutes: [15, 60], limits: { maxBytes: int(1, 65536, 65536), dir: oneOf(CLIP_DIRS, 'off') } },
  'file.send': { standing: false, minutes: [15, 60], limits: { maxBytes: int(1, 2 * GB, 2 * GB) } },
});

export const CAPABILITY_NAMES = Object.freeze(Object.keys(CAPABILITIES));
export const COMPUTE_RESOURCES = Object.freeze(['compute.gpu', 'compute.cpu', 'compute.ram', 'compute.storage']);

export const isCapability = (name) => typeof name === 'string' && Object.hasOwn(CAPABILITIES, name);

/** Normalizes { name, limits }: unknown names throw, unknown limit fields are dropped, numbers clamped. */
export function normalizeCapability(cap) {
  const name = typeof cap === 'string' ? cap : cap?.name;
  if (!isCapability(name)) throw new CapError('bad_capability', `unknown capability: ${String(name).slice(0, 60)}`);
  const spec = CAPABILITIES[name].limits;
  const given = (typeof cap === 'object' && cap.limits && typeof cap.limits === 'object') ? cap.limits : {};
  const limits = {};
  for (const [k, s] of Object.entries(spec)) {
    const v = given[k];
    if (s.kind === 'int') limits[k] = Number.isFinite(v) ? Math.min(s.max, Math.max(s.min, Math.round(v))) : s.def;
    else if (s.kind === 'bool') limits[k] = typeof v === 'boolean' ? v : s.def;
    else if (s.kind === 'list') limits[k] = Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === 'string' && s.re.test(x)))].slice(0, s.max) : [];
    else if (s.kind === 'id') { if (typeof v === 'string' && s.re.test(v)) limits[k] = v; }
    else if (s.kind === 'enum') limits[k] = s.values.includes(v) ? v : s.def;
  }
  return Object.keys(limits).length ? { name, limits } : { name };
}

/** A list of capabilities from a peer or a command, deduplicated by name, unknown ones dropped. */
export function normalizeCapList(list, max = 24) {
  const out = new Map();
  for (const c of Array.isArray(list) ? list.slice(0, max) : []) {
    try {
      const n = normalizeCapability(c);
      out.set(n.name, n);
    } catch { /* an unknown name from a newer peer is ignored */ }
  }
  return [...out.values()];
}

export const grantId = () => 'gr_' + base32(crypto.randomBytes(8)).slice(0, 12);

/**
 * Makes a Grant. Only a person grants: origin must be { kind: 'user' }.
 *   scope 'session' needs sessionId and ends with that session.
 *   expiresAt is null only for city.view and chat on a known peer with minutes: null.
 */
export function makeGrant({ peerId, capability, scope, minutes, sessionId, trust, origin, now = Date.now() }) {
  if (origin?.kind !== 'user') throw new CapError('forbidden', 'only a person can grant a capability');
  const cap = normalizeCapability(capability);
  const spec = CAPABILITIES[cap.name];
  const sc = scope || (spec.standing ? 'standing' : 'session');
  if (sc !== 'session' && sc !== 'standing') throw new CapError('bad_request', 'scope is session or standing');
  if (sc === 'standing' && !spec.standing) throw new CapError('bad_request', `${cap.name} is only granted for one session`);
  if (sc === 'session' && !sessionId) throw new CapError('bad_request', 'a session grant needs an open session');
  if (trust === 'blocked') throw new CapError('forbidden', 'this peer is blocked');
  let expiresAt;
  if (minutes === null) {
    if (!(spec.open && trust === 'known')) throw new CapError('bad_request', `${cap.name} needs an expiry`);
    expiresAt = null;
  } else {
    let m = Number.isFinite(minutes) ? minutes : spec.minutes[0];
    if (spec.choices && !spec.choices.includes(m)) throw new CapError('bad_request', `${cap.name} lasts ${spec.choices.join(', ')} minutes`);
    m = Math.min(spec.minutes[1], Math.max(1, m));
    expiresAt = new Date(now + m * MIN).toISOString();
  }
  return {
    id: grantId(),
    peerId,
    capability: cap,
    grantedBy: 'user',
    grantedAt: new Date(now).toISOString(),
    expiresAt,
    scope: sc,
    ...(sc === 'session' ? { sessionId } : {}),
  };
}

export function isActive(grant, now = Date.now(), sessionId) {
  if (!grant || grant.revokedAt) return false;
  if (grant.expiresAt !== null && Date.parse(grant.expiresAt) <= now) return false;
  if (grant.scope === 'session' && sessionId !== undefined && grant.sessionId !== sessionId) return false;
  return true;
}

/** The active grant for a capability, or null. control implies view for remote.* and terminal.share.*. */
export function findGrant(grants, name, now = Date.now(), sessionId) {
  const names = name === 'remote.view' ? ['remote.view', 'remote.control'] : name === 'terminal.share.read' ? ['terminal.share.read', 'terminal.share.write'] : [name];
  return (grants || []).find((g) => names.includes(g.capability?.name) && isActive(g, now, sessionId)) || null;
}

/**
 * The compute a peer may use here, from its active grants. null where nothing is granted.
 * A job is possible only with compute.inference and at least one of compute.gpu or compute.cpu.
 */
export function effectiveCompute(grants, now = Date.now(), sessionId) {
  const pick = (n) => findGrant(grants, n, now, sessionId)?.capability.limits || null;
  const out = { inference: pick('compute.inference'), gpu: pick('compute.gpu'), cpu: pick('compute.cpu'), ram: pick('compute.ram'), storage: pick('compute.storage') };
  out.allowed = !!out.inference && !!(out.gpu || out.cpu);
  return out;
}

/** Wire copy of a grant (what cap.grant and join.accept carry). */
export function grantForWire(g) {
  return { id: g.id, peerId: g.peerId, capability: g.capability, grantedBy: 'user', grantedAt: g.grantedAt, expiresAt: g.expiresAt, scope: g.scope, ...(g.revokedAt ? { revokedAt: g.revokedAt } : {}) };
}

/** Reads a grant announced by a peer (one it gave us). Returns null when malformed. */
export function readWireGrant(g, ourPeerId) {
  if (!g || typeof g !== 'object' || typeof g.id !== 'string' || !/^gr_[a-z2-7]{12}$/.test(g.id)) return null;
  if (g.peerId !== ourPeerId) return null;
  let capability;
  try {
    capability = normalizeCapability(g.capability);
  } catch {
    return null;
  }
  const iso = (v) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(Date.parse(v)).toISOString() : null);
  if (!iso(g.grantedAt)) return null;
  return { id: g.id, peerId: g.peerId, capability, grantedBy: 'user', grantedAt: iso(g.grantedAt), expiresAt: g.expiresAt === null ? null : iso(g.expiresAt), scope: g.scope === 'session' ? 'session' : 'standing' };
}

/** The defaults of the join dialog: city.view on, everything else off (PLAN 3.3 step 5). */
export function joinDialogToggles(requested, offered = []) {
  const names = new Map();
  for (const c of [...normalizeCapList(offered), ...normalizeCapList(requested)]) names.set(c.name, c);
  if (!names.has('city.view')) names.set('city.view', { name: 'city.view' });
  return [...names.values()].map((c) => ({ capability: c, on: c.name === 'city.view', standing: CAPABILITIES[c.name].standing, minutes: CAPABILITIES[c.name].minutes[0], choices: CAPABILITIES[c.name].choices || null }));
}

export { MIN, DAY, GB };
