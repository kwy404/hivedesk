import { describe, it, expect } from 'vitest';
import { initialCity, reduceCity, replayCity, levelFor, publicMemory, roomForRole, ROOMS, statusForKind, isCityEvent } from '../../src/city/state.js';
import { pickAgent, bidScore } from '../../src/city/router.js';

let seq = 0;
const ev = (type, data) => ({ seq: ++seq, ts: new Date(1_800_000_000_000 + seq * 1000).toISOString(), type, data });

function city() {
  const c = initialCity();
  reduceCity(c, ev('city.started', { city: 1, host: 'm_host0001' }));
  reduceCity(c, ev('city.machine.joined', { machine: { id: 'm_host0001', name: 'My PC', host: true, owner: 'host', brainId: 'local' } }));
  for (const r of ROOMS) reduceCity(c, ev('city.room.added', { room: { ...r } }));
  const agent = (id, specialization, extra = {}) => reduceCity(c, ev('city.agent.joined', { agent: { id, workerId: id, name: id, specialization, level: 1, xp: 0, room: specialization[0], taskId: null, status: 'idle', home: 'm_host0001', ...extra } }));
  agent('mel', ['lobby', 'library']);
  agent('dev', ['code', 'review']);
  agent('qa', ['test', 'review']);
  agent('designer', ['design', 'review'], { level: 3 });
  return c;
}

describe('city state', () => {
  it('levels follow the xp curve', () => {
    expect([0, 24, 25, 74, 75, 149, 150, 250].map(levelFor)).toEqual([1, 1, 2, 2, 3, 3, 4, 5]);
  });

  it('shows only the count and four highlights of a memory, pinned first', () => {
    const list = [1, 2, 3, 4, 5, 6].map((n) => ({ id: `m${n}`, kind: 'fact', text: `fact ${n}`, pinned: n === 1 }));
    const pub = publicMemory(list);
    expect(pub.count).toBe(6);
    expect(pub.highlights.map((h) => h.id)).toEqual(['m1', 'm6', 'm5', 'm4']);
    expect(pub.highlights[0]).not.toHaveProperty('pinned');
  });

  it('maps roles and room kinds', () => {
    expect(['Code reviewer', 'QA tester', 'UI designer', 'Docs writer', 'Release ops', 'Developer'].map(roomForRole)).toEqual(['review', 'test', 'design', 'library', 'ops', 'code']);
    expect(['review', 'test', 'work', 'board'].map(statusForKind)).toEqual(['in_review', 'in_test', 'in_progress', 'in_progress']);
    expect(isCityEvent({ type: 'worker.status' })).toBe(true);
    expect(isCityEvent({ type: 'job.done' })).toBe(false);
  });

  it('holds and frees agents as a task hops, and maps the crew worker status', () => {
    const c = city();
    reduceCity(c, ev('city.task.created', { task: { id: 'ct_1', title: 'x', pipeline: ['code', 'review', 'test'], stage: 0, room: 'code', status: 'open', agentId: null, createdBy: { kind: 'user' } } }));
    reduceCity(c, ev('city.task.claimed', { taskId: 'ct_1', agentId: 'dev', room: 'code' }));
    expect(c.agents.dev.taskId).toBe('ct_1');
    expect(c.tasks.ct_1.status).toBe('claimed');
    reduceCity(c, ev('worker.status', { workerId: 'dev', status: 'thinking' }));
    expect(c.agents.dev.status).toBe('thinking');
    reduceCity(c, ev('worker.status', { workerId: 'dev', status: 'idle' }));
    expect(c.agents.dev.status).toBe('working');
    reduceCity(c, ev('city.task.hop', { hop: { id: 'h_1', taskId: 'ct_1', from: 'code', to: 'review', agentId: 'qa' }, task: { id: 'ct_1', room: 'review', stage: 1, status: 'in_review', agentId: 'qa' } }));
    expect(c.agents.dev.taskId).toBe(null);
    expect(c.agents.dev.status).toBe('idle');
    expect(c.agents.qa.taskId).toBe('ct_1');
    reduceCity(c, ev('city.task.verdict', { taskId: 'ct_1', room: 'review', agentId: 'qa', passed: false, issues: ['no title'], by: 'agent' }));
    expect(c.tasks.ct_1.issues).toEqual(['no title']);
    reduceCity(c, ev('city.task.done', { taskId: 'ct_1', by: 'agent' }));
    expect(c.tasks.ct_1).toMatchObject({ status: 'done', stage: 3, agentId: null });
    expect(c.agents.qa.taskId).toBe(null);
    expect(c.hops).toHaveLength(1);
  });

  it('counts borrow turns on the lender and puts a leaving machine offline', () => {
    const c = city();
    reduceCity(c, ev('city.machine.joined', { machine: { id: 'm_rita0001', name: 'Rita', host: false, owner: 'peer:g1', brainId: 'b_friend' } }));
    reduceCity(c, ev('city.agent.joined', { agent: { id: 'm_rita0001:pip', workerId: 'w_1', name: 'Pip', specialization: ['review'], home: 'm_rita0001', status: 'idle' } }));
    expect(c.machines.m_rita0001.agents).toEqual(['m_rita0001:pip']);
    reduceCity(c, ev('city.borrow.requested', { borrow: { id: 'bw_1', agentId: 'dev', from: 'm_host0001', to: 'm_rita0001', status: 'pending', limit: { turns: 2, minutes: 5 } } }));
    reduceCity(c, ev('city.borrow.answered', { borrowId: 'bw_1', accepted: true, limit: { turns: 2, minutes: 5 } }));
    expect(c.machines.m_rita0001.lending.active).toBe(1);
    reduceCity(c, ev('turn.started', { workerId: 'dev', brainId: 'b_friend' }));
    expect(c.agents.dev.brain).toMatchObject({ kind: 'lent', machineId: 'm_rita0001' });
    reduceCity(c, ev('city.borrow.turn', { borrowId: 'bw_1', completionTokens: 7, ms: 3 }));
    expect(c.borrows.bw_1.used).toEqual({ turns: 1, completionTokens: 7, ms: 3 });
    reduceCity(c, ev('city.borrow.ended', { borrowId: 'bw_1', reason: 'stopped', used: c.borrows.bw_1.used }));
    expect(c.machines.m_rita0001.lending).toEqual({ turns: 1, active: 0 });
    reduceCity(c, ev('city.machine.left', { machineId: 'm_rita0001', reason: 'left' }));
    expect(c.machines.m_rita0001.online).toBe(false);
    expect(c.agents['m_rita0001:pip'].status).toBe('offline');
  });

  it('replays to the same state, also on top of a snapshot', () => {
    seq = 0;
    const events = [];
    const c = initialCity();
    const push = (type, data) => { const e = ev(type, data); events.push(e); reduceCity(c, e); };
    push('city.started', { host: 'm_host0001' });
    push('city.machine.joined', { machine: { id: 'm_host0001', host: true } });
    push('city.room.added', { room: { ...ROOMS[2] } });
    const snap = JSON.parse(JSON.stringify(c));
    push('city.task.created', { task: { id: 'ct_1', title: 'x', pipeline: ['code'], stage: 0, room: 'code', status: 'open' } });
    push('city.task.done', { taskId: 'ct_1' });
    expect(replayCity(events)).toEqual(c);
    expect(replayCity(events, Infinity, snap)).toEqual(c);
    expect(replayCity(events, 3).tasks).toEqual({});
  });
});

describe('city routing', () => {
  const ctx = (busy = []) => ({ busy: (id) => busy.includes(id), load: () => 0, canThink: () => true });
  const task = (pipeline, stage, extra = {}) => ({ id: 'ct_1', pipeline, stage, status: 'open', verdicts: [], ...extra });

  it('scores skill, level and load', () => {
    expect(bidScore({ skill: 1, level: 1, load: 0 })).toBe(0.775);
    expect(bidScore({ skill: 0.6, level: 10, load: 1 })).toBe(0.61);
  });

  it('gives a room to its specialist, never to the author for review, and Mel only the Lobby', () => {
    const c = city();
    expect(pickAgent(c, task(['code'], 0), ctx()).agent.id).toBe('dev');
    expect(pickAgent(c, task(['lobby'], 0), ctx()).agent.id).toBe('mel');
    const review = pickAgent(c, task(['code', 'review'], 1, { author: 'dev' }), ctx());
    expect(review.agent.id).toBe('designer'); // level 3 beats QA's level 1 at the same skill
    expect(review.bid.rivals).toBe(1);
    expect(pickAgent(c, task(['code'], 0), ctx(['dev']))).toBe(null);
    expect(pickAgent(c, task(['code'], 0, { wantAgent: 'qa' }), ctx()).agent.id).toBe('qa');
    c.agents.dev.status = 'sleeping';
    expect(pickAgent(c, task(['code'], 0), ctx())).toBe(null);
  });
});
