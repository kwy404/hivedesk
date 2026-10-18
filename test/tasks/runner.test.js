// Native tasks run by the real crew (src/tasks/crew-executor.js) and the tasks.* commands on a real engine.
import { describe, it, expect } from 'vitest';
import { startHive } from '../../src/index.js';
import { createFakeBrain } from '../../src/brain/fake.js';
import { tmpDir, waitFor } from '../helpers.js';

const page = '<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <title>Hi</title>\n</head>\n<body>\n  <p>Hi</p>\n</body>\n</html>\n';
const step = (messages) => messages.filter((m) => m.role === 'assistant').length;

function brain({ slow = 0 } = {}) {
  return createFakeBrain({
    delayMs: slow,
    respond: (messages) => {
      const task = (messages.find((m) => m.role === 'user')?.content.match(/Your task: ([^\n]+)/) || [])[1] || '';
      if (/never ends/.test(task)) return { tool: 'list_files', args: {} };
      return step(messages) === 0 ? { tool: 'write_file', args: { path: 'hi.html', content: page } } : { tool: 'done', args: { summary: 'Wrote hi.html.' } };
    }
  });
}

async function hive(opts = {}) {
  const app = await startHive({ dir: tmpDir(), home: tmpDir(), brain: brain(opts), maxTurns: 6, ...opts.start });
  app.hive.setSettings({ approvalMode: false, refine: false });
  return app;
}

describe('the crew runs native tasks', () => {
  it('runs a task given to a crew worker to completed, with its files as artifacts and the crew chat as logs', async () => {
    const app = await hive();
    const cmd = (type, data) => app.server.runCommand(type, data);
    const { task } = await cmd('tasks.create', { title: 'Write the hi page', criteria: ['hi.html exists'], assignee: 'dev', run: 'crew' });
    expect(task.state).toBe('assigned');
    await waitFor(() => app.tasks.get(task.id).state === 'completed', { timeout: 20000 });
    const done = (await cmd('tasks.get', { taskId: task.id })).task;
    expect(done.history.map((h) => h.to)).toEqual(['assigned', 'working', 'completed']);
    expect(done.history[0].by).toBe('user');
    expect(done.artifacts.map((a) => a.path)).toEqual(['hi.html']);
    expect(done.logs.some((l) => /^dev: Done/.test(l.text))).toBe(true);
    expect(done.legacy.crewJobId).toMatch(/^j_/);
    // The crew job's own task joined the native task instead of becoming a second board task.
    expect(app.bus.state.board.order).toEqual([task.id]);
    expect(app.toolbox.ws.read('hi.html')).toContain('<title>Hi</title>');
    const list = await cmd('tasks.list', { state: 'completed' });
    expect(list.tasks.map((t) => t.id)).toEqual([task.id]);
    expect(list.counts.completed).toBe(1);
    await app.close();
  });

  it('cancels the crew job when the task is cancelled, and starts over after a reassign', async () => {
    const app = await hive({ slow: 30 });
    const cmd = (type, data) => app.server.runCommand(type, data);
    const { task } = await cmd('tasks.create', { title: 'A task that never ends', assignee: 'dev', run: 'crew' });
    await waitFor(() => app.tasks.get(task.id).state === 'working');
    const firstJob = app.tasks.get(task.id).legacy.crewJobId;
    await cmd('tasks.reassign', { taskId: task.id, agentId: 'designer' });
    await waitFor(() => app.tasks.get(task.id).state === 'working' && app.tasks.get(task.id).legacy.crewJobId !== firstJob);
    expect(app.bus.state.jobs.find((j) => j.id === firstJob).status).toBe('cancelled');
    expect(app.tasks.get(task.id).assignee).toBe('designer');
    const secondJob = app.tasks.get(task.id).legacy.crewJobId;
    await cmd('tasks.cancel', { taskId: task.id });
    await waitFor(() => app.bus.state.jobs.find((j) => j.id === secondJob).status === 'cancelled');
    expect(app.tasks.get(task.id).state).toBe('cancelled');
    await app.close();
  });

  it('passes retry, reassign and cancel of crew tasks to the crew', async () => {
    const app = await hive({ start: { city: false } });
    const { jobId } = app.hive.createJob({ request: 'x', plan: [{ title: 'Write the hi page', assignee: 'dev' }] });
    await waitFor(() => app.bus.state.jobs.find((j) => j.id === jobId)?.status === 'done', { timeout: 20000 });
    const id = app.bus.state.board.order.find((x) => x.startsWith('crew:'));
    expect(app.tasks.get(id).state).toBe('completed');
    await app.server.runCommand('tasks.retry', { taskId: id });
    await waitFor(() => app.tasks.get(id).history.length > 3 && app.tasks.get(id).state === 'completed', { timeout: 20000 });
    expect(app.tasks.get(id).history.map((h) => h.to)).toContain('assigned');
    await expect(app.server.runCommand('tasks.start', { taskId: id })).rejects.toMatchObject({ code: 'conflict' });
    await app.close();
  });

  it('emits a hand off when a finished task makes the task of another worker ready', async () => {
    const app = await hive({ start: { city: false } });
    const { jobId } = app.hive.createJob({ request: 'x', plan: [{ title: 'Write the hi page', assignee: 'dev' }, { title: 'Write the hi page again', assignee: 'designer', dependsOn: [0] }] });
    await waitFor(() => app.bus.state.jobs.find((j) => j.id === jobId)?.status === 'done', { timeout: 20000 });
    const handoffs = app.bus.events.filter((e) => e.type === 'task.handoff');
    expect(handoffs.map((e) => e.data)).toEqual([expect.objectContaining({ from: 'dev', to: 'designer', title: 'Write the hi page again', reason: 'Write the hi page is done' })]);
    expect(handoffs[0].origin).toEqual({ kind: 'crew', agentId: 'mel' });
    await app.close();
  });

  it('Restore City: a task that was running when hivedesk stopped waits for the user after the restart', async () => {
    const dir = tmpDir();
    const home = tmpDir();
    let app = await startHive({ dir, home, brain: brain({ slow: 40 }) });
    const { task } = await app.server.runCommand('tasks.create', { title: 'A task that never ends', assignee: 'dev', run: 'crew' });
    await waitFor(() => app.tasks.get(task.id).state === 'working');
    await app.close();
    app = await startHive({ dir, home, brain: brain() });
    const restored = app.bus.events.filter((e) => e.type === 'store.restored').at(-1);
    expect(restored.data.interrupted).toEqual([task.id]);
    expect(restored.data.snapshotSeq).toBeGreaterThan(0);
    expect(app.tasks.get(task.id)).toMatchObject({ state: 'waiting', waitingFor: { kind: 'user', ref: 'restart' } });
    await app.close();
  });
});
