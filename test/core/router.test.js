import { describe, it, expect } from 'vitest';
import { createRouter, DEFAULT_PEER_CAPS } from '../../src/core/router.js';
import { EventBus } from '../../src/core/bus.js';
import { obj, str } from '../../src/core/schema.js';
import { startHive } from '../../src/index.js';
import { createFakeBrain } from '../../src/brain/fake.js';
import { tmpDir } from '../helpers.js';

const peer = (peerId = 'hd1friend') => ({ kind: 'peer', peerId });

describe('command router', () => {
  it('lets local users run every command and refuses peers without a capability, in Node', async () => {
    const r = createRouter();
    const seen = [];
    r.register('files.read', (d) => ({ read: d.path }));
    r.register('brain.attach', () => ({ ok: true }));
    r.register('local.only', () => 1, { local: true, peer: 'chat' });
    r.register('custom', () => 'yes', { peer: (d) => (d.loud ? null : 'chat') });
    r.onCommand((rec) => seen.push(rec));
    expect(await r.dispatch('files.read', { path: 'a' }, { origin: { kind: 'user' } })).toEqual({ read: 'a' });
    await expect(r.dispatch('files.read', {}, { origin: peer() })).rejects.toMatchObject({ code: 'not_granted' });
    await expect(r.dispatch('brain.attach', {}, { origin: peer() })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(r.dispatch('nope', {}, { origin: { kind: 'user' } })).rejects.toMatchObject({ code: 'bad_request' });
    const grants = new Set(['hd1friend:workspace.read', 'hd1friend:chat']);
    r.setGrantChecker((peerId, cap) => grants.has(`${peerId}:${cap}`));
    expect(await r.dispatch('files.read', { path: 'b' }, { origin: peer() })).toEqual({ read: 'b' });
    await expect(r.dispatch('files.read', {}, { origin: peer('hd1other') })).rejects.toMatchObject({ code: 'not_granted' });
    await expect(r.dispatch('local.only', {}, { origin: peer() })).rejects.toMatchObject({ code: 'forbidden' });
    expect(await r.dispatch('custom', {}, { origin: peer() })).toBe('yes');
    await expect(r.dispatch('custom', { loud: true }, { origin: peer() })).rejects.toMatchObject({ code: 'forbidden' });
    // A grant checker that throws counts as no grant.
    r.setGrantChecker(() => { throw new Error('broken store'); });
    await expect(r.dispatch('files.read', {}, { origin: peer() })).rejects.toMatchObject({ code: 'not_granted' });
    expect(seen.filter((x) => x.ok).length).toBe(3);
    expect(seen.find((x) => x.code === 'not_granted').origin).toEqual(peer());
    expect(r.capabilityFor('city.machine.join')).toBe(null);
    expect(DEFAULT_PEER_CAPS['city.machine.join']).toBe('city.member');
  });

  it('replaces the identity a peer claims with its verified one, validates data and limits the rate', async () => {
    let now = 0;
    const r = createRouter({ now: () => now });
    r.setGrantChecker(() => true);
    r.register('chat.send', (d) => d, { schema: obj({ text: str(10) }, ['text']) });
    const out = await r.dispatch('chat.send', { text: 'hi', as: { id: 'h', name: 'Host' } }, { origin: peer(), peerName: 'Rita' });
    expect(out.as).toEqual({ id: 'hd1friend', name: 'Rita', verified: true });
    const mine = await r.dispatch('chat.send', { text: 'hi', as: { id: 'g1', name: 'Guest' } }, { origin: { kind: 'user' } });
    expect(mine.as).toEqual({ id: 'g1', name: 'Guest' });
    await expect(r.dispatch('chat.send', { text: 'far too long text' }, { origin: { kind: 'user' } })).rejects.toMatchObject({ code: 'bad_request' });
    for (let i = 0; i < 39; i++) await r.dispatch('chat.send', { text: 'x' }, { origin: peer() });
    await expect(r.dispatch('chat.send', { text: 'x' }, { origin: peer() })).rejects.toMatchObject({ code: 'rate_limited' });
    expect(await r.dispatch('chat.send', { text: 'x' }, { origin: { kind: 'user' } })).toMatchObject({ text: 'x' });
    now = 20_000;
    expect(await r.dispatch('chat.send', { text: 'x' }, { origin: peer() })).toMatchObject({ text: 'x' });
  });

  it('never opens the controls of the owner to a peer, whatever the spec says', async () => {
    const r = createRouter();
    r.setGrantChecker(() => true);
    for (const t of ['compute.share.set', 'compute.job.stop', 'store.info', 'settings.set', 'brain.select', 'provider.setKey']) {
      r.register(t, () => 'ran', { peer: 'compute.inference' });
      await expect(r.dispatch(t, {}, { origin: peer() })).rejects.toMatchObject({ code: 'forbidden' });
      expect(await r.dispatch(t, {}, { origin: { kind: 'user' } })).toBe('ran');
    }
  });

  it('runs the handler with the origin and the command id as the cause of its events', async () => {
    const bus = new EventBus();
    const r = createRouter();
    r.register('do', (_d, _c, ctx) => { bus.emit('chat.message', { text: 'x' }); return ctx; });
    const ctx = await r.dispatch('do', {}, { origin: { kind: 'user' } });
    expect(bus.events[0]).toMatchObject({ origin: { kind: 'user' }, cause: ctx.commandId });
  });

  it('is the one way into the engine: REST and WebSocket are the user, a peer origin is checked', async () => {
    const app = await startHive({ dir: tmpDir(), home: tmpDir(), brain: createFakeBrain({ respond: () => 'x' }) });
    await expect(app.server.runCommand('files.list', {}, null, peer())).rejects.toMatchObject({ code: 'not_granted' });
    await expect(app.server.runCommand('job.create', { request: 'x' }, null, peer())).rejects.toMatchObject({ code: 'forbidden' });
    await expect(app.server.runCommand('city.agent.hire', { name: 'x' }, null, peer())).rejects.toMatchObject({ code: 'forbidden' });
    app.router.setGrantChecker((_p, cap) => cap === 'workspace.read' || cap === 'city.view');
    expect((await app.server.runCommand('files.list', {}, null, peer())).files).toEqual([]);
    expect((await app.server.runCommand('city.state', {}, null, peer())).city.v).toBe(1);
    await expect(app.server.runCommand('city.task.create', { title: 'x' }, null, peer())).rejects.toMatchObject({ code: 'not_granted' });
    expect((await app.server.runCommand('store.info', {})).lastSeq).toBeGreaterThan(0);
    await app.close();
  });
});
