// The glue between the library and the crew. It listens to the event log: when Mel plans a job,
// each task gets its playbooks (kept here by task id, read by the prompt assembly and shown in the
// UI through `library.selected`); the user can swap one while the task is pending; the checks of the
// picked playbooks run in QA (Hive.playbookChecks) and in the Hive City Test room (Hive.playbookTestChecks).
import { getLibrary, roleOf, configureLibrary } from './index.js';
import { selectPlaybooks, rerank, searchLibrary } from './select.js';
import { runChecks, CHECKS } from './checks.js';
import { DOMAINS } from '../domains/index.js';

/** taskId -> the picks of that task (short form). */
const planned = new Map();
/** jobId -> { pinned, blocked }: swaps made on the brief, before the plan exists. */
const overrides = new Map();
/** jobId -> the playbooks shown on the brief. */
const previews = new Map();
/** jobId -> the domain of the job (the job.domain event of src/crew/domains/flow.js). */
const domains = new Map();

export function setJobDomain(jobId, domain) {
  domains.set(jobId, domain);
  if (domains.size > MAX_PLANNED) domains.delete(domains.keys().next().value);
}

export function jobDomain(jobId) {
  return domains.get(jobId) || null;
}
const MAX_PLANNED = 2000;

export function jobOverrides(jobId) {
  if (!overrides.has(jobId)) overrides.set(jobId, { pinned: new Set(), blocked: new Set() });
  return overrides.get(jobId);
}

/** The playbooks picked for a task, or null when it has none. */
export function playbooksOf(task) {
  if (!task) return null;
  return task.playbooks || planned.get(task.id) || null;
}

export function setPlaybooks(taskId, picks) {
  planned.set(taskId, picks);
  if (planned.size > MAX_PLANNED) planned.delete(planned.keys().next().value);
}

export function resetLibraryState() {
  planned.clear();
  overrides.clear();
  previews.clear();
  domains.clear();
}

/** The short form kept per task and sent in events. */
const slim = (p) => ({ id: p.id, title: p.title, score: p.score, terms: p.terms, ...(p.strong === false ? { strong: false } : {}), ...(p.pinned ? { pinned: true } : {}), ...(p.reranked ? { reranked: true } : {}), ...(p.swapped ? { swapped: true } : {}) });

/**
 * Picks the playbooks for one task.
 * @param {{ task: any, job?: any, worker?: any, files?: string[], family?: string, room?: string, library?: any }} input
 */
export function pickForTask({ task, job, worker, files = [], family = 'small', room, library }) {
  const lib = library || getLibrary();
  const o = job?.id && overrides.has(job.id) ? overrides.get(job.id) : { pinned: new Set(), blocked: new Set() };
  const role = roleOf(worker || task.assignee || 'dev');
  // A pinned entry only goes to the tasks whose role can use it.
  const pinned = [...o.pinned].filter((id) => lib.get(id)?.roles.includes(role));
  return selectPlaybooks({
    task: `${task.title || ''}. ${task.detail || ''}`, request: job?.request, brief: job?.brief, files, role, room, kind: task.kind, family,
    pinned, blocked: [...o.blocked], library: lib, domain: job?.domain || (job?.id ? jobDomain(job.id) : null) || undefined
  });
}

/** The playbooks of a job before the plan exists: the brief window shows these and lets the user swap. */
export function previewForJob({ job, family = 'small', files = [], library }) {
  const lib = library || getLibrary();
  const o = job?.id && overrides.has(job.id) ? overrides.get(job.id) : { pinned: new Set(), blocked: new Set() };
  return selectPlaybooks({ request: job?.request, brief: job?.brief, files, limit: 3, pinned: [...o.pinned], blocked: [...o.blocked], library: lib, budget: family === 'cloud' ? 2000 : 1400 });
}

/**
 * Replaces one playbook of a task (or of the job, before the plan) by another.
 * @param {{ jobId: string, taskId?: string, from?: string, to?: string, status?: string, library?: any }} spec
 */
export function swapPlaybook({ jobId, taskId, from, to, status, library }) {
  const lib = library || getLibrary();
  const next = to ? lib.get(to) : null;
  if (to && !next) throw Object.assign(new Error(`no library entry ${to}`), { code: 'not_found' });
  if (!taskId) {
    const o = jobOverrides(jobId);
    if (from) { o.blocked.add(from); o.pinned.delete(from); }
    if (next) { o.pinned.add(next.id); o.blocked.delete(next.id); }
    return { pinned: [...o.pinned], blocked: [...o.blocked] };
  }
  if (status && status !== 'pending') throw Object.assign(new Error('the task has started; its playbooks can no longer change'), { code: 'conflict' });
  let list = (planned.get(taskId) || []).filter((p) => p.id !== from);
  if (next && !list.some((p) => p.id === next.id)) list = [...list, { id: next.id, title: next.title, score: 0, terms: [], swapped: true }].slice(-3);
  setPlaybooks(taskId, list);
  return { playbooks: list };
}

/**
 * How sure a pick must be before its checks can fail QA (and it must match a rare word of the request on
 * its tags, see `strong` in select.js). Picks below it, and checks of level "warn",
 * only advise (they go to the notes). An entry the user pinned or swapped in always counts.
 */
export const ENFORCE_SCORE = 10;
const enforced = (p) => p.pinned || p.swapped || ((p.score || 0) >= ENFORCE_SCORE && p.strong !== false);

/** The check ids of the playbooks picked for these tasks: the ones that can fail QA and the ones that advise.
 * The checks of the job's domain (a mobile job: manifest, service worker, Capacitor config) always count. */
export function checkIdsOf(tasks, library, domain) {
  const lib = library || getLibrary();
  const enforce = new Set((DOMAINS[domain]?.build ? DOMAINS[domain].checks : []).filter((c) => CHECKS[c]));
  const advise = new Set();
  for (const t of tasks || []) {
    for (const p of playbooksOf(t) || []) {
      for (const c of lib.get(p.id)?.checks || []) if (CHECKS[c]) (enforced(p) ? enforce : advise).add(c);
    }
  }
  for (const c of enforce) advise.delete(c);
  return { enforce: [...enforce], advise: [...advise], all: [...enforce, ...advise] };
}

/** Runs enforce and advise checks; advisory errors become notes. */
function runSplit(ids, where) {
  const r = runChecks(ids.all, where);
  const soft = new Set(ids.advise);
  const issues = [];
  const notes = [...r.notes];
  for (const x of r.results) {
    if (x.level !== 'error') continue;
    for (const i of x.issues) (soft.has(x.id) ? notes : issues).push(`[${x.id}] ${i}`);
  }
  return { passed: issues.length === 0, issues, notes, results: r.results.map((x) => ({ ...x, enforced: !soft.has(x.id) })) };
}

/**
 * Adds the playbook checks to a checkWorkspace result (QA): the errors of confident picks become issues and
 * fail the review, the rest goes to `notes`. `only` limits the content checks to the files the job wrote, so
 * text that was already in the project (an old TODO) does not fail a job that did not touch it.
 * @param {{ passed: boolean, checked?: string[], issues: string[] }} base
 * Only the first QA round can fail on them: later rounds get them as notes, so one fix round follows a
 * playbook check and a small model is never stuck in fix rounds on them.
 * @param {string[]} [only]
 */
export function withPlaybookChecks(base, ws, tasks, library, only, domain) {
  const ids = checkIdsOf(tasks, library, domain);
  if (!ids.all.length) return base;
  if ((tasks || []).some((t) => t.kind === 'qa' && t.status === 'done')) { ids.advise = ids.all; ids.enforce = []; }
  const r = runSplit(ids, only?.length ? { ws, only } : { ws });
  const issues = [...base.issues, ...r.issues.filter((i) => !base.issues.includes(i))];
  return { ...base, passed: base.passed && r.passed, issues, notes: r.notes, playbook: { ids: ids.all, results: r.results } };
}

/**
 * The Hive City Test room: the checks of the playbooks that fit the task, on its files. Only testing
 * playbooks (role qa or reviewer) picked with confidence can fail the hop, and only on its first test
 * (cityTask.loops is 0); the others advise.
 */
export function cityTestChecks(ws, cityTask, library) {
  const files = cityTask?.files || [];
  if (!files.length) return { passed: true, issues: [], notes: [], ids: [] };
  const lib = library || getLibrary();
  const sel = selectPlaybooks({ task: `${cityTask.title || ''}. ${cityTask.detail || ''}`, files, role: 'qa', room: 'test', budget: Infinity, library: lib });
  const enforce = new Set();
  const advise = new Set();
  for (const p of sel.picks) {
    const e = lib.get(p.id);
    const tester = e?.roles.some((r) => r === 'qa' || r === 'reviewer');
    for (const c of e?.checks || []) if (CHECKS[c]) (tester && enforced(p) && !cityTask.loops ? enforce : advise).add(c);
  }
  for (const c of enforce) advise.delete(c);
  const ids = { enforce: [...enforce], advise: [...advise], all: [...enforce, ...advise] };
  if (!ids.all.length) return { passed: true, issues: [], notes: [], ids: [] };
  const r = runSplit(ids, { ws, only: files });
  return { passed: r.passed, issues: r.issues, notes: r.notes, ids: ids.all, picks: sel.picks.map(slim) };
}

const familyOf = (brain = {}) => {
  const backend = brain?.backend || 'local';
  if (!['local', 'fake', 'ollama', 'lmstudio', 'none'].includes(backend)) return 'cloud';
  return /(^|[^0-9.])(0\.5|1\.5|3)b/.test(String(brain?.model || '').toLowerCase()) || backend === 'fake' || backend === 'none' ? 'small' : 'local';
};

/**
 * Wires the library into a running hivedesk: the event listener, the QA and Test hooks and the
 * commands of the Library window.
 * @param {{ bus: any, hive: any, server?: any, scheduler?: any, dir?: string | null }} opts dir: the folder of your own entries
 *   (undefined keeps the shared library as it is, null means builtin entries only)
 */
export function attachLibrary({ bus, hive, server, scheduler, dir }) {
  const lib = dir === undefined ? getLibrary() : configureLibrary({ userDir: dir });
  const family = () => familyOf(bus.state?.brain);
  const files = () => { try { return hive.toolbox.ws.list().map((f) => f.path); } catch { return []; } };
  const jobOf = (jobId) => bus.state.jobs.find((j) => j.id === jobId) || null;
  const workerOf = (id) => { try { return hive.crewById().get(id); } catch { return null; } };
  /** jobId -> the files the job created or changed. */
  const touched = new Map();

  const pick = (jobId, tasks) => {
    const job = jobOf(jobId);
    const fam = family();
    const list = files();
    const out = [];
    for (const t of tasks) {
      if (!t?.id) continue;
      const sel = pickForTask({ task: t, job: { ...(job || {}), id: jobId }, worker: workerOf(t.assignee), files: list, family: fam });
      const picks = sel.picks.map(slim);
      setPlaybooks(t.id, picks);
      out.push({ taskId: t.id, workerId: t.assignee, picks, candidates: sel.candidates.slice(0, 5), budget: sel.budget, used: sel.used });
      if (fam === 'cloud' && scheduler && picks.length) {
        const ask = (messages, schema) => scheduler.turn({ workerId: 'mel', jobId, messages, options: { schema, maxTokens: 300, temperature: 0 } }).then((r) => r.json);
        rerank(`${t.title}. ${t.detail || ''}`, sel, ask).then((r) => {
          if (!r.reranked || bus.state.tasks?.[t.id]?.status !== 'pending') return;
          const again = r.picks.map(slim);
          setPlaybooks(t.id, again);
          bus.emit('library.selected', { tasks: [{ taskId: t.id, workerId: t.assignee, picks: again, reranked: true }] }, { jobId });
        }, () => {});
      }
    }
    if (out.length) bus.emit('library.selected', { tasks: out }, { jobId });
  };

  const off = bus.on((e) => {
    if (e.type === 'file.changed' && e.jobId && e.data?.path) {
      if (!touched.has(e.jobId)) touched.set(e.jobId, new Set());
      if (e.data.op === 'delete') touched.get(e.jobId).delete(e.data.path); else touched.get(e.jobId).add(e.data.path);
      if (touched.size > 200) touched.delete(touched.keys().next().value);
    } else if (e.type === 'job.domain' && e.jobId) setJobDomain(e.jobId, e.data?.domain);
    else if (e.type === 'job.planned') pick(e.jobId, e.data?.tasks || []);
    else if (e.type === 'task.added') pick(e.jobId, [e.data?.task]);
    else if (e.type === 'brief.proposed') {
      const job = { ...(jobOf(e.jobId) || {}), id: e.jobId, request: e.data?.original, brief: e.data?.brief?.text };
      const sel = previewForJob({ job, family: family(), files: files() });
      previews.set(e.jobId, sel.picks.map(slim));
      bus.emit('library.preview', { picks: previews.get(e.jobId) }, { jobId: e.jobId });
    }
  });

  if (hive) {
    hive.playbookChecks = (checks, tasks) => {
      const jobId = tasks?.[0]?.jobId;
      const r = withPlaybookChecks(checks, hive.toolbox.ws, tasks, undefined, [...(touched.get(jobId) || [])], jobDomain(jobId));
      if (r.playbook) bus.emit('library.checks', { results: r.playbook.results }, { jobId });
      return r;
    };
    hive.playbookTestChecks = (cityTask) => cityTestChecks(hive.toolbox.ws, cityTask);
  }

  if (server?.command) {
    const fail = (code, msg) => { throw Object.assign(new Error(msg), { code }); };
    const view = (e, full = false) => ({
      id: e.id, title: e.title, category: e.category, roles: e.roles, tags: e.tags, when: e.when, size: e.size, version: e.version,
      source: e.source || 'builtin', favorite: lib.favorites().has(e.id), checks: e.checks,
      ...(full ? { inputs: e.inputs, prompt: e.prompt, examples: e.examples } : {})
    });
    server.command('library.list', (d) => {
      const q = typeof d.q === 'string' ? d.q.slice(0, 200) : '';
      let rows = searchLibrary(q, { category: typeof d.category === 'string' ? d.category : undefined, role: typeof d.role === 'string' ? d.role : undefined, limit: Math.min(2000, Number(d.limit) || 2000) });
      if (d.favorites) rows = rows.filter((r) => lib.favorites().has(r.entry.id));
      return { entries: rows.map((r) => ({ ...view(r.entry), score: r.score, terms: r.terms })), total: lib.size, stats: lib.stats() };
    });
    server.command('library.get', (d) => {
      const e = lib.get(String(d.id || ''));
      if (!e) fail('not_found', 'no library entry with that id');
      return { entry: view(e, true) };
    });
    server.command('library.favorite', (d) => ({ favorites: lib.setFavorite(String(d.id || ''), d.on !== false) }));
    server.command('library.add', (d) => ({ entry: view(lib.add(d.entry || d), true) }));
    server.command('library.remove', (d) => { if (!lib.remove(String(d.id || ''))) fail('not_found', 'no library entry with that id'); return {}; });
    server.command('library.preview', (d) => {
      const sel = selectPlaybooks({ request: String(d.text || '').slice(0, 4000), role: typeof d.role === 'string' ? d.role : undefined, family: family() });
      return { picks: sel.picks.map(slim), candidates: sel.candidates };
    });
    server.command('library.job', (d) => {
      const job = jobOf(String(d.jobId || ''));
      if (!job) fail('not_found', 'no job with that id');
      return { preview: previews.get(job.id) || [], tasks: (job.taskIds || []).filter((id) => planned.has(id)).map((id) => ({ taskId: id, picks: planned.get(id) })) };
    });
    server.command('library.swap', (d) => {
      const jobId = String(d.jobId || '');
      if (!jobOf(jobId)) fail('not_found', 'no job with that id');
      const taskId = typeof d.taskId === 'string' && d.taskId ? d.taskId : undefined;
      const status = taskId ? bus.state.tasks?.[taskId]?.status : undefined;
      if (taskId && !status) fail('not_found', 'no task with that id');
      const r = swapPlaybook({ jobId, taskId, from: d.from ? String(d.from) : undefined, to: d.to ? String(d.to) : undefined, status });
      if (taskId) bus.emit('library.selected', { tasks: [{ taskId, picks: r.playbooks, swapped: true }] }, { jobId });
      else {
        const job = jobOf(jobId);
        previews.set(jobId, previewForJob({ job: { ...job, brief: job.brief || job.briefProposed?.text }, family: family(), files: files() }).picks.map(slim));
        bus.emit('library.preview', { picks: previews.get(jobId), swapped: true }, { jobId });
      }
      return r;
    });
  }
  return { library: lib, off };
}
