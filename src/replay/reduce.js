// Pure event reducer. No Node imports: the UI loads this file from /lib/reduce.js.
// State shape is documented in PROTOCOL.md section 5.

export const PROTOCOL = 1;
const CHAT_LIMIT = 200;
const RUN_LIMIT = 50;

/** @returns {any} */
export function initialState(meta = {}) {
  return {
    protocol: PROTOCOL,
    version: meta.version || '0.0.0',
    demo: !!meta.demo,
    lend: !!meta.lend,
    lastSeq: 0,
    settings: { approvalMode: true, sound: true, brain: { backend: 'none' } },
    brain: { state: 'none', backend: 'none' },
    brains: [],
    hardware: null,
    download: null,
    runtime: null,
    crew: [],
    workers: {},
    jobs: [],
    tasks: {},
    queue: { running: [], waiting: [] },
    approvals: [],
    chat: { general: [] },
    files: {},
    runs: [],
    playbooks: [],
    tokens: { prompt: 0, completion: 0 }
  };
}

function findJob(state, id) {
  return state.jobs.find((j) => j.id === id);
}

function upsert(list, item, key = 'id') {
  const i = list.findIndex((x) => x[key] === item[key]);
  if (i === -1) list.push(item);
  else list[i] = { ...list[i], ...item };
}

/**
 * Applies one event to the state, mutating it. Returns the same state.
 * Unknown event types are ignored so new types never break old clients.
 */
export function reduce(state, event) {
  if (!event || typeof event.seq !== 'number') return state;
  if (event.seq > state.lastSeq) state.lastSeq = event.seq;
  if (event.demo) state.demo = true;
  const d = event.data || {};
  switch (event.type) {
    case 'session.started':
      state.version = d.version || state.version;
      state.demo = state.demo || !!d.demo;
      state.lend = !!d.lend;
      break;
    case 'settings.changed': {
      for (const [k, v] of Object.entries(d)) state.settings[k] = v;
      break;
    }
    case 'hardware.detected':
      state.hardware = d;
      break;
    case 'brain.status':
      state.brain = { ...d };
      break;
    case 'brain.runtime':
      state.runtime = { ...d };
      break;
    case 'brain.download.required':
    case 'brain.download.started':
      state.download = { ...d, state: event.type === 'brain.download.started' ? 'downloading' : 'required', received: 0 };
      break;
    case 'brain.download.finished':
      state.download = { ...(state.download || {}), ...d, state: 'done' };
      break;
    case 'brain.download.failed':
      state.download = { ...(state.download || {}), ...d, state: 'failed' };
      break;
    case 'brain.attached':
      upsert(state.brains, { brainId: d.brainId, label: d.label, kind: d.kind, model: d.model }, 'brainId');
      break;
    case 'brain.detached':
      state.brains = state.brains.filter((b) => b.brainId !== d.brainId);
      break;
    case 'crew.hired':
    case 'crew.updated':
      if (d.worker) {
        upsert(state.crew, d.worker);
        if (!state.workers[d.worker.id]) state.workers[d.worker.id] = { status: 'idle' };
      }
      break;
    case 'crew.fired':
      state.crew = state.crew.filter((w) => w.id !== d.workerId);
      delete state.workers[d.workerId];
      break;
    case 'worker.status':
      state.workers[d.workerId] = { status: d.status, detail: d.detail, taskId: d.taskId };
      break;
    case 'job.created':
      if (d.job) upsert(state.jobs, { ...d.job, taskIds: d.job.taskIds || [] });
      break;
    case 'job.planning': {
      const j = findJob(state, event.jobId);
      if (j) j.status = 'planning';
      break;
    }
    case 'job.planned': {
      const j = findJob(state, event.jobId);
      for (const t of d.tasks || []) {
        state.tasks[t.id] = { ...t };
        if (j && !j.taskIds.includes(t.id)) j.taskIds.push(t.id);
      }
      if (j) {
        j.status = 'running';
        if (d.playbookId) j.playbookId = d.playbookId;
      }
      break;
    }
    case 'task.added': {
      const t = d.task;
      if (t) {
        state.tasks[t.id] = { ...t };
        const j = findJob(state, t.jobId || event.jobId);
        if (j && !j.taskIds.includes(t.id)) j.taskIds.push(t.id);
      }
      break;
    }
    case 'job.refining': {
      const j = findJob(state, event.jobId);
      if (j) j.status = 'refining';
      break;
    }
    case 'brief.proposed': {
      const j = findJob(state, event.jobId);
      if (j) {
        j.status = 'awaiting_brief';
        j.briefProposed = d.brief;
      }
      break;
    }
    case 'brief.approved': {
      const j = findJob(state, event.jobId);
      if (j) {
        j.status = 'planning';
        j.brief = { text: d.text, source: d.source };
      }
      break;
    }
    case 'job.report': {
      const j = findJob(state, event.jobId);
      if (j) j.report = { ...d.report, improvedPrompt: d.improvedPrompt, nextPrompts: d.nextPrompts };
      break;
    }
    case 'worker.note': {
      if (!state.notes) state.notes = {};
      const list = (state.notes[d.workerId] = state.notes[d.workerId] || []);
      list.push({ text: d.text, taskId: d.taskId, ts: event.ts });
      if (list.length > 20) list.splice(0, list.length - 20);
      break;
    }
    case 'brain.choice':
      state.choice = { ...d };
      break;
    case 'task.updated': {
      const t = d.task && state.tasks[d.task.id];
      if (t) Object.assign(t, d.task);
      break;
    }
    case 'job.resumed': {
      const j = findJob(state, event.jobId);
      if (j) {
        j.status = 'running';
        delete j.finishedAt;
        delete j.error;
      }
      break;
    }
    case 'task.status': {
      const t = state.tasks[d.taskId];
      if (t) {
        t.status = d.status;
        if (d.note !== undefined) t.note = d.note;
        if (d.status === 'running') t.attempts = (t.attempts || 0) + 1;
      }
      break;
    }
    case 'job.done':
    case 'job.failed':
    case 'job.cancelled': {
      const j = findJob(state, event.jobId);
      if (j) {
        j.status = event.type.slice(4);
        j.finishedAt = event.ts;
        if (d.summary) j.summary = d.summary;
        if (d.error) j.error = d.error;
      }
      state.approvals = state.approvals.filter((a) => a.jobId !== event.jobId);
      break;
    }
    case 'queue.updated':
      state.queue = { running: d.running || [], waiting: d.waiting || [] };
      break;
    case 'turn.ended': {
      state.tokens.prompt += d.promptTokens || 0;
      state.tokens.completion += d.completionTokens || 0;
      if (!state.usage) state.usage = {};
      const u = (state.usage[d.brainId || 'main'] = state.usage[d.brainId || 'main'] || { prompt: 0, completion: 0, turns: 0 });
      u.prompt += d.promptTokens || 0;
      u.completion += d.completionTokens || 0;
      u.turns += 1;
      break;
    }
    case 'providers.changed':
      state.providers = d.providers || {};
      break;
    case 'chat.message': {
      const ch = d.channel || 'general';
      if (!state.chat[ch]) state.chat[ch] = [];
      state.chat[ch].push({ id: d.id, from: d.from, text: d.text, taskId: d.taskId, ts: event.ts, seq: event.seq });
      if (state.chat[ch].length > CHAT_LIMIT) state.chat[ch].splice(0, state.chat[ch].length - CHAT_LIMIT);
      break;
    }
    case 'file.changed':
      if (d.op === 'delete') delete state.files[d.path];
      else state.files[d.path] = { bytes: d.bytes, content: d.content, lastSeq: event.seq };
      break;
    case 'run.finished':
      state.runs.push({ ...d, seq: event.seq });
      if (state.runs.length > RUN_LIMIT) state.runs.splice(0, state.runs.length - RUN_LIMIT);
      break;
    case 'approval.requested':
      if (d.approval) upsert(state.approvals, d.approval);
      break;
    case 'approval.resolved':
      state.approvals = state.approvals.filter((a) => a.id !== d.approvalId);
      break;
    case 'playbook.saved':
      if (d.playbook) upsert(state.playbooks, d.playbook);
      break;
    case 'playbook.used': {
      const p = state.playbooks.find((x) => x.id === d.playbookId);
      if (p) p.uses = (p.uses || 0) + 1;
      break;
    }
    case 'playbook.deleted':
      state.playbooks = state.playbooks.filter((p) => p.id !== d.playbookId);
      break;
    default:
      break;
  }
  return state;
}

/** Rebuilds the state from a list of events, stopping after `seq` when given. */
export function replay(events, seq = Infinity, meta = {}) {
  const state = initialState(meta);
  for (const e of events) {
    if (e.seq > seq) break;
    reduce(state, e);
  }
  return state;
}
