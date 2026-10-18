// What a phone sees of this engine, by grant (docs/1.0/protocol/phone.md section 6). Pure functions
// over the engine state, so the tests check exactly what leaves the desktop. Never sent: file contents,
// settings, provider keys, prompts, memory, paths outside the workspace, peers or the audit log.

import { briefText } from '../crew/brief.js';

const MAX_JOBS = 20;
const MAX_TASKS = 80;
const MAX_CHAT = 60;
const MAX_DIFF = 48 * 1024;
const s = (v, n) => (typeof v === 'string' ? v.slice(0, n) : v == null ? undefined : String(v).slice(0, n));

const worker = (w, st) => ({
  id: s(w.id, 40), name: s(w.name, 40), role: s(w.role, 60), color: s(w.color, 16), avatar: s(w.avatar, 4),
  status: s(st?.status || 'idle', 30), detail: s(st?.detail, 160), taskId: s(st?.taskId, 40), paused: w.paused === true
});

function briefOf(j) {
  if (!j.briefProposed) return undefined;
  let text = '';
  try { text = j.briefProposed.text || briefText(j.briefProposed); } catch { text = ''; }
  return { text: s(text, 6000), goal: s(j.briefProposed.goal, 400) };
}

const job = (j) => ({
  id: s(j.id, 40), request: s(j.request, 600), status: s(j.status, 30), createdAt: s(j.createdAt, 40), finishedAt: s(j.finishedAt, 40),
  summary: s(j.summary, 600), error: s(j.error, 300), taskIds: (j.taskIds || []).slice(0, 40).map((x) => s(x, 40)),
  brief: j.status === 'awaiting_brief' ? briefOf(j) : undefined
});

const task = (t) => ({ id: s(t.id, 40), title: s(t.title, 200), status: s(t.status, 30), workerId: s(t.workerId || t.assignee, 40), jobId: s(t.jobId, 40), note: s(t.note, 200) });

/** The City in numbers: machines and agents by status, the 1.0 board by state. */
function cityOf(state) {
  const city = state.city || {};
  const machines = Object.values(city.machines || {});
  const agents = Object.values(city.agents || {}).filter((a) => !a.retired);
  const byStatus = {};
  for (const a of agents) byStatus[a.status || 'idle'] = (byStatus[a.status || 'idle'] || 0) + 1;
  const board = {};
  for (const t of Object.values(state.board?.tasks || {})) board[t.state] = (board[t.state] || 0) + 1;
  return {
    machines: machines.length,
    online: machines.filter((m) => m.online !== false && m.status !== 'offline').length,
    agents: agents.length,
    agentsByStatus: byStatus,
    board
  };
}

/** The full approval card: who asks, what, where it comes from, and the diff summary. */
export function approvalCard(a, state = {}) {
  const w = (state.crew || []).find((x) => x.id === a.workerId);
  const j = (state.jobs || []).find((x) => x.id === a.jobId);
  const diff = typeof a.diff === 'string' ? a.diff : '';
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++;
    else if (line.startsWith('-') && !line.startsWith('---')) removed++;
  }
  const args = a.args && typeof a.args === 'object' ? a.args : {};
  return {
    id: s(a.id, 60), jobId: s(a.jobId, 40), taskId: s(a.taskId, 40), tool: s(a.tool, 40), summary: s(a.summary, 400), createdAt: s(a.createdAt, 40),
    origin: { worker: w ? s(w.name, 40) : s(a.workerId, 40), workerId: s(a.workerId, 40), job: j ? s(j.request, 200) : undefined, remote: a.remoteOrigin ? s(a.remoteOrigin, 80) : undefined },
    command: typeof args.command === 'string' ? s(args.command, 2000) : typeof args.script === 'string' ? s(args.script, 2000) : undefined,
    path: typeof args.path === 'string' ? s(args.path, 300) : undefined,
    diff: diff ? { added, removed, text: diff.slice(0, MAX_DIFF), cut: diff.length > MAX_DIFF } : undefined
  };
}

/**
 * The status snapshot for a phone. grants: the grant map of that phone.
 * Approvals: a count with phone.status only; the full cards need phone.approve.
 */
export function statusView(state, grants = {}) {
  const jobs = (state.jobs || []).slice(-MAX_JOBS);
  const taskIds = new Set(jobs.flatMap((j) => j.taskIds || []));
  const tasks = Object.values(state.tasks || {}).filter((t) => taskIds.has(t.id)).slice(-MAX_TASKS).map(task);
  const out = {
    v: 1,
    at: new Date().toISOString(),
    demo: !!state.demo,
    brain: { state: s(state.brain?.state, 30), model: s(state.brain?.model, 80) },
    crew: (state.crew || []).slice(0, 24).map((w) => worker(w, state.workers?.[w.id])),
    jobs: jobs.map(job).reverse(),
    tasks,
    queue: { running: (state.queue?.running || []).length, waiting: (state.queue?.waiting || []).length },
    city: cityOf(state),
    approvals: { count: (state.approvals || []).length }
  };
  if (grants['phone.approve']) out.approvals.cards = (state.approvals || []).slice(0, 12).map((a) => approvalCard(a, state));
  if (grants['phone.crew']) out.chat = chatView(state, 'general');
  return out;
}

/** One chat channel: "general" or "dm:<workerId>". */
export function chatView(state, channel = 'general') {
  const ch = typeof channel === 'string' && (channel === 'general' || /^dm:[\w-]{1,40}$/.test(channel)) ? channel : 'general';
  return { channel: ch, lines: (state.chat?.[ch] || []).slice(-MAX_CHAT).map((m) => ({ id: s(m.id, 40), from: s(m.from, 40), text: s(m.text, 2000), ts: s(m.ts, 40), taskId: s(m.taskId, 40) })) };
}

/** An event as one line of the activity feed, or null when it is not for the feed. */
export function feedItem(e) {
  const d = e?.data || {};
  const base = { seq: e.seq, ts: s(e.ts, 40), jobId: s(e.jobId, 40) };
  switch (e?.type) {
    case 'job.created': return { ...base, k: 'job.created', text: s(d.job?.request, 200) };
    case 'brief.proposed': return { ...base, k: 'brief.proposed' };
    case 'job.planned': return { ...base, k: 'job.planned', n: (d.tasks || []).length };
    case 'job.done': return { ...base, k: 'job.done', text: s(d.summary, 200) };
    case 'job.failed': return { ...base, k: 'job.failed', text: s(d.error, 200) };
    case 'job.cancelled': return { ...base, k: 'job.cancelled' };
    case 'task.status': return ['running', 'done', 'failed'].includes(d.status) ? { ...base, k: `task.${d.status}`, taskId: s(d.taskId, 40) } : null;
    case 'approval.requested': return { ...base, k: 'approval.requested', text: s(d.approval?.summary, 200), workerId: s(d.approval?.workerId, 40) };
    case 'approval.resolved': return { ...base, k: d.approved ? 'approval.approved' : 'approval.rejected' };
    case 'file.changed': return { ...base, k: 'file.changed', path: s(d.path, 200), op: s(d.op, 10) };
    case 'chat.message': return d.channel && d.channel !== 'general' ? null : { ...base, k: 'chat', from: s(d.from, 40), text: s(d.text, 200) };
    case 'crew.updated': return typeof d.worker?.paused === 'boolean' ? { ...base, k: d.worker.paused ? 'worker.paused' : 'worker.resumed', workerId: s(d.worker.id, 40) } : null;
    default: return null;
  }
}

/** Notices for phones that hold phone.notify. */
export function noticeOf(e, state = {}) {
  const d = e?.data || {};
  const j = (state.jobs || []).find((x) => x.id === e?.jobId);
  if (e?.type === 'job.done') return { kind: 'job.done', jobId: s(e.jobId, 40), text: s(j?.request, 120) };
  if (e?.type === 'job.failed') return { kind: 'job.failed', jobId: s(e.jobId, 40), text: s(j?.request, 120) };
  if (e?.type === 'approval.requested') return { kind: 'approval', jobId: s(e.jobId, 40), approvalId: s(d.approval?.id, 60), text: s(d.approval?.summary, 160) };
  if (e?.type === 'brief.proposed') return { kind: 'brief', jobId: s(e.jobId, 40), text: s(j?.request, 120) };
  return null;
}

/** Events after which the snapshot changes. */
export const SNAPSHOT_EVENTS = new Set([
  'job.created', 'job.planning', 'job.planned', 'job.refining', 'brief.proposed', 'brief.approved', 'job.done', 'job.failed', 'job.cancelled', 'job.resumed',
  'task.added', 'task.updated', 'task.status', 'worker.status', 'crew.hired', 'crew.updated', 'crew.fired', 'queue.updated', 'approval.requested',
  'approval.resolved', 'chat.message', 'brain.status'
]);
