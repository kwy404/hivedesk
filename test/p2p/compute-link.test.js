// The ComputeLink over real sessions and grants, with the compute plane's own worker and requester
// (src/compute/, Stream 3): two engines in one process, a real handshake, a real grant, and a real
// lease, token stream, revoke and disconnect through encrypted frames.
// Runs once src/compute/ is in the tree (after the merge with Stream 3).
import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { inprocPair } from '../../src/p2p/transport/inproc.js';
import { createComputeLink } from '../../src/p2p/compute-link.js';
import { cleanHomes, makeNode, until, waitFor } from './helpers.js';
import { compactSchema } from '../../src/compute/wire.js';

const HAS_COMPUTE = fs.existsSync(new URL('../../src/compute/worker.js', import.meta.url)) && fs.existsSync(new URL('../compute/rig.js', import.meta.url));
const msgs = [{ role: 'user', content: 'write a haiku about bees' }];

afterEach(cleanHomes);

/** Rita lends (worker), Alex borrows (requester): paired, accepted, compute.inference and the GPU granted. */
async function world({ choiceWaitMs = 50, workerBrain } = {}) {
  const rig = await import('../compute/rig.js');
  const { ComputeWorker } = await import('../../src/compute/worker.js');
  const { Requester } = await import('../../src/compute/requester.js');
  const { ResourceScheduler } = await import('../../src/compute/scheduler.js');
  const { localServing } = await import('../../src/compute/index.js');
  const { readAdvert } = await import('../../src/compute/wire.js');
  const { EventBus } = await import('../../src/bus.js');
  const { Scheduler } = await import('../../src/crew/scheduler.js');

  const rita = makeNode('rita', { pingMs: 200, deadMs: 1500 });
  const alex = makeNode('alex', { pingMs: 200, deadMs: 1500 });
  const invite = await rita.createInvite({ caps: [{ name: 'compute.inference' }, { name: 'compute.gpu', limits: { maxVramBytes: 4 * 1024 ** 3 } }] });
  const [rc, ac] = inprocPair();
  rita.accept(rc);
  const req = waitFor(rita, 'join.request');
  const joined = await alex.join(invite.words, ac, { requestedCaps: ['compute.inference', 'compute.gpu'] });
  const r = await req;
  rita.answerJoin(r.requestId, { accept: true, sasMatches: true, caps: r.toggles.map((t) => ({ capability: t.capability, minutes: 60 })) });
  await joined.decision;

  const ritaLink = createComputeLink(rita);
  const alexLink = createComputeLink(alex);
  await until(() => alexLink.holdsGrant(rita.identity.peerId, 'compute.inference'));

  // The worker engine, as test/compute/rig.js builds it, on the real link.
  const wBus = new EventBus();
  const wSched = new Scheduler(wBus);
  const ctl = rig.controlledBrain();
  // A scripted brain keeps the controlled brain's model facts, so the worker advertises it the same way.
  const brain = workerBrain ? Object.assign(workerBrain, { info: ctl.info }) : ctl;
  wSched.addBrain(brain);
  const state = { share: rig.sharing(), resource: rig.resource() };
  const worker = new ComputeWorker({ link: ritaLink, bus: wBus, getShare: () => state.share, getResource: () => state.resource, serving: () => localServing(wSched, state.resource), runTurn: (q) => wSched.turn(q) });

  // The requester engine, no local model: every job has to cross the bridge.
  const rBus = new EventBus();
  const rSched = new Scheduler(rBus);
  const resources = new ResourceScheduler();
  const res = { ...rig.resource(), gpus: [] };
  const requester = new Requester({
    link: alexLink, resources, bus: rBus, choiceWaitMs, resourceWaitMs: 200,
    localState: () => ({ resource: res, brain: null, queue: { waiting: 0, running: 0 } }),
    runLocal: (q) => rSched.turn({ ...q, eligible: (id) => id !== 'compute' }),
  });
  alexLink.onMessage((peerId, type, body) => {
    if (type === 'resource.advert') {
      resources.advert(peerId, readAdvert(body));
      requester.resourcesChanged();
    }
  });
  const advert = rig.advertOf({ scheduler: wSched, state, worker });
  expect(ritaLink.send(alex.identity.peerId, 'resource.advert', advert)).toBe(true);
  await until(() => resources.adverts.get(rita.identity.peerId));
  const events = (type) => rBus.events.filter((e) => e.type === type).map((e) => e.data);
  return { rita, alex, ritaLink, alexLink, worker, requester, brain, events };
}

describe.skipIf(!HAS_COMPUTE)('ComputeLink with the compute plane over real sessions', () => {
  it('runs a real lease: offer, accept, tokens, result, and the answer names the verified peer', async () => {
    const w = await world();
    const tokens = [];
    const p = w.requester.chat(msgs, { maxTokens: 200, onToken: (t) => tokens.push(t) });
    await until(() => w.brain.calls.length);
    expect(w.worker.jobs.size).toBe(1);
    const job = [...w.worker.jobs.values()][0];
    expect(job.requester).toBe(w.alex.identity.peerId);
    w.brain.last.token('Busy ');
    w.brain.last.answer('Busy bees hum');
    const r = await p;
    expect(r).toMatchObject({ text: 'Busy bees hum', remoteOrigin: w.rita.identity.peerId });
    expect(tokens).toEqual(['Busy ']);
    expect(w.events('job.state').map((s) => s.state)).toEqual(['offered', 'leased', 'running', 'completed']);
    // The lender's audit chain has the served job (counts only), and stays intact.
    await until(() => w.rita.audit.tail(10).some((x) => x.entry.type === 'compute.job.served'));
    expect(JSON.stringify(w.rita.audit.tail(20))).not.toContain('haiku');
    expect(w.rita.audit.verify().ok).toBe(true);
    await w.rita.close();
    await w.alex.close();
  });

  it('revoking the grant mid job aborts the turn on the lender and fails the job as revoked', async () => {
    const w = await world();
    const peerEvents = [];
    w.alexLink.onPeer((e) => peerEvents.push(e));
    const p = w.requester.chat(msgs, {});
    await until(() => w.brain.calls.length);
    const grant = w.rita.can(w.alex.identity.peerId, 'compute.inference');
    w.rita.revoke(grant.id, 'need my GPU back');
    await expect(p).rejects.toMatchObject({ code: 'revoked' });
    await until(() => w.brain.aborted === 1);
    expect(peerEvents).toContainEqual(expect.objectContaining({ type: 'grant.revoked', peerId: w.rita.identity.peerId, capability: 'compute.inference' }));
    expect(w.alexLink.holdsGrant(w.rita.identity.peerId, 'compute.inference')).toBe(false);
    // An offer without the grant is refused before the worker, in the compute protocol.
    const inbox = [];
    w.alexLink.onMessage((from, type, body) => inbox.push({ from, type, body }));
    w.alexLink.send(w.rita.identity.peerId, 'job.offer', { job: { id: `jb_${'b'.repeat(16)}`, type: 'inference', input: { model: 'any-allowed', messages: msgs, maxTokens: 10 } } });
    await until(() => inbox.some((m) => m.type === 'job.reject'));
    expect(inbox.find((m) => m.type === 'job.reject').body).toMatchObject({ code: 'not_granted' });
    expect(w.brain.calls).toHaveLength(1);
    await w.rita.close();
    await w.alex.close();
  });

  it('reports offline when the peer stops answering, resumed when it comes back, and blocked', async () => {
    const w = await world();
    const seen = [];
    w.ritaLink.onPeer((e) => seen.push(e.type));
    expect(w.ritaLink.peers()[0]).toMatchObject({ peerId: w.alex.identity.peerId, online: true, blocked: false });
    // Cut the wire without a close: only the missing pongs tell.
    const s = w.rita.sessionOf(w.alex.identity.peerId).session;
    s.conn.tap = () => null;
    w.alex.sessionOf(w.rita.identity.peerId).session.conn.tap = () => null;
    await until(() => seen.includes('offline'), 5000);
    expect(w.ritaLink.peers()[0].online).toBe(false);
    expect(w.ritaLink.send(w.alex.identity.peerId, 'job.revoke', { jobId: `jb_${'c'.repeat(16)}`, reason: 'x' })).toBe(false);
    const [rc, ac] = inprocPair();
    w.rita.accept(rc);
    await w.alex.connect(w.rita.identity.peerId, ac);
    await until(() => seen.includes('resumed'));
    w.rita.block(w.alex.identity.peerId);
    expect(seen).toContain('blocked');
    expect(w.ritaLink.hasGrant(w.alex.identity.peerId, 'compute.inference')).toBe(false);
    await w.rita.close();
    await w.alex.close();
  });
});

describe('ComputeLink without the compute plane', () => {
  it('maps the compute types to their streams and audits with a type', async () => {
    const { messageSpec } = await import('../../src/p2p/messages.js');
    for (const t of ['job.cancel', 'job.revoke', 'resource.advert']) expect(messageSpec(t).stream).toBe(1);
    for (const t of ['job.offer', 'job.accept', 'job.reject', 'job.heartbeat', 'job.token', 'job.result', 'job.error']) expect(messageSpec(t).stream).toBe(2);
    const n = makeNode('solo');
    const link = createComputeLink(n);
    expect(link.selfId).toBe(n.identity.peerId);
    expect(link.peers()).toEqual([]);
    expect(link.send(`hd1${'a'.repeat(49)}`, 'job.cancel', {})).toBe(false);
    link.audit({ kind: 'compute.job.refused', code: 'ram' });
    expect(n.audit.tail(1)[0].entry).toMatchObject({ type: 'compute.job.refused', code: 'ram' });
    link.close();
    await n.close();
  });
});

// Schema turns cross the bridge whole: the crew's brief and tool call schemas are deeper than a control body.
describe.skipIf(!HAS_COMPUTE)('schema turns on a peer over real sessions', () => {
  it('runs a brief turn (BRIEF_SCHEMA) on the peer with the schema exactly as sent, and gets the JSON back', async () => {
    const { BRIEF_SCHEMA } = await import('../../src/crew/brief.js');
    const w = await world();
    const p = w.requester.chat(msgs, { maxTokens: 300, schema: BRIEF_SCHEMA });
    await until(() => w.brain.calls.length);
    expect(w.brain.last.options.schema).toEqual(compactSchema(BRIEF_SCHEMA));
    const brief = { goal: 'A page', build: ['index.html'], constraints: [], acceptance: ['has a title', 'has a menu'], questions: [{ question: 'Colors?', options: ['warm', 'cold'], answer: 'warm' }] };
    w.brain.last.answer(JSON.stringify(brief));
    const r = await p;
    expect(r.json).toEqual(brief);
    expect(r.remoteOrigin).toBe(w.rita.identity.peerId);
    await w.rita.close();
    await w.alex.close();
  });

  it('runs a QA tool call turn (the deepest crew schema) on the peer', async () => {
    const { workerSchema } = await import('../../src/crew/worker.js');
    const { ALL_TOOLS } = await import('../../src/tools/index.js');
    const schema = workerSchema({ tools: ALL_TOOLS }, { kind: 'qa' });
    const w = await world();
    const p = w.requester.chat(msgs, { maxTokens: 300, schema });
    await until(() => w.brain.calls.length);
    expect(w.brain.last.options.schema).toEqual(compactSchema(schema));
    const call = { tool: 'read_file', args: { path: 'index.html' } };
    w.brain.last.answer(JSON.stringify(call));
    expect((await p).json).toEqual(call);
    await w.rita.close();
    await w.alex.close();
  });

  it('refuses a schema over the bounds at once with bad_input, never a cut copy', async () => {
    const w = await world();
    const deep = [...Array(12)].reduce((inner) => ({ type: 'object', properties: { x: inner } }), { type: 'string' });
    const t0 = Date.now();
    await expect(w.requester.chat(msgs, { maxTokens: 50, schema: deep })).rejects.toBeTruthy();
    expect(w.brain.calls).toHaveLength(0);
    const refused = w.events('job.state').find((e) => e.error);
    expect(refused?.error?.code === 'bad_input' || w.events('job.ended').some((e) => /bad_input/.test(JSON.stringify(e)))).toBe(true);
    expect(Date.now() - t0).toBeLessThan(5000);
    await w.rita.close();
    await w.alex.close();
  });

  it('runs a whole crew job on the peer: brief, plan, tool turns, QA and the fix round, with the writes approved here', async () => {
    const path = await import('node:path');
    const { EventBus } = await import('../../src/bus.js');
    const { Scheduler } = await import('../../src/crew/scheduler.js');
    const { Hive } = await import('../../src/crew/engine.js');
    const { ToolBox, Workspace } = await import('../../src/tools/index.js');
    const { Approvals } = await import('../../src/tools/approvals.js');
    const { PlaybookStore } = await import('../../src/playbooks/index.js');
    const { createDemoBrain } = await import('../../src/demo.js');
    const { tmpDir } = await import('../helpers.js');
    const w = await world({ workerBrain: createDemoBrain({ delayMs: 0, tokenDelayMs: 0 }) });
    try {
      // Alex's crew has no model of its own: its only brain is the compute brain, so every turn crosses the bridge.
      const dir = tmpDir();
      const bus = new EventBus();
      const scheduler = new Scheduler(bus);
      const approvals = new Approvals(bus);
      const ws = new Workspace(path.join(dir, 'ws'));
      const toolbox = new ToolBox({ workspace: ws, bus, approvals });
      const hive = new Hive({ bus, scheduler, toolbox, approvals, playbooks: new PlaybookStore(path.join(dir, 'pb')), autoApproveBriefMs: 1 });
      hive.init();
      scheduler.addBrain(w.requester.brain('compute'));
      // The host answers every approval the friend's turns raise, and the test keeps what it was asked.
      const asked = [];
      const answer = setInterval(() => {
        for (const a of Object.values(bus.state.approvals || {})) {
          if (asked.some((x) => x.id === a.id)) continue;
          asked.push(a);
          approvals.resolve(a.id, true);
        }
      }, 10);
      const { jobId, done } = hive.createJob({ request: 'A tiny landing page for Crumb, a bakery', refine: true });
      await done;
      clearInterval(answer);
      const job = bus.state.jobs.find((j) => j.id === jobId);
      expect(job.status).toBe('done');
      expect(ws.list().map((f) => f.path).sort()).toEqual(['README.md', 'app.js', 'bread.svg', 'index.html', 'style.css']);
      // Every turn ran on Rita's machine: the brief, the plan, the tool calls and the QA reports.
      const schemas = w.brain.calls.map((c) => c.options.schema).filter(Boolean);
      expect(schemas.some((x) => x.properties?.goal)).toBe(true);
      expect(schemas.some((x) => x.properties?.tasks)).toBe(true);
      expect(schemas.some((x) => x.oneOf?.some((o) => o.properties?.tool?.const === 'report'))).toBe(true);
      expect(bus.events.filter((e) => e.type === 'qa.report').map((e) => e.data.passed)).toEqual([false, true]);
      // A friend's model output never writes here by itself: each write waited for the host.
      expect(asked.length).toBeGreaterThanOrEqual(5);
    } finally {
      await w.rita.close();
      await w.alex.close();
    }
  }, 60_000);
});
