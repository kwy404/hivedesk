// Hive City 1.0 on the engine: the pipeline order, QA on the project's tests, the guest rules of the
// Phase 0 hotfix (SEC-1, SEC-2), onboarding, real tokens per second and the 1.0 agent fields.
import { describe, it, expect } from 'vitest';
import { rig, scripted, page, friendBrain, RITA } from './rig.js';
import { waitFor } from '../helpers.js';

const HELLO = { 'Make a hello page': [{ tool: 'write_file', args: { path: 'hello.html', content: page() } }, { tool: 'done', args: { summary: 'hello.html is written.' } }] };
const ended = (r, id) => waitFor(() => ['done', 'blocked', 'cancelled'].includes(r.s.tasks[id]?.status) && r.s.tasks[id], { timeout: 30000 });
const join = (r, extra = {}) => r.run('city.machine.join', {
  as: RITA, machine: { id: 'm_rita0001', name: "Rita's PC" },
  agents: [{ id: 'pip', name: 'Pip', role: 'Reviewer', specialization: ['review', 'test'], tools: ['list_files', 'read_file', 'write_file', 'edit_file', 'run', 'check'] }],
  via: 'words', ...extra
});

describe('guests cannot bind the host models (SEC-1)', () => {
  it('links a building only to a remote brain that guest attached itself', async () => {
    const r = rig();
    // Brains with no lender recorded (brain.owner is how the 0.2.1 lend bridge records one).
    r.scheduler.addBrain(friendBrain('b_friend', scripted(), null));
    r.scheduler.addBrain(friendBrain('b_other', scripted(), null));
    for (const brainId of ['local', 'b_friend', 'b_nope']) {
      await join(r, { brainId });
      expect(r.s.machines.m_rita0001.brainId).toBe(null);
    }
    expect(r.scheduler.brains.get('local').brain.only).toBeFalsy();
    // another guest's bridge attached b_other: Rita cannot take it
    r.city.noteBrainOwner('b_other', 'peer:g2');
    await join(r, { brainId: 'b_other' });
    expect(r.s.machines.m_rita0001.brainId).toBe(null);
    await expect(r.run('city.machine.update', { as: RITA, machineId: 'm_rita0001', brainId: 'b_other' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(r.run('city.machine.update', { as: RITA, machineId: 'm_rita0001', brainId: 'local' })).rejects.toMatchObject({ code: 'forbidden' });
    // her own bridge's brain links
    r.city.noteBrainOwner('b_friend', 'peer:g1');
    await r.run('city.machine.update', { as: RITA, machineId: 'm_rita0001', brainId: 'b_friend' });
    expect(r.s.machines.m_rita0001.brainId).toBe('b_friend');
    // the host can never be noted as a guest owner
    r.city.noteBrainOwner('local', 'host');
    expect(r.city.brainOwners.has('local')).toBe(false);
    await r.city.close();
  });
});

describe("a friend's agents are read only until the host grants more (SEC-2)", () => {
  it('cuts contributed tools to reading and checking, and only the host grants writes, never a shell', async () => {
    const r = rig();
    await join(r);
    const id = 'm_rita0001:pip';
    expect(r.s.agents[id].tools).toEqual(['list_files', 'read_file', 'check']);
    expect(r.s.agents[id].permissions).toMatchObject({ write: false, shell: false, tools: ['list_files', 'read_file', 'check'] });
    await expect(r.run('city.agent.grant', { as: RITA, agentId: id, tools: ['write_file'] })).rejects.toMatchObject({ code: 'forbidden' });
    await r.run('city.agent.grant', { agentId: id, tools: ['write_file', 'run', 'delete_file'] });
    expect(r.s.agents[id].tools).toEqual(['list_files', 'read_file', 'check', 'write_file']);
    expect(r.s.agents[id].permissions.write).toBe(true);
    // the grant survives the friend coming back
    await join(r);
    expect(r.s.agents[id].tools).toContain('write_file');
    expect(r.s.agents[id].tools).not.toContain('run');
    await expect(r.run('city.agent.grant', { agentId: 'dev', tools: ['run'] })).rejects.toMatchObject({ code: 'bad_request' });
    await r.city.close();
  });
});

describe('the pipeline', () => {
  it('starts each task from its room in the city pipeline, and the host can change the order', async () => {
    const r = rig();
    expect(r.s.pipeline).toEqual(['design', 'code', 'test', 'review']);
    expect(r.s.rooms.design.role).toBe('architect');
    expect(r.s.rooms.code.role).toBe('developer');
    expect(r.s.rooms.test.role).toBe('qa');
    expect(r.s.rooms.review.role).toBe('reviewer');
    const pipe = async (room) => (await r.run('city.task.create', { title: `in ${room}`, room })).task.pipeline;
    expect(await pipe('code')).toEqual(['code', 'test', 'review']);
    expect(await pipe('library')).toEqual(['library', 'test', 'review']);
    await r.run('city.pipeline.set', { pipeline: ['design', 'code', 'review'] });
    expect(await pipe('design')).toEqual(['design', 'code', 'review']);
    await expect(r.run('city.pipeline.set', { pipeline: ['review', 'test'] })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(r.run('city.pipeline.set', { pipeline: ['code', 'code'] })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(r.run('city.pipeline.set', { pipeline: ['code', 'ops'] })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(r.run('city.pipeline.set', { as: RITA, pipeline: ['code'] })).rejects.toMatchObject({ code: 'forbidden' });
    await r.run('city.room.update', { roomId: 'library', role: 'architect' });
    expect(r.s.rooms.library.role).toBe('architect');
    await r.city.close();
  });

  it('loops a failed review back to the author, with the loop in the task history', async () => {
    let reviews = 0;
    const r = rig({ respond: scripted({ scripts: HELLO, review: () => (++reviews === 1 ? { approved: false, issues: ['Add a footer'] } : { approved: true, issues: [] }) }) });
    const { task } = await r.run('city.task.create', { title: 'Make a hello page', room: 'code' });
    const t = await ended(r, task.id);
    expect(t).toMatchObject({ status: 'done', state: 'completed', loops: 1 });
    expect(r.of('city.task.hop').map((e) => e.data.hop.to)).toEqual(['test', 'review', 'code', 'test', 'review']);
    const back = r.of('city.task.hop').find((e) => e.data.hop.from === 'review' && e.data.hop.to === 'code');
    expect(back.data.hop.loop).toBe(1);
    expect(t.history.some((x) => x.from === 'review' && x.to === 'queued')).toBe(true);
    expect(r.s.agents.dev.history).toMatchObject({ done: 1, loops: 1, lastTasks: [task.id] });
    await r.city.close();
  });
});

describe('QA runs the project tests', () => {
  const withTests = (r, script, file) => {
    r.ws.write('package.json', JSON.stringify({ name: 'x', version: '1.0.0', scripts: { test: script } }));
    r.ws.write('t.js', file);
  };

  it('passes on exit code 0 and loops back with the output on a failure', async () => {
    const r = rig({ respond: scripted({ scripts: HELLO }) });
    withTests(r, 'node t.js', 'process.exit(0)');
    const { task } = await r.run('city.task.create', { title: 'Make a hello page', room: 'code', pipeline: ['code', 'test'] });
    const t = await ended(r, task.id);
    expect(t.verdicts.find((v) => v.room === 'test')).toMatchObject({ passed: true, by: 'qa' });
    expect(r.of('run.finished').at(-1).data.exitCode).toBe(0);
    await r.city.close();

    const f = rig({ respond: scripted({ scripts: HELLO }) });
    withTests(f, 'node t.js', 'console.error("2 tests failed"); process.exit(1)');
    const b = (await f.run('city.task.create', { title: 'Make a hello page', pipeline: ['code', 'test'] })).task;
    await waitFor(() => f.s.tasks[b.id].verdicts.some((v) => v.room === 'test'), { timeout: 30000 });
    const v = f.s.tasks[b.id].verdicts.find((x) => x.room === 'test');
    expect(v).toMatchObject({ passed: false, by: 'qa' });
    expect(v.issues[0]).toBe('npm test failed with exit code 1');
    expect(v.issues.join(' ')).toContain('2 tests failed');
    await f.run('city.task.cancel', { taskId: b.id });
    await f.city.close();
  });

  it("always asks before running a guest task's tests, in any approval mode (SEC-3)", async () => {
    const r = rig({ respond: scripted({ scripts: HELLO }) });
    expect(r.bus.state.settings.approvalMode).toBe(false);
    withTests(r, 'node t.js', 'process.exit(0)');
    const { task } = await r.run('city.task.create', { as: { id: 'g3', name: 'Kim', role: 'collaborator' }, title: 'Make a hello page', pipeline: ['code', 'test'] });
    // Since 0.2.1 the writes of a guest's task wait for the host too: the host allows them here.
    const allowed = new Set();
    const ask = await waitFor(() => {
      for (const e of r.of('approval.requested')) {
        const a = e.data.approval;
        if (a.tool !== 'run' && !allowed.has(a.id)) { allowed.add(a.id); r.approvals.resolve(a.id, true, 'ok'); }
      }
      return r.of('approval.requested').find((e) => e.data.approval.tool === 'run' && e.data.approval.taskId === task.id);
    }, { timeout: 30000 });
    expect(ask.data.approval.summary).toContain('node t.js');
    // Strict with the guest as origin: approval mode off and approveAll never answer it.
    expect(ask.data.approval).toMatchObject({ strict: true, origin: { kind: 'guest', label: 'Kim' } });
    r.approvals.approveAll('auto');
    expect(r.approvals.get(ask.data.approval.id)).toBeTruthy();
    r.approvals.resolve(ask.data.approval.id, false, 'not now');
    await waitFor(() => r.s.tasks[task.id].verdicts.some((v) => v.room === 'test'), { timeout: 30000 });
    expect(r.s.tasks[task.id].verdicts.find((v) => v.room === 'test')).toMatchObject({ passed: false, issues: ['npm test was not allowed: not now'] });
    expect(r.of('run.finished')).toHaveLength(0);
    await r.run('city.task.cancel', { as: { id: 'g3', name: 'Kim', role: 'collaborator' }, taskId: task.id });
    await r.city.close();
  });

  it('uses the static checks when there is no real test script', async () => {
    const r = rig({ respond: scripted({ scripts: HELLO }) });
    r.ws.write('package.json', JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
    const { task } = await r.run('city.task.create', { title: 'Make a hello page', pipeline: ['code', 'test'] });
    const t = await ended(r, task.id);
    expect(t.verdicts.find((v) => v.room === 'test')).toMatchObject({ passed: true, by: 'checks' });
    await r.city.close();
  });
});

describe('onboarding and the machine', () => {
  it('names the city and this machine, and remembers when onboarding is over', async () => {
    const r = rig();
    expect(r.s).toMatchObject({ name: null, onboarded: null });
    await expect(r.run('city.name.set', { as: RITA, name: 'X' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(r.run('city.name.set', { name: '  ' })).rejects.toMatchObject({ code: 'bad_request' });
    await r.run('city.name.set', { name: 'Honey Town', machineName: 'Studio PC' });
    expect(r.s.name).toBe('Honey Town');
    expect(r.s.machines[r.city.machineId].name).toBe('Studio PC');
    expect(r.city.store.machine().name).toBe('Studio PC');
    await r.run('city.onboard.done', {});
    expect(r.s.onboarded).toBeTruthy();
    expect(r.of('city.onboarded')).toHaveLength(1);
    await r.run('city.onboard.done', {});
    expect(r.of('city.onboarded')).toHaveLength(1);
    await r.city.close();
  });

  it('reports busy model slots and the real tokens per second of the last turn', async () => {
    const r = rig();
    const frames = [];
    r.bus.onLive((type, data) => { if (type === 'city.machine.load') frames.push(data); });
    await r.scheduler.turn({ workerId: 'dev', messages: [{ role: 'user', content: 'hello there' }] });
    const tps = r.of('turn.ended').at(-1).data.tps;
    await waitFor(() => frames.some((f) => f.slots));
    const last = frames.at(-1);
    expect(last.slots).toEqual({ busy: 0, total: 1 });
    if (tps > 0) expect(last.tps).toBe(tps);
    expect(frames.every((f) => typeof f.tps === 'number')).toBe(true);
    await r.city.close();
  });

  it('fills the 1.0 agent fields', () => {
    const r = rig();
    const dev = r.s.agents.dev;
    expect(dev).toMatchObject({
      machineId: r.city.machineId, thinksOn: { kind: 'local' },
      permissions: { tools: dev.tools, capabilities: [] },
      history: { done: 0, reviews: 0, tests: 0, loops: 0, lastTasks: [] }, level: 1, xp: 0
    });
    expect('owner' in dev).toBe(true);
    r.city.close();
  });
});
