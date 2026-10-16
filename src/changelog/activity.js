// The activity log: who did what and when, across workers and humans, read from the event log.
// Guests of a shared session are named: an event may carry `guest: { name }`, `by: { kind: "guest", name }`
// or a worker id / chat sender of the form "guest:<name>".

const KINDS = ['file', 'chat', 'job', 'task', 'approval', 'git', 'changelog', 'crew', 'run'];
export { KINDS };

/** Who an event belongs to: { id, name, kind: "worker" | "human" | "guest" | "system" }. */
export function actorOf(e, names) {
  const d = e.data || {};
  const guest = d.guest?.name || (d.by && typeof d.by === 'object' && d.by.kind === 'guest' ? d.by.name : null);
  if (guest) return { id: `guest:${guest}`, name: String(guest).slice(0, 60), kind: 'guest' };
  const raw = d.workerId || (e.type === 'chat.message' ? d.from : null) || (typeof d.by === 'string' ? d.by : null) || d.actor;
  if (typeof raw === 'string') {
    if (raw.startsWith('guest:')) return { id: raw, name: raw.slice(6).slice(0, 60) || 'Guest', kind: 'guest' };
    if (raw === 'user') return { id: 'user', name: 'You', kind: 'human' };
    if (raw === 'auto' || raw === 'system') return { id: 'system', name: 'hivedesk', kind: 'system' };
    if (raw.startsWith('lend:')) return { id: raw, name: 'Friend', kind: 'human' };
    return { id: raw, name: names.get(raw) || raw, kind: 'worker' };
  }
  return null;
}

const short = (s, n = 160) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}...` : t; };

/** One activity entry per meaningful event, newest last. */
export function activityFrom(events, state = {}) {
  const names = new Map((state.crew || []).map((w) => [w.id, w.name]));
  for (const e of events) if ((e.type === 'crew.hired' || e.type === 'crew.updated') && e.data?.worker) names.set(e.data.worker.id, e.data.worker.name);
  const calls = new Map();
  const out = [];
  for (const e of events) {
    const d = e.data || {};
    if (e.type === 'tool.called') calls.set(d.callId, d.workerId);
    const base = { seq: e.seq, ts: e.ts, jobId: e.jobId || null };
    const push = (kind, action, text, extra = {}, who) => out.push({ ...base, kind, action, text: short(text), who: who || actorOf(e, names) || { id: 'system', name: 'hivedesk', kind: 'system' }, ...extra });
    switch (e.type) {
      case 'file.changed':
        push('file', d.op === 'create' ? 'created' : d.op === 'delete' ? 'deleted' : 'edited', d.path, { path: d.path, op: d.op, added: d.added || 0, removed: d.removed || 0, taskId: d.taskId || null });
        break;
      case 'chat.message':
        if (d.from === 'system') break;
        push('chat', 'said', d.text, { channel: d.channel });
        break;
      case 'job.created':
        push('job', 'asked', d.job?.request, {}, { id: 'user', name: 'You', kind: 'human' });
        break;
      case 'job.done': push('job', 'finished', d.summary); break;
      case 'job.failed': push('job', 'failed', typeof d.error === 'string' ? d.error : d.error?.message); break;
      case 'job.cancelled': push('job', 'cancelled', 'Job cancelled', {}, { id: 'user', name: 'You', kind: 'human' }); break;
      case 'task.status': {
        if (!['done', 'failed'].includes(d.status)) break;
        const t = state.tasks?.[d.taskId];
        const who = t?.assignee ? { id: t.assignee, name: names.get(t.assignee) || t.assignee, kind: 'worker' } : undefined;
        push('task', d.status === 'done' ? 'finished task' : 'failed task', t?.title || d.note || d.taskId, { taskId: d.taskId }, who);
        break;
      }
      case 'approval.resolved':
        push('approval', d.approved ? 'approved' : 'rejected', d.note || d.approvalId, {}, d.by === 'user' ? { id: 'user', name: 'You', kind: 'human' } : actorOf(e, names));
        break;
      case 'run.finished': {
        const w = calls.get(d.callId);
        push('run', 'ran', `${d.command} (exit ${d.exitCode})`, {}, w ? { id: w, name: names.get(w) || w, kind: 'worker' } : undefined);
        break;
      }
      case 'crew.hired': if (d.worker && !d.worker.builtin) push('crew', 'hired', d.worker.name, {}, { id: 'user', name: 'You', kind: 'human' }); break;
      case 'crew.fired': push('crew', 'fired', names.get(d.workerId) || d.workerId, {}, { id: 'user', name: 'You', kind: 'human' }); break;
      case 'github.connected': push('git', 'connected GitHub', `@${d.login} (${d.source})`); break;
      case 'github.disconnected': push('git', 'disconnected GitHub', d.login ? `@${d.login}` : ''); break;
      case 'github.cloned': push('git', 'cloned', d.repo, { url: d.url }); break;
      case 'github.repo.created': push('git', 'created repository', `${d.fullName} (${d.private ? 'private' : 'public'})`, { url: d.url }); break;
      case 'github.branch': push('git', 'created branch', d.branch); break;
      case 'github.committed': push('git', 'committed', `${String(d.sha || '').slice(0, 7)} ${d.subject}`, { files: d.files }); break;
      case 'github.pushed': push('git', 'pushed', `${d.branch} to ${d.remote}`, { url: d.url }); break;
      case 'github.pr.opened': push('git', 'opened pull request', `#${d.number} ${d.title}`, { url: d.url }); break;
      case 'github.failed': push('git', 'failed', `${d.action}: ${d.message}`); break;
      case 'changelog.written': push('changelog', 'updated the changelog', d.version ? `${d.path} (${d.version})` : `${d.path} (Unreleased)`, { path: d.path }); break;
      default: break;
    }
  }
  return out;
}

/**
 * @param {any[]} entries
 * @param {{ who?: string, kind?: string, q?: string, jobId?: string, since?: string, until?: string, path?: string }} f
 */
export function filterActivity(entries, f = {}) {
  const q = String(f.q || '').trim().toLowerCase();
  const since = f.since ? Date.parse(f.since) : NaN;
  const until = f.until ? Date.parse(f.until) : NaN;
  return entries.filter((e) => {
    if (f.who && e.who.id !== f.who && !(f.who === 'humans' && e.who.kind !== 'worker' && e.who.kind !== 'system') && !(f.who === 'workers' && e.who.kind === 'worker')) return false;
    if (f.kind && e.kind !== f.kind) return false;
    if (f.jobId && e.jobId !== f.jobId) return false;
    if (f.path && e.path !== f.path) return false;
    if (!Number.isNaN(since) && Date.parse(e.ts) < since) return false;
    if (!Number.isNaN(until) && Date.parse(e.ts) > until) return false;
    if (q && !`${e.who.name} ${e.action} ${e.text} ${e.path || ''}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

/** Everyone who appears in the log, for the filter. */
export function people(entries) {
  const m = new Map();
  for (const e of entries) if (!m.has(e.who.id)) m.set(e.who.id, { ...e.who, count: 0 });
  for (const e of entries) m.get(e.who.id).count++;
  return [...m.values()].sort((a, b) => b.count - a.count);
}

const csvCell = (v) => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // no formulas when opened in a spreadsheet
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function exportActivity(entries, format = 'json') {
  if (format === 'csv') {
    const rows = [['time', 'who', 'kind', 'role', 'action', 'detail', 'path', 'added', 'removed', 'job', 'seq']];
    for (const e of entries) rows.push([e.ts, e.who.name, e.kind, e.who.kind, e.action, e.text, e.path || '', e.added ?? '', e.removed ?? '', e.jobId || '', e.seq]);
    return { type: 'text/csv; charset=utf-8', ext: 'csv', body: rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n' };
  }
  if (format === 'md') {
    const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
    const lines = ['# Activity', '', '| Time | Who | What | Detail |', '| --- | --- | --- | --- |'];
    for (const e of entries) lines.push(`| ${e.ts} | ${esc(e.who.name)}${e.who.kind === 'guest' ? ' (guest)' : ''} | ${esc(e.action)} | ${esc(e.text)} |`);
    return { type: 'text/markdown; charset=utf-8', ext: 'md', body: lines.join('\n') + '\n' };
  }
  return { type: 'application/json; charset=utf-8', ext: 'json', body: JSON.stringify({ exportedAt: new Date().toISOString(), entries }, null, 2) };
}
