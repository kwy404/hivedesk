// A local stand in for the city engine (?city=mock). It emits the events of CITY-PROTOCOL.md
// (every one labeled demo), answers the same commands and sends the same live frames, so the
// scene, the panels and the drag and drop can be built and tested without a running city.
// The story follows the engine demo: Rita joins with six words and her building rises, she
// contributes Pip, a reviewer; Dev borrows Rita's GPU over the bridge; and a task flows Design,
// Code, Review, Test and done, again and again.

const GB = 1024 ** 3;
export const HOST = 'm_5e1f0a01';
export const RITA = 'm_7a11ce02';
const MODEL = 'Qwen2.5 Coder 7B';

const ROOMS = [
  { id: 'lobby', name: 'Lobby', kind: 'board', tools: [], accepts: ['plan'], requireApproval: false, hostOnly: false, order: 0, color: '#FFB531' },
  { id: 'design', name: 'Design', kind: 'work', tools: ['list_files', 'read_file', 'write_file', 'edit_file', 'check', 'preview'], accepts: ['design'], requireApproval: false, hostOnly: false, order: 1, color: '#FF7AB6' },
  { id: 'code', name: 'Code', kind: 'work', tools: ['list_files', 'read_file', 'write_file', 'edit_file', 'delete_file', 'run', 'check', 'preview'], accepts: ['code', 'fix'], requireApproval: false, hostOnly: false, order: 2, color: '#6CC4FF' },
  { id: 'review', name: 'Review', kind: 'review', tools: ['list_files', 'read_file', 'check'], accepts: ['review'], requireApproval: false, hostOnly: false, mode: 'auto', order: 3, color: '#C9A7FF' },
  { id: 'test', name: 'Test', kind: 'test', tools: ['list_files', 'read_file', 'run', 'check', 'preview'], accepts: ['test'], requireApproval: false, hostOnly: false, order: 4, color: '#7BE0A0' },
  { id: 'ops', name: 'Ops', kind: 'ops', tools: ['list_files', 'read_file', 'run'], accepts: ['ops'], requireApproval: true, hostOnly: true, order: 5, color: '#E8C27A' },
  { id: 'library', name: 'Library', kind: 'library', tools: ['list_files', 'read_file', 'write_file', 'edit_file', 'check', 'preview'], accepts: ['docs'], requireApproval: false, hostOnly: false, order: 6, color: '#9FD3C7' },
].map((r) => ({ ...r, builtin: true }));

const mem = (...items) => ({ count: items.length + 3, highlights: items.map(([kind, text], i) => ({ id: `mem_${kind}_${i}_${text.length}`, kind, text })) });
const agent = (id, name, role, color, spec, level, xp, tools, memory, extra = {}) => ({
  id, workerId: id, name, role, avatar: null, color, specialization: spec, level, xp, tools, permissions: { shell: tools.includes('run'), write: tools.includes('write_file') },
  memory, room: spec[0], taskId: null, status: 'idle', brain: { kind: 'local', machineId: HOST, label: MODEL }, home: HOST, builtin: true, retired: false,
  stats: { done: Math.round(xp / 12), reviews: 0, tests: 0, loops: 0 }, ...extra,
});

export function mockCity() {
  const now = new Date().toISOString();
  const agents = [
    agent('mel', 'Mel', 'Foreman', '#FFB531', ['lobby', 'library'], 4, 160, ['list_files', 'read_file'], mem(['preference', 'The user likes small, finished steps'], ['decision', 'Every task gets a review before the tests'])),
    agent('designer', 'Designer', 'Designer', '#FF7AB6', ['design', 'review'], 3, 96, ['list_files', 'read_file', 'write_file', 'edit_file', 'check', 'preview'], mem(['fact', 'Brand colors: honey amber on warm charcoal'], ['preference', 'Rounded corners, 12 px'], ['task', 'Designed the Crumb bakery hero'])),
    agent('dev', 'Dev', 'Developer', '#6CC4FF', ['code', 'review', 'ops'], 4, 170, ['list_files', 'read_file', 'write_file', 'edit_file', 'delete_file', 'run', 'check'], mem(['fact', 'The project uses plain HTML and CSS'], ['decision', 'No build step for small pages'], ['task', 'Wrote the opening hours table'])),
    agent('qa', 'QA', 'Tester', '#7DC49B', ['test', 'review'], 3, 120, ['list_files', 'read_file', 'run', 'check', 'preview'], mem(['fact', 'Run the link checker on every page'])),
    agent('writer', 'Writer', 'Writer', '#C9A0E8', ['library', 'design'], 2, 40, ['list_files', 'read_file', 'write_file', 'edit_file'], mem(['preference', 'Short sentences, plain words'])),
    agent('w_bolt', 'Bolt', 'Ops', '#F08A5D', ['ops', 'code'], 2, 30, ['list_files', 'read_file', 'run'], mem(['decision', 'Commit after every green test run']), { builtin: false }),
  ];
  return {
    v: 1, host: HOST, lastSeq: 0,
    machines: { [HOST]: { id: HOST, name: 'Your PC', host: true, owner: 'host', online: true, gpu: { name: 'RTX 3060', vramBytes: 12 * GB, backend: 'cuda' }, ramBytes: 32 * GB, cpus: 12, model: MODEL, brainId: 'b_local', lending: { turns: 0, active: 0 }, agents: agents.map((a) => a.id), via: 'local', color: '#FFB531', joinedAt: now } },
    rooms: Object.fromEntries(ROOMS.map((r) => [r.id, r])),
    agents: Object.fromEntries(agents.map((a) => [a.id, a])),
    tasks: {
      ct_1: task('ct_1', 'Opening hours', 'lobby', 'open'),
      ct_2: task('ct_2', 'Footer links', 'lobby', 'open'),
      ct_3: task('ct_3', 'Bread cards', 'lobby', 'done'),
    },
    borrows: {},
    hops: [],
  };
}

function task(id, title, room, status, extra = {}) {
  return { id, title, detail: '', criteria: [], pipeline: ['design', 'code', 'review', 'test'], stage: status === 'done' ? 4 : 0, room, status, agentId: null, loops: 0, maxLoops: 3, awaiting: null, issues: [], files: [], verdicts: [], createdBy: { kind: 'user', id: 'h' }, guest: false, createdAt: new Date().toISOString(), demo: true, ...extra };
}

const KIND_STATUS = { review: 'in_review', test: 'in_test' };
const AGENT_STATUS = { review: 'reviewing', test: 'testing' };
const NEW_TASKS = ['Hero section', 'Gallery strip', 'Contact form', 'Menu prices', 'Dark mode', 'Map and address'];

export class MockCity {
  /**
   * @param {{ emit: (ev: object) => void, live?: (frame: object) => void, speed?: number }} opts
   */
  constructor({ emit, live, speed = 1 }) {
    this.emit = emit;
    this.live = live || (() => {});
    this.speed = speed;
    this.seq = 0;
    this.timers = new Set();
    this.city = mockCity();
    this.n = 3;
    this.hopN = 0;
    this.borrowN = 0;
    this.turnN = 0;
    this.loop = 0;
    this.running = false;
    this.full = {}; // the private memory lists, by agent
    for (const a of Object.values(this.city.agents)) this.full[a.id] = a.memory.highlights.map((h) => ({ ...h, pinned: false, ts: new Date().toISOString() }));
  }

  snapshot() { return JSON.parse(JSON.stringify(this.city)); }

  ev(type, data) {
    const e = { seq: ++this.seq, ts: new Date().toISOString(), type, demo: true, data };
    this.city.lastSeq = e.seq;
    this.track(e);
    this.emit(e);
    return e;
  }

  /** The mock keeps its own copy of the state for its decisions (a tiny mirror of the engine reducer). */
  track(e) {
    const d = e.data; const c = this.city;
    switch (e.type) {
      case 'city.machine.joined': c.machines[d.machine.id] = { ...d.machine }; break;
      case 'city.agent.joined': c.agents[d.agent.id] = { ...d.agent }; break;
      case 'city.agent.moved': if (c.agents[d.agentId]) c.agents[d.agentId].room = d.to; break;
      case 'city.agent.status': if (c.agents[d.agentId]) c.agents[d.agentId].status = d.status; break;
      case 'city.agent.updated': if (c.agents[d.agent.id]) Object.assign(c.agents[d.agent.id], d.agent); break;
      case 'city.agent.leveled': if (c.agents[d.agentId]) Object.assign(c.agents[d.agentId], { level: d.level, xp: d.xp }); break;
      case 'city.agent.retired': delete c.agents[d.agentId]; break;
      case 'city.task.created': c.tasks[d.task.id] = { ...d.task }; break;
      case 'city.task.claimed': { const t = c.tasks[d.taskId]; if (t) { t.agentId = d.agentId; t.status = 'claimed'; t.room = d.room; } for (const a of Object.values(c.agents)) if (a.taskId === d.taskId) a.taskId = null; if (c.agents[d.agentId]) c.agents[d.agentId].taskId = d.taskId; break; }
      case 'city.task.hop': { const t = c.tasks[d.task.id]; if (t) Object.assign(t, d.task); for (const a of Object.values(c.agents)) if (a.taskId === d.task.id && a.id !== d.task.agentId) a.taskId = null; break; }
      case 'city.task.done': case 'city.task.cancelled': { const t = c.tasks[d.taskId]; if (t) { t.status = e.type === 'city.task.done' ? 'done' : 'cancelled'; t.agentId = null; } for (const a of Object.values(c.agents)) if (a.taskId === d.taskId) a.taskId = null; break; }
      case 'city.borrow.requested': c.borrows[d.borrow.id] = { ...d.borrow }; break;
      case 'city.borrow.answered': if (c.borrows[d.borrowId]) c.borrows[d.borrowId].status = d.accepted ? 'active' : 'ended'; break;
      case 'city.borrow.ended': if (c.borrows[d.borrowId]) c.borrows[d.borrowId].status = 'ended'; break;
      default: break;
    }
  }

  later(ms, fn) {
    const t = setTimeout(() => { this.timers.delete(t); if (this.running) fn(); }, ms / this.speed);
    this.timers.add(t);
    return t;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.load(HOST, 0.34);
    this.later(700, () => this.live({ type: 'city.presence', data: { id: 'g_sam', name: 'Sam', color: '#86A9D6', x: 6, y: 8 } }));
    // 1. Rita joins with the six words, her building rises, she contributes Pip
    this.later(1500, () => {
      this.ev('city.demo.step', { step: 'friend', text: 'Rita joins with the six words and her building rises' });
      this.ev('city.machine.joined', { machine: { id: RITA, name: "Rita's laptop", host: false, owner: 'peer:g_rita', online: true, gpu: { name: 'RTX 4070 Laptop', vramBytes: 8 * GB, backend: 'cuda' }, ramBytes: 16 * GB, cpus: 8, model: MODEL, brainId: 'b_rita', lending: { turns: 0, active: 0 }, agents: [], via: 'words', color: '#7DC49B' } });
      this.load(RITA, 0.1);
    });
    this.later(5600, () => {
      const pip = agent(`${RITA}:pip`, 'Pip', 'Reviewer', '#9BD86A', ['review', 'code'], 2, 40, ['list_files', 'read_file', 'check'], mem(['fact', "Lives on Rita's laptop and takes tasks from the shared board"], ['preference', 'Reads the diff twice']), { workerId: 'pip', builtin: false, home: RITA, brain: { kind: 'remote', machineId: RITA, label: MODEL }, room: 'review' });
      this.full[pip.id] = pip.memory.highlights.map((h) => ({ ...h, pinned: false, ts: new Date().toISOString() }));
      this.ev('city.agent.joined', { agent: pip });
    });
    // 3. a task dropped in the Design room flows through the pipeline (2. the borrow happens in Code)
    this.later(3600, () => this.newTask());
    // Mel routes the open board notes now and then
    this.later(16000, () => this.routeBoard());
    this.tickPresence();
  }

  stop() {
    this.running = false;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  load(machineId, load) { this.live({ type: 'city.machine.load', data: { machineId, load, queue: load > 0.8 ? 3 : 0, tps: load > 0.05 ? Math.round(18 + load * 20) : 0 } }); }

  tickPresence() {
    const t0 = Date.now();
    const loop = () => {
      const t = (Date.now() - t0) / 1000;
      this.live({ type: 'city.presence', data: { id: 'g_sam', name: 'Sam', color: '#86A9D6', x: 7 + Math.sin(t * 0.5) * 5, y: 6 + Math.cos(t * 0.37) * 3.5, ts: Date.now() } });
      if (t > 1.6) this.live({ type: 'city.presence', data: { id: 'g_rita', name: 'Rita', color: '#7DC49B', x: 25 + Math.cos(t * 0.3) * 9, y: -2 + Math.sin(t * 0.45) * 4, building: RITA, ts: Date.now() } });
      this.later(110, loop);
    };
    this.later(800, loop);
  }

  /* ---------- the pipeline ---------- */
  newTask(room = 'design', title = NEW_TASKS[this.loop % NEW_TASKS.length], wantAgent = null) {
    const id = `ct_${++this.n}`;
    if (!wantAgent && room === 'design') this.ev('city.demo.step', { step: 'task', text: 'A task note lands in the Design room' });
    const t = task(id, title, room, 'open', { pipeline: room === 'design' || room === 'lobby' ? ['design', 'code', 'review', 'test'] : [room, 'review', 'test'], wantAgent });
    this.ev('city.task.created', { task: t });
    if (room === 'lobby') this.later(2000, () => this.hop(id, 'design', 0, 'Mel planned it'));
    else this.later(1300, () => this.claimStage(id));
    return t;
  }

  hop(id, to, stage, reason = 'next') {
    const t = this.city.tasks[id];
    if (!t) return;
    const hop = { id: `h_${++this.hopN}`, taskId: id, from: t.room, to, agentId: null, by: 'system', reason, loop: t.loops || 0, ts: new Date().toISOString() };
    this.ev('city.task.hop', { hop, task: { id, room: to, stage, status: 'open', agentId: null, loops: t.loops || 0 } });
    this.later(1200, () => this.claimStage(id));
  }

  pickAgent(t, room) {
    if (t.wantAgent && this.city.agents[t.wantAgent]) { const w = t.wantAgent; t.wantAgent = null; return w; }
    const author = t.author;
    const pip = this.city.agents[`${RITA}:pip`];
    if (room === 'review' && pip && this.city.machines[RITA]?.online && !pip.taskId) return pip.id;
    const best = Object.values(this.city.agents).filter((a) => (a.specialization || [])[0] === room && a.status !== 'sleeping' && !a.taskId && a.id !== author);
    if (best.length) return best[0].id;
    const any = Object.values(this.city.agents).filter((a) => (a.specialization || []).includes(room) && a.status !== 'sleeping' && !a.taskId && a.id !== author);
    return any[0]?.id || null;
  }

  claimStage(id) {
    const t = this.city.tasks[id];
    if (!t || t.status !== 'open') return;
    const room = t.room;
    const who = this.pickAgent(t, room);
    if (!who) { this.later(4000, () => this.claimStage(id)); return; }
    const a = this.city.agents[who];
    const kindStatus = KIND_STATUS[room] || 'in_progress';
    if (a.home === HOST && a.room !== room) this.ev('city.agent.moved', { agentId: who, from: a.room, to: room, taskId: id });
    this.ev('city.task.claimed', { taskId: id, agentId: who, room, bid: { score: 0.82, skill: 1, load: 0.3, level: a.level, rivals: 1 } });
    if (a.home !== HOST) this.ev('city.agent.moved', { agentId: who, from: a.room, to: room, taskId: id });
    this.later(1500, () => {
      const hop = { id: `h_${++this.hopN}`, taskId: id, from: room, to: room, agentId: who, by: 'agent', reason: 'claimed', loop: t.loops || 0, ts: new Date().toISOString() };
      this.ev('city.task.hop', { hop, task: { id, room, stage: t.pipeline.indexOf(room), status: kindStatus, agentId: who, loops: t.loops || 0 } });
      this.ev('city.agent.status', { agentId: who, status: AGENT_STATUS[room] || 'working' });
      if (a.home !== HOST) for (let i = 0; i < 4; i++) this.later(1200 + i * 1500, () => this.ev('turn.started', { turnId: `tn_${++this.turnN}`, workerId: a.workerId, taskId: id, brainId: 'b_rita', n: i + 1 }));
    });
    let work = 9000;
    if (room === 'code' && this.city.machines[RITA]?.online && who === 'dev') {
      // 2. Dev's PC is busy, so Dev borrows Rita's GPU for three turns
      this.later(2600, () => this.borrow(who, RITA, 3));
      work = 2600 + 1400 + 5200 + 3 * 1700 + 1200 + 3500;
    }
    this.later(work, () => this.finishStage(id, who));
  }

  finishStage(id, who) {
    const t = this.city.tasks[id];
    if (!t || t.status === 'done' || t.status === 'cancelled') return;
    const room = t.room;
    const a = this.city.agents[who];
    if (room === 'review' || room === 'test') this.ev('city.task.verdict', { taskId: id, room, agentId: who, passed: true, issues: [], by: 'agent' });
    else t.author = who;
    if (a) {
      const xp = (a.xp || 0) + (room === 'review' ? 4 : room === 'test' ? 3 : 10);
      const level = Math.max(1, Math.floor((1 + Math.sqrt(1 + (8 * xp) / 25)) / 2));
      if (level > a.level) this.ev('city.agent.leveled', { agentId: who, level, xp });
      else this.ev('city.agent.updated', { agent: { id: who, xp } });
      this.ev('city.agent.status', { agentId: who, status: 'idle' });
    }
    const i = t.pipeline.indexOf(room);
    const next = t.pipeline[i + 1];
    if (!next) {
      this.ev('city.task.done', { taskId: id, by: 'agent' });
      this.ev('city.demo.step', { step: 'done', text: 'Done: every hop was an event' });
      if (a && a.home === HOST && a.room !== a.specialization[0]) this.later(1500, () => this.ev('city.agent.moved', { agentId: who, from: a.room, to: a.specialization[0] }));
      this.loop++;
      this.later(5000, () => this.newTask());
      return;
    }
    this.hop(id, next, i + 1, 'next');
    if (a && a.home === HOST && a.room !== a.specialization[0]) this.later(2500, () => this.ev('city.agent.moved', { agentId: who, from: a.room, to: a.specialization[0] }));
  }

  routeBoard() {
    const open = Object.values(this.city.tasks).find((t) => t.room === 'lobby' && t.status === 'open');
    if (open) {
      this.ev('city.agent.status', { agentId: 'mel', status: 'thinking' });
      this.later(1500, () => { this.ev('city.agent.status', { agentId: 'mel', status: 'idle' }); this.hop(open.id, 'design', 0, 'Mel planned it'); });
    }
    this.later(30000, () => this.routeBoard());
  }

  borrow(agentId, to, turns) {
    const id = `bw_${++this.borrowN}`;
    const lim = { turns, minutes: 10 };
    this.load(HOST, 0.96);
    this.ev('city.demo.step', { step: 'borrow', text: "Dev's machine is busy, so Dev asks to borrow Rita's GPU" });
    this.ev('city.borrow.requested', { borrow: { id, agentId, from: HOST, to, status: 'pending', limit: lim, used: { turns: 0, completionTokens: 0, ms: 0 }, requestedBy: agentId, createdAt: new Date().toISOString() } });
    this.later(1400, () => {
      this.ev('city.borrow.answered', { borrowId: id, accepted: true, limit: lim, by: 'peer:g_rita' });
      this.ev('city.demo.step', { step: 'lent', text: 'Rita said yes: Dev walks across the bridge' });
      this.load(to, 0.64);
      for (let i = 0; i < turns; i++) this.later(5200 + i * 1700, () => this.ev('city.borrow.turn', { borrowId: id, turnId: `tn_${++this.turnN}`, completionTokens: 180 + i * 41, ms: 1900 + i * 210 }));
      this.later(5200 + turns * 1700 + 1200, () => {
        this.ev('city.borrow.ended', { borrowId: id, reason: 'limit', used: { turns, completionTokens: 663, ms: 6330 } });
        this.load(HOST, 0.4); this.load(to, 0.1);
      });
    });
  }

  /* ---------- commands from the UI ---------- */
  async command(type, d = {}) {
    const c = this.city;
    const fail = (code, msg) => { throw Object.assign(new Error(msg), { code }); };
    switch (type) {
      case 'city.state': return { city: this.snapshot(), lastSeq: this.seq };
      case 'city.task.create': {
        if (!String(d.title || '').trim()) fail('bad_request', 'a task needs a title');
        const room = d.agentId ? (c.agents[d.agentId]?.specialization?.[0] || 'code') : (d.room || 'lobby');
        const t = this.newTask(room, String(d.title).slice(0, 200), d.agentId || null);
        return { task: t };
      }
      case 'city.task.assign': {
        const t = c.tasks[d.taskId]; const a = c.agents[d.agentId];
        if (!t || !a) fail('not_found', 'no such task or agent');
        if (t.agentId === d.agentId) return { task: t };
        if (t.agentId) this.ev('city.agent.status', { agentId: t.agentId, status: 'idle' });
        t.wantAgent = d.agentId;
        const room = t.status === 'done' ? null : (t.room === 'lobby' ? (a.specialization?.[0] || 'code') : t.room);
        if (!room) fail('bad_request', 'the task is done');
        this.ev('city.task.updated', { task: { id: t.id, wantAgent: d.agentId } });
        this.hop(t.id, room, Math.max(0, t.pipeline.indexOf(room)), 'assigned by drag');
        return { task: t };
      }
      case 'city.task.move': {
        const t = c.tasks[d.taskId];
        if (!t) fail('not_found', 'no such task');
        if (!c.rooms[d.room]) fail('bad_request', 'no such room');
        if (t.agentId) this.ev('city.agent.status', { agentId: t.agentId, status: 'idle' });
        if (!t.pipeline.includes(d.room) && d.room !== 'lobby') t.pipeline = [d.room, 'review', 'test'];
        this.hop(t.id, d.room, Math.max(0, t.pipeline.indexOf(d.room)), 'moved by drag');
        return { task: t };
      }
      case 'city.task.cancel': this.ev('city.task.cancelled', { taskId: d.taskId, by: 'user' }); return {};
      case 'city.task.approve': case 'city.task.retry': case 'city.task.reject': return { task: c.tasks[d.taskId] };
      case 'city.agent.move': {
        const a = c.agents[d.agentId];
        if (!a) fail('not_found', 'no such agent');
        this.ev('city.agent.moved', { agentId: a.id, from: a.room, to: d.room });
        return { agent: a };
      }
      case 'city.agent.update': {
        const a = c.agents[d.agentId];
        if (!a) fail('not_found', 'no such agent');
        const patch = {};
        for (const k of ['name', 'role', 'specialization', 'tools', 'color']) if (d[k] !== undefined) patch[k] = d[k];
        this.ev('city.agent.updated', { agent: { id: a.id, ...patch } });
        return { agent: a };
      }
      case 'city.agent.retire': {
        const a = c.agents[d.agentId];
        if (!a) return {};
        if (a.builtin) this.ev('city.agent.status', { agentId: a.id, status: 'sleeping' });
        else this.ev('city.agent.retired', { agentId: a.id });
        return {};
      }
      case 'city.agent.wake': this.ev('city.agent.status', { agentId: d.agentId, status: 'idle' }); return { agent: c.agents[d.agentId] };
      case 'city.agent.hire': {
        const id = `w_${++this.n}`;
        const room = d.specialization?.[0] || 'code';
        const a = agent(id, String(d.name || 'Nova').slice(0, 40), d.role || 'Developer', d.color || '#9BD86A', d.specialization || [room], 1, 0, d.tools || ['list_files', 'read_file', 'write_file'], { count: 0, highlights: [] }, { builtin: false, room: 'lobby' });
        this.full[id] = [];
        this.ev('city.agent.joined', { agent: a });
        this.later(900, () => this.ev('city.agent.moved', { agentId: id, from: 'lobby', to: room }));
        return { agent: a };
      }
      case 'city.agent.memory.list': return { entries: (this.full[d.agentId] || []).slice() };
      case 'city.agent.memory.add': case 'city.agent.memory.update': case 'city.agent.memory.delete': {
        const list = this.full[d.agentId] || (this.full[d.agentId] = []);
        let entry = null;
        if (type.endsWith('add')) { entry = { id: `mem_${Date.now().toString(36)}`, kind: d.kind || 'fact', text: String(d.text || '').slice(0, 300), pinned: !!d.pinned, ts: new Date().toISOString() }; list.push(entry); }
        else if (type.endsWith('update')) { entry = list.find((x) => x.id === d.id); if (!entry) fail('not_found', 'no such memory'); Object.assign(entry, { ...(d.text != null ? { text: String(d.text).slice(0, 300) } : {}), ...(d.kind ? { kind: d.kind } : {}), ...(d.pinned != null ? { pinned: !!d.pinned } : {}) }); }
        else { const i = list.findIndex((x) => x.id === d.id); if (i >= 0) list.splice(i, 1); }
        const pinned = list.filter((e) => e.pinned); const rest = list.filter((e) => !e.pinned).slice().reverse();
        this.ev('city.agent.memory', { agentId: d.agentId, count: list.length, highlights: [...pinned, ...rest].slice(0, 4).map((e) => ({ id: e.id, kind: e.kind, text: e.text })) });
        return entry ? { entry } : {};
      }
      case 'city.borrow.answer': this.ev('city.borrow.answered', { borrowId: d.borrowId, accepted: !!d.accept, by: 'host' }); if (!d.accept) this.ev('city.borrow.ended', { borrowId: d.borrowId, reason: 'refused' }); return {};
      case 'city.borrow.stop': this.ev('city.borrow.ended', { borrowId: d.borrowId, reason: 'stopped' }); return {};
      case 'city.presence': return {};
      default: return fail('bad_request', `unknown command ${type}`);
    }
  }
}
