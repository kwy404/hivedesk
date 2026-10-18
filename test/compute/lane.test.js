import { describe, it, expect } from 'vitest';
import { EventBus } from '../../src/bus.js';
import { Scheduler } from '../../src/crew/scheduler.js';
import { controlledBrain, tick } from './rig.js';

const ask = (s, workerId, content, extra = {}) => s.turn({ workerId, messages: [{ role: 'user', content }], ...extra });

describe('crew scheduler: the peer lane and the compute hooks', () => {
  it('serves owner turns before peer turns, whatever the order they came in', async () => {
    const s = new Scheduler(new EventBus());
    const b = controlledBrain();
    s.addBrain(b);
    const first = ask(s, 'mel', 'owner running');
    await tick();
    const peer = ask(s, 'peer:x', 'peer', { lane: 'peer' });
    const owner = ask(s, 'dev', 'owner waiting');
    await tick();
    expect(s.queueState().waiting).toEqual(expect.arrayContaining([{ workerId: 'peer:x', lane: 'peer', taskId: undefined }, { workerId: 'dev', taskId: undefined }]));
    b.calls[0].answer();
    await first;
    await tick();
    expect(b.calls[1].messages[0].content).toBe('owner waiting');
    b.calls[1].answer();
    await owner;
    await tick();
    expect(b.calls[2].messages[0].content).toBe('peer');
    b.calls[2].answer();
    await peer;
  });

  it('a running peer turn is not preempted by a new owner turn', async () => {
    const s = new Scheduler(new EventBus());
    const b = controlledBrain();
    s.addBrain(b);
    const peer = ask(s, 'peer:x', 'peer', { lane: 'peer' });
    await tick();
    const owner = ask(s, 'dev', 'owner');
    await tick();
    expect(b.calls).toHaveLength(1);
    expect(b.aborted).toBe(0);
    expect(s.queueState().running).toEqual([{ workerId: 'peer:x', taskId: undefined, brainId: 'local', lane: 'peer' }]);
    b.calls[0].answer();
    await peer;
    await tick();
    b.calls[1].answer();
    await owner;
  });

  it('eligible limits the brains, onStart runs when a brain takes the turn, noRetry reports at once', async () => {
    const s = new Scheduler(new EventBus());
    const cloud = controlledBrain({ id: 'cloud:x', kind: 'cloud' });
    const local = controlledBrain({ id: 'local' });
    s.addBrain(cloud);
    s.addBrain(local);
    const started = [];
    const p = ask(s, 'peer:x', 'only local', { lane: 'peer', eligible: (id) => id === 'local', onStart: (id) => started.push(id), noRetry: true });
    await tick();
    expect(cloud.calls).toHaveLength(0);
    expect(local.calls).toHaveLength(1);
    expect(started).toEqual(['local']);
    local.calls[0].fail(new Error('crash'));
    await expect(p).rejects.toThrow('crash');
    expect(local.calls).toHaveLength(1);
  });
});
