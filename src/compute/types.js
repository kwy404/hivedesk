// Shapes and constants of the compute plane (docs/1.0/PLAN.md sections 2, 4, 5 and 8).
// Pure and import free, so the UI can load it too.
//
// The JSDoc typedefs below use the names of PLAN section 2. Two additions, both documented in
// docs/1.0/protocol/compute.md: ShareSettings gets separate `gpu` and `cpu` blocks (both off by
// default) and RejectCode gets "ram" for a CPU job that does not fit the owner's RAM limit.

/**
 * @typedef {string} PeerId
 *
 * @typedef {{ enabled: boolean, maxVramBytes: number | null, maxConcurrentJobs: number, maxJobSeconds: number,
 *             remoteInference: boolean, modelDownload: boolean }} GpuShare
 * @typedef {{ enabled: boolean, maxThreads: number, maxRamBytes: number | null }} CpuShare
 *
 * @typedef {Object} ShareSettings
 * @property {number}  v
 * @property {boolean} enabled            derived: gpu.enabled || cpu.enabled
 * @property {GpuShare} gpu
 * @property {CpuShare} cpu
 * @property {boolean} remoteInference    mirror of gpu.remoteInference (the frozen field)
 * @property {boolean} modelDownload      mirror of gpu.modelDownload
 * @property {number}  maxConcurrentJobs  mirror of gpu.maxConcurrentJobs
 * @property {number | null} maxVramBytes mirror of gpu.maxVramBytes
 * @property {number}  maxJobSeconds      mirror of gpu.maxJobSeconds; CPU jobs use the same duration
 * @property {number}  maxTokensPerJob
 * @property {string[]} modelAllowlist
 * @property {'known' | PeerId[]} peers
 * @property {{ from: string, to: string }} [hours]
 *
 * @typedef {'not_granted'|'sharing_off'|'busy'|'model_not_allowed'|'model_missing'|'vram'|'ram'|'too_long'|'rate_limited'|'outside_hours'|'bad_input'} RejectCode
 * @typedef {'timeout'|'cancelled'|'revoked'|'crashed'|'oom'|'lease_expired'|'disconnected'|'bad_output'} JobErrorCode
 *
 * @typedef {{ model: string, messages: Array<{ role: 'system'|'user'|'assistant', content: string }>, maxTokens: number,
 *             temperature?: number, format?: 'text'|'json', schema?: object }} InferenceInput
 *
 * @typedef {{ kind: 'local-gpu'|'local-cpu'|'peer-gpu'|'peer-cpu', peerId?: PeerId, gpuIndex?: number, model: string }} Target
 *
 * @typedef {{ target: Target, estimateMs: number, reason: string,
 *             candidates: Array<{ target: string, ok: boolean, code?: RejectCode, detail?: string, estimateMs?: number, score?: number }>,
 *             decidedAt: number }} SchedulerDecision
 *
 * @typedef {{ id: string, jobId: string, worker: PeerId, requester: PeerId, grantedAt: number, expiresAt: number,
 *             hardDeadline: number, limits: { maxTokens: number, vramBytes: number, model: string },
 *             state: 'active'|'released'|'expired'|'revoked' }} JobLease
 *
 * @typedef {Object} Job
 * @property {string} id
 * @property {'inference'} type
 * @property {PeerId} requester
 * @property {PeerId | 'local'} worker
 * @property {string} [taskId]
 * @property {string} [agentId]
 * @property {InferenceInput} input
 * @property {'interactive'|'normal'|'background'} priority
 * @property {'queued'|'offered'|'leased'|'running'|'completed'|'partial'|'failed'|'cancelled'|'expired'|'revoked'} state
 * @property {SchedulerDecision} [decision]
 * @property {Array<{ worker: PeerId | 'local', leaseId?: string, startedAt: string, endedAt?: string, outcome: string }>} attempts
 * @property {{ text: string, json?: unknown, promptTokens: number, completionTokens: number, ms: number, model: string }} [result]
 * @property {{ text: string, completionTokens: number }} [partial]
 * @property {{ code: JobErrorCode | RejectCode | 'no_candidate', message: string }} [error]
 * @property {string} createdAt
 * @property {string} [endedAt]
 */

/** 1.0 ships exactly one job type (PLAN section 5). */
export const JOB_TYPES = Object.freeze(['inference']);

export const REJECT_CODES = Object.freeze(['not_granted', 'sharing_off', 'busy', 'model_not_allowed', 'model_missing', 'vram', 'ram', 'too_long', 'rate_limited', 'outside_hours', 'bad_input']);
export const JOB_ERROR_CODES = Object.freeze(['timeout', 'cancelled', 'revoked', 'crashed', 'oom', 'lease_expired', 'disconnected', 'bad_output']);
export const JOB_STATES = Object.freeze(['queued', 'offered', 'leased', 'running', 'completed', 'partial', 'failed', 'cancelled', 'expired', 'revoked']);
export const FINAL_STATES = Object.freeze(new Set(['completed', 'partial', 'failed', 'cancelled', 'expired', 'revoked']));
export const PRIORITIES = Object.freeze(['interactive', 'normal', 'background']);

/** The capability a requester must hold on the worker (PLAN section 2). */
export const CAPABILITY = 'compute.inference';

/** Times from PLAN sections 2, 4 and 8, in milliseconds. */
export const TIMES = Object.freeze({
  leaseMs: 15_000,          // a lease lives 15 s and is renewed by heartbeats
  heartbeatMs: 5_000,       // the worker sends a heartbeat every 5 s
  noTokenMs: 30_000,        // a running job with no token for 30 s is a timeout
  resumeGraceMs: 15_000,    // a closed session gets 15 s to resume before the job fails
  advertMaxAgeMs: 15_000,   // a resource advert older than this is ignored by the scheduler
  unhealthyMs: 5 * 60_000,  // a target that crashed or ran out of memory is penalized this long
  tokenFlushMs: 20          // job.token frames: at most 50 per second
});

export const GB = 1e9;
/** Memory a worker keeps free for itself (PLAN section 6: a 1 GB reserve). */
export const VRAM_RESERVE = 1 * 1024 ** 3;

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** n random base32 characters from a random source (crypto.getRandomValues in Node 20 and browsers). */
export function base32Id(n, random = (len) => globalThis.crypto.getRandomValues(new Uint8Array(len))) {
  const bytes = random(n);
  let s = '';
  for (let i = 0; i < n; i++) s += B32[bytes[i] & 31];
  return s;
}

export const newJobId = () => `jb_${base32Id(16)}`;
export const newLeaseId = () => `ls_${base32Id(16)}`;

/** A typed error the requester and the worker both use. */
export class ComputeError extends Error {
  /** @param {string} code @param {string} message @param {object} [extra] */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'ComputeError';
    this.code = code;
    Object.assign(this, extra);
  }
}
