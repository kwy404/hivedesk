// A friend's agents think on the friend's machine: onlyPeer jobs and compute.peerBrainId (City membership).
import { describe, it, expect } from 'vitest';
import { EventBus } from '../../src/bus.js';
import { Scheduler } from '../../src/crew/scheduler.js';
import register from '../../src/compute/index.js';
import { Net, workerEngine, requesterEngine, advertOf, controlledBrain, resource, tick } from './rig.js';
import { tmpDir, waitFor } from '../helpers.js';

const msgs = [{ role: 'user', content: 'x'.repeat(400) }];

describe('jobs bound to one peer', () => {
  it('runs only on that peer, never here, even when another machine would be faster', async () => {
    const net = new Net();
    const alex = requesterEngine(net, 'alex');
    const rita = workerEngine(net, 'rita');
    const sam = workerEngine(net, 'sam');
    for (const w of [rita, sam]) { net.grant(w.node, alex.node); w.node.send(alex.node.selfId, 'resource.advert', advertOf(w)); }
    await tick(5);
    const p = alex.requester.chat(msgs, { maxTokens: 50, onlyPeer: sam.node.selfId });
    await waitFor(() => sam.brain.calls.length);
    sam.brain.last.answer('from sam');
    expect(await p).toMatchObject({ text: 'from sam', remoteOrigin: sam.node.selfId });
    expect(rita.brain.calls).toHaveLength(0);
    expect(alex.brain.calls).toHaveLength(0);
  });

  it('waits and fails with the reason when that peer gives no grant, with no local fallback', async () => {
    const net = new Net();
    const alex = requesterEngine(net, 'alex', { resourceWaitMs: 50 });
    const sam = workerEngine(net, 'sam');
    await expect(alex.requester.chat(msgs, { maxTokens: 50, onlyPeer: sam.node.selfId })).rejects.toMatchObject({ code: 'no_candidate' });
    expect(alex.brain.calls).toHaveLength(0);
  });

  it('the plug-in adds one brain per peer for the City, bound to that peer', async () => {
    const net = new Net();
    const mine = net.node('alex');
    const rita = net.node('rita');
    const bus = new EventBus();
    const scheduler = new Scheduler(bus);
    scheduler.addBrain(controlledBrain());
    const probe = { sample: async () => ({ ...resource(), sampledAt: Date.now() }), setRuntime() {}, close() {} };
    const plane = register({ bus, scheduler, home: tmpDir(), probe, link: mine, server: { command() {}, route() {} } });
    const id = plane.peerBrainId(rita.selfId);
    expect(id).toMatch(/^compute:/);
    expect(scheduler.brains.has(id)).toBe(true);
    expect(plane.peerBrainId(rita.selfId)).toBe(id);
    expect(plane.peerBrainId('not a peer')).toBe(null);
    plane.close();
    expect(scheduler.brains.has(id)).toBe(false);
  });
});
