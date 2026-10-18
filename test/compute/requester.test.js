import { describe, it, expect, vi, afterEach } from 'vitest';
import { Net, workerEngine, requesterEngine, advertOf, controlledBrain, sharing, tick } from './rig.js';
import { choicesFor } from '../../src/compute/requester.js';
import { waitFor } from '../helpers.js';

const msgs = [{ role: 'user', content: 'x'.repeat(800) }];

function world(opts = {}) {
  const net = new Net();
  const alex = requesterEngine(net, 'alex', opts.alex || {});
  const workers = (opts.workers || ['rita']).map((name) => workerEngine(net, name, opts[name] || {}));
  for (const w of workers) net.grant(w.node, alex.node);
  const advertise = () => { for (const w of workers) w.node.send(alex.node.selfId, 'resource.advert', advertOf(w)); };
  advertise();
  const events = (type) => alex.bus.events.filter((e) => e.type === type).map((e) => e.data);
  return { net, alex, workers, rita: workers[0], sam: workers[1], advertise, events };
}

afterEach(() => { vi.useRealTimers(); });

describe('requester: where a job runs', () => {
  it('runs on the peer GPU, streams tokens and marks the answer as remote', async () => {
    const { alex, rita, events } = world();
    await tick(5);
    const tokens = [];
    const p = alex.requester.chat(msgs, { maxTokens: 200, onToken: (t) => tokens.push(t) });
    await waitFor(() => rita.brain.calls.length);
    rita.brain.last.token('Hello ');
    rita.brain.last.answer('Hello there');
    const r = await p;
    expect(r).toMatchObject({ text: 'Hello there', remoteOrigin: rita.node.selfId, model: 'qwen2.5-coder-3b' });
    expect(tokens).toEqual(['Hello ']);
    const sched = events('job.scheduled')[0];
    expect(sched.decision.target).toMatchObject({ kind: 'peer-gpu', peerId: rita.node.selfId });
    expect(sched.decision.reason).toMatch(/^rita's PC, GPU: Qwen2\.5-Coder 3B fits in/);
    expect(events('job.state').map((s) => s.state)).toEqual(['offered', 'leased', 'running', 'completed']);
    expect(events('job.ended')[0]).toMatchObject({ state: 'completed', worker: rita.node.selfId });
    expect(JSON.stringify(events('job.ended'))).not.toContain('xxxx');
    expect(alex.brain.calls).toHaveLength(0);
  });

  it('runs locally when no peer is usable', async () => {
    const { net, alex, rita } = world();
    net.revoke(rita.node, alex.node);
    const p = alex.requester.chat(msgs, { maxTokens: 50 });
    await waitFor(() => alex.brain.calls.length);
    alex.brain.last.answer('local answer');
    expect(await p).toMatchObject({ text: 'local answer' });
    expect((await p).remoteOrigin).toBeUndefined();
  });

  it('a refusal moves on to the next candidate without asking anyone', async () => {
    const { alex, rita, advertise } = world();
    await tick(5);
    // The advert said sharing was on; the owner just turned it off.
    rita.state.share = sharing({ gpu: { enabled: false } });
    const p = alex.requester.chat(msgs, { maxTokens: 50 });
    await waitFor(() => alex.brain.calls.length);
    alex.brain.last.answer('fallback');
    expect((await p).text).toBe('fallback');
    expect(advertise).toBeTypeOf('function');
  });

  it('with nothing able to run, it fails with the reasons after a short wait, never forever', async () => {
    const net = new Net();
    const alex = requesterEngine(net, 'alex', { noLocal: true, resourceWaitMs: 50 });
    const started = Date.now();
    await expect(alex.requester.chat(msgs, {})).rejects.toMatchObject({ code: 'no_candidate', message: expect.stringMatching(/^No machine can run this now/) });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('frequent resource samples do not extend the wait, and Cancel works while waiting', async () => {
    const net = new Net();
    const alex = requesterEngine(net, 'alex', { noLocal: true, resourceWaitMs: 150 });
    const pump = setInterval(() => alex.requester.resourcesChanged(), 10);
    try {
      const started = Date.now();
      await expect(alex.requester.chat(msgs, {})).rejects.toMatchObject({ code: 'no_candidate' });
      expect(Date.now() - started).toBeLessThan(1500);
      const p = alex.requester.chat(msgs, {});
      await tick(20);
      expect(alex.requester.cancel(alex.requester.list().find((j) => j.state === 'queued').id)).toBe(true);
      await expect(p).rejects.toMatchObject({ code: 'cancelled' });
    } finally {
      clearInterval(pump);
    }
  });
});

describe('requester: the failure matrix', () => {
  it('Cancel by the requester: the worker aborts within a second', async () => {
    const { alex, rita } = world();
    await tick(5);
    const ctrl = new AbortController();
    const p = alex.requester.chat(msgs, { signal: ctrl.signal });
    await waitFor(() => rita.brain.calls.length && alex.requester.list()[0]?.state === 'leased');
    const t = Date.now();
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ code: 'cancelled' });
    await waitFor(() => rita.brain.aborted === 1);
    expect(Date.now() - t).toBeLessThan(1000);
    expect(alex.requester.list()[0].state).toBe('cancelled');
  });

  it('Revoke by the owner: Retry locally or Cancel, and that peer is not used again this session', async () => {
    const { alex, rita, events } = world({ alex: { choiceWaitMs: 5000 } });
    await tick(5);
    const p = alex.requester.chat(msgs, {});
    await waitFor(() => rita.brain.calls.length && rita.worker.jobs.size);
    rita.worker.revoke([...rita.worker.jobs.keys()][0], 'need my GPU back');
    await waitFor(() => alex.requester.list()[0].state === 'revoked');
    const job = alex.requester.list()[0];
    expect(job.choices).toEqual(['retry-local', 'cancel']);
    expect(job.error.message).toMatch(/need my GPU back/);
    expect(() => alex.requester.choose(job.id, 'retry-peer')).toThrow(/not one of/);
    alex.requester.choose(job.id, 'retry-local');
    await waitFor(() => alex.brain.calls.length);
    alex.brain.last.answer('done here');
    expect((await p).text).toBe('done here');
    const d = alex.resources.decide({ job: { input: { model: 'any-allowed', messages: msgs, maxTokens: 10 } }, local: { resource: { gpus: [], ram: {} }, brain: null }, peers: [{ peerId: rita.node.selfId, name: 'rita', online: true, granted: true }] });
    expect(d.candidates.find((c) => c.target.startsWith('peer-gpu')).detail).toMatch(/stopped one of your jobs/);
    expect(events('job.state').some((s) => s.state === 'revoked' && s.choices.length === 2)).toBe(true);
  });

  it('Peer disconnect: 15 s grace, then the partial text is kept and offered', async () => {
    vi.useFakeTimers();
    const { net, alex, rita } = world({ alex: { choiceWaitMs: 60_000 } });
    await vi.advanceTimersByTimeAsync(5);
    const p = alex.requester.chat(msgs, {});
    await vi.advanceTimersByTimeAsync(5);
    rita.brain.last.token('The first half');
    await vi.advanceTimersByTimeAsync(30);
    net.disconnect(rita.node, alex.node);
    await vi.advanceTimersByTimeAsync(14_000);
    expect(alex.requester.list()[0].state).toBe('running');
    await vi.advanceTimersByTimeAsync(1_100);
    const job = alex.requester.list()[0];
    expect(job.state).toBe('partial');
    expect(job.error.code).toBe('disconnected');
    expect(job.choices).toEqual(['retry-local', 'use-partial', 'cancel']);
    expect(job.choiceDeadline).toBeTruthy();
    alex.requester.choose(job.id, 'use-partial');
    const r = await p;
    expect(r).toMatchObject({ text: 'The first half', partial: true });
  });

  it('Lease expiry: no heartbeat for 15 s; with no choice the job ends, it never hangs', async () => {
    vi.useFakeTimers();
    const { net, alex, rita } = world({ alex: { choiceWaitMs: 10_000 } });
    await vi.advanceTimersByTimeAsync(5);
    const p = alex.requester.chat(msgs, {});
    const caught = p.catch((e) => e);
    await vi.advanceTimersByTimeAsync(5);
    net.drop.add('job.heartbeat');
    await vi.advanceTimersByTimeAsync(15_100);
    expect(alex.requester.list()[0]).toMatchObject({ state: 'expired', error: { code: 'lease_expired' } });
    await vi.advanceTimersByTimeAsync(10_100);
    const err = await caught;
    expect(err).toMatchObject({ code: 'lease_expired' });
    expect(rita.brain.aborted).toBe(1);   // the requester told the worker to stop
  });

  it('Timeout: no token for 30 s, one automatic retry on the next best candidate', async () => {
    vi.useFakeTimers();
    const { alex, rita } = world();
    await vi.advanceTimersByTimeAsync(5);
    const p = alex.requester.chat(msgs, {});
    await vi.advanceTimersByTimeAsync(30_100);
    expect(rita.brain.aborted).toBe(1);
    expect(alex.brain.calls).toHaveLength(1);
    alex.brain.last.answer('local after timeout');
    await vi.advanceTimersByTimeAsync(5);
    expect((await p).text).toBe('local after timeout');
    expect(alex.requester.list()[0].attempts.map((a) => a.outcome)).toEqual(['timeout', 'completed']);
  });

  it('Worker crash: Retry another peer, and the crashed one is penalized', async () => {
    const { alex, rita, sam, advertise } = world({ workers: ['rita', 'sam'], alex: { choiceWaitMs: 5000 } });
    await tick(5);
    const p = alex.requester.chat(msgs, {});
    await waitFor(() => rita.brain.calls.length || sam.brain.calls.length);
    const [first, second] = rita.brain.calls.length ? [rita, sam] : [sam, rita];
    first.brain.last.fail(new Error('segfault in the runtime'));
    await waitFor(() => alex.requester.list()[0].state === 'failed');
    const job = alex.requester.list()[0];
    expect(job.error.code).toBe('crashed');
    expect(job.choices).toEqual(['retry-local', 'retry-peer', 'cancel']);
    advertise();
    await tick(5);
    alex.requester.choose(job.id, 'retry-peer');
    await waitFor(() => second.brain.calls.length);
    second.brain.last.answer('from the other peer');
    expect(await p).toMatchObject({ text: 'from the other peer', remoteOrigin: second.node.selfId });
    expect(alex.resources.outcomes[`peer-gpu:${first.node.selfId}:0`].unhealthyUntil).toBeGreaterThan(Date.now());
  });

  it('Cancel as a choice ends the job', async () => {
    const { alex, rita } = world({ alex: { choiceWaitMs: 5000 } });
    await tick(5);
    const p = alex.requester.chat(msgs, {});
    await waitFor(() => rita.brain.calls.length);
    rita.brain.last.fail(new Error('boom'));
    await waitFor(() => alex.requester.list()[0].state === 'failed');
    alex.requester.choose(alex.requester.list()[0].id, 'cancel');
    await expect(p).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('Bad output: one retry with the error appended, validated on the requester', async () => {
    const { alex, rita } = world();
    await tick(5);
    const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] };
    const p = alex.requester.chat(msgs, { schema });
    await waitFor(() => rita.brain.calls.length);
    rita.brain.last.answer('not json at all');
    await waitFor(() => rita.brain.calls.length === 2);
    const retry = rita.brain.last.messages;
    expect(retry[retry.length - 1].content).toMatch(/was not valid/);
    rita.brain.last.answer('{"ok":true}');
    expect((await p).json).toEqual({ ok: true });
  });

  it('a grant revoked mid job fails it as revoked', async () => {
    const { net, alex, rita } = world({ alex: { choiceWaitMs: 50 } });
    await tick(5);
    const p = alex.requester.chat(msgs, {});
    await waitFor(() => rita.brain.calls.length);
    net.revoke(rita.node, alex.node);
    await expect(p).rejects.toMatchObject({ code: 'revoked' });
  });

  it('offers only the buttons that can work', () => {
    expect(choicesFor('revoked', { canLocal: true, canPeer: true, hasPartial: false, allowPartial: true })).toEqual(['retry-local', 'cancel']);
    expect(choicesFor('crashed', { canLocal: false, canPeer: false, hasPartial: true, allowPartial: false })).toEqual(['cancel']);
    expect(choicesFor('timeout', { canLocal: false, canPeer: true, hasPartial: true, allowPartial: true })).toEqual(['retry-peer', 'use-partial', 'cancel']);
  });

  it('the requester brain sits in the crew scheduler like any brain', async () => {
    const { alex, rita } = world();
    await tick(5);
    const brain = alex.requester.brain('compute');
    alex.scheduler.removeBrain(alex.brain.id);
    alex.scheduler.addBrain(brain);
    const p = alex.scheduler.turn({ workerId: 'dev', messages: msgs });
    await waitFor(() => rita.brain.calls.length);
    rita.brain.last.answer('via the crew');
    expect((await p).text).toBe('via the crew');
    expect(controlledBrain).toBeTypeOf('function');
  });
});
