// Client state. The engine's events are the source of truth (PROTOCOL.md section 3):
// the UI starts from `hello.state` and applies every event with the reducer below.
// Big data (chat, files) stays in a plain object; Voodoo.js reactive revision counters
// tell the widgets which slice changed, so only that part of the screen re-renders.

import { t } from './i18n.js';

const V = window.V;

export const rev = V.reactive({
  crew: 0, workers: 0, jobs: 0, tasks: 0, queue: 0, approvals: 0, chat: 0, files: 0,
  runs: 0, playbooks: 0, brain: 0, settings: 0, live: 0, tools: 0, all: 0,
});

/** UI-only reactive state. */
export const ui = V.reactive({
  connection: 'connecting',
  demo: false,
  lend: false,
  version: '',
  hello: false,
  replay: null, // { seq, lastSeq } while scrubbing
  unread: { __v: 0 }, // channel -> unread count, __v bumps on change
  notifications: 0,
  focused: null,
  mobile: false,
  askPlaybook: null, // { id, title } chosen in the Playbooks window
  wallpaper: 'comb',
});

const blank = () => ({
  protocol: 1, version: '', demo: false, lend: false, lastSeq: 0,
  settings: { approvalMode: true, sound: true, brain: null },
  brain: { state: 'none', backend: null },
  brains: [], crew: [], workers: {}, jobs: [], tasks: {},
  queue: { running: [], waiting: [] }, approvals: [], chat: {}, files: {}, runs: [],
  playbooks: [], tokens: { prompt: 0, completion: 0 },
});

let live = blank();
let view = null; // replay snapshot, when set
/** Side data that the engine State does not carry. */
export const extra = {
  download: null, runtime: null, hardware: null, fallback: null,
  diffs: {}, tools: {}, turns: {}, stats: { tps: 0, queue: 0, loaded: false },
  runLive: {}, qa: {}, eventsSeen: [], markers: [],
};

export const S = () => view || live;
export const liveState = () => live;
export const inReplay = () => !!view;

const listeners = new Set();
export function onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); }

function bump(...keys) { for (const k of keys) rev[k]++; }

function normalize(st) {
  const s = Object.assign(blank(), st || {});
  s.settings = Object.assign(blank().settings, s.settings || {});
  s.queue = Object.assign({ running: [], waiting: [] }, s.queue || {});
  for (const ch of Object.keys(s.chat)) s.chat[ch] = (s.chat[ch] || []).slice(-200);
  return s;
}

export function loadHello(frame) {
  live = normalize(frame.state);
  if (frame.state && !frame.state.lastSeq) live.lastSeq = frame.lastSeq || 0;
  ui.demo = !!(frame.demo || live.demo);
  ui.lend = !!frame.lend;
  ui.version = frame.version || '';
  ui.hello = true;
  for (const [path, f] of Object.entries(live.files)) {
    if (!extra.diffs[path]) extra.diffs[path] = [];
    void f;
  }
  bumpAll();
}

function bumpAll() { for (const k of Object.keys(rev)) rev[k]++; }

const MARKER = { 'job.created': 'job', 'job.done': 'done', 'job.failed': 'fail', 'approval.requested': 'approval', 'file.changed': 'file', 'qa.report': 'qa' };

export function applyEvent(ev) {
  if (!ev || typeof ev.seq !== 'number') return;
  if (ev.seq <= live.lastSeq && live.lastSeq) return; // duplicate after a reconnect
  reduce(live, ev, true);
  live.lastSeq = ev.seq;
  if (ev.demo) ui.demo = true;
  if (MARKER[ev.type]) { extra.markers.push({ seq: ev.seq, kind: MARKER[ev.type] }); if (extra.markers.length > 2000) extra.markers.shift(); }
  if (!view) for (const fn of listeners) { try { fn(ev); } catch (err) { console.error(err); } }
  else bump('all');
}

// The roles of the built in workers and specialists come from the engine in English: shown in the desktop's language.
const ROLE_KEY = {
  'Foreman and planner': 'mel', Developer: 'dev', 'UI and styles': 'designer', 'Checks and tests': 'qa', 'README, copy and docs': 'writer',
  'Mobile developer': 'mobile', 'Desktop app developer': 'desktop', 'Backend developer': 'backend', 'Security reviewer': 'security',
  'Data engineer': 'data', 'DevOps engineer': 'devops'
};
/** A worker's role in the current language (a role the user typed stays as typed). Takes a worker or a role. */
export function roleName(w) {
  const role = typeof w === 'string' ? w : w?.role;
  const k = ROLE_KEY[role];
  return k ? t(`crew.role.${k}`) : role || '';
}

function workerOf(s, id) { return s.crew.find((w) => w.id === id); }
export const worker = (id) => workerOf(S(), id) || fallbackWorker(id);
function fallbackWorker(id) {
  if (id === 'user') return { id: 'user', name: t('who.you'), role: t('who.youRole'), color: '#8C8172' };
  if (id === 'system') return { id: 'system', name: 'hivedesk', role: 'system', color: '#8C8172' };
  return { id, name: id || t('who.unknown'), role: '', color: '#8C8172' };
}

/**
 * Applies one event to a state object. `isLive` also updates the side data used by
 * live views (diff history, tool log); replay snapshots come from the engine.
 */
export function reduce(s, ev, isLive) {
  const d = ev.data || {};
  switch (ev.type) {
    case 'session.started': if (d.demo) s.demo = true; s.lend = !!d.lend; break;
    case 'settings.changed': Object.assign(s.settings, d); bump('settings'); break;
    case 'brain.status':
      s.brain = { ...d };
      if (isLive && d.state === 'ready' && extra.download) extra.download.phase = extra.download.phase === 'downloading' ? 'done' : extra.download.phase;
      bump('brain'); break;
    case 'brain.download.required': if (isLive) extra.download = { phase: 'required', ...d, received: 0, total: d.bytes }; bump('brain'); break;
    case 'brain.download.started': if (isLive) extra.download = { ...(extra.download || {}), phase: 'downloading', ...d, total: d.bytes, startedAt: Date.parse(ev.ts) }; bump('brain'); break;
    case 'brain.download.finished': if (isLive) extra.download = { ...(extra.download || {}), phase: 'done', ...d, received: d.bytes, total: d.bytes }; bump('brain'); break;
    case 'brain.download.failed': if (isLive) extra.download = { ...(extra.download || {}), phase: 'failed', ...d }; bump('brain'); break;
    case 'brain.runtime': if (isLive) extra.runtime = { ...d }; bump('brain'); break;
    case 'brain.fallback': if (isLive) extra.fallback = { ...d, ts: ev.ts }; bump('brain'); break;
    case 'hardware.detected': if (isLive) extra.hardware = d; bump('brain'); break;
    case 'brain.attached': s.brains = s.brains.filter((b) => b.brainId !== d.brainId).concat([{ ...d }]); bump('brain'); break;
    case 'brain.detached': s.brains = s.brains.filter((b) => b.brainId !== d.brainId); bump('brain'); break;
    case 'crew.hired':
    case 'crew.updated': {
      const i = s.crew.findIndex((w) => w.id === d.worker.id);
      if (i >= 0) s.crew[i] = { ...s.crew[i], ...d.worker }; else s.crew.push({ ...d.worker });
      if (!s.workers[d.worker.id]) s.workers[d.worker.id] = { status: 'idle' };
      bump('crew'); break;
    }
    case 'crew.fired': s.crew = s.crew.filter((w) => w.id !== d.workerId); delete s.workers[d.workerId]; bump('crew', 'workers'); break;
    case 'job.created': s.jobs.push({ ...d.job, taskIds: [...(d.job.taskIds || [])] }); bump('jobs'); break;
    case 'job.planning': { const j = job(s, ev.jobId); if (j) { j.status = 'planning'; j.playbookId = d.playbookId || j.playbookId; } bump('jobs'); break; }
    case 'job.planned': {
      const j = job(s, ev.jobId);
      for (const t of d.tasks || []) { s.tasks[t.id] = { ...t }; if (j && !j.taskIds.includes(t.id)) j.taskIds.push(t.id); }
      if (j) { j.status = 'running'; if (d.playbookId) j.playbookId = d.playbookId; }
      bump('jobs', 'tasks'); break;
    }
    // The brief step: the job card, the top bar and the Office say what the job waits for.
    case 'job.refining': { const j = job(s, ev.jobId); if (j) j.status = 'refining'; bump('jobs'); break; }
    case 'brief.proposed': { const j = job(s, ev.jobId); if (j) { j.status = 'awaiting_brief'; j.briefProposed = d.brief; } bump('jobs'); break; }
    case 'brief.approved': { const j = job(s, ev.jobId); if (j) { j.status = 'planning'; j.brief = { text: d.text, source: d.source }; } bump('jobs'); break; }
    case 'job.resumed': { const j = job(s, ev.jobId); if (j) { j.status = 'running'; delete j.finishedAt; delete j.error; } bump('jobs'); break; }
    case 'job.done': { const j = job(s, ev.jobId); if (j) Object.assign(j, { status: 'done', summary: d.summary, files: d.files, finishedAt: ev.ts }); bump('jobs'); break; }
    case 'job.failed': { const j = job(s, ev.jobId); if (j) Object.assign(j, { status: 'failed', error: d.error, finishedAt: ev.ts }); bump('jobs'); break; }
    case 'job.cancelled': { const j = job(s, ev.jobId); if (j) Object.assign(j, { status: 'cancelled', finishedAt: ev.ts }); bump('jobs'); break; }
    case 'task.added': {
      s.tasks[d.task.id] = { ...d.task };
      const j = job(s, d.task.jobId || ev.jobId);
      if (j && !j.taskIds.includes(d.task.id)) j.taskIds.push(d.task.id);
      bump('tasks', 'jobs'); break;
    }
    case 'task.status': {
      const t = s.tasks[d.taskId];
      if (t) {
        if (d.status === 'running' && t.status !== 'running') t.startedAt = ev.ts;
        if (['done', 'failed', 'skipped'].includes(d.status)) t.finishedAt = ev.ts;
        t.status = d.status; if (d.note) t.note = d.note;
      }
      bump('tasks'); break;
    }
    case 'queue.updated': s.queue = { running: d.running || [], waiting: d.waiting || [] }; bump('queue'); break;
    case 'turn.started':
      if (isLive) extra.turns[d.workerId] = { ...d, text: '', startedAt: Date.parse(ev.ts) };
      bump('live'); break;
    case 'turn.ended':
      if (isLive && extra.turns[d.workerId]) Object.assign(extra.turns[d.workerId], { ended: true, ...d });
      s.tokens = { prompt: (s.tokens?.prompt || 0) + (d.promptTokens || 0), completion: (s.tokens?.completion || 0) + (d.completionTokens || 0) };
      if (isLive && d.tps) extra.stats.tps = d.tps;
      bump('live', 'brain'); break;
    case 'worker.status': s.workers[d.workerId] = { ...(s.workers[d.workerId] || {}), status: d.status, detail: d.detail, taskId: d.taskId ?? s.workers[d.workerId]?.taskId }; bump('workers'); break;
    case 'chat.message': {
      const ch = d.channel || 'general';
      (s.chat[ch] ||= []).push({ ...d, ts: d.ts || ev.ts, seq: ev.seq, ...(ev.jobId && !d.jobId ? { jobId: ev.jobId } : {}) });
      if (s.chat[ch].length > 200) s.chat[ch].splice(0, s.chat[ch].length - 200);
      bump('chat'); break;
    }
    case 'chat.chosen': {
      const m = (s.chat[d.channel] || []).find((x) => x.replyTo === d.messageId && x.choices);
      if (m) m.chosen = d.choice;
      bump('chat'); break;
    }
    case 'tool.called':
      if (isLive) { const list = (extra.tools[d.workerId] ||= []); list.push({ ...d, ts: ev.ts, state: 'running' }); if (list.length > 40) list.shift(); }
      bump('tools'); break;
    case 'tool.result':
      if (isLive) for (const list of Object.values(extra.tools)) { const c = list.find((x) => x.callId === d.callId); if (c) { c.state = d.ok ? 'ok' : 'error'; c.error = d.error; c.result = d.result; } }
      bump('tools'); break;
    case 'file.changed': {
      if (d.op === 'delete') delete s.files[d.path];
      else s.files[d.path] = { bytes: d.bytes, content: d.content, lastSeq: ev.seq, op: d.op, workerId: d.workerId };
      if (isLive) { const list = (extra.diffs[d.path] ||= []); list.push({ diff: d.diff, op: d.op, workerId: d.workerId, taskId: d.taskId, seq: ev.seq, ts: ev.ts }); if (list.length > 12) list.shift(); }
      bump('files'); break;
    }
    case 'run.finished': s.runs.push({ ...d, ts: ev.ts }); if (s.runs.length > 50) s.runs.shift(); if (isLive) delete extra.runLive[d.callId]; bump('runs'); break;
    case 'approval.requested': s.approvals = s.approvals.filter((a) => a.id !== d.approval.id).concat([{ ...d.approval }]); bump('approvals'); break;
    case 'approval.resolved': s.approvals = s.approvals.filter((a) => a.id !== d.approvalId); bump('approvals'); break;
    case 'qa.report': if (isLive) extra.qa[d.taskId] = d; bump('tasks'); break;
    case 'playbook.saved': s.playbooks = s.playbooks.filter((p) => p.id !== d.playbook.id).concat([{ ...d.playbook }]); bump('playbooks'); break;
    case 'playbook.used': { const p = s.playbooks.find((x) => x.id === d.playbookId); if (p) p.uses = (p.uses || 0) + 1; bump('playbooks'); break; }
    case 'playbook.deleted': s.playbooks = s.playbooks.filter((p) => p.id !== d.playbookId); bump('playbooks'); break;
    default: break;
  }
}

function job(s, id) { return s.jobs.find((j) => j.id === id); }

/** Live frames (never logged). */
export function applyLive(frame) {
  const d = frame.data || {};
  switch (frame.type) {
    case 'turn.token': {
      const t = (extra.turns[d.workerId] ||= { turnId: d.turnId, workerId: d.workerId, text: '' });
      if (t.turnId !== d.turnId) { Object.assign(t, { turnId: d.turnId, text: '', ended: false }); }
      t.text += d.text || '';
      if (t.text.length > 24000) t.text = t.text.slice(-20000);
      bump('live'); break;
    }
    case 'brain.stats': extra.stats = { ...extra.stats, ...d }; bump('brain'); break;
    case 'brain.download.progress': extra.download = { ...(extra.download || { phase: 'downloading' }), phase: 'downloading', ...d }; bump('brain'); break;
    case 'brain.runtime.progress': extra.runtime = { ...(extra.runtime || { state: 'installing' }), line: d.line }; bump('brain'); break;
    case 'run.output': {
      const r = (extra.runLive[d.callId] ||= { callId: d.callId, out: '' });
      r.out += d.text || '';
      if (r.out.length > 32000) r.out = r.out.slice(-24000);
      bump('runs'); break;
    }
    default: break;
  }
}

export function enterReplay(state, seq) {
  view = normalize(state);
  ui.replay = { seq, lastSeq: live.lastSeq };
  bumpAll();
}

export function exitReplay() {
  view = null;
  ui.replay = null;
  bumpAll();
}

/** Tasks of a job in a stable dependency order. */
export function jobTasks(s, j) {
  const tasks = (j.taskIds || []).map((id) => s.tasks[id]).filter(Boolean);
  const order = new Map(tasks.map((t, i) => [t.id, i]));
  const depth = new Map();
  const depthOf = (t, seen = new Set()) => {
    if (depth.has(t.id)) return depth.get(t.id);
    if (seen.has(t.id)) return 0;
    seen.add(t.id);
    let dd = 0;
    for (const dep of t.dependsOn || []) { const dt = s.tasks[dep]; if (dt) dd = Math.max(dd, depthOf(dt, seen) + 1); }
    depth.set(t.id, dd);
    return dd;
  };
  for (const t of tasks) depthOf(t);
  return tasks.sort((a, b) => depth.get(a.id) - depth.get(b.id) || order.get(a.id) - order.get(b.id)).map((t) => ({ ...t, depth: depth.get(t.id) }));
}

export function currentJob(s = S()) {
  for (let i = s.jobs.length - 1; i >= 0; i--) if (['refining', 'awaiting_brief', 'planning', 'running'].includes(s.jobs[i].status)) return s.jobs[i];
  return s.jobs[s.jobs.length - 1] || null;
}

const SIDE = new Set(['file.changed', 'tool.called', 'tool.result', 'qa.report', 'hardware.detected', 'brain.download.required', 'brain.download.started', 'brain.download.finished', 'brain.download.failed', 'brain.runtime', 'brain.fallback', 'turn.started', 'turn.ended']);

/** Rebuilds the side data (diff history, tool log, QA reports, markers) from past events after a page load. */
export function hydrateExtra(events) {
  const scratch = blank();
  extra.diffs = {}; extra.tools = {}; extra.qa = {}; extra.markers = [];
  for (const ev of events) {
    if (MARKER[ev.type]) extra.markers.push({ seq: ev.seq, kind: MARKER[ev.type] });
    if (SIDE.has(ev.type)) reduce(scratch, ev, true);
  }
  for (const t of Object.values(extra.turns)) t.ended = true;
  bumpAll();
}
