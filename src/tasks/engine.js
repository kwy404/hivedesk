// The 1.0 task engine (PLAN.md section 2, Task; section 8, failure states).
// One task model with nine states, dependencies, retry, reassign, cancel, history, logs and artifacts.
// Native tasks change only through this engine, and every change is a tasks.* event.
// Crew and city tasks of 0.2 appear on the same board (src/tasks/state.js); for them the engine passes
// retry, reassign and cancel to the module that runs them, so there is one task API.
import crypto from 'node:crypto';
import { canTransition, TERMINAL, ACTIVE, listTasks, countByState } from './state.js';
import { CommandError } from '../core/router.js';
import { msUntil, isoIn } from '../core/deadline.js';
import { originLabel } from '../core/origin.js';

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
function randomId(prefix, n = 12) {
  const bytes = crypto.randomBytes(n);
  let s = '';
  for (const b of bytes) s += B32[b & 31];
  return `${prefix}${s}`;
}

const fail = (code, message) => { throw new CommandError(code, message); };
const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** How long a task waits for a peer after its job failed before it fails for good (PLAN.md section 8). */
export const PEER_WAIT_MS = 120_000;
/** Job errors worth one more try on another candidate. */
const RETRYABLE = new Set(['timeout', 'disconnected', 'lease_expired', 'crashed', 'oom', 'bad_output']);
const JOB_TO_FAILURE = { timeout: 'timeout', disconnected: 'peer_lost', lease_expired: 'peer_lost', revoked: 'rejected', cancelled: 'error', crashed: 'error', oom: 'error', bad_output: 'error' };

export class TaskEngine {
  /**
   * @param {{
   *   bus: import('../core/bus.js').EventBus,
   *   hive?: import('../crew/engine.js').Hive,
   *   dispatch?: (type: string, data: object, origin: object) => Promise<any>,
   *   localPeerId?: () => string,
   *   now?: () => number
   * }} opts
   * dispatch: runs a command with the same origin (the city commands for city tasks).
   * localPeerId: this engine's PeerId (src/p2p/ sets it); "local" until then.
   */
  constructor(opts) {
    this.bus = opts.bus;
    this.hive = opts.hive || null;
    this.dispatch = opts.dispatch || null;
    this.localPeerId = opts.localPeerId || (() => 'local');
    this.now = opts.now || Date.now;
    /** @type {Map<string, NodeJS.Timeout>} */
    this.timers = new Map();
    this._busy = false;
    this._dirty = false;
    this._off = this.bus.on((e) => this._onEvent(e));
    this._closed = false;
  }

  get board() {
    return this.bus.state.board;
  }

  // ---------------------------------------------------------------- reading
  get(id) {
    return this.board.tasks[id] || null;
  }

  _need(id) {
    const t = this.get(String(id || ''));
    if (!t) fail('not_found', `no task ${id}`);
    return t;
  }

  list(filter = {}) {
    let out = listTasks(this.board, filter.state);
    if (filter.assignee) out = out.filter((t) => t.assignee === filter.assignee);
    if (filter.native) out = out.filter((t) => !t.src);
    return out;
  }

  counts() {
    return countByState(this.board);
  }

  history(id) {
    return this._need(id).history;
  }

  // ---------------------------------------------------------------- writing
  _emit(type, data) {
    return this.bus.emit(type, data);
  }

  _native(t, verb) {
    if (t.src) fail('conflict', `${t.id} is run by the ${t.src.driver}; ${verb} it there`);
    return t;
  }

  _move(t, to, extra = {}) {
    if (t.state === to && to !== 'waiting') return t;
    // waiting to waiting is allowed: what it waits for changed (fewer dependencies, a new deadline).
    if (!(t.state === 'waiting' && to === 'waiting') && !canTransition(t.state, to)) fail('conflict', `task ${t.id} cannot go from ${t.state} to ${to}`);
    const data = { taskId: t.id, from: t.state, to };
    if (extra.reason) data.reason = String(extra.reason).slice(0, 1000);
    for (const k of ['waitingFor', 'failure', 'assignee', 'stage', 'loops', 'attempts', 'resumeTo']) if (extra[k] !== undefined) data[k] = extra[k];
    this._emit('tasks.transition', data);
    this._timersFor(this.get(t.id));
    return this.get(t.id);
  }

  /**
   * Creates a native task. Its dependencies must exist; it waits for them when they are not completed.
   * @param {{ title: string, detail?: string, criteria?: string[], dependsOn?: string[], assignee?: string | null,
   *   pipeline?: string[], maxLoops?: number, maxAttempts?: number, run?: 'crew' | null, legacy?: object }} spec
   * @param {{ origin?: { kind: string, peerId?: string, agentId?: string } }} [ctx]
   */
  create(spec = {}, ctx = {}) {
    const title = text(spec.title, 300);
    if (!title) fail('bad_request', 'title is required');
    const deps = [...new Set((Array.isArray(spec.dependsOn) ? spec.dependsOn : []).map((d) => String(d)))].slice(0, 100);
    for (const d of deps) if (!this.get(d)) fail('bad_request', `unknown dependency ${d}`);
    const origin = ctx.origin || { kind: 'user' };
    const createdBy = origin.kind === 'peer'
      ? { kind: 'peer', id: origin.peerId, peerId: origin.peerId }
      : origin.kind === 'crew' ? { kind: spec.planner ? 'planner' : 'agent', id: origin.agentId || 'crew' } : { kind: 'user', id: 'user' };
    const task = {
      id: randomId('tk_'), title, detail: text(spec.detail, 16000),
      criteria: (Array.isArray(spec.criteria) ? spec.criteria : []).map((c) => text(c, 500)).filter(Boolean).slice(0, 50),
      state: 'queued', dependsOn: deps, assignee: text(spec.assignee || '', 120) || null,
      pipeline: (Array.isArray(spec.pipeline) ? spec.pipeline : []).map((p) => text(p, 40)).filter(Boolean).slice(0, 20), stage: 0,
      loops: 0, maxLoops: clampInt(spec.maxLoops, 0, 20, 3), attempts: 0, maxAttempts: clampInt(spec.maxAttempts, 1, 10, 2),
      createdBy, owner: this.localPeerId(), jobIds: [], createdAt: new Date(this.now()).toISOString()
    };
    const legacy = {};
    if (spec.run === 'crew') legacy.run = 'crew';
    if (spec.legacy && typeof spec.legacy === 'object') {
      if (typeof spec.legacy.cityTaskId === 'string') legacy.cityTaskId = spec.legacy.cityTaskId.slice(0, 80);
    }
    if (Object.keys(legacy).length) task.legacy = legacy;
    this._emit('tasks.created', { task });
    this._reconcile(task.id);
    const t = this.get(task.id);
    if (t.state === 'queued' && t.assignee) this._move(t, 'assigned', { assignee: t.assignee, reason: 'assigned at creation' });
    return this.get(task.id);
  }

  /** Changes what a task is about. A new dependency list is checked for cycles. */
  update(id, patch = {}, ctx = {}) {
    const t = this._native(this._own(this._need(id), ctx), 'change');
    const out = { id: t.id };
    if (typeof patch.title === 'string' && text(patch.title, 300)) out.title = text(patch.title, 300);
    if (typeof patch.detail === 'string') out.detail = text(patch.detail, 16000);
    if (Array.isArray(patch.criteria)) out.criteria = patch.criteria.map((c) => text(c, 500)).filter(Boolean).slice(0, 50);
    if (Array.isArray(patch.pipeline)) out.pipeline = patch.pipeline.map((p) => text(p, 40)).filter(Boolean).slice(0, 20);
    if (Array.isArray(patch.dependsOn)) {
      const deps = [...new Set(patch.dependsOn.map(String))].slice(0, 100);
      for (const d of deps) {
        if (!this.get(d)) fail('bad_request', `unknown dependency ${d}`);
        if (d === t.id || this._reaches(d, t.id)) fail('bad_request', `${d} already depends on ${t.id}: that would be a cycle`);
      }
      out.dependsOn = deps;
    }
    if (Number.isInteger(patch.maxLoops)) out.maxLoops = clampInt(patch.maxLoops, 0, 20, 3);
    if (Number.isInteger(patch.maxAttempts)) out.maxAttempts = clampInt(patch.maxAttempts, 1, 10, 2);
    if (Object.keys(out).length > 1) this._emit('tasks.updated', { task: out });
    if (out.dependsOn) this._reconcile(t.id);
    return this.get(t.id);
  }

  /** True when `from` depends (directly or not) on `to`. */
  _reaches(from, to, seen = new Set()) {
    if (from === to) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    const t = this.get(from);
    return !!t && t.dependsOn.some((d) => this._reaches(d, to, seen));
  }

  assign(id, agentId, ctx = {}) {
    const t = this._native(this._need(id), 'assign');
    const who = text(agentId, 120);
    if (!who) fail('bad_request', 'agentId is required');
    if (t.state === 'queued') return this._move(t, 'assigned', { assignee: who, reason: ctx.reason || `assigned to ${who}` });
    if (t.state === 'assigned' || t.state === 'waiting') {
      this._emit('tasks.updated', { task: { id: t.id, assignee: who } });
      return this.get(t.id);
    }
    return this.reassign(id, who, ctx);
  }

  /** assigned to working. Counts an attempt. */
  start(id, ctx = {}) {
    const t = this._native(this._need(id), 'start');
    if (t.state !== 'assigned' && t.state !== 'waiting') fail('conflict', `task ${t.id} is ${t.state}; only an assigned task starts`);
    if (t.state === 'waiting' && t.waitingFor?.kind === 'dependency') fail('conflict', `task ${t.id} waits for ${t.waitingFor.ref}`);
    return this._move(t, 'working', { attempts: t.attempts + 1, reason: ctx.reason || 'started' });
  }

  /** working to review, optionally at the next pipeline stage. */
  review(id, ctx = {}) {
    const t = this._native(this._need(id), 'review');
    return this._move(t, 'review', { reason: ctx.reason || 'sent to review', ...(Number.isInteger(ctx.stage) ? { stage: ctx.stage } : {}) });
  }

  test(id, ctx = {}) {
    const t = this._native(this._need(id), 'test');
    return this._move(t, 'testing', { reason: ctx.reason || 'sent to test', ...(Number.isInteger(ctx.stage) ? { stage: ctx.stage } : {}) });
  }

  /** Review or test found problems: back to working, one loop more; past maxLoops the task fails with max_loops. */
  loopBack(id, ctx = {}) {
    const t = this._native(this._need(id), 'loop');
    if (t.state !== 'review' && t.state !== 'testing') fail('conflict', `task ${t.id} is ${t.state}; only review and testing loop back`);
    const loops = t.loops + 1;
    if (loops > t.maxLoops) return this._move(t, 'failed', { loops, failure: { code: 'max_loops', message: `still not passing after ${t.maxLoops} loops${ctx.reason ? `: ${ctx.reason}` : ''}`.slice(0, 2000) }, reason: 'too many loops' });
    return this._move(t, 'working', { loops, reason: ctx.reason || `loop ${loops}`, ...(Number.isInteger(ctx.stage) ? { stage: ctx.stage } : {}) });
  }

  /**
   * Waits for something. Every wait can have a deadline; peer and resource waits fail when it passes,
   * approval and user waits only show it (PLAN.md section 8).
   * @param {{ kind: 'approval' | 'resource' | 'peer' | 'user', ref?: string, deadlineMs?: number, deadline?: string }} what
   */
  wait(id, what = {}, ctx = {}) {
    const t = this._native(this._need(id), 'pause');
    if (!['approval', 'resource', 'peer', 'user'].includes(what.kind)) fail('bad_request', 'kind must be approval, resource, peer or user');
    if (TERMINAL.has(t.state)) fail('conflict', `task ${t.id} is ${t.state}`);
    const waitingFor = { kind: what.kind };
    if (what.ref) waitingFor.ref = String(what.ref).slice(0, 400);
    const deadline = what.deadline || (Number.isFinite(what.deadlineMs) ? isoIn(what.deadlineMs, this.now) : what.kind === 'peer' ? isoIn(PEER_WAIT_MS, this.now) : null);
    if (deadline) waitingFor.deadline = deadline;
    const resumeTo = t.state === 'waiting' ? t.resumeTo : t.state;
    return this._move(t, 'waiting', { waitingFor, resumeTo, reason: ctx.reason || `waits for ${what.kind}` });
  }

  /** Ends a wait: back to the state it left (working, review, testing, assigned or queued). */
  resume(id, ctx = {}) {
    const t = this._native(this._need(id), 'resume');
    if (t.state !== 'waiting') fail('conflict', `task ${t.id} is not waiting`);
    if (t.waitingFor?.kind === 'dependency') fail('conflict', `task ${t.id} waits for its dependencies`);
    const to = t.resumeTo && t.resumeTo !== 'waiting' ? t.resumeTo : t.assignee ? 'assigned' : 'queued';
    // Going on after a failed job is a new attempt (the retry policy counts them).
    const again = t.waitingFor?.kind === 'peer' && ACTIVE.has(to);
    return this._move(t, to, { reason: ctx.reason || 'goes on', ...(again ? { attempts: t.attempts + 1 } : {}) });
  }

  complete(id, ctx = {}) {
    const t = this._native(this._need(id), 'complete');
    if (!ACTIVE.has(t.state)) fail('conflict', `task ${t.id} is ${t.state}; only a working, review or testing task completes`);
    return this._move(t, 'completed', { reason: ctx.reason || 'completed', ...(t.pipeline.length ? { stage: t.pipeline.length } : {}) });
  }

  /** @param {{ code?: string, message?: string }} failure */
  failTask(id, failure = {}, ctx = {}) {
    const t = this._native(this._need(id), 'fail');
    if (TERMINAL.has(t.state)) fail('conflict', `task ${t.id} is already ${t.state}`);
    const code = ['error', 'max_loops', 'dependency_failed', 'timeout', 'peer_lost', 'rejected'].includes(failure.code) ? failure.code : 'error';
    return this._move(t, 'failed', { failure: { code, message: text(failure.message || '', 2000) || code }, reason: ctx.reason || failure.message || code });
  }

  /**
   * A compute job of this task failed (src/compute/). The task never stays in working:
   * with attempts left and a retryable error it waits for a peer (Retry locally, Retry another peer, Cancel),
   * otherwise it fails.
   * @param {{ jobId?: string, code: string, message?: string }} job
   */
  jobFailed(id, job = {}, ctx = {}) {
    const t = this._native(this._need(id), 'fail');
    if (TERMINAL.has(t.state)) return t;
    const code = String(job.code || 'crashed');
    if (job.jobId && !t.jobIds.includes(job.jobId)) this._emit('tasks.updated', { task: { id: t.id, jobIds: [...t.jobIds, String(job.jobId).slice(0, 80)].slice(-500) } });
    if (RETRYABLE.has(code) && t.attempts < t.maxAttempts) {
      return this.wait(t.id, { kind: 'peer', ref: job.jobId || code }, { reason: `job ${job.jobId || ''} failed: ${code}${job.message ? ` (${job.message})` : ''}`.trim() });
    }
    return this.failTask(t.id, { code: JOB_TO_FAILURE[code] || 'error', message: job.message || `the job failed: ${code}` }, ctx);
  }

  /** Puts a finished task back in line. Tasks that failed because of it wait for it again. */
  retry(id, ctx = {}) {
    const t = this._own(this._need(id), ctx);
    if (t.src) return this._delegate(t, 'retry', {}, ctx);
    if (!TERMINAL.has(t.state) && !(t.state === 'waiting' && t.waitingFor?.kind === 'peer')) fail('conflict', `task ${t.id} is ${t.state}; only failed, cancelled, completed or peer waiting tasks are retried`);
    this._move(t, 'queued', { reason: ctx.reason || 'retry', loops: 0 });
    this._reconcile(t.id);
    const now = this.get(t.id);
    if (now.state === 'queued' && now.assignee) this._move(now, 'assigned', { reason: 'retry with the same assignee' });
    for (const other of Object.values(this.board.tasks)) {
      if (!other.src && other.state === 'failed' && other.failure?.code === 'dependency_failed' && other.dependsOn.includes(t.id)) this.retry(other.id, { ...ctx, reason: `unblocked by the retry of ${t.id}` });
    }
    return this.get(t.id);
  }

  /** Gives a task to another agent. An active task goes back to assigned so its runner starts over. */
  reassign(id, agentId, ctx = {}) {
    const t = this._own(this._need(id), ctx);
    const who = text(agentId, 120);
    if (!who) fail('bad_request', 'agentId is required');
    if (t.src) return this._delegate(t, 'reassign', { agentId: who }, ctx);
    if (t.state === 'completed') fail('conflict', 'the task is completed; retry it instead');
    if (t.state === 'cancelled' || t.state === 'failed') {
      this._emit('tasks.updated', { task: { id: t.id, assignee: who } });
      return this.retry(t.id, { ...ctx, reason: `reassigned to ${who}` });
    }
    if (t.state === 'queued') return this._move(t, 'assigned', { assignee: who, reason: `reassigned to ${who}` });
    if (t.state === 'assigned' || t.state === 'waiting') {
      this._emit('tasks.updated', { task: { id: t.id, assignee: who } });
      this._emit('tasks.logged', { taskId: t.id, level: 'info', text: `reassigned to ${who}` });
      return this.get(t.id);
    }
    return this._move(t, 'assigned', { assignee: who, reason: `reassigned to ${who}` });
  }

  /** Cancels a task; tasks that depend on it fail with dependency_failed. */
  cancel(id, ctx = {}) {
    const t = this._own(this._need(id), ctx);
    if (t.src) return this._delegate(t, 'cancel', {}, ctx);
    if (TERMINAL.has(t.state)) fail('conflict', `task ${t.id} is already ${t.state}`);
    return this._move(t, 'cancelled', { reason: ctx.reason || `cancelled by ${originLabel(ctx.origin || { kind: 'user' })}` });
  }

  log(id, line, level = 'info', ctx = {}) {
    const t = this._need(id);
    const msg = text(line, 4000);
    if (!msg) fail('bad_request', 'text is required');
    this._emit('tasks.logged', { taskId: t.id, level: ['info', 'warn', 'error'].includes(level) ? level : 'info', text: msg });
    return this.get(t.id);
  }

  /** @param {{ kind: 'file' | 'diff' | 'report' | 'link' | 'job' | 'note', path?: string, ref?: string, label?: string, bytes?: number, id?: string }} a */
  artifact(id, a = {}, ctx = {}) {
    const t = this._need(id);
    if (!['file', 'diff', 'report', 'link', 'job', 'note'].includes(a.kind)) fail('bad_request', 'kind must be file, diff, report, link, job or note');
    const artifact = { id: text(a.id || '', 80) || randomId('ar_', 10), kind: a.kind };
    if (a.path) artifact.path = text(a.path, 1000);
    if (a.ref) artifact.ref = text(a.ref, 400);
    if (a.label) artifact.label = text(a.label, 300);
    if (Number.isInteger(a.bytes) && a.bytes >= 0) artifact.bytes = a.bytes;
    this._emit('tasks.artifact', { taskId: t.id, artifact });
    return this.get(t.id);
  }

  // ---------------------------------------------------------------- authority
  /** A peer changes only the tasks it created (PLAN.md section 2: peers own only tasks they created). */
  _own(t, ctx = {}) {
    const o = ctx.origin;
    if (!o || o.kind !== 'peer') return t;
    const mine = t.createdBy?.kind === 'peer' && (t.createdBy.peerId === o.peerId || t.createdBy.id === o.peerId);
    const guestMine = t.owner === `guest:${o.peerId}`;
    if (!mine && !guestMine) fail('forbidden', 'a peer can change only the tasks it created');
    return t;
  }

  /** retry, reassign and cancel of a crew or city task go to the module that runs it. */
  async _delegateAsync(t, op, args, ctx) {
    const src = t.src;
    if (src.driver === 'crew') {
      if (!this.hive) fail('conflict', 'the crew is not running');
      const crewId = t.legacy.crewTaskId;
      if (op === 'retry') return this.hive.retryTask(crewId);
      if (op === 'cancel') return this.hive.cancelTask(crewId);
      if (op === 'reassign') return this.hive.reassignTask(crewId, args.agentId);
    }
    if (src.driver === 'city') {
      if (!this.dispatch) fail('conflict', 'the city is not running');
      const taskId = t.legacy.cityTaskId;
      const origin = ctx.origin || { kind: 'user' };
      if (op === 'retry') return this.dispatch('city.task.retry', { taskId }, origin);
      if (op === 'cancel') return this.dispatch('city.task.cancel', { taskId }, origin);
      if (op === 'reassign') return this.dispatch('city.task.assign', { taskId, agentId: args.agentId }, origin);
    }
    fail('conflict', `cannot ${op} ${t.id}`);
  }

  _delegate(t, op, args, ctx) {
    const p = this._delegateAsync(t, op, args, ctx);
    return p.then(() => this.get(t.id));
  }

  // ---------------------------------------------------------------- dependencies and deadlines
  /** Moves a native task that is not running yet according to its dependencies. */
  _reconcile(id) {
    const t = this.get(id);
    if (!t || t.src || !['queued', 'assigned', 'waiting'].includes(t.state)) return;
    if (t.state === 'waiting' && t.waitingFor?.kind !== 'dependency') return;
    const deps = t.dependsOn.map((d) => this.get(d)).filter(Boolean);
    const broken = deps.find((d) => d.state === 'failed' || d.state === 'cancelled');
    if (broken) {
      this._move(t, 'failed', { failure: { code: 'dependency_failed', message: `${broken.id} is ${broken.state}` }, reason: `${broken.id} is ${broken.state}` });
      return;
    }
    const unmet = deps.filter((d) => d.state !== 'completed').map((d) => d.id);
    if (unmet.length) {
      const ref = unmet.join(',');
      if (t.state !== 'waiting' || t.waitingFor.ref !== ref) {
        this._move(t, 'waiting', { waitingFor: { kind: 'dependency', ref }, resumeTo: t.state === 'waiting' ? t.resumeTo : t.state, reason: `waits for ${ref}` });
      }
      return;
    }
    if (t.state === 'waiting') this._move(t, t.assignee ? 'assigned' : 'queued', { reason: 'dependencies completed' });
  }

  _onEvent(e) {
    if (this._closed) return;
    if (this._busy) { this._dirty = true; return; }
    if (!e.type.startsWith('tasks.') && !e.type.startsWith('task.') && !e.type.startsWith('city.task.') && e.type !== 'job.planned') return;
    this._busy = true;
    try {
      do {
        this._dirty = false;
        for (const t of Object.values(this.board.tasks)) {
          if (!t.src && t.dependsOn.length && ['queued', 'assigned', 'waiting'].includes(t.state)) {
            try { this._reconcile(t.id); } catch { /* a stale state is fixed on the next event */ }
          }
        }
      } while (this._dirty);
    } finally {
      this._busy = false;
    }
  }

  _timersFor(t) {
    if (!t) return;
    const old = this.timers.get(t.id);
    if (old) { clearTimeout(old); this.timers.delete(t.id); }
    if (t.src || t.state !== 'waiting' || !t.waitingFor?.deadline) return;
    if (t.waitingFor.kind !== 'peer' && t.waitingFor.kind !== 'resource') return;
    const ms = msUntil(t.waitingFor.deadline, this.now);
    const deadline = t.waitingFor.deadline;
    const timer = setTimeout(() => {
      this.timers.delete(t.id);
      const now = this.get(t.id);
      if (!now || now.state !== 'waiting' || now.waitingFor?.deadline !== deadline) return;
      try {
        this.failTask(now.id, { code: now.waitingFor.kind === 'peer' ? 'peer_lost' : 'timeout', message: `no ${now.waitingFor.kind} before the deadline` }, { reason: 'deadline passed' });
      } catch { /* moved meanwhile */ }
    }, Math.min(ms, 2 ** 31 - 1));
    timer.unref?.();
    this.timers.set(t.id, timer);
  }

  /**
   * After a start (Restore City): native tasks that were running when hivedesk stopped wait for the user
   * (Retry or Cancel) instead of pretending to run; deadlines are armed again.
   * @returns {string[]} the interrupted task ids
   */
  restore() {
    const interrupted = [];
    for (const t of Object.values(this.board.tasks)) {
      if (t.src) continue;
      if (ACTIVE.has(t.state)) {
        // Nothing runs it any more: going on means starting over from assigned (or queued without an assignee).
        this._move(t, 'waiting', { waitingFor: { kind: 'user', ref: 'restart' }, resumeTo: t.assignee ? 'assigned' : 'queued', reason: `hivedesk stopped while this task was ${t.state}` });
        interrupted.push(t.id);
      } else if (t.state === 'waiting') {
        this._timersFor(t);
      }
    }
    for (const t of Object.values(this.board.tasks)) if (!t.src && t.dependsOn.length) this._reconcile(t.id);
    return interrupted;
  }

  close() {
    this._closed = true;
    this._off?.();
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}

function clampInt(v, min, max, dflt) {
  const n = Number(v);
  return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : dflt;
}
