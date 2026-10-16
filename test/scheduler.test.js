import { describe, it, expect } from 'vitest';
import { EventBus } from '../src/bus.js';
import { Scheduler } from '../src/crew/scheduler.js';
import { TaskGraph } from '../src/crew/taskgraph.js';

function gatedBrain(id = 'b1') {
  const calls = [];
  let active = 0;
  let maxActive = 0;
  const brain = {
    id, label: id, kind: 'local',
    calls,
    get maxActive() { return maxActive; },
    release: [],
    chat(messages, options) {
      active++;
      maxActive = Math.max(maxActive, active);
      calls.push(messages[0].content);
      return new Promise((resolve, reject) => {
        const done = (text = 'ok') => { active--; resolve({ text, promptTokens: 1, completionTokens: 2, ms: 1 }); };
        brain.release.push(done);
        options.signal?.addEventListener('abort', () => { active--; reject(new Error('aborted')); }, { once: true });
      });
    }
  };
  return brain;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('turn scheduler', () => {
  it('runs one turn at a time per brain and serves workers round robin', async () => {
    const bus = new EventBus();
    const s = new Scheduler(bus);
    const brain = gatedBrain();
    s.addBrain(brain);
    const order = [];
    const ask = (w, n) => s.turn({ workerId: w, messages: [{ role: 'user', content: `${w}${n}` }] }).then(() => order.push(`${w}${n}`));
    const all = [ask('dev', 1), ask('dev', 2), ask('dev', 3), ask('qa', 1), ask('designer', 1)];
    for (let i = 0; i < 5; i++) {
      await tick();
      expect(brain.release.length).toBe(i + 1);
      brain.release[i]();
    }
    await Promise.all(all);
    expect(brain.maxActive).toBe(1);
    // dev1 starts first; then the workers that were never served go before dev again.
    expect(brain.calls).toEqual(['dev1', 'qa1', 'designer1', 'dev2', 'dev3']);
    const types = bus.events.map((e) => e.type);
    expect(types.filter((t) => t === 'turn.started')).toHaveLength(5);
    expect(types).toContain('queue.updated');
    const ended = bus.events.find((e) => e.type === 'turn.ended');
    expect(ended.data.completionTokens).toBe(2);
  });

  it('shows who waits in the queue', async () => {
    const bus = new EventBus();
    const s = new Scheduler(bus);
    const brain = gatedBrain();
    s.addBrain(brain);
    s.turn({ workerId: 'dev', taskId: 't1', messages: [{ role: 'user', content: 'a' }] });
    s.turn({ workerId: 'qa', taskId: 't2', messages: [{ role: 'user', content: 'b' }] });
    await tick();
    expect(s.queueState()).toEqual({ running: [{ workerId: 'dev', taskId: 't1', brainId: 'b1' }], waiting: [{ workerId: 'qa', taskId: 't2' }] });
    expect(bus.state.queue.waiting).toEqual([{ workerId: 'qa', taskId: 't2' }]);
    brain.release[0]();
    await tick();
    brain.release[1]();
  });

  it('a second brain adds a parallel slot', async () => {
    const bus = new EventBus();
    const s = new Scheduler(bus);
    const a = gatedBrain('a');
    const b = gatedBrain('b');
    s.addBrain(a);
    s.addBrain(b);
    s.turn({ workerId: 'dev', messages: [{ role: 'user', content: 'x' }] });
    s.turn({ workerId: 'qa', messages: [{ role: 'user', content: 'y' }] });
    await tick();
    expect(a.calls).toEqual(['x']);
    expect(b.calls).toEqual(['y']);
    expect(bus.state.brains.map((x) => x.brainId)).toEqual(['a', 'b']);
  });

  it('waits when there is no brain and starts when one arrives', async () => {
    const s = new Scheduler(new EventBus());
    const p = s.turn({ workerId: 'dev', messages: [{ role: 'user', content: 'late' }] });
    await tick();
    const brain = gatedBrain();
    s.addBrain(brain);
    await tick();
    brain.release[0]('done');
    expect((await p).text).toBe('done');
  });

  it('re-queues a running turn when its brain goes away', async () => {
    const bus = new EventBus();
    const s = new Scheduler(bus);
    const a = gatedBrain('a');
    s.addBrain(a);
    const p = s.turn({ workerId: 'dev', messages: [{ role: 'user', content: 'move me' }] });
    await tick();
    s.removeBrain('a');
    await tick();
    const b = gatedBrain('b');
    s.addBrain(b);
    await tick();
    expect(b.calls).toEqual(['move me']);
    b.release[0]('moved');
    expect((await p).text).toBe('moved');
    expect(bus.events.some((e) => e.type === 'brain.detached')).toBe(true);
  });

  it('cancels a waiting turn', async () => {
    const s = new Scheduler(new EventBus());
    const ctrl = new AbortController();
    const p = s.turn({ workerId: 'dev', messages: [{ role: 'user', content: 'x' }], signal: ctrl.signal });
    ctrl.abort();
    await expect(p).rejects.toThrow('cancelled');
    expect(s.waiting).toHaveLength(0);
  });

  it('retries a failed turn once, then rejects', async () => {
    const s = new Scheduler(new EventBus());
    let n = 0;
    s.addBrain({ id: 'f', label: 'f', kind: 'local', chat: async () => { n++; throw new Error('flaky'); } });
    await expect(s.turn({ workerId: 'dev', messages: [] })).rejects.toThrow('flaky');
    expect(n).toBe(2);
  });
});

describe('task graph', () => {
  it('gives ready tasks in dependency order and blocks after a failure', () => {
    const g = new TaskGraph();
    g.add({ id: 'a' });
    g.add({ id: 'b', dependsOn: ['a'] });
    g.add({ id: 'c', dependsOn: ['a', 'missing', 'c'] });
    g.add({ id: 'd', dependsOn: ['b', 'c'] });
    expect(g.get('c').dependsOn).toEqual(['a']);
    expect(g.ready().map((t) => t.id)).toEqual(['a']);
    g.setStatus('a', 'done');
    expect(g.ready().map((t) => t.id)).toEqual(['b', 'c']);
    g.setStatus('b', 'failed');
    g.setStatus('c', 'done');
    expect(g.propagateBlocked().map((t) => t.id)).toEqual(['d']);
    expect(g.isFinished()).toBe(true);
    expect(g.allDone()).toBe(false);
    expect(g.order().map((t) => t.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(() => g.add({ id: 'a' })).toThrow('duplicate');
  });
});
