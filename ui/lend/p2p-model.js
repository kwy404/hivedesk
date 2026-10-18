// Pure view models for the 1.0 Lend screen and Join window (no DOM, no strings): what to show
// for a lend form, a join request, the people borrowing now and a join in progress. Every line
// is { key, params } for p2p-text.js. Tested in test/lend/p2p-model.test.js.

const GB = 1024 ** 3;
const gb = (bytes) => Math.round((bytes / GB) * 10) / 10;

export const DEFAULT_FORM = Object.freeze({
  gpu: { on: true, maxVramGB: 4 },
  cpu: { on: false, threads: 2, maxLoadPct: 50 },
  ram: { on: true, maxGB: 2 },
  storage: { on: false, maxGB: 10, modelDownload: false },
  minutes: 60,
});

export const MINUTE_CHOICES = Object.freeze([15, 60, 240, 1440]);

/** A form from loose input values (numbers as text, checkboxes), clamped to sane ranges. */
export function readForm(v = {}) {
  const num = (x, d, min, max) => {
    const n = Number(x);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
  };
  const d = DEFAULT_FORM;
  return {
    gpu: { on: !!(v.gpu?.on ?? d.gpu.on), maxVramGB: num(v.gpu?.maxVramGB, d.gpu.maxVramGB, 0.5, 1024) },
    cpu: { on: !!(v.cpu?.on ?? d.cpu.on), threads: Math.round(num(v.cpu?.threads, d.cpu.threads, 1, 256)), maxLoadPct: Math.round(num(v.cpu?.maxLoadPct, d.cpu.maxLoadPct, 1, 100)) },
    ram: { on: !!(v.ram?.on ?? d.ram.on), maxGB: num(v.ram?.maxGB, d.ram.maxGB, 0.5, 4096) },
    storage: { on: !!(v.storage?.on ?? d.storage.on), maxGB: num(v.storage?.maxGB, d.storage.maxGB, 0, 16384), modelDownload: !!v.storage?.modelDownload },
    minutes: MINUTE_CHOICES.includes(Number(v.minutes)) ? Number(v.minutes) : d.minutes,
  };
}

export const canLend = (form) => !!(form.gpu.on || form.cpu.on);

/** One capability as a line for people. */
export function capLine(cap) {
  const l = cap.limits || {};
  switch (cap.name) {
    case 'compute.inference':
      return { key: 'lend.p2p.cap.inference', params: { jobs: l.maxConcurrentJobs ?? 1, seconds: l.maxJobSeconds ?? 120, tokens: l.maxTokensPerJob ?? 2048 } };
    case 'compute.gpu':
      return { key: l.gpus?.length ? 'lend.p2p.cap.gpuSome' : 'lend.p2p.cap.gpu', params: { gb: gb(l.maxVramBytes ?? 0), gpus: (l.gpus || []).join(', ') } };
    case 'compute.cpu':
      return { key: 'lend.p2p.cap.cpu', params: { threads: l.maxThreads ?? 1, pct: l.maxLoadPct ?? 50 } };
    case 'compute.ram':
      return { key: 'lend.p2p.cap.ram', params: { gb: gb(l.maxBytes ?? 0) } };
    case 'compute.storage':
      return { key: l.modelDownload ? 'lend.p2p.cap.storageDownload' : 'lend.p2p.cap.storage', params: { gb: gb(l.maxBytes ?? 0) } };
    case 'city.view':
      return { key: 'lend.p2p.cap.cityView', params: {} };
    default:
      return { key: 'lend.p2p.cap.other', params: { name: cap.name } };
  }
}

/** Minutes left until an ISO time (never negative), or null without one. */
export function minutesLeft(iso, now = Date.now()) {
  if (!iso) return null;
  return Math.max(0, Math.ceil((Date.parse(iso) - now) / 60_000));
}

/** The confirm card for a join request (p2p.join.request live frame). */
export function confirmModel(request, offeredCaps = [], now = Date.now()) {
  return {
    requestId: request.requestId,
    name: request.peer.name,
    fingerprint: request.peer.fingerprint.words,
    knownBefore: !!request.peer.knownBefore,
    sas: request.sas,
    lines: offeredCaps.map(capLine),
    expiresIn: minutesLeft(request.expiresAt, now),
  };
}

/** Rows for "Lending now" from lend.grants. */
export function lendingModel(lending = [], now = Date.now()) {
  return lending.map((p) => ({
    peerId: p.peerId,
    name: p.name,
    online: !!p.online,
    fingerprint: p.fingerprint,
    lines: p.grants.map((g) => ({ ...capLine(g.capability), left: minutesLeft(g.expiresAt, now), grantId: g.id })),
  }));
}

/** The Join window state from p2p.join.update frames (the last one wins). */
export function joinModel(update) {
  if (!update) return { phase: 'idle' };
  const out = { phase: update.phase };
  if (update.sas) {
    out.sas = update.sas;
    out.hostName = update.host?.name;
    out.hostFingerprint = update.host?.fingerprint?.words;
  }
  if (update.phase === 'accepted') out.lines = (update.grants || []).map((g) => capLine(g.capability));
  if (update.phase === 'failed') out.reasonKey = `lend.p2p.join.failed.${['words', 'timeout', 'refused'].includes(update.reason) ? update.reason : 'words'}`;
  if (update.phase === 'refused') out.reason = update.reason === 'sas_mismatch' ? 'sas_mismatch' : (update.reason || 'refused');
  return out;
}

/** The capabilities a borrower asks for: inference plus GPU, CPU and RAM (the lender decides). */
export const BORROW_REQUEST = Object.freeze(['compute.inference', 'compute.gpu', 'compute.cpu', 'compute.ram']);
