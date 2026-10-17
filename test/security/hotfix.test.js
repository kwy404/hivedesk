// Regression tests for the 0.2.1 security hotfix (docs/1.0/AUDIT.md section 14, PLAN.md section 14).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { rig, scripted, page, friendBrain, joinRita, RITA } from '../city/rig.js';
import { tmpDir, waitFor } from '../helpers.js';
import { startHive } from '../../src/index.js';
import { createServer } from '../../src/server.js';
import { createFakeBrain } from '../../src/brain/fake.js';
import { EventBus } from '../../src/bus.js';
import { Scheduler } from '../../src/crew/scheduler.js';
import { ToolBox } from '../../src/tools/index.js';
import { Approvals } from '../../src/tools/approvals.js';
import { createLendGuard } from '../../src/lend/guard.js';
import { findLocalChat } from '../../src/lend/index.js';
import { demoFolder } from '../../src/cli.js';
import { Sandbox } from '../../src/extensions/sandbox.js';
import { guestMay } from '../../src/collab/policy.js';
import { readOptions } from '../../ui/lend/core/frames.js';

const VIEWER = { id: 'g7', name: 'Vic', role: 'viewer' };
const NOROLE = { id: 'g8', name: 'Nora' };
const COLLAB = { id: 'g9', name: 'Cole', role: 'collaborator' };
const WRITE = ['write_file', 'edit_file', 'delete_file', 'run'];
const HELLO = { 'Make a hello page': [{ tool: 'write_file', args: { path: 'hello.html', content: page() } }, { tool: 'done', args: { summary: 'hello.html is written.' } }] };
const msg = (content = 'hi') => ({ messages: [{ role: 'user', content }] });
const approvalsOf = (bus) => bus.events.filter((e) => e.type === 'approval.requested').map((e) => e.data.approval);

describe('guest roles are checked by the engine', () => {
  it('a viewer, or a guest without a role, cannot join the city, bind a model, change agents or post tasks', async () => {
    const r = rig();
    r.scheduler.addBrain(friendBrain());
    for (const as of [VIEWER, NOROLE]) {
      await expect(r.run('city.machine.join', { as, machine: { id: 'm_vic00001', name: 'Vic' }, brainId: 'local' })).rejects.toMatchObject({ code: 'forbidden' });
      await expect(r.run('city.machine.update', { as, machineId: 'm_vic00001', brainId: 'local' })).rejects.toMatchObject({ code: 'forbidden' });
      await expect(r.run('city.agent.update', { as, agentId: 'dev', tools: ['run'] })).rejects.toMatchObject({ code: 'forbidden' });
      await expect(r.run('city.borrow.request', { as, agentId: 'dev', machineId: r.city.machineId })).rejects.toMatchObject({ code: 'forbidden' });
      await expect(r.run('city.task.create', { as, title: 'x' })).rejects.toMatchObject({ code: 'forbidden' });
    }
    expect(r.s.machines.m_vic00001).toBeUndefined();
    expect(r.scheduler.brains.get('local').brain.only).toBeUndefined();
    await expect(r.run('city.state', { as: VIEWER })).resolves.toBeTruthy();
    await r.city.close();
  });

  it('a collaborator binds only the model it lends itself, never the host model or another guest one', async () => {
    const r = rig();
    r.scheduler.addBrain(friendBrain());
    r.scheduler.addBrain(friendBrain('b_other', scripted(), 'peer:g5'));
    await joinRita(r, { brainId: 'local' });
    expect(r.s.machines.m_rita0001.brainId).toBeNull();
    expect(r.scheduler.brains.get('local').brain.only).toBeUndefined();
    for (const brainId of ['local', 'b_other']) {
      await expect(r.run('city.machine.update', { as: RITA, machineId: 'm_rita0001', brainId })).rejects.toMatchObject({ code: 'forbidden' });
    }
    await r.run('city.machine.update', { as: RITA, machineId: 'm_rita0001', brainId: 'b_friend' });
    expect(r.s.machines.m_rita0001.brainId).toBe('b_friend');
    // The host crew still thinks on the host model.
    await r.scheduler.turn({ workerId: 'dev', messages: [{ role: 'user', content: 'hi' }] });
    expect(r.of('turn.ended').at(-1).data.brainId).toBe('local');
    await r.city.close();
  });

  it('records which guest lent a brain on brain.attach', async () => {
    const app = await startHive({ dir: tmpDir(), home: tmpDir(), brain: createFakeBrain({ respond: () => 'x' }) });
    const client = { id: 'c9', conn: { sendJson: () => true }, brains: new Map() };
    const mine = await app.server.runCommand('brain.attach', { label: 'Rita', guest: 'g1' }, client);
    const plain = await app.server.runCommand('brain.attach', { label: 'Friend' }, client);
    expect(app.scheduler.brains.get(mine.brainId).brain.owner).toBe('peer:g1');
    expect(app.scheduler.brains.get(plain.brainId).brain.owner).toBeNull();
    await expect(app.server.runCommand('brain.attach', { label: 'x', as: COLLAB }, client)).rejects.toMatchObject({ code: 'forbidden' });
    await app.close();
  });

  it('refuses every command a role does not allow, whatever the host browser forwards', async () => {
    const app = await startHive({ dir: tmpDir(), home: tmpDir(), brain: createFakeBrain({ respond: () => 'x' }) });
    const run = (type, data) => app.server.runCommand(type, data, null);
    for (const [type, data] of [['job.create', { request: 'a page' }], ['files.write', { path: 'a.txt', content: 'x' }], ['approval.resolve', { approvalId: 'a_1', approved: true }], ['task.cancel', { taskId: 't_1' }], ['city.machine.join', { machine: { id: 'm_x0000001' } }]]) {
      await expect(run(type, { ...data, as: VIEWER })).rejects.toMatchObject({ code: 'forbidden' });
    }
    for (const type of ['crew.hire', 'crew.update', 'settings.set', 'brain.select', 'brain.attach', 'brain.chat', 'provider.setKey', 'memory.add', 'playbook.delete', 'city.agent.hire', 'city.room.add']) {
      await expect(run(type, { as: COLLAB })).rejects.toMatchObject({ code: 'forbidden' });
    }
    await expect(run('files.list', { as: VIEWER })).resolves.toBeTruthy();
    expect(guestMay('viewer', 'chat.send')).toBe(true);
    expect(guestMay('collaborator', 'city.task.create')).toBe(true);
    await app.close();
  });
});

describe('guest agents and guest writes', () => {
  it("a guest's agent comes with read only tools, and only the host grants more", async () => {
    const r = rig();
    r.scheduler.addBrain(friendBrain());
    await joinRita(r, { agents: [{ id: 'pip', name: 'Pip', role: 'Dev', tools: [...WRITE, 'read_file'] }, { id: 'zed', name: 'Zed', role: 'Dev', tools: ['run'] }] });
    for (const id of ['m_rita0001:pip', 'm_rita0001:zed']) {
      const a = r.s.agents[id];
      expect(a.tools.some((t) => WRITE.includes(t))).toBe(false);
      expect(a.permissions).toEqual({ shell: false, write: false });
      expect(r.bus.state.crew.find((w) => w.id === a.workerId).tools.some((t) => WRITE.includes(t))).toBe(false);
    }
    const pip = r.s.agents['m_rita0001:pip'];
    await expect(r.run('city.agent.update', { as: RITA, agentId: pip.id, tools: ['write_file'] })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(r.run('city.agent.hire', { as: RITA, name: 'X', role: 'Dev', tools: ['write_file'] })).rejects.toMatchObject({ code: 'forbidden' });
    // The host grants a write tool; a later join keeps the grant.
    await r.run('city.agent.update', { agentId: pip.id, tools: ['list_files', 'read_file', 'write_file'], name: 'Not yours' });
    expect(r.s.agents[pip.id]).toMatchObject({ name: 'Pip', tools: ['list_files', 'read_file', 'write_file'], grantedBy: 'host' });
    await r.run('city.machine.leave', { as: RITA, machineId: 'm_rita0001' });
    await joinRita(r, { agents: [{ id: 'pip', name: 'Pip', role: 'Dev', tools: WRITE }] });
    expect(r.s.agents[pip.id].tools).toEqual(['list_files', 'read_file', 'write_file']);
    // A worker that still holds write tools without a grant (an older version) comes back read only.
    const zed = r.s.agents['m_rita0001:zed'];
    r.hive.updateWorker(zed.workerId, { tools: ['read_file', 'write_file'] });
    await r.run('city.machine.leave', { as: RITA, machineId: 'm_rita0001' });
    await joinRita(r, { agents: [{ id: 'zed', name: 'Zed', role: 'Dev', tools: WRITE }] });
    expect(r.bus.state.crew.find((w) => w.id === zed.workerId).tools.some((t) => WRITE.includes(t))).toBe(false);
    await r.city.close();
  });

  it("a guest's save and job wait for the host, new files included, with approval mode off; a guest cannot answer them", async () => {
    const app = await startHive({ dir: tmpDir(), home: tmpDir(), brain: createFakeBrain({ respond: () => 'x' }) });
    app.hive.setSettings({ approvalMode: false });
    const saving = app.server.runCommand('files.write', { path: 'new.txt', content: 'hi', as: COLLAB }, null);
    const req = await waitFor(() => approvalsOf(app.bus)[0]);
    expect(req).toMatchObject({ tool: 'write_file', strict: true, origin: { kind: 'guest', id: 'g9', label: 'Cole' } });
    expect(fs.existsSync(path.join(app.toolbox.ws.root, 'new.txt'))).toBe(false);
    await expect(app.server.runCommand('approval.resolve', { approvalId: req.id, approved: true, as: COLLAB }, null)).rejects.toMatchObject({ code: 'forbidden' });
    app.hive.setSettings({ approvalMode: false }); // turning approval mode off approves the rest, not this one
    expect(app.approvals.get(req.id)).toBeTruthy();
    await app.server.runCommand('approval.resolve', { approvalId: req.id, approved: true }, null);
    await saving;
    expect(app.toolbox.ws.read('new.txt')).toBe('hi');
    await app.close();
  });

  it("a guest's job runs with approval on and is marked as the guest's", async () => {
    const bus = new EventBus();
    const approvals = new Approvals(bus);
    const toolbox = new ToolBox({ workspace: tmpDir(), bus, approvals });
    const jobs = [];
    const hive = { createJob: (o) => { jobs.push(o); return { jobId: `j_${jobs.length}` }; } };
    const server = createServer({ bus, hive, scheduler: new Scheduler(bus), approvals, playbooks: { list: () => [] }, toolbox });
    await server.runCommand('job.create', { request: 'a page', approval: false, as: COLLAB });
    await server.runCommand('job.create', { request: 'mine', approval: false });
    expect(jobs.map((j) => j.approval)).toEqual([true, false]);
    expect(toolbox.originOf({ jobId: 'j_1' })).toMatchObject({ kind: 'guest', id: 'g9' });
    expect(toolbox.originOf({ jobId: 'j_2' })).toBeNull();
  });
});

describe("a friend's model never drives host tools on its own", () => {
  it('a task whose turns ran on a lent brain asks the host for every write, with the origin on the card', async () => {
    const r = rig({ brain: friendBrain('b_friend', scripted({ scripts: HELLO })) });
    const { jobId, done } = r.hive.createJob({ request: 'hello', plan: [{ title: 'Make a hello page', detail: '', assignee: 'dev', kind: 'build' }] });
    const req = await waitFor(() => approvalsOf(r.bus)[0]);
    expect(req).toMatchObject({ jobId, tool: 'write_file', strict: true, origin: { kind: 'remote', brainId: 'b_friend', label: 'Friend' } });
    expect(r.ws.exists('hello.html')).toBe(false);
    r.approvals.resolve(req.id, true, '', 'user');
    await done;
    expect(r.ws.exists('hello.html')).toBe(true);
    await r.city.close();
  });

  it('npm run from an untrusted origin always asks, shows the script body, and approval mode off does not skip it', async () => {
    const bus = new EventBus();
    bus.emit('settings.changed', { approvalMode: false });
    const approvals = new Approvals(bus);
    const toolbox = new ToolBox({ workspace: tmpDir(), bus, approvals });
    toolbox.ws.write('package.json', JSON.stringify({ scripts: { x: 'node -e "require(\'fs\').writeFileSync(\'pwned\', \'1\')"' } }));
    expect(toolbox.needsApproval('write_file', { path: 'n.txt' }, {})).toBe(false);
    expect(toolbox.needsApproval('write_file', { path: 'n.txt' }, { origin: { kind: 'remote' } })).toBe(true);
    const running = toolbox.execute('run', { command: 'npm run x' }, { workerId: 'dev', origin: { kind: 'remote', label: "Rita's PC" } });
    const req = await waitFor(() => approvalsOf(bus)[0]);
    expect(req).toMatchObject({ strict: true, origin: { kind: 'remote', label: "Rita's PC" }, script: { name: 'x', body: expect.stringContaining('writeFileSync') } });
    approvals.approveAll();
    expect(approvals.get(req.id)).toBeTruthy();
    approvals.resolve(req.id, false, 'no');
    expect((await running).ok).toBe(false);
    expect(toolbox.ws.exists('pwned')).toBe(false);
  });
});

describe('lend safety on the lender', () => {
  it('cancel stops the running turn on the lender model', async () => {
    const scheduler = new Scheduler(new EventBus());
    let aborted = false;
    scheduler.addBrain({ id: 'local', label: 'Mine', kind: 'local', info: () => ({ model: 'qwen-7b' }), chat: (m, o) => new Promise((_, reject) => o.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); })) });
    const guard = createLendGuard({ chat: findLocalChat({ scheduler }) });
    const p = guard.handle({ ...msg(), requestId: 'r_1' });
    await waitFor(() => scheduler.queueState().running.length);
    expect(guard.cancel('r_2')).toBe(false);
    expect(guard.cancel('r_1')).toBe(true);
    await expect(p).rejects.toMatchObject({ code: 'cancelled' });
    expect(aborted).toBe(true);
    expect(guard.status().busy).toBe(false);
  });

  it('a grant is a lease: it ends after its turns or its minutes, and a new pairing starts a new one', async () => {
    let t = 1_000_000;
    const chat = async () => ({ text: 'ok' });
    const byTurns = createLendGuard({ chat, grant: { turns: 2, minutes: 5 }, now: () => t });
    await byTurns.handle(msg());
    await byTurns.handle(msg());
    await expect(byTurns.handle(msg())).rejects.toMatchObject({ code: 'expired' });
    const events = [];
    const byTime = createLendGuard({ chat, grant: { minutes: 1 }, now: () => t, emit: (type) => events.push(type) });
    await byTime.handle(msg());
    t += 61_000;
    await expect(byTime.handle(msg())).rejects.toMatchObject({ code: 'expired' });
    expect(events).toContain('lend.expired');
    byTime.stop();
    byTime.resume();
    await expect(byTime.handle(msg())).resolves.toMatchObject({ text: 'ok' });
    byTime.close();
    byTurns.close();
  });

  it('lends local models only: no cloud key unless the grant allows it, never a borrowed brain, and the allowlist holds', async () => {
    const scheduler = new Scheduler(new EventBus());
    const cloud = createFakeBrain({ id: 'cloud:openai', model: 'gpt', respond: () => 'paid' });
    cloud.kind = 'cloud';
    const borrowed = createFakeBrain({ id: 'b_remote_1', respond: () => 'borrowed' });
    borrowed.kind = 'remote';
    scheduler.addBrain(cloud);
    scheduler.addBrain(borrowed);
    const guard = createLendGuard({ chat: findLocalChat({ scheduler }) });
    await expect(guard.handle(msg())).rejects.toMatchObject({ code: 'no_model' });
    const local = createFakeBrain({ id: 'local', model: 'qwen-7b', respond: () => 'mine' });
    scheduler.addBrain(local);
    expect((await guard.handle(msg())).text).toBe('mine');
    guard.setGrant({ models: ['qwen-14b'] });
    await expect(guard.handle(msg())).rejects.toMatchObject({ code: 'no_model' });
    guard.setGrant({ models: [], cloud: true });
    scheduler.removeBrain('local');
    expect((await guard.handle(msg())).text).toBe('paid');
    expect(borrowed.calls).toHaveLength(0);
    expect(cloud.calls).toHaveLength(1);
    guard.close();
  });

  it('caps how deep and how large a remote schema may be', () => {
    let deep = { type: 'string' };
    for (let i = 0; i < 30; i++) deep = { type: 'array', items: deep };
    expect(() => readOptions({ schema: deep })).toThrow(/too deep|too many/);
    expect(readOptions({ schema: { type: 'object', properties: { a: { type: 'string' } } } }).schema).toBeTruthy();
  });
});

describe('demo separation', () => {
  it('--demo never writes into a real project log', async () => {
    const real = tmpDir();
    const app = await startHive({ dir: real, home: tmpDir(), brain: createFakeBrain({ respond: () => 'x' }) });
    await app.close();
    const log = path.join(real, '.hivedesk', 'events.jsonl');
    const before = fs.readFileSync(log, 'utf8');
    await expect(startHive({ dir: real, demo: true, home: tmpDir(), autoStartDemo: false })).rejects.toMatchObject({ code: 'demo_dir' });
    expect(fs.readFileSync(log, 'utf8')).toBe(before);
    expect(() => demoFolder({ dir: real })).toThrow(/not empty/);
    expect(() => demoFolder({ 'demo-dir': real })).toThrow(/real hivedesk project/);
    const project = tmpDir();
    fs.writeFileSync(path.join(project, 'index.html'), '<p>mine</p>');
    expect(() => demoFolder({ dir: project })).toThrow(/not empty/);
    expect(demoFolder({ 'demo-dir': project })).toBe(path.resolve(project));
    const fresh = demoFolder({}, { tmp: tmpDir() });
    expect(fs.readdirSync(fresh)).toEqual([]);
  });

  it('a demo run in a folder does not label a later real run as a demo', async () => {
    const dir = tmpDir();
    const demo = await startHive({ dir, demo: true, home: tmpDir(), autoStartDemo: false, demoDelayMs: 0 });
    expect(demo.bus.state.demo).toBe(true);
    await demo.close();
    expect(demoFolder({ dir })).toBe(path.resolve(dir));
    const real = await startHive({ dir, home: tmpDir(), brain: createFakeBrain({ respond: () => 'x' }) });
    expect(real.bus.state.demo).toBe(false);
    await real.close();
    // Once a real run wrote to it, the demo stays out.
    await expect(startHive({ dir, demo: true, home: tmpDir(), autoStartDemo: false })).rejects.toMatchObject({ code: 'demo_dir' });
  });
});

describe('extension sandbox', () => {
  it('runs each extension in its own process and binds its calls to it, whatever id a message names', async () => {
    const calls = [];
    const sb = new Sandbox({ onCapability: async (id, cap) => { calls.push([id, cap]); return 'ok'; }, idleMs: 10_000 });
    const code = { 'main.js': "export const tools = { who: async (args, api) => api.storage.get('k') };" };
    sb.set('ext.a', code, 'main.js');
    sb.set('ext.b', code, 'main.js');
    try {
      await sb.call('ext.a', 'who', {});
      await sb.call('ext.b', 'who', {});
      expect(calls).toEqual([['ext.a', 'storage.get'], ['ext.b', 'storage.get']]);
      const a = sb.children.get('ext.a');
      const b = sb.children.get('ext.b');
      expect(a.child.pid).not.toBe(b.child.pid);
      await sb._onMessage('ext.a', a, { t: 'cap', id: 'k_forged', extId: 'ext.b', cap: 'workspace.write', args: {} });
      expect(calls.at(-1)).toEqual(['ext.a', 'workspace.write']);
    } finally {
      sb.stop();
    }
  });
});
