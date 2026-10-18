// Compute plane message bodies (PLAN section 4): a normalizer per type, in the style of
// ui/lend/core/frames.js. Unknown fields are dropped, strings are capped, numbers clamped.
// A body that cannot be normalized throws a ComputeError with code "bad_input".
// Also the inference input rules of PLAN section 5, enforced on the worker before anything runs.
import { ComputeError, JOB_TYPES, REJECT_CODES, JOB_ERROR_CODES, PRIORITIES } from './types.js';

export const LIMITS = Object.freeze({
  messages: 64,
  promptChars: 120_000,
  // PLAN 5 said 2,000 characters and depth 6; the crew's tool call schema is about 3,700 characters and
  // 6 nodes deep, so the subset allows 8,192 and 8 (src/p2p/messages.js SCHEMA_BOUNDS carries the same).
  schemaChars: 8192,
  schemaDepth: 8,
  oneOf: 12,
  tokenText: 64 * 1024,
  resultText: 512 * 1024,
  detail: 300,
  message: 500
});

const JOB_ID = /^jb_[a-z2-7]{16}$/;
const LEASE_ID = /^ls_[a-z2-7]{16}$/;
const PEER_ID = /^hd1[a-z2-7]{49}$/;
const ROLES = new Set(['system', 'user', 'assistant']);

const bad = (detail) => new ComputeError('bad_input', detail);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const nat = (v, max = Number.MAX_SAFE_INTEGER) => (Number.isFinite(v) && v >= 0 ? Math.min(max, Math.round(v)) : 0);

export function readJobId(v) {
  if (typeof v !== 'string' || !JOB_ID.test(v)) throw bad('bad job id');
  return v;
}

const SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
const SCHEMA_KEYS = new Set(['type', 'properties', 'required', 'items', 'enum', 'const', 'oneOf', 'additionalProperties', 'description', 'title', 'minItems', 'maxItems', 'minLength', 'maxLength', 'default']);

const COMPACT_DROP = new Set(['description', 'title', 'default']);

/**
 * The schema a requester sends to a worker: the same constraints without descriptions, titles and
 * defaults (the worker's grammar needs only the shape; the requester validates the answer against
 * the full schema itself). The crew's largest real schema, the QA tool call schema, is about 3,700
 * characters in full and about 3,350 compact (test/compute/schema-size.test.js measures it).
 */
export function compactSchema(schema) {
  if (Array.isArray(schema)) return schema.map(compactSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (COMPACT_DROP.has(k)) continue;
    if (k === 'properties' && v && typeof v === 'object') out[k] = Object.fromEntries(Object.entries(v).map(([name, sub]) => [name, compactSchema(sub)]));
    else if (k === 'enum' || k === 'const' || k === 'required') out[k] = v;
    else out[k] = compactSchema(v);
  }
  return out;
}

/**
 * The bounded schema subset of PLAN section 5: depth at most 8, at most 8,192 characters, types object,
 * array, string, number, integer, boolean, enum, const, oneOf with at most 12 branches; no $ref, no pattern,
 * no other keyword. Returns null when the schema is fine, or the reason.
 */
export function schemaProblem(schema) {
  let text;
  try { text = JSON.stringify(schema); } catch { return 'the schema is not JSON'; }
  if (text.length > LIMITS.schemaChars) return `the schema is longer than ${LIMITS.schemaChars} characters`;
  const walk = (s, depth) => {
    if (depth > LIMITS.schemaDepth) return `the schema is deeper than ${LIMITS.schemaDepth}`;
    if (!obj(s)) return 'a schema node is not an object';
    for (const k of Object.keys(s)) if (!SCHEMA_KEYS.has(k)) return `the schema keyword "${k}" is not allowed`;
    if (s.type !== undefined) {
      const types = Array.isArray(s.type) ? s.type : [s.type];
      if (!types.length || !types.every((t) => SCHEMA_TYPES.has(t))) return 'a schema type is not allowed';
    }
    for (const k of ['minItems', 'maxItems', 'minLength', 'maxLength']) {
      if (s[k] !== undefined && !(Number.isInteger(s[k]) && s[k] >= 0 && s[k] <= 100_000)) return `"${k}" must be a small whole number`;
    }
    if (s.enum !== undefined && (!Array.isArray(s.enum) || s.enum.length > 64 || s.enum.some((v) => v !== null && typeof v === 'object'))) return 'enum must be a short list of plain values';
    if (s.const !== undefined && s.const !== null && typeof s.const === 'object') return 'const must be a plain value';
    if (s.additionalProperties !== undefined && typeof s.additionalProperties !== 'boolean') return 'additionalProperties must be true or false';
    if (s.required !== undefined && (!Array.isArray(s.required) || s.required.some((r) => typeof r !== 'string'))) return 'required must list names';
    if (s.properties !== undefined) {
      if (!obj(s.properties)) return 'properties must be an object';
      for (const v of Object.values(s.properties)) { const p = walk(v, depth + 1); if (p) return p; }
    }
    if (s.items !== undefined) { const p = walk(s.items, depth + 1); if (p) return p; }
    if (s.oneOf !== undefined) {
      if (!Array.isArray(s.oneOf) || !s.oneOf.length || s.oneOf.length > LIMITS.oneOf) return `oneOf must have 1 to ${LIMITS.oneOf} branches`;
      for (const v of s.oneOf) { const p = walk(v, depth + 1); if (p) return p; }
    }
    return null;
  };
  return walk(schema, 1);
}

/**
 * Checks and cleans an InferenceInput. `maxTokensCap` is the worker's ShareSettings.maxTokensPerJob:
 * a larger maxTokens is lowered to it (the lease says the real limit).
 * @returns {import('./types.js').InferenceInput}
 */
export function readInferenceInput(v, { maxTokensCap = 8192 } = {}) {
  const o = obj(v);
  if (!o) throw bad('input must be an object');
  const model = str(o.model, 200).trim();
  if (!model) throw bad('input.model is required');
  if (!Array.isArray(o.messages) || !o.messages.length) throw bad('input.messages must be a list');
  if (o.messages.length > LIMITS.messages) throw bad(`at most ${LIMITS.messages} messages`);
  let chars = 0;
  const messages = o.messages.map((m) => {
    if (!obj(m) || !ROLES.has(m.role) || typeof m.content !== 'string') throw bad('each message needs a role (system, user or assistant) and text content');
    chars += m.content.length;
    return { role: m.role, content: m.content };
  });
  if (chars > LIMITS.promptChars) throw bad(`the prompt is longer than ${LIMITS.promptChars} characters`);
  const maxTokens = Number.isInteger(o.maxTokens) && o.maxTokens > 0 ? Math.min(o.maxTokens, maxTokensCap) : Math.min(1024, maxTokensCap);
  const out = { model, messages, maxTokens };
  if (o.temperature !== undefined) {
    if (!Number.isFinite(o.temperature)) throw bad('temperature must be a number');
    out.temperature = Math.min(2, Math.max(0, o.temperature));
  }
  if (o.format !== undefined) {
    if (o.format !== 'text' && o.format !== 'json') throw bad('format must be text or json');
    out.format = o.format;
  }
  if (o.schema !== undefined) {
    const p = schemaProblem(o.schema);
    if (p) throw bad(p);
    out.schema = o.schema;
    out.format = 'json';
  }
  return out;
}

/** job.offer: { job }. The job type allowlist is checked here: only "inference". */
export function readOffer(body) {
  const j = obj(obj(body)?.job);
  if (!j) throw bad('job.offer needs a job');
  const id = readJobId(j.id);
  if (!JOB_TYPES.includes(j.type)) throw new ComputeError('bad_input', `the job type "${String(j.type).slice(0, 40)}" is not allowed; this worker runs only inference`, { jobId: id, disallowedType: true });
  return {
    id,
    type: 'inference',
    input: j.input,                      // checked by readInferenceInput with the worker's limits
    priority: PRIORITIES.includes(j.priority) ? j.priority : 'normal',
    ...(typeof j.taskId === 'string' ? { taskId: j.taskId.slice(0, 80) } : {}),
    ...(typeof j.agentId === 'string' ? { agentId: j.agentId.slice(0, 80) } : {}),
    ...(Number.isFinite(j.maxSeconds) ? { maxSeconds: Math.max(1, Math.min(1800, Math.round(j.maxSeconds))) } : {})
  };
}

export function readLease(v) {
  const l = obj(v);
  if (!l || typeof l.id !== 'string' || !LEASE_ID.test(l.id)) throw bad('bad lease');
  const lim = obj(l.limits) || {};
  return {
    id: l.id, jobId: readJobId(l.jobId),
    worker: typeof l.worker === 'string' && PEER_ID.test(l.worker) ? l.worker : '',
    requester: typeof l.requester === 'string' && PEER_ID.test(l.requester) ? l.requester : '',
    grantedAt: nat(l.grantedAt), expiresAt: nat(l.expiresAt), hardDeadline: nat(l.hardDeadline),
    limits: { maxTokens: nat(lim.maxTokens, 8192), vramBytes: nat(lim.vramBytes), model: str(lim.model, 200) },
    state: ['active', 'released', 'expired', 'revoked'].includes(l.state) ? l.state : 'active'
  };
}

export const readAccept = (b) => ({ jobId: readJobId(obj(b)?.jobId), lease: readLease(obj(b)?.lease) });
export function readReject(b) {
  const o = obj(b) || {};
  return { jobId: readJobId(o.jobId), code: REJECT_CODES.includes(o.code) ? o.code : 'bad_input', detail: str(o.detail, LIMITS.detail) };
}
export const readHeartbeat = (b) => {
  const o = obj(b) || {};
  return { jobId: readJobId(o.jobId), leaseId: typeof o.leaseId === 'string' && LEASE_ID.test(o.leaseId) ? o.leaseId : '', tokens: nat(o.tokens), vramBytes: nat(o.vramBytes) };
};
export const readToken = (b) => ({ jobId: readJobId(obj(b)?.jobId), text: str(obj(b)?.text, LIMITS.tokenText) });
export function readResult(b) {
  const o = obj(b) || {};
  const r = obj(o.result);
  if (!r || typeof r.text !== 'string') throw bad('job.result needs text');
  const out = { text: r.text.slice(0, LIMITS.resultText), promptTokens: nat(r.promptTokens), completionTokens: nat(r.completionTokens), ms: nat(r.ms), model: str(r.model, 200) };
  if (r.json !== undefined) out.json = r.json;
  return { jobId: readJobId(o.jobId), result: out };
}
export function readError(b) {
  const o = obj(b) || {};
  const p = obj(o.partial);
  return {
    jobId: readJobId(o.jobId),
    code: JOB_ERROR_CODES.includes(o.code) ? o.code : 'crashed',
    message: str(o.message, LIMITS.message),
    ...(p && typeof p.text === 'string' && p.text ? { partial: { text: p.text.slice(0, LIMITS.resultText), completionTokens: nat(p.completionTokens) } } : {})
  };
}
export const readCancel = (b) => ({ jobId: readJobId(obj(b)?.jobId) });
export const readRevoke = (b) => ({ jobId: readJobId(obj(b)?.jobId), reason: str(obj(b)?.reason, LIMITS.detail) });

const gb = (v) => (Number.isFinite(v) && v >= 0 ? Math.min(1e15, Math.round(v)) : null);
const pct = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : null);

/** resource.advert from a peer: what the scheduler may read, nothing else (no paths, no addresses). */
export function readAdvert(b) {
  const o = obj(b) || {};
  const cpu = obj(o.cpu) || {};
  const ram = obj(o.ram) || {};
  const share = obj(o.share) || {};
  const sg = obj(share.gpu) || {};
  const sc = obj(share.cpu) || {};
  const serving = obj(o.serving);
  const busy = obj(o.busy) || {};
  const VENDORS = ['nvidia', 'amd', 'intel', 'apple', 'other'];
  return {
    sampledAt: nat(o.sampledAt),
    cpu: { model: str(cpu.model, 120) || 'unknown', cores: Number.isInteger(cpu.cores) ? cpu.cores : null, threads: Number.isInteger(cpu.threads) ? cpu.threads : null, avx2: typeof cpu.avx2 === 'boolean' ? cpu.avx2 : null, loadPct: pct(cpu.loadPct) },
    ram: { totalBytes: gb(ram.totalBytes), freeBytes: gb(ram.freeBytes) },
    gpus: (Array.isArray(o.gpus) ? o.gpus : []).slice(0, 8).filter(obj).map((g, i) => ({
      index: i, name: str(g.name, 120) || 'GPU', vendor: VENDORS.includes(g.vendor) ? g.vendor : 'other',
      vramTotalBytes: gb(g.vramTotalBytes), vramFreeBytes: gb(g.vramFreeBytes), utilPct: pct(g.utilPct),
      source: str(g.source, 40) || 'unknown'
    })),
    models: (Array.isArray(o.models) ? o.models : []).slice(0, 32).filter(obj).map((m) => ({ id: str(m.id, 200), bytes: nat(m.bytes), loaded: m.loaded === true })),
    serving: serving && typeof serving.model === 'string' && (serving.device === 'gpu' || serving.device === 'cpu')
      ? { model: str(serving.model, 200), device: serving.device, gpuIndex: Number.isInteger(serving.gpuIndex) ? serving.gpuIndex : 0, ...(Number.isFinite(serving.vramBytes) ? { vramBytes: nat(serving.vramBytes) } : {}), ...(Number.isFinite(serving.bytes) ? { bytes: nat(serving.bytes) } : {}) }
      : null,
    share: {
      gpu: { enabled: sg.enabled === true, remoteInference: sg.remoteInference === true, maxConcurrentJobs: Math.max(1, Math.min(4, nat(sg.maxConcurrentJobs) || 1)), maxJobSeconds: Math.max(10, Math.min(1800, nat(sg.maxJobSeconds) || 120)), maxVramBytes: gb(sg.maxVramBytes), modelDownload: sg.modelDownload === true },
      cpu: { enabled: sc.enabled === true, maxThreads: nat(sc.maxThreads) || 1, maxRamBytes: gb(sc.maxRamBytes) },
      maxTokensPerJob: Math.max(1, Math.min(8192, nat(share.maxTokensPerJob) || 2048)),
      modelAllowlist: (Array.isArray(share.modelAllowlist) ? share.modelAllowlist : []).filter((m) => typeof m === 'string').slice(0, 16).map((m) => m.slice(0, 200))
    },
    insideHours: o.insideHours !== false,
    busy: { jobs: nat(busy.jobs, 64), turns: nat(busy.turns, 1000) }
  };
}
