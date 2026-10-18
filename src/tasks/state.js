// The 1.0 task domain: one task model with nine states (PLAN.md section 2, Task).
// A pure reducer over the log. No imports: the UI loads this file from /lib/tasks.js.
//
// Three sources feed it:
//   tasks.*      events of the task engine (src/tasks/engine.js): native tasks, every change explicit
//   task.*       0.2 crew events: each crew task becomes the board task "crew:<id>"
//   city.task.*  0.2 city events: each city task becomes "city:<id>", or joins the crew task it mirrors
// Mapped tasks keep the 0.2 fields they come from in `src` and their state is derived from them,
// so a 0.2 log replays into the same board as a live run. Native tasks have no `src`.

export const TASKS_VERSION = 1;
export const TASK_STATES = Object.freeze(['queued', 'assigned', 'working', 'waiting', 'review', 'testing', 'completed', 'failed', 'cancelled']);
export const ACTIVE = new Set(['working', 'review', 'testing']);
export const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
export const WAIT_KINDS = Object.freeze(['approval', 'dependency', 'resource', 'peer', 'user']);
export const FAILURE_CODES = Object.freeze(['error', 'max_loops', 'dependency_failed', 'timeout', 'peer_lost', 'rejected']);

/** The transition table of the engine. Mapped 0.2 tasks record what happened even when it skips a step. */
export const TRANSITIONS = Object.freeze({
  queued: ['assigned', 'waiting', 'failed', 'cancelled'],
  assigned: ['queued', 'working', 'waiting', 'failed', 'cancelled'],
  working: ['assigned', 'waiting', 'review', 'testing', 'completed', 'failed', 'cancelled'],
  waiting: ['queued', 'assigned', 'working', 'review', 'testing', 'failed', 'cancelled'],
  review: ['assigned', 'working', 'testing', 'waiting', 'completed', 'failed', 'cancelled'],
  testing: ['assigned', 'working', 'review', 'waiting', 'completed', 'failed', 'cancelled'],
  completed: ['queued'],
  failed: ['queued', 'cancelled'],
  cancelled: ['queued']
});

export function canTransition(from, to) {
  return !!TRANSITIONS[from] && TRANSITIONS[from].includes(to);
}

export const HISTORY_LIMIT = 200;
export const LOG_LIMIT = 200;
export const ARTIFACT_LIMIT = 200;

export function initialTasks() {
  return { v: TASKS_VERSION, lastSeq: 0, tasks: {}, order: [], links: {} };
}

/** "user", "system", "crew:dev", "peer:hd1..." from an event's origin (events before 1.0 have none: system). */
export function byOf(event) {
  const o = event && event.origin;
  if (!o || typeof o !== 'object') return 'system';
  if (o.kind === 'peer') return `peer:${o.peerId || '?'}`;
  if (o.kind === 'crew') return o.agentId ? `crew:${o.agentId}` : 'crew';
  if (o.kind === 'user') return 'user';
  return 'system';
}

function sameWait(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.kind === b.kind && (a.ref || '') === (b.ref || '') && (a.deadline || '') === (b.deadline || '');
}

function capPush(list, item, limit) {
  list.push(item);
  if (list.length > limit) list.splice(0, list.length - limit);
}

/** Sets a state and writes the history line. No-op when nothing changes. */
function move(t, to, event, reason, extra = {}) {
  const from = t.state;
  const waitingFor = to === 'waiting' ? extra.waitingFor || t.waitingFor || { kind: 'user' } : undefined;
  const failure = to === 'failed' ? extra.failure || t.failure || { code: 'error' } : undefined;
  if (from === to && sameWait(t.waitingFor, waitingFor) && (to !== 'failed' || (t.failure && t.failure.code === failure.code))) return false;
  t.state = to;
  if (waitingFor) t.waitingFor = { ...waitingFor };
  else delete t.waitingFor;
  if (failure) t.failure = { ...failure };
  else delete t.failure;
  t.updatedAt = event.ts;
  capPush(t.history, { seq: event.seq, ts: event.ts, from, to, by: byOf(event), reason: String(reason || '').slice(0, 300) }, HISTORY_LIMIT);
  return true;
}

function newTask(fields, event) {
  return {
    id: fields.id, title: fields.title || 'Task', detail: fields.detail || '', criteria: fields.criteria || [],
    state: fields.state || 'queued', dependsOn: fields.dependsOn || [], assignee: fields.assignee ?? null,
    pipeline: fields.pipeline || [], stage: fields.stage || 0, loops: fields.loops || 0, maxLoops: fields.maxLoops ?? 3,
    attempts: fields.attempts || 0, maxAttempts: fields.maxAttempts || 2,
    createdBy: fields.createdBy || { kind: 'user', id: 'user' }, owner: fields.owner || 'local', jobIds: fields.jobIds || [],
    ...(fields.waitingFor ? { waitingFor: fields.waitingFor } : {}), ...(fields.failure ? { failure: fields.failure } : {}),
    ...(fields.legacy ? { legacy: { ...fields.legacy } } : {}), ...(fields.src ? { src: fields.src } : {}),
    history: [], logs: [], artifacts: [],
    createdAt: fields.createdAt || event.ts, updatedAt: event.ts
  };
}

function add(s, t) {
  if (!s.tasks[t.id]) s.order.push(t.id);
  s.tasks[t.id] = t;
  if (t.legacy?.crewTaskId) s.links[`crew:${t.legacy.crewTaskId}`] = t.id;
  if (t.legacy?.cityTaskId) s.links[`city:${t.legacy.cityTaskId}`] = t.id;
  if (t.legacy?.crewJobId && !t.src) s.links[`job:${t.legacy.crewJobId}`] = t.id;
  return t;
}

function log(t, event, text, level = 'info') {
  if (!t || !text) return;
  capPush(t.logs, { seq: event.seq, ts: event.ts, level, text: String(text).slice(0, 2000), by: byOf(event) }, LOG_LIMIT);
}

// ---------------------------------------------------------------- 0.2 crew tasks
function crewTarget(s, t) {
  const src = t.src;
  switch (src.status) {
    case 'pending':
    case 'ready': {
      const unmet = t.dependsOn.filter((d) => s.tasks[d] && s.tasks[d].state !== 'completed');
      if (unmet.length) return ['waiting', { waitingFor: { kind: 'dependency', ref: unmet.join(',') } }];
      return [t.assignee ? 'assigned' : 'queued', {}];
    }
    case 'running':
      if (src.approval) return ['waiting', { waitingFor: { kind: 'approval' } }];
      return [src.kind === 'qa' ? 'testing' : 'working', {}];
    case 'review': return ['review', {}];
    case 'done': return ['completed', {}];
    case 'failed': return ['failed', { failure: { code: 'error', message: src.note || 'the task failed' } }];
    case 'blocked': return ['failed', { failure: { code: 'dependency_failed', message: src.note || 'a task it depends on failed or was cancelled' } }];
    case 'skipped': return ['cancelled', {}];
    default: return [t.state, {}];
  }
}

// ---------------------------------------------------------------- 0.2 city tasks
const CITY_STATE = { open: 'queued', claimed: 'assigned', in_progress: 'working', in_review: 'review', in_test: 'testing', done: 'completed', cancelled: 'cancelled' };

function cityTarget(t) {
  const c = t.src.city;
  if (c.awaiting && !['done', 'blocked', 'cancelled'].includes(c.status)) return ['waiting', { waitingFor: { kind: 'approval', ref: String(c.awaiting) } }];
  if (c.status === 'blocked') {
    const code = (c.loops || 0) >= (c.maxLoops ?? 3) && c.maxLoops > 0 ? 'max_loops' : 'error';
    return ['failed', { failure: { code, message: c.reason || 'blocked' } }];
  }
  return [CITY_STATE[c.status] || t.state, {}];
}

function derive(s, t, event, reason) {
  if (!t || !t.src) return false;
  const [to, extra] = t.src.driver === 'city' ? cityTarget(t) : crewTarget(s, t);
  const changed = move(t, to, event, reason, extra);
  if (changed) rederiveDependents(s, t.id, event);
  return changed;
}

/** Mapped tasks waiting on `id` (or no longer able to) look again. */
function rederiveDependents(s, id, event, depth = 0) {
  if (depth > 50) return;
  for (const other of Object.values(s.tasks)) {
    if (!other.src || other.src.driver === 'city' || !other.dependsOn.includes(id)) continue;
    if (other.src.status !== 'pending' && other.src.status !== 'ready') continue;
    const [to, extra] = crewTarget(s, other);
    if (move(other, to, event, `${id} is ${s.tasks[id]?.state}`, extra)) rederiveDependents(s, other.id, event, depth + 1);
  }
}

function crewTaskFrom(ct, jobId, event) {
  return newTask({
    id: `crew:${ct.id}`, title: String(ct.title || 'Task').slice(0, 300), detail: String(ct.detail || '').slice(0, 16000),
    dependsOn: (ct.dependsOn || []).map((d) => `crew:${d}`), assignee: ct.assignee || null, maxLoops: 0, attempts: ct.attempts || 0,
    createdBy: { kind: 'planner', id: 'mel' }, owner: 'local', legacy: { crewTaskId: ct.id, crewJobId: jobId },
    src: { driver: 'crew', status: ct.status || 'pending', kind: ct.kind || 'build', approval: false, note: '' }
  }, event);
}

function crewCreated(s, ct, jobId, event) {
  if (!ct || !ct.id) return;
  const owner = jobId && s.links[`job:${jobId}`];
  if (owner && s.tasks[owner]) {
    // A crew job run for a city task or a native task: its crew tasks are the steps of that one task.
    s.links[`crew:${ct.id}`] = owner;
    log(s.tasks[owner], event, `step: ${ct.title || ct.id}`);
    return;
  }
  if (s.links[`crew:${ct.id}`]) return;
  const t = add(s, crewTaskFrom(ct, jobId, event));
  derive(s, t, event, 'planned');
}

/** The board task a crew event talks about, when the crew drives it. */
function crewDriven(s, taskId) {
  const id = s.links[`crew:${taskId}`];
  const t = id && s.tasks[id];
  return t && t.src && t.src.driver === 'crew' ? t : null;
}

const CITY_FIELDS = ['status', 'awaiting', 'agentId', 'reason', 'loops', 'maxLoops', 'stage', 'pipeline', 'room'];

function cityPatch(s, t, patch, event, reason) {
  if (!t) return;
  if (!t.src || t.src.driver !== 'city') {
    // A native task linked to a city task: the city does not drive it, its events are only logged.
    if (patch.status) log(t, event, `city: ${patch.status}`);
    return;
  }
  const c = t.src.city;
  for (const k of CITY_FIELDS) if (k in patch) c[k] = patch[k];
  // The last agent stays the assignee of a finished task; an open (queued) city task has none.
  if (patch.agentId) t.assignee = String(patch.agentId);
  if (Array.isArray(patch.pipeline)) t.pipeline = patch.pipeline.slice(0, 20);
  if (Number.isInteger(patch.stage)) t.stage = patch.stage;
  if (Number.isInteger(patch.loops)) t.loops = patch.loops;
  if (Number.isInteger(patch.maxLoops)) t.maxLoops = patch.maxLoops;
  if (patch.jobId && !t.legacy?.cityJobs?.includes(patch.jobId)) {
    t.legacy = { ...(t.legacy || {}), cityJobs: [...(t.legacy?.cityJobs || []), patch.jobId].slice(-50) };
    s.links[`job:${patch.jobId}`] = t.id;
  }
  t.updatedAt = event.ts;
  derive(s, t, event, reason);
  if (t.state === 'queued') t.assignee = null;
}

function cityCreatedBy(cb) {
  if (!cb || typeof cb !== 'object') return { kind: 'user', id: 'user' };
  if (cb.kind === 'guest') return { kind: 'peer', id: String(cb.id || 'guest') };
  if (cb.kind === 'planner') return { kind: 'planner', id: String(cb.id || 'mel') };
  if (cb.kind === 'agent') return { kind: 'agent', id: String(cb.id || '') };
  return { kind: 'user', id: 'user' };
}

function cityCreated(s, ct, event) {
  if (!ct || !ct.id || s.links[`city:${ct.id}`]) return;
  const city = { status: ct.status || 'open', awaiting: ct.awaiting || null, agentId: ct.agentId || null, reason: ct.reason || '', loops: ct.loops || 0, maxLoops: ct.maxLoops ?? 3, stage: ct.stage || 0, pipeline: ct.pipeline || [], room: ct.room || null };
  const mirrored = ct.link && ct.link.taskId ? s.tasks[s.links[`crew:${ct.link.taskId}`]] : null;
  if (mirrored && mirrored.src) {
    // The city task of a planner task: one task on the board, driven by the city (it has the review and test rooms).
    mirrored.legacy = { ...(mirrored.legacy || {}), cityTaskId: ct.id };
    mirrored.src = { driver: 'city', city, crew: mirrored.src };
    if (Array.isArray(ct.criteria) && ct.criteria.length) mirrored.criteria = ct.criteria.slice(0, 50);
    mirrored.pipeline = (ct.pipeline || []).slice(0, 20);
    mirrored.maxLoops = city.maxLoops;
    s.links[`city:${ct.id}`] = mirrored.id;
    derive(s, mirrored, event, 'in the city');
    return;
  }
  if (mirrored) {
    // The city mirrors a crew step of a native task: the native task stays the one board task, the city only logs.
    s.links[`city:${ct.id}`] = mirrored.id;
    log(mirrored, event, `in the city as ${ct.id}`);
    return;
  }
  const guest = ct.createdBy && ct.createdBy.kind === 'guest';
  const t = add(s, newTask({
    id: `city:${ct.id}`, title: String(ct.title || 'Task').slice(0, 300), detail: String(ct.detail || '').slice(0, 16000),
    criteria: Array.isArray(ct.criteria) ? ct.criteria.slice(0, 50) : [], pipeline: (ct.pipeline || []).slice(0, 20), stage: city.stage,
    loops: city.loops, maxLoops: city.maxLoops, assignee: city.agentId, createdBy: cityCreatedBy(ct.createdBy),
    owner: guest ? `guest:${ct.createdBy.id}` : 'local', createdAt: ct.createdAt, legacy: { cityTaskId: ct.id },
    src: { driver: 'city', city }
  }, event));
  derive(s, t, event, 'created in the city');
}

const PATCHABLE = ['title', 'detail', 'criteria', 'assignee', 'pipeline', 'stage', 'dependsOn', 'jobIds', 'maxLoops', 'maxAttempts', 'loops', 'attempts'];

/**
 * Applies one event, mutating the domain state. Unknown types are ignored.
 * @returns the same state
 */
export function reduceTasks(s, event) {
  if (!s || !event || typeof event.seq !== 'number') return s;
  if (event.seq > s.lastSeq) s.lastSeq = event.seq;
  const d = event.data || {};
  const type = event.type;
  switch (type) {
    // ---- native ----
    case 'tasks.created':
      if (d.task && d.task.id && !s.tasks[d.task.id]) add(s, newTask({ ...d.task, src: undefined }, event));
      break;
    case 'tasks.transition': {
      const t = s.tasks[d.taskId];
      if (!t || t.src) break;
      for (const k of ['assignee', 'stage', 'loops', 'attempts']) if (d[k] !== undefined) t[k] = d[k];
      if (d.resumeTo) t.resumeTo = d.resumeTo;
      else if (d.to !== 'waiting') delete t.resumeTo;
      move(t, d.to, event, d.reason, { waitingFor: d.waitingFor, failure: d.failure });
      break;
    }
    case 'tasks.updated': {
      const t = d.task && s.tasks[d.task.id];
      if (!t) break;
      for (const k of PATCHABLE) if (k in d.task) t[k] = d.task[k];
      if (d.task.legacy && typeof d.task.legacy === 'object') {
        t.legacy = { ...(t.legacy || {}), ...d.task.legacy };
        if (t.legacy.crewJobId && !t.src) s.links[`job:${t.legacy.crewJobId}`] = t.id;
        if (t.legacy.cityTaskId) s.links[`city:${t.legacy.cityTaskId}`] = t.id;
      }
      t.updatedAt = event.ts;
      break;
    }
    case 'tasks.logged':
      log(s.tasks[d.taskId], event, d.text, d.level || 'info');
      break;
    case 'tasks.artifact': {
      const t = s.tasks[d.taskId];
      if (!t || !d.artifact || !d.artifact.id) break;
      const a = { ...d.artifact, ts: event.ts, seq: event.seq };
      const i = t.artifacts.findIndex((x) => x.id === a.id);
      if (i >= 0) t.artifacts[i] = a;
      else capPush(t.artifacts, a, ARTIFACT_LIMIT);
      break;
    }

    // ---- 0.2 crew ----
    case 'job.created': {
      const job = d.job || {};
      const jobId = event.jobId || job.id;
      if (!jobId) break;
      if (job.cityTaskId && s.links[`city:${job.cityTaskId}`]) s.links[`job:${jobId}`] = s.links[`city:${job.cityTaskId}`];
      if (job.taskRef && s.tasks[job.taskRef]) s.links[`job:${jobId}`] = job.taskRef;
      break;
    }
    case 'job.planned':
      for (const ct of d.tasks || []) crewCreated(s, ct, event.jobId || ct.jobId, event);
      break;
    case 'task.added':
      crewCreated(s, d.task, (d.task && d.task.jobId) || event.jobId, event);
      break;
    case 'task.status': {
      const id = s.links[`crew:${d.taskId}`];
      const t = id && s.tasks[id];
      if (!t) break;
      if (d.note) log(t, event, `${d.status}: ${d.note}`);
      const driven = crewDriven(s, d.taskId);
      if (!driven) break;
      driven.src.status = d.status;
      driven.src.note = d.note || '';
      if (d.status === 'running') { driven.attempts += 1; driven.src.approval = false; }
      derive(s, driven, event, d.note || d.status);
      break;
    }
    case 'task.updated': {
      const driven = d.task && crewDriven(s, d.task.id);
      if (!driven) break;
      if (typeof d.task.assignee === 'string') driven.assignee = d.task.assignee;
      if (typeof d.task.title === 'string') driven.title = d.task.title.slice(0, 300);
      if (typeof d.task.detail === 'string') driven.detail = d.task.detail.slice(0, 16000);
      driven.updatedAt = event.ts;
      derive(s, driven, event, 'updated');
      break;
    }
    case 'worker.status': {
      if (!d.taskId) break;
      const driven = crewDriven(s, d.taskId);
      if (!driven || driven.src.status !== 'running') break;
      const waiting = d.status === 'waiting_approval';
      if (waiting === !!driven.src.approval) break;
      driven.src.approval = waiting;
      derive(s, driven, event, waiting ? `${d.workerId} waits for an approval` : `${d.workerId} goes on`);
      break;
    }
    case 'qa.report': {
      const id = s.links[`crew:${d.taskId}`];
      if (id) log(s.tasks[id], event, d.passed ? 'QA passed' : `QA found ${(d.issues || []).length} issues`, d.passed ? 'info' : 'warn');
      break;
    }

    // ---- 0.2 city ----
    case 'city.task.created':
      cityCreated(s, d.task, event);
      break;
    case 'city.task.claimed':
      cityPatch(s, s.tasks[s.links[`city:${d.taskId}`]], { status: 'claimed', agentId: d.agentId || null, ...(d.room ? { room: d.room } : {}) }, event, `claimed by ${d.agentId}`);
      break;
    case 'city.task.hop':
    case 'city.task.updated': {
      const patch = d.task || {};
      if (!patch.id) break;
      const reason = type === 'city.task.hop' ? `hop to ${patch.room || (d.hop && d.hop.to) || 'the next room'}` : 'updated in the city';
      cityPatch(s, s.tasks[s.links[`city:${patch.id}`]], patch, event, reason);
      break;
    }
    case 'city.task.awaiting':
      cityPatch(s, s.tasks[s.links[`city:${d.taskId}`]], { awaiting: d.room || null }, event, d.room ? `waits for approval in ${d.room}` : 'approval answered');
      break;
    case 'city.task.verdict': {
      const t = s.tasks[s.links[`city:${d.taskId}`]];
      if (t) log(t, event, `${d.room}: ${d.passed ? 'passed' : `failed (${(d.issues || []).slice(0, 3).join('; ')})`} by ${d.by || 'agent'}`, d.passed ? 'info' : 'warn');
      break;
    }
    case 'city.task.done':
      cityPatch(s, s.tasks[s.links[`city:${d.taskId}`]], { status: 'done', awaiting: null }, event, `done${d.by ? ` (${d.by})` : ''}`);
      break;
    case 'city.task.blocked':
      cityPatch(s, s.tasks[s.links[`city:${d.taskId}`]], { status: 'blocked', awaiting: null, reason: d.reason || '' }, event, d.reason || 'blocked');
      break;
    case 'city.task.cancelled':
      cityPatch(s, s.tasks[s.links[`city:${d.taskId}`]], { status: 'cancelled', awaiting: null }, event, `cancelled${d.by ? ` by ${d.by}` : ''}`);
      break;
    default:
      break;
  }
  return s;
}

/** Rebuilds the board from a list of events. */
export function replayTasks(events, upto = Infinity) {
  const s = initialTasks();
  for (const e of events) {
    if (e.seq > upto) break;
    reduceTasks(s, e);
  }
  return s;
}

/** Tasks in board order, optionally of some states. */
export function listTasks(s, states) {
  const want = states ? new Set(Array.isArray(states) ? states : [states]) : null;
  return s.order.map((id) => s.tasks[id]).filter((t) => t && (!want || want.has(t.state)));
}

/** Counts by state, every state present. */
export function countByState(s) {
  const out = Object.fromEntries(TASK_STATES.map((k) => [k, 0]));
  for (const id of s.order) { const t = s.tasks[id]; if (t) out[t.state] += 1; }
  return out;
}
