// The Activity stream (PLAN section 10): one line per meaningful event, newest first in the UI.
// Pure module, no DOM: every task transition, job decision, grant, revoke, peer join and leave,
// approval, file change and git action, with filters and the CSV, JSON and Markdown export of
// src/changelog/activity.js (same columns, same spreadsheet safety).
// Lines carry an i18n key and its parameters (`key`, `p`), so the UI renders them in any language
// and the export can use the English text it is given.

export const KINDS = ['task', 'job', 'peer', 'grant', 'approval', 'file', 'git', 'agent', 'city'];

const short = (s, n = 160) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}...` : t; };

/**
 * One activity entry for an event, or null.
 * @param {any} e an engine event
 * @param {{ agentName?: (id) => string, taskTitle?: (id) => string, machineName?: (id) => string, peerName?: (id) => string, roomName?: (id) => string, workerName?: (id) => string, city?: any }} ctx
 */
export function entryOf(e, ctx = {}) {
  const d = e?.data || {};
  const an = ctx.agentName || ((id) => id || '');
  const tt = ctx.taskTitle || ((id) => id || '');
  const mn = ctx.machineName || ((id) => id || '');
  const pn = ctx.peerName || ((id) => (id ? String(id).slice(0, 12) : ''));
  const rn = ctx.roomName || ((id) => id || '');
  const wn = ctx.workerName || an;
  const base = { seq: e.seq, ts: e.ts, type: e.type, demo: !!e.demo };
  const mk = (kind, key, p = {}, extra = {}) => ({ ...base, kind, key: `city.act.${key}`, p, ...extra });
  switch (e?.type) {
    // tasks: every transition
    case 'city.task.created': return mk('task', 'created', { title: short(d.task?.title) }, { taskId: d.task?.id, who: d.task?.createdBy?.kind === 'guest' ? { kind: 'peer', name: d.task.createdBy.name } : null });
    case 'city.task.claimed': return mk('task', 'claimed', { agent: an(d.agentId), title: short(tt(d.taskId)), room: rn(d.room) }, { taskId: d.taskId, agentId: d.agentId });
    case 'city.task.hop': {
      const h = d.hop || {};
      if (!h.from || h.from === h.to) return null;
      const back = (d.task?.loops || 0) > 0 && /changes requested|QA asked/i.test(h.reason || '');
      return mk('task', back ? 'loop' : 'hop', { title: short(tt(h.taskId)), from: rn(h.from), to: rn(h.to), n: d.task?.loops || 0 }, { taskId: h.taskId, loop: back });
    }
    case 'city.task.verdict': return mk('task', d.passed ? 'passed' : 'failed', { title: short(tt(d.taskId)), room: rn(d.room), agent: d.agentId ? an(d.agentId) : '', issue: short(d.issues?.[0] || '', 120) }, { taskId: d.taskId, tone: d.passed ? 'ok' : 'bad' });
    case 'city.task.awaiting': return d.room ? mk('approval', 'awaiting', { title: short(tt(d.taskId)), room: rn(d.room) }, { taskId: d.taskId, tone: 'warn' }) : null;
    case 'city.task.done': return mk('task', 'done', { title: short(tt(d.taskId)) }, { taskId: d.taskId, tone: 'ok' });
    case 'city.task.blocked': return mk('task', 'blocked', { title: short(tt(d.taskId)), reason: short(d.reason, 120) }, { taskId: d.taskId, tone: 'bad' });
    case 'city.task.cancelled': return mk('task', 'cancelled', { title: short(tt(d.taskId)) }, { taskId: d.taskId });
    case 'task.handoff': return mk('task', 'handoff', { from: wn(d.from), to: wn(d.to), title: short(d.title || tt(d.taskId)) }, { taskId: d.taskId });
    // jobs: the scheduler decision and the end
    case 'job.scheduled': {
      const job = d.job || d;
      return mk('job', 'scheduled', { reason: short(d.decision?.reason || job.decision?.reason || '', 220) }, { jobId: job.id || d.jobId, agentId: job.agentId });
    }
    case 'job.completed': case 'job.result': return mk('job', 'completed', { id: d.jobId || d.job?.id }, { jobId: d.jobId || d.job?.id, tone: 'ok' });
    case 'job.failed': case 'job.error': return mk('job', 'jobFailed', { code: d.error?.code || d.code || 'failed', message: short(d.error?.message || d.message || '', 160) }, { jobId: d.jobId || d.job?.id, tone: 'bad' });
    case 'job.partial': return mk('job', 'partial', { code: d.error?.code || d.code || 'partial' }, { jobId: d.jobId || d.job?.id, tone: 'warn' });
    case 'job.revoked': return mk('job', 'revoked', { reason: short(d.reason || '', 120) }, { jobId: d.jobId || d.job?.id, tone: 'bad' });
    case 'job.cancelled': if (d.jobId || d.job?.id) return mk('job', 'jobCancelled', {}, { jobId: d.jobId || d.job?.id }); return null;
    // the final record of src/compute/requester.js (job.ended, role requester)
    case 'job.ended': {
      if (d.role && d.role !== 'requester') return null;
      if (d.state === 'completed') return mk('job', 'completed', { id: d.jobId }, { jobId: d.jobId, tone: 'ok' });
      if (d.state === 'cancelled') return mk('job', 'jobCancelled', {}, { jobId: d.jobId });
      if (d.state === 'revoked') return mk('job', 'revoked', { reason: short(d.reason || '', 120) }, { jobId: d.jobId, tone: 'bad' });
      if (d.state === 'partial') return mk('job', 'partial', { code: d.error || 'partial' }, { jobId: d.jobId, tone: 'warn' });
      return mk('job', 'jobFailed', { code: d.error || d.state || 'failed', message: '' }, { jobId: d.jobId, tone: 'bad' });
    }
    // peers and grants
    case 'city.member.joined': return mk('peer', 'memberJoined', { name: pn(d.member?.peerId) || mn(d.member?.machineId) }, { peerId: d.member?.peerId, tone: 'honey' });
    case 'city.member.left': return mk('peer', 'memberLeft', { name: pn(d.peerId), reason: d.reason || 'left' }, { peerId: d.peerId });
    case 'city.machine.joined': return d.machine?.host ? null : mk('peer', 'machineJoined', { name: d.machine?.name || '' }, { machineId: d.machine?.id, tone: 'honey' });
    case 'city.machine.left': return mk('peer', 'machineLeft', { name: mn(d.machineId), reason: d.reason || 'left' }, { machineId: d.machineId });
    case 'city.visit.started': return mk('peer', 'visitStarted', { name: d.name || pn(d.hostPeerId) }, { peerId: d.hostPeerId });
    case 'city.visit.ended': return mk('peer', 'visitEnded', { name: pn(d.hostPeerId), reason: d.reason || 'left' }, { peerId: d.hostPeerId });
    case 'session.opened': case 'session.open': return mk('peer', 'online', { name: pn(d.peerId) }, { peerId: d.peerId });
    case 'session.closed': return mk('peer', 'offline', { name: pn(d.peerId), reason: d.reason || '' }, { peerId: d.peerId });
    case 'cap.granted': case 'grant.created': { const g = d.grant || d; return mk('grant', 'granted', { cap: g.capability?.name || g.capability || '', name: pn(g.peerId) }, { peerId: g.peerId, tone: 'info' }); }
    case 'cap.revoked': case 'grant.revoked': return mk('grant', 'revokedGrant', { name: pn(d.peerId), reason: short(d.reason || '', 120) }, { peerId: d.peerId, tone: 'bad' });
    // the logged events of src/p2p/engine.js
    case 'p2p.peer': return d.online ? mk('peer', 'online', { name: pn(d.peerId) }, { peerId: d.peerId }) : mk('peer', 'offline', { name: pn(d.peerId), reason: short(d.reason || '', 80) }, { peerId: d.peerId });
    case 'p2p.grant': return mk('grant', 'granted', { cap: d.capability || '', name: pn(d.peerId) }, { peerId: d.peerId, tone: 'info' });
    case 'p2p.revoke': return mk('grant', 'revokedGrant', { name: pn(d.peerId), reason: short(d.reason || '', 120) }, { peerId: d.peerId, tone: 'bad' });
    case 'city.borrow.answered': return d.accepted ? mk('grant', 'borrowStart', { agent: an(ctx.city?.borrows?.[d.borrowId]?.agentId), machine: mn(ctx.city?.borrows?.[d.borrowId]?.to) }, { tone: 'info' }) : null;
    case 'city.borrow.ended': return mk('grant', 'borrowEnd', { agent: an(ctx.city?.borrows?.[d.borrowId]?.agentId), reason: d.reason || '' });
    // approvals
    case 'approval.requested': return mk('approval', 'asked', { what: short(d.approval?.summary || d.approval?.tool || '', 160), agent: wn(d.approval?.workerId) }, { tone: 'warn' });
    case 'approval.resolved': return mk('approval', d.approved ? 'approved' : 'rejected', { note: short(d.note || '', 120) }, { who: d.by === 'user' ? { kind: 'human' } : null, tone: d.approved ? 'ok' : 'bad' });
    // files and git
    case 'file.changed': return mk('file', d.op === 'create' ? 'fileCreated' : d.op === 'delete' ? 'fileDeleted' : 'fileEdited', { path: short(d.path, 200), agent: wn(d.workerId) }, { path: d.path, taskId: d.taskId || null, added: d.added || 0, removed: d.removed || 0 });
    case 'github.committed': return mk('git', 'committed', { sha: String(d.sha || '').slice(0, 7), subject: short(d.subject, 120) });
    case 'github.pushed': return mk('git', 'pushed', { branch: d.branch || '', remote: d.remote || '' });
    case 'github.branch': return mk('git', 'branch', { branch: d.branch || '' });
    case 'github.pr.opened': return mk('git', 'pr', { n: d.number || 0, title: short(d.title, 120) });
    case 'github.cloned': return mk('git', 'cloned', { repo: d.repo || '' });
    // agents and the city
    case 'city.agent.joined': return mk('agent', 'agentJoined', { name: d.agent?.name || '' }, { agentId: d.agent?.id });
    case 'city.agent.leveled': return (d.level || 1) >= 2 ? mk('agent', 'leveled', { agent: an(d.agentId), n: d.level }, { agentId: d.agentId, tone: 'honey' }) : null;
    case 'city.agent.retired': return mk('agent', 'retired', { agent: an(d.agentId) }, { agentId: d.agentId });
    case 'city.named': return mk('city', 'named', { name: d.name || '' });
    case 'city.pipeline.updated': return mk('city', 'pipeline', { rooms: (d.pipeline || []).map(rn).join(', ') });
    default: return null;
  }
}

/** Entries for a list of events, oldest first. */
export function activityFrom(events, ctx = {}) {
  const out = [];
  for (const e of events || []) { const x = entryOf(e, ctx); if (x) out.push(x); }
  return out;
}

/** @param {{ kind?: string, q?: string, taskId?: string, peerId?: string, since?: string }} f  text: (entry) => string */
export function filterActivity(entries, f = {}, text = (e) => e.key) {
  const q = String(f.q || '').trim().toLowerCase();
  const since = f.since ? Date.parse(f.since) : NaN;
  return entries.filter((e) => {
    if (f.kind && e.kind !== f.kind) return false;
    if (f.taskId && e.taskId !== f.taskId) return false;
    if (f.peerId && e.peerId !== f.peerId) return false;
    if (!Number.isNaN(since) && Date.parse(e.ts) < since) return false;
    if (q && !String(text(e)).toLowerCase().includes(q)) return false;
    return true;
  });
}

const csvCell = (v) => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // no formulas when opened in a spreadsheet
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** The export of src/changelog/activity.js: json, csv or md. `text` renders an entry's line. */
export function exportActivity(entries, format = 'json', text = (e) => e.key) {
  if (format === 'csv') {
    const rows = [['time', 'kind', 'event', 'detail', 'task', 'job', 'peer', 'path', 'seq']];
    for (const e of entries) rows.push([e.ts, e.kind, e.type, text(e), e.taskId || '', e.jobId || '', e.peerId || '', e.path || '', e.seq]);
    return { type: 'text/csv; charset=utf-8', ext: 'csv', body: rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n' };
  }
  if (format === 'md') {
    const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
    const lines = ['# Activity', '', '| Time | Kind | What |', '| --- | --- | --- |'];
    for (const e of entries) lines.push(`| ${e.ts} | ${esc(e.kind)} | ${esc(text(e))} |`);
    return { type: 'text/markdown; charset=utf-8', ext: 'md', body: lines.join('\n') + '\n' };
  }
  return { type: 'application/json; charset=utf-8', ext: 'json', body: JSON.stringify({ exportedAt: new Date().toISOString(), entries: entries.map((e) => ({ ...e, text: text(e) })) }, null, 2) };
}
