// The hive: request, planner, task graph, workers taking turns, tools, QA, done.
import { BUILTIN, BUILTIN_IDS, hireWorker } from './workers.js';
import { TaskGraph } from './taskgraph.js';
import { Memory } from './memory.js';
import { makePlan } from './planner.js';
import { runTask } from './worker.js';
import { checkWorkspace } from '../tools/check.js';
import { modelFamily } from './prompts/index.js';
import { BRIEF_SCHEMA, briefMessages, normalizeBrief, briefText, acceptanceFrom, answerBrief, isVague, REPORT_SCHEMA, reportMessages, buildReport, fallbackPrompt } from './brief.js';

const MAX_FIX_ROUNDS = 3;
/** Mel stops a job that uses more model turns than this (a loop that does not converge). */
const JOB_TURN_BUDGET = 160;
let chatSeq = 0;

/** A signal that aborts when any of the given signals aborts (AbortSignal.any is not in Node 18). */
function anySignal(signals) {
  const ctrl = new AbortController();
  for (const sig of signals) {
    if (!sig) continue;
    if (sig.aborted) { ctrl.abort(); break; }
    sig.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  return ctrl.signal;
}

export class Hive {
  /**
   * @param {{
   *   bus: import('../bus.js').EventBus, scheduler: import('./scheduler.js').Scheduler,
   *   toolbox: import('../tools/index.js').ToolBox, approvals: import('../tools/approvals.js').Approvals,
   *   playbooks: import('../playbooks/index.js').PlaybookStore, maxTurns?: number, previewUrl?: () => string | null,
   *   autoApproveBriefMs?: number
   * }} opts
   */
  constructor(opts) {
    this.bus = opts.bus;
    this.scheduler = opts.scheduler;
    this.toolbox = opts.toolbox;
    this.approvals = opts.approvals;
    this.playbooks = opts.playbooks;
    this.maxTurns = opts.maxTurns;
    /** Demo and tests: approve the proposed brief by itself after this many ms (0: wait for the user). */
    this.autoApproveBriefMs = opts.autoApproveBriefMs || 0;
    /** Long term memory (src/memory), optional. */
    this.memoryStore = opts.memoryStore || null;
    this.previewUrl = opts.previewUrl || (() => null);
    this.memory = new Memory();
    /** @type {Map<string, { ctrl: AbortController, notes: Map<string, string[]>, promise: Promise<any> }>} */
    this.active = new Map();
  }

  get state() {
    return this.bus.state;
  }

  /** First start: hire the builtin crew, sync playbooks, and close jobs left open by a crash. */
  init() {
    for (const w of this.state.crew) if (w.paused) this.scheduler.setPaused(w.id, true);
    const have = new Set(this.state.crew.map((w) => w.id));
    for (const w of BUILTIN) if (!have.has(w.id)) this.bus.emit('crew.hired', { worker: w });
    const known = new Set(this.state.playbooks.map((p) => p.id));
    for (const p of this.playbooks.list()) if (!known.has(p.id)) this.bus.emit('playbook.saved', { playbook: p });
    for (const j of this.state.jobs) {
      if (j.status === 'planning' || j.status === 'running') {
        for (const id of j.taskIds) {
          const t = this.state.tasks[id];
          if (t && (t.status === 'running' || t.status === 'pending' || t.status === 'review')) this.bus.emit('task.status', { taskId: id, status: 'skipped', note: 'hivedesk stopped' }, { jobId: j.id });
        }
        this.bus.emit('job.failed', { error: 'hivedesk was stopped while this job was running' }, { jobId: j.id });
      }
    }
    for (const w of this.state.crew) {
      const s = this.state.workers[w.id];
      if (s && s.status !== 'idle') this.bus.emit('worker.status', { workerId: w.id, status: 'idle' });
    }
  }

  crewById() {
    return new Map(this.state.crew.map((w) => [w.id, w]));
  }

  chat(from, text, taskId, channel = 'general', jobId) {
    const data = { id: `m_${Date.now().toString(36)}_${++chatSeq}`, channel, from, text };
    if (taskId) data.taskId = taskId;
    this.bus.emit('chat.message', data, jobId ? { jobId } : {});
    return data.id;
  }

  // ---- crew ----
  hire(spec) {
    const worker = hireWorker(spec, this.state.crew);
    this.bus.emit('crew.hired', { worker });
    return worker;
  }

  updateWorker(workerId, fields = {}) {
    const w = this.state.crew.find((x) => x.id === workerId);
    if (!w) throw Object.assign(new Error(`no worker ${workerId}`), { code: 'not_found' });
    const next = { ...w };
    for (const k of ['name', 'role', 'prompt', 'color', 'avatar']) if (typeof fields[k] === 'string' && fields[k].trim()) next[k] = fields[k].trim().slice(0, k === 'prompt' ? 2000 : 64);
    if (Array.isArray(fields.tools) && !w.builtin) next.tools = hireWorker({ name: 'x', role: 'x', tools: fields.tools }).tools;
    if (typeof fields.paused === 'boolean') {
      next.paused = fields.paused;
      this.scheduler.setPaused(workerId, fields.paused);
    }
    this.bus.emit('crew.updated', { worker: next });
    return next;
  }

  fire(workerId) {
    if (BUILTIN_IDS.includes(workerId)) throw Object.assign(new Error('the default crew cannot be fired'), { code: 'bad_request' });
    if (!this.state.crew.some((w) => w.id === workerId)) throw Object.assign(new Error(`no worker ${workerId}`), { code: 'not_found' });
    this.bus.emit('crew.fired', { workerId });
  }

  // ---- settings ----
  setSettings(patch = {}) {
    const changed = {};
    if (typeof patch.approvalMode === 'boolean') changed.approvalMode = patch.approvalMode;
    if (typeof patch.sound === 'boolean') changed.sound = patch.sound;
    if (Array.isArray(patch.crew)) changed.crew = patch.crew.filter((id) => typeof id === 'string').slice(0, 32);
    if (typeof patch.refine === 'boolean') changed.refine = patch.refine;
    if (typeof patch.memory === 'boolean') changed.memory = patch.memory;
    if (patch.workerBrains && typeof patch.workerBrains === 'object') {
      changed.workerBrains = Object.fromEntries(Object.entries(patch.workerBrains).filter(([k, v]) => typeof k === 'string' && typeof v === 'string').slice(0, 32));
    }
    if (Object.keys(changed).length) this.bus.emit('settings.changed', changed);
    if (changed.approvalMode === false) this.approvals.approveAll('auto');
    return this.state.settings;
  }

  // ---- chat from the user ----
  userChat(channel, text) {
    const ch = typeof channel === 'string' && (channel === 'general' || /^dm:[\w-]+$/.test(channel)) ? channel : 'general';
    const msg = String(text || '').trim().slice(0, 2000);
    if (!msg) throw Object.assign(new Error('empty message'), { code: 'bad_request' });
    const id = this.chat('user', msg, undefined, ch);
    const target = ch.startsWith('dm:') ? ch.slice(3) : '*';
    if (this.active.size) {
      for (const run of this.active.values()) {
        const list = run.notes.get(target) || [];
        list.push(msg);
        run.notes.set(target, list.slice(-5));
      }
    } else {
      const who = target === '*' ? 'mel' : target;
      if (this.crewById().has(who)) this.chat(who, 'Got it. Type a request in the top bar and the crew will start a job.', undefined, ch);
    }
    return id;
  }

  // ---- jobs ----
  /**
   * @param {{ request: string, approval?: boolean, playbookId?: string }} spec
   * @returns {{ jobId: string, done: Promise<any> }}
   */
  createJob(spec) {
    const request = String(spec?.request || '').trim().slice(0, 4000);
    if (!request) throw Object.assign(new Error('the request is empty'), { code: 'bad_request' });
    const jobId = `j_${this.state.jobs.length + 1}`;
    const job = {
      id: jobId, request, status: 'planning',
      approval: spec.approval === undefined ? this.state.settings.approvalMode !== false : !!spec.approval,
      refine: spec.refine === undefined ? this.state.settings.refine !== false : !!spec.refine,
      createdAt: new Date().toISOString(), taskIds: []
    };
    const ctrl = new AbortController();
    const run = { ctrl, notes: new Map(), promise: null };
    this.active.set(jobId, run);
    this.bus.emit('job.created', { job }, { jobId });
    run.promise = this._runJob(job, run, spec.playbookId).catch((err) => {
      if (ctrl.signal.aborted) return;
      this.bus.emit('job.failed', { error: String(err?.message || err) }, { jobId });
    }).finally(() => {
      this.active.delete(jobId);
      for (const w of this.state.crew) {
        if (this.state.workers[w.id]?.status && this.state.workers[w.id].status !== 'idle' && !this._busyElsewhere(w.id)) {
          this.bus.emit('worker.status', { workerId: w.id, status: 'idle' });
        }
      }
    });
    return { jobId, done: run.promise };
  }

  _busyElsewhere(workerId) {
    return this.active.size > 0 && this.scheduler.waiting.some((i) => i.workerId === workerId);
  }

  cancelJob(jobId) {
    const run = this.active.get(jobId);
    if (!run) throw Object.assign(new Error(`job ${jobId} is not running`), { code: 'not_found' });
    run.ctrl.abort();
    const job = this.state.jobs.find((j) => j.id === jobId);
    for (const id of job?.taskIds || []) {
      const t = this.state.tasks[id];
      if (t && !['done', 'failed', 'skipped', 'blocked'].includes(t.status)) this.bus.emit('task.status', { taskId: id, status: 'skipped', note: 'cancelled' }, { jobId });
    }
    this.bus.emit('job.cancelled', { by: 'user' }, { jobId });
    this.chat('mel', 'Job cancelled. The files written so far stay in the workspace.', undefined, 'general', jobId);
    return true;
  }

  async _runJob(job, run, playbookId) {
    const jobId = job.id;
    const signal = run.ctrl.signal;
    const ev = { jobId };
    // The crew chosen in the setup (settings.crew); hired workers and Mel always take part.
    const active = this.state.settings.crew;
    const crew = Array.isArray(active) ? this.state.crew.filter((w) => w.id === 'mel' || !w.builtin || active.includes(w.id)) : this.state.crew;
    const crewById = this.crewById();
    run.budget = { turns: 0, max: JOB_TURN_BUDGET };
    if (!this.scheduler.hasBrain) {
      this.chat('system', 'No model yet: the job waits until a model is ready. See the model status in the top bar or open Settings.', undefined, 'general', jobId);
    }
    // 1. The prompt refiner: Mel turns the request into a brief, the user approves, edits or keeps the original.
    if (job.refine) {
      this.chat('mel', `On it: "${job.request}". First I will write it up as a clear brief for you to check.`, undefined, 'general', jobId);
      await this._refine(job, run);
      if (signal.aborted) return;
    } else {
      this.chat('mel', `On it: "${job.request}". Let me make a plan.`, undefined, 'general', jobId);
    }
    const work = job.brief || job.request;
    // What we know: a few relevant memories (keyword and recency scoring), shown in the UI as "used".
    run.memories = [];
    if (this.memoryStore && this.state.settings.memory !== false) {
      const used = this.memoryStore.forJob(`${job.request} ${work}`, 6);
      run.memories = used.map((m) => m.text);
      if (used.length) this.bus.emit('memory.used', { items: used.map((m) => ({ id: m.id, text: m.text, kind: m.kind, scope: m.scope })) }, ev);
    }
    // Playbook retrieval.
    let playbook = null;
    let score = 0;
    if (playbookId) {
      playbook = this.playbooks.get(playbookId);
      score = playbook ? 1 : 0;
    } else {
      const hit = this.playbooks.search(work, { limit: 1, min: 0.25 })[0];
      if (hit) { playbook = hit.playbook; score = hit.score; }
    }
    this.bus.emit('job.planning', playbook ? { workerId: 'mel', playbookId: playbook.id, playbookScore: score } : { workerId: 'mel' }, ev);
    if (playbook) {
      this.playbooks.markUsed(playbook.id);
      this.bus.emit('playbook.used', { playbookId: playbook.id, score }, ev);
      this.chat('mel', `This looks like an earlier job ("${playbook.title}"), so I am reusing its playbook.`, undefined, 'general', jobId);
    }
    const files = this.toolbox.ws.list().map((f) => f.path);
    const plan = await makePlan({ scheduler: this.scheduler, request: work, crew, playbook, files, merge: modelFamily(this.state.brain) === 'small', notes: [...run.memories.map((m) => `memory: ${m}`), ...this.memory.crew(4)], jobId, signal });
    if (signal.aborted) return;
    if (plan.error) this.chat('system', `The planner answer was not usable (${plan.error}). Using a ${plan.source === 'playbook' ? 'saved playbook' : 'simple default plan'}.`, undefined, 'general', jobId);

    const jobNum = jobId.slice(2);
    const graph = new TaskGraph();
    const tasks = plan.tasks.map((t, i) => graph.add({
      id: `t_${jobNum}_${i + 1}`, jobId, title: t.title, detail: t.detail, assignee: t.assignee,
      dependsOn: t.dependsOn.map((d) => `t_${jobNum}_${d + 1}`), status: 'pending', attempts: 0, kind: t.kind
    }));
    this.bus.emit('job.planned', playbook ? { tasks: tasks.map((t) => ({ ...t })), playbookId: playbook.id } : { tasks: tasks.map((t) => ({ ...t })) }, ev);
    const lines = tasks.map((t, i) => `${i + 1}. ${crewById.get(t.assignee)?.name || t.assignee}: ${t.title}`);
    this.chat('mel', `${plan.summary ? plan.summary + '\n' : ''}Plan:\n${lines.join('\n')}`, undefined, 'general', jobId);
    await this._drive(job, run, {
      graph, tasks, preexisting: new Set(files), fixRounds: 0, nextIdx: tasks.length + 1,
      qaPassed: !crew.some((w) => w.id === 'qa'), openIssues: [], playbook, score
    });
  }

  /** Runs the task graph of a job to the end: workers take turns, QA adds fix rounds, then done. */
  async _drive(job, run, st) {
    const jobId = job.id;
    const signal = run.ctrl.signal;
    const ev = { jobId };
    const { graph } = st;
    const jobNum = jobId.slice(2);
    /** @type {Map<string, Promise<any>>} */
    const active = new Map();
    /** @type {Map<string, { ctrl: AbortController, why?: string }>} per task control, for cancel and reassign */
    const controls = new Map();
    const busy = new Set();
    let wake = null;
    const woken = () => new Promise((resolve) => { wake = resolve; });
    run.graph = graph;
    run.controls = controls;
    run.kick = () => { if (wake) { const w = wake; wake = null; w({ wake: true }); } };

    const startTask = (task) => {
      const crewById = this.crewById();
      const worker = crewById.get(task.assignee) || crewById.get('dev');
      graph.setStatus(task.id, 'running');
      this.bus.emit('task.status', { taskId: task.id, status: 'running' }, ev);
      const userNotes = () => [...(run.notes.get('*') || []), ...(run.notes.get(worker.id) || [])];
      let extra;
      let checks;
      if (task.kind === 'qa') {
        checks = checkWorkspace(this.toolbox.ws);
        extra = `Automatic checks: ${checks.passed ? `all passed (${checks.checked.length} files)` : `issues:\n- ${checks.issues.join('\n- ')}`}`;
        // Small models review better when the files are right in front of them.
        let budget = 6000;
        const shown = [];
        for (const f of this.toolbox.ws.list()) {
          if (budget <= 0 || !/\.(html?|css|m?js|json|md)$/i.test(f.path)) continue;
          let text = '';
          try { text = this.toolbox.ws.read(f.path); } catch { continue; }
          const cut = text.slice(0, Math.min(2500, budget));
          budget -= cut.length;
          shown.push(`--- ${f.path}\n${cut}${cut.length < text.length ? '\n[cut]' : ''}`);
        }
        if (shown.length) extra += `\n\nThe files now:\n${shown.join('\n')}\n\nCheck them against the job: is anything missing, duplicated, empty or broken?`;
        if (job.acceptance?.length) extra += `\n\nAcceptance criteria to check one by one (each unmet one is an issue):\n${job.acceptance.map((a) => `- [ ] ${a}`).join('\n')}`;
      }
      const control = { ctrl: new AbortController() };
      controls.set(task.id, control);
      const p = runTask({
        job, task, worker, graph, crewById, scheduler: this.scheduler, toolbox: this.toolbox, memory: this.memory, bus: this.bus,
        signal: anySignal([signal, control.ctrl.signal]), maxTurns: this.maxTurns, extra, userNotes, preexisting: st.preexisting, budget: run.budget,
        family: modelFamily(this.state.brain), contextTokens: this.state.brain?.ctx || undefined,
        recent: () => this._recentFiles(jobId), memories: run.memories || [],
        verify: task.kind === 'qa' ? undefined : (wrote) => {
          // Fix tasks must clear every static issue; build tasks only the ones in their own files
          // (a link to a file another worker has not written yet is not their problem).
          if (task.kind !== 'fix' && !wrote.length) return [];
          const r = checkWorkspace(this.toolbox.ws, task.kind === 'fix' ? undefined : wrote);
          return r.issues.filter((i) => task.kind === 'fix' || !/ links to /.test(i));
        },
        chat: (from, text, taskId) => this.chat(from, text, taskId, 'general', jobId)
      }).then((res) => ({ task, worker, res, checks, control }), (err) => ({ task, worker, err, checks, control }));
      active.set(task.id, p);
      busy.add(task.assignee);
    };

    while (true) {
      if (signal.aborted) return;
      for (const t of graph.propagateBlocked()) this.bus.emit('task.status', { taskId: t.id, status: 'blocked', note: 'a task it depends on failed or was cancelled' }, ev);
      // One task at a time per worker: two tasks of the same worker would fight over the same files.
      for (const t of graph.ready()) {
        if (!active.has(t.id) && !busy.has(t.assignee)) startTask(t);
      }
      if (!active.size) break;
      const out = await Promise.race([...active.values(), woken()]);
      if (out.wake) continue;
      const { task, worker, res, err, checks, control } = out;
      active.delete(task.id);
      controls.delete(task.id);
      busy.delete(worker.id);
      busy.delete(task.assignee);
      if (signal.aborted) return;
      if (control.why) {
        // Cancelled or reassigned by the user: the command already set the new status.
        this.bus.emit('worker.status', { workerId: worker.id, status: 'idle' }, ev);
        continue;
      }
      if (err) {
        graph.setStatus(task.id, 'failed');
        this.bus.emit('task.status', { taskId: task.id, status: 'failed', note: String(err.message || err).slice(0, 300) }, ev);
        this.bus.emit('worker.status', { workerId: worker.id, status: 'idle' }, ev);
        continue;
      }
      if (task.kind === 'qa') {
        const report = res.report || { passed: false, issues: ['QA gave no report'] };
        if (checks && !checks.passed) {
          for (const i of checks.issues) if (!report.issues.includes(i)) report.issues.push(i);
          report.passed = false;
        }
        this.bus.emit('qa.report', { taskId: task.id, passed: report.passed, issues: report.issues }, ev);
        graph.setStatus(task.id, 'done');
        this.bus.emit('task.status', { taskId: task.id, status: 'done', note: report.passed ? 'passed' : `${report.issues.length} issues` }, ev);
        this.chat(worker.id, report.passed ? 'All checks passed.' : `Found ${report.issues.length} issues:\n- ${report.issues.join('\n- ')}`, task.id, 'general', jobId);
        st.qaPassed = report.passed;
        st.openIssues = report.passed ? [] : report.issues;
        if (!report.passed && st.fixRounds < MAX_FIX_ROUNDS && this.crewById().has('dev')) {
          st.fixRounds++;
          const fix = graph.add({
            id: `t_${jobNum}_${st.nextIdx++}`, jobId, title: `Fix the QA issues (round ${st.fixRounds})`,
            detail: `QA found these problems. Read the files and fix each one:\n- ${report.issues.join('\n- ')}`,
            assignee: 'dev', dependsOn: [task.id], status: 'pending', attempts: 0, kind: 'fix'
          });
          this.bus.emit('task.added', { task: { ...fix } }, ev);
          const recheck = graph.add({
            id: `t_${jobNum}_${st.nextIdx++}`, jobId, title: 'Check the fixes', detail: `Check that these problems are fixed:\n- ${report.issues.join('\n- ')}`,
            assignee: 'qa', dependsOn: [fix.id], status: 'pending', attempts: 0, kind: 'qa'
          });
          this.bus.emit('task.added', { task: { ...recheck } }, ev);
        }
      } else {
        graph.setStatus(task.id, res.status);
        this.bus.emit('task.status', { taskId: task.id, status: res.status, note: res.summary }, ev);
        if (res.status === 'done') this.chat(worker.id, `Done: ${res.summary}`, task.id, 'general', jobId);
        else this.chat(worker.id, `I could not finish "${task.title}": ${res.summary}`, task.id, 'general', jobId);
      }
      this.bus.emit('worker.status', { workerId: worker.id, status: 'idle' }, ev);
    }
    run.kick = null;

    const all = graph.all();
    const failed = all.filter((t) => t.status === 'failed' || t.status === 'blocked');
    const skipped = all.filter((t) => t.status === 'skipped').length;
    const outFiles = this.toolbox.ws.list().map((f) => f.path);
    const buildTasks = all.filter((t) => t.kind !== 'qa' && t.status !== 'skipped');
    if (buildTasks.length && buildTasks.every((t) => t.status === 'failed' || t.status === 'blocked')) {
      this.bus.emit('job.failed', { error: `${failed.length} tasks failed` }, ev);
      this.chat('mel', 'This job did not work out. You can retry a task from its menu, try a smaller request, or use a bigger model.', undefined, 'general', jobId);
      await this._report(job, run);
      return;
    }
    const summary = failed.length
      ? `Finished with ${failed.length} failed tasks.`
      : st.qaPassed ? `Finished, and QA passed.${skipped ? ` ${skipped} tasks were cancelled.` : ''}` : `Finished, but QA still reports ${st.openIssues.length} issues.`;
    this.bus.emit('job.done', { summary, files: outFiles }, ev);
    const url = this.previewUrl();
    this.chat('mel', `${summary} Files: ${outFiles.join(', ') || 'none'}.${url ? ' Open the Live preview to see it.' : ''}`, undefined, 'general', jobId);
    if (st.tasks && !failed.length && !skipped && st.qaPassed && !(st.playbook && st.score >= 0.6)) {
      // Save the original plan (without the fix rounds) as a playbook.
      const base = st.tasks.filter((t) => t.kind !== 'fix');
      const index = new Map(base.map((t, i) => [t.id, i]));
      const playbookSaved = this.playbooks.save({
        request: job.request,
        tasks: base.map((t) => ({ title: t.title, detail: t.detail, assignee: t.assignee, kind: t.kind, dependsOn: t.dependsOn.map((d) => index.get(d)).filter((d) => d !== undefined) }))
      });
      this.bus.emit('playbook.saved', { playbook: playbookSaved }, ev);
    }
    await this._report(job, run);
  }

  // ---- prompt refiner ----
  async _refine(job, run) {
    const jobId = job.id;
    const ev = { jobId };
    this.bus.emit('job.refining', { workerId: 'mel' }, ev);
    let brief;
    try {
      const r = await this.scheduler.turn({
        workerId: 'mel', jobId, signal: run.ctrl.signal,
        messages: briefMessages(job.request, this.toolbox.ws.list().map((f) => f.path)),
        options: { schema: BRIEF_SCHEMA, maxTokens: 900, temperature: 0.2 }
      });
      brief = normalizeBrief(r.json, job.request);
    } catch (err) {
      if (run.ctrl.signal.aborted) return;
      this.chat('system', `The brief could not be written (${err.message}). The crew works from your request as written.`, undefined, 'general', jobId);
      job.brief = null;
      this.bus.emit('brief.approved', { brief: null, text: job.request, source: 'original' }, ev);
      return;
    }
    brief.text = briefText(brief);
    this.bus.emit('brief.proposed', { original: job.request, brief, vague: isVague(job.request) }, ev);
    this.chat('mel', 'Here is the brief. Use it, edit it, or keep your original request.', undefined, 'general', jobId);
    const decision = await new Promise((resolve, reject) => {
      run.briefWaiter = resolve;
      if (this.autoApproveBriefMs) {
        const t = setTimeout(() => resolve({ use: 'refined', by: 'auto' }), this.autoApproveBriefMs);
        t.unref?.();
      }
      run.ctrl.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    }).catch(() => null);
    run.briefWaiter = null;
    if (!decision) return;
    if (decision.answers && decision.use !== 'original') brief = answerBrief(brief, decision.answers);
    let text = brief.text;
    let source = 'refined';
    if (decision.use === 'original') { text = job.request; source = 'original'; }
    else if (decision.use === 'edited' && typeof decision.text === 'string' && decision.text.trim()) { text = decision.text.trim().slice(0, 8000); source = 'edited'; }
    job.brief = source === 'original' ? null : text;
    job.acceptance = source === 'original' ? [] : acceptanceFrom(text);
    this.bus.emit('brief.approved', { brief: source === 'refined' ? brief : null, text, source, ...(decision.by ? { by: decision.by } : {}) }, ev);
  }

  /** The command `brief.approve`. */
  approveBrief(jobId, { use = 'refined', text, answers } = {}) {
    const run = this.active.get(jobId);
    if (!run || !run.briefWaiter) throw Object.assign(new Error('no brief is waiting for that job'), { code: 'conflict' });
    if (!['refined', 'edited', 'original'].includes(use)) throw Object.assign(new Error('use must be refined, edited or original'), { code: 'bad_request' });
    run.briefWaiter({ use, text, answers, by: 'user' });
    return {};
  }

  // ---- end of job: report and improved prompt ----
  async _report(job, run) {
    const jobId = job.id;
    const report = buildReport(this.bus.events, jobId, this.state);
    let prompt;
    try {
      const r = await this.scheduler.turn({
        workerId: 'mel', jobId, signal: run.ctrl.signal,
        messages: reportMessages({ request: job.request, brief: job.brief, report }),
        options: { schema: REPORT_SCHEMA, maxTokens: 700, temperature: 0.3 }
      });
      const improvedPrompt = String(r.json?.improvedPrompt || '').trim();
      const nextPrompts = (r.json?.nextPrompts || []).map((x) => String(x).trim()).filter(Boolean).slice(0, 3);
      prompt = improvedPrompt && nextPrompts.length >= 2 ? { improvedPrompt: improvedPrompt.slice(0, 4000), nextPrompts } : fallbackPrompt({ request: job.request, brief: job.brief, report });
    } catch {
      if (run.ctrl.signal.aborted) return;
      prompt = fallbackPrompt({ request: job.request, brief: job.brief, report });
    }
    this.bus.emit('job.report', { report, ...prompt }, { jobId });
    this.chat('mel', `Report: ${report.files.length} files changed, ${report.checks.filter((c) => c.ok).length} of ${report.checks.length} checks passed${report.missing.length ? `, ${report.missing.length} things still missing` : ''}. The improved prompt is in the Report window.`, undefined, 'general', jobId);
  }

  /** The command `session.continue`: a new job that picks up where a past session ended. */
  continueSession(sessionId, request = '') {
    if (!this.memoryStore) throw Object.assign(new Error('memory is not available'), { code: 'conflict' });
    const rec = this.memoryStore.readSession(sessionId);
    if (!rec) throw Object.assign(new Error(`no session ${sessionId}`), { code: 'not_found' });
    const req = rec.find((r) => r.type === 'request')?.request || '';
    const report = [...rec].reverse().find((r) => r.type === 'report');
    const files = [...new Set(rec.filter((r) => r.type === 'files').flatMap((r) => r.files || []))];
    const next = String(request || '').trim() || 'Continue where we stopped: finish what is still missing.';
    const text = [
      `Continue the session ${sessionId}.`,
      report?.improvedPrompt ? `Last time the goal was:\n${report.improvedPrompt}` : `Last time the request was: ${req}`,
      files.length ? `Files from that session: ${files.join(', ')}.` : '',
      report?.report?.missing?.length ? `Still missing then: ${report.report.missing.join('; ')}` : '',
      `Now: ${next}`
    ].filter(Boolean).join('\n\n');
    return this.createJob({ request: text.slice(0, 4000) });
  }

  /** The command `playbook.save`: keep a finished job (and its improved prompt) as a playbook. */
  savePlaybook(jobId) {
    const job = this.state.jobs.find((j) => j.id === jobId);
    if (!job) throw Object.assign(new Error(`no job ${jobId}`), { code: 'not_found' });
    const tasks = job.taskIds.map((id) => this.state.tasks[id]).filter((t) => t && t.kind !== 'fix');
    if (!tasks.length) throw Object.assign(new Error('that job has no plan to save'), { code: 'conflict' });
    const index = new Map(tasks.map((t, i) => [t.id, i]));
    const playbook = this.playbooks.save({
      request: job.request,
      prompt: job.report?.improvedPrompt,
      tasks: tasks.map((t) => ({ title: t.title, detail: t.detail, assignee: t.assignee, kind: t.kind, dependsOn: (t.dependsOn || []).map((d) => index.get(d)).filter((d) => d !== undefined) }))
    });
    this.bus.emit('playbook.saved', { playbook }, { jobId });
    return { playbook };
  }

  /** Files changed in this job, most recent first. */
  _recentFiles(jobId) {
    const out = [];
    for (let i = this.bus.events.length - 1; i >= 0 && out.length < 8; i--) {
      const e = this.bus.events[i];
      if (e.jobId === jobId && e.type === 'file.changed' && !out.includes(e.data.path)) out.push(e.data.path);
    }
    return out;
  }

  // ---- task commands (PROTOCOL.md: task.retry, task.reassign, task.cancel) ----
  _taskAndJob(taskId) {
    const t = this.state.tasks[taskId];
    if (!t) throw Object.assign(new Error(`no task ${taskId}`), { code: 'not_found' });
    const job = this.state.jobs.find((j) => j.id === t.jobId);
    if (!job) throw Object.assign(new Error(`no job for task ${taskId}`), { code: 'not_found' });
    return { t, job };
  }

  /** Puts a failed, blocked, cancelled or done task back in line; reopens its job when the job already ended. */
  retryTask(taskId) {
    const { t, job } = this._taskAndJob(taskId);
    if (!['failed', 'blocked', 'skipped', 'done'].includes(t.status)) {
      throw Object.assign(new Error(`task ${taskId} is ${t.status}; only failed, blocked, cancelled or done tasks can be retried`), { code: 'conflict' });
    }
    if (job.status === 'cancelled' && !this.active.has(job.id)) throw Object.assign(new Error('the job was cancelled; start a new one'), { code: 'conflict' });
    const run = this.active.get(job.id) || this._reopen(job);
    const graph = run.graph;
    const reset = (id, note) => {
      graph.setStatus(id, 'pending');
      const ready = graph.get(id).dependsOn.every((d) => graph.get(d)?.status === 'done');
      this.bus.emit('task.status', { taskId: id, status: ready ? 'ready' : 'pending', note }, { jobId: job.id });
    };
    reset(taskId, 'retry');
    // Tasks that were blocked because of this one can run again.
    let again = true;
    while (again) {
      again = false;
      for (const n of graph.all()) {
        if (n.status === 'blocked' && n.dependsOn.every((d) => !['failed', 'blocked', 'skipped'].includes(graph.get(d)?.status))) {
          reset(n.id, 'unblocked by a retry');
          again = true;
        }
      }
    }
    run.kick?.();
    return {};
  }

  /** Gives a task that is not done to another worker. A running task restarts with the new worker. */
  reassignTask(taskId, workerId) {
    const { t, job } = this._taskAndJob(taskId);
    const worker = this.state.crew.find((w) => w.id === workerId);
    if (!worker || workerId === 'mel') throw Object.assign(new Error(`no worker ${workerId} who can take tasks`), { code: 'bad_request' });
    if (t.status === 'done') throw Object.assign(new Error('the task is already done; retry it instead'), { code: 'conflict' });
    const run = this.active.get(job.id);
    const node = run?.graph?.get(taskId);
    if (node) {
      node.assignee = workerId;
      const control = run.controls?.get(taskId);
      if (control) {
        control.why = 'reassigned';
        control.ctrl.abort();
        node.status = 'pending';
      }
    }
    this.bus.emit('task.updated', { task: { id: taskId, assignee: workerId } }, { jobId: job.id });
    if (['failed', 'blocked', 'skipped'].includes(node ? node.status : t.status)) return this.retryTask(taskId);
    if (node) {
      this.bus.emit('task.status', { taskId, status: 'pending', note: `reassigned to ${worker.name}` }, { jobId: job.id });
      run.kick?.();
    }
    return {};
  }

  /** Cancels one task; tasks that depend on it become blocked. */
  cancelTask(taskId) {
    const { t, job } = this._taskAndJob(taskId);
    if (['done', 'skipped'].includes(t.status)) throw Object.assign(new Error(`task ${taskId} is already ${t.status}`), { code: 'conflict' });
    const run = this.active.get(job.id);
    const node = run?.graph?.get(taskId);
    if (node) {
      node.status = 'skipped';
      const control = run.controls?.get(taskId);
      if (control) {
        control.why = 'cancelled';
        control.ctrl.abort();
      }
    }
    this.bus.emit('task.status', { taskId, status: 'skipped', note: 'cancelled by the user' }, { jobId: job.id });
    run?.kick?.();
    return {};
  }

  /** Rebuilds the graph of a finished job from the state and runs it again. */
  _reopen(job) {
    const graph = new TaskGraph();
    for (const id of job.taskIds) {
      const t = this.state.tasks[id];
      if (!t) continue;
      graph.add({ ...t, dependsOn: [...(t.dependsOn || [])], status: t.status === 'running' || t.status === 'review' ? 'pending' : t.status });
    }
    const ctrl = new AbortController();
    const run = { ctrl, notes: new Map(), promise: null, graph, controls: new Map(), kick: null };
    this.active.set(job.id, run);
    this.bus.emit('job.resumed', { by: 'user' }, { jobId: job.id });
    const st = {
      graph, tasks: null, preexisting: new Set(this.toolbox.ws.list().map((f) => f.path)),
      fixRounds: graph.all().filter((t) => t.kind === 'fix').length, nextIdx: job.taskIds.length + 1,
      qaPassed: !this.state.crew.some((w) => w.id === 'qa'), openIssues: [], playbook: null, score: 0
    };
    // Start after the caller has reset the task it wants to retry.
    run.promise = Promise.resolve().then(() => this._drive(job, run, st)).catch((err) => {
      if (ctrl.signal.aborted) return;
      this.bus.emit('job.failed', { error: String(err?.message || err) }, { jobId: job.id });
    }).finally(() => this.active.delete(job.id));
    return run;
  }

  async close() {
    for (const [, run] of this.active) run.ctrl.abort();
    await Promise.allSettled([...this.active.values()].map((r) => r.promise));
  }
}
