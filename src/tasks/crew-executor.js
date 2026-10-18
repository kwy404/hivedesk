// Runs native tasks with the crew (PLAN.md section 1.1: crew tasks become views of the one task engine).
// A native task created with run: "crew" and assigned to a crew worker becomes a one task crew job
// (the same path a Hive City hop uses). The job's progress moves the task:
//   job started            working
//   an approval is waiting waiting (approval), then back
//   files written          artifacts
//   crew chat of the job   task logs
//   job done               completed
//   job failed             failed (error)
//   job cancelled          cancelled, or assigned again after a reassign

/**
 * @param {{ bus: import('../core/bus.js').EventBus, hive: import('../crew/engine.js').Hive, tasks: import('./engine.js').TaskEngine }} opts
 * @returns {{ close: () => void, running: Map<string, string> }}
 */
export function attachCrewExecutor({ bus, hive, tasks }) {
  /** task id -> crew job id */
  const running = new Map();
  /** crew job id -> task id */
  const byJob = new Map();
  /** jobs we cancelled ourselves, with what to do next */
  const stopping = new Map();
  let closed = false;

  const runnable = (t) => !!t && !t.src && t.legacy?.run === 'crew' && t.state === 'assigned' && !running.has(t.id)
    && !!t.assignee && t.assignee !== 'mel' && hive.crewById().has(t.assignee);

  function detail(t) {
    const parts = [t.detail || t.title];
    if (t.criteria.length) parts.push(`Done when:\n${t.criteria.map((c) => `- ${c}`).join('\n')}`);
    if (t.loops) parts.push(`This is loop ${t.loops}. Read the task log and fix what was found.`);
    return parts.join('\n\n').slice(0, 8000);
  }

  function start(t) {
    if (closed || !runnable(t)) return;
    let jobId;
    try {
      ({ jobId } = hive.createJob({ request: t.title, plan: [{ title: t.title, detail: detail(t), assignee: t.assignee, kind: 'build' }], taskRef: t.id }));
    } catch (err) {
      tasks.log(t.id, `the crew could not start it: ${err.message}`, 'error');
      return;
    }
    running.set(t.id, jobId);
    byJob.set(jobId, t.id);
    bus.emit('tasks.updated', { task: { id: t.id, legacy: { crewJobId: jobId } } });
    try { tasks.start(t.id, { reason: `crew job ${jobId} with ${t.assignee}` }); } catch { /* changed meanwhile */ }
  }

  function stop(taskId, then) {
    const jobId = running.get(taskId);
    if (!jobId) return;
    stopping.set(jobId, then);
    try { hive.cancelJob(jobId); } catch { /* already over */ }
  }

  function finished(jobId) {
    const taskId = byJob.get(jobId);
    byJob.delete(jobId);
    if (taskId && running.get(taskId) === jobId) running.delete(taskId);
    return taskId;
  }

  const safe = (fn) => { try { fn(); } catch { /* the task moved on its own */ } };

  const off = bus.on((e) => {
    if (closed) return;
    const d = e.data || {};
    switch (e.type) {
      case 'tasks.transition': {
        const t = tasks.get(d.taskId);
        if (!t || t.src || t.legacy?.run !== 'crew') break;
        if (running.has(t.id)) {
          if (d.to === 'cancelled' || d.to === 'failed' || d.to === 'queued') stop(t.id, 'none');
          else if (d.to === 'assigned' && d.from !== 'waiting') stop(t.id, 'restart');
        } else if (d.to === 'assigned') {
          queueMicrotask(() => start(tasks.get(t.id)));
        }
        break;
      }
      case 'worker.status': {
        const taskId = byJob.get(e.jobId);
        const t = taskId && tasks.get(taskId);
        if (!t || !d.taskId) break;
        if (d.status === 'waiting_approval' && t.state === 'working') safe(() => tasks.wait(t.id, { kind: 'approval', ref: d.workerId }, { reason: `${d.workerId} waits for an approval` }));
        else if ((d.status === 'thinking' || d.status === 'tool') && t.state === 'waiting' && t.waitingFor?.kind === 'approval') safe(() => tasks.resume(t.id, { reason: 'approval answered' }));
        break;
      }
      case 'chat.message': {
        const taskId = byJob.get(e.jobId);
        if (taskId && d.from && d.from !== 'system' && d.text) safe(() => tasks.log(taskId, `${d.from}: ${String(d.text).slice(0, 1000)}`));
        break;
      }
      case 'file.changed': {
        const taskId = byJob.get(e.jobId);
        if (taskId && d.path) safe(() => tasks.artifact(taskId, { id: `file:${String(d.path).slice(0, 70)}`, kind: 'file', path: d.path, label: d.op === 'delete' ? 'deleted' : d.op || 'written', ...(Number.isInteger(d.bytes) ? { bytes: d.bytes } : {}) }));
        break;
      }
      case 'job.done':
      case 'job.failed':
      case 'job.cancelled': {
        if (!byJob.has(e.jobId)) break;
        const then = stopping.get(e.jobId);
        stopping.delete(e.jobId);
        const taskId = finished(e.jobId);
        const t = taskId && tasks.get(taskId);
        if (!t) break;
        if (e.type === 'job.done' && !then) {
          safe(() => { if (t.state === 'waiting') tasks.resume(t.id, { reason: 'the job ended' }); });
          safe(() => tasks.complete(t.id, { reason: d.summary || 'the crew job is done' }));
        } else if (e.type === 'job.failed' && !then) {
          safe(() => tasks.failTask(t.id, { code: 'error', message: d.error || 'the crew job failed' }));
        } else if (e.type === 'job.cancelled' && !then) {
          safe(() => tasks.cancel(t.id, { reason: 'the crew job was cancelled' }));
        }
        if (then === 'restart') queueMicrotask(() => start(tasks.get(taskId)));
        break;
      }
      default:
        break;
    }
  });

  // Tasks that were assigned before the crew was ready.
  for (const t of tasks.list({ state: 'assigned', native: true })) queueMicrotask(() => start(tasks.get(t.id)));

  return {
    running,
    close() {
      closed = true;
      off();
    }
  };
}
