import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { rig, scripted, page, friendBrain, joinRita, RITA, userTask } from './rig.js';
import { reduceCity } from '../../src/city/state.js';
import { City } from '../../src/city/index.js';
import { tmpDir, waitFor } from '../helpers.js';

const HELLO = { 'Make a hello page': [{ tool: 'write_file', args: { path: 'hello.html', content: page() } }, { tool: 'done', args: { summary: 'hello.html is written.' } }] };
const done = (r, id) => waitFor(() => ['done', 'blocked', 'cancelled'].includes(r.s.tasks[id]?.status) && r.s.tasks[id], { timeout: 15000 });

describe('agents', () => {
  it('turns the crew into persistent agents with rooms, and keeps their level and memory across projects', async () => {
    const home = tmpDir();
    const a = rig({ home, respond: scripted({ scripts: HELLO }) });
    expect(Object.keys(a.s.agents).sort()).toEqual(['designer', 'dev', 'mel', 'qa', 'writer']);
    expect(a.s.agents.dev).toMatchObject({ workerId: 'dev', level: 1, xp: 0, room: 'code', status: 'idle', home: a.city.machineId, specialization: ['code', 'review', 'ops'] });
    expect(Object.keys(a.s.rooms).sort()).toEqual(['code', 'design', 'library', 'lobby', 'ops', 'review', 'test']);
    expect(a.s.machines[a.city.machineId]).toMatchObject({ host: true, owner: 'host', online: true, brainId: 'local' });
    await a.run('city.agent.memory.add', { agentId: 'dev', text: 'The user likes plain CSS', kind: 'preference', pinned: true });
    const t = (await a.run('city.task.create', { title: 'Make a hello page', room: 'code' })).task;
    await done(a, t.id);
    expect(a.s.agents.dev.xp).toBe(15);
    expect(a.s.agents.dev.level).toBe(1);
    expect(a.s.agents.dev.memory.count).toBe(2);
    // The pinned preference went into Dev's prompt.
    expect(a.brain.calls.some((c) => c.messages.some((m) => m.content.includes('Dev remembers: The user likes plain CSS')))).toBe(true);
    await a.city.close();
    const saved = JSON.parse(fs.readFileSync(path.join(home, 'city', 'agents', 'dev.json'), 'utf8'));
    expect(saved).toMatchObject({ id: 'dev', xp: 15 });
    expect(saved.memoryEntries.map((m) => m.kind)).toEqual(['preference', 'task']);
    // Another project on the same machine: the same Dev, same xp and memory, same machine id.
    const b = rig({ home });
    expect(b.city.machineId).toBe(a.city.machineId);
    expect(b.s.agents.dev).toMatchObject({ xp: 15, memory: { count: 2 } });
    expect((await b.run('city.agent.memory.list', { agentId: 'dev' })).entries[0].text).toBe('The user likes plain CSS');
    await b.city.close();
  });

  it('hires, edits, moves, puts to sleep and retires agents', async () => {
    const r = rig();
    const { agent } = await r.run('city.agent.hire', { name: 'Ivy', role: 'Code reviewer', specialization: ['review', 'test'], tools: ['list_files', 'read_file', 'check'] });
    expect(agent).toMatchObject({ name: 'Ivy', room: 'review', specialization: ['review', 'test'], permissions: { shell: false, write: false } });
    expect(r.bus.state.crew.some((w) => w.id === agent.workerId)).toBe(true);
    await r.run('city.agent.update', { agentId: agent.id, name: 'Ivy B', tools: ['list_files', 'read_file', 'check', 'run'] });
    expect(r.s.agents[agent.id]).toMatchObject({ name: 'Ivy B', permissions: { shell: true } });
    expect(r.bus.state.crew.find((w) => w.id === agent.workerId).name).toBe('Ivy B');
    await r.run('city.agent.move', { agentId: agent.id, room: 'library' });
    expect(r.s.agents[agent.id].room).toBe('library');
    await r.run('city.agent.retire', { agentId: 'dev' });
    expect(r.s.agents.dev).toMatchObject({ status: 'sleeping', retired: false });
    await r.run('city.agent.wake', { agentId: 'dev' });
    expect(r.s.agents.dev.status).toBe('idle');
    await r.run('city.agent.retire', { agentId: agent.id });
    await waitFor(() => r.s.agents[agent.id].retired);
    expect(r.bus.state.crew.some((w) => w.id === agent.workerId)).toBe(false);
    await expect(r.run('city.agent.update', { agentId: 'dev', tools: ['run'] })).rejects.toMatchObject({ code: 'bad_request' });
    await r.city.close();
  });
});

describe('the task bus and the pipeline', () => {
  it('flows a Design task through Design, Code, Review and Test to done, with a hop event for every move', async () => {
    const respond = scripted({ scripts: HELLO });
    const r = rig({ respond });
    const { task } = await r.run('city.task.create', { title: 'Make a hello page', detail: 'A friendly page.', room: 'design' });
    expect(task).toMatchObject({ pipeline: ['design', 'code', 'review', 'test'], stage: 0, room: 'design', status: 'open', createdBy: { kind: 'user' } });
    const t = await done(r, task.id);
    expect(t.status).toBe('done');
    expect(t.spec).toBe('A hello page in hello.html.');
    expect(t.criteria).toEqual(['hello.html says hello']);
    expect(t.files).toEqual(['hello.html']);
    expect(t.author).toBe('dev');
    const hops = r.of('city.task.hop').map((e) => e.data.hop.to);
    expect(hops).toEqual(['code', 'review', 'test']);
    const claims = r.of('city.task.claimed').map((e) => [e.data.agentId, e.data.room]);
    expect(claims).toEqual([['designer', 'design'], ['dev', 'code'], ['designer', 'review'], ['qa', 'test']]);
    expect(r.of('city.task.claimed')[0].data.bid).toMatchObject({ skill: 1 });
    expect(t.verdicts.map((v) => [v.room, v.passed, v.by])).toEqual([['review', true, 'agent'], ['test', true, 'checks']]);
    // The Code hop is a crew job with one task for Dev, no planner and no report.
    const job = r.bus.state.jobs[0];
    expect(job).toMatchObject({ cityTaskId: task.id, status: 'done' });
    expect(r.of('job.report')).toHaveLength(0);
    expect(respond.seen.some((x) => x.options.schema?.properties?.tasks)).toBe(false);
    // The reviewer read the diff.
    const review = respond.seen.find((x) => x.options.schema?.properties?.approved);
    expect(review.messages[1].content).toContain('--- hello.html');
    expect(r.s.agents.designer.xp).toBe(10 + 4);
    expect(r.s.agents.qa.xp).toBe(3);
    expect(r.s.agents.dev.stats.done).toBe(1);
    await r.city.close();
  });

  it('loops back to Code when Review asks for changes, and blocks after three loops', async () => {
    let reviews = 0;
    const r = rig({ respond: scripted({ scripts: HELLO, review: () => (++reviews === 1 ? { approved: false, issues: ['Add a footer to hello.html'] } : { approved: true, issues: [] }) }) });
    const { task } = await r.run('city.task.create', { title: 'Make a hello page', room: 'code' });
    const t = await done(r, task.id);
    expect(t).toMatchObject({ status: 'done', loops: 1 });
    const loop = r.of('city.task.hop').find((e) => e.data.task.loops === 1);
    expect(loop.data).toMatchObject({ hop: { from: 'review', to: 'code' }, task: { wantAgent: 'dev', issues: ['Add a footer to hello.html'] } });
    // The second Code hop got the issues in its task.
    const fix = r.brain.calls.filter((c) => userTask(c.messages) === 'Make a hello page').map((c) => c.messages.find((m) => m.role === 'user').content);
    expect(fix.some((text) => text.includes('Add a footer to hello.html'))).toBe(true);
    await r.city.close();

    const never = rig({ respond: scripted({ scripts: HELLO, review: () => ({ approved: false, issues: ['Still wrong'] }) }) });
    const b = (await never.run('city.task.create', { title: 'Make a hello page', pipeline: ['code', 'review'] })).task;
    const tb = await done(never, b.id);
    expect(tb.status).toBe('blocked');
    expect(tb.reason).toMatch(/after 3 loops: Still wrong/);
    expect(never.of('city.task.hop').filter((e) => e.data.hop.to === 'code')).toHaveLength(3);
    // A blocked task can be retried by the user.
    await never.run('city.task.retry', { taskId: b.id });
    expect(never.of('city.task.hop').find((e) => e.data.hop.reason === 'retried').data.task).toMatchObject({ status: 'open', loops: 0 });
    await never.city.close();
  });

  it('fails a test on broken files, and waits for the user in a room that needs approval', async () => {
    const broken = { 'Make a hello page': [{ tool: 'write_file', args: { path: 'hello.html', content: '<p>no doctype' } }, { tool: 'done', args: { summary: 'ok' } }] };
    const r = rig({ respond: scripted({ scripts: broken }) });
    await r.run('city.room.update', { roomId: 'review', requireApproval: true, mode: 'checks' });
    const { task } = await r.run('city.task.create', { title: 'Make a hello page', room: 'code' });
    await waitFor(() => r.s.tasks[task.id].awaiting === 'review');
    expect(r.of('city.task.awaiting')).toHaveLength(1);
    const v = r.s.tasks[task.id].verdicts[0];
    expect(v).toMatchObject({ room: 'review', passed: false, by: 'checks' });
    // The user approves anyway: on to Test, where the checks fail and the task loops back.
    await r.run('city.task.approve', { taskId: task.id });
    await waitFor(() => r.s.tasks[task.id].verdicts.some((x) => x.room === 'test'));
    const test = r.s.tasks[task.id].verdicts.find((x) => x.room === 'test');
    expect(test.passed).toBe(false);
    expect(test.issues.join(' ')).toMatch(/doctype/);
    await waitFor(() => r.s.tasks[task.id].loops === 1);
    await r.run('city.task.cancel', { taskId: task.id });
    expect(r.s.tasks[task.id].status).toBe('cancelled');
    await r.city.close();
  });

  it('lets the user hand a task to an agent and move it between rooms', async () => {
    const r = rig({ respond: scripted({ scripts: HELLO }) });
    await r.run('city.agent.retire', { agentId: 'dev' }); // Dev sleeps: the Code room has nobody else
    const { task } = await r.run('city.task.create', { title: 'Make a hello page', room: 'code' });
    await new Promise((res) => setTimeout(res, 30));
    expect(r.s.tasks[task.id].status).toBe('open');
    await r.run('city.task.assign', { taskId: task.id, agentId: 'writer' });
    const t = await done(r, task.id);
    expect(t.author).toBe('writer');
    const moved = (await r.run('city.task.create', { title: 'Make a hello page', room: 'code', agentId: 'writer' })).task;
    expect(moved.wantAgent).toBe('writer');
    await r.run('city.task.move', { taskId: moved.id, room: 'test' });
    expect(r.s.tasks[moved.id]).toMatchObject({ stage: 2, room: 'test' });
    await r.city.close();
  });

  it("mirrors Mel's planner tasks, uses the crew QA as the Test hop and its fix rounds as loops", async () => {
    const plan = { summary: 'Two tasks.', tasks: [
      { title: 'Write hello', detail: 'Write hello.html.', assignee: 'dev', dependsOn: [] },
      { title: 'Check it', detail: 'Check hello.html.', assignee: 'qa', dependsOn: [0] }
    ] };
    const scripts = {
      'Write hello': [{ tool: 'write_file', args: { path: 'hello.html', content: page() } }, { tool: 'done', args: { summary: 'written' } }],
      'Check it': [{ tool: 'report', args: { passed: false, issues: ['hello.html: add a footer'] } }],
      'Fix the QA issues (round 1)': [{ tool: 'read_file', args: { path: 'hello.html' } }, { tool: 'write_file', args: { path: 'hello.html', content: page('<p>Hello</p><footer>Bye</footer>') } }, { tool: 'done', args: { summary: 'footer' } }],
      'Check the fixes': [{ tool: 'report', args: { passed: true, issues: [] } }]
    };
    const r = rig({ respond: scripted({ scripts, plan }) });
    const { done: jobDone } = r.hive.createJob({ request: 'a hello page' });
    await jobDone;
    const tasks = Object.values(r.s.tasks);
    expect(tasks).toHaveLength(1); // the QA tasks are the Test room, not tasks of their own
    const t = await done(r, tasks[0].id);
    expect(t).toMatchObject({ status: 'done', loops: 1, link: { jobId: 'j_1', taskId: 't_1_1' }, createdBy: { kind: 'planner', id: 'mel' }, author: 'dev' });
    expect(t.verdicts.map((v) => [v.room, v.passed, v.by])).toEqual([['review', true, 'checks'], ['test', false, 'qa'], ['review', true, 'checks'], ['test', true, 'qa']]);
    expect(r.of('city.task.hop').map((e) => e.data.hop.to)).toEqual(['review', 'test', 'code', 'review', 'test']);
    expect(r.s.agents.qa.stats.tests).toBe(2);
    // The old job API is unchanged.
    expect(r.bus.state.jobs[0].status).toBe('done');
    await r.city.close();
  });

  it('lets Mel plan a Lobby task into crew tasks, and finishes it when they are done', async () => {
    const plan = { summary: 'x', tasks: [{ title: 'Make a hello page', detail: 'hello.html', assignee: 'dev', dependsOn: [] }, { title: 'Write the README', detail: 'README.md', assignee: 'writer', dependsOn: [0], kind: 'docs' }] };
    const scripts = { ...HELLO, 'Write the README': [{ tool: 'write_file', args: { path: 'README.md', content: '# Hello\n' } }, { tool: 'done', args: { summary: 'ok' } }] };
    const r = rig({ respond: scripted({ scripts, plan }) });
    const { task } = await r.run('city.task.create', { title: 'A hello site', detail: 'with a README' });
    expect(task.pipeline).toEqual(['lobby']);
    const t = await done(r, task.id);
    expect(t.status).toBe('done');
    expect(t.children).toHaveLength(2);
    expect(t.children.map((id) => [r.s.tasks[id].status, r.s.tasks[id].pipeline[0], r.s.tasks[id].parent])).toEqual([['done', 'code', task.id], ['done', 'library', task.id]]);
    expect(r.of('city.task.claimed')[0].data.agentId).toBe('mel');
    await r.city.close();
  });
});

describe('machines and GPU borrowing', () => {
  it('adds a friend building with its agent, which thinks only on its own machine', async () => {
    const r = rig();
    r.scheduler.addBrain(friendBrain());
    const res = await joinRita(r);
    expect(res.agents).toEqual(['m_rita0001:pip']);
    const m = r.s.machines.m_rita0001;
    expect(m).toMatchObject({ name: "Rita's PC", owner: 'peer:g1', online: true, brainId: 'b_friend', via: 'words', agents: ['m_rita0001:pip'] });
    const pip = r.s.agents['m_rita0001:pip'];
    expect(pip).toMatchObject({ home: 'm_rita0001', level: 2, xp: 30, brain: { kind: 'remote' }, tools: ['list_files', 'read_file', 'check'] });
    expect(r.scheduler.brains.get('b_friend').brain.only).toEqual(new Set([pip.workerId]));
    expect(r.scheduler.prefs.get(pip.workerId)).toBe('b_friend');
    // The host's own crew does not run on the friend's brain.
    const turn = await r.scheduler.turn({ workerId: 'dev', messages: [{ role: 'user', content: 'hi' }] });
    expect(turn).toBeTruthy();
    expect(r.of('turn.ended').at(-1).data.brainId).toBe('local');
    // Owners win: nobody else can claim that machine, nobody can claim the host's.
    await expect(r.run('city.machine.join', { as: { id: 'g2', name: 'Eve' }, machine: { id: 'm_rita0001', name: 'Fake' } })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(r.run('city.machine.join', { as: { id: 'g2', name: 'Eve' }, machine: { id: r.city.machineId } })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(r.run('city.machine.update', { as: { id: 'g2', name: 'Eve' }, machineId: 'm_rita0001', name: 'Mine' })).rejects.toMatchObject({ code: 'forbidden' });
    await r.run('city.machine.update', { as: RITA, machineId: 'm_rita0001', name: 'Rita laptop' });
    expect(r.s.machines.m_rita0001.name).toBe('Rita laptop');
    await r.run('city.machine.leave', { as: RITA, machineId: 'm_rita0001' });
    expect(r.s.machines.m_rita0001.online).toBe(false);
    expect(r.s.agents['m_rita0001:pip'].status).toBe('offline');
    // Back again: the same agent and worker.
    await joinRita(r);
    expect(r.s.agents['m_rita0001:pip']).toMatchObject({ status: 'idle', workerId: pip.workerId });
    await r.city.close();
  });

  it('borrows a GPU across the bridge: the lender answers, turns are counted, it ends at its limit', async () => {
    const r = rig();
    r.scheduler.addBrain(friendBrain());
    await joinRita(r);
    const { borrow } = await r.run('city.borrow.request', { agentId: 'dev', machineId: 'm_rita0001', turns: 2, minutes: 5 });
    expect(borrow).toMatchObject({ status: 'pending', from: r.city.machineId, to: 'm_rita0001', limit: { turns: 2, minutes: 5 } });
    await expect(r.run('city.borrow.answer', { borrowId: borrow.id, accept: true })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(r.run('city.borrow.request', { agentId: 'dev', machineId: 'm_rita0001' })).rejects.toMatchObject({ code: 'conflict' });
    await expect(r.run('city.borrow.request', { as: RITA, agentId: 'qa', machineId: 'm_rita0001' })).rejects.toMatchObject({ code: 'forbidden' });
    const ok = await r.run('city.borrow.answer', { as: RITA, borrowId: borrow.id, accept: true, turns: 9 });
    expect(ok.borrow).toMatchObject({ status: 'active', limit: { turns: 2 } });
    for (let i = 0; i < 3; i++) await r.scheduler.turn({ workerId: 'dev', messages: [{ role: 'user', content: `turn ${i}` }] });
    await waitFor(() => r.s.borrows[borrow.id].status === 'ended');
    expect(r.of('turn.ended').filter((e) => e.data.workerId === 'dev').map((e) => e.data.brainId)).toEqual(['b_friend', 'b_friend', 'local']);
    expect(r.of('city.borrow.turn')).toHaveLength(2);
    expect(r.s.borrows[borrow.id]).toMatchObject({ reason: 'limit', used: { turns: 2 } });
    expect(r.s.machines.m_rita0001.lending).toEqual({ turns: 2, active: 0 });
    expect(r.scheduler.prefs.has('dev')).toBe(false);
    expect(r.scheduler.brains.get('b_friend').brain.only.has('dev')).toBe(false);
    // Refused, and stopped by the borrower.
    const b2 = (await r.run('city.borrow.request', { agentId: 'dev', machineId: 'm_rita0001' })).borrow;
    await r.run('city.borrow.answer', { as: RITA, borrowId: b2.id, accept: false });
    expect(r.s.borrows[b2.id]).toMatchObject({ status: 'ended', reason: 'refused' });
    const b3 = (await r.run('city.borrow.request', { agentId: 'dev', machineId: 'm_rita0001' })).borrow;
    await r.run('city.borrow.answer', { as: RITA, borrowId: b3.id, accept: true });
    await r.run('city.borrow.stop', { as: RITA, borrowId: b3.id });
    expect(r.s.borrows[b3.id].reason).toBe('stopped');
    // A friend's agent can borrow the host's GPU too, and the borrow ends when its machine leaves.
    const pip = r.s.agents['m_rita0001:pip'];
    const b4 = (await r.run('city.borrow.request', { as: RITA, agentId: pip.id, machineId: r.city.machineId })).borrow;
    await r.run('city.borrow.answer', { borrowId: b4.id, accept: true });
    expect(r.scheduler.prefs.get(pip.workerId)).toBe('local');
    await r.run('city.machine.leave', { as: RITA, machineId: 'm_rita0001' });
    expect(r.s.borrows[b4.id].reason).toBe('left');
    await r.city.close();
  });

  it('marks a building without a brain when the lent brain detaches', async () => {
    const r = rig();
    r.scheduler.addBrain(friendBrain());
    await joinRita(r);
    const b = (await r.run('city.borrow.request', { agentId: 'dev', machineId: 'm_rita0001' })).borrow;
    await r.run('city.borrow.answer', { as: RITA, borrowId: b.id, accept: true });
    r.scheduler.removeBrain('b_friend', 'disconnected');
    await waitFor(() => r.s.machines.m_rita0001.brainId === null);
    expect(r.s.borrows[b.id].reason).toBe('brain_gone');
    await r.city.close();
  });
});

describe('safety rules for guests', () => {
  it('keeps the host agents, rooms and Ops for the host, and owners win', async () => {
    const r = rig();
    const g = { as: { id: 'g9', name: 'Guest' } };
    await expect(r.run('city.agent.memory.list', { ...g, agentId: 'dev' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(r.run('city.agent.update', { ...g, agentId: 'dev', name: 'Hacked' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(r.run('city.agent.hire', { ...g, name: 'X', role: 'Dev' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(r.run('city.room.add', { ...g, id: 'lab', name: 'Lab' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(r.run('city.agents.local', g)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(r.run('city.task.create', { ...g, title: 'deploy', room: 'ops' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(r.run('city.task.create', { ...g, title: 'deploy', pipeline: ['code', 'ops'] })).rejects.toMatchObject({ code: 'forbidden' });
    const host = (await r.run('city.task.create', { title: 'host task', room: 'review' })).task;
    await expect(r.run('city.task.approve', { ...g, taskId: host.id })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(r.run('city.task.cancel', { ...g, taskId: host.id })).rejects.toMatchObject({ code: 'forbidden' });
    // A guest may not pose as someone else's machine for a borrow answer either (checked above); and floods are cut.
    let limited = null;
    for (let i = 0; i < 45 && !limited; i++) await r.run('city.state', g).catch((err) => { limited = err; });
    expect(limited).toMatchObject({ code: 'rate_limited' });
    await r.city.close();
  });

  it('runs a guest task with approval mode on and without a shell, whatever its room', async () => {
    const respond = scripted({ scripts: HELLO });
    const r = rig({ respond });
    const { task } = await r.run('city.task.create', { as: { id: 'g3', name: 'Kim' }, title: 'Make a hello page', room: 'code' });
    expect(task).toMatchObject({ guest: true, createdBy: { kind: 'guest', id: 'g3', name: 'Kim' } });
    await done(r, task.id);
    const job = r.bus.state.jobs.find((j) => j.cityTaskId === task.id);
    expect(job.approval).toBe(true);
    const work = respond.seen.find((x) => userTask(x.messages) === 'Make a hello page');
    const tools = work.options.schema.oneOf.map((o) => o.properties.tool.const);
    expect(tools).toContain('write_file');
    expect(tools).not.toContain('run');
    expect(tools).not.toContain('delete_file');
    // The guest can approve or cancel its own task.
    const own = (await r.run('city.task.create', { as: { id: 'g3', name: 'Kim' }, title: 'Again', room: 'review' })).task;
    await r.run('city.task.cancel', { as: { id: 'g3', name: 'Kim' }, taskId: own.id });
    expect(r.s.tasks[own.id].status).toBe('cancelled');
    await r.city.close();
  });

  it('cuts every agent to the tools of its room', () => {
    const r = rig();
    const dev = r.bus.state.crew.find((w) => w.id === 'dev');
    r.city._createTask({ title: 'x', pipeline: ['review'], createdBy: { kind: 'user', id: 'user' } });
    const ct = Object.values(r.s.tasks)[0];
    const adapted = r.hive.adaptWorker(dev, { id: 't_9_1' }, { cityTaskId: ct.id });
    expect(adapted.tools).toEqual(['list_files', 'read_file', 'check']);
    expect(r.hive.adaptWorker(dev, { id: 't_x' }, { id: 'j_x' })).toBe(dev);
    r.city.close();
  });
});

describe('replication and persistence', () => {
  it('gives a late joiner the snapshot plus the tail, then only the tail', async () => {
    const r = rig({ respond: scripted({ scripts: HELLO }) });
    const { task } = await r.run('city.task.create', { title: 'Make a hello page', room: 'code' });
    await done(r, task.id);
    const first = await r.run('city.sync', {});
    expect(first.snapshotSeq).toBeGreaterThan(0);
    expect(first.tail.length).toBeGreaterThan(5);
    expect(first.tail.every((e) => e.type.startsWith('city.') || e.type === 'worker.status' || e.type === 'turn.started')).toBe(true);
    const mirror = JSON.parse(JSON.stringify(first.snapshot));
    for (const e of first.tail) reduceCity(mirror, e);
    expect(mirror.tasks).toEqual(r.s.tasks);
    expect(mirror.agents).toEqual(r.s.agents);
    const again = await r.run('city.sync', { since: first.lastSeq });
    expect(again.snapshot).toBeUndefined();
    expect(again.tail).toEqual([]);
    await r.city.close();
    expect(fs.existsSync(path.join(r.dir, 'city', 'snapshot.json'))).toBe(true);
  });

  it('survives a restart: friends go offline, borrows end, unfinished tasks open again and finish', async () => {
    const dir = tmpDir();
    const home = tmpDir();
    const hang = (messages, options) => (options.schema?.properties?.approved ? new Promise(() => {}) : scripted({ scripts: HELLO })(messages, options));
    const a = rig({ dir, home, respond: hang });
    a.scheduler.addBrain(friendBrain('b_friend', hang));
    await joinRita(a);
    const b = (await a.run('city.borrow.request', { agentId: 'qa', machineId: 'm_rita0001' })).borrow;
    const { task } = await a.run('city.task.create', { title: 'Make a hello page', room: 'code', criteria: ['says hello'] });
    await waitFor(() => a.s.tasks[task.id].status === 'in_review');
    // hivedesk stops here (no close: like a crash).
    const r = rig({ dir, home, respond: scripted({ scripts: HELLO }) });
    expect(r.s.machines.m_rita0001.online).toBe(false);
    expect(r.s.borrows[b.id]).toMatchObject({ status: 'ended', reason: 'stopped' });
    const restart = r.of('city.task.hop').find((e) => e.data.hop.reason.includes('restarted'));
    expect(restart.data.hop).toMatchObject({ taskId: task.id, to: 'review', by: 'system' });
    const t = await done(r, task.id);
    expect(t).toMatchObject({ status: 'done', criteria: ['says hello'], files: ['hello.html'] });
    expect(r.s.agents.dev.xp).toBeGreaterThanOrEqual(10);
    await r.city.close();
  });

  it('sends cursors as live frames, at most 15 a second per person', async () => {
    let clock = 1_000_000;
    const r = rig();
    r.city.now = () => clock;
    const got = [];
    r.bus.onLive((type, data) => { if (type.startsWith('city.presence')) got.push({ type, data }); });
    for (let i = 0; i < 20; i++) await r.run('city.presence', { x: i, y: 2, room: 'code' });
    expect(got).toHaveLength(15);
    expect(got[0].data).toMatchObject({ id: 'h', name: 'You', x: 0, y: 2, room: 'code' });
    clock += 1000;
    await r.run('city.presence', { as: RITA, x: 1.234, y: 5 });
    expect(got.at(-1).data).toMatchObject({ id: 'g1', name: 'Rita', x: 1.23 });
    await r.run('city.presence', { as: RITA, left: true });
    expect(got.at(-1)).toEqual({ type: 'city.presence.left', data: { id: 'g1' } });
    expect(r.bus.events.some((e) => e.type.startsWith('city.presence'))).toBe(false);
    await r.city.close();
  });

  it('adds extension rooms that tasks can go through, and protects the builtin ones', async () => {
    const r = rig({ respond: scripted({ scripts: { 'Polish it': HELLO['Make a hello page'] } }) });
    const { room } = await r.run('city.room.add', { id: 'lab', name: 'Lab', kind: 'work', tools: ['list_files', 'read_file', 'write_file'], ext: 'my-ext' });
    expect(room).toMatchObject({ builtin: false, kind: 'work', ext: 'my-ext' });
    await r.run('city.agent.update', { agentId: 'designer', specialization: ['design', 'lab'] });
    const { task } = await r.run('city.task.create', { title: 'Polish it', room: 'lab' });
    expect(task.pipeline).toEqual(['lab', 'review', 'test']);
    const t = await done(r, task.id);
    expect(t).toMatchObject({ status: 'done', author: 'designer' });
    await expect(r.run('city.room.remove', { roomId: 'code' })).rejects.toMatchObject({ code: 'bad_request' });
    await r.run('city.room.remove', { roomId: 'lab' });
    expect(r.s.rooms.lab).toBeUndefined();
    await r.city.close();
  });
});

describe('the store', () => {
  it('keeps a stable machine id and safe agent file names', async () => {
    const { CityStore, agentFileName } = await import('../../src/city/store.js');
    const home = tmpDir();
    const a = new CityStore({ home }).machine();
    expect(a.id).toMatch(/^m_[0-9a-f]{8}$/);
    expect(new CityStore({ home }).machine().id).toBe(a.id);
    expect(agentFileName('m_x:../../evil')).toBe('m_x_.._.._evil.json');
    expect(new CityStore({}).loadAgents()).toEqual([]);
    expect(City).toBeTypeOf('function');
  });
});
