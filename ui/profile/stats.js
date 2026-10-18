// Profile statistics: counters computed from the engine's own event log, never invented
// (docs/1.0/PROFILE.md). Pure module shared by the engine (src/profile/) and the tests.
// Every counter has one source event; demo events are counted only into a demo home.

export const STATS_VERSION = 1;
const CAP = { projects: 1000, models: 50, friends: 500, days: 800 };
const DOMAINS = ['code', 'design', 'test', 'review', 'docs', 'plan', 'other'];

export function blankStats() {
  return {
    v: STATS_VERSION, jobs: 0, projects: [], files: 0, tasksByDomain: Object.fromEntries(DOMAINS.map((d) => [d, 0])),
    crewMs: 0, tokens: 0, models: [], lentGpuMs: 0, lentCpuMs: 0, lentJobs: 0, borrowedMs: 0, borrowedJobs: 0,
    friends: [], remoteSessions: 0, playbooksUsed: 0, days: [], qaPassed: 0, approvals: 0, nightJobs: 0,
    themes: 0, extensions: 0, prs: 0, changelogs: 0, hires: 0, memories: 0, voice: 0, mobile: 0, auditClean: 0,
  };
}

const n = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
const addUnique = (list, v, cap) => { if (v && !list.includes(v)) { list.push(v); if (list.length > cap) list.shift(); } };
const day = (ts) => { const d = new Date(ts); return Number.isNaN(d.getTime()) ? null : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/** The domain of a task from its worker's role. */
export function domainOf(role) {
  const r = String(role || '').toLowerCase();
  if (/dev|code|engineer|program/.test(r)) return 'code';
  if (/design|\bui\b|style/.test(r)) return 'design';
  if (/qa|test|check/.test(r)) return 'test';
  if (/review/.test(r)) return 'review';
  if (/writ|doc|copy|readme/.test(r)) return 'docs';
  if (/plan|foreman|mel|architect/.test(r)) return 'plan';
  return 'other';
}

/** Repairs a stats object read from disk: known keys only, numbers clamped, lists bounded. */
export function normalizeStats(raw) {
  const s = blankStats();
  if (!raw || typeof raw !== 'object') return s;
  for (const k of Object.keys(s)) {
    if (k === 'v') continue;
    if (Array.isArray(s[k])) s[k] = Array.isArray(raw[k]) ? raw[k].filter((x) => typeof x === 'string').map((x) => x.slice(0, 120)).slice(-(CAP[k] || 500)) : [];
    else if (k === 'tasksByDomain') for (const d of DOMAINS) s.tasksByDomain[d] = n(raw.tasksByDomain?.[d]);
    else s[k] = n(raw[k]);
  }
  return s;
}

/**
 * Counts one engine event. ctx: { project: string, roleOf: (taskId) => string, local: boolean }.
 * Returns true when a counter changed.
 * @param {ReturnType<typeof blankStats>} s
 * @param {{ type: string, ts?: string, data?: any }} ev
 */
export function applyEvent(s, ev, ctx = {}) {
  const d = ev?.data || {};
  const ts = ev?.ts || new Date().toISOString();
  switch (ev?.type) {
    case 'job.done': {
      s.jobs++;
      addUnique(s.projects, ctx.project || 'default', CAP.projects);
      addUnique(s.days, day(ts), CAP.days);
      const h = new Date(ts).getHours();
      if (h >= 0 && h < 5) s.nightJobs++;
      return true;
    }
    case 'file.changed':
      if (d.op === 'create' || d.op === 'modify') { s.files++; return true; }
      return false;
    case 'task.status':
      if (d.status !== 'done') return false;
      s.tasksByDomain[domainOf(ctx.roleOf?.(d.taskId))]++;
      return true;
    case 'turn.ended':
      if (d.error) return false;
      s.crewMs += n(d.ms);
      s.tokens += n(d.completionTokens);
      addUnique(s.days, day(ts), CAP.days);
      return true;
    case 'brain.status':
      if (d.state === 'ready' && typeof d.model === 'string' && d.model && !/demo/.test(d.model)) { addUnique(s.models, d.model.slice(0, 120), CAP.models); return true; }
      return false;
    case 'job.served':
      if (d.outcome !== 'completed') return false;
      s.lentJobs++;
      if (String(d.device || '').toLowerCase().includes('cpu')) s.lentCpuMs += n(d.ms); else s.lentGpuMs += n(d.ms);
      return true;
    case 'job.ended': {
      if (d.role !== 'requester' || d.state !== 'completed' || !d.worker || d.worker === 'local') return false;
      const ms = Date.parse(d.endedAt) - Date.parse(d.createdAt);
      s.borrowedJobs++;
      s.borrowedMs += n(ms);
      return true;
    }
    case 'p2p.peer':
      if (!d.online) return false;
      addUnique(s.friends, String(d.peerId || '').slice(0, 120), CAP.friends);
      return true;
    case 'p2p.grant':
      if (!/^remote\./.test(String(d.capability || ''))) { if (/^phone\./.test(String(d.capability || ''))) { s.mobile++; return true; } return false; }
      s.remoteSessions++;
      return true;
    case 'playbook.used': s.playbooksUsed++; return true;
    case 'qa.report': if (!d.passed) return false; s.qaPassed++; return true;
    case 'approval.resolved': if (d.by !== 'user') return false; s.approvals++; return true;
    case 'theme.generated': s.themes++; return true;
    case 'extension.installed': s.extensions++; return true;
    case 'github.pr.opened': s.prs++; return true;
    case 'changelog.written': s.changelogs++; return true;
    case 'crew.hired': if (d.worker?.builtin) return false; s.hires++; return true;
    case 'memory.changed': s.memories++; return true;
    case 'phone.paired': s.mobile++; return true;
    default: return false;
  }
}

/** Consecutive days with work, ending today (or yesterday, so the streak is not lost before today's first job). */
export function streak(days, now = Date.now()) {
  const set = new Set(days);
  const at = new Date(now);
  let k = 0;
  if (!set.has(day(at))) at.setDate(at.getDate() - 1);
  while (set.has(day(at))) { k++; at.setDate(at.getDate() - 1); }
  return k;
}

/** The longest run of consecutive days in the list. */
export function bestStreak(days) {
  const sorted = [...new Set(days)].sort();
  let best = 0; let run = 0; let prev = null;
  for (const d of sorted) {
    const t = Date.parse(`${d}T12:00:00`);
    run = prev != null && Math.round((t - prev) / 86_400_000) === 1 ? run + 1 : 1;
    best = Math.max(best, run);
    prev = t;
  }
  return best;
}

/** The numbers the Profile page shows. */
export function summary(s, now = Date.now()) {
  const hours = (ms) => Math.round((ms / 3_600_000) * 10) / 10;
  return {
    projects: s.projects.length, jobs: s.jobs, files: s.files, tasksByDomain: { ...s.tasksByDomain },
    crewHours: hours(s.crewMs), tokens: s.tokens, models: [...s.models],
    lentGpuHours: hours(s.lentGpuMs), lentCpuHours: hours(s.lentCpuMs), lentJobs: s.lentJobs, borrowedHours: hours(s.borrowedMs), borrowedJobs: s.borrowedJobs,
    friends: s.friends.length, remoteSessions: s.remoteSessions, playbooksUsed: s.playbooksUsed,
    streak: streak(s.days, now), bestStreak: bestStreak(s.days), activeDays: s.days.length,
  };
}
