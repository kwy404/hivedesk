// The hive: request, planner, task graph, workers taking turns, tools, QA, done.
import path from 'node:path';
import { BUILTIN, BUILTIN_IDS, hireWorker } from './workers.js';
import { TaskGraph } from './taskgraph.js';
import { Memory } from './memory.js';
import { makePlan } from './planner.js';
import { runTask } from './worker.js';
import { checkWorkspace } from '../tools/check.js';
import { modelFamily } from './prompts/index.js';
import { runWithOrigin, crewOrigin } from '../core/origin.js';
import { BRIEF_SCHEMA, briefMessages, normalizeBrief, briefText, acceptanceFrom, answerBrief, isVague, REPORT_SCHEMA, reportMessages, buildReport, fallbackPrompt } from './brief.js';
import { say, localeOf, languageName } from './say.js';
import { INTENT_SCHEMA, keywordIntent, decideIntent, intentMessages, replyMessages, cleanReply, briefReply, isStatusQuestion, isRefusal, claimsWork } from './talk.js';
import { looksLikeGitIntent, parseRules } from '../github/intent.js';
import { validate, extractJson } from '../brain/schema.js';
import { startDomain, jobCrew } from './domains/flow.js';
import { tagLegacyChat } from './legacy.js';

const MAX_FIX_ROUNDS = 3;
/** The buttons under the line that says a brief is ready: use it, keep the original, open the Brief window to edit. */
const BRIEF_CHOICES = ['use', 'original', 'open'].map((id) => ({ id, key: `crew.talk.choice.${id}` }));
const shortRequest = (r) => { const s = String(r || ''); return s.length > 160 ? `${s.slice(0, 157)}...` : s; };
/** Mel stops a job that uses more model turns than this (a loop that does not converge). */
const JOB_TURN_BUDGET = 160;
let chatSeq = 0;

/**
 * For "a.html: links to style.css, which does not exist" when css/style.css is there: the exact
 * change, since a small model rewrites the same broken link round after round otherwise.
 */
export function linkHints(issues, files) {
  const out = [];
  for (const issue of issues) {
    const m = /^(.+?): links to (.+?), which does not exist/.exec(issue);
    if (!m) continue;
    const [, from, ref] = m;
    const name = path.posix.basename(ref.split(/[?#]/)[0]);
    const found = files.filter((f) => path.posix.basename(f) === name && f !== from);
    if (found.length !== 1) continue;
    const rel = path.posix.relative(path.posix.dirname(from), found[0]) || name;
    const hint = `In ${from}, change the link "${ref}" to "${rel}": that file exists.`;
    if (!out.includes(hint)) out.push(hint);
  }
  return out.length ? `\n\nHow to fix the links:\n- ${out.join('\n- ')}` : '';
}

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
    /** Hive City hooks (src/city/), optional: the worker a task runs with (room tools) and extra memories for its prompt. */
    this.adaptWorker = null;
    this.extraMemories = null;
    /** The language of the user's desktop (the last one a command carried): what the crew answers in. */
    this.lang = 'en';
    /** Chat messages waiting for "start as a task" or "just talk": message id -> what was asked. */
    this.choices = new Map();
    /** Talk turns in flight (chat answers and intent checks); their errors are handled, never thrown. */
    this.talks = new Set();
    this.classifyTimeoutMs = opts.classifyTimeoutMs ?? 90_000;
    this.answerTimeoutMs = opts.answerTimeoutMs ?? 240_000;
    /** Open clarifying question cards (src/crew/domains/questions.js): id -> { card, run, resolve }. */
    this.questions = new Map();
  }

  setLang(tag) {
    if (typeof tag === 'string' && tag.trim()) this.lang = localeOf(tag.trim());
    return this.lang;
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
    // Chat lines from before 1.0 have no i18n key: give them one, so they show in the desktop language.
    tagLegacyChat(this.state.chat);
    for (const j of this.state.jobs) {
      // A brief that waited for the user still waits: approving it starts the job again (_revive).
      if (j.status === 'planning' || j.status === 'running' || j.status === 'refining' || (j.status === 'awaiting_brief' && !j.briefProposed)) {
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

  chat(from, text, taskId, channel = 'general', jobId, extra) {
    const data = { id: `m_${Date.now().toString(36)}_${++chatSeq}`, channel, from, text };
    if (taskId) data.taskId = taskId;
    if (extra) Object.assign(data, extra);
    this.bus.emit('chat.message', data, jobId ? { jobId } : {});
    return data.id;
  }

  /**
   * A message from the crew in the user's language. The key and parameters travel with it, so the
   * desktop shows it in the language picked later too.
   * @param {{ lang?: string, taskId?: string, channel?: string, jobId?: string, choices?: any[], replyTo?: string }} [o]
   */
  say(from, key, params = {}, o = {}) {
    const lang = localeOf(o.lang || this.lang);
    const extra = { i18n: { key, params } };
    if (o.choices) extra.choices = o.choices;
    if (o.replyTo) extra.replyTo = o.replyTo;
    return this.chat(from, say(lang, key, params), o.taskId, o.channel || 'general', o.jobId, extra);
  }

  /** Mel and the crew narrate a job in the language it was asked in. */
  _jobSay(job, from, key, params, taskId, replyTo) {
    return this.say(from, key, params, { lang: job?.lang || 'en', taskId, jobId: job?.id, replyTo });
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
  /**
   * A message the user wrote in #general or a worker's direct chat. A build or change request starts
   * a job (with that worker as the lead in a direct chat), a question or small talk gets an answer
   * from the model, and when it is not clear the crew asks with two buttons.
   * @param {{ lang?: string, jobs?: boolean, owner?: boolean }} [opts] jobs: the sender may start jobs from the chat;
   *   owner: false for a guest or a peer (their text never goes into running jobs' notes)
   *   (the host's desktop says so; a Code together guest's message never carries it)
   */
  userChat(channel, text, opts = {}) {
    const ch = typeof channel === 'string' && (channel === 'general' || /^dm:[\w-]+$/.test(channel)) ? channel : 'general';
    const msg = String(text || '').trim().slice(0, 2000);
    if (!msg) throw Object.assign(new Error('empty message'), { code: 'bad_request' });
    if (opts.lang) this.setLang(opts.lang);
    const lang = this.lang;
    const id = this.chat('user', msg, undefined, ch);
    const target = ch.startsWith('dm:') ? ch.slice(3) : '*';
    const running = this._runningJobs().length > 0;
    // Only the owner's own chat reaches running jobs as notes; a guest's or a peer's text never becomes a user message there.
    if (this.active.size && opts.owner !== false) {
      for (const run of this.active.values()) {
        const list = run.notes.get(target) || [];
        list.push(msg);
        run.notes.set(target, list.slice(-5));
      }
    }
    const who = target === '*' ? 'mel' : target;
    if (!this.crewById().has(who)) return id;
    // GitHub and changelog requests get Mel's confirmation card from src/github/ instead.
    if ((ch === 'general' || ch === 'dm:mel') && looksLikeGitIntent(msg)) {
      const rules = parseRules(msg);
      if (rules.intent !== 'none' && rules.confidence >= 0.6) return id;
    }
    this._track(this._talk({ id, channel: ch, text: msg, who, lang, running, jobs: opts.jobs === true }));
    return id;
  }

  _track(p) {
    const q = p.catch(() => {}).finally(() => this.talks.delete(q));
    this.talks.add(q);
    return q;
  }

  /** Jobs the user started that are still going (city hops and their one task jobs are not counted). */
  _runningJobs() {
    return this.state.jobs.filter((j) => this.active.has(j.id) && !j.cityTaskId);
  }

  /** Is this worker busy with a task or with planning in a running job? */
  _inJob(workerId) {
    for (const run of this.active.values()) {
      // Mel is not busy while a brief waits for the user.
      if (!run.graph) { if (workerId === 'mel' && !run.briefWaiter) return true; continue; }
      if (run.graph.all().some((t) => t.status === 'running' && t.assignee === workerId)) return true;
    }
    return false;
  }

  /** One model turn for the chat, with a time limit; the worker goes back to idle after it. */
  async _chatTurn(workerId, messages, options, ms) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    timer.unref?.();
    try {
      return await this.scheduler.turn({ workerId, messages, options, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
      if (!this._inJob(workerId)) this.bus.emit('worker.status', { workerId, status: 'idle' });
    }
  }

  async _classify(text, who, lang) {
    const kw = keywordIntent(text, lang);
    let model = null;
    if (this.scheduler.hasBrain) {
      try {
        const r = await this._chatTurn(who, intentMessages(text, this.crewById().get(who)), { schema: INTENT_SCHEMA, maxTokens: 40, temperature: 0 }, this.classifyTimeoutMs);
        const json = r.json ?? extractJson(r.text);
        if (!validate(INTENT_SCHEMA, json).length) model = json;
      } catch { /* the keyword rules decide */ }
    }
    return { intent: decideIntent(model, kw), request: kw.request, model, keywords: kw };
  }

  async _talk({ id, channel, text, who, lang, running, jobs }) {
    // A brief waits for the user: "ok", "pode continuar" approve it, a change request edits it.
    const waiting = jobs ? this._briefWaiting() : null;
    const reply = waiting ? briefReply(text, lang) : null;
    if (reply) return this._briefFromChat(waiting, reply, { channel, who, lang, text, replyTo: id });
    // "cade a landingpage?": the status comes from the engine, never from the model.
    if (isStatusQuestion(text)) return this._status({ channel, who, lang, replyTo: id, jobs });
    const c = await this._classify(text, who, lang);
    this.bus.live('chat.intent', { messageId: id, channel, intent: c.intent, model: c.model?.intent || null, keywords: c.keywords.intent || null });
    if (c.intent === 'request') {
      if (!jobs) return this.say(who, 'crew.talk.hostOnly', {}, { lang, channel, replyTo: id });
      if (running) {
        // The running job already got the message as a note; a separate job is one click away.
        return this.say(who, 'crew.talk.noted', {}, { lang, channel, replyTo: id, choices: this._offer(id, { channel, text: c.request, who, lang, jobs }, ['task']) });
      }
      return this._startFromChat({ channel, who, lang, request: c.request, replyTo: id });
    }
    if (c.intent === 'ambiguous' && jobs) {
      return this.say(who, 'crew.talk.ambiguous', {}, { lang, channel, replyTo: id, choices: this._offer(id, { channel, text: c.request, who, lang, jobs }, ['task', 'chat']) });
    }
    return this._answer({ channel, who, lang, text, replyTo: id });
  }

  _offer(id, ask, ids) {
    this.choices.set(id, ask);
    while (this.choices.size > 50) this.choices.delete(this.choices.keys().next().value);
    return ids.map((c) => ({ id: c, key: `crew.talk.choice.${c}` }));
  }

  /** The command `chat.choose`: the user picked "start as a task" or "just talk" for a message. */
  chooseChat(messageId, choice, opts = {}) {
    const id = String(messageId || '');
    const ask = this.choices.get(id) || (id.startsWith('brief:') ? { kind: 'brief', jobId: id.slice(6), channel: 'general', who: 'mel' } : null);
    if (!ask) throw Object.assign(new Error('that choice is no longer open'), { code: 'conflict' });
    if (ask.kind === 'brief') {
      if (!['use', 'original'].includes(choice)) throw Object.assign(new Error('choice must be use or original'), { code: 'bad_request' });
      if (opts.lang) this.setLang(opts.lang);
      const job = this.state.jobs.find((j) => j.id === ask.jobId);
      if (!job || !this._briefWaiting() || this._briefWaiting().id !== job.id) throw Object.assign(new Error('that choice is no longer open'), { code: 'conflict' });
      this._briefFromChat(job, choice === 'use' ? 'approve' : 'original', { channel: ask.channel, who: ask.who, lang: opts.lang ? this.lang : ask.lang || job.lang || this.lang, replyTo: id });
      return { jobId: job.id };
    }
    if (!['task', 'chat'].includes(choice)) throw Object.assign(new Error('choice must be task or chat'), { code: 'bad_request' });
    if (opts.lang) this.setLang(opts.lang);
    this.choices.delete(messageId);
    this.bus.emit('chat.chosen', { messageId, channel: ask.channel, choice });
    const lang = opts.lang ? this.lang : ask.lang;
    if (choice === 'task') return this._startFromChat({ channel: ask.channel, who: ask.who, lang, request: ask.text, replyTo: messageId });
    this._track(this._answer({ channel: ask.channel, who: ask.who, lang, text: ask.text, replyTo: messageId }));
    return {};
  }

  /** Starts a job from the chat: the normal flow (brief, plan, crew), with the worker asked directly as the lead. */
  _startFromChat({ channel, who, lang, request, replyTo }) {
    const lead = channel.startsWith('dm:') && who !== 'mel' && who !== 'qa' ? who : undefined;
    // In #general Mel's first line about the job is the reply itself.
    const melHere = who === 'mel' && channel === 'general';
    let started;
    try {
      started = this.createJob({ request, lang, ...(lead ? { lead } : {}), ...(melHere ? { replyTo } : {}) });
    } catch (err) {
      this.say(who, 'crew.talk.startFailed', { error: String(err.message || err).slice(0, 200) }, { lang, channel, replyTo });
      return {};
    }
    const short = request.length > 160 ? `${request.slice(0, 157)}...` : request;
    if (melHere && !started.flow) return { jobId: started.jobId || null };
    const key = started.flow ? 'crew.talk.startedFlow' : lead ? 'crew.talk.startedLead' : who === 'mel' ? 'crew.talk.startedMel' : 'crew.talk.started';
    this.say(who, key, { request: short }, { lang, channel, replyTo, jobId: started.jobId || undefined });
    return { jobId: started.jobId || null };
  }

  /** A real answer from the model, as the worker who was asked, in the user's language. */
  async _answer({ channel, who, lang, text, replyTo }) {
    const worker = this.crewById().get(who) || this.crewById().get('mel');
    if (!this.scheduler.hasBrain) return this.say(who, 'crew.talk.noModel', {}, { lang, channel, replyTo });
    const s = this.state;
    const messages = replyMessages({
      worker, text, lang, crew: s.crew, files: this.toolbox.ws.list().map((f) => f.path),
      jobs: s.jobs, tasks: s.tasks, history: (s.chat[channel] || []).filter((m) => m.from !== 'system').slice(-7, -1)
    });
    try {
      const r = await this._chatTurn(who, messages, { maxTokens: 320, temperature: 0.5, talk: true }, this.answerTimeoutMs);
      const answer = cleanReply(r.text, worker);
      if (!answer) return this.say(who, 'crew.talk.empty', {}, { lang, channel, replyTo });
      // Never the generic "I am an AI and cannot create files", never a promise of work no job is doing:
      // the real status from the engine instead.
      if (isRefusal(answer) || claimsWork(answer)) return this._status({ channel, who, lang, replyTo });
      return this.chat(who, answer, undefined, channel, undefined, { replyTo });
    } catch (err) {
      return this.say(who, 'crew.talk.failed', { error: String(err.message || err).slice(0, 200) }, { lang, channel, replyTo });
    }
  }

  /** The job whose brief waits for the user (live, or left waiting when hivedesk stopped). */
  _briefWaiting() {
    for (let i = this.state.jobs.length - 1; i >= 0; i--) {
      const j = this.state.jobs[i];
      if (j.status !== 'awaiting_brief') continue;
      const run = this.active.get(j.id);
      if (run ? run.briefWaiter : j.briefProposed) return j;
    }
    return null;
  }

  /** The user answered a waiting brief in the chat (or with the buttons under Mel's line). */
  _briefFromChat(job, reply, { channel, who, lang, text, replyTo }) {
    const o = { lang, channel, replyTo, jobId: job.id };
    if (reply === 'cancel') {
      if (this.active.has(job.id)) this.cancelJob(job.id);
      else this.bus.emit('job.cancelled', { by: 'user' }, { jobId: job.id });
      this._closeBriefChoices(job.id, 'cancel');
      return this.say(who, 'crew.talk.brief.cancel', { request: shortRequest(job.request) }, o);
    }
    const use = reply === 'approve' ? 'refined' : reply === 'original' ? 'original' : 'edited';
    const proposed = this.state.jobs.find((j) => j.id === job.id)?.briefProposed;
    const edited = use === 'edited' ? { text: `${proposed?.text || job.request}

Change asked by the user: ${String(text || '').slice(0, 2000)}` } : {};
    // Mel says it first, then the job moves on.
    const said = this.say(who, `crew.talk.brief.${reply}`, { request: shortRequest(job.request) }, o);
    try {
      this.approveBrief(job.id, { use, ...edited });
    } catch (err) {
      return this.say(who, 'crew.talk.startFailed', { error: String(err.message || err).slice(0, 200) }, o);
    }
    return said;
  }

  /** Takes the brief buttons away from the chat once the brief is decided. */
  _closeBriefChoices(jobId, choice) {
    for (const [mid, ask] of [...this.choices]) {
      if (ask.kind !== 'brief' || ask.jobId !== jobId) continue;
      this.choices.delete(mid);
      this.bus.emit('chat.chosen', { messageId: mid, channel: ask.channel, choice });
    }
    const mid = `brief:${jobId}`;
    for (const [ch, list] of Object.entries(this.state.chat || {})) {
      if ((list || []).some((m) => m.replyTo === mid && m.choices && !m.chosen)) this.bus.emit('chat.chosen', { messageId: mid, channel: ch, choice });
    }
  }

  /** The job the user is most likely asking about: the one going on, else the last one. */
  _currentJob() {
    const jobs = this.state.jobs.filter((j) => !j.cityTaskId);
    for (let i = jobs.length - 1; i >= 0; i--) if (['refining', 'awaiting_brief', 'planning', 'running'].includes(jobs[i].status)) return jobs[i];
    return jobs[jobs.length - 1] || null;
  }

  /** "Where is the landing page?": what the job waits for, what is done and what is next, from the engine state. */
  _status({ channel, who, lang, replyTo, jobs = true }) {
    const job = this._currentJob();
    const o = { lang, channel, replyTo };
    if (!job) return this.say(who, 'crew.status.none', {}, o);
    o.jobId = job.id;
    const request = shortRequest(job.request);
    const files = this.toolbox.ws.list().map((f) => f.path);
    const fileList = files.length ? files.slice(0, 6).join(', ') + (files.length > 6 ? ` (+${files.length - 6})` : '') : say(lang, 'crew.status.noFiles');
    if (job.status === 'awaiting_brief') {
      if (jobs && this._briefWaiting()?.id === job.id) o.choices = this._offer(replyTo, { kind: 'brief', jobId: job.id, channel, who, lang }, ['use', 'original', 'open']);
      return this.say(who, 'crew.status.brief', { request }, o);
    }
    if (job.status === 'refining') return this.say(who, 'crew.status.refining', { request }, o);
    if (job.status === 'planning') return this.say(who, 'crew.status.planning', { request }, o);
    if (job.status === 'running') {
      const tasks = (job.taskIds || []).map((id) => this.state.tasks[id]).filter(Boolean);
      const done = tasks.filter((t) => t.status === 'done').length;
      const now = tasks.find((t) => t.status === 'running') || tasks.find((t) => t.status === 'pending');
      const name = now ? this.crewById().get(now.assignee)?.name || now.assignee : '';
      return this.say(who, 'crew.status.running', { request, done, count: tasks.length, now: now ? `${name}: ${now.title}` : '-', files: fileList }, o);
    }
    if (job.status === 'done') return this.say(who, 'crew.status.done', { request, files: fileList }, o);
    if (job.status === 'failed') return this.say(who, 'crew.status.failed', { request, error: String(job.error || '').slice(0, 200) }, o);
    return this.say(who, 'crew.status.cancelled', { request }, o);
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
    if (spec.lang) this.setLang(spec.lang);
    const lang = localeOf(spec.lang || this.lang);
    if (lang !== 'en') job.lang = lang;
    // A job asked for in a worker's direct chat: that worker leads it (Mel still plans it).
    const lead = typeof spec.lead === 'string' ? this.state.crew.find((w) => w.id === spec.lead && w.id !== 'mel') : null;
    if (lead) job.lead = lead.id;
    // A city hop (src/city/): one given task, no brief, no planner, no report.
    const plan = Array.isArray(spec.plan) && spec.plan.length ? spec.plan : null;
    if (plan) {
      job.refine = false;
      job.cityTaskId = String(spec.cityTaskId || '').slice(0, 40) || undefined;
      // A native 1.0 task run by the crew (src/tasks/crew-executor.js): its board task, so the job's steps join it.
      if (typeof spec.taskRef === 'string' && spec.taskRef) job.taskRef = spec.taskRef.slice(0, 120);
    }
    const ctrl = new AbortController();
    const run = { ctrl, notes: new Map(), promise: null, replyTo: typeof spec.replyTo === 'string' ? spec.replyTo : undefined };
    this.active.set(jobId, run);
    const created = this.bus.emit('job.created', { job }, { jobId });
    // Everything the job does from here is the crew's doing, caused by job.created (src/core/origin.js).
    this._launch(jobId, run, () => (plan ? this._runPlanned(job, run, plan) : this._runJob(job, run, spec.playbookId)), created.seq);
    return { jobId, done: run.promise };
  }

  /** Runs a job's work as the crew, failing the job on an error and putting busy workers back to idle. */
  _launch(jobId, run, fn, cause) {
    run.promise = runWithOrigin(crewOrigin('mel'), fn, cause).catch((err) => {
      if (run.ctrl.signal.aborted) return;
      this.bus.emit('job.failed', { error: String(err?.message || err) }, { jobId });
    }).finally(() => {
      this.active.delete(jobId);
      for (const w of this.state.crew) {
        if (this.state.workers[w.id]?.status && this.state.workers[w.id].status !== 'idle' && !this._busyElsewhere(w.id)) {
          this.bus.emit('worker.status', { workerId: w.id, status: 'idle' });
        }
      }
    });
  }

  /** A job whose brief waited when hivedesk stopped: the user's decision on it starts it again from the brief. */
  _revive(job, decision) {
    const copy = { ...job, refine: true, taskIds: [...(job.taskIds || [])] };
    const run = { ctrl: new AbortController(), notes: new Map(), promise: null, preDecision: decision };
    this.active.set(job.id, run);
    this._launch(job.id, run, () => this._runJob(copy, run));
    return run;
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
    this._jobSay(job || { id: jobId }, 'mel', 'crew.say.cancelled');
    return true;
  }

  async _runJob(job, run, playbookId) {
    const jobId = job.id;
    const signal = run.ctrl.signal;
    const ev = { jobId };
    run.budget = { turns: 0, max: JOB_TURN_BUDGET };
    if (!this.scheduler.hasBrain) this._jobSay(job, 'system', 'crew.say.noModel');
    // 0. The domain (src/crew/domains/flow.js): what kind of project, the questions that change the plan,
    // the specialist and the offline skeleton. A security audit finishes here, read only.
    const dom = await startDomain(this, job, run);
    if (signal.aborted || dom.done || dom.cancelled) return;
    // The crew chosen in the setup (settings.crew); hired workers and Mel always take part, and of the
    // domain specialists only the one this job needs.
    const crew = jobCrew(this.state, dom.specialist);
    const crewById = this.crewById();
    // 1. The prompt refiner: Mel turns the request into a brief, the user approves, edits or keeps the original.
    if (job.refine) {
      if (!run.preDecision) this._jobSay(job, 'mel', 'crew.say.onItBrief', { request: job.request }, undefined, run.replyTo);
      await this._refine(job, run);
      if (signal.aborted) return;
    } else {
      this._jobSay(job, 'mel', 'crew.say.onItPlan', { request: job.request }, undefined, run.replyTo);
    }
    const work = job.brief || job.request;
    // What we know: a few relevant memories (keyword and recency scoring), shown in the UI as "used".
    run.memories = [];
    if (this.memoryStore && this.state.settings.memory !== false) {
      const used = this.memoryStore.forJob(`${job.request} ${work}`, 6);
      run.memories = used.map((m) => m.text);
      if (used.length) this.bus.emit('memory.used', { items: used.map((m) => ({ id: m.id, text: m.text, kind: m.kind, scope: m.scope })) }, ev);
    }
    // A user who writes in another language gets a site in that language (small models default to English).
    if (job.lang && job.lang !== 'en') run.memories.push(`The user speaks ${languageName(job.lang)}: write every visible text in the files in ${languageName(job.lang)}, with <html lang="${job.lang}">.`);
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
      this._jobSay(job, 'mel', 'crew.say.playbook', { title: playbook.title });
    }
    const files = this.toolbox.ws.list().map((f) => f.path);
    const lead = job.lead ? crewById.get(job.lead) : null;
    const leadNote = lead ? [`The user asked ${lead.name} (${lead.role}) directly: ${lead.name} leads this job, so give the main work to ${lead.id}.`] : [];
    const plan = await makePlan({ scheduler: this.scheduler, request: work, crew, playbook, files, merge: modelFamily(this.state.brain) === 'small', notes: [...dom.notes, ...leadNote, ...run.memories.map((m) => `memory: ${m}`), ...this.memory.crew(4)], jobId, signal, domain: dom.domain });
    if (signal.aborted) return;
    // The plan came from a remote brain: every write and run of this job now needs the host (SEC-3).
    if (plan.remote && !this.toolbox.originOf?.({ jobId })) {
      this.toolbox.markOrigin?.(jobId, { kind: 'remote', brainId: plan.remote.brainId, label: plan.remote.label, ...(plan.remote.peerId ? { peerId: plan.remote.peerId } : {}) });
    }
    if (plan.error) this._jobSay(job, 'system', 'crew.say.plannerFallback', { error: plan.error, source: plan.source === 'playbook' ? 'playbook' : 'default' });
    // The lead (or the domain specialist) takes the first build task when the plan left them out (QA keeps checking).
    const owner = lead || (dom.specialist ? crew.find((w) => w.id === dom.specialist) : null);
    if (owner && crew.some((w) => w.id === owner.id) && !plan.tasks.some((t) => t.assignee === owner.id)) {
      const first = plan.tasks.find((t) => t.kind !== 'qa' && t.assignee !== 'qa');
      if (first) first.assignee = owner.id;
    }

    const jobNum = jobId.slice(2);
    const graph = new TaskGraph();
    const tasks = plan.tasks.map((t, i) => graph.add({
      id: `t_${jobNum}_${i + 1}`, jobId, title: t.title, detail: t.detail, assignee: t.assignee,
      dependsOn: t.dependsOn.map((d) => `t_${jobNum}_${d + 1}`), status: 'pending', attempts: 0, kind: t.kind
    }));
    this.bus.emit('job.planned', playbook ? { tasks: tasks.map((t) => ({ ...t })), playbookId: playbook.id } : { tasks: tasks.map((t) => ({ ...t })) }, ev);
    const lines = tasks.map((t, i) => `${i + 1}. ${crewById.get(t.assignee)?.name || t.assignee}: ${t.title}`);
    const planSummary = plan.source === 'fallback' ? say(job.lang, 'crew.say.planDefault') : plan.source === 'playbook' ? say(job.lang, 'crew.say.planPlaybook', { title: playbook?.title || '' }) : plan.summary;
    this._jobSay(job, 'mel', 'crew.say.plan', { summary: planSummary ? `${planSummary}\n` : '', lines: lines.join('\n') });
    await this._drive(job, run, {
      graph, tasks, preexisting: new Set(files.filter((f) => !dom.seeded.includes(f))), fixRounds: 0, nextIdx: tasks.length + 1,
      qaPassed: !crew.some((w) => w.id === 'qa'), openIssues: [], playbook, score
    });
  }

  /** A job with a given plan (a Hive City hop): the tasks run as they are, without the planner, QA rounds or the report. */
  async _runPlanned(job, run, plan) {
    const jobNum = job.id.slice(2);
    const graph = new TaskGraph();
    const known = this.crewById();
    const tasks = plan.slice(0, 8).map((t, i) => graph.add({
      id: `t_${jobNum}_${i + 1}`, jobId: job.id, title: String(t.title || 'Task').slice(0, 200), detail: String(t.detail || '').slice(0, 8000),
      assignee: known.has(t.assignee) ? t.assignee : 'dev', dependsOn: (t.dependsOn || []).map((d) => `t_${jobNum}_${d + 1}`), status: 'pending', attempts: 0,
      kind: ['build', 'fix', 'docs'].includes(t.kind) ? t.kind : 'build'
    }));
    run.memories = [];
    this.bus.emit('job.planned', { tasks: tasks.map((t) => ({ ...t })) }, { jobId: job.id });
    await this._drive(job, run, {
      graph, tasks: null, preexisting: new Set(this.toolbox.ws.list().map((f) => f.path)), fixRounds: MAX_FIX_ROUNDS, nextIdx: tasks.length + 1,
      qaPassed: true, openIssues: [], playbook: null, score: 0, quiet: true
    });
  }

  /** Adds a note for one worker of a running job, as if the user had written it (Hive City review notes). */
  addNote(jobId, workerId, text) {
    const run = this.active.get(jobId);
    if (!run) return false;
    const list = run.notes.get(workerId) || [];
    list.push(String(text).slice(0, 2000));
    run.notes.set(workerId, list.slice(-5));
    return true;
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
      const base = crewById.get(task.assignee) || crewById.get('dev');
      const worker = (this.adaptWorker && this.adaptWorker(base, task, job)) || base;
      graph.setStatus(task.id, 'running');
      this.bus.emit('task.status', { taskId: task.id, status: 'running' }, ev);
      const userNotes = () => [...(run.notes.get('*') || []), ...(run.notes.get(worker.id) || [])];
      let extra;
      let checks;
      if (task.kind === 'qa') {
        checks = checkWorkspace(this.toolbox.ws);
        // The checks of the playbooks picked for this job's tasks (src/crew/library/hook.js).
        if (this.playbookChecks) checks = this.playbookChecks(checks, graph.all());
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
      const p = runWithOrigin(crewOrigin(worker.id), () => runTask({
        job, task, worker, graph, crewById, scheduler: this.scheduler, toolbox: this.toolbox, memory: this.memory, bus: this.bus,
        signal: anySignal([signal, control.ctrl.signal]), maxTurns: this.maxTurns, extra, userNotes, preexisting: st.preexisting, budget: run.budget,
        family: modelFamily(this.state.brain), contextTokens: this.state.brain?.ctx || undefined,
        recent: () => this._recentFiles(jobId), memories: [...(run.memories || []), ...((this.extraMemories && this.extraMemories(worker.id, task)) || [])],
        verify: task.kind === 'qa' ? undefined : (wrote) => {
          // Fix tasks must clear every static issue; build tasks only the ones in their own files
          // (a link to a file another worker has not written yet is not their problem).
          if (task.kind !== 'fix' && !wrote.length) return [];
          const r = checkWorkspace(this.toolbox.ws, task.kind === 'fix' ? undefined : wrote);
          return r.issues.filter((i) => task.kind === 'fix' || !/ links to /.test(i));
        },
        chat: (from, text, taskId) => this.chat(from, text, taskId, 'general', jobId)
      })).then((res) => ({ task, worker, res, checks, control }), (err) => ({ task, worker, err, checks, control }));
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
        if (report.passed) this._jobSay(job, worker.id, 'crew.say.qaPassed', {}, task.id);
        else this._jobSay(job, worker.id, 'crew.say.qaIssues', { count: report.issues.length, issues: report.issues.join('\n- ') }, task.id);
        st.qaPassed = report.passed;
        st.openIssues = report.passed ? [] : report.issues;
        if (!report.passed && st.fixRounds < MAX_FIX_ROUNDS && this.crewById().has('dev')) {
          st.fixRounds++;
          const fix = graph.add({
            id: `t_${jobNum}_${st.nextIdx++}`, jobId, title: `Fix the QA issues (round ${st.fixRounds})`,
            detail: `QA found these problems. Read the files and fix each one:\n- ${report.issues.join('\n- ')}${linkHints(report.issues, this.toolbox.ws.list().map((f) => f.path))}`,
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
        if (res.status === 'done') this._jobSay(job, worker.id, 'crew.say.taskDone', { summary: res.summary }, task.id);
        else this._jobSay(job, worker.id, 'crew.say.taskFailed', { title: task.title, summary: res.summary }, task.id);
      }
      // Hand offs (PLAN.md section 10): a finished task makes the work of another worker ready. An event, not a guess.
      if (graph.get(task.id)?.status === 'done') {
        for (const next of graph.ready()) {
          if (!next.dependsOn.includes(task.id) || next.assignee === worker.id) continue;
          this.bus.emit('task.handoff', { taskId: next.id, from: worker.id, to: next.assignee, title: next.title, kind: next.kind, reason: `${task.title} is done` }, ev);
        }
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
      if (st.quiet) return;
      this._jobSay(job, 'mel', 'crew.say.jobFailed');
      await this._report(job, run);
      return;
    }
    const summary = failed.length
      ? `Finished with ${failed.length} failed tasks.`
      : st.qaPassed ? `Finished, and QA passed.${skipped ? ` ${skipped} tasks were cancelled.` : ''}` : `Finished, but QA still reports ${st.openIssues.length} issues.`;
    this.bus.emit('job.done', { summary, files: outFiles }, ev);
    if (st.quiet) return;
    const url = this.previewUrl();
    const said = failed.length ? say(job.lang, 'crew.say.sumFailed', { count: failed.length })
      : st.qaPassed ? say(job.lang, 'crew.say.sumPassed', { skipped }) : say(job.lang, 'crew.say.sumOpen', { count: st.openIssues.length });
    this._jobSay(job, 'mel', 'crew.say.finished', { summary: said, files: outFiles.join(', ') || say(job.lang, 'crew.say.none'), preview: url ? 'yes' : 'no' });
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
    let brief;
    let decision;
    if (run.preDecision && job.briefProposed) {
      // Revived after a restart: the brief was proposed before and the user just decided.
      brief = { ...job.briefProposed };
      decision = run.preDecision;
    } else {
      const r = await this._proposeBrief(job, run);
      if (!r) return;
      ({ brief, decision } = r);
    }
    if (!decision) return;
    if (decision.answers && decision.use !== 'original') brief = answerBrief(brief, decision.answers);
    let text = brief.text;
    let source = 'refined';
    if (decision.use === 'original') { text = job.request; source = 'original'; }
    else if (decision.use === 'edited' && typeof decision.text === 'string' && decision.text.trim()) { text = decision.text.trim().slice(0, 8000); source = 'edited'; }
    job.brief = source === 'original' ? null : text;
    job.acceptance = source === 'original' ? [] : acceptanceFrom(text);
    this.bus.emit('brief.approved', { brief: source === 'refined' ? brief : null, text, source, ...(decision.by ? { by: decision.by } : {}) }, ev);
    this._closeBriefChoices(jobId, decision.use === 'original' ? 'original' : 'use');
  }

  /** Mel writes the brief and waits for the user's decision (or the auto approve). null: no brief, the job goes on with the request. */
  async _proposeBrief(job, run) {
    const jobId = job.id;
    const ev = { jobId };
    this.bus.emit('job.refining', { workerId: 'mel' }, ev);
    let brief;
    try {
      const r = await this.scheduler.turn({
        workerId: 'mel', jobId, signal: run.ctrl.signal,
        messages: briefMessages(job.decisions ? `${job.request}

${job.decisions}` : job.request, this.toolbox.ws.list().map((f) => f.path)),
        options: { schema: BRIEF_SCHEMA, maxTokens: 900, temperature: 0.2 }
      });
      brief = normalizeBrief(r.json, job.request);
    } catch (err) {
      if (run.ctrl.signal.aborted) return null;
      this._jobSay(job, 'system', 'crew.say.briefFailed', { error: err.message });
      job.brief = null;
      this.bus.emit('brief.approved', { brief: null, text: job.request, source: 'original' }, ev);
      return null;
    }
    brief.text = briefText(brief);
    this.bus.emit('brief.proposed', { original: job.request, brief, vague: isVague(job.request) }, ev);
    // Mel waits for the user now, she is not thinking: the status says so.
    if (!this.scheduler.waiting.some((i) => i.workerId === 'mel')) this.bus.emit('worker.status', { workerId: 'mel', status: 'idle' });
    // The line carries the buttons, so the brief never waits unseen: use it, keep the request, open it to edit.
    this.say('mel', 'crew.say.briefReady', {}, { lang: job.lang || 'en', jobId, replyTo: `brief:${jobId}`, choices: BRIEF_CHOICES });
    const decision = await new Promise((resolve, reject) => {
      run.briefWaiter = resolve;
      if (this.autoApproveBriefMs) {
        const t = setTimeout(() => resolve({ use: 'refined', by: 'auto' }), this.autoApproveBriefMs);
        t.unref?.();
      }
      run.ctrl.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    }).catch(() => null);
    run.briefWaiter = null;
    return { brief, decision };
  }

  /** The command `brief.approve`. */
  approveBrief(jobId, { use = 'refined', text, answers } = {}) {
    if (!['refined', 'edited', 'original'].includes(use)) throw Object.assign(new Error('use must be refined, edited or original'), { code: 'bad_request' });
    const run = this.active.get(jobId);
    const job = this.state.jobs.find((j) => j.id === jobId);
    // A brief left waiting when hivedesk stopped: the decision starts the job again from it.
    if (!run && job?.status === 'awaiting_brief' && job.briefProposed) {
      this._revive(job, { use, text, answers, by: 'user' });
      return {};
    }
    if (!run || !run.briefWaiter) throw Object.assign(new Error('no brief is waiting for that job'), { code: 'conflict' });
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
        messages: reportMessages({ request: job.decisions ? `${job.request}

${job.decisions}` : job.request, brief: job.brief, report }),
        options: { schema: REPORT_SCHEMA, maxTokens: 700, temperature: 0.3 }
      });
      const improvedPrompt = String(r.json?.improvedPrompt || '').trim();
      const nextPrompts = (r.json?.nextPrompts || []).map((x) => String(x).trim()).filter(Boolean).slice(0, 3);
      // A small model sometimes describes a prompt instead of writing one: use the plain one then.
      const describes = /^(create|write|generate|design|craft|make)\b[^.]{0,60}\bprompt\b/i.test(improvedPrompt) || /\bthe prompt should\b/i.test(improvedPrompt);
      prompt = improvedPrompt && !describes && nextPrompts.length >= 2 ? { improvedPrompt: improvedPrompt.slice(0, 4000), nextPrompts } : fallbackPrompt({ request: job.request, brief: job.brief, report });
    } catch {
      if (run.ctrl.signal.aborted) return;
      prompt = fallbackPrompt({ request: job.request, brief: job.brief, report });
    }
    this.bus.emit('job.report', { report, ...prompt }, { jobId });
    this._jobSay(job, 'mel', 'crew.say.report', { files: report.files.length, passed: report.checks.filter((c) => c.ok).length, checks: report.checks.length, missing: report.missing.length });
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
    this.choices.clear();
  }
}
