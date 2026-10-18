// What the scene draws comes from state: loop arcs from the hops, the Test light from the last QA
// verdict, the pipeline order from the city, and the 1.0 task and agent fields.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { viewOf } from '../../ui/city/model.js';
import { ROOMS as LAYOUT, SPOTS, roomAt } from '../../ui/city/layout.js';
import { initialCity, reduceCity, ROOMS } from '../../src/city/state.js';

let seq = 0;
const ev = (type, data) => ({ seq: ++seq, ts: new Date(1_800_000_000_000 + seq * 1000).toISOString(), type, data });

function city() {
  const c = initialCity();
  reduceCity(c, ev('city.started', { host: 'm_h' }));
  reduceCity(c, ev('city.machine.joined', { machine: { id: 'm_h', name: 'PC', host: true, owner: 'host' } }));
  for (const r of ROOMS) reduceCity(c, ev('city.room.added', { room: { ...r } }));
  for (const [id, spec] of [['dev', ['code']], ['qa', ['test']], ['ivy', ['review']]]) reduceCity(c, ev('city.agent.joined', { agent: { id, workerId: id, name: id, specialization: spec, room: spec[0], status: 'idle', home: 'm_h', tools: ['read_file'], stats: { done: 0 } } }));
  reduceCity(c, ev('city.task.created', { task: { id: 'ct_1', title: 'Page', pipeline: ['code', 'test', 'review'], stage: 0, room: 'code', status: 'open', createdBy: { kind: 'user' } } }));
  return c;
}

describe('the City view of 1.0 state', () => {
  it('lays the back row out in the pipeline order, Design, Code, Test, Review', () => {
    const back = Object.entries(LAYOUT).filter(([, r]) => r.row === 'back').sort((a, b) => a[1].x0 - b[1].x0).map(([k]) => k);
    expect(back).toEqual(['design', 'code', 'test', 'review']);
    for (const k of ['test', 'review']) for (const s of SPOTS[k]) expect(roomAt(s.x, s.y)).toBe(k);
    const v = viewOf(city());
    expect(v.pipeline).toEqual(['design', 'code', 'test', 'review']);
    expect(Object.keys(v.rooms).slice(0, 5)).toEqual(['lobby', 'design', 'code', 'test', 'review']);
    expect(v.rooms.review.role).toBe('reviewer');
  });

  it('draws a loop arc only while a task that was sent back is in the work room', () => {
    const c = city();
    reduceCity(c, ev('city.task.claimed', { taskId: 'ct_1', agentId: 'dev', room: 'code' }));
    reduceCity(c, ev('city.task.hop', { hop: { id: 'h1', taskId: 'ct_1', from: 'code', to: 'test', loop: 0 }, task: { id: 'ct_1', room: 'test', stage: 1, status: 'open', agentId: null } }));
    reduceCity(c, ev('city.task.hop', { hop: { id: 'h2', taskId: 'ct_1', from: 'test', to: 'review', loop: 0 }, task: { id: 'ct_1', room: 'review', stage: 2, status: 'open', agentId: null } }));
    expect(viewOf(c).loops).toEqual([]);
    reduceCity(c, ev('city.task.verdict', { taskId: 'ct_1', room: 'review', agentId: 'ivy', passed: false, issues: ['footer'] }));
    reduceCity(c, ev('city.task.hop', { hop: { id: 'h3', taskId: 'ct_1', from: 'review', to: 'code', loop: 1, reason: 'changes requested: footer' }, task: { id: 'ct_1', room: 'code', stage: 0, status: 'open', loops: 1, agentId: null } }));
    let v = viewOf(c);
    expect(v.loops).toEqual([{ taskId: 'ct_1', from: 'review', to: 'code', n: 1, max: 3, reason: 'changes requested: footer' }]);
    expect(v.tasks.ct_1).toMatchObject({ state: 'queued', loops: 1 });
    expect(v.tasks.ct_1.history.map((x) => x.to)).toEqual(['queued', 'assigned', 'queued']);
    reduceCity(c, ev('city.task.hop', { hop: { id: 'h4', taskId: 'ct_1', from: 'code', to: 'test', loop: 1 }, task: { id: 'ct_1', room: 'test', stage: 1, status: 'open' } }));
    v = viewOf(c);
    expect(v.loops).toEqual([]);
  });

  it('lights the Test lamp from the last QA verdict and while QA is testing', () => {
    const c = city();
    let v = viewOf(c);
    expect(v.qa).toMatchObject({ running: false, last: null });
    reduceCity(c, ev('city.agent.status', { agentId: 'qa', status: 'testing' }));
    expect(viewOf(c).qa.running).toBe(true);
    reduceCity(c, ev('city.task.verdict', { taskId: 'ct_1', room: 'test', agentId: 'qa', passed: false, issues: ['npm test failed with exit code 1'], by: 'qa' }));
    reduceCity(c, ev('city.agent.status', { agentId: 'qa', status: 'idle' }));
    v = viewOf(c);
    expect(v.qa).toMatchObject({ running: false, last: false });
  });

  it('gives the panels the 1.0 agent fields', () => {
    const v = viewOf(city());
    expect(v.agents.dev).toMatchObject({ machineId: 'm_h', thinksOn: { kind: 'local' }, history: { done: 0, lastTasks: [] } });
  });

  it('keeps every number in the City scene state driven: no random load, no invented progress', () => {
    const scene = fs.readFileSync(new URL('../../ui/city/scene.js', import.meta.url), 'utf8');
    expect(scene).not.toMatch(/mm\.load/);
    expect(scene).not.toMatch(/idleSince > 14/);
    expect(scene).not.toMatch(/Math\.floor\(this\.now \* 0\.5\) % 4/);
    const office = fs.readFileSync(new URL('../../ui/office/office.js', import.meta.url), 'utf8');
    expect(office).not.toMatch(/running \* 0\.4/);
    expect(office).not.toMatch(/\? 4 : 0/);
    const oscene = fs.readFileSync(new URL('../../ui/office/scene.js', import.meta.url), 'utf8');
    expect(oscene).not.toMatch(/issues found/);
    expect(oscene).not.toMatch(/dependsOn \|\| \[\]\)\.includes\(t\.id\)/);
    expect(oscene).toMatch(/case 'task\.handoff'/);
  });
});
