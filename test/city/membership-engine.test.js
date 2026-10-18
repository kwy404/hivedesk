import { describe, it, expect } from 'vitest';
import { startHive } from '../../src/index.js';
import { createFakeBrain } from '../../src/brain/fake.js';
import { tmpDir, waitFor } from '../helpers.js';

const brain = () => createFakeBrain({ respond: () => ({ tool: 'done', args: { summary: 'ok' } }) });
const cmd = (app, type, data = {}) => app.router.dispatch(type, data, { origin: { kind: 'user' } });

/** Two real engines: invite, LAN join, SAS check and accept with the given capabilities. */
async function pairEngines(caps) {
  const host = await startHive({ dir: tmpDir(), home: tmpDir(), brain: brain(), name: 'Alex PC' });
  const guest = await startHive({ dir: tmpDir(), home: tmpDir(), brain: brain(), name: 'Rita PC' });
  const lan = await cmd(host, 'p2p.lan.listen', { host: '127.0.0.1', port: 0 });
  const inv = await cmd(host, 'p2p.invite.create', { caps: caps.map((name) => ({ name })) });
  const join = await cmd(guest, 'p2p.join', { words: inv.words.join(' '), via: 'lan', address: `127.0.0.1:${lan.port}` });
  expect(join.phase).toBe('sas');
  const req = await waitFor(async () => (await cmd(host, 'p2p.join.requests')).requests[0]);
  expect(req.sas).toEqual(join.sas);
  await cmd(host, 'p2p.join.answer', { requestId: req.requestId || req.id, accept: true, sasMatches: true, caps: caps.map((name) => ({ name })) });
  const hostId = host.p2p.node().info().peerId;
  const guestId = guest.p2p.node().info().peerId;
  await waitFor(() => host.p2p.node().can(guestId, caps[0]) && guest.p2p.node().held(hostId).length);
  return { host, guest, hostId, guestId, close: async () => { await guest.close(); await host.close(); } };
}

describe('city membership between two engines over real sessions', () => {
  it('a member visits with its building, creates a task as its verified PeerId, and leaves on revoke', async () => {
    const e = await pairEngines(['city.member']);
    try {
      const visit = await cmd(e.guest, 'city.remote.visit', { hostPeerId: e.hostId });
      expect(visit.machineId).toMatch(/^m_[0-9a-f]{8}$/);
      const member = e.host.city.state.members[e.guestId];
      expect(member).toMatchObject({ peerId: e.guestId, machineId: visit.machineId });
      expect(e.host.city.state.machines[visit.machineId].owner).toBe(`peer:${e.guestId}`);
      const made = await cmd(e.guest, 'city.remote.cmd', { hostPeerId: e.hostId, type: 'city.task.create', data: { title: 'Draw the logo' } });
      const task = e.host.city.state.tasks[made.task.id];
      expect(task.createdBy).toMatchObject({ kind: 'guest', id: e.guestId });
      // A host only command never runs for a peer, whatever it holds.
      await expect(cmd(e.guest, 'city.remote.cmd', { hostPeerId: e.hostId, type: 'city.room.add', data: { name: 'x' } })).rejects.toThrow();
      // The router audit names the verified peer.
      const audit = e.host.p2p.node().audit.tail(50);
      expect(audit.some((a) => a.entry?.type === 'command' && a.entry.peerId === e.guestId && a.entry.command === 'city.task.create')).toBe(true);
      const grant = e.host.p2p.node().grantsOf(e.guestId).find((g) => g.capability.name === 'city.member');
      await cmd(e.host, 'p2p.revoke', { grantId: grant.id });
      await waitFor(() => e.host.city.state.members[e.guestId]?.leftAt);
      expect(e.host.city.state.machines[visit.machineId].online).toBe(false);
    } finally {
      await e.close();
    }
  });

  it('a peer with city.view only can look but not create tasks', async () => {
    const e = await pairEngines(['city.view']);
    try {
      const r = await e.guest.city.membership.remoteCommand(e.hostId, 'city.state', {});
      expect(r.city.rooms).toBeTruthy();
      const t0 = Date.now();
      await expect(e.guest.city.membership.remoteCommand(e.hostId, 'city.task.create', { title: 'no' }, 5000)).rejects.toMatchObject({ code: 'not_granted' });
      expect(Date.now() - t0).toBeLessThan(2000);
    } finally {
      await e.close();
    }
  });
});
