// The Machines panel view (PLAN section 10): every number is a measurement with a source, or it
// is "unknown". Pure module, no DOM.
//   measured  a live probe sample of this engine (src/compute/probe.js, Stream 3), younger than 15 s
//   reported  a peer's signed resource advert ("reported by Rita's PC")
//   static    measured once when hivedesk started (hardware.detected): real, but not live
//   joined    what a friend's window said when it joined (0.2 path): self reported, not verified
//   estimate  a rule of thumb (Apple unified memory), never shown as a measurement
//   stale     the last sample is older than 15 s
//   unknown   nothing measured it

import { STALE_MS, ENDED, countdown } from './compute.js';

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The probe sample for a city machine: by machine id, by PeerId, or this engine's own. */
export function resourceFor(compute, m) {
  const r = compute?.resources || {};
  return r[m.id] || (m.peerId ? r[m.peerId] : null) || (m.self ? r.self : null) || null;
}

function stateOf(res, now) {
  if (!res) return null;
  const at = num(res.sampledAt) ?? num(res.receivedAt);
  if (at != null && now - at > STALE_MS) return 'stale';
  return res.reportedBy ? 'reported' : 'measured';
}

const field = (key, value, state, source, extra = {}) => ({ key, value: value ?? null, state: value == null && state !== 'stale' ? 'unknown' : state, source: value == null && state !== 'stale' ? null : source, ...extra });

/**
 * @param {any} v the City view (ui/city/model.js viewOf)
 * @param {any} compute the compute view (ui/city/compute.js)
 * @param {{ now?: number, selfPeerId?: string | null, demo?: boolean }} [opts]
 */
export function machinesView(v, compute, { now = Date.now(), selfPeerId = null, demo = false } = {}) {
  const list = Object.values(v?.machines || {}).sort((a, b) => (b.self - a.self) || String(a.joinedAt || '').localeCompare(String(b.joinedAt || '')));
  return list.map((m) => machineCard(m, v, compute, { now, selfPeerId, demo }));
}

export function machineCard(m, v, compute, { now = Date.now(), selfPeerId = null, demo = false } = {}) {
  const res = resourceFor(compute, m);
  const st = stateOf(res, now);
  const src = res ? (res.reportedBy ? `advert:${m.name}` : 'probe') : null;
  const fields = [];
  // GPU
  const g = res?.gpus?.[0] || null;
  if (g) {
    fields.push(field('gpu', g.name, st, g.source || src, { vendor: g.vendor, driver: g.driver, cuda: g.cuda, backend: g.backend, count: res.gpus.length }));
    const total = num(g.vramTotalBytes); const free = num(g.vramFreeBytes);
    fields.push(field('vram', total != null && free != null ? { usedBytes: total - free, totalBytes: total } : null, st, g.source || src));
    fields.push(field('gpuUtil', num(g.utilPct), st, g.source || src));
  } else if (res && Array.isArray(res.gpus) && !res.gpus.length) {
    fields.push({ key: 'gpu', value: null, state: 'none', source: 'probe' });
  } else if (m.gpu) {
    // no probe: the start time detection (host) or what a friend sent at join time (0.2)
    const kind = m.self || m.host ? (m.gpu.unified ? 'estimate' : 'static') : 'joined';
    fields.push(field('gpu', m.gpu.name || null, kind === 'estimate' ? 'static' : kind, m.self || m.host ? 'startup' : `join:${m.name}`));
    fields.push(field('vram', num(m.gpu.vramBytes) != null ? { usedBytes: null, totalBytes: m.gpu.vramBytes } : null, kind, m.gpu.unified ? 'unified' : m.self || m.host ? 'startup' : `join:${m.name}`));
    fields.push(field('gpuUtil', null, 'unknown', null));
  } else {
    fields.push(field('gpu', null, 'unknown', null));
    fields.push(field('vram', null, 'unknown', null));
    fields.push(field('gpuUtil', null, 'unknown', null));
  }
  // CPU and RAM
  if (res) {
    fields.push(field('cpu', num(res.cpu?.loadPct), st, 'os.cpus', { cores: num(res.cpu?.cores), model: res.cpu?.model || null }));
    const total = num(res.ram?.totalBytes); const free = num(res.ram?.freeBytes);
    fields.push(field('ram', total != null && free != null ? { usedBytes: total - free, totalBytes: total } : null, st, 'os.freemem'));
  } else {
    fields.push(field('cpu', null, 'unknown', null, { cores: num(m.cpus) }));
    fields.push(field('ram', num(m.ramBytes) != null ? { usedBytes: null, totalBytes: m.ramBytes } : null, m.self || m.host ? 'static' : 'joined', m.self || m.host ? 'startup' : `join:${m.name}`));
  }
  // model
  const loaded = res?.models?.find((x) => x.loaded) || null;
  if (loaded) fields.push(field('model', loaded.id, st, 'runtime', { loaded: true }));
  else if (m.model) fields.push(field('model', m.model, m.self || m.host ? 'static' : 'joined', m.self || m.host ? 'brain' : `join:${m.name}`, { loaded: null }));
  else fields.push(field('model', null, 'unknown', null));
  // tokens per second of the last turn (turn.ended), and the model slots
  fields.push(m.tps > 0 ? { key: 'tps', value: m.tps, state: 'measured', source: 'turn.ended' } : { key: 'tps', value: null, state: 'unknown', source: null });
  fields.push({ key: 'slots', value: m.slots ? { busy: m.slots.busy, total: m.slots.total } : null, state: m.slots ? 'measured' : 'unknown', source: m.slots ? 'scheduler' : null });

  // jobs that run here (this machine is the worker) or that this machine asked for
  const jobs = [];
  for (const id of compute?.order || []) {
    const j = compute.jobs[id];
    if (!j || ENDED.has(j.state)) continue;
    const workerPeer = j.worker === 'local' ? (j.requester || selfPeerId) : j.worker;
    const onThis = (m.self && (j.worker === 'local' || (selfPeerId && j.worker === selfPeerId))) || (!m.self && m.peerId && workerPeer === m.peerId);
    if (!onThis) continue;
    const forPeer = !!selfPeerId && j.requester && j.requester !== selfPeerId;
    jobs.push({ id: j.id, state: j.state, model: j.model, tokens: j.tokens, requester: j.requester, forPeer, leaseId: j.lease?.id || null, countdown: countdown(j, now), vramBytes: num(j.vramBytes) });
  }
  // the share settings this machine's owner set (a friend's are advisory: the owner enforces)
  const share = (m.self ? compute?.share : null) || res?.share || null;
  const borrows = Object.values(v?.borrows || {}).filter((b) => b.to === m.id || b.from === m.id);
  return {
    id: m.id, name: m.name, self: !!m.self, online: m.online !== false, color: m.color, via: m.via, peerId: m.peerId || null,
    demo: !!demo, sampledAt: num(res?.sampledAt) ?? num(res?.receivedAt), state: st || (m.self || m.host ? 'static' : 'joined'),
    reportedBy: res?.reportedBy ? m.name : null, fields, jobs, share: share ? cleanShare(share) : null,
    borrows: borrows.map((b) => ({ id: b.id, agentId: b.agentId, from: b.from, to: b.to, used: b.used?.turns || 0, limit: b.limit?.turns ?? null, lender: b.to === m.id })),
    pending: (v?.pending || []).filter((b) => b.to === m.id).map((b) => ({ id: b.id, agentId: b.agentId })),
    agents: Object.values(v?.agents || {}).filter((a) => a.home === m.id).map((a) => a.id)
  };
}

function cleanShare(s) {
  // ShareSettings of src/compute/share.js keep the GPU and CPU blocks; a peer's advert has only the blocks.
  const g = s.gpu && typeof s.gpu === 'object' ? s.gpu : {};
  const pick = (k) => (k in s ? s[k] : g[k]);
  return {
    enabled: !!(s.enabled ?? (g.enabled || s.cpu?.enabled)), remoteInference: !!(pick('remoteInference') ?? pick('enabled')), modelDownload: !!pick('modelDownload'),
    maxConcurrentJobs: num(pick('maxConcurrentJobs')), maxVramBytes: num(pick('maxVramBytes')), maxJobSeconds: num(pick('maxJobSeconds')), maxTokensPerJob: num(s.maxTokensPerJob),
    modelAllowlist: Array.isArray(s.modelAllowlist) ? s.modelAllowlist.slice(0, 12).map(String) : [], peers: s.peers === 'known' || Array.isArray(s.peers) ? s.peers : 'known',
    hours: s.hours && typeof s.hours === 'object' ? { from: String(s.hours.from || ''), to: String(s.hours.to || '') } : null
  };
}

/** Bytes as GB with one decimal under 10 GB, for the panel. */
export function gb(bytes) {
  if (num(bytes) == null) return null;
  const v = bytes / 1024 ** 3;
  return v >= 10 ? Math.round(v) : Math.round(v * 10) / 10;
}

/** What the scene may draw for a machine: only measured or reported live numbers move it. */
export function liveOf(card) {
  const f = Object.fromEntries((card?.fields || []).map((x) => [x.key, x]));
  const live = (x) => x && (x.state === 'measured' || x.state === 'reported') && x.value != null;
  const util = live(f.gpuUtil) ? f.gpuUtil.value / 100 : null;
  // the VRAM bar on a building: used of total, only when a probe or a signed advert measured both
  const vram = live(f.vram) && f.vram.value.usedBytes != null && f.vram.value.totalBytes ? f.vram.value.usedBytes / f.vram.value.totalBytes : null;
  const cpu = live(f.cpu) ? f.cpu.value / 100 : null;
  return { util, vram, cpu, jobs: card?.jobs?.length || 0, slotsBusy: f.slots?.value?.busy || 0 };
}
