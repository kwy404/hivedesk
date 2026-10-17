// Hive City state: a pure reducer over the event log. No Node imports: the UI loads this file
// from /lib/city.js. Shapes are documented in CITY-PROTOCOL.md section 3.

export const CITY = 1;
export const HOP_LIMIT = 200;
export const VERDICT_LIMIT = 20;
export const MAX_LOOPS = 3;

/** The builtin rooms and their rules. Extensions add more through city.room.add. */
export const ROOMS = Object.freeze([
  { id: 'lobby', name: 'Lobby', kind: 'board', tools: [], accepts: ['plan'], requireApproval: false, hostOnly: false, order: 0, color: '#FFB531' },
  { id: 'design', name: 'Design', kind: 'work', tools: ['list_files', 'read_file', 'write_file', 'edit_file', 'check', 'preview'], accepts: ['design'], requireApproval: false, hostOnly: false, order: 1, color: '#FF7AB6' },
  { id: 'code', name: 'Code', kind: 'work', tools: ['list_files', 'read_file', 'write_file', 'edit_file', 'delete_file', 'run', 'check', 'preview'], accepts: ['code', 'fix'], requireApproval: false, hostOnly: false, order: 2, color: '#6CC4FF' },
  { id: 'review', name: 'Review', kind: 'review', tools: ['list_files', 'read_file', 'check'], accepts: ['review'], requireApproval: false, hostOnly: false, mode: 'auto', order: 3, color: '#C9A7FF' },
  { id: 'test', name: 'Test', kind: 'test', tools: ['list_files', 'read_file', 'run', 'check', 'preview'], accepts: ['test'], requireApproval: false, hostOnly: false, order: 4, color: '#7BE0A0' },
  { id: 'ops', name: 'Ops', kind: 'ops', tools: ['list_files', 'read_file', 'run'], accepts: ['ops'], requireApproval: true, hostOnly: true, order: 5, color: '#E8C27A' },
  { id: 'library', name: 'Library', kind: 'library', tools: ['list_files', 'read_file', 'write_file', 'edit_file', 'check', 'preview'], accepts: ['docs'], requireApproval: false, hostOnly: false, order: 6, color: '#9FD3C7' }
].map((r) => Object.freeze({ ...r, builtin: true })));

export const ROOM_IDS = ROOMS.map((r) => r.id);
/** Room kinds where an agent does the work itself (a crew job with one task). */
export const WORK_KINDS = new Set(['work', 'library', 'ops']);

/** Where the builtin crew works. The first room is the home room. */
export const SPECIALIZATION = Object.freeze({
  mel: ['lobby', 'library'],
  dev: ['code', 'review', 'ops'],
  designer: ['design', 'review'],
  qa: ['test', 'review'],
  writer: ['library', 'design']
});

/** A home room for a hired worker, from its role. */
export function roomForRole(role = '') {
  const r = String(role).toLowerCase();
  if (/review/.test(r)) return 'review';
  if (/\b(qa|test|check)/.test(r)) return 'test';
  if (/design|\bui\b|css|style/.test(r)) return 'design';
  if (/doc|writ|copy|readme/.test(r)) return 'library';
  if (/ops|deploy|git|release/.test(r)) return 'ops';
  return 'code';
}

export const AGENT_STATUSES = Object.freeze(['idle', 'thinking', 'waiting_model', 'working', 'reviewing', 'testing', 'waiting', 'sleeping', 'offline']);
export const TASK_STATUSES = Object.freeze(['open', 'claimed', 'in_progress', 'in_review', 'in_test', 'done', 'blocked', 'cancelled']);

/** level = floor((1 + sqrt(1 + 8 xp / 25)) / 2): 0 xp level 1, 25 level 2, 75 level 3, 150 level 4. */
export function levelFor(xp) {
  const x = Math.max(0, Number(xp) || 0);
  return Math.max(1, Math.floor((1 + Math.sqrt(1 + (8 * x) / 25)) / 2));
}

/** The task status while it is in a room of this kind. */
export function statusForKind(kind) {
  if (kind === 'review') return 'in_review';
  if (kind === 'test') return 'in_test';
  return 'in_progress';
}

/** The public view of a private memory list: the count and up to 4 highlights (pinned first, then the newest). */
export function publicMemory(entries = []) {
  const list = Array.isArray(entries) ? entries : [];
  const pinned = list.filter((e) => e.pinned);
  const rest = list.filter((e) => !e.pinned).slice().reverse();
  return { count: list.length, highlights: [...pinned, ...rest].slice(0, 4).map((e) => ({ id: e.id, kind: e.kind, text: e.text })) };
}

/** Events the city reducer reads: every city.* event plus these crew events. */
export const CREW_EVENTS = new Set(['worker.status', 'turn.started']);
export const isCityEvent = (e) => !!e && typeof e.type === 'string' && (e.type.startsWith('city.') || CREW_EVENTS.has(e.type));

export function initialCity() {
  return { v: CITY, host: null, lastSeq: 0, machines: {}, rooms: {}, agents: {}, tasks: {}, borrows: {}, hops: [] };
}

const WORKER_STATUS = { queued: 'waiting_model', thinking: 'thinking', tool: 'working', waiting_approval: 'waiting', error: 'idle' };

function agentByWorker(city, workerId) {
  for (const a of Object.values(city.agents)) if (a.workerId === workerId && !a.retired) return a;
  return null;
}

const BUSY = new Set(['working', 'reviewing', 'testing']);

function unhold(a) {
  a.taskId = null;
  if (BUSY.has(a.status)) a.status = 'idle';
}

function release(city, task) {
  for (const a of Object.values(city.agents)) if (a.taskId === task.id && a.id !== task.agentId) unhold(a);
  if (task.agentId && city.agents[task.agentId]) city.agents[task.agentId].taskId = task.id;
}

function freeAll(city, task) {
  for (const a of Object.values(city.agents)) if (a.taskId === task.id) unhold(a);
  task.agentId = null;
}

function merge(target, patch) {
  for (const [k, v] of Object.entries(patch || {})) if (k !== 'id') target[k] = v;
  return target;
}

/**
 * Applies one event to the city, mutating it. Returns the same object.
 * Unknown types are ignored, so new types never break an older UI.
 */
export function reduceCity(city, event) {
  if (!city || !event || typeof event.seq !== 'number') return city;
  if (event.seq > city.lastSeq) city.lastSeq = event.seq;
  if (!isCityEvent(event)) return city;
  const d = event.data || {};
  const ts = event.ts;
  switch (event.type) {
    case 'city.started':
      city.host = d.host || city.host;
      break;
    case 'city.machine.joined': {
      const m = d.machine;
      if (!m?.id) break;
      const before = city.machines[m.id] || {};
      city.machines[m.id] = { lending: { turns: 0, active: 0 }, agents: [], ...before, ...m, online: m.online !== false, joinedAt: m.joinedAt || ts };
      for (const a of Object.values(city.agents)) if (a.home === m.id && !city.machines[m.id].agents.includes(a.id) && !a.retired) city.machines[m.id].agents.push(a.id);
      break;
    }
    case 'city.machine.updated':
      if (d.machine?.id && city.machines[d.machine.id]) merge(city.machines[d.machine.id], d.machine);
      break;
    case 'city.machine.left': {
      const m = city.machines[d.machineId];
      if (!m) break;
      m.online = false;
      m.leftAt = ts;
      m.brainId = null;
      for (const a of Object.values(city.agents)) if (a.home === m.id) a.status = 'offline';
      break;
    }
    case 'city.room.added':
      if (d.room?.id) city.rooms[d.room.id] = { ...d.room };
      break;
    case 'city.room.updated':
      if (d.room?.id && city.rooms[d.room.id]) merge(city.rooms[d.room.id], d.room);
      break;
    case 'city.room.removed':
      delete city.rooms[d.roomId];
      break;
    case 'city.agent.joined': {
      const a = d.agent;
      if (!a?.id) break;
      city.agents[a.id] = { ...(city.agents[a.id] || {}), ...a };
      const m = city.machines[a.home];
      if (m && !m.agents.includes(a.id)) m.agents.push(a.id);
      break;
    }
    case 'city.agent.updated':
      if (d.agent?.id && city.agents[d.agent.id]) merge(city.agents[d.agent.id], d.agent);
      break;
    case 'city.agent.moved':
      if (city.agents[d.agentId]) city.agents[d.agentId].room = d.to;
      break;
    case 'city.agent.status':
      if (city.agents[d.agentId]) city.agents[d.agentId].status = d.status;
      break;
    case 'city.agent.leveled':
      if (city.agents[d.agentId]) Object.assign(city.agents[d.agentId], { level: d.level, xp: d.xp });
      break;
    case 'city.agent.memory':
      if (city.agents[d.agentId]) city.agents[d.agentId].memory = { count: d.count || 0, highlights: Array.isArray(d.highlights) ? d.highlights : [] };
      break;
    case 'city.agent.retired': {
      const a = city.agents[d.agentId];
      if (!a) break;
      a.retired = true;
      a.status = 'sleeping';
      a.taskId = null;
      const m = city.machines[a.home];
      if (m) m.agents = m.agents.filter((id) => id !== a.id);
      break;
    }
    case 'city.task.created':
      if (d.task?.id) city.tasks[d.task.id] = { issues: [], files: [], verdicts: [], loops: 0, maxLoops: MAX_LOOPS, ...d.task };
      break;
    case 'city.task.claimed': {
      const t = city.tasks[d.taskId];
      if (!t) break;
      t.agentId = d.agentId;
      t.status = 'claimed';
      if (d.room) t.room = d.room;
      t.updatedAt = ts;
      release(city, t);
      break;
    }
    case 'city.task.hop': {
      const hop = d.hop;
      if (hop) {
        city.hops.push(hop);
        if (city.hops.length > HOP_LIMIT) city.hops.splice(0, city.hops.length - HOP_LIMIT);
      }
      const t = d.task?.id ? city.tasks[d.task.id] : null;
      if (!t) break;
      merge(t, d.task);
      t.updatedAt = ts;
      release(city, t);
      break;
    }
    case 'city.task.updated': {
      const t = d.task?.id ? city.tasks[d.task.id] : null;
      if (!t) break;
      merge(t, d.task);
      t.updatedAt = ts;
      if ('agentId' in d.task) release(city, t);
      break;
    }
    case 'city.task.verdict': {
      const t = city.tasks[d.taskId];
      if (!t) break;
      t.verdicts = [...(t.verdicts || []), { room: d.room, agentId: d.agentId, passed: !!d.passed, issues: d.issues || [], by: d.by }].slice(-VERDICT_LIMIT);
      t.issues = d.passed ? [] : (d.issues || []);
      break;
    }
    case 'city.task.awaiting':
      if (city.tasks[d.taskId]) city.tasks[d.taskId].awaiting = d.room;
      break;
    case 'city.task.done': {
      const t = city.tasks[d.taskId];
      if (!t) break;
      t.status = 'done';
      t.stage = (t.pipeline || []).length;
      t.awaiting = null;
      t.updatedAt = ts;
      freeAll(city, t);
      break;
    }
    case 'city.task.blocked':
    case 'city.task.cancelled': {
      const t = city.tasks[d.taskId];
      if (!t) break;
      t.status = event.type === 'city.task.blocked' ? 'blocked' : 'cancelled';
      if (d.reason) t.reason = d.reason;
      t.awaiting = null;
      t.updatedAt = ts;
      freeAll(city, t);
      break;
    }
    case 'city.borrow.requested':
      if (d.borrow?.id) city.borrows[d.borrow.id] = { used: { turns: 0, completionTokens: 0, ms: 0 }, ...d.borrow };
      break;
    case 'city.borrow.answered': {
      const b = city.borrows[d.borrowId];
      if (!b) break;
      if (d.accepted) {
        b.status = 'active';
        b.startedAt = ts;
        if (d.limit) b.limit = { ...b.limit, ...d.limit };
        const m = city.machines[b.to];
        if (m) m.lending = { ...(m.lending || { turns: 0, active: 0 }), active: (m.lending?.active || 0) + 1 };
      }
      break;
    }
    case 'city.borrow.turn': {
      const b = city.borrows[d.borrowId];
      if (!b) break;
      b.used = { turns: (b.used?.turns || 0) + 1, completionTokens: (b.used?.completionTokens || 0) + (d.completionTokens || 0), ms: (b.used?.ms || 0) + (d.ms || 0) };
      const m = city.machines[b.to];
      if (m) m.lending = { ...(m.lending || { turns: 0, active: 0 }), turns: (m.lending?.turns || 0) + 1 };
      break;
    }
    case 'city.borrow.ended': {
      const b = city.borrows[d.borrowId];
      if (!b) break;
      const wasActive = b.status === 'active';
      b.status = 'ended';
      b.reason = d.reason;
      b.endedAt = ts;
      if (d.used) b.used = d.used;
      const m = city.machines[b.to];
      if (m && wasActive) m.lending = { ...(m.lending || { turns: 0, active: 0 }), active: Math.max(0, (m.lending?.active || 1) - 1) };
      break;
    }
    case 'worker.status': {
      const a = agentByWorker(city, d.workerId);
      if (!a || a.status === 'sleeping' || a.status === 'offline') break;
      if (d.status === 'idle') {
        const t = a.taskId ? city.tasks[a.taskId] : null;
        a.status = t ? (t.status === 'in_review' ? 'reviewing' : t.status === 'in_test' ? 'testing' : 'working') : 'idle';
      } else if (WORKER_STATUS[d.status]) {
        a.status = WORKER_STATUS[d.status];
      }
      break;
    }
    case 'turn.started': {
      const a = agentByWorker(city, d.workerId);
      if (!a) break;
      const m = Object.values(city.machines).find((x) => x.brainId && x.brainId === d.brainId);
      if (m) a.brain = { kind: m.id === a.home ? (m.host ? 'local' : 'remote') : 'lent', machineId: m.id, label: m.model || m.name };
      else a.brain = { kind: 'cloud', label: d.brainId };
      break;
    }
  }
  return city;
}

/** Rebuilds the city from a list of events, optionally on top of a snapshot. */
export function replayCity(events, upto = Infinity, base = null) {
  const city = base ? JSON.parse(JSON.stringify(base)) : initialCity();
  for (const e of events) {
    if (e.seq > upto) break;
    if (base && e.seq <= base.lastSeq) continue;
    reduceCity(city, e);
  }
  return city;
}
