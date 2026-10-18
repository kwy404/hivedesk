// The registry of event types and their data schemas (PLAN.md section 1.3).
// Every module registers the types it emits. The bus validates on emit:
//   strict  (tests that ask for it, --strict): a bad or unregistered type throws
//   check   (under vitest): a registered type with bad data throws, unknown types pass
//   warn    (default): problems are counted in bus.warnings, the event is still written
import { validate, str, id, int, obj, arr, bool, ANY_OBJECT } from './schema.js';

/** @type {Map<string, { schema: object, domain: string }>} */
const exact = new Map();
/** @type {Array<{ prefix: string, schema: object, domain: string }>} */
const prefixes = [];

export function registerEvent(type, schema = ANY_OBJECT, domain = type.split('.')[0]) {
  if (typeof type !== 'string' || !/^[a-z][a-z0-9_.-]{0,80}$/.test(type)) throw new Error(`bad event type ${type}`);
  exact.set(type, { schema, domain });
}

/** A family of types a stream has not listed one by one yet (for example "remote."). Exact types win. */
export function registerEventPrefix(prefix, schema = ANY_OBJECT, domain = prefix.replace(/\.$/, '')) {
  if (!prefixes.some((p) => p.prefix === prefix)) prefixes.push({ prefix, schema, domain });
}

export function eventSpec(type) {
  const e = exact.get(type);
  if (e) return e;
  let best = null;
  for (const p of prefixes) if (type.startsWith(p.prefix) && (!best || p.prefix.length > best.prefix.length)) best = p;
  return best;
}

/** @returns {{ known: boolean, errors: string[] }} */
export function checkEvent(type, data) {
  const spec = eventSpec(type);
  if (!spec) return { known: false, errors: [`unregistered event type ${type}`] };
  return { known: true, errors: validate(spec.schema, data, `${type}`) };
}

export function registeredTypes() {
  return [...exact.keys()].sort();
}

// ---------------------------------------------------------------- the 0.2 types, kept as they are
const loose = ANY_OBJECT;
const LEGACY = [
  'approval.requested', 'approval.resolved', 'brain.attached', 'brain.choice', 'brain.detached', 'brain.download.failed',
  'brain.download.finished', 'brain.download.required', 'brain.download.started', 'brain.fallback', 'brain.runtime',
  'brain.served', 'brain.status', 'brief.approved', 'brief.proposed', 'changelog.proposed', 'changelog.written',
  'crew.fired', 'crew.hired', 'crew.updated', 'hardware.detected', 'job.cancelled', 'job.created', 'job.done', 'job.failed',
  'job.planned', 'job.planning', 'job.refining', 'job.report', 'job.resumed', 'memory.changed', 'memory.used',
  'playbook.deleted', 'playbook.saved', 'playbook.used', 'providers.changed', 'qa.report', 'queue.updated', 'run.finished',
  'session.stopped', 'settings.changed', 'task.added', 'task.updated', 'tool.called', 'tool.result', 'turn.ended',
  'turn.started', 'worker.note'
];
for (const t of LEGACY) registerEvent(t, loose);

registerEvent('session.started', obj({ version: str(40), demo: bool(), lend: bool() }));
registerEvent('chat.message', obj({ id: str(80), channel: str(80), from: str(80), text: str(20000) }, ['text']));
registerEvent('file.changed', obj({ path: str(1000), op: str(20) }, ['path']));
registerEvent('task.handoff', obj({ taskId: id(), from: id(120), to: id(120), title: str(300), kind: str(20), reason: str(400) }, ['taskId', 'from', 'to']), 'crew');
registerEvent('task.status', obj({ taskId: id(), status: str(40), note: str(4000) }, ['taskId', 'status']));
registerEvent('worker.status', obj({ workerId: id(), status: str(40) }, ['workerId', 'status']));

// Families owned by other modules and streams. Each stream replaces these with exact types as it lands.
for (const p of ['city.', 'github.', 'extension.', 'theme.', 'lend.', 'changelog.', 'p2p.', 'peer.', 'grant.', 'audit.', 'compute.', 'resources.', 'share.', 'workbench.', 'remote.', 'term.']) {
  registerEventPrefix(p, loose);
}

// ---------------------------------------------------------------- core and store
registerEvent('store.restored', obj({ snapshotSeq: int(), replayed: int(), ms: { type: 'number' }, interrupted: arr(id(120), 5000) }, ['snapshotSeq', 'replayed']), 'store');
registerEvent('store.migrated', obj({ migration: id(), detail: ANY_OBJECT }, ['migration']), 'store');

// ---------------------------------------------------------------- the 1.0 task engine (src/tasks/)
export const TASK_STATE_ENUM = ['queued', 'assigned', 'working', 'waiting', 'review', 'testing', 'completed', 'failed', 'cancelled'];
const waitingFor = obj({ kind: { enum: ['approval', 'dependency', 'resource', 'peer', 'user'] }, ref: str(400), deadline: str(40) }, ['kind'], { additionalProperties: false });
const failure = obj({ code: { enum: ['error', 'max_loops', 'dependency_failed', 'timeout', 'peer_lost', 'rejected'] }, message: str(2000) }, ['code'], { additionalProperties: false });
const createdBy = obj({ kind: { enum: ['user', 'planner', 'agent', 'peer'] }, id: str(120), peerId: str(80) }, ['kind', 'id']);
const artifact = obj({ id: id(), kind: { enum: ['file', 'diff', 'report', 'link', 'job', 'note'] }, path: str(1000), ref: str(400), label: str(300), bytes: int() }, ['id', 'kind']);

export const TASK_SCHEMA = obj({
  id: id(120), title: str(300), detail: str(16000), criteria: arr(str(500), 50), state: { enum: TASK_STATE_ENUM },
  dependsOn: arr(id(120), 100), assignee: { type: ['string', 'null'], maxLength: 120 }, pipeline: arr(str(40), 20),
  stage: int(0, 20), loops: int(0, 1000), maxLoops: int(0, 1000), attempts: int(0, 1000), maxAttempts: int(1, 1000),
  createdBy, owner: str(80), jobIds: arr(str(80), 500), waitingFor, failure, legacy: ANY_OBJECT, createdAt: str(40)
}, ['id', 'title', 'state', 'dependsOn', 'createdBy', 'owner']);

registerEvent('tasks.created', obj({ task: TASK_SCHEMA }, ['task']), 'tasks');
registerEvent('tasks.transition', obj({
  taskId: id(120), from: { enum: TASK_STATE_ENUM }, to: { enum: TASK_STATE_ENUM }, reason: str(1000),
  waitingFor, failure, assignee: { type: ['string', 'null'], maxLength: 120 }, stage: int(0, 20), loops: int(0, 1000), attempts: int(0, 1000),
  resumeTo: { enum: TASK_STATE_ENUM }
}, ['taskId', 'from', 'to'], { additionalProperties: false }), 'tasks');
registerEvent('tasks.updated', obj({ task: obj({ id: id(120) }, ['id']) }, ['task']), 'tasks');
registerEvent('tasks.logged', obj({ taskId: id(120), level: { enum: ['info', 'warn', 'error'] }, text: str(4000) }, ['taskId', 'text']), 'tasks');
registerEvent('tasks.artifact', obj({ taskId: id(120), artifact }, ['taskId', 'artifact']), 'tasks');

// ---------------------------------------------------------------- the p2p control plane (src/p2p/, Stream 2)
// A PeerId is 52 characters ("hd1" and base32); the schemas allow up to 80.
const peerIdS = id(80);
registerEvent('p2p.join', obj({ peerId: peerIdS, accepted: bool(), reason: str(200) }, ['peerId', 'accepted']), 'p2p');
registerEvent('p2p.peer', obj({ peerId: peerIdS, online: bool(), reason: str(200) }, ['peerId', 'online']), 'p2p');
registerEvent('p2p.grant', obj({ grantId: id(40), peerId: peerIdS, capability: str(60), expiresAt: { type: ['string', 'null'], maxLength: 40 }, scope: { enum: ['session', 'standing'] } }, ['grantId', 'peerId', 'capability']), 'p2p');
registerEvent('p2p.revoke', obj({ grantId: id(40), peerId: peerIdS, capability: str(60), reason: str(300) }, ['grantId', 'peerId']), 'p2p');

// ---------------------------------------------------------------- the compute plane (src/compute/, docs/1.0/protocol/compute.md)
// job.created is shared with the 0.x crew jobs ({ job }) and stays loose; compute's has { jobId, model, priority, taskId?, agentId? }.
const JOB_STATES = ['queued', 'offered', 'leased', 'running', 'completed', 'partial', 'failed', 'cancelled', 'expired', 'revoked'];
const jobId = id(80);
registerEvent('job.scheduled', obj({ jobId, decision: ANY_OBJECT }, ['jobId', 'decision']), 'compute');
registerEvent('job.state', obj({ jobId, state: { enum: JOB_STATES }, error: ANY_OBJECT, choices: arr(str(40), 10), choiceDeadline: str(40), waiting: ANY_OBJECT, usedPartial: bool() }, ['jobId', 'state']), 'compute');
registerEvent('job.ended', obj({ role: str(20), jobId, worker: { type: ['string', 'null'], maxLength: 80 }, model: str(200), state: { enum: JOB_STATES }, attempts: arr(ANY_OBJECT, 50), reason: str(1000), charsIn: int(), tokensOut: int(), createdAt: str(40), endedAt: str(40), error: str(40) }, ['jobId', 'state']), 'compute');
registerEvent('job.leased', obj({ jobId, peerId: str(80), leaseId: str(80), model: str(200), device: str(20), hardDeadline: { type: 'number' } }, ['jobId', 'leaseId']), 'compute');
registerEvent('job.running', obj({ jobId, peerId: str(80) }, ['jobId']), 'compute');
registerEvent('job.refused', obj({ jobId, peerId: str(80), code: str(40), detail: str(1000) }, ['jobId', 'code']), 'compute');
registerEvent('job.served', obj({ jobId, requester: str(80), model: str(200), device: str(20), leaseId: str(80), charsIn: int(), tokensOut: int(), ms: { type: 'number' }, outcome: str(40) }, ['jobId', 'outcome']), 'compute');
registerEvent('share.changed', obj({ share: ANY_OBJECT, why: str(200) }, ['share']), 'compute');
registerEvent('resources.changed', obj({ cpu: ANY_OBJECT, ram: ANY_OBJECT, gpus: arr(ANY_OBJECT, 16) }, ['cpu', 'ram', 'gpus']), 'compute');
