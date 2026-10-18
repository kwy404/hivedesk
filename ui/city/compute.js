// The compute plane as the City sees it: resources measured by the probes and the jobs that run
// on them (PLAN sections 2, 6, 7, 8 and 10). Pure module, no DOM, so it runs in the unit tests.
//
// It is an adapter: it reduces the events and live frames of Stream 3 (src/compute/) into a small
// view. Until those exist nothing arrives and every value stays "unknown"; nothing is guessed.
// Accepted inputs (names from PLAN; aliases listed so a rename in Stream 3 is a one line change):
//   live   resources.sample   { ...Resource }            this engine's probe, every 2 s while a window is open
//   live   resource.advert    { peerId, resource }       a peer's signed advert, forwarded by its session
//   event  resources.changed  { ...Resource }            a threshold crossing (logged)
//   event  share.changed      { share: ShareSettings }   the owner's share settings
//   event  job.created | job.queued | job.offered | job.scheduled | job.leased | job.accepted |
//          job.started | job.running | job.completed | job.result | job.partial | job.failed |
//          job.error | job.cancelled | job.expired | job.revoked | job.rejected
//          { job?: Job, jobId?, decision?, lease?, result?, partial?, error?, code?, message? }
//   live   job.token          { jobId, text? , tokens? }  lights the bridge, counts tokens
//   live   job.heartbeat      { jobId, leaseId, tokens, vramBytes }
//   live   brain.download.progress { model, received, total, bps }   the crane on the host building
// What Stream 3 really sends (docs/1.0/protocol/compute.md), read here since the 1.0 merge:
//   live   resources.peer     { peerId, name, reportedBy, ...advert }   a peer's advert
//   event  job.state          { jobId, state, error?, choices?, choiceDeadline? }   the requester's job
//   event  job.ended          { role, jobId, worker, model, state, error? }        the final record
//   event  job.leased | job.running | job.refused | job.served   the jobs this engine serves for a peer
//   live   job.token          { jobId, n }                       n tokens so far
// Commands go back as compute.job.choose { jobId, choice }, compute.job.stop { jobId } and
// compute.share.set { change } (jobCommand and STOP_SHARING below).

export const JOB_STATES = ['queued', 'offered', 'leased', 'running', 'completed', 'partial', 'failed', 'cancelled', 'expired', 'revoked'];
export const ENDED = new Set(['completed', 'partial', 'failed', 'cancelled', 'expired', 'revoked']);
const KEEP_ENDED = 40;
/** A sample older than this is stale: its numbers are no longer shown as live. */
export const STALE_MS = 15_000;

const EVENT_STATE = {
  'job.created': 'queued', 'job.queued': 'queued', 'job.offered': 'offered', 'job.scheduled': null,
  'job.leased': 'leased', 'job.accepted': 'leased', 'job.started': 'running', 'job.running': 'running',
  'job.completed': 'completed', 'job.result': 'completed', 'job.partial': 'partial',
  'job.failed': 'failed', 'job.error': 'failed', 'job.rejected': 'failed',
  'job.cancelled': 'cancelled', 'job.expired': 'expired', 'job.revoked': 'revoked',
  'job.state': null, 'job.ended': null, 'job.refused': 'failed', 'job.served': null
};
const SERVED_STATE = { completed: 'completed', cancelled: 'cancelled', revoked: 'revoked', expired: 'expired', lease_expired: 'expired', partial: 'partial' };
const FAILED_TYPES = new Set(['job.failed', 'job.error', 'job.rejected', 'job.expired', 'job.revoked', 'job.partial', 'job.cancelled', 'job.refused']);
const FAILED_STATES = new Set(['failed', 'partial', 'expired', 'revoked', 'cancelled']);

export const blankCompute = () => ({ resources: {}, jobs: {}, order: [], share: null, download: null, tokens: {}, n: 0 });

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** A Resource with every number either measured or null (PLAN section 2). */
export function cleanResource(r, extra = {}) {
  if (!r || typeof r !== 'object') return null;
  const gpus = Array.isArray(r.gpus) ? r.gpus.slice(0, 8).map((g, i) => ({
    index: num(g?.index) ?? i, name: typeof g?.name === 'string' ? g.name.slice(0, 80) : null,
    vendor: typeof g?.vendor === 'string' ? g.vendor : 'other',
    vramTotalBytes: num(g?.vramTotalBytes), vramFreeBytes: num(g?.vramFreeBytes), utilPct: num(g?.utilPct),
    driver: typeof g?.driver === 'string' ? g.driver.slice(0, 40) : null, cuda: typeof g?.cuda === 'string' ? g.cuda.slice(0, 20) : null,
    backend: typeof g?.backend === 'string' ? g.backend : null, source: typeof g?.source === 'string' ? g.source : null
  })) : [];
  return {
    machineId: typeof r.machineId === 'string' ? r.machineId : null,
    peerId: typeof r.peerId === 'string' ? r.peerId : null,
    sampledAt: num(r.sampledAt),
    cpu: { model: typeof r.cpu?.model === 'string' ? r.cpu.model.slice(0, 80) : null, cores: num(r.cpu?.cores), loadPct: num(r.cpu?.loadPct) },
    ram: { totalBytes: num(r.ram?.totalBytes), freeBytes: num(r.ram?.freeBytes) },
    gpus,
    models: Array.isArray(r.models) ? r.models.slice(0, 32).map((m) => ({ id: String(m?.id || '').slice(0, 80), bytes: num(m?.bytes), loaded: !!m?.loaded })) : [],
    share: r.share && typeof r.share === 'object' ? { ...r.share } : null,
    busy: { jobs: num(r.busy?.jobs) ?? 0, turns: num(r.busy?.turns) ?? 0 },
    ...extra
  };
}

function keyOf(r, fallback) {
  return r?.machineId || r?.peerId || fallback || 'self';
}

/** Applies a live frame. Returns true when the view changed. */
export function applyComputeLive(c, frame, { now = Date.now(), selfPeerId = null } = {}) {
  const d = frame?.data || {};
  switch (frame?.type) {
    case 'resources.sample': {
      const r = cleanResource(d, { reportedBy: null, receivedAt: now });
      if (!r) return false;
      c.resources[keyOf(r, 'self')] = r;
      return true;
    }
    case 'resources.peer':
    case 'resource.advert': {
      const raw = d.resource || d;
      const peerId = d.peerId || raw.peerId;
      if (!peerId || peerId === selfPeerId) return false;
      const r = cleanResource({ ...raw, peerId }, { reportedBy: typeof d.reportedBy === 'string' ? d.reportedBy.slice(0, 40) : peerId, receivedAt: now, signed: d.verified !== false });
      if (!r) return false;
      c.resources[keyOf(r, peerId)] = r;
      return true;
    }
    case 'job.token': {
      const j = c.jobs[d.jobId];
      if (!j) return false;
      if (num(d.n) != null) j.tokens = Math.max(j.tokens, d.n);
      else j.tokens += num(d.tokens) ?? 1;
      j.lastTokenAt = now;
      if (j.state === 'leased' || j.state === 'offered' || j.state === 'queued') j.state = 'running';
      return true;
    }
    case 'job.heartbeat': {
      const j = c.jobs[d.jobId];
      if (!j) return false;
      if (num(d.tokens) != null) j.tokens = Math.max(j.tokens, d.tokens);
      if (num(d.vramBytes) != null) j.vramBytes = d.vramBytes;
      j.heartbeatAt = now;
      if (j.lease && num(d.expiresAt) != null) j.lease.expiresAt = d.expiresAt;
      return true;
    }
    case 'brain.download.progress':
      c.download = { model: String(d.model || ''), received: num(d.received) ?? 0, total: num(d.total), bps: num(d.bps), at: now };
      return true;
    default: return false;
  }
}

function blankJob(id) {
  return { id, type: 'inference', state: 'queued', requester: null, worker: null, taskId: null, agentId: null, priority: 'normal', decision: null, lease: null, attempts: [], result: null, partial: null, error: null, tokens: 0, createdAt: null, endedAt: null, lastTokenAt: null, vramBytes: null, model: null };
}

/** Applies a logged event. Returns true when the view changed. */
export function applyComputeEvent(c, ev) {
  const d = ev?.data || {};
  const type = ev?.type || '';
  if (type === 'resources.changed') {
    const r = cleanResource(d.resource || d, { reportedBy: d.peerId || null, receivedAt: Date.parse(ev.ts) || null });
    if (!r) return false;
    c.resources[keyOf(r, d.peerId || 'self')] = { ...(c.resources[keyOf(r, d.peerId || 'self')] || {}), ...r };
    return true;
  }
  if (type === 'share.changed' || type === 'share.updated') {
    c.share = d.share && typeof d.share === 'object' ? { ...d.share } : { ...d };
    return true;
  }
  if (type === 'brain.download.finished' || type === 'brain.download.failed') { c.download = null; return true; }
  if (!(type in EVENT_STATE)) return false;
  const src = d.job && typeof d.job === 'object' ? d.job : d;
  const id = src.id || d.jobId;
  if (!id) return false;
  let j = c.jobs[id];
  if (!j) { j = blankJob(id); c.jobs[id] = j; c.order.push(id); }
  for (const k of ['type', 'requester', 'worker', 'taskId', 'agentId', 'priority']) if (src[k] != null) j[k] = src[k];
  if (src.input?.model) j.model = src.input.model;
  if (src.createdAt || (!j.createdAt && ev.ts)) j.createdAt = src.createdAt || ev.ts;
  if (Array.isArray(src.attempts)) j.attempts = src.attempts.slice(-8);
  const decision = d.decision || src.decision;
  if (decision && typeof decision === 'object') {
    j.decision = decision;
    if (decision.target?.model) j.model = decision.target.model;
  }
  if (d.lease || src.lease) j.lease = { ...(d.lease || src.lease) };
  if (d.result || src.result) j.result = { ...(d.result || src.result) };
  if (d.partial || src.partial) j.partial = { ...(d.partial || src.partial) };
  // The jobs this engine serves for a peer (worker side): the requester is the peer, the worker is this engine.
  if (type === 'job.leased' || type === 'job.running' || type === 'job.refused' || type === 'job.served') {
    j.served = true;
    j.worker = 'local';
    if (typeof (d.requester || d.peerId) === 'string') j.requester = d.requester || d.peerId;
    if (d.model) j.model = d.model;
    if (d.leaseId) j.lease = { ...(j.lease || {}), id: d.leaseId, state: 'active', ...(num(d.hardDeadline) != null ? { hardDeadline: d.hardDeadline } : {}) };
  }
  if (type === 'job.scheduled' && decision?.target && !j.served && !j.requester) j.worker = decision.target.kind?.startsWith('local') ? 'local' : decision.target.peerId || j.worker;
  if (type === 'job.ended' && typeof d.worker === 'string') j.worker = d.worker;
  if (type === 'job.state') j.choices = Array.isArray(d.choices) ? d.choices.slice(0, 6).map(String) : null;
  const rawErr = d.error || src.error || (d.code ? { code: d.code, message: d.message || d.detail || '' } : null);
  const err = typeof rawErr === 'string' ? { code: rawErr, message: '' } : rawErr;
  const failedNow = FAILED_TYPES.has(type) || ((type === 'job.state' || type === 'job.ended') && FAILED_STATES.has(d.state)) || (type === 'job.served' && d.outcome && d.outcome !== 'completed');
  if (err && failedNow) {
    j.error = { code: String(err.code || type.slice(4)), message: String(err.message || '').slice(0, 300) };
  }
  if (type === 'job.served' && !j.error && d.outcome && d.outcome !== 'completed') j.error = { code: String(d.outcome).slice(0, 40), message: '' };
  if (type === 'job.revoked' && !j.error) j.error = { code: 'revoked', message: String(d.reason || '').slice(0, 300) };
  if (type === 'job.expired' && !j.error) j.error = { code: 'lease_expired', message: '' };
  const next = type === 'job.served' ? SERVED_STATE[d.outcome] || 'failed' : EVENT_STATE[type] || (src.state && JOB_STATES.includes(src.state) ? src.state : null);
  if (next) j.state = next;
  if (ENDED.has(j.state)) {
    j.endedAt = src.endedAt || ev.ts || null;
    if (j.lease) j.lease.state = j.state === 'revoked' ? 'revoked' : j.state === 'expired' ? 'expired' : 'released';
  }
  trim(c);
  return true;
}

function trim(c) {
  const ended = c.order.filter((id) => ENDED.has(c.jobs[id]?.state));
  if (ended.length <= KEEP_ENDED) return;
  for (const id of ended.slice(0, ended.length - KEEP_ENDED)) { delete c.jobs[id]; c.order.splice(c.order.indexOf(id), 1); }
}

/** True for events and live frames this module reads. */
export const isComputeType = (type) => typeof type === 'string' && (type in EVENT_STATE || /^(resources?\.|share\.|job\.(token|heartbeat)$|brain\.download\.)/.test(type));

/**
 * What the user may do with a job, from the failure table of PLAN section 8.
 * Returns ids among: cancel, stop (I am the worker), retryLocal, retryPeer, usePartial.
 */
export function jobActions(j, { selfPeerId = null } = {}) {
  if (!j) return [];
  const iWork = !!j.served || (!!selfPeerId && j.worker === selfPeerId && j.requester !== selfPeerId);
  if (!ENDED.has(j.state)) return iWork ? ['stop'] : ['cancel'];
  if (iWork) return [];
  // The requester offers its own choices while it waits for a person (job.state choices); after that nothing is left to do.
  if (Array.isArray(j.choices)) return j.choices.map((c) => CHOICE_ACTION[c]).filter(Boolean);
  if (j.choices === null) return [];
  switch (j.state) {
    case 'failed': case 'expired': return j.partial?.text ? ['usePartial', 'retryLocal', 'retryPeer', 'cancel'] : ['retryLocal', 'retryPeer', 'cancel'];
    case 'partial': return ['usePartial', 'retryLocal', 'retryPeer', 'cancel'];
    case 'revoked': return ['retryLocal', 'cancel'];
    default: return [];
  }
}

const CHOICE_ACTION = { 'retry-local': 'retryLocal', 'retry-peer': 'retryPeer', 'use-partial': 'usePartial', cancel: 'cancel', 'open-machines': 'openMachines' };
const ACTION_CHOICE = { retryLocal: 'retry-local', retryPeer: 'retry-peer', usePartial: 'use-partial', cancel: 'cancel' };

/** The engine command of a job action: [type, data] (src/compute/index.js). */
export function jobCommand(action, jobId) {
  if (action === 'stop') return ['compute.job.stop', { jobId }];
  if (ACTION_CHOICE[action]) return ['compute.job.choose', { jobId, choice: ACTION_CHOICE[action] }];
  return null;
}

/** Stop sharing: GPU and CPU off (compute.share.set). */
export const STOP_SHARING = ['compute.share.set', { change: { gpu: { enabled: false }, cpu: { enabled: false } } }];

/** Seconds left on the lease and on the hard deadline (null when there is no lease). */
export function countdown(j, now = Date.now()) {
  const l = j?.lease;
  if (!l || ENDED.has(j.state)) return null;
  const left = (t) => (num(t) == null ? null : Math.max(0, Math.round((t - now) / 1000)));
  return { lease: left(l.expiresAt), deadline: left(l.hardDeadline) };
}

/** The view of one job for the job panel and the bridge. */
export function jobView(j, { now = Date.now(), selfPeerId = null, peerName = (id) => id } = {}) {
  if (!j) return null;
  const target = j.decision?.target || null;
  const where = !target ? null : target.kind?.startsWith('local') ? { kind: target.kind === 'local-gpu' ? 'localGpu' : 'localCpu', name: null }
    : { kind: target.kind === 'peer-gpu' ? 'peerGpu' : 'peerCpu', name: peerName(target.peerId) };
  const rejected = (j.decision?.candidates || []).filter((x) => x && x.ok === false).slice(0, 6);
  return {
    id: j.id, state: j.state, model: j.model, tokens: j.tokens, agentId: j.agentId, taskId: j.taskId,
    where, reason: j.decision?.reason || null, estimateMs: num(j.decision?.estimateMs), rejected,
    lease: j.lease ? { id: j.lease.id || null, state: j.lease.state || 'active', maxTokens: num(j.lease.limits?.maxTokens), vramBytes: num(j.lease.limits?.vramBytes) } : null,
    countdown: countdown(j, now), error: j.error, partial: j.partial?.text ? { chars: j.partial.text.length, tokens: num(j.partial.completionTokens) } : null,
    result: j.result ? { tokens: num(j.result.completionTokens), ms: num(j.result.ms), model: j.result.model || null } : null,
    actions: jobActions(j, { selfPeerId }), live: !!j.lastTokenAt && now - j.lastTokenAt < 2000,
    remote: !!target && !target.kind?.startsWith('local'), peerId: target?.peerId || null
  };
}

/** Jobs that touch a peer machine, for the bridge: running ones light it, failed ones break it. */
export function bridgeJobs(c, peerId, now = Date.now()) {
  const out = { live: false, running: 0, failed: null };
  for (const id of c.order) {
    const j = c.jobs[id];
    if (!j) continue;
    const p = j.decision?.target?.peerId || (j.worker !== 'local' ? j.worker : null);
    if (p !== peerId && j.requester !== peerId) continue;
    if (!ENDED.has(j.state)) { out.running++; if (j.lastTokenAt && now - j.lastTokenAt < 1500) out.live = true; }
    else if (['failed', 'expired', 'revoked'].includes(j.state) && (!out.failed || String(j.endedAt) > String(out.failed.endedAt))) {
      const end = Date.parse(j.endedAt || '') || 0;
      if (!end || now - end < 120_000) out.failed = { id: j.id, code: j.error?.code || j.state, endedAt: j.endedAt };
    }
  }
  return out;
}
