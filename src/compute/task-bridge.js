// The task side of the failure matrix (PLAN section 8, last line): a compute job of a 1.0 task never
// leaves the task in working. The crew runs a native task as a crew job (src/tasks/crew-executor.js,
// legacy.crewJobId); the crew scheduler hands that job id to the requester brain (options.turn), and
// job.created carries it as crewJobId. This bridge follows job.state:
//   queued with a resource wait   -> task waiting { kind: 'resource' } with the reasons and the deadline
//   failed, partial, revoked,     -> waiting { kind: 'peer' } until the person chooses (the job's deadline)
//   expired, with choices
//   the same without choices      -> tasks.jobFailed: waiting { kind: 'peer' } while attempts last, else failed
//   leased, running, completed    -> the task goes on (tasks.resume) when it was waiting for this job
// The task engine owns the rules; this only translates.

const CHOICE_STATES = new Set(['failed', 'partial', 'revoked', 'expired']);
const GOING_ON = new Set(['offered', 'leased', 'running', 'completed']);

/** @param {{ bus: any, tasks: any }} ctx  Returns { close() }. */
export function attachTaskBridge({ bus, tasks }) {
  const crewJobOf = new Map(); // compute job id -> crew job id
  const safe = (fn) => { try { fn(); } catch { /* the task moved on its own */ } };
  const taskOf = (jobId) => {
    const crewJobId = crewJobOf.get(jobId);
    if (!crewJobId) return null;
    return tasks.list({ native: true }).find((t) => t.legacy?.crewJobId === crewJobId) || null;
  };

  const off = bus.on((e) => {
    const d = e.data || {};
    if (e.type === 'job.created') {
      if (typeof d.jobId === 'string' && typeof d.crewJobId === 'string') {
        crewJobOf.set(d.jobId, d.crewJobId);
        while (crewJobOf.size > 500) crewJobOf.delete(crewJobOf.keys().next().value);
      }
      return;
    }
    if (e.type !== 'job.state' || typeof d.jobId !== 'string') return;
    const t = taskOf(d.jobId);
    if (!t) return;
    if (d.state === 'queued' && d.waiting?.kind === 'resource') {
      if (t.state === 'waiting' && t.waitingFor?.kind === 'resource') return;
      const deadlineMs = d.waiting.deadline ? Math.max(1000, Date.parse(d.waiting.deadline) - Date.now()) : undefined;
      safe(() => tasks.wait(t.id, { kind: 'resource', ref: String(d.waiting.reason || 'no machine can run it now'), ...(deadlineMs ? { deadlineMs } : {}) }, { reason: 'no machine can run its job now' }));
      return;
    }
    if (d.state === 'partial' && d.usedPartial) {
      if (t.state === 'waiting' && t.waitingFor?.kind === 'peer') safe(() => tasks.resume(t.id, { reason: `goes on with the partial answer of job ${d.jobId}` }));
      return;
    }
    if (CHOICE_STATES.has(d.state)) {
      const code = d.error?.code || 'crashed';
      if (Array.isArray(d.choices) && d.choices.length) {
        // A person chooses (Retry locally, Retry another peer, Use partial, Cancel): the task waits with the job's deadline.
        safe(() => tasks.wait(t.id, { kind: 'peer', ref: d.jobId, ...(d.choiceDeadline ? { deadline: d.choiceDeadline } : {}) }, { reason: `job ${d.jobId} failed: ${code}` }));
      } else if (d.state !== 'partial') {
        // No choice was made in time: the failure stands and the task engine applies its retry policy.
        safe(() => tasks.jobFailed(t.id, { jobId: d.jobId, code, message: d.error?.message }));
      }
      return;
    }
    if (GOING_ON.has(d.state) && t.state === 'waiting' && (t.waitingFor?.kind === 'resource' || t.waitingFor?.kind === 'peer')) {
      safe(() => tasks.resume(t.id, { reason: `job ${d.jobId} goes on` }));
    }
    if (d.state === 'completed' || d.state === 'cancelled') crewJobOf.delete(d.jobId);
  });
  return { close: () => off?.() };
}
