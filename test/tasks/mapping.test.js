// The 0.2 crew and city tasks on the 1.0 board, from real 0.2 logs.
// The fixtures were written by the 0.2.0 engine itself (git 10d9f2d) with test/tasks/fixtures/make-0.2.mjs.
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEventsFile } from '../../src/bus.js';
import { replayTasks, listTasks, countByState, reduceTasks, initialTasks } from '../../src/tasks/state.js';
import { replayCity } from '../../src/city/state.js';
import { replay } from '../../src/replay/reduce.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const real = () => readEventsFile(path.join(FIX, 'real-0.2.jsonl'));
const ev = (seq, type, data, extra = {}) => ({ seq, ts: `2026-10-17T00:00:${String(seq).padStart(2, '0')}.000Z`, type, data, ...extra });

describe('mapping a real 0.2 log', () => {
  it('turns crew tasks into crew:<id> and city tasks into city:<id>, one board task for a mirrored planner task', () => {
    const events = real();
    const board = replayTasks(events);
    const crew = replay(events);
    const city = replayCity(events);
    const ids = board.order;
    // Every crew task is on the board once; every city task too, unless it mirrors a crew task.
    for (const id of Object.keys(crew.tasks)) expect(ids).toContain(`crew:${id}`);
    for (const t of Object.values(city.tasks)) {
      if (t.link?.taskId) expect(board.tasks[`crew:${t.link.taskId}`].legacy.cityTaskId).toBe(t.id);
      else expect(ids).toContain(`city:${t.id}`);
    }
    expect(ids.length).toBe(Object.keys(crew.tasks).length + Object.values(city.tasks).filter((t) => !t.link?.taskId).length);
  });

  it('gives each task the 1.0 state of its 0.2 status', () => {
    const events = real();
    const board = replayTasks(events);
    const crew = replay(events);
    const city = replayCity(events);
    const crewMap = { done: 'completed', failed: 'failed', blocked: 'failed', skipped: 'cancelled' };
    for (const [id, t] of Object.entries(crew.tasks)) {
      const b = board.tasks[`crew:${id}`];
      if (b.legacy.cityTaskId) continue;
      expect(b.state, id).toBe(crewMap[t.status]);
      if (t.status === 'blocked') expect(b.failure.code).toBe('dependency_failed');
    }
    const cityMap = { done: 'completed', cancelled: 'cancelled', blocked: 'failed' };
    for (const t of Object.values(city.tasks)) {
      const b = board.tasks[t.link?.taskId ? `crew:${t.link.taskId}` : `city:${t.id}`];
      expect(b.state, t.id).toBe(cityMap[t.status]);
    }
    expect(countByState(board)).toMatchObject({ completed: 3, failed: 2, cancelled: 1 });
  });

  it('keeps a history whose last line is the current state, logs of notes and verdicts, and the dependencies', () => {
    const board = replayTasks(real());
    for (const t of listTasks(board)) {
      expect(t.history.length, t.id).toBeGreaterThan(0);
      expect(t.history.at(-1).to).toBe(t.state);
      for (let i = 1; i < t.history.length; i++) expect(t.history[i].from).toBe(t.history[i - 1].to);
    }
    const check = listTasks(board).find((t) => t.title === 'Check the work');
    expect(check.dependsOn.every((d) => board.tasks[d])).toBe(true);
    expect(check.history.map((h) => h.to)).toEqual(['waiting', 'failed']);
    const review = listTasks(board).find((t) => t.title === 'Review the page');
    expect(review.logs.some((l) => /review: passed/.test(l.text))).toBe(true);
    expect(review.pipeline).toEqual(['review', 'test']);
    expect(review.history.every((h) => h.by === 'system')).toBe(true);
  });

  it('replays to the same board at any point as the reducer applied event by event', () => {
    const events = real();
    const mid = events[Math.floor(events.length / 2)].seq;
    const s = initialTasks();
    for (const e of events) { if (e.seq > mid) break; reduceTasks(s, e); }
    expect(s).toEqual(replayTasks(events, mid));
  });
});

describe('mapping rules', () => {
  it('a crew task waits for its approval and for its dependencies', () => {
    const s = initialTasks();
    reduceTasks(s, ev(1, 'job.planned', { tasks: [{ id: 't_1_1', title: 'a', assignee: 'dev', dependsOn: [], status: 'pending' }, { id: 't_1_2', title: 'b', assignee: 'qa', dependsOn: ['t_1_1'], status: 'pending', kind: 'qa' }] }, { jobId: 'j_1' }));
    expect(s.tasks['crew:t_1_1'].state).toBe('assigned');
    expect(s.tasks['crew:t_1_2']).toMatchObject({ state: 'waiting', waitingFor: { kind: 'dependency', ref: 'crew:t_1_1' } });
    reduceTasks(s, ev(2, 'task.status', { taskId: 't_1_1', status: 'running' }, { jobId: 'j_1' }));
    reduceTasks(s, ev(3, 'worker.status', { workerId: 'dev', status: 'waiting_approval', taskId: 't_1_1' }, { jobId: 'j_1' }));
    expect(s.tasks['crew:t_1_1']).toMatchObject({ state: 'waiting', waitingFor: { kind: 'approval' }, attempts: 1 });
    reduceTasks(s, ev(4, 'worker.status', { workerId: 'dev', status: 'tool', taskId: 't_1_1' }, { jobId: 'j_1' }));
    expect(s.tasks['crew:t_1_1'].state).toBe('working');
    reduceTasks(s, ev(5, 'task.status', { taskId: 't_1_1', status: 'done', note: 'ok' }, { jobId: 'j_1', origin: { kind: 'crew', agentId: 'dev' } }));
    expect(s.tasks['crew:t_1_1'].history.at(-1)).toMatchObject({ to: 'completed', by: 'crew:dev', reason: 'ok' });
    expect(s.tasks['crew:t_1_2'].state).toBe('assigned');
    reduceTasks(s, ev(6, 'task.status', { taskId: 't_1_2', status: 'running' }, { jobId: 'j_1' }));
    expect(s.tasks['crew:t_1_2'].state).toBe('testing');
    reduceTasks(s, ev(7, 'task.updated', { task: { id: 't_1_2', assignee: 'dev' } }, { jobId: 'j_1' }));
    expect(s.tasks['crew:t_1_2'].assignee).toBe('dev');
  });

  it('the steps of a crew job run for a city or native task join that task instead of adding board tasks', () => {
    const s = initialTasks();
    reduceTasks(s, ev(1, 'tasks.created', { task: { id: 'tk_a', title: 'native', state: 'queued', dependsOn: [], createdBy: { kind: 'user', id: 'user' }, owner: 'local' } }));
    reduceTasks(s, ev(2, 'job.created', { job: { id: 'j_2', taskRef: 'tk_a' } }, { jobId: 'j_2' }));
    reduceTasks(s, ev(3, 'job.planned', { tasks: [{ id: 't_2_1', title: 'native', assignee: 'dev', dependsOn: [], status: 'pending' }] }, { jobId: 'j_2' }));
    reduceTasks(s, ev(4, 'task.status', { taskId: 't_2_1', status: 'failed', note: 'boom' }, { jobId: 'j_2' }));
    expect(s.order).toEqual(['tk_a']);
    expect(s.tasks.tk_a.state).toBe('queued');
    expect(s.tasks.tk_a.logs.map((l) => l.text)).toEqual(['step: native', 'failed: boom']);
    // Native tasks never move from tasks.transition of another kind of source.
    reduceTasks(s, ev(5, 'city.task.created', { task: { id: 'ct_1', title: 'c', status: 'open', pipeline: ['code'] } }));
    reduceTasks(s, ev(6, 'city.task.blocked', { taskId: 'ct_1', reason: 'still failing after 3 loops' }));
    expect(s.tasks['city:ct_1']).toMatchObject({ state: 'failed', failure: { code: 'error' } });
    reduceTasks(s, ev(7, 'city.task.created', { task: { id: 'ct_2', title: 'c2', status: 'open', loops: 3, maxLoops: 3, createdBy: { kind: 'guest', id: 'g1' } } }));
    reduceTasks(s, ev(8, 'city.task.awaiting', { taskId: 'ct_2', room: 'review' }));
    expect(s.tasks['city:ct_2']).toMatchObject({ state: 'waiting', waitingFor: { kind: 'approval', ref: 'review' }, createdBy: { kind: 'peer', id: 'g1' }, owner: 'guest:g1' });
    reduceTasks(s, ev(9, 'city.task.blocked', { taskId: 'ct_2', reason: 'loops' }));
    expect(s.tasks['city:ct_2'].failure.code).toBe('max_loops');
  });
});
