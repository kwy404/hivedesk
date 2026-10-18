import { describe, it, expect } from 'vitest';
import { rig } from './rig.js';
import { p2pHub, flush } from './p2p-fake.js';
import { CityMembership, capabilityFor, machineIdFor, eventForPeer } from '../../src/city/membership.js';
import { waitFor } from '../helpers.js';

const HOST = 'hd1hostaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const RITA = 'hd1ritaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function pair({ caps = ['city.member'] } = {}) {
  const hub = p2pHub();
  const h = rig();
  const g = rig();
  const hp = hub.node(HOST, 'Alex PC');
  const gp = hub.node(RITA, 'Rita');
  const host = new CityMembership({ city: h.city, p2p: hp }).start();
  const remote = [];
  const guest = new CityMembership({ city: g.city, p2p: gp, onRemote: (id, e) => remote.push(e) }).start();
  for (const c of caps) hp.grant(RITA, c);
  hub.link(hp, gp);
  const close = async () => { host.close(); guest.close(); await h.city.close(); await g.city.close(); };
  return { hub, h, g, hp, gp, host, guest, remote, close };
}

describe('city membership over p2p', () => {
  it('maps every city command to the capability it needs, and keeps host commands for the host', () => {
    expect(capabilityFor('city.sync')).toBe('city.view');
    expect(capabilityFor('city.machine.join')).toBe('city.member');
    expect(capabilityFor('city.task.create')).toBe('city.member');
    for (const t of ['city.agent.hire', 'city.room.add', 'city.agents.local', 'city.pipeline.set', 'city.name.set', 'city.agent.memory.list', 'city.nope']) expect(capabilityFor(t)).toBe(null);
    expect(machineIdFor(RITA)).toMatch(/^m_[0-9a-f]{8}$/);
    expect(machineIdFor(RITA)).not.toBe(machineIdFor(HOST));
    expect(eventForPeer({ seq: 1, type: 'worker.status', data: { workerId: 'dev', status: 'tool', detail: 'Replace secret.txt' } }).data).toEqual({ workerId: 'dev', status: 'tool' });
    expect(eventForPeer({ seq: 2, type: 'file.changed', data: { content: 'x' } })).toBe(null);
    expect(eventForPeer({ seq: 3, type: 'city.agent.memory', data: {} })).toBe(null);
  });

  it('lets a member visit with its building and agents, identified by its session, never by what it sends', async () => {
    const p = pair();
    const visit = await p.guest.visit(HOST);
    const mid = machineIdFor(RITA);
    expect(visit.machineId).toBe(mid);
    const m = p.h.s.machines[mid];
    expect(m).toMatchObject({ owner: `peer:${RITA}`, peerId: RITA, online: true, via: 'invite', brainId: null, reported: true });
    // its agents are read only and cannot think on the host's model
    const agents = Object.values(p.h.s.agents).filter((a) => a.home === mid);
    expect(agents.length).toBeGreaterThan(0);
    for (const a of agents) {
      expect(a.tools.every((t) => ['list_files', 'read_file', 'check'].includes(t))).toBe(true);
      expect(a).toMatchObject({ machineId: mid, owner: RITA, thinksOn: { kind: 'peer', peerId: RITA } });
    }
    expect(p.h.city._canThink(agents[0])).toBe(false);
    expect(p.h.s.members[RITA]).toMatchObject({ peerId: RITA, machineId: mid, via: 'invite', leftAt: null });
    expect(p.h.s.members[RITA].grants).toHaveLength(1);
    // the guest's replica of the host city has its own building in it
    expect(p.guest.remoteState(HOST).machines[mid]).toBeTruthy();
    expect(p.g.of('city.visit.started')).toHaveLength(1);
    // a host event reaches the guest
    const { task } = await p.h.run('city.task.create', { title: 'Host task', room: 'review' });
    await waitFor(() => p.guest.remoteState(HOST).tasks[task.id]);
    expect(p.remote.some((e) => e.type === 'city.task.created')).toBe(true);
    await p.close();
  });

  it('refuses spoofed identity, host brains and host only commands', async () => {
    const p = pair();
    await p.guest.visit(HOST);
    // `as`, another machine id and a host brain in the data change nothing
    const res = await p.guest.remoteCommand(HOST, 'city.machine.join', { as: { id: 'h', name: 'You' }, machine: { id: p.h.city.machineId, name: 'Fake' }, brainId: 'local' });
    expect(res.machineId).toBe(machineIdFor(RITA));
    expect(p.h.s.machines[machineIdFor(RITA)].brainId).toBe(null);
    expect(p.h.s.machines[p.h.city.machineId].owner).toBe('host');
    await expect(p.guest.remoteCommand(HOST, 'city.agent.hire', { name: 'X', role: 'Dev' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(p.guest.remoteCommand(HOST, 'city.room.add', { id: 'lab' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(p.guest.remoteCommand(HOST, 'city.agent.memory.list', { agentId: 'dev' })).rejects.toMatchObject({ code: 'forbidden' });
    // a guest's task is a guest task; it cannot approve the host's tasks
    const mine = await p.guest.remoteCommand(HOST, 'city.task.create', { title: 'Guest task', room: 'review' });
    expect(mine.task).toMatchObject({ guest: true, createdBy: { kind: 'guest', id: RITA, name: 'Rita' } });
    const hostTask = (await p.h.run('city.task.create', { title: 'Host task', room: 'review' })).task;
    await expect(p.guest.remoteCommand(HOST, 'city.task.cancel', { taskId: hostTask.id })).rejects.toMatchObject({ code: 'forbidden' });
    await p.close();
  });

  it('gives a city.view peer the city to look at and nothing to change', async () => {
    const p = pair({ caps: ['city.view'] });
    const sync = await p.guest.remoteCommand(HOST, 'city.sync', {});
    expect(sync.snapshot || sync.tail).toBeTruthy();
    await expect(p.guest.remoteCommand(HOST, 'city.machine.join', { machine: {} })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(p.guest.remoteCommand(HOST, 'city.task.create', { title: 'x' })).rejects.toMatchObject({ code: 'forbidden' });
    // without any grant nothing is forwarded either
    p.hp.revoke(RITA, 'city.view');
    const before = p.hp.sent.filter((x) => x.type === 'city.event').length;
    await p.h.run('city.task.create', { title: 'Quiet', room: 'review' });
    await flush();
    expect(p.hp.sent.filter((x) => x.type === 'city.event').length).toBe(before);
    await expect(p.guest.remoteCommand(HOST, 'city.sync', {})).rejects.toMatchObject({ code: 'forbidden' });
    await p.close();
  });

  it('takes the building out when the grant is revoked or the session drops', async () => {
    const p = pair();
    await p.guest.visit(HOST);
    const mid = machineIdFor(RITA);
    p.hp.revoke(RITA, 'city.member');
    expect(p.h.s.machines[mid].online).toBe(false);
    expect(p.h.s.members[RITA]).toMatchObject({ reason: 'revoked' });
    p.hp.grant(RITA, 'city.member');
    await p.guest.visit(HOST);
    expect(p.h.s.machines[mid].online).toBe(true);
    p.hub.unlink(p.hp, p.gp);
    expect(p.h.s.machines[mid].online).toBe(false);
    expect(p.h.s.members[RITA].reason).toBe('peer_lost');
    expect(p.g.of('city.visit.ended').at(-1).data.reason).toBe('peer_lost');
    expect(p.guest.list()).toEqual([]);
    await p.close();
  });

  it('keeps on the guest machine the level its agent earned in the friend city', async () => {
    const p = pair();
    await p.guest.visit(HOST);
    const id = `${machineIdFor(RITA)}:dev`;
    expect(p.h.s.agents[id]).toBeTruthy();
    p.h.city._xp(id, 30, null);
    await waitFor(() => p.g.s.agents.dev.xp === 30);
    expect(p.g.s.agents.dev.level).toBe(2);
    await p.close();
  });

  it('answers a command to a friend that is gone with a deadline, not a hang', async () => {
    const p = pair();
    await p.guest.visit(HOST);
    p.host.close(); // the host engine stops answering, the session stays open
    const t0 = Date.now();
    await expect(p.guest.remoteCommand(HOST, 'city.sync', {}, 80)).rejects.toMatchObject({ code: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(2000);
    await p.close();
  });
});
