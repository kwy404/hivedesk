// The City UI's pure parts: the view adapter over the engine's CityState, the city layout and
// walking paths, and the local mock, which must speak the same protocol as the engine.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { initialCity, reduceCity } from '../src/city/state.js';
import { viewOf, blankLive, noteEvent, applyLive, deriveCity, xpFor, xpProgress, fmtVram, borrowOf, pendingOf } from '../ui/city/model.js';
import { ROOMS, SPOTS, roomAt, roomPath, exitPath, bridgeTo, bridgePoint, friendCenter, spotFor, roomDoor, HOME, pathLength, CORRIDOR_Y } from '../ui/city/layout.js';
import { MockCity, mockCity, HOST, RITA } from '../ui/city/mock.js';

const ev = (seq, type, data) => ({ seq, ts: new Date(1700000000000 + seq * 1000).toISOString(), type, data });

describe('city view', () => {
  it('maps a CityState to the view the scene reads', () => {
    const c = mockCity();
    const v = viewOf(c);
    expect(v.selfId).toBe(HOST);
    expect(v.machines[HOST].self).toBe(true);
    expect(Object.keys(v.rooms)).toEqual(['lobby', 'design', 'code', 'review', 'test', 'ops', 'library']);
    expect(v.agents.dev.room).toBe('code');
    expect(v.agents.dev.memory.length).toBeGreaterThan(0);
    expect(v.tasks.ct_1.status).toBe('open');
  });

  it('follows the engine reducer through a claim, a hop and a borrow', () => {
    const c = mockCity();
    const live = blankLive();
    const apply = (e) => { reduceCity(c, e); noteEvent(live, c, e); };
    apply(ev(1, 'city.machine.joined', { machine: { id: RITA, name: 'Rita', host: false, owner: 'peer:g', brainId: 'b_r', agents: [] } }));
    apply(ev(2, 'city.task.claimed', { taskId: 'ct_1', agentId: 'dev', room: 'code' }));
    let v = viewOf(c, live);
    expect(v.tasks.ct_1.assignee).toBe('dev');
    expect(v.agents.dev.taskId).toBe('ct_1');
    apply(ev(3, 'city.borrow.requested', { borrow: { id: 'bw_1', agentId: 'dev', from: HOST, to: RITA, status: 'pending', limit: { turns: 3 } } }));
    v = viewOf(c, live);
    expect(pendingOf(v, 'dev')?.id).toBe('bw_1');
    expect(borrowOf(v, 'dev')).toBe(null);
    apply(ev(4, 'city.borrow.answered', { borrowId: 'bw_1', accepted: true }));
    apply(ev(5, 'city.borrow.turn', { borrowId: 'bw_1', turnId: 't1', completionTokens: 9, ms: 10 }));
    v = viewOf(c, live);
    expect(borrowOf(v, 'dev')?.to).toBe(RITA);
    expect(v.borrows.bw_1.used.turns).toBe(1);
    expect(live.traffic.at(-1)).toMatchObject({ kind: 'turn', from: HOST, to: RITA });
    apply(ev(6, 'city.borrow.ended', { borrowId: 'bw_1', reason: 'limit' }));
    expect(borrowOf(viewOf(c, live), 'dev')).toBe(null);
  });

  it('keeps presence and machine load from live frames', () => {
    const live = blankLive();
    expect(applyLive(live, { type: 'city.presence', data: { id: 'g1', name: 'Sam', x: 1, y: 2 } })).toBe(true);
    expect(applyLive(live, { type: 'city.machine.load', data: { machineId: HOST, load: 0.5 } })).toBe(true);
    expect(applyLive(live, { type: 'city.unknown', data: {} })).toBe(false);
    const v = viewOf(mockCity(), live);
    expect(v.people.g1.name).toBe('Sam');
    expect(v.machines[HOST].load).toBe(0.5);
    expect(applyLive(live, { type: 'city.presence.left', data: { id: 'g1' } })).toBe(true);
    expect(live.people.g1).toBeUndefined();
  });

  it('notes the demo captions and a friend agent claiming a task', () => {
    const c = mockCity();
    const live = blankLive();
    c.machines[RITA] = { id: RITA, host: false, agents: [] };
    c.agents[`${RITA}:pip`] = { id: `${RITA}:pip`, home: RITA, room: 'review' };
    noteEvent(live, c, ev(1, 'city.task.claimed', { taskId: 'ct_1', agentId: `${RITA}:pip` }));
    expect(live.traffic[0]).toMatchObject({ kind: 'task', from: HOST, to: RITA });
    noteEvent(live, c, ev(2, 'city.demo.step', { step: 'friend', text: 'x' }));
    expect(live.caption.step).toBe('friend');
  });

  it('uses the engine level curve for XP progress', () => {
    expect([xpFor(1), xpFor(2), xpFor(3), xpFor(4)]).toEqual([0, 25, 75, 150]);
    expect(xpProgress({ level: 2, xp: 50 })).toBeCloseTo(0.5);
    expect(xpProgress({ level: 1, xp: 0 })).toBe(0);
    expect(fmtVram(12 * 1024 ** 3)).toBe('12 GB');
    expect(fmtVram(8 * 1024 ** 3)).toBe('8.0 GB');
  });

  it('derives a city from the classic crew state for an engine without a city', () => {
    const s = { crew: [{ id: 'mel', name: 'Mel', role: 'Foreman' }, { id: 'dev', name: 'Dev', role: 'Developer' }, { id: 'qa', name: 'QA', role: 'Tester' }], workers: { dev: { status: 'thinking', taskId: 't1' } },
      jobs: [{ id: 'j1', status: 'running', taskIds: ['t1'] }], tasks: { t1: { id: 't1', title: 'Page', assignee: 'dev', status: 'running' } } };
    const v = viewOf(deriveCity(s));
    expect(v.agents.mel.room).toBe('lobby');
    expect(v.agents.qa.room).toBe('test');
    expect(v.agents.dev.status).toBe('thinking');
    expect(v.tasks.t1).toMatchObject({ status: 'in_progress', room: 'code', assignee: 'dev' });
  });
});

describe('city layout', () => {
  it('has a room for every builtin room, inside the building, without overlaps', () => {
    expect(Object.keys(ROOMS).sort()).toEqual(['code', 'design', 'library', 'lobby', 'ops', 'review', 'test']);
    for (const [k, r] of Object.entries(ROOMS)) {
      for (const s of SPOTS[k]) expect(roomAt(s.x, s.y), `${k} spot`).toBe(k);
      expect(roomAt((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2)).toBe(k);
    }
    expect(roomAt(8, CORRIDOR_Y)).toBe(null);
    expect(roomAt(-3, -3)).toBe(null);
  });

  it('walks between rooms through the doors and the corridor', () => {
    const to = spotFor('review', 0);
    const p = roomPath('code', spotFor('code', 0), 'review', to);
    expect(p.at(-1)).toEqual(to);
    expect(p.some((q) => q.y === CORRIDOR_Y)).toBe(true);
    expect(p).toContainEqual(roomDoor('review'));
    expect(roomPath('code', null, 'code', to)).toEqual([to]);
  });

  it('puts friend islands apart and bridges them from the plaza side', () => {
    const a = friendCenter(0); const b = friendCenter(1);
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(16);
    const br = bridgeTo(a);
    expect(br.len).toBeGreaterThan(3);
    expect(bridgePoint(br, 0)).toMatchObject({ x: br.a.x, y: br.a.y, z: 0 });
    expect(bridgePoint(br, 0.5).z).toBeGreaterThan(0);
    expect(Math.hypot(br.a.x - HOME.cx, br.a.y - HOME.cy)).toBeLessThan(HOME.r);
    const out = exitPath('code', br);
    expect(out.at(-1)).toMatchObject({ x: br.b.x, y: br.b.y });
    expect(pathLength({ x: 5, y: 2 }, out)).toBeGreaterThan(br.len);
  });
});

describe('city mock', () => {
  afterEach(() => vi.useRealTimers());

  it('plays the demo story with events the engine reducer accepts', () => {
    vi.useFakeTimers();
    const city = mockCity();
    const events = [];
    const frames = [];
    const m = new MockCity({ emit: (e) => { events.push(e); reduceCity(city, e); }, live: (f) => frames.push(f) });
    m.start();
    vi.advanceTimersByTime(60000);
    m.stop();
    const types = new Set(events.map((e) => e.type));
    for (const t of ['city.machine.joined', 'city.agent.joined', 'city.task.created', 'city.task.claimed', 'city.task.hop', 'city.borrow.requested', 'city.borrow.answered', 'city.borrow.turn', 'city.borrow.ended', 'city.task.done', 'city.demo.step']) expect(types.has(t), t).toBe(true);
    expect(events.every((e) => e.demo === true)).toBe(true);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(city.machines[RITA].online).toBe(true);
    expect(Object.values(city.tasks).some((t) => t.status === 'done' && t.title === 'Hero section')).toBe(true);
    expect(frames.some((f) => f.type === 'city.presence')).toBe(true);
    expect(frames.some((f) => f.type === 'city.machine.load')).toBe(true);
  });

  it('answers the UI commands like the engine', async () => {
    vi.useFakeTimers();
    const city = initialCity();
    Object.assign(city, mockCity());
    const m = new MockCity({ emit: (e) => reduceCity(city, e) });
    m.running = true;
    const { task } = await m.command('city.task.create', { title: 'Logo', room: 'design' });
    expect(city.tasks[task.id].room).toBe('design');
    await m.command('city.task.assign', { taskId: task.id, agentId: 'designer' });
    vi.advanceTimersByTime(3000);
    expect(city.tasks[task.id].agentId).toBe('designer');
    await m.command('city.agent.move', { agentId: 'qa', room: 'lobby' });
    expect(city.agents.qa.room).toBe('lobby');
    await m.command('city.agent.memory.add', { agentId: 'qa', text: 'Check the footer' });
    const list = await m.command('city.agent.memory.list', { agentId: 'qa' });
    expect(list.entries.some((x) => x.text === 'Check the footer')).toBe(true);
    expect(city.agents.qa.memory.highlights[0].text).toBe('Check the footer');
    await m.command('city.agent.retire', { agentId: 'dev' });
    expect(city.agents.dev.status).toBe('sleeping');
    await expect(m.command('city.task.create', { title: '  ' })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(m.command('city.nope', {})).rejects.toMatchObject({ code: 'bad_request' });
    m.stop();
  });
});
