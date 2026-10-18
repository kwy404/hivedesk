import { describe, it, expect, vi, afterEach } from 'vitest';
import { Net, workerEngine, controlledBrain, sharing, resource, tick, GiB } from './rig.js';
import { servesPeers, errorCode } from '../../src/compute/worker.js';
import { waitFor } from '../helpers.js';

const msgs = [{ role: 'user', content: 'write a haiku about bees' }];
let n = 0;
const jobId = () => `jb_${'a'.repeat(15)}${'abcdefghijklmnopqrstuvwxyz234567'[n++ % 32]}`;

function setup(opts = {}) {
  const net = new Net();
  const w = workerEngine(net, 'rita', opts);
  const g = net.node('alex');
  if (opts.grant !== false) net.grant(w.node, g, 'compute.inference', opts.grantLimits || null);
  const inbox = [];
  g.onMessage((from, type, body) => inbox.push({ from, type, body }));
  const offer = (job = {}) => {
    const id = job.id || jobId();
    g.send(w.node.selfId, 'job.offer', { job: { id, type: 'inference', input: { model: 'any-allowed', messages: msgs, maxTokens: 256 }, ...job } });
    return id;
  };
  const of = (type, id) => inbox.filter((m) => m.type === type && (!id || m.body.jobId === id));
  return { net, w, g, inbox, offer, of };
}

afterEach(() => { vi.useRealTimers(); });

describe('job worker: the rules before anything runs', () => {
  const refused = [
    ['a peer without compute.inference', { grant: false }, {}, 'not_granted'],
    ['when nothing is shared (the default)', { share: sharing({ gpu: { enabled: false } }) }, {}, 'sharing_off'],
    ['GPU jobs when remote inference is off', { share: sharing({ gpu: { remoteInference: false } }) }, {}, 'sharing_off'],
    ['a model not on the allowlist', {}, { input: { model: 'qwen2.5-coder-7b', messages: msgs, maxTokens: 10 } }, 'model_not_allowed'],
    ['an allowed model that is not loaded', { share: sharing({ modelAllowlist: ['3b', '7b'] }) }, { input: { model: '7b', messages: msgs, maxTokens: 10 } }, 'model_missing'],
    ['a loaded model the owner did not list', { share: sharing({ modelAllowlist: ['7b'] }) }, {}, 'model_not_allowed'],
    ['65 messages', {}, { input: { model: 'any-allowed', messages: Array.from({ length: 65 }, () => msgs[0]), maxTokens: 10 } }, 'bad_input'],
    ['a prompt over 120,000 characters', {}, { input: { model: 'any-allowed', messages: [{ role: 'user', content: 'x'.repeat(120_001) }], maxTokens: 10 } }, 'bad_input'],
    ['a tool role', {}, { input: { model: 'any-allowed', messages: [{ role: 'tool', content: 'x' }], maxTokens: 10 } }, 'bad_input'],
    ['a schema with $ref', {}, { input: { model: 'any-allowed', messages: msgs, maxTokens: 10, schema: { $ref: '#/x' } } }, 'bad_input'],
    ['a schema with pattern', {}, { input: { model: 'any-allowed', messages: msgs, maxTokens: 10, schema: { type: 'string', pattern: '.*' } } }, 'bad_input'],
    ['a schema deeper than 8', {}, { input: { model: 'any-allowed', messages: msgs, maxTokens: 10, schema: [...Array(8)].reduce((inner) => ({ type: 'array', items: inner }), { type: 'string' }) } }, 'bad_input'],
    ['a oneOf with 13 branches', {}, { input: { model: 'any-allowed', messages: msgs, maxTokens: 10, schema: { oneOf: Array.from({ length: 13 }, () => ({ type: 'string' })) } } }, 'bad_input'],
    ['too little free VRAM', { resource: resource({ free: 0.9 * GiB }) }, {}, 'vram'],
    ['a model over the VRAM limit', { share: sharing({ gpu: { maxVramBytes: 1 * GiB } }) }, {}, 'vram'],
    ['unmeasured VRAM without a limit', { resource: { ...resource(), gpus: [{ index: 0, name: 'GPU', vendor: 'amd', vramTotalBytes: null, vramFreeBytes: null }] } }, {}, 'vram'],
    ['a peer not on a listed peers share', { share: sharing({ peers: ['hd1' + 'z'.repeat(49)] }) }, {}, 'not_granted']
  ];
  for (const [name, opts, job, code] of refused) {
    it(`refuses ${name} with ${code}`, async () => {
      const { w, of, offer } = setup(opts);
      const id = offer(job);
      await waitFor(() => of('job.reject', id).length);
      expect(of('job.reject', id)[0].body.code).toBe(code);
      expect(w.brain.calls).toHaveLength(0);
      expect(w.bus.events.find((e) => e.type === 'job.refused').data.code).toBe(code);
    });
  }

  it('runs only the inference job type, and audits any other', async () => {
    const { w, of, offer } = setup();
    const id = offer({ type: 'shell', input: { cmd: 'rm -rf /' } });
    await waitFor(() => of('job.reject').length);
    expect(of('job.reject')[0].body).toMatchObject({ jobId: id, code: 'bad_input' });
    expect(of('job.reject')[0].body.detail).toMatch(/only inference/);
    expect(w.node.audits).toEqual([expect.objectContaining({ kind: 'compute.job.refused', code: 'bad_input' })]);
    expect(w.brain.calls).toHaveLength(0);
  });

  it('refuses outside the sharing hours', async () => {
    const at = new Date(2026, 9, 17, 3, 0).getTime();
    const { of, offer } = setup({ share: sharing({ hours: { from: '09:00', to: '18:00' } }), now: () => at });
    const id = offer();
    await waitFor(() => of('job.reject', id).length);
    expect(of('job.reject', id)[0].body.code).toBe('outside_hours');
  });

  it('keeps to the concurrent job limit', async () => {
    const { of, offer } = setup();
    const a = offer();
    const b = offer();
    await waitFor(() => of('job.accept', a).length && of('job.reject', b).length);
    expect(of('job.reject', b)[0].body.code).toBe('busy');
  });

  it('rate limits offers per peer', async () => {
    const { w, of, offer } = setup({ share: sharing({ gpu: { enabled: false } }) });
    for (let i = 0; i < 31; i++) offer();
    await waitFor(() => of('job.reject').length === 31);
    expect(of('job.reject').filter((m) => m.body.code === 'rate_limited')).toHaveLength(1);
    expect(w.worker.counts.refused).toBe(31);
  });
});

describe('job worker: leases, tokens, results', () => {
  it('enforces the limits written in the peer grant: tokens, seconds, models and jobs at a time', async () => {
    const t = setup({ grantLimits: { maxTokensPerJob: 64, maxJobSeconds: 30, maxConcurrentJobs: 1 } });
    const id = t.offer({ input: { model: 'any-allowed', messages: msgs, maxTokens: 5000 } });
    await waitFor(() => t.of('job.accept', id).length);
    const lease = t.of('job.accept', id)[0].body.lease;
    expect(lease.limits.maxTokens).toBe(64);
    expect(lease.hardDeadline - lease.grantedAt).toBe(30_000);
    const second = t.offer();
    await waitFor(() => t.of('job.reject', second).length);
    expect(t.of('job.reject', second)[0].body.code).toBe('busy');
    const m = setup({ grantLimits: { models: ['qwen2.5-coder-7b'] } });
    const other = m.offer();
    await waitFor(() => m.of('job.reject', other).length);
    expect(m.of('job.reject', other)[0].body.code).toBe('model_not_allowed');
  });

  it('leases, streams tokens, answers and audits counts only', async () => {
    const t0 = Date.now();
    const { w, g, of, offer } = setup();
    const id = offer({ input: { model: 'any-allowed', messages: msgs, maxTokens: 99999 } });
    await waitFor(() => w.brain.calls.length && of('job.accept', id).length);
    const acc = of('job.accept', id)[0].body;
    expect(acc.lease).toMatchObject({ jobId: id, worker: w.node.selfId, requester: g.selfId, state: 'active', limits: { maxTokens: 2048, model: 'qwen2.5-coder-3b' } });
    expect(acc.lease.expiresAt - acc.lease.grantedAt).toBe(15_000);
    expect(acc.lease.hardDeadline - acc.lease.grantedAt).toBe(120_000);
    expect(acc.lease.grantedAt).toBeGreaterThanOrEqual(t0);
    // maxTokens was lowered to the owner's limit before the brain saw it.
    expect(w.brain.last.options.maxTokens).toBe(2048);
    w.brain.last.token('Bees ');
    w.brain.last.token('hum.');
    await waitFor(() => of('job.token', id).length);
    w.brain.last.answer('Bees hum.');
    await waitFor(() => of('job.result', id).length);
    expect(of('job.token', id).map((m) => m.body.text).join('')).toBe('Bees hum.');
    expect(of('job.result', id)[0].body.result).toMatchObject({ text: 'Bees hum.', completionTokens: 5, model: 'qwen2.5-coder-3b' });
    const audit = w.node.audits.find((a) => a.kind === 'compute.job.served');
    expect(audit).toMatchObject({ requester: g.selfId, model: 'qwen2.5-coder-3b', charsIn: msgs[0].content.length, tokensOut: 5, outcome: 'completed' });
    expect(JSON.stringify(w.node.audits)).not.toContain('haiku');
    expect(w.worker.jobs.size).toBe(0);
  });

  it('sends heartbeats every 5 s with the VRAM the lease holds', async () => {
    vi.useFakeTimers();
    const { w, of, offer } = setup();
    const id = offer();
    await vi.advanceTimersByTimeAsync(10);
    expect(w.brain.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000);
    const beats = of('job.heartbeat', id);
    expect(beats).toHaveLength(2);
    expect(beats[0].body.vramBytes).toBeGreaterThan(2 * GiB);
    expect(beats[0].body.leaseId).toBe(of('job.accept', id)[0].body.lease.id);
  });
});

describe('job worker: cancel, revoke, expiry', () => {
  it('a cancel from the requester aborts the brain at once and keeps the partial text', async () => {
    const { w, g, of, offer } = setup();
    const id = offer();
    await waitFor(() => w.brain.calls.length);
    w.brain.last.token('half a ');
    await tick(30);
    const started = Date.now();
    g.send(w.node.selfId, 'job.cancel', { jobId: id });
    await waitFor(() => of('job.error', id).length);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(w.brain.aborted).toBe(1);
    expect(w.brain.last.options.signal.aborted).toBe(true);
    expect(of('job.error', id)[0].body).toMatchObject({ code: 'cancelled', partial: { text: 'half a ' } });
    expect(w.worker.jobs.size).toBe(0);
  });

  it('a cancel from another peer is ignored', async () => {
    const { net, w, of, offer } = setup();
    const id = offer();
    await waitFor(() => w.brain.calls.length);
    const mallory = net.node('mallory');
    net.grant(w.node, mallory);
    mallory.send(w.node.selfId, 'job.cancel', { jobId: id });
    await tick(20);
    expect(w.brain.aborted).toBe(0);
    expect(of('job.error', id)).toHaveLength(0);
  });

  it('the owner\'s Stop revokes: job.revoke goes out and the turn stops', async () => {
    const { w, of, offer } = setup();
    const id = offer();
    await waitFor(() => w.brain.calls.length);
    expect(w.worker.revoke(id, 'I need my GPU')).toBe(true);
    await waitFor(() => of('job.revoke', id).length);
    expect(of('job.revoke', id)[0].body.reason).toBe('I need my GPU');
    expect(w.brain.aborted).toBe(1);
    await tick(10);
    expect(of('job.error', id)).toHaveLength(0);
    expect(w.bus.events.find((e) => e.type === 'job.served').data.outcome).toBe('revoked');
  });

  it('revoking the grant revokes the running job', async () => {
    const { net, w, g, of, offer } = setup();
    const id = offer();
    await waitFor(() => w.brain.calls.length);
    net.revoke(w.node, g);
    await waitFor(() => w.brain.aborted === 1 && w.worker.jobs.size === 0 && of('job.revoke', id).length === 1);
  });

  it('turning sharing off revokes running jobs', async () => {
    const { w, of, offer } = setup();
    const id = offer();
    await waitFor(() => w.brain.calls.length);
    w.state.share = sharing({ gpu: { enabled: false } });
    w.worker.applyShare(w.state.share);
    await waitFor(() => of('job.revoke', id).length);
    expect(w.brain.aborted).toBe(1);
  });

  it('the hard deadline stops a job that runs too long', async () => {
    vi.useFakeTimers();
    const { w, of, offer } = setup({ share: sharing({ gpu: { maxJobSeconds: 10 } }) });
    const id = offer();
    await vi.advanceTimersByTimeAsync(10);
    w.brain.last.token('slow');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(w.brain.aborted).toBe(1);
    expect(of('job.error', id)[0].body).toMatchObject({ code: 'timeout', partial: { text: 'slow' } });
  });

  it('a lease expires when heartbeats cannot be delivered for 15 s', async () => {
    vi.useFakeTimers();
    const { net, w, g, offer } = setup();
    offer();
    await vi.advanceTimersByTimeAsync(10);
    net.down.add(net._pair(w.node.selfId, g.selfId));   // silent loss, no offline event
    await vi.advanceTimersByTimeAsync(20_000);
    expect(w.brain.aborted).toBe(1);
    expect(w.bus.events.find((e) => e.type === 'job.served').data.outcome).toBe('lease_expired');
  });

  it('a requester that disconnects gets 15 s to resume', async () => {
    vi.useFakeTimers();
    const { net, w, g, of, offer } = setup();
    const id = offer();
    await vi.advanceTimersByTimeAsync(10);
    net.disconnect(w.node, g);
    await vi.advanceTimersByTimeAsync(9_000);
    net.resume(w.node, g);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(w.brain.aborted).toBe(0);
    w.brain.last.answer('still here');
    await vi.advanceTimersByTimeAsync(10);
    expect(of('job.result', id)).toHaveLength(1);
    // Now without resuming: the job ends as disconnected.
    const id2 = offer();
    await vi.advanceTimersByTimeAsync(10);
    net.disconnect(w.node, g);
    await vi.advanceTimersByTimeAsync(15_001);
    expect(w.brain.aborted).toBe(1);
    expect(w.bus.events.filter((e) => e.type === 'job.served').map((e) => e.data.outcome)).toEqual(['completed', 'disconnected']);
    expect(id2).toBeTruthy();
  });

  it('a runtime crash and an out of memory are told apart', () => {
    expect(errorCode(Object.assign(new Error('x'), { code: 'no_memory' }))).toBe('oom');
    expect(errorCode(new Error('CUDA error: out of memory'))).toBe('oom');
    expect(errorCode(new Error('segfault'))).toBe('crashed');
    expect(errorCode(Object.assign(new Error('x'), { code: 'invalid_json' }))).toBe('bad_output');
  });
});

describe('job worker: lanes and brains', () => {
  it('a peer job waits for the owner\'s turns and never preempts them', async () => {
    const { w, offer } = setup();
    const own1 = w.scheduler.turn({ workerId: 'mel', messages: [{ role: 'user', content: 'owner 1' }] });
    offer();
    await tick(20);
    const own2 = w.scheduler.turn({ workerId: 'dev', messages: [{ role: 'user', content: 'owner 2' }] });
    await tick(5);
    expect(w.brain.calls.map((c) => c.messages[0].content)).toEqual(['owner 1']);
    w.brain.calls[0].answer();
    await own1;
    await tick(5);
    expect(w.brain.calls[1].messages[0].content).toBe('owner 2');   // the owner's next turn goes first
    w.brain.calls[1].answer();
    await own2;
    await tick(5);
    expect(w.brain.calls[2].messages[0].content).toBe(msgs[0].content);
  });

  it('a CPU job caps the runtime threads while it runs', async () => {
    const limits = [];
    const brain = controlledBrain({ gpu: 'cpu' });
    brain.threads = () => 8;
    brain.limitThreads = (k) => { limits.push(k); return () => limits.push('restored'); };
    const { w, of, offer } = setup({ brain, share: sharing({ gpu: { enabled: false }, cpu: { enabled: true, maxThreads: 3 } }) });
    const id = offer();
    await waitFor(() => (w.brain.calls.length && of('job.accept', id).length) || of('job.reject', id).length);
    expect(of('job.reject', id)).toEqual([]);
    expect(of('job.accept', id)[0].body.lease.limits.vramBytes).toBe(0);
    expect(limits).toEqual([3]);
    w.brain.last.answer();
    await waitFor(() => limits.length === 2);
    expect(limits).toEqual([3, 'restored']);
  });

  it('a CPU job is refused when CPU sharing is off, even with the GPU shared', async () => {
    const { of, offer } = setup({ brain: controlledBrain({ gpu: 'cpu' }) });
    const id = offer();
    await waitFor(() => of('job.reject', id).length);
    expect(of('job.reject', id)[0].body).toMatchObject({ code: 'sharing_off', detail: 'CPU sharing is off' });
  });

  it('never serves peers from a cloud key or a remote endpoint', () => {
    expect(servesPeers(controlledBrain())).toBe(true);
    expect(servesPeers(controlledBrain({ backend: 'ollama' }))).toBe(true);
    expect(servesPeers(controlledBrain({ kind: 'cloud', backend: 'gemini' }))).toBe(false);
    expect(servesPeers(controlledBrain({ kind: 'remote', backend: 'remote' }))).toBe(false);
    expect(servesPeers(controlledBrain({ backend: 'openai', url: 'https://api.example.com/v1' }))).toBe(false);
    expect(servesPeers(controlledBrain({ backend: 'openai', url: 'http://127.0.0.1:8080/v1' }))).toBe(true);
  });
});
