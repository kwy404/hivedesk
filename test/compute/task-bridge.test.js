import { describe, it, expect } from 'vitest';
import { EventBus } from '../../src/core/bus.js';
import { TaskEngine } from '../../src/tasks/engine.js';
import { attachTaskBridge } from '../../src/compute/task-bridge.js';
import { Net, requesterEngine, tick } from './rig.js';
import { waitFor } from '../helpers.js';

function setup() {
  const bus = new EventBus({ strict: true });
  const tasks = new TaskEngine({ bus });
  const bridge = attachTaskBridge({ bus, tasks });
  const t = tasks.create({ title: 'Build the page' });
  tasks.assign(t.id, 'dev');
  tasks.start(t.id);
  bus.emit('tasks.updated', { task: { id: t.id, legacy: { crewJobId: 'job_crew1' } } });
  bus.emit('job.created', { jobId: 'jb_one', model: 'any-allowed', priority: 'normal', crewJobId: 'job_crew1' });
  const state = (data) => bus.emit('job.state', { jobId: 'jb_one', ...data });
  return { bus, tasks, bridge, id: t.id, state };
}

describe('compute jobs and the task engine', () => {
  it('a failed job with choices makes the task wait for a peer, and a retry puts it back to work', () => {
    const { tasks, id, state } = setup();
    state({ state: 'failed', error: { code: 'disconnected', message: 'the peer left' }, choices: ['retry-local', 'cancel'], choiceDeadline: new Date(Date.now() + 60000).toISOString() });
    expect(tasks.get(id)).toMatchObject({ state: 'waiting', waitingFor: { kind: 'peer', ref: 'jb_one' } });
    state({ state: 'running' });
    expect(tasks.get(id).state).toBe('working');
  });

  it('no machine now: the task waits for a resource with the reason, and goes on when the job starts', () => {
    const { tasks, id, state } = setup();
    state({ state: 'queued', waiting: { kind: 'resource', reason: 'Your GPU has 1.0 GB free', deadline: new Date(Date.now() + 120000).toISOString() } });
    expect(tasks.get(id)).toMatchObject({ state: 'waiting', waitingFor: { kind: 'resource', ref: 'Your GPU has 1.0 GB free' } });
    expect(tasks.get(id).waitingFor.deadline).toBeTruthy();
    state({ state: 'leased' });
    expect(tasks.get(id).state).toBe('working');
  });

  it('a failure with no choice made fails the task by the retry policy, and a used partial goes on', () => {
    const a = setup();
    a.state({ state: 'revoked', error: { code: 'revoked', message: 'stopped by the owner' } });
    expect(a.tasks.get(a.id)).toMatchObject({ state: 'failed', failure: { code: 'rejected' } });

    const b = setup();
    b.state({ state: 'partial', error: { code: 'disconnected' }, choices: ['use-partial', 'cancel'] });
    expect(b.tasks.get(b.id).state).toBe('waiting');
    b.state({ state: 'partial', usedPartial: true });
    expect(b.tasks.get(b.id).state).toBe('working');
  });

  it('ignores jobs of other tasks and jobs without a crew job', () => {
    const { bus, tasks, id } = setup();
    bus.emit('job.created', { jobId: 'jb_two', model: 'any-allowed', priority: 'normal' });
    bus.emit('job.state', { jobId: 'jb_two', state: 'failed', error: { code: 'crashed' } });
    expect(tasks.get(id).state).toBe('working');
  });

  it('the requester brain takes the crew task and job from the scheduler turn', async () => {
    const net = new Net();
    const alex = requesterEngine(net, 'alex', {});
    const brain = alex.requester.brain();
    expect(brain.turnMeta).toBe(true);
    const p = brain.chat([{ role: 'user', content: 'hello' }], { maxTokens: 20, turn: { taskId: 't1', workerId: 'dev', jobId: 'job_crew9' } });
    await waitFor(() => alex.brain.calls.length);
    alex.brain.last.answer('ok');
    await p;
    await tick(1);
    const created = alex.bus.events.find((e) => e.type === 'job.created').data;
    expect(created).toMatchObject({ taskId: 't1', agentId: 'dev', crewJobId: 'job_crew9' });
  });
});
