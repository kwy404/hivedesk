// browser-pipe end to end inside one process: two real engines (createServer plus the control
// plane), two "windows" on their token WebSockets, and between the windows a relay that stands in
// for the WebRTC data channel. The windows only move text; the handshake, the SAS and the
// session run in the engines.
import { afterEach, describe, expect, it } from 'vitest';
import { EventBus } from '../../src/bus.js';
import { createServer } from '../../src/server.js';
import { connect } from '../../src/ws.js';
import { attachP2P } from '../../src/p2p/engine.js';
import register from '../../src/lend/index.js';
import { cleanHomes, tempHome, until } from './helpers.js';

const open = [];
afterEach(async () => {
  for (const x of open.splice(0)) await x();
  cleanHomes();
});

async function engine(name, { lendPlugin = false } = {}) {
  const bus = new EventBus({});
  const server = createServer({ bus, hive: {}, scheduler: { prompts: new Map() }, approvals: {}, playbooks: {}, toolbox: {}, version: 'test' });
  const ctx = { bus, server: { command: server.command, route: server.route }, config: { home: tempHome(name), name }, nodeOptions: { iterations: 1000, handshakeMs: 4000 } };
  let p2p;
  if (lendPlugin) p2p = register({ ...ctx, scheduler: { localBrain: { chat: async () => ({ text: 'x' }) } } }).p2p;
  else p2p = attachP2P(ctx);
  await server.listen(0);
  open.push(async () => {
    await p2p.close();
    await server.close();
    bus.close();
  });
  return { bus, server, p2p, name };
}

/** A window: the token WebSocket, commands with replies, live frames by type. */
async function windowOf(e) {
  const ws = await connect(`ws://127.0.0.1:${e.server.port}/ws?t=${e.server.token}`, { headers: { host: `127.0.0.1:${e.server.port}` } });
  let next = 1;
  const waiting = new Map();
  const live = [];
  const listeners = new Set();
  ws.on('message', (text) => {
    const m = JSON.parse(text);
    if (m.kind === 'reply') {
      const w = waiting.get(m.id);
      if (w) {
        waiting.delete(m.id);
        if (m.ok) w.resolve(m.result);
        else w.reject(Object.assign(new Error(m.error.message), { code: m.error.code }));
      }
    } else if (m.kind === 'live') {
      live.push(m);
      for (const fn of listeners) fn(m);
    }
  });
  const command = (type, data = {}) => new Promise((resolve, reject) => {
    const id = `w${next++}`;
    waiting.set(id, { resolve, reject });
    ws.sendJson({ kind: 'command', id, type, data });
  });
  open.push(async () => ws.close());
  return { ws, command, live, onLive: (fn) => listeners.add(fn), liveOf: (type) => live.filter((m) => m.type === type).map((m) => m.data) };
}

/** The data channel between two windows: what one engine sends out goes into the other's pipe. */
function relay(a, b) {
  const ends = { a: null, b: null };
  const early = {};
  const pending = { a: [], b: [] };
  const deliver = (to, data) => {
    const w = to === 'a' ? a : b;
    if (!ends[to]) return pending[to].push(data);
    w.command('p2p.pipe.in', { pipeId: ends[to], data }).catch(() => {});
  };
  a.onLive((m) => m.type === 'p2p.pipe.out' && m.data.pipeId === ends.a && deliver('b', m.data.data));
  b.onLive((m) => m.type === 'p2p.pipe.out' && m.data.pipeId === ends.b && deliver('a', m.data.data));
  // Frames that come out before the window learned its pipe id (the reply may follow them).
  a.onLive((m) => m.type === 'p2p.pipe.out' && !ends.a && (early.a ||= []).push(m.data));
  b.onLive((m) => m.type === 'p2p.pipe.out' && !ends.b && (early.b ||= []).push(m.data));
  const set = (side, pipeId) => {
    ends[side] = pipeId;
    const other = side === 'a' ? 'b' : 'a';
    for (const f of (early[side] || []).splice(0)) if (f.pipeId === pipeId) deliver(other, f.data);
    for (const d of pending[side].splice(0)) deliver(side, d);
  };
  return { setA: (id) => set('a', id), setB: (id) => set('b', id), ends };
}

describe('browser-pipe between two engines', () => {
  it('pairs through the windows: same rendezvous, same SAS, accept, grants, revoke, window close', async () => {
    const host = await engine('rita');
    const guest = await engine('ben');
    const hw = await windowOf(host);
    const gw = await windowOf(guest);

    const invite = await hw.command('p2p.invite.create', { caps: [{ name: 'compute.inference' }, { name: 'compute.gpu', limits: { maxVramBytes: 2 ** 32 } }] });
    expect(invite.words).toHaveLength(6);
    const join = await gw.command('p2p.join', { words: invite.words.join(' '), requestedCaps: ['compute.inference', 'compute.gpu'] });
    // Both windows meet on the same relay topic and can open each other's sealed messages,
    // but neither window ever gets the pre shared key.
    expect(join.rendezvous).toEqual(invite.rendezvous);
    expect(JSON.stringify(join)).not.toMatch(/psk/);

    const r = relay(hw, gw);
    r.setA((await hw.command('p2p.pipe.open', {})).pipeId);
    r.setB((await gw.command('p2p.pipe.open', { joinId: join.joinId })).pipeId);

    await until(() => hw.liveOf('p2p.join.request').length && gw.liveOf('p2p.join.update').some((u) => u.phase === 'sas'));
    const request = hw.liveOf('p2p.join.request')[0];
    const sasUpdate = gw.liveOf('p2p.join.update').find((u) => u.phase === 'sas');
    expect(sasUpdate.sas).toEqual(request.sas);
    expect((await hw.command('p2p.join.requests')).requests).toHaveLength(1);

    await expect(hw.command('p2p.join.answer', { requestId: request.requestId, accept: true })).rejects.toMatchObject({ code: 'sas_unconfirmed' });
    const caps = request.toggles.map((t) => ({ capability: t.capability, minutes: 30 }));
    const answer = await hw.command('p2p.join.answer', { requestId: request.requestId, accept: true, sasMatches: true, caps });
    expect(answer.accepted).toBe(true);
    await until(() => gw.liveOf('p2p.join.update').some((u) => u.phase === 'accepted'));
    expect((await gw.command('p2p.join.status', { joinId: join.joinId })).phase).toBe('accepted');

    const hostPeers = (await hw.command('p2p.peers')).peers;
    expect(hostPeers).toHaveLength(1);
    expect(hostPeers[0]).toMatchObject({ trust: 'known', online: true, transport: 'browser-pipe' });
    expect(hostPeers[0].grants.map((g) => g.capability.name).sort()).toEqual(['city.view', 'compute.gpu', 'compute.inference']);
    const guestPeers = (await gw.command('p2p.peers')).peers;
    expect(guestPeers[0].identity.peerId).toBe((await hw.command('p2p.identity')).peerId);

    // A second window on the host cannot feed the host's pipe.
    const other = await windowOf(host);
    await expect(other.command('p2p.pipe.in', { pipeId: 'pp_0', data: 'x' })).rejects.toMatchObject({ code: 'not_found' });

    // Revoke from the host's window reaches the guest engine.
    const gpu = hostPeers[0].grants.find((g) => g.capability.name === 'compute.gpu');
    await hw.command('p2p.revoke', { grantId: gpu.id });
    await until(async () => false === (await gw.command('p2p.peers')).peers[0].held.some((g) => g.id === gpu.id), 3000);
    const held = (await gw.command('p2p.peers')).peers[0].held.map((g) => g.id);
    expect(held).not.toContain(gpu.id);

    // The events in the log carry ids and names, never words or the SAS.
    const types = host.bus.events.map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['p2p.join', 'p2p.peer', 'p2p.grant', 'p2p.revoke']));
    const log = JSON.stringify(host.bus.events) + JSON.stringify(guest.bus.events);
    for (const w of invite.words) expect(log).not.toContain(`"${w}"`);
    expect(log).not.toContain(request.sas.join(' '));

    // The guest's window closes: its pipe and session end there, and the host's window sees its
    // data channel close and says so.
    gw.ws.close();
    await hw.command('p2p.pipe.close', { pipeId: r.ends.a, reason: 'the data channel closed' });
    await until(async () => !(await hw.command('p2p.peers')).peers[0].online, 4000).catch(() => {});
    expect((await hw.command('p2p.peers')).peers[0].online).toBe(false);
  });

  it('wrong words through the windows fail on both sides and burn the invite', async () => {
    const host = await engine('rita');
    const guest = await engine('ben');
    const hw = await windowOf(host);
    const gw = await windowOf(guest);
    const invite = await hw.command('p2p.invite.create', {});
    const join = await gw.command('p2p.join', { words: 'abandon ability able about above absent' });
    expect(join.rendezvous.topic).not.toBe(invite.rendezvous.topic);
    // Someone who watched the relays knows the topic and knocks with the wrong words: the
    // window relays the knock to the host engine.
    const realTopic = invite.rendezvous.topic;
    gw.onLive((m) => {
      if (m.type === 'p2p.pipe.out' && m.data.data.includes('"hs.1"')) m.data.data = m.data.data.replace(/"inv":"[^"]+"/, `"inv":"${realTopic}"`);
    });
    const r = relay(hw, gw);
    r.setA((await hw.command('p2p.pipe.open', {})).pipeId);
    r.setB((await gw.command('p2p.pipe.open', { joinId: join.joinId })).pipeId);
    await until(() => gw.liveOf('p2p.join.update').some((u) => u.phase === 'failed'), 5000);
    expect(gw.liveOf('p2p.join.update').find((u) => u.phase === 'failed').reason).toBe('words');
    await until(() => hw.liveOf('p2p.invite.burned').length);
    expect((await hw.command('p2p.invite.list')).invites[0].state).toBe('burned');
  });

  it('the Lend screen commands make compute grants from the form and Stop lending revokes them', async () => {
    const host = await engine('rita', { lendPlugin: true });
    const guest = await engine('ben');
    const hw = await windowOf(host);
    const gw = await windowOf(guest);
    const form = { gpu: { on: true, maxVramGB: 6 }, cpu: { on: true, threads: 4 }, ram: { on: true, maxGB: 8 }, storage: { on: false }, minutes: 45 };
    await expect(hw.command('lend.offer', { form: { gpu: { on: false }, cpu: { on: false } } })).rejects.toMatchObject({ code: 'bad_request' });
    const offer = await hw.command('lend.offer', { form });
    expect(offer.offeredCaps.map((c) => c.name)).toEqual(['compute.inference', 'compute.gpu', 'compute.cpu', 'compute.ram']);
    const join = await gw.command('p2p.join', { words: offer.words, requestedCaps: [] });
    const r = relay(hw, gw);
    r.setA((await hw.command('p2p.pipe.open', {})).pipeId);
    r.setB((await gw.command('p2p.pipe.open', { joinId: join.joinId })).pipeId);
    await until(() => hw.liveOf('p2p.join.request').length);
    const request = hw.liveOf('p2p.join.request')[0];
    await expect(hw.command('lend.accept', { requestId: request.requestId, form })).rejects.toMatchObject({ code: 'sas_unconfirmed' });
    await hw.command('lend.accept', { requestId: request.requestId, form, sasMatches: true });
    const lending = (await hw.command('lend.grants')).lending;
    expect(lending).toHaveLength(1);
    const byName = Object.fromEntries(lending[0].grants.map((g) => [g.capability.name, g]));
    expect(byName['compute.gpu'].capability.limits.maxVramBytes).toBe(6 * 1024 ** 3);
    expect(byName['compute.cpu'].capability.limits.maxThreads).toBe(4);
    expect(byName['compute.ram'].capability.limits.maxBytes).toBe(8 * 1024 ** 3);
    expect(Date.parse(byName['compute.gpu'].expiresAt) - Date.parse(byName['compute.gpu'].grantedAt)).toBe(45 * 60_000);
    const status = await hw.command('lend.status');
    expect(status.p2p.lending[0].grants).toHaveLength(4);

    const stopped = await hw.command('lend.stop', {});
    expect(stopped.revoked).toBe(4);
    expect((await hw.command('lend.grants')).lending).toEqual([]);
    await until(async () => (await gw.command('p2p.peers')).peers[0]?.held.every((g) => !g.capability.name.startsWith('compute.')), 3000).catch(() => {});
    expect((await gw.command('p2p.peers')).peers[0].held.map((g) => g.capability.name)).toEqual(['city.view']);
  });
});
