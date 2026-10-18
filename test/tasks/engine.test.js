import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { EventBus } from '../../src/core/bus.js';
import { TaskEngine } from '../../src/tasks/engine.js';
import { TASK_STATES, TRANSITIONS, canTransition, replayTasks } from '../../src/tasks/state.js';
import { runWithOrigin } from '../../src/core/origin.js';
import { tmpDir, waitFor } from '../helpers.js';

function setup(opts = {}) {
  const bus = opts.bus || new EventBus({ strict: true });
  const tasks = new TaskEngine({ bus, ...opts });
  return { bus, tasks };
}

describe('the transition table', () => {
  it('has the nine states, every target is a state, and terminal states only go back to queued', () => {
    expect(TASK_STATES).toEqual(['queued', 'assigned', 'working', 'waiting', 'review', 'testing', 'completed', 'failed', 'cancelled']);
    for (const [from, tos] of Object.entries(TRANSITIONS)) {
      expect(TASK_STATES).toContain(from);
      for (const to of tos) expect(TASK_STATES).toContain(to);
    }
    expect(canTransition('completed', 'queued')).toBe(true);
    expect(canTransition('completed', 'working')).toBe(false);
    expect(canTransition('queued', 'working')).toBe(false);
    expect(canTransition('cancelled', 'failed')).toBe(false);
  });
});

describe('task engine', () => {
  it('runs a task through assigned, working, review, a loop, testing and completed, with history by origin', () => {
    const { bus, tasks } = setup();
    const t = runWithOrigin({ kind: 'user' }, () => tasks.create({ title: 'Build the page', criteria: ['has a title'], pipeline: ['code', 'review', 'test'] }));
    expect(t).toMatchObject({ state: 'queued', owner: 'local', createdBy: { kind: 'user' }, maxLoops: 3 });
    expect(t.id).toMatch(/^tk_[a-z2-7]{12}$/);
    tasks.assign(t.id, 'dev');
    runWithOrigin({ kind: 'crew', agentId: 'dev' }, () => tasks.start(t.id));
    expect(tasks.get(t.id)).toMatchObject({ state: 'working', attempts: 1, assignee: 'dev' });
    tasks.review(t.id, { stage: 1 });
    tasks.loopBack(t.id, { reason: 'the title is missing' });
    expect(tasks.get(t.id)).toMatchObject({ state: 'working', loops: 1 });
    tasks.test(t.id, { stage: 2 });
    tasks.complete(t.id);
    const done = tasks.get(t.id);
    expect(done).toMatchObject({ state: 'completed', stage: 3 });
    expect(done.history.map((h) => `${h.from}>${h.to}`)).toEqual(['queued>assigned', 'assigned>working', 'working>review', 'review>working', 'working>testing', 'testing>completed']);
    expect(done.history[1].by).toBe('crew:dev');
    expect(done.history[3].reason).toBe('the title is missing');
    expect(() => tasks.start(t.id)).toThrow(/only an assigned task/);
    expect(() => tasks.complete(t.id)).toThrow();
    // The board is the same when replayed from the log.
    expect(replayTasks(bus.events).tasks[t.id]).toEqual(JSON.parse(JSON.stringify(done)));
  });

  it('fails with max_loops when review keeps finding problems', () => {
    const { tasks } = setup();
    const t = tasks.create({ title: 'x', assignee: 'dev', maxLoops: 1 });
    expect(t.state).toBe('assigned');
    tasks.start(t.id);
    tasks.review(t.id);
    tasks.loopBack(t.id);
    tasks.review(t.id);
    const out = tasks.loopBack(t.id, { reason: 'still wrong' });
    expect(out).toMatchObject({ state: 'failed', loops: 2, failure: { code: 'max_loops' } });
  });

  it('waits on dependencies, starts when they complete, and fails when one fails; a retry brings it back', () => {
    const { tasks } = setup();
    const a = tasks.create({ title: 'a', assignee: 'dev' });
    const b = tasks.create({ title: 'b' });
    const c = tasks.create({ title: 'c', dependsOn: [a.id, b.id], assignee: 'qa' });
    expect(c.state).toBe('waiting');
    expect(c.waitingFor).toEqual({ kind: 'dependency', ref: `${a.id},${b.id}` });
    expect(() => tasks.start(c.id)).toThrow(/waits for/);
    tasks.start(a.id);
    tasks.complete(a.id);
    expect(tasks.get(c.id).waitingFor.ref).toBe(b.id);
    tasks.cancel(b.id);
    expect(tasks.get(c.id)).toMatchObject({ state: 'failed', failure: { code: 'dependency_failed' } });
    tasks.retry(b.id);
    expect(tasks.get(b.id).state).toBe('queued');
    expect(tasks.get(c.id)).toMatchObject({ state: 'waiting', waitingFor: { kind: 'dependency', ref: b.id } });
    tasks.assign(b.id, 'designer');
    tasks.start(b.id);
    tasks.complete(b.id);
    expect(tasks.get(c.id)).toMatchObject({ state: 'assigned', assignee: 'qa' });
    expect(() => tasks.create({ title: 'd', dependsOn: ['tk_nothere'] })).toThrow(/unknown dependency/);
    expect(() => tasks.update(a.id, { dependsOn: [c.id] })).toThrow(/cycle/);
    expect(() => tasks.update(a.id, { dependsOn: [a.id] })).toThrow(/cycle/);
  });

  it('waits for approvals and users without a timer, and fails a peer wait at its deadline', async () => {
    const { tasks } = setup();
    const t = tasks.create({ title: 'x', assignee: 'dev' });
    tasks.start(t.id);
    tasks.wait(t.id, { kind: 'approval', ref: 'ap_1', deadlineMs: 10 });
    expect(tasks.get(t.id)).toMatchObject({ state: 'waiting', resumeTo: 'working', waitingFor: { kind: 'approval', ref: 'ap_1' } });
    await new Promise((r) => setTimeout(r, 40));
    expect(tasks.get(t.id).state).toBe('waiting');
    tasks.resume(t.id);
    expect(tasks.get(t.id).state).toBe('working');
    tasks.wait(t.id, { kind: 'peer', ref: 'jb_1', deadlineMs: 20 });
    await waitFor(() => tasks.get(t.id).state === 'failed');
    expect(tasks.get(t.id).failure.code).toBe('peer_lost');
    tasks.close();
  });

  it('never leaves a task in working when its job fails: waiting for a peer while attempts last, then failed', () => {
    const { tasks } = setup();
    const t = tasks.create({ title: 'x', assignee: 'dev', maxAttempts: 2 });
    tasks.start(t.id);
    tasks.jobFailed(t.id, { jobId: 'jb_a', code: 'disconnected', message: 'peer gone' });
    expect(tasks.get(t.id)).toMatchObject({ state: 'waiting', waitingFor: { kind: 'peer', ref: 'jb_a' }, jobIds: ['jb_a'] });
    expect(tasks.get(t.id).waitingFor.deadline).toBeTruthy();
    // Going on after a peer wait is a new attempt.
    tasks.resume(t.id);
    expect(tasks.get(t.id)).toMatchObject({ state: 'working', attempts: 2 });
    tasks.jobFailed(t.id, { jobId: 'jb_b', code: 'disconnected' });
    expect(tasks.get(t.id)).toMatchObject({ state: 'failed', failure: { code: 'peer_lost' }, jobIds: ['jb_a', 'jb_b'] });
    tasks.close();
  });

  it('applies the retry policy to job errors', () => {
    const { tasks } = setup();
    const a = tasks.create({ title: 'a', assignee: 'dev', maxAttempts: 1 });
    tasks.start(a.id);
    tasks.jobFailed(a.id, { jobId: 'jb_1', code: 'timeout' });
    expect(tasks.get(a.id)).toMatchObject({ state: 'failed', failure: { code: 'timeout' } });
    const b = tasks.create({ title: 'b', assignee: 'dev', maxAttempts: 3 });
    tasks.start(b.id);
    tasks.jobFailed(b.id, { jobId: 'jb_2', code: 'revoked', message: 'the owner stopped it' });
    expect(tasks.get(b.id)).toMatchObject({ state: 'failed', failure: { code: 'rejected' } });
    const c = tasks.create({ title: 'c', assignee: 'dev' });
    tasks.start(c.id);
    tasks.jobFailed(c.id, { jobId: 'jb_3', code: 'lease_expired' });
    expect(tasks.get(c.id).state).toBe('waiting');
    tasks.retry(c.id);
    expect(tasks.get(c.id).state).toBe('assigned');
    tasks.close();
  });

  it('reassigns, cancels and retries; peers change only tasks they created', () => {
    const { tasks } = setup();
    const t = tasks.create({ title: 'x', assignee: 'dev' });
    tasks.start(t.id);
    tasks.reassign(t.id, 'designer');
    expect(tasks.get(t.id)).toMatchObject({ state: 'assigned', assignee: 'designer' });
    tasks.cancel(t.id);
    expect(tasks.get(t.id).state).toBe('cancelled');
    expect(() => tasks.cancel(t.id)).toThrow(/already cancelled/);
    tasks.reassign(t.id, 'qa');
    expect(tasks.get(t.id)).toMatchObject({ state: 'assigned', assignee: 'qa' });
    tasks.start(t.id);
    tasks.complete(t.id);
    expect(() => tasks.reassign(t.id, 'dev')).toThrow(/retry it instead/);
    tasks.retry(t.id);
    expect(tasks.get(t.id)).toMatchObject({ state: 'assigned', loops: 0 });
    const friend = { kind: 'peer', peerId: 'hd1rita' };
    const theirs = tasks.create({ title: 'from Rita' }, { origin: friend });
    expect(theirs.createdBy).toEqual({ kind: 'peer', id: 'hd1rita', peerId: 'hd1rita' });
    expect(() => tasks.cancel(t.id, { origin: friend })).toThrow(/only the tasks it created/);
    expect(() => tasks.cancel(theirs.id, { origin: { kind: 'peer', peerId: 'hd1eve' } })).toThrow(/only the tasks/);
    expect(tasks.cancel(theirs.id, { origin: friend }).state).toBe('cancelled');
    expect(tasks.get(theirs.id).history.at(-1).reason).toBe('cancelled by peer:hd1rita');
  });

  it('keeps logs and artifacts per task, and lists and counts', () => {
    const { tasks } = setup();
    const t = tasks.create({ title: 'x' });
    tasks.log(t.id, 'started reading', 'info');
    tasks.log(t.id, 'a check failed', 'warn');
    tasks.artifact(t.id, { id: 'file:index.html', kind: 'file', path: 'index.html', bytes: 120 });
    tasks.artifact(t.id, { id: 'file:index.html', kind: 'file', path: 'index.html', bytes: 140 });
    tasks.artifact(t.id, { kind: 'link', ref: 'https://example.org/pr/1', label: 'PR' });
    const got = tasks.get(t.id);
    expect(got.logs.map((l) => [l.level, l.text])).toEqual([['info', 'started reading'], ['warn', 'a check failed']]);
    expect(got.artifacts).toHaveLength(2);
    expect(got.artifacts[0].bytes).toBe(140);
    expect(() => tasks.artifact(t.id, { kind: 'binary' })).toThrow(/kind must be/);
    expect(tasks.counts()).toMatchObject({ queued: 1, completed: 0 });
    expect(tasks.list({ state: 'queued' }).map((x) => x.id)).toEqual([t.id]);
  });

  it('Restore City: after a restart, running native tasks wait for the user and peer deadlines are armed again', async () => {
    const dir = path.join(tmpDir(), '.hivedesk');
    fs.mkdirSync(dir, { recursive: true });
    const a = setup({ bus: new EventBus({ dir }) });
    const run = a.tasks.create({ title: 'running', assignee: 'dev' });
    a.tasks.start(run.id);
    const peerWait = a.tasks.create({ title: 'peer', assignee: 'dev' });
    a.tasks.start(peerWait.id);
    a.tasks.wait(peerWait.id, { kind: 'peer', deadlineMs: 30 });
    const queued = a.tasks.create({ title: 'queued' });
    a.tasks.close();
    a.bus.close();
    const b = setup({ bus: new EventBus({ dir }) });
    expect(b.bus.restore.snapshotSeq).toBeGreaterThan(0);
    const interrupted = b.tasks.restore();
    expect(interrupted).toEqual([run.id]);
    expect(b.tasks.get(run.id)).toMatchObject({ state: 'waiting', waitingFor: { kind: 'user', ref: 'restart' }, resumeTo: 'assigned' });
    expect(b.tasks.get(queued.id).state).toBe('queued');
    b.tasks.resume(run.id);
    expect(b.tasks.get(run.id).state).toBe('assigned');
    await waitFor(() => b.tasks.get(peerWait.id).state === 'failed');
    b.tasks.close();
  });
});
