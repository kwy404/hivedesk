// Hive City, engine side (CITY-PROTOCOL.md). The city is the state of the system:
//   machines are buildings, crew workers are persistent agents with levels and memory, rooms have
//   rules (tools, what they accept, approval), tasks travel a pipeline of rooms on a bus, every hop
//   is an event, and an agent can borrow another machine's GPU.
// It runs inside the host engine on the same event log, so the existing Code together relay
// (engine frames to every guest) replicates it, and a restart replays it.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_TOOLS } from '../tools/index.js';
import { guestOf, checkGuest } from '../collab/policy.js';
import { acceptanceFrom } from '../crew/brief.js';
import {
  CITY, ROOMS, ROOM_IDS, WORK_KINDS, SPECIALIZATION, MAX_LOOPS, DEFAULT_PIPELINE, PIPELINE_ROLES, roomForRole, levelFor, publicMemory, statusForKind, isCityEvent
} from './state.js';
import { CityStore } from './store.js';
import { pickAgent } from './router.js';
import { DESIGN_SCHEMA, REVIEW_SCHEMA, designMessages, reviewMessages, checkFiles, readReview, readDesign } from './hops.js';

export { CityStore } from './store.js';
export * from './state.js';

export class CityError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const fail = (code, message) => { throw new CityError(code, message); };
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const COLOR = /^#[0-9a-fA-F]{6}$/;
const TERMINAL = new Set(['done', 'blocked', 'cancelled']);
/** Tools a guest's task never gets: no shell, no deletes. */
export const GUEST_DENY = new Set(['run', 'delete_file']);
/** What a friend's contributed agent may use until the host grants more (SEC-2). */
export const READ_ONLY_TOOLS = Object.freeze(['list_files', 'read_file', 'check']);
/** Brains a guest can never link to its building (SEC-1): the host's own models. */
const HOST_BRAINS = new Set(['local', 'main', 'ollama', 'lmstudio', 'openai', 'cloud']);
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const STRINGS_FILE = path.join(HERE, '..', '..', 'i18n', 'parts', 'city.en.json');
export const LIMITS = Object.freeze({
  title: 200, detail: 4000, criteria: 6, criterion: 200, memoryText: 300, memoryEntries: 40, name: 40,
  guestCommands: 40, guestWindowMs: 10_000, presencePerSecond: 15, agentsPerMachine: 4, pipeline: 8,
  borrowTurns: 50, borrowMinutes: 60, borrowPendingMs: 60_000, tail: 5000, snapshotEvery: 200
});
const XP = { work: 10, review: 4, test: 3, clean: 5 };
const MEMORY_KINDS = new Set(['fact', 'preference', 'decision', 'task']);
const PROMPT_KINDS = new Set(['fact', 'preference', 'decision']);

export class City {
  /**
   * @param {{
   *   bus: import('../bus.js').EventBus, hive: import('../crew/engine.js').Hive, scheduler: import('../crew/scheduler.js').Scheduler,
   *   toolbox: import('../tools/index.js').ToolBox, home?: string | null, projectDir?: string | null, version?: string,
   *   store?: CityStore, now?: () => number
   * }} opts
   */
  constructor(opts) {
    this.bus = opts.bus;
    this.hive = opts.hive;
    this.scheduler = opts.scheduler;
    this.toolbox = opts.toolbox;
    this.version = opts.version || '0.0.0';
    this.now = opts.now || Date.now;
    this.store = opts.store || new CityStore({ home: opts.home ?? null, projectDir: opts.projectDir ?? null });
    this.machineId = this.store.machine().id;
    /** taskId -> { ctrl, agentId, room, jobId? } the hops the city runs itself */
    this.exec = new Map();
    /** agentId -> private memory entries (agents homed on this machine) */
    this.memories = new Map();
    /** jobId -> { taskId, mode: "hop" | "plan" } jobs the city started */
    this.jobOwners = new Map();
    /** crew taskId -> city taskId (planner tasks) */
    this.linkIndex = new Map();
    /** crew fix taskId -> city task ids that loop through it */
    this.fixFor = new Map();
    /** city task ids waiting in Test for the crew QA report */
    this.waitingQa = new Set();
    /** crew taskId -> Map(path -> diff) */
    this.crewFiles = new Map();
    /** borrowId -> { timer, prevPref, addedOnly, workerId, brainId } */
    this.borrowRt = new Map();
    this.guestRate = new Map();
    this.presenceRate = new Map();
    this.loads = new Map();
    this.queue = [];
    this.draining = false;
    this.routeQueued = false;
    this.saveTimers = new Map();
    /** brainId -> owner ("peer:<id>") of the guest whose lend bridge attached it (SEC-1). */
    this.brainOwners = new Map();
    /** brainId -> { tps, at } from the last turn.ended on it: the real tokens per second. */
    this.lastTps = new Map();
    /** This engine's PeerId when the p2p identity exists (Stream 2), else null. */
    this.peerId = opts.peerId || null;
    this.closed = false;
    this.started = false;
    this.cityEvents = 0;
    this.snapshot = null;
    this.onTaskDone = null;
  }

  get state() {
    return this.bus.state.city;
  }

  emit(type, data) {
    if (this.closed) return null;
    return this.bus.emit(type, data);
  }

  // ---------------------------------------------------------------- start
  start() {
    if (this.started) return this;
    this.started = true;
    const s = this.state;
    for (const t of Object.values(s.tasks)) {
      const m = /^ct_(\d+)$/.exec(t.id);
      if (m) this.taskSeq = Math.max(this.taskSeq || 0, Number(m[1]));
    }
    this.taskSeq = this.taskSeq || 0;
    this.emit('city.started', { city: CITY, host: this.machineId, version: this.version });
    this._hostMachine();
    for (const m of Object.values(s.machines)) {
      if (m.id !== this.machineId && m.online) this.emit('city.machine.left', { machineId: m.id, reason: 'restart' });
    }
    for (const r of ROOMS) if (!s.rooms[r.id]) this.emit('city.room.added', { room: { ...r } });
    // Agents: the crew of this project, with the levels and memories saved on this machine.
    for (const w of this.bus.state.crew) this._ensureAgent(w);
    for (const a of Object.values(s.agents)) {
      if (a.home === this.machineId && !a.retired && a.status !== 'sleeping' && a.status !== 'idle') this.emit('city.agent.status', { agentId: a.id, status: 'idle' });
    }
    for (const b of Object.values(s.borrows)) if (b.status !== 'ended') this.emit('city.borrow.ended', { borrowId: b.id, reason: 'stopped', used: b.used });
    // Unfinished work opens again in the same room and is claimed again.
    for (const t of Object.values(s.tasks)) {
      if (!['claimed', 'in_progress', 'in_review', 'in_test'].includes(t.status) && !(t.status === 'open' && t.link)) continue;
      const patch = { status: 'open', agentId: null, awaiting: t.awaiting || null };
      if (t.link) Object.assign(patch, { link: null, was: t.link });
      this._hop(t, t.room, patch, 'system', 'hivedesk restarted: the task opens again here');
    }
    this.snapshot = { seq: this.bus.seq, city: clone(this.state) };
    this.store.saveSnapshot(this.snapshot.seq, this.snapshot.city);
    this.off = this.bus.on((e) => this._enqueue(e));
    if (this.hive) {
      this.hive.adaptWorker = (worker, task, job) => this._adaptWorker(worker, task, job);
      this.hive.extraMemories = (workerId) => this._promptMemories(workerId);
    }
    this._kick();
    return this;
  }

  _hostMachine() {
    const s = this.state;
    const card = this.store.machine();
    const hw = this.bus.state.hardware;
    const brain = this.bus.state.brain;
    const local = this._localBrainId();
    const machine = {
      id: this.machineId, name: card.name || 'My PC', host: true, owner: 'host', online: true,
      gpu: hw?.gpu || null, ramBytes: hw?.ramBytes, cpus: hw?.cpus || os.cpus()?.length,
      model: brain?.model || undefined, brainId: local || null, via: 'local', ...(this.peerId ? { peerId: this.peerId } : {})
    };
    if (!s.machines[this.machineId]) this.emit('city.machine.joined', { machine: { ...machine, lending: { turns: 0, active: 0 }, agents: [] } });
    else this.emit('city.machine.updated', { machine });
  }

  /** The id of a brain on this machine (local or cloud), if one is attached. */
  _localBrainId() {
    const linked = new Set(Object.values(this.state.machines).filter((m) => !m.host && m.brainId).map((m) => m.brainId));
    for (const [id, slot] of this.scheduler.brains) if (slot.brain.kind !== 'remote' && !linked.has(id)) return id;
    return null;
  }

  _agentByWorker(workerId) {
    for (const a of Object.values(this.state.agents)) if (a.workerId === workerId && !a.retired) return a;
    return null;
  }

  _ensureAgent(w, extra = {}) {
    const existing = this._agentByWorker(w.id);
    if (existing) {
      if (!this.memories.has(existing.id) && existing.home === this.machineId) {
        const saved = this.store.loadAgent(existing.id);
        this.memories.set(existing.id, Array.isArray(saved?.memoryEntries) ? saved.memoryEntries : []);
        // A higher level saved on this machine (another project) wins: the agent is the same.
        if (saved && (saved.xp || 0) > (existing.xp || 0)) this.emit('city.agent.leveled', { agentId: existing.id, level: levelFor(saved.xp), xp: saved.xp });
        if (!saved) this._save(existing.id);
      }
      return existing;
    }
    const saved = this.store.loadAgent(w.id);
    const entries = Array.isArray(saved?.memoryEntries) ? saved.memoryEntries.slice(-LIMITS.memoryEntries) : [];
    this.memories.set(w.id, entries);
    const spec = cleanSpec(extra.specialization) || cleanSpec(saved?.specialization) || SPECIALIZATION[w.id] || [roomForRole(w.role)];
    const xp = Math.max(0, Number(saved?.xp) || 0);
    const agent = {
      id: w.id, workerId: w.id, name: w.name, role: w.role, avatar: w.avatar, color: w.color,
      specialization: spec, level: levelFor(xp), xp,
      tools: [...(w.tools || [])], permissions: perms(w.tools || []),
      memory: publicMemory(entries), room: spec[0], taskId: null, status: w.paused ? 'sleeping' : 'idle',
      brain: { kind: 'local', machineId: this.machineId }, home: this.machineId, builtin: !!w.builtin, retired: false,
      stats: { done: 0, reviews: 0, tests: 0, loops: 0, ...(saved?.stats || {}) }
    };
    this.emit('city.agent.joined', { agent });
    this._save(agent.id);
    return agent;
  }

  // ---------------------------------------------------------------- persistence
  _save(agentId) {
    const a = this.state.agents[agentId];
    if (!a || a.home !== this.machineId) return;
    clearTimeout(this.saveTimers.get(agentId));
    const t = setTimeout(() => { this.saveTimers.delete(agentId); this._saveNow(agentId); }, 300);
    t.unref?.();
    this.saveTimers.set(agentId, t);
  }

  _saveNow(agentId) {
    const a = this.state.agents[agentId];
    if (!a || a.home !== this.machineId) return;
    const { taskId, status, room, ...keep } = a;
    this.store.saveAgent({ ...keep, memoryEntries: this.memories.get(agentId) || [] });
  }

  _snapshotMaybe(force = false) {
    if (!force && this.cityEvents < LIMITS.snapshotEvery) return;
    this.cityEvents = 0;
    this.snapshot = { seq: this.bus.seq, city: clone(this.state) };
    this.store.saveSnapshot(this.snapshot.seq, this.snapshot.city);
  }

  // ---------------------------------------------------------------- reactions to events
  _enqueue(e) {
    if (this.closed) return;
    this.queue.push(e);
    if (this.draining) return;
    this.draining = true;
    queueMicrotask(() => this._drain());
  }

  _drain() {
    while (this.queue.length && !this.closed) {
      const e = this.queue.shift();
      try { this._react(e); } catch { /* a reaction must never break the log */ }
    }
    this.draining = false;
  }

  _react(e) {
    const d = e.data || {};
    if (isCityEvent(e) && e.type.startsWith('city.')) {
      this.cityEvents++;
      const id = d.agent?.id || d.agentId;
      if (id && ['city.agent.joined', 'city.agent.updated', 'city.agent.leveled', 'city.agent.memory', 'city.agent.retired'].includes(e.type)) this._save(id);
      if (['city.task.done', 'city.task.blocked', 'city.task.cancelled'].includes(e.type)) this._childFinished(d.taskId);
      if (e.type === 'city.task.done') this.onTaskDone?.(d.taskId);
      this._snapshotMaybe();
      this._kick();
      return;
    }
    switch (e.type) {
      case 'crew.hired': if (!this._agentByWorker(d.worker?.id)) this._ensureAgent(d.worker); break;
      case 'crew.updated': this._crewUpdated(d.worker); break;
      case 'crew.fired': {
        const a = this._agentByWorker(d.workerId);
        if (a) this.emit('city.agent.retired', { agentId: a.id });
        break;
      }
      case 'hardware.detected':
        this.emit('city.machine.updated', { machine: { id: this.machineId, gpu: d.gpu || null, ramBytes: d.ramBytes, cpus: d.cpus } });
        break;
      case 'brain.status':
        if (d.state === 'ready' && d.model && this.state.machines[this.machineId]?.model !== d.model) this.emit('city.machine.updated', { machine: { id: this.machineId, model: d.model } });
        break;
      case 'brain.attached': {
        if (d.kind === 'remote') break;
        if (Object.values(this.state.machines).some((m) => m.brainId === d.brainId)) break;
        const host = this.state.machines[this.machineId];
        if (host && (!host.brainId || !this.scheduler.brains.has(host.brainId))) this.emit('city.machine.updated', { machine: { id: this.machineId, brainId: d.brainId } });
        break;
      }
      case 'brain.detached': this._brainGone(d.brainId); break;
      case 'job.planned': this._jobPlanned(e); break;
      case 'task.added': this._taskAdded(e); break;
      case 'task.status': this._crewStatus(e); break;
      case 'qa.report': this._qaReport(e); break;
      case 'file.changed': {
        if (!d.taskId) break;
        const map = this.crewFiles.get(d.taskId) || new Map();
        map.set(d.path, d.diff || '');
        this.crewFiles.set(d.taskId, map);
        break;
      }
      case 'job.done':
      case 'job.failed':
      case 'job.cancelled': this._jobEnded(e); break;
      case 'turn.ended':
        if (!d.error && d.brainId && d.tps > 0) this.lastTps.set(d.brainId, { tps: d.tps, at: this.now() });
        this._borrowTurn(d);
        break;
      case 'queue.updated': this._loads(d); break;
      case 'worker.status': if (d.status === 'idle') this._kick(); break;
    }
  }

  _crewUpdated(w) {
    if (!w) return;
    const a = this._agentByWorker(w.id);
    if (!a) return;
    const patch = { id: a.id };
    for (const k of ['name', 'role', 'avatar', 'color']) if (w[k] && w[k] !== a[k]) patch[k] = w[k];
    if (Array.isArray(w.tools) && w.tools.join() !== (a.tools || []).join()) Object.assign(patch, { tools: [...w.tools], permissions: perms(w.tools) });
    if (Object.keys(patch).length > 1) this.emit('city.agent.updated', { agent: patch });
    if (typeof w.paused === 'boolean') {
      const want = w.paused ? 'sleeping' : 'idle';
      if ((w.paused && a.status !== 'sleeping') || (!w.paused && a.status === 'sleeping')) this.emit('city.agent.status', { agentId: a.id, status: want });
    }
  }

  // ---------------------------------------------------------------- hive hooks
  _cityTaskFor(job, task) {
    if (job?.cityTaskId) return this.state.tasks[job.cityTaskId] || null;
    const id = this.linkIndex.get(task?.id) || this.fixFor.get(task?.id)?.[0];
    return id ? this.state.tasks[id] || null : null;
  }

  /** A task runs with the tools of its room, and a guest's task never gets a shell. */
  _adaptWorker(worker, task, job) {
    const ct = this._cityTaskFor(job, task);
    if (!ct) return worker;
    const room = this.state.rooms[this.fixFor.has(task?.id) ? 'code' : ct.room];
    let tools = room && room.tools?.length ? worker.tools.filter((t) => room.tools.includes(t)) : [...worker.tools];
    if (ct.guest) tools = tools.filter((t) => !GUEST_DENY.has(t));
    const origin = this._originFor(worker, ct);
    if (tools.length === worker.tools.length && !origin) return worker;
    return { ...worker, tools, ...(origin ? { origin } : {}) };
  }

  /** A guest's task, or an agent a guest brought: its writes always wait for the host. */
  _originFor(worker, ct) {
    const a = this._agentByWorker(worker?.id);
    const m = a && a.home !== this.machineId ? this.state.machines[a.home] : null;
    if (m) return { kind: 'guest', id: String(m.owner || '').replace(/^peer:/, ''), label: m.name || 'a guest' };
    if (ct?.guest) return { kind: 'guest', id: ct.createdBy?.id, label: ct.createdBy?.name || 'a guest' };
    return null;
  }

  /** What an agent remembers goes into its prompts: pinned entries and facts, preferences, decisions. */
  _promptMemories(workerId) {
    const a = this._agentByWorker(workerId);
    if (!a) return [];
    const list = (this.memories.get(a.id) || []).filter((m) => m.pinned || PROMPT_KINDS.has(m.kind));
    return list.slice(-4).map((m) => `${a.name} remembers: ${m.text}`);
  }

  // ---------------------------------------------------------------- tasks: creation and hops
  _newTaskId() {
    this.taskSeq = (this.taskSeq || 0) + 1;
    while (this.state.tasks[`ct_${this.taskSeq}`]) this.taskSeq++;
    return `ct_${this.taskSeq}`;
  }

  _createTask(fields) {
    const now = new Date(this.now()).toISOString();
    const task = {
      id: this._newTaskId(), title: fields.title, detail: fields.detail || '', criteria: fields.criteria || [],
      pipeline: fields.pipeline, stage: 0, room: fields.pipeline[0], status: fields.status || 'open',
      agentId: null, loops: 0, maxLoops: MAX_LOOPS, awaiting: null, issues: [], files: fields.files || [], verdicts: [],
      createdBy: fields.createdBy, guest: !!fields.guest, createdAt: now, updatedAt: now
    };
    if (fields.wantAgent) task.wantAgent = fields.wantAgent;
    if (fields.link) task.link = fields.link;
    if (fields.parent) task.parent = fields.parent;
    this.emit('city.task.created', { task });
    return this.state.tasks[task.id];
  }

  _hop(t, to, patch, by, reason) {
    const hop = { id: `h_${this.bus.seq + 1}`, taskId: t.id, from: t.room || null, to, agentId: patch.agentId ?? null, by, reason: String(reason || '').slice(0, 300), loop: patch.loops ?? t.loops ?? 0, ts: new Date(this.now()).toISOString() };
    this.emit('city.task.hop', { hop, task: { id: t.id, room: to, ...patch } });
  }

  _claim(t, agent, bid, by = 'agent') {
    const roomId = t.pipeline[t.stage];
    this.emit('city.task.claimed', bid ? { taskId: t.id, agentId: agent.id, room: roomId, bid } : { taskId: t.id, agentId: agent.id, room: roomId });
    if (agent.room !== roomId) this.emit('city.agent.moved', { agentId: agent.id, from: agent.room, to: roomId, taskId: t.id });
    if (by !== 'crew') this._startHop(t.id);
  }

  _busy(agentId) {
    const a = this.state.agents[agentId];
    if (!a) return true;
    if (a.taskId && !TERMINAL.has(this.state.tasks[a.taskId]?.status)) return true;
    for (const x of this.exec.values()) if (x.agentId === agentId) return true;
    return false;
  }

  /** An agent can think when its home machine has a brain (a friend's agent needs its machine's brain). */
  _canThink(a) {
    const m = this.state.machines[a.home];
    if (!m || !m.online) return false;
    if (m.id === this.machineId) return true;
    return !!(m.brainId && this.scheduler.brains.has(m.brainId));
  }

  _kick() {
    if (this.routeQueued || this.closed) return;
    this.routeQueued = true;
    queueMicrotask(() => {
      this.routeQueued = false;
      if (!this.closed) this._route();
    });
  }

  _route() {
    const open = Object.values(this.state.tasks).filter((t) => t.status === 'open' && !t.link && !t.awaiting && t.stage < t.pipeline.length)
      .sort((a, b) => taskNum(a.id) - taskNum(b.id));
    for (const t of open) {
      const room = this.state.rooms[t.pipeline[t.stage]];
      if (!room) continue;
      const pick = pickAgent(this.state, t, { busy: (id) => this._busy(id), load: (m) => this.loads.get(m) || 0, canThink: (a) => this._canThink(a) });
      if (pick) this._claim(this.state.tasks[t.id], pick.agent, pick.bid);
    }
  }

  _startHop(taskId) {
    const t = this.state.tasks[taskId];
    if (!t || this.closed) return;
    const roomId = t.pipeline[t.stage];
    const room = this.state.rooms[roomId];
    const agent = this.state.agents[t.agentId];
    if (!room || !agent) return;
    this.emit('city.task.updated', { task: { id: t.id, status: statusForKind(room.kind) } });
    const status = room.kind === 'review' ? 'reviewing' : room.kind === 'test' ? 'testing' : room.kind === 'board' ? 'thinking' : 'working';
    this.emit('city.agent.status', { agentId: agent.id, status });
    const ctrl = new AbortController();
    const x = { ctrl, agentId: agent.id, room: roomId };
    this.exec.set(t.id, x);
    let run;
    if (room.kind === 'board') run = this._plan(t, agent, ctrl, x);
    else if (room.kind === 'review') run = this._review(t, agent, room, ctrl);
    else if (room.kind === 'test') run = this._test(t, agent, ctrl);
    else if (roomId === 'design' || room.executor === 'design') run = this._design(t, agent, ctrl);
    else run = this._work(t, agent, room, ctrl, x);
    Promise.resolve(run).then((res) => this._afterHop(t.id, roomId, agent.id, res, ctrl), (err) => this._afterHop(t.id, roomId, agent.id, { passed: false, issues: [String(err?.message || err).slice(0, 300)], by: 'agent' }, ctrl));
  }

  _afterHop(taskId, roomId, agentId, res, ctrl) {
    if (this.exec.get(taskId)?.ctrl === ctrl) this.exec.delete(taskId);
    if (this.closed || ctrl.signal.aborted) return;
    const t = this.state.tasks[taskId];
    if (!t || TERMINAL.has(t.status) || t.pipeline[t.stage] !== roomId) return;
    const room = this.state.rooms[roomId] || { kind: 'work' };
    const agent = this.state.agents[agentId];
    if (res.waitChildren) {
      this.emit('city.task.updated', { task: { id: t.id, status: 'in_progress', agentId: null } });
      this._agentHome(agent);
      return this._childFinished(null, t.id);
    }
    if (room.kind === 'review' || room.kind === 'test') {
      this.emit('city.task.verdict', { taskId, room: roomId, agentId, passed: !!res.passed, issues: res.issues || [], by: res.by || 'agent' });
      this._xp(agentId, room.kind === 'review' ? XP.review : XP.test, room.kind === 'review' ? 'reviews' : 'tests');
    } else if (res.passed && room.kind !== 'board') {
      const patch = { id: taskId, author: agentId };
      if (res.files) patch.files = [...new Set([...(t.files || []), ...res.files])];
      if (res.spec) patch.spec = res.spec;
      if (res.criteria) patch.criteria = res.criteria;
      this.emit('city.task.updated', { task: patch });
      this._xp(agentId, XP.work, null);
    }
    this._agentHome(agent);
    if (room.requireApproval) {
      this.emit('city.task.updated', { task: { id: taskId, agentId: null, issues: res.passed ? [] : (res.issues || []) } });
      this.emit('city.task.awaiting', { taskId, room: roomId });
      return;
    }
    if (res.passed) this._advance(this.state.tasks[taskId], 'agent', `${agent?.name || 'The agent'} finished in ${room.name || roomId}`);
    else this._loop(this.state.tasks[taskId], res.issues || [], 'agent');
  }

  _agentHome(agent) {
    if (!agent || this.state.agents[agent.id]?.retired) return;
    const a = this.state.agents[agent.id];
    if (a.status !== 'sleeping' && a.status !== 'offline') this.emit('city.agent.status', { agentId: a.id, status: 'idle' });
    const home = a.specialization?.[0];
    if (home && a.room !== home && !this._busy(a.id)) this.emit('city.agent.moved', { agentId: a.id, from: a.room, to: home });
  }

  _advance(t, by, reason) {
    if (!t || TERMINAL.has(t.status)) return;
    const next = t.stage + 1;
    if (next >= t.pipeline.length) return this._done(t, by);
    this._hop(t, t.pipeline[next], { stage: next, status: 'open', agentId: null, wantAgent: null, awaiting: null }, by, reason);
    this._kick();
  }

  _done(t, by) {
    if (t.author && t.loops === 0) this._xp(t.author, XP.clean, null);
    if (t.author) {
      this._statInc(t.author, 'done');
      this._remember(t.author, 'task', `Finished "${t.title}"${t.files?.length ? ` (${t.files.slice(0, 4).join(', ')})` : ''}${t.loops ? ` after ${t.loops} loop${t.loops > 1 ? 's' : ''}` : ''}.`);
    }
    this.emit('city.task.done', { taskId: t.id, by });
  }

  _blocked(t, reason) {
    if (!t || TERMINAL.has(t.status)) return;
    this.emit('city.task.blocked', { taskId: t.id, reason: String(reason).slice(0, 300) });
  }

  _loop(t, issues, by) {
    if (!t || TERMINAL.has(t.status)) return;
    const loops = (t.loops || 0) + 1;
    if (t.author) this._statInc(t.author, 'loops');
    if (loops > (t.maxLoops ?? MAX_LOOPS)) return this._blocked(t, `still failing after ${t.maxLoops ?? MAX_LOOPS} loops: ${issues[0] || 'no detail'}`);
    let idx = t.stage;
    for (let i = t.stage; i >= 0; i--) {
      const r = this.state.rooms[t.pipeline[i]];
      if (r && (WORK_KINDS.has(r.kind) || r.id === 'design')) { idx = i; break; }
    }
    const author = t.author && this.state.agents[t.author] && !this.state.agents[t.author].retired ? t.author : null;
    this._hop(t, t.pipeline[idx], { stage: idx, status: 'open', agentId: null, wantAgent: author, loops, issues: issues.slice(0, 12), awaiting: null }, by, `changes requested: ${issues[0] || 'see the issues'}`);
    this._kick();
  }

  _xp(agentId, amount, stat) {
    const a = this.state.agents[agentId];
    if (!a || !amount) return;
    const xp = (a.xp || 0) + amount;
    this.emit('city.agent.leveled', { agentId, level: levelFor(xp), xp });
    if (stat) this._statInc(agentId, stat);
  }

  _statInc(agentId, stat) {
    const a = this.state.agents[agentId];
    if (!a) return;
    const stats = { done: 0, reviews: 0, tests: 0, loops: 0, ...(a.stats || {}) };
    stats[stat] = (stats[stat] || 0) + 1;
    this.emit('city.agent.updated', { agent: { id: agentId, stats } });
  }

  // ---------------------------------------------------------------- what happens in each room
  /** Lobby: Mel plans the task into crew tasks (they become this task's children). */
  async _plan(t, agent, ctrl, x) {
    const request = [t.title, t.detail].filter(Boolean).join('\n\n');
    const { jobId, done } = this.hive.createJob({ request, ...(t.guest ? { approval: true } : {}) });
    if (t.guest) this.toolbox.markOrigin?.(jobId, this._originFor(null, t));
    x.jobId = jobId;
    this.jobOwners.set(jobId, { taskId: t.id, mode: 'plan' });
    this.emit('city.task.updated', { task: { id: t.id, jobId } });
    ctrl.signal.addEventListener('abort', () => { try { this.hive.cancelJob(jobId); } catch { /* already over */ } }, { once: true });
    await done;
    const job = this.bus.state.jobs.find((j) => j.id === jobId);
    if (job?.status === 'done') return { passed: true, by: 'agent', waitChildren: true };
    return { passed: false, issues: [job?.error || `the job ended ${job?.status || 'without a result'}`], by: 'agent' };
  }

  /** Design: the agent writes a short spec and criteria for the builder (one model turn). */
  async _design(t, agent, ctrl) {
    const files = this.toolbox.ws.list().map((f) => f.path).slice(0, 60);
    const r = await this.scheduler.turn({ workerId: agent.workerId, taskId: t.id, messages: designMessages(agent, t, files), options: { schema: DESIGN_SCHEMA, maxTokens: 700, temperature: 0.3 }, signal: ctrl.signal });
    const d = readDesign(r.json ?? safeJson(r.text), t);
    return { passed: true, spec: d.spec, criteria: d.criteria, by: 'agent' };
  }

  /** Code, Library, Ops and extension work rooms: a crew job with one task for this agent. */
  async _work(t, agent, room, ctrl, x) {
    const kind = room.id === 'library' ? 'docs' : t.loops ? 'fix' : 'build';
    const detail = [
      t.detail,
      t.spec ? `Spec from Design:\n${t.spec}` : '',
      t.criteria?.length ? `Acceptance criteria:\n- ${t.criteria.join('\n- ')}` : '',
      t.issues?.length ? `Review or Test found these problems. Fix each one:\n- ${t.issues.join('\n- ')}` : ''
    ].filter(Boolean).join('\n\n');
    const approval = t.guest || room.requireApproval ? { approval: true } : {};
    const { jobId, done } = this.hive.createJob({ request: t.title, plan: [{ title: t.title, detail, assignee: agent.workerId, kind }], cityTaskId: t.id, ...approval });
    if (t.guest) this.toolbox.markOrigin?.(jobId, this._originFor(null, t));
    x.jobId = jobId;
    this.jobOwners.set(jobId, { taskId: t.id, mode: 'hop' });
    this.emit('city.task.updated', { task: { id: t.id, jobId } });
    ctrl.signal.addEventListener('abort', () => { try { this.hive.cancelJob(jobId); } catch { /* already over */ } }, { once: true });
    await done;
    const job = this.bus.state.jobs.find((j) => j.id === jobId);
    const crewTask = job ? this.bus.state.tasks[job.taskIds?.[0]] : null;
    const files = this._jobFiles(job);
    if (crewTask?.status === 'done') return { passed: true, files, by: 'agent' };
    return { passed: false, issues: [crewTask?.note || job?.error || 'the work did not finish'], files, by: 'agent' };
  }

  async _review(t, agent, room, ctrl) {
    const checks = checkFiles(this.toolbox.ws, t.files || [], { links: false });
    const mode = room.mode || 'auto';
    if (mode === 'checks' || (mode === 'auto' && t.link)) return { passed: checks.passed, issues: checks.issues, by: 'checks' };
    // A work hop before this review that changed nothing is not done (the user can still approve it).
    const worked = t.pipeline.slice(0, t.stage).some((r) => WORK_KINDS.has(this.state.rooms[r]?.kind) && r !== 'design');
    if (worked && !(t.files || []).length) return { passed: false, issues: ['Nothing changed: no file was written for this task.'], by: 'checks' };
    try {
      const r = await this.scheduler.turn({ workerId: agent.workerId, taskId: t.id, messages: reviewMessages(agent, t, this._diffs(t), checks), options: { schema: REVIEW_SCHEMA, maxTokens: 500, temperature: 0.2 }, signal: ctrl.signal });
      return { ...readReview(r.json ?? safeJson(r.text), checks), by: 'agent' };
    } catch (err) {
      if (ctrl.signal.aborted) throw err;
      return { passed: checks.passed, issues: checks.issues, by: 'checks' };
    }
  }

  /**
   * Test (QA): the project's own `npm test` when package.json has a real test script (approval
   * rules apply), the static checks otherwise. The run is always asked for, in any approval mode,
   * when a guest created the task, a friend's agent did its work or it changed package.json (SEC-3).
   */
  async _test(t, agent, ctrl) {
    const script = this._testScript();
    if (!script) {
      const checks = checkFiles(this.toolbox.ws, t.files || [], { links: true });
      // Plus the checks of the library playbooks that fit the task (src/crew/library/hook.js).
      const lib = this.hive?.playbookTestChecks ? this.hive.playbookTestChecks(t) : null;
      if (lib && !lib.passed) return { passed: false, issues: [...checks.issues, ...lib.issues].slice(0, 12), by: 'checks' };
      return { passed: checks.passed, issues: checks.issues, by: 'checks' };
    }
    const ask = !!(t.guest || (t.files || []).includes('package.json') || this._remoteWork(t));
    const workerId = agent?.workerId;
    if (ask) {
      // A guest's task or another machine's agent: only the host answers (strict, with the origin on the card).
      const origin = this._originFor(null, t) || this._remoteOrigin(t);
      const decision = await this.toolbox.approvals.request({
        taskId: t.id, workerId, tool: 'run', args: { command: 'npm test' },
        summary: `Run: npm test (the test script is: ${script.slice(0, 300)})`,
        ...(origin ? { strict: true, origin } : {})
      }, ctrl?.signal);
      if (!decision.approved) return { passed: false, issues: [`npm test was not allowed${decision.note ? `: ${decision.note}` : ''}`], by: 'qa' };
    }
    let callId = null;
    let finished = null;
    const off = this.bus.on((e) => {
      if (e.type === 'tool.called' && e.data?.tool === 'run' && e.data.taskId === t.id && e.data.workerId === workerId && !callId) callId = e.data.callId;
      else if (e.type === 'run.finished' && callId && e.data?.callId === callId) finished = e.data;
    });
    let out;
    try {
      out = await this.toolbox.execute('run', { command: 'npm test' }, { workerId, taskId: t.id, signal: ctrl?.signal, ...(ask ? { approval: false } : {}) });
    } finally { off(); }
    if (!out.ok) return { passed: false, issues: [String(out.error || 'npm test could not run').slice(0, 300)], by: 'qa' };
    if (!finished) return { passed: false, issues: ['npm test ended without an exit code'], by: 'qa' };
    if (finished.exitCode === 0 && !finished.timedOut) return { passed: true, issues: [], by: 'qa', tests: true };
    const tail = [finished.stderr || '', finished.stdout || ''].join('\n').split(/\r?\n/).map((x) => x.trim()).filter(Boolean).slice(-4);
    const head = finished.timedOut ? 'npm test timed out' : `npm test failed with exit code ${finished.exitCode}`;
    return { passed: false, issues: [head, ...tail.map((x) => x.slice(0, 200))], by: 'qa', tests: true };
  }

  /** The workspace's own test script, or null (no package.json, no script, or the npm default stub). */
  _testScript() {
    try {
      if (!this.toolbox.ws.exists('package.json')) return null;
      const pkg = JSON.parse(this.toolbox.ws.read('package.json'));
      const s = pkg?.scripts?.test;
      if (typeof s !== 'string' || !s.trim()) return null;
      if (/no test specified/.test(s)) return null;
      return s.trim();
    } catch { return null; }
  }

  /** True when an agent that is not homed on this machine did a work hop of this task. */
  /** The origin of the first agent from another machine that worked on this task, or null. */
  _remoteOrigin(t) {
    const authors = new Set([t.author, ...(t.verdicts || []).map((v) => v.agentId)].filter(Boolean));
    for (const id of authors) {
      const a = this.state.agents[id];
      if (a && a.home !== this.machineId) { const m = this.state.machines[a.home]; return { kind: 'guest', id: String(m?.owner || '').replace(/^peer:/, ''), label: m?.name || 'another machine' }; }
    }
    return null;
  }

  _remoteWork(t) {
    const authors = new Set([t.author, ...(t.verdicts || []).map((v) => v.agentId)].filter(Boolean));
    for (const id of authors) { const a = this.state.agents[id]; if (a && a.home !== this.machineId) return true; }
    return false;
  }

  _jobFiles(job) {
    const out = new Set();
    for (const id of job?.taskIds || []) for (const p of this.crewFiles.get(id)?.keys() || []) out.add(p);
    return [...out];
  }

  /** The diffs of a task's work, or the files as they are now when the diffs are gone (after a restart). */
  _diffs(t) {
    const out = new Map();
    const jobs = this.bus.state.jobs.filter((j) => j.cityTaskId === t.id || (t.link && j.id === t.link.jobId));
    for (const j of jobs) for (const id of j.taskIds || []) for (const [p, diff] of this.crewFiles.get(id) || []) out.set(p, diff);
    if (!out.size) {
      for (const p of t.files || []) {
        try { out.set(p, `(the file now)\n${this.toolbox.ws.read(p).slice(0, 3000)}`); } catch { /* deleted */ }
      }
    }
    return [...out].map(([path, diff]) => ({ path, diff }));
  }

  // ---------------------------------------------------------------- planner tasks (the crew runs the work hop)
  _jobPlanned(e) {
    const owner = this.jobOwners.get(e.jobId);
    if (owner?.mode === 'hop') return;
    const job = this.bus.state.jobs.find((j) => j.id === e.jobId);
    // A native 1.0 task run by the crew (src/tasks/crew-executor.js) already is the one task on the board.
    if (job?.taskRef) return;
    const criteria = acceptanceFrom(job?.brief?.text || '').slice(0, LIMITS.criteria);
    const parent = owner?.mode === 'plan' ? this.state.tasks[owner.taskId] : null;
    const kids = [];
    for (const ct of e.data.tasks || []) {
      const t = this._mirror(ct, e.jobId, criteria, parent);
      if (t) kids.push(t.id);
    }
    if (parent && kids.length) this.emit('city.task.updated', { task: { id: parent.id, children: [...(parent.children || []), ...kids] } });
  }

  _mirror(ct, jobId, criteria, parent) {
    if (!ct || ct.kind === 'qa' || ct.kind === 'fix' || this.linkIndex.has(ct.id)) return null;
    const work = ct.kind === 'docs' ? 'library' : ct.assignee === 'designer' ? 'design' : 'code';
    const pipeline = work === 'library' ? ['library', 'review', 'test'] : [work, 'review', 'test'];
    const t = this._createTask({
      title: String(ct.title || 'Task').slice(0, LIMITS.title), detail: String(ct.detail || '').slice(0, LIMITS.detail), criteria,
      pipeline, link: { jobId, taskId: ct.id }, createdBy: { kind: 'planner', id: 'mel', name: 'Mel' },
      guest: !!parent?.guest, parent: parent?.id
    });
    this.linkIndex.set(ct.id, t.id);
    return t;
  }

  _taskAdded(e) {
    const ct = e.data.task;
    if (!ct || this.jobOwners.get(e.jobId)?.mode === 'hop') return;
    if (ct.kind === 'fix') {
      // QA found issues: the waiting tasks whose files it names loop back to Code through this fix task.
      const waiting = [...this.waitingQa].map((id) => this.state.tasks[id]).filter((t) => t && t.link?.jobId === e.jobId && t.issues?.length);
      const text = ct.detail || '';
      let hit = waiting.filter((t) => (t.files || []).some((f) => text.includes(f)));
      if (!hit.length) hit = waiting;
      const agent = this._agentByWorker(ct.assignee);
      const ids = [];
      for (const t of hit) {
        this.waitingQa.delete(t.id);
        const loops = (t.loops || 0) + 1;
        if (loops > (t.maxLoops ?? MAX_LOOPS)) { this._blocked(t, `still failing after ${t.maxLoops ?? MAX_LOOPS} loops: ${t.issues[0]}`); continue; }
        if (t.author) this._statInc(t.author, 'loops');
        const idx = Math.max(0, t.pipeline.findIndex((r) => r === 'code' || r === 'design' || r === 'library'));
        this._hop(t, 'code', { stage: idx, status: 'in_progress', agentId: agent?.id || null, loops }, 'agent', `QA asked for a fix: ${t.issues[0]}`);
        if (t.pipeline[idx] !== 'code') this.emit('city.task.updated', { task: { id: t.id, pipeline: ['code', ...t.pipeline.slice(idx + 1)], stage: 0 } });
        if (agent && agent.room !== 'code') this.emit('city.agent.moved', { agentId: agent.id, from: agent.room, to: 'code', taskId: t.id });
        ids.push(t.id);
      }
      if (ids.length) this.fixFor.set(ct.id, ids);
      return;
    }
    if (ct.kind !== 'qa') {
      const job = this.bus.state.jobs.find((j) => j.id === e.jobId);
      if (job?.taskRef) return;
      const owner = this.jobOwners.get(e.jobId);
      this._mirror(ct, e.jobId, acceptanceFrom(job?.brief?.text || ''), owner?.mode === 'plan' ? this.state.tasks[owner.taskId] : null);
    }
  }

  _crewStatus(e) {
    const { taskId, status, note } = e.data;
    const owner = this.jobOwners.get(e.jobId);
    if (owner?.mode === 'hop') return;
    const crewTask = this.bus.state.tasks[taskId];
    const agent = crewTask ? this._agentByWorker(crewTask.assignee) : null;
    const fixes = this.fixFor.get(taskId);
    if (fixes) {
      for (const id of fixes) {
        const t = this.state.tasks[id];
        if (!t || TERMINAL.has(t.status)) continue;
        if (status === 'running' && agent && t.agentId !== agent.id) this.emit('city.task.claimed', { taskId: t.id, agentId: agent.id, room: 'code' });
        if (status === 'running') this.emit('city.task.updated', { task: { id: t.id, status: 'in_progress' } });
        if (status === 'done') this._linkedWorkDone(t, agent, taskId);
        if (status === 'failed') this._blocked(t, `the fix failed: ${note || 'no detail'}`);
      }
      if (status === 'done' || status === 'failed') this.fixFor.delete(taskId);
      return;
    }
    const id = this.linkIndex.get(taskId);
    const t = id ? this.state.tasks[id] : null;
    if (!t || !t.link || t.status === 'done' || t.status === 'cancelled') return;
    switch (status) {
      case 'running': {
        if (!agent) break;
        const room = t.pipeline[t.stage];
        if (t.agentId !== agent.id) this._claim(t, agent, null, 'crew');
        this.emit('city.task.updated', { task: { id: t.id, status: 'in_progress', room } });
        break;
      }
      case 'done': if (t.status !== 'in_review' && t.status !== 'in_test') this._linkedWorkDone(t, agent, taskId); break;
      case 'failed': this._blocked(t, note || 'the crew task failed'); break;
      case 'skipped': this.emit('city.task.cancelled', { taskId: t.id, by: note === 'cancelled by the user' ? 'user' : 'system' }); break;
      case 'blocked': this._blocked(t, note || 'a task it depends on failed'); break;
      case 'ready':
      case 'pending':
        // task.retry from the old UI: a blocked city task opens again at its work room.
        if (t.status === 'blocked' && note) {
          this.emit('city.task.updated', { task: { id: t.id, status: 'open', reason: null } });
          this._hop(t, t.pipeline[0], { stage: 0, status: 'open', agentId: null }, 'user', 'the crew task was retried');
        }
        break;
    }
  }

  /** The crew finished the work of a planner task: a reviewer checks the changed files, then it waits in Test. */
  _linkedWorkDone(t, agent, crewTaskId) {
    const files = [...new Set([...(t.files || []), ...(this.crewFiles.get(crewTaskId)?.keys() || [])])];
    if (agent) this._xp(agent.id, XP.work, null);
    this.emit('city.task.updated', { task: { id: t.id, files, ...(agent ? { author: agent.id } : {}) } });
    const reviewIdx = t.pipeline.indexOf('review');
    const testIdx = t.pipeline.indexOf('test');
    const job = this.bus.state.jobs.find((j) => j.id === t.link.jobId);
    if (reviewIdx !== -1) {
      const cur = this.state.tasks[t.id];
      const reviewTask = { ...cur, stage: reviewIdx };
      const pick = pickAgent(this.state, reviewTask, { busy: () => false, load: (m) => this.loads.get(m) || 0, canThink: (a) => this._canThink(a) });
      const reviewer = pick?.agent || null;
      this._hop(cur, 'review', { stage: reviewIdx, status: 'in_review', agentId: reviewer?.id || null }, 'agent', `${agent?.name || 'The crew'} finished the work`);
      const checks = checkFiles(this.toolbox.ws, files, { links: false });
      this.emit('city.task.verdict', { taskId: t.id, room: 'review', agentId: reviewer?.id || null, passed: checks.passed, issues: checks.issues, by: 'checks' });
      if (reviewer) this._xp(reviewer.id, XP.review, 'reviews');
      // A failed review goes to the crew QA as a note, so the QA report covers it.
      if (!checks.passed && job) this.hive.addNote(job.id, 'qa', `Review of "${t.title}" found:\n- ${checks.issues.join('\n- ')}`);
    }
    if (testIdx === -1) return this._done(this.state.tasks[t.id], 'agent');
    const cur = this.state.tasks[t.id];
    this._hop(cur, 'test', { stage: testIdx, status: 'in_test', agentId: null }, 'agent', 'the review is done');
    const qaPending = job && (job.taskIds || []).some((id) => {
      const x = this.bus.state.tasks[id];
      return x && x.kind === 'qa' && !['done', 'skipped', 'failed', 'blocked'].includes(x.status);
    });
    if (qaPending) { this.waitingQa.add(t.id); return; }
    this._linkedChecksTest(t.id);
  }

  _linkedChecksTest(id) {
    const t = this.state.tasks[id];
    if (!t || TERMINAL.has(t.status)) return;
    const checks = checkFiles(this.toolbox.ws, t.files || [], { links: true });
    const tester = this._agentByWorker('qa');
    this.emit('city.task.verdict', { taskId: t.id, room: 'test', agentId: tester?.id || null, passed: checks.passed, issues: checks.issues, by: 'checks' });
    if (checks.passed) this._done(this.state.tasks[t.id], 'agent');
    else this._blocked(t, `the checks still fail: ${checks.issues[0]}`);
  }

  _qaReport(e) {
    const qa = this.bus.state.tasks[e.data.taskId];
    const tester = qa ? this._agentByWorker(qa.assignee) : null;
    for (const id of [...this.waitingQa]) {
      const t = this.state.tasks[id];
      if (!t || t.link?.jobId !== e.jobId) continue;
      if (tester) this._xp(tester.id, XP.test, 'tests');
      this.emit('city.task.verdict', { taskId: id, room: 'test', agentId: tester?.id || null, passed: !!e.data.passed, issues: e.data.issues || [], by: 'qa' });
      if (e.data.passed) {
        this.waitingQa.delete(id);
        this._done(this.state.tasks[id], 'agent');
      }
    }
  }

  _jobEnded(e) {
    const owner = this.jobOwners.get(e.jobId);
    if (owner) this.jobOwners.delete(e.jobId);
    if (owner?.mode === 'hop') return; // the hop's own promise handles it
    for (const id of [...this.waitingQa]) {
      const t = this.state.tasks[id];
      if (!t || t.link?.jobId !== e.jobId) continue;
      this.waitingQa.delete(id);
      const last = [...(t.verdicts || [])].reverse().find((v) => v.room === 'test');
      if (last && !last.passed) this._blocked(t, `QA still reports issues: ${last.issues[0] || 'see the report'}`);
      else this._linkedChecksTest(id);
    }
    for (const t of Object.values(this.state.tasks)) {
      if (t.link?.jobId !== e.jobId || TERMINAL.has(t.status) || this.waitingQa.has(t.id)) continue;
      if (e.type === 'job.cancelled') this.emit('city.task.cancelled', { taskId: t.id, by: 'user' });
      else this._blocked(t, 'the job ended before this task finished');
    }
  }

  /** A Lobby task is done when every task Mel planned for it is finished. */
  _childFinished(childId, parentId) {
    const pid = parentId || (childId && this.state.tasks[childId]?.parent);
    const p = pid ? this.state.tasks[pid] : null;
    if (!p || TERMINAL.has(p.status) || this.exec.has(p.id)) return;
    if (p.pipeline[p.stage] !== 'lobby' || p.status !== 'in_progress') return;
    const kids = (p.children || []).map((id) => this.state.tasks[id]).filter(Boolean);
    if (kids.some((k) => !TERMINAL.has(k.status))) return;
    const bad = kids.filter((k) => k.status === 'blocked');
    if (bad.length) return this._blocked(p, `${bad.length} of its tasks are blocked`);
    this._advance(p, 'agent', 'every planned task is done');
  }

  _brainGone(brainId) {
    for (const m of Object.values(this.state.machines)) {
      if (m.brainId !== brainId) continue;
      const next = m.host ? this._localBrainId() : null;
      this.emit('city.machine.updated', { machine: { id: m.id, brainId: next } });
    }
    for (const b of Object.values(this.state.borrows)) if (b.status !== 'ended' && this.borrowRt.get(b.id)?.brainId === brainId) this._endBorrow(b.id, 'brain_gone');
  }

  /**
   * Model slots per machine: how many of its brains run a turn now. This is not CPU or GPU load
   * (the probes of the compute plane measure those); the UI shows it as "slots busy". tps is the
   * real tokens per second of the last turn that ended on one of its brains, 0 when none did.
   */
  _loads(q) {
    const busy = new Set((q.running || []).map((r) => r.brainId));
    for (const m of Object.values(this.state.machines)) {
      if (!m.online) continue;
      let ids;
      if (m.host) ids = [...this.scheduler.brains.entries()].filter(([id, slot]) => slot.brain.kind !== 'remote' && !Object.values(this.state.machines).some((x) => !x.host && x.brainId === id)).map(([id]) => id);
      else ids = m.brainId ? [m.brainId] : [];
      const used = ids.filter((id) => busy.has(id)).length;
      const load = ids.length ? used / ids.length : 0;
      let tps = 0;
      for (const id of ids) { const x = this.lastTps.get(id); if (x && x.tps > tps) tps = x.tps; }
      const key = `${used}/${ids.length}/${tps}`;
      if (this.loads.get(m.id) === load && this.loadKeys?.get(m.id) === key) continue;
      this.loads.set(m.id, load);
      (this.loadKeys ||= new Map()).set(m.id, key);
      this.bus.live('city.machine.load', { machineId: m.id, load, slots: { busy: used, total: ids.length }, queue: (q.waiting || []).length, tps });
    }
  }

  // ---------------------------------------------------------------- machines and friends' agents
  /**
   * A friend's building joins the city. owner: "peer:<guestId>" (or "host" for a machine of the host's own).
   * trusted: what the engine itself verified (the p2p adapter passes the session's peerId).
   */
  joinMachine(data, owner, trusted = {}) {
    const m = data?.machine || {};
    const id = str(m.id, 30);
    if (!/^m_[0-9a-z_]{1,26}$/.test(id)) fail('bad_request', 'machine.id must look like m_1a2b3c4d');
    if (id === this.machineId) fail('forbidden', 'that is the host machine');
    const old = this.state.machines[id];
    if (old && old.online && old.owner !== owner) fail('forbidden', 'another person is in the city with that machine');
    const brainId = this._guestBrain(data.brainId, owner);
    const machine = {
      id, name: str(m.name, LIMITS.name) || 'Friend', host: false, owner, online: true,
      gpu: m.gpu && typeof m.gpu === 'object' ? { name: str(m.gpu.name, 80) || undefined, vramBytes: num(m.gpu.vramBytes), backend: str(m.gpu.backend, 20) || undefined } : null,
      ramBytes: num(m.ramBytes), cpus: num(m.cpus), model: str(m.model, 120) || undefined,
      color: COLOR.test(m.color || '') ? m.color : undefined, brainId,
      via: ['words', 'qr', 'link', 'demo', 'invite', 'known'].includes(data.via) ? data.via : 'words', leftAt: null,
      reported: true,
      // the PeerId comes only from a verified p2p session (src/city/membership.js), never from the data
      ...(typeof trusted.peerId === 'string' ? { peerId: trusted.peerId.slice(0, 64) } : {})
    };
    this.emit('city.machine.joined', { machine: { lending: old?.lending || { turns: 0, active: 0 }, agents: old?.agents || [], ...machine } });
    if (brainId) this._restrictBrain(brainId, id);
    const ids = [];
    for (const a of (Array.isArray(data.agents) ? data.agents : []).slice(0, LIMITS.agentsPerMachine)) {
      const agent = this._contribute(id, a);
      if (agent) ids.push(agent.id);
    }
    // Friends' agents that came before and did not come back this time stay offline.
    this._kick();
    return { machineId: id, agents: ids };
  }

  /** Records that a guest's own lend bridge attached this brain (only then may it link it, SEC-1). */
  noteBrainOwner(brainId, owner) {
    if (typeof brainId === 'string' && typeof owner === 'string' && owner !== 'host') this.brainOwners.set(brainId, owner);
  }

  /** A brain id a guest may link to its building: a remote brain its own bridge attached, nothing else. */
  _guestBrain(brainId, owner) {
    if (typeof brainId !== 'string' || !brainId) return null;
    if (HOST_BRAINS.has(brainId)) return null;
    const slot = this.scheduler.brains.get(brainId);
    if (!slot || slot.brain.kind !== 'remote') return null;
    // The owner is recorded by the p2p membership (noteBrainOwner) or by the 0.2.1 lend bridge (brain.owner on brain.attach).
    if (this.brainOwners.get(brainId) !== owner && slot.brain.owner !== owner) return null;
    return brainId;
  }

  /** A friend's brain inside the city serves only that friend's agents and the borrows its owner accepts. */
  _restrictBrain(brainId, machineId) {
    const slot = this.scheduler.brains.get(brainId);
    if (!slot) return;
    const only = new Set();
    for (const a of Object.values(this.state.agents)) if (a.home === machineId && !a.retired) only.add(a.workerId);
    for (const [bid, rt] of this.borrowRt) if (rt.brainId === brainId && this.state.borrows[bid]?.status === 'active') only.add(rt.workerId);
    slot.brain.only = only;
  }

  _contribute(machineId, a) {
    if (!a || typeof a !== 'object') return null;
    const local = str(a.id, 40).replace(/[^A-Za-z0-9_-]/g, '_');
    const name = str(a.name, LIMITS.name);
    if (!local || !name) return null;
    const id = `${machineId}:${local}`;
    const role = str(a.role, 64) || 'Friend';
    const existing = this.state.agents[id];
    // A friend's agent gets read only tools; only the host can grant it more (city.agent.grant, SEC-2).
    const granted = existing?.granted || [];
    const asked = (Array.isArray(a.tools) ? a.tools : READ_ONLY_TOOLS).filter((t) => ALL_TOOLS.includes(t) && !GUEST_DENY.has(t) && (READ_ONLY_TOOLS.includes(t) || granted.includes(t)));
    // Nothing safe asked for: the read only set, never the crew's default tools.
    // What the host granted stays as the host set it; otherwise what was asked, else the read only set.
    const tools = granted.length && existing?.grantedBy === 'host' && Array.isArray(existing.tools) ? [...existing.tools] : asked.length ? asked : [...READ_ONLY_TOOLS];
    let worker = existing ? this.bus.state.crew.find((w) => w.id === existing.workerId) : null;
    if (!worker) worker = this.hive.hire({ name, role, prompt: str(a.prompt, 2000) || undefined, tools, color: a.color, avatar: a.avatar });
    else {
      // A worker hired by an older version may still hold write tools: it comes back with the safe set.
      if ((worker.tools || []).some((t) => !tools.includes(t))) worker = this.hive.updateWorker(worker.id, { tools }) || worker;
      this.scheduler.setPaused(worker.id, false);
    }
    const xp = Math.min(Math.max(0, Number(a.xp) || 0), 1e6);
    const spec = cleanSpec(a.specialization, Object.keys(this.state.rooms)) || [roomForRole(role)];
    const m = this.state.machines[machineId];
    const agent = {
      id, workerId: worker.id, name, role, avatar: worker.avatar, color: worker.color, specialization: spec,
      level: levelFor(xp), xp, tools, permissions: perms(tools), ...(granted.length ? { grantedBy: 'host' } : {}),
      memory: a.memory && Array.isArray(a.memory.highlights) ? { count: num(a.memory.count) || 0, highlights: a.memory.highlights.slice(0, 4).map((h) => ({ id: str(h.id, 40), kind: str(h.kind, 20), text: str(h.text, LIMITS.memoryText) })) } : { count: 0, highlights: [] },
      room: spec[0], taskId: null, status: 'idle', brain: { kind: 'remote', machineId, label: m?.model || m?.name },
      home: machineId, builtin: false, retired: false, granted, stats: { done: 0, reviews: 0, tests: 0, loops: 0, ...(existing?.stats || {}) }
    };
    this.emit('city.agent.joined', { agent });
    if (m?.brainId) {
      this.scheduler.setPreference(worker.id, m.brainId);
      this._restrictBrain(m.brainId, machineId);
    }
    return this.state.agents[id];
  }

  leaveMachine(machineId, reason = 'left') {
    const m = this.state.machines[machineId];
    if (!m || m.host) return;
    for (const b of Object.values(this.state.borrows)) if (b.status !== 'ended' && (b.to === machineId || b.from === machineId)) this._endBorrow(b.id, 'left');
    for (const a of Object.values(this.state.agents)) {
      if (a.home !== machineId) continue;
      this.scheduler.setPaused(a.workerId, true);
      this.scheduler.setPreference(a.workerId, null);
      const t = a.taskId ? this.state.tasks[a.taskId] : null;
      if (t && !TERMINAL.has(t.status)) this._reopen(t, 'system', `${a.name} went offline`);
    }
    this.emit('city.machine.left', { machineId, reason: str(reason, 60) || 'left' });
    this._kick();
  }

  /** Stops the current hop of a task and opens it again in the same room. */
  _reopen(t, by, reason, patch = {}) {
    const x = this.exec.get(t.id);
    if (x) { this.exec.delete(t.id); x.ctrl.abort(); }
    const p = { status: 'open', agentId: null, awaiting: null, ...patch };
    if (t.link) Object.assign(p, { link: null, was: t.link });
    this._hop(t, (p.pipeline || t.pipeline)[p.stage ?? t.stage] || t.room, p, by, reason);
    this._kick();
  }

  // ---------------------------------------------------------------- GPU borrowing
  requestBorrow(data, who) {
    const agent = this.state.agents[str(data.agentId, 80)];
    if (!agent || agent.retired) fail('not_found', 'no such agent');
    if (!this._ownsAgent(who, agent)) fail('forbidden', 'only the owner of an agent can ask for a GPU for it');
    const to = this.state.machines[str(data.machineId, 30)];
    if (!to || !to.online) fail('not_found', 'that machine is not in the city');
    const brainId = to.host ? (to.brainId && this.scheduler.brains.has(to.brainId) ? to.brainId : this._localBrainId()) : to.brainId;
    if (!brainId || !this.scheduler.brains.has(brainId)) fail('conflict', `${to.name} has no model ready to lend`);
    if (agent.home === to.id) fail('bad_request', 'the agent already lives on that machine');
    if (Object.values(this.state.borrows).some((b) => b.agentId === agent.id && b.status !== 'ended')) fail('conflict', `${agent.name} already has a borrow`);
    const borrow = {
      id: `bw_${Object.keys(this.state.borrows).length + 1}`, agentId: agent.id, from: agent.home, to: to.id, status: 'pending',
      limit: { turns: clampInt(data.turns, 1, LIMITS.borrowTurns, 6), minutes: clampInt(data.minutes, 1, LIMITS.borrowMinutes, 10) },
      used: { turns: 0, completionTokens: 0, ms: 0 }, requestedBy: who.owner, createdAt: new Date(this.now()).toISOString()
    };
    this.emit('city.borrow.requested', { borrow });
    const timer = setTimeout(() => { if (this.state.borrows[borrow.id]?.status === 'pending') this._endBorrow(borrow.id, 'expired'); }, LIMITS.borrowPendingMs);
    timer.unref?.();
    this.borrowRt.set(borrow.id, { timer, brainId, workerId: agent.workerId });
    return this.state.borrows[borrow.id];
  }

  answerBorrow(data, who) {
    const b = this.state.borrows[str(data.borrowId, 40)];
    if (!b) fail('not_found', 'no such borrow');
    if (b.status !== 'pending') fail('conflict', `the borrow is ${b.status}`);
    const lender = this.state.machines[b.to];
    if (!lender || lender.owner !== who.owner) fail('forbidden', 'only the lender can answer');
    if (!data.accept) {
      this.emit('city.borrow.answered', { borrowId: b.id, accepted: false, by: who.owner });
      this._endBorrow(b.id, 'refused');
      return this.state.borrows[b.id];
    }
    const rt = this.borrowRt.get(b.id);
    const slot = rt && this.scheduler.brains.get(rt.brainId);
    if (!slot) { this._endBorrow(b.id, 'brain_gone'); fail('conflict', 'the lent model is gone'); }
    const limit = { turns: Math.min(b.limit.turns, clampInt(data.turns, 1, LIMITS.borrowTurns, b.limit.turns)), minutes: Math.min(b.limit.minutes, clampInt(data.minutes, 1, LIMITS.borrowMinutes, b.limit.minutes)) };
    clearTimeout(rt.timer);
    rt.prevPref = this.scheduler.prefs.get(rt.workerId) || null;
    if (slot.brain.only && !slot.brain.only.has(rt.workerId)) { slot.brain.only.add(rt.workerId); rt.addedOnly = true; }
    this.emit('city.borrow.answered', { borrowId: b.id, accepted: true, limit, by: who.owner });
    this.scheduler.setPreference(rt.workerId, rt.brainId);
    rt.timer = setTimeout(() => this._endBorrow(b.id, 'time'), limit.minutes * 60_000);
    rt.timer.unref?.();
    return this.state.borrows[b.id];
  }

  stopBorrow(data, who) {
    const b = this.state.borrows[str(data.borrowId, 40)];
    if (!b) fail('not_found', 'no such borrow');
    const lender = this.state.machines[b.to];
    const borrower = this.state.machines[b.from];
    if (who.owner !== lender?.owner && who.owner !== borrower?.owner && who.owner !== 'host') fail('forbidden', 'only the lender or the borrower can stop it');
    if (b.status !== 'ended') this._endBorrow(b.id, 'stopped');
    return this.state.borrows[b.id];
  }

  _endBorrow(id, reason) {
    const b = this.state.borrows[id];
    if (!b || b.status === 'ended') return;
    const rt = this.borrowRt.get(id);
    if (rt) {
      clearTimeout(rt.timer);
      this.borrowRt.delete(id);
      if (b.status === 'active') {
        const slot = this.scheduler.brains.get(rt.brainId);
        if (rt.addedOnly && slot?.brain.only) slot.brain.only.delete(rt.workerId);
        this.scheduler.setPreference(rt.workerId, rt.prevPref && this.scheduler.brains.has(rt.prevPref) ? rt.prevPref : null);
      }
    }
    this.emit('city.borrow.ended', { borrowId: id, reason, used: b.used });
  }

  _borrowTurn(d) {
    if (d.error) return;
    for (const [id, rt] of this.borrowRt) {
      const b = this.state.borrows[id];
      if (!b || b.status !== 'active' || rt.workerId !== d.workerId || rt.brainId !== d.brainId) continue;
      this.emit('city.borrow.turn', { borrowId: id, turnId: d.turnId, completionTokens: d.completionTokens || 0, ms: d.ms || 0 });
      if (this.state.borrows[id].used.turns >= b.limit.turns) this._endBorrow(id, 'limit');
    }
  }

  // ---------------------------------------------------------------- memory
  _remember(agentId, kind, text, pinned = false) {
    const a = this.state.agents[agentId];
    if (!a || a.home !== this.machineId) return null;
    const list = this.memories.get(agentId) || [];
    const entry = { id: `am_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, kind: MEMORY_KINDS.has(kind) ? kind : 'fact', text: String(text).trim().slice(0, LIMITS.memoryText), pinned: !!pinned, ts: new Date(this.now()).toISOString() };
    list.push(entry);
    while (list.length > LIMITS.memoryEntries) {
      const i = list.findIndex((e) => !e.pinned);
      if (i === -1) break;
      list.splice(i, 1);
    }
    this.memories.set(agentId, list);
    this.emit('city.agent.memory', { agentId, ...publicMemory(list) });
    return entry;
  }

  // ---------------------------------------------------------------- who is asking
  _who(d) {
    if (d && d.as && typeof d.as === 'object') {
      // A verified PeerId (set by the Node router from the session, 52 characters) is kept whole, so two peers never share a building or a task.
      const id = str(String(d.as.id ?? ''), d.as.verified === true ? 80 : 24) || 'guest';
      const name = str(String(d.as.name ?? ''), LIMITS.name) || 'Guest';
      // A peer through the Node router (verified, its grants checked) or a 0.2 guest with its role (src/collab/policy.js).
      if (d.as.verified === true) return { guest: true, id, name, owner: `peer:${id}`, peerId: id };
      const g = guestOf(d);
      return { guest: true, id, name, role: g?.role || 'viewer', owner: `peer:${id}` };
    }
    return { guest: false, id: 'h', name: 'You', role: 'host', owner: 'host' };
  }

  _ownsAgent(who, a) {
    const m = this.state.machines[a.home];
    return m ? m.owner === who.owner : !who.guest;
  }

  _ownsTask(who, t) {
    return !who.guest || (t.createdBy?.kind === 'guest' && t.createdBy.id === who.id);
  }

  _hostOnly(who) {
    if (who.guest) fail('forbidden', 'only the host can do this');
  }

  _rate(who) {
    if (!who.guest) return;
    const now = this.now();
    const list = (this.guestRate.get(who.id) || []).filter((t) => now - t < LIMITS.guestWindowMs);
    if (list.length >= LIMITS.guestCommands) fail('rate_limited', 'too many city commands, wait a few seconds');
    list.push(now);
    this.guestRate.set(who.id, list);
  }

  _task(d, who) {
    const t = this.state.tasks[str(d.taskId, 40)];
    if (!t) fail('not_found', 'no such task');
    if (!this._ownsTask(who, t)) fail('forbidden', 'a guest can change only the tasks it created');
    return t;
  }

  _agent(d) {
    const a = this.state.agents[str(d.agentId, 80)];
    if (!a) fail('not_found', 'no such agent');
    return a;
  }

  // ---------------------------------------------------------------- commands
  createTask(d, who) {
    const title = str(d.title, LIMITS.title);
    if (!title) fail('bad_request', 'title is required');
    // The host's desktop language: Mel and the crew narrate the job it becomes in it.
    if (!who.guest && typeof d.lang === 'string') this.hive.setLang?.(d.lang);
    const want = d.agentId ? this.state.agents[str(d.agentId, 80)] : null;
    if (d.agentId && (!want || want.retired)) fail('not_found', 'no such agent');
    let room = str(d.room, 40) || (want ? want.specialization?.[0] : 'lobby');
    if (!this.state.rooms[room]) fail('bad_request', `no room ${room}`);
    if (who.guest && this.state.rooms[room].hostOnly) fail('forbidden', `guests cannot send tasks to ${this.state.rooms[room].name}`);
    let pipeline = Array.isArray(d.pipeline) && d.pipeline.length ? d.pipeline.map((r) => str(r, 40)).slice(0, LIMITS.pipeline) : null;
    if (pipeline) {
      for (const r of pipeline) if (!this.state.rooms[r]) fail('bad_request', `no room ${r}`);
      if (who.guest && pipeline.some((r) => this.state.rooms[r].hostOnly)) fail('forbidden', 'guests cannot send tasks to the Ops room');
      room = pipeline[0];
    } else {
      const kind = this.state.rooms[room].kind;
      if (room === 'lobby' && want) room = want.specialization?.[0] || 'code';
      if (kind === 'board' && room === 'lobby') pipeline = ['lobby'];
      else pipeline = this.pipelineFrom(room);
    }
    const criteria = (Array.isArray(d.criteria) ? d.criteria : []).map((c) => str(c, LIMITS.criterion)).filter(Boolean).slice(0, LIMITS.criteria);
    const reviewOnly = this.state.rooms[pipeline[0]].kind === 'review' || this.state.rooms[pipeline[0]].kind === 'test';
    const t = this._createTask({
      title, detail: str(d.detail, LIMITS.detail), criteria, pipeline,
      files: reviewOnly ? this.toolbox.ws.list().map((f) => f.path).slice(0, 60) : [],
      wantAgent: want?.id, createdBy: who.guest ? { kind: 'guest', id: who.id, name: who.name } : { kind: 'user', id: 'user' }, guest: who.guest
    });
    this._kick();
    return clone(t);
  }

  /**
   * The pipeline a task dropped in a room follows: the rest of the city pipeline from that room
   * (Architect, Developer, QA, Reviewer by default), or that room and then the checking rooms.
   */
  pipelineFrom(room) {
    const base = (this.state.pipeline?.length ? this.state.pipeline : DEFAULT_PIPELINE).filter((r) => this.state.rooms[r]);
    const i = base.indexOf(room);
    if (i !== -1) return base.slice(i);
    const checks = base.filter((r) => ['review', 'test'].includes(this.state.rooms[r]?.kind));
    return [room, ...checks];
  }

  setPipeline(d, who) {
    this._hostOnly(who);
    const list = (Array.isArray(d.pipeline) ? d.pipeline : []).map((r) => str(r, 40)).filter(Boolean).slice(0, LIMITS.pipeline);
    if (!list.length) fail('bad_request', 'pipeline: a list of room ids');
    if (new Set(list).size !== list.length) fail('bad_request', 'a room appears twice in the pipeline');
    for (const r of list) {
      const room = this.state.rooms[r];
      if (!room) fail('bad_request', `no room ${r}`);
      if (room.kind === 'board' || room.hostOnly) fail('bad_request', `${room.name} cannot be a pipeline stage`);
    }
    if (!list.some((r) => WORK_KINDS.has(this.state.rooms[r].kind) || r === 'design')) fail('bad_request', 'the pipeline needs a room where the work is done');
    this.emit('city.pipeline.updated', { pipeline: list });
    return { pipeline: [...this.state.pipeline] };
  }

  /** Onboarding: the name of the city and of this machine. Host only. */
  nameCity(d, who) {
    this._hostOnly(who);
    const name = str(d.name, LIMITS.name);
    if (!name) fail('bad_request', 'name is required');
    if (name !== this.state.name) this.emit('city.named', { name });
    const machineName = str(d.machineName, LIMITS.name);
    if (machineName && machineName !== this.state.machines[this.machineId]?.name) {
      this.store.setMachineName(machineName);
      this.emit('city.machine.updated', { machine: { id: this.machineId, name: machineName } });
    }
    return { name: this.state.name, machine: this.state.machines[this.machineId] };
  }

  /** Onboarding is over (the user finished or skipped the steps). Host only. */
  finishOnboarding(d, who) {
    this._hostOnly(who);
    if (!this.state.onboarded) this.emit('city.onboarded', { skipped: !!d.skipped });
    return { onboarded: this.state.onboarded };
  }

  /** The host gives a friend's agent more tools than the read only set (SEC-2). Host only, no shell. */
  grantAgent(d, who) {
    this._hostOnly(who);
    const a = this._agent(d);
    if (a.home === this.machineId) fail('bad_request', 'your own agents use city.agent.update');
    const granted = (Array.isArray(d.tools) ? d.tools : []).filter((t) => ALL_TOOLS.includes(t) && !GUEST_DENY.has(t) && !READ_ONLY_TOOLS.includes(t));
    const tools = [...new Set([...READ_ONLY_TOOLS, ...granted])];
    this.emit('city.agent.updated', { agent: { id: a.id, granted, tools, permissions: perms(tools) } });
    const w = this.bus.state.crew.find((x) => x.id === a.workerId);
    if (w) this.hive.updateWorker(w.id, { tools });
    return this.state.agents[a.id];
  }

  assignTask(d, who) {
    const t = this._task(d, who);
    const a = this._agent(d);
    if (a.retired) fail('conflict', `${a.name} is retired`);
    if (TERMINAL.has(t.status)) fail('conflict', `the task is ${t.status}`);
    if (t.link) {
      const crew = this.bus.state.tasks[t.link.taskId];
      if (crew && crew.status !== 'done') {
        this.hive.reassignTask(t.link.taskId, a.workerId);
        return this.state.tasks[t.id];
      }
    }
    if (this.exec.has(t.id) || ['claimed', 'in_progress', 'in_review', 'in_test'].includes(t.status)) this._reopen(t, who.guest ? 'guest' : 'user', `handed to ${a.name}`, { wantAgent: a.id });
    else this.emit('city.task.updated', { task: { id: t.id, wantAgent: a.id } });
    this._kick();
    return this.state.tasks[t.id];
  }

  moveTask(d, who) {
    const t = this._task(d, who);
    const room = this.state.rooms[str(d.room, 40)];
    if (!room) fail('bad_request', 'no such room');
    if (who.guest && room.hostOnly) fail('forbidden', `guests cannot send tasks to ${room.name}`);
    if (t.status === 'done' || t.status === 'cancelled') fail('conflict', `the task is ${t.status}`);
    if (t.link && ['running', 'review'].includes(this.bus.state.tasks[t.link.taskId]?.status)) fail('conflict', 'the crew is working on it; hand it to another agent instead');
    let pipeline = t.pipeline;
    let stage = pipeline.indexOf(room.id);
    if (stage === -1) {
      const rest = pipeline.slice(t.stage).filter((r) => ['review', 'test'].includes(this.state.rooms[r]?.kind));
      pipeline = [...pipeline.slice(0, t.stage), room.id, ...rest];
      stage = t.stage;
    }
    this._reopen(t, who.guest ? 'guest' : 'user', `moved to ${room.name}`, { stage, pipeline, wantAgent: null, status: 'open' });
    if (t.status === 'blocked') this.emit('city.task.updated', { task: { id: t.id, reason: null } });
    return this.state.tasks[t.id];
  }

  approveTask(d, who) {
    const t = this._task(d, who);
    if (TERMINAL.has(t.status)) fail('conflict', `the task is ${t.status}`);
    const roomId = t.pipeline[t.stage];
    const room = this.state.rooms[roomId];
    if (t.link && t.stage === 0) {
      // The crew still runs the work hop: only the hops after it can be approved.
      const crew = this.bus.state.tasks[t.link.taskId];
      if (crew && !['done', 'failed', 'skipped', 'blocked'].includes(crew.status)) fail('conflict', 'the crew is still working on it');
    }
    const x = this.exec.get(t.id);
    if (x) { this.exec.delete(t.id); x.ctrl.abort(); }
    this.waitingQa.delete(t.id);
    if (room && (room.kind === 'review' || room.kind === 'test') && !t.awaiting) {
      this.emit('city.task.verdict', { taskId: t.id, room: roomId, agentId: null, passed: true, issues: [], by: 'user' });
    }
    if (t.awaiting) this.emit('city.task.awaiting', { taskId: t.id, room: null });
    if (t.link) this.emit('city.task.updated', { task: { id: t.id, link: null, was: t.link } });
    if (str(d.note, 300)) this.emit('city.task.updated', { task: { id: t.id, note: str(d.note, 300) } });
    this._advance(this.state.tasks[t.id], who.guest ? 'guest' : 'user', `approved by ${who.name}`);
    return this.state.tasks[t.id];
  }

  rejectTask(d, who) {
    const t = this._task(d, who);
    if (TERMINAL.has(t.status)) fail('conflict', `the task is ${t.status}`);
    const note = str(d.note, 300) || 'changes requested';
    const x = this.exec.get(t.id);
    if (x) { this.exec.delete(t.id); x.ctrl.abort(); }
    this.waitingQa.delete(t.id);
    const roomId = t.pipeline[t.stage];
    this.emit('city.task.verdict', { taskId: t.id, room: roomId, agentId: null, passed: false, issues: [note], by: 'user' });
    if (t.awaiting) this.emit('city.task.awaiting', { taskId: t.id, room: null });
    if (t.link) this.emit('city.task.updated', { task: { id: t.id, link: null, was: t.link } });
    this._loop(this.state.tasks[t.id], [note], who.guest ? 'guest' : 'user');
    return this.state.tasks[t.id];
  }

  retryTask(d, who) {
    const t = this._task(d, who);
    if (t.status !== 'blocked' && t.status !== 'cancelled') fail('conflict', 'only a blocked or cancelled task can be retried');
    this._reopen(t, who.guest ? 'guest' : 'user', 'retried', { loops: 0, reason: null });
    return this.state.tasks[t.id];
  }

  cancelTask(d, who) {
    const t = this._task(d, who);
    if (TERMINAL.has(t.status)) fail('conflict', `the task is ${t.status}`);
    const x = this.exec.get(t.id);
    if (x) { this.exec.delete(t.id); x.ctrl.abort(); }
    this.waitingQa.delete(t.id);
    if (t.link) {
      const crew = this.bus.state.tasks[t.link.taskId];
      if (crew && !['done', 'skipped'].includes(crew.status)) { try { this.hive.cancelTask(t.link.taskId); } catch { /* already over */ } }
    }
    if (!TERMINAL.has(this.state.tasks[t.id].status)) this.emit('city.task.cancelled', { taskId: t.id, by: who.guest ? 'guest' : 'user' });
    return this.state.tasks[t.id];
  }

  hireAgent(d, who) {
    this._hostOnly(who);
    const spec = cleanSpec(d.specialization, Object.keys(this.state.rooms));
    const worker = this.hive.hire({ name: d.name, role: d.role, prompt: d.prompt, tools: d.tools, color: d.color, avatar: d.avatar });
    return this._ensureAgent(worker, { specialization: spec });
  }

  updateAgent(d, who) {
    const a = this._agent(d);
    const owns = this._ownsAgent(who, a);
    // The host may grant tools to a guest's agent; nothing else of it changes then.
    if (!owns && (who.guest || !Array.isArray(d.tools))) fail('forbidden', 'only the owner of an agent can change it');
    const patch = { id: a.id };
    const crewPatch = {};
    if (owns) {
      for (const k of ['name', 'role', 'avatar']) if (str(d[k], k === 'role' ? 64 : LIMITS.name)) { patch[k] = str(d[k], k === 'role' ? 64 : LIMITS.name); crewPatch[k] = patch[k]; }
      if (COLOR.test(d.color || '')) { patch.color = d.color; crewPatch.color = d.color; }
      const spec = cleanSpec(d.specialization, Object.keys(this.state.rooms));
      if (spec) patch.specialization = spec;
    }
    if (Array.isArray(d.tools)) {
      // Tools are what an agent may do on the host's disk: only the host grants them.
      if (who.guest) fail('forbidden', 'only the host can change the tools of an agent');
      let tools = d.tools.filter((t) => ALL_TOOLS.includes(t));
      if (a.home !== this.machineId) tools = tools.filter((t) => !GUEST_DENY.has(t));
      if (tools.length) { patch.tools = tools; patch.permissions = perms(tools); crewPatch.tools = tools; if (a.home !== this.machineId) { patch.grantedBy = 'host'; patch.granted = tools.filter((t) => !READ_ONLY_TOOLS.includes(t)); } }
    }
    const w = this.bus.state.crew.find((x) => x.id === a.workerId);
    if (w && Object.keys(crewPatch).length) {
      if (w.builtin) delete crewPatch.tools;
      if (Object.keys(crewPatch).length) this.hive.updateWorker(w.id, crewPatch);
      if (w.builtin && patch.tools) fail('bad_request', 'the tools of the default crew cannot be changed; hire an agent instead');
    }
    if (Object.keys(patch).length > 1) this.emit('city.agent.updated', { agent: patch });
    return this.state.agents[a.id];
  }

  moveAgent(d, who) {
    const a = this._agent(d);
    if (who.guest && !this._ownsAgent(who, a)) fail('forbidden', 'only the owner of an agent can move it');
    const room = this.state.rooms[str(d.room, 40)];
    if (!room) fail('bad_request', 'no such room');
    if (this._busy(a.id)) fail('conflict', `${a.name} is busy with a task`);
    if (a.room !== room.id) this.emit('city.agent.moved', { agentId: a.id, from: a.room, to: room.id });
    return this.state.agents[a.id];
  }

  retireAgent(d, who) {
    const a = this._agent(d);
    if (!this._ownsAgent(who, a)) fail('forbidden', 'only the owner of an agent can retire it');
    if (this._busy(a.id)) fail('conflict', `${a.name} is busy with a task`);
    if (a.builtin) { this.emit('city.agent.status', { agentId: a.id, status: 'sleeping' }); return {}; }
    this.hive.fire(a.workerId);
    if (!this.state.agents[a.id].retired) this.emit('city.agent.retired', { agentId: a.id });
    return {};
  }

  wakeAgent(d, who) {
    const a = this._agent(d);
    if (!this._ownsAgent(who, a)) fail('forbidden', 'only the owner of an agent can wake it');
    if (a.retired) fail('conflict', `${a.name} is retired`);
    if (a.status === 'sleeping') this.emit('city.agent.status', { agentId: a.id, status: 'idle' });
    this._kick();
    return this.state.agents[a.id];
  }

  _memoryAgent(d, who) {
    const a = this._agent(d);
    if (!this._ownsAgent(who, a)) fail('forbidden', 'only the owner of an agent can read or change its memory');
    if (a.home !== this.machineId) fail('forbidden', "a friend's agent keeps its memory on its own machine");
    return a;
  }

  memoryCommand(op, d, who) {
    const a = this._memoryAgent(d, who);
    const list = this.memories.get(a.id) || [];
    if (op === 'list') return { entries: list.map((e) => ({ ...e })) };
    if (op === 'add') {
      const text = str(d.text, LIMITS.memoryText);
      if (!text) fail('bad_request', 'text is required');
      return { entry: this._remember(a.id, d.kind, text, !!d.pinned) };
    }
    const e = list.find((x) => x.id === str(d.id, 40));
    if (!e) fail('not_found', 'no such memory');
    if (op === 'delete') list.splice(list.indexOf(e), 1);
    else {
      if (str(d.text, LIMITS.memoryText)) e.text = str(d.text, LIMITS.memoryText);
      if (MEMORY_KINDS.has(d.kind)) e.kind = d.kind;
      if (typeof d.pinned === 'boolean') e.pinned = d.pinned;
      e.updatedAt = new Date(this.now()).toISOString();
    }
    this.memories.set(a.id, list);
    this.emit('city.agent.memory', { agentId: a.id, ...publicMemory(list) });
    return op === 'delete' ? {} : { entry: { ...e } };
  }

  /** This machine's card and its own agents, for a guest's browser to send in city.machine.join. */
  localAgents() {
    const m = this.state.machines[this.machineId] || {};
    const agents = Object.values(this.state.agents).filter((a) => a.home === this.machineId && !a.retired && a.workerId !== 'mel')
      .map(({ taskId, status, room, ...a }) => a);
    return { machine: { id: this.machineId, name: m.name || 'My PC', gpu: m.gpu || null, ramBytes: m.ramBytes, cpus: m.cpus, model: m.model, color: m.color }, agents };
  }

  /** A guest's browser writes back the levels its agents earned in a friend's city. */
  saveLocalAgents(d, who) {
    this._hostOnly(who);
    const out = [];
    for (const x of (Array.isArray(d.agents) ? d.agents : []).slice(0, 16)) {
      const a = this.state.agents[str(x?.id, 80)];
      if (!a || a.home !== this.machineId) continue;
      const xp = Math.min(Number(x.xp) || 0, 1e6);
      if (xp > (a.xp || 0)) { this.emit('city.agent.leveled', { agentId: a.id, level: levelFor(xp), xp }); out.push(a.id); }
    }
    return { saved: out };
  }

  addRoom(d, who) {
    this._hostOnly(who);
    const id = str(d.id, 24).toLowerCase();
    if (!/^[a-z][a-z0-9-]{1,23}$/.test(id)) fail('bad_request', 'room id: 2 to 24 lowercase letters, digits or dashes');
    if (this.state.rooms[id]) fail('conflict', 'that room exists');
    const kind = ['work', 'review', 'test', 'library', 'ops'].includes(d.kind) ? d.kind : 'work';
    const room = {
      id, name: str(d.name, LIMITS.name) || id, kind, tools: (Array.isArray(d.tools) ? d.tools : ['list_files', 'read_file']).filter((t) => ALL_TOOLS.includes(t)),
      accepts: (Array.isArray(d.accepts) ? d.accepts : [kind === 'work' ? 'code' : kind]).map((x) => str(x, 20)).filter(Boolean).slice(0, 8),
      requireApproval: !!d.requireApproval, hostOnly: !!d.hostOnly, builtin: false, ext: str(d.ext, 60) || undefined,
      role: PIPELINE_ROLES.includes(d.role) ? d.role : (kind === 'review' ? 'reviewer' : kind === 'test' ? 'qa' : 'developer'),
      order: Object.keys(this.state.rooms).length, color: COLOR.test(d.color || '') ? d.color : undefined
    };
    if (kind === 'review') room.mode = ['auto', 'model', 'checks'].includes(d.mode) ? d.mode : 'auto';
    this.emit('city.room.added', { room });
    return this.state.rooms[id];
  }

  updateRoom(d, who) {
    this._hostOnly(who);
    const r = this.state.rooms[str(d.roomId, 24)];
    if (!r) fail('not_found', 'no such room');
    const patch = { id: r.id };
    if (str(d.name, LIMITS.name)) patch.name = str(d.name, LIMITS.name);
    if (Array.isArray(d.tools)) patch.tools = d.tools.filter((t) => ALL_TOOLS.includes(t));
    if (typeof d.requireApproval === 'boolean') patch.requireApproval = d.requireApproval;
    if (r.kind === 'review' && ['auto', 'model', 'checks'].includes(d.mode)) patch.mode = d.mode;
    if (COLOR.test(d.color || '')) patch.color = d.color;
    if (typeof d.role === 'string' && PIPELINE_ROLES.includes(d.role)) patch.role = d.role;
    if (Object.keys(patch).length > 1) this.emit('city.room.updated', { room: patch });
    return this.state.rooms[r.id];
  }

  removeRoom(d, who) {
    this._hostOnly(who);
    const r = this.state.rooms[str(d.roomId, 24)];
    if (!r) fail('not_found', 'no such room');
    if (r.builtin) fail('bad_request', 'builtin rooms cannot be removed');
    if (Object.values(this.state.tasks).some((t) => !TERMINAL.has(t.status) && t.pipeline.includes(r.id))) fail('conflict', 'open tasks still go through that room');
    this.emit('city.room.removed', { roomId: r.id });
    return {};
  }

  presence(d, who) {
    const now = this.now();
    const r = this.presenceRate.get(who.id) || { sec: 0, n: 0 };
    const sec = Math.floor(now / 1000);
    if (r.sec !== sec) { r.sec = sec; r.n = 0; }
    if (++r.n > LIMITS.presencePerSecond) { this.presenceRate.set(who.id, r); return {}; }
    this.presenceRate.set(who.id, r);
    const x = Number(d.x);
    const y = Number(d.y);
    if (d.left === true) { this.bus.live('city.presence.left', { id: who.id }); return {}; }
    if (!Number.isFinite(x) || !Number.isFinite(y)) return {};
    this.bus.live('city.presence', {
      id: who.id, name: str(d.name, LIMITS.name) || who.name, color: COLOR.test(d.color || '') ? d.color : undefined,
      x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100, room: str(d.room, 24) || undefined, building: str(d.building, 30) || undefined, ts: now
    });
    return {};
  }

  /** The snapshot and the tail for a late joiner (CITY-PROTOCOL.md, city.sync). */
  sync(d) {
    if (!this.snapshot) this._snapshotMaybe(true);
    const since = Number(d?.since);
    const tailFrom = (seq) => {
      const out = [];
      for (const e of this.bus.events) if (e.seq > seq && isCityEvent(e)) out.push(e);
      return out;
    };
    if (Number.isFinite(since) && since >= this.snapshot.seq) {
      const tail = tailFrom(since);
      if (tail.length <= LIMITS.tail) return { tail, lastSeq: this.bus.seq };
    }
    let tail = tailFrom(this.snapshot.seq);
    if (tail.length > LIMITS.tail) { this._snapshotMaybe(true); tail = tailFrom(this.snapshot.seq); }
    return { snapshot: this.snapshot.city, snapshotSeq: this.snapshot.seq, tail, lastSeq: this.bus.seq };
  }

  /** Registers the city.* commands on the engine server. */
  register(server) {
    this.handlers = new Map();
    const cmd = (type, fn, { guest = true } = {}) => {
      // `run` is also what the p2p adapter calls with a who it verified in Node (never `as`).
      const run = (d, who, client) => {
        if (who.guest && !guest) fail('forbidden', 'only the host can do this');
        // A 0.2 guest's role is checked here too, not only in the host's browser (0.2.1). A verified peer
        // (who.peerId) reaches this only after its capability was checked in Node.
        if (who.guest && !who.peerId) checkGuest(who, type, (code, message) => new CityError(code, message));
        if (type !== 'city.presence') this._rate(who);
        return fn(d, who, client);
      };
      this.handlers.set(type, run);
      server.command(type, (data, client) => {
        const d = data && typeof data === 'object' ? data : {};
        return run(d, this._who(d), client);
      });
    };
    cmd('city.state', () => ({ city: this.state, lastSeq: this.bus.seq }));
    cmd('city.sync', (d) => this.sync(d));
    cmd('city.task.create', (d, w) => ({ task: this.createTask(d, w) }));
    cmd('city.task.assign', (d, w) => ({ task: this.assignTask(d, w) }));
    cmd('city.task.move', (d, w) => ({ task: this.moveTask(d, w) }));
    cmd('city.task.approve', (d, w) => ({ task: this.approveTask(d, w) }));
    cmd('city.task.reject', (d, w) => ({ task: this.rejectTask(d, w) }));
    cmd('city.task.retry', (d, w) => ({ task: this.retryTask(d, w) }));
    cmd('city.task.cancel', (d, w) => ({ task: this.cancelTask(d, w) }));
    cmd('city.agent.hire', (d, w) => ({ agent: this.hireAgent(d, w) }), { guest: false });
    cmd('city.agent.update', (d, w) => ({ agent: this.updateAgent(d, w) }));
    cmd('city.agent.move', (d, w) => ({ agent: this.moveAgent(d, w) }));
    cmd('city.agent.retire', (d, w) => this.retireAgent(d, w));
    cmd('city.agent.wake', (d, w) => ({ agent: this.wakeAgent(d, w) }));
    for (const op of ['list', 'add', 'update', 'delete']) cmd(`city.agent.memory.${op}`, (d, w) => this.memoryCommand(op, d, w));
    cmd('city.agents.local', () => this.localAgents(), { guest: false });
    cmd('city.agents.save', (d, w) => this.saveLocalAgents(d, w), { guest: false });
    cmd('city.machine.join', (d, w) => {
      if (!w.guest) fail('bad_request', 'city.machine.join comes from a guest: the host browser forwards it with as');
      return this.joinMachine(d, w.owner);
    });
    cmd('city.machine.update', (d, w) => {
      const m = this.state.machines[str(d.machineId, 30)];
      if (!m) fail('not_found', 'no such machine');
      if (m.owner !== w.owner) fail('forbidden', 'only the owner of a machine can change it');
      const patch = { id: m.id };
      if (str(d.name, LIMITS.name)) patch.name = str(d.name, LIMITS.name);
      if (str(d.model, 120)) patch.model = str(d.model, 120);
      if (COLOR.test(d.color || '')) patch.color = d.color;
      if (typeof d.brainId === 'string' && !m.host) {
        if (!this.scheduler.brains.has(d.brainId)) fail('not_found', 'no such brain');
        if (!this._guestBrain(d.brainId, m.owner)) fail('forbidden', "only a model this friend's own bridge lends can run its building");
        patch.brainId = d.brainId;
      }
      if (m.host && patch.name) this.store.setMachineName(patch.name);
      this.emit('city.machine.updated', { machine: patch });
      if (patch.brainId) {
        this._restrictBrain(patch.brainId, m.id);
        for (const a of Object.values(this.state.agents)) if (a.home === m.id && !a.retired) this.scheduler.setPreference(a.workerId, patch.brainId);
      }
      this._kick();
      return { machine: this.state.machines[m.id] };
    });
    cmd('city.machine.leave', (d, w) => {
      const m = this.state.machines[str(d.machineId, 30)];
      if (!m) fail('not_found', 'no such machine');
      if (m.owner !== w.owner && w.guest) fail('forbidden', 'only the owner of a machine (or the host) can take it out');
      if (m.host) fail('bad_request', 'the host machine cannot leave its own city');
      this.leaveMachine(m.id, d.reason);
      return {};
    });
    cmd('city.borrow.request', (d, w) => ({ borrow: this.requestBorrow(d, w) }));
    cmd('city.borrow.answer', (d, w) => ({ borrow: this.answerBorrow(d, w) }));
    cmd('city.borrow.stop', (d, w) => ({ borrow: this.stopBorrow(d, w) }));
    cmd('city.presence', (d, w) => this.presence(d, w));
    cmd('city.room.add', (d, w) => ({ room: this.addRoom(d, w) }), { guest: false });
    cmd('city.room.update', (d, w) => ({ room: this.updateRoom(d, w) }), { guest: false });
    cmd('city.room.remove', (d, w) => this.removeRoom(d, w), { guest: false });
    cmd('city.pipeline.set', (d, w) => this.setPipeline(d, w), { guest: false });
    cmd('city.name.set', (d, w) => this.nameCity(d, w), { guest: false });
    cmd('city.onboard.done', (d, w) => this.finishOnboarding(d, w), { guest: false });
    cmd('city.agent.grant', (d, w) => ({ agent: this.grantAgent(d, w) }), { guest: false });
    // The City strings (i18n/parts/city.en.json) until the parts are merged into i18n/en.json.
    server.route?.('GET', '/api/city/strings', (req, res) => {
      let body = '{}';
      try { body = fs.readFileSync(STRINGS_FILE, 'utf8'); } catch { /* not shipped */ }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(body);
    });
  }

  /** The handler of a city command, for the p2p membership adapter (src/city/membership.js). */
  handler(type) {
    return this.handlers?.get(type) || null;
  }

  async close() {
    if (this.closed) return;
    for (const x of this.exec.values()) x.ctrl.abort();
    this.exec.clear();
    for (const id of [...this.borrowRt.keys()]) {
      const b = this.state.borrows[id];
      if (b && b.status !== 'ended') this._endBorrow(id, 'stopped');
    }
    for (const t of this.saveTimers.values()) clearTimeout(t);
    for (const id of this.saveTimers.keys()) this._saveNow(id);
    this.saveTimers.clear();
    for (const a of Object.values(this.state.agents)) if (a.home === this.machineId) this._saveNow(a.id);
    this._snapshotMaybe(true);
    this.closed = true;
    this.off?.();
    if (this.hive) { this.hive.adaptWorker = null; this.hive.extraMemories = null; }
  }
}

function clone(x) {
  return JSON.parse(JSON.stringify(x));
}

function taskNum(id) {
  const m = /^ct_(\d+)$/.exec(id);
  return m ? Number(m[1]) : 0;
}

function perms(tools) {
  return { shell: tools.includes('run'), write: tools.includes('write_file') || tools.includes('edit_file') || tools.includes('delete_file') };
}

function num(v) {
  return Number.isFinite(v) && v >= 0 ? v : undefined;
}

function clampInt(v, min, max, dflt) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : dflt;
}

function safeJson(text) {
  try { return JSON.parse(String(text || '').replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { return null; }
}

/** A clean list of room ids (the first one is the home room), or null. */
function cleanSpec(list, known = ROOM_IDS) {
  if (!Array.isArray(list)) return null;
  const out = [...new Set(list.map((x) => String(x).trim().toLowerCase()).filter((x) => known.includes(x)))].slice(0, 6);
  return out.length ? out : null;
}

/**
 * Starts the city on a running engine and registers its commands.
 * @returns {City}
 */
export function startCity({ bus, hive, scheduler, toolbox, server, home, projectDir, version }) {
  const city = new City({ bus, hive, scheduler, toolbox, home, projectDir, version });
  city.start();
  if (server) city.register(server);
  return city;
}
