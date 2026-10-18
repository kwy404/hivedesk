// Hive City on the UI side: an adapter from the engine's CityState (CITY-PROTOCOL.md, reduced by
// the engine's own reducer served at /lib/city.js) to the small view the scene and the panels
// read. Pure module (no DOM), so it runs in the unit tests too. The engine is the source of truth:
// the scene never moves a bee or raises a building unless this view changed, and the view only
// changes from a snapshot, an event or a live frame.

export const ROOM_KINDS = ['lobby', 'design', 'code', 'test', 'review', 'ops', 'library'];
export const PIPELINE = ['design', 'code', 'test', 'review'];

/** Room colors, the same as the engine's builtin rooms. */
export const ROOM_COLOR = {
  lobby: '#FFB531', design: '#FF7AB6', code: '#6CC4FF', review: '#C9A7FF', test: '#7BE0A0', ops: '#E8C27A', library: '#9FD3C7',
};

const MACHINE_COLORS = ['#7DC49B', '#86A9D6', '#FF7AB6', '#C9A7FF', '#E8C27A', '#9FD3C7'];

/** Side data the engine state does not keep: presence, live machine load, bridge traffic. */
export const blankLive = () => ({ people: {}, loads: {}, traffic: [], caption: null, n: 0 });

/** XP needed to reach a level: 25 * L * (L - 1) / 2 (the inverse of the engine's levelFor). */
export const xpFor = (level) => (25 * level * (level - 1)) / 2;

/** Progress 0..1 inside the current level. */
export function xpProgress(a) {
  const lv = Math.max(1, a.level || 1);
  const lo = xpFor(lv); const hi = xpFor(lv + 1);
  return Math.max(0, Math.min(1, ((a.xp || 0) - lo) / Math.max(1, hi - lo)));
}

/**
 * Notes what a raw event means for the bridges and the captions. The engine reducer handles the
 * state; this only keeps the traffic that the state does not record.
 */
export function noteEvent(live, city, ev) {
  const d = ev?.data || {};
  switch (ev?.type) {
    case 'city.borrow.turn': {
      const b = city.borrows?.[d.borrowId];
      if (b) trip(live, 'turn', b.from, b.to, ev, b.agentId);
      break;
    }
    case 'turn.started': {
      // a friend's own agent thinks on its own machine: its turns cross the bridge too
      const m = Object.values(city.machines || {}).find((x) => x.brainId && x.brainId === d.brainId);
      const borrowing = Object.values(city.borrows || {}).some((b) => b.status === 'active' && b.to === m?.id);
      if (m && m.id !== city.host && !borrowing) trip(live, 'turn', city.host, m.id, ev, d.workerId);
      break;
    }
    case 'city.task.claimed': {
      const a = city.agents?.[d.agentId];
      if (a && a.home && a.home !== city.host) trip(live, 'task', city.host, a.home, ev, d.taskId);
      break;
    }
    case 'city.demo.step': live.caption = { step: d.step, text: d.text, at: Date.now() }; break;
    default: break;
  }
}

/** Applies a live frame (presence, machine load). Returns true when something changed. */
export function applyLive(live, frame) {
  const d = frame?.data || {};
  switch (frame?.type) {
    case 'city.presence':
      if (!d.id) return false;
      live.people[d.id] = { ...(live.people[d.id] || {}), ...d, seen: Date.now() };
      return true;
    case 'city.presence.left':
      if (!live.people[d.id]) return false;
      delete live.people[d.id];
      return true;
    case 'city.machine.load':
      if (!d.machineId) return false;
      live.loads[d.machineId] = {
        load: Number(d.load) || 0, queue: d.queue || 0, tps: Number(d.tps) > 0 ? Number(d.tps) : 0,
        slots: d.slots && Number.isFinite(d.slots.busy) && Number.isFinite(d.slots.total) ? { busy: d.slots.busy, total: d.slots.total } : null,
      };
      return true;
    default: return false;
  }
}

function trip(live, kind, from, to, ev, ref) {
  if (!from || !to || from === to) return;
  live.traffic.push({ id: `${kind}:${ev.seq ?? ++live.n}:${ref || ''}`, kind, from, to, ref });
  if (live.traffic.length > 40) live.traffic.splice(0, live.traffic.length - 40);
}

const STATUS = { waiting_model: 'waiting', waiting: 'waiting' };

/**
 * The view of a CityState. `live` adds presence, load and traffic.
 * @param {any} city CityState
 * @param {ReturnType<typeof blankLive>} [live]
 */
export function viewOf(city, live = blankLive()) {
  const v = {
    ready: !!city, selfId: city?.host || null, name: city?.name || null, onboarded: !!city?.onboarded, pipeline: city?.pipeline || PIPELINE,
    machines: {}, rooms: {}, agents: {}, tasks: {}, borrows: {}, pending: [], members: {}, loops: [], qa: { running: false, last: null },
    people: live.people, traffic: live.traffic, caption: live.caption, lastSeq: city?.lastSeq || 0,
  };
  if (!city) return v;
  let ci = 0;
  const machines = Object.values(city.machines || {}).sort((a, b) => String(a.joinedAt || '').localeCompare(String(b.joinedAt || '')));
  for (const m of machines) {
    const lv = live.loads[m.id];
    v.machines[m.id] = {
      id: m.id, name: m.name || m.id, self: m.id === city.host, host: !!m.host, owner: m.owner || '',
      color: m.color || (m.id === city.host ? '#FFB531' : MACHINE_COLORS[ci++ % MACHINE_COLORS.length]),
      gpu: m.gpu || null, ramBytes: m.ramBytes || null, cpus: m.cpus || null, model: m.model || null,
      load: lv ? lv.load : 0, tps: lv?.tps || 0, queue: lv?.queue || 0, slots: lv?.slots || null,
      lending: { turns: m.lending?.turns || 0, active: m.lending?.active || 0 },
      online: m.online !== false, joinedAt: m.joinedAt || null, via: m.via || null, agents: m.agents || [],
      peerId: m.peerId || null, reported: !!m.reported, live: null,
    };
  }
  for (const r of Object.values(city.rooms || {}).sort((a, b) => (a.order ?? 99) - (b.order ?? 99))) {
    v.rooms[r.id] = { id: r.id, name: r.name || r.id, kind: r.kind || 'work', role: r.role || null, tools: r.tools || [], accepts: r.accepts || [], requireApproval: !!r.requireApproval, hostOnly: !!r.hostOnly, mode: r.mode || null, builtin: !!r.builtin, color: r.color || ROOM_COLOR[r.id] || '#FFB531' };
  }
  if (!Object.keys(v.rooms).length) for (const k of ROOM_KINDS) v.rooms[k] = { id: k, name: k, kind: 'work', tools: [], accepts: [], builtin: true, color: ROOM_COLOR[k] };
  for (const a of Object.values(city.agents || {})) {
    if (a.retired) continue;
    v.agents[a.id] = {
      id: a.id, workerId: a.workerId || a.id, name: a.name || a.id, role: a.role || '', color: a.color || '#FFB531', avatar: a.avatar || null,
      specialization: a.specialization || [], level: a.level || 1, xp: a.xp || 0,
      tools: a.tools || [], permissions: a.permissions || {},
      memory: a.memory?.highlights || [], memoryCount: a.memory?.count || 0,
      room: a.room || 'lobby', taskId: a.taskId || null, status: STATUS[a.status] || a.status || 'idle', rawStatus: a.status || 'idle',
      brain: a.brain || { kind: 'local' }, home: a.home || city.host, builtin: !!a.builtin, stats: a.stats || {},
      thinksOn: a.thinksOn || null, model: a.model || null, history: a.history || null, owner: a.owner || null, machineId: a.machineId || a.home || null,
    };
    if (a.status === 'testing') v.qa.running = true;
  }
  for (const t of Object.values(city.tasks || {})) {
    if (t.status === 'cancelled') continue;
    const ag = t.agentId && v.agents[t.agentId];
    v.tasks[t.id] = {
      id: t.id, title: t.title || t.id, detail: t.detail || '', status: t.status || 'open', room: t.room || 'lobby',
      assignee: t.agentId || null, wantAgent: t.wantAgent || null, machineId: ag && ag.home !== city.host ? ag.home : null,
      pipeline: t.pipeline || [], stage: t.stage || 0, loops: t.loops || 0, maxLoops: t.maxLoops || 3, awaiting: t.awaiting || null,
      issues: t.issues || [], files: t.files || [], createdBy: t.createdBy || null, guest: !!t.guest, updatedAt: t.updatedAt || t.createdAt || null,
      state: t.state || null, history: t.history || [], verdicts: t.verdicts || [], waitingFor: t.waitingFor || null, criteria: t.criteria || [],
      spec: t.spec || null, jobId: t.jobId || null, author: t.author || null, reason: t.reason || null, createdAt: t.createdAt || null,
    };
    for (const x of t.verdicts || []) if (city.rooms?.[x.room]?.kind === 'test' || x.room === 'test') { if (!v.qa.at || String(t.updatedAt || '') >= v.qa.at) { v.qa.last = !!x.passed; v.qa.at = String(t.updatedAt || ''); } }
  }
  // a task that just looped back: an arc from the room that sent it back to the work room, while it is there
  const lastHop = new Map();
  for (const h of city.hops || []) if (h?.taskId) lastHop.set(h.taskId, h);
  for (const [taskId, h] of lastHop) {
    const t = v.tasks[taskId];
    if (!t || !h.from || h.from === h.to || t.room !== h.to || ['done', 'blocked'].includes(t.status)) continue;
    const fromKind = city.rooms?.[h.from]?.kind;
    if ((h.loop || 0) > 0 && (fromKind === 'review' || fromKind === 'test')) v.loops.push({ taskId, from: h.from, to: h.to, n: h.loop, max: t.maxLoops, reason: h.reason || '' });
  }
  for (const [peerId, m] of Object.entries(city.members || {})) v.members[peerId] = { ...m };
  for (const b of Object.values(city.borrows || {})) {
    if (b.status === 'active') v.borrows[b.id] = { id: b.id, agentId: b.agentId, from: b.from, to: b.to, limit: b.limit || null, used: b.used || { turns: 0 } };
    else if (b.status === 'pending') v.pending.push({ ...b });
  }
  return v;
}

/* ---------- a city derived from the classic engine state, for an engine without a city ---------- */

const ROLE_ROOM = (w) => {
  const r = String(w.role || '').toLowerCase();
  if (w.id === 'mel' || /foreman|plan/.test(r)) return 'lobby';
  if (/review/.test(r)) return 'review';
  if (/qa|test/.test(r)) return 'test';
  if (/design|ui/.test(r)) return 'design';
  if (/writ|doc|copy/.test(r)) return 'library';
  if (/ops|deploy|git/.test(r)) return 'ops';
  return 'code';
};
const WSTATUS = { idle: 'idle', queued: 'waiting_model', thinking: 'thinking', tool: 'working', waiting_approval: 'waiting', error: 'idle' };
const TSTATUS = { pending: 'open', ready: 'open', running: 'in_progress', review: 'in_review', done: 'done', failed: 'blocked', blocked: 'blocked', skipped: 'done' };

/**
 * A CityState built from the classic engine State (crew, workers, tasks), so the City view works
 * on an engine that has no city yet.
 */
export function deriveCity(s, { hardware = null, label = 'This computer' } = {}) {
  const city = { v: 1, host: 'self', lastSeq: s?.lastSeq || 0, machines: {}, rooms: {}, agents: {}, tasks: {}, borrows: {}, hops: [] };
  city.machines.self = { id: 'self', name: label, host: true, owner: 'host', online: true, gpu: hardware?.gpu || null, model: s?.brain?.model || null, lending: { turns: 0, active: 0 }, agents: [], joinedAt: '' };
  ROOM_KINDS.forEach((k, i) => { city.rooms[k] = { id: k, name: k, kind: k === 'review' ? 'review' : k === 'test' ? 'test' : 'work', tools: [], accepts: [], order: i, builtin: true, color: ROOM_COLOR[k] }; });
  const done = {};
  for (const t of Object.values(s?.tasks || {})) if (t.status === 'done') done[t.assignee] = (done[t.assignee] || 0) + 1;
  for (const w of s?.crew || []) {
    const st = s.workers?.[w.id] || {};
    const xp = (done[w.id] || 0) * 10;
    const level = Math.max(1, Math.floor((1 + Math.sqrt(1 + (8 * xp) / 25)) / 2));
    city.agents[w.id] = { id: w.id, workerId: w.id, name: w.name, role: w.role, color: w.color, specialization: [ROLE_ROOM(w)], level, xp, tools: w.tools || [], memory: { count: 0, highlights: [] }, room: ROLE_ROOM(w), taskId: st.taskId || null, status: w.paused ? 'sleeping' : WSTATUS[st.status] || 'idle', brain: { kind: 'local', machineId: 'self' }, home: 'self', builtin: !!w.builtin };
    city.machines.self.agents.push(w.id);
  }
  const job = [...(s?.jobs || [])].reverse().find((j) => ['refining', 'awaiting_brief', 'planning', 'running'].includes(j.status)) || (s?.jobs || [])[(s?.jobs || []).length - 1];
  for (const id of job?.taskIds || []) {
    const t = s.tasks?.[id];
    if (!t) continue;
    const status = TSTATUS[t.status] || 'open';
    const a = city.agents[t.assignee];
    const room = status === 'open' || status === 'done' ? 'lobby' : status === 'in_review' ? 'review' : (a?.room || 'code');
    city.tasks[id] = { id, title: t.title, detail: t.detail, status, room, agentId: status === 'open' ? null : t.assignee, pipeline: [], stage: 0, loops: 0, issues: [] };
  }
  return city;
}

/* ---------- small helpers shared by the scene and the panels ---------- */

export const borrowOf = (v, agentId) => Object.values(v.borrows || {}).find((b) => b.agentId === agentId) || null;
export const pendingOf = (v, agentId) => (v.pending || []).find((b) => b.agentId === agentId) || null;
export const friends = (v) => Object.values(v.machines).filter((m) => m.id !== v.selfId);
export const tasksIn = (v, room) => Object.values(v.tasks).filter((t) => t.room === room && t.status !== 'done');
export const agentsIn = (v, room) => Object.values(v.agents).filter((a) => a.room === room);

export function fmtVram(bytes) {
  if (!bytes) return '';
  return `${(bytes / 1024 ** 3).toFixed(bytes >= 10 * 1024 ** 3 ? 0 : 1)} GB`;
}
