// The window's half of browser-pipe (ui/lend/core/p2p-pipe.js) against two real engines: the
// windows' sockets are real token WebSockets, the data channel between the windows is an
// in-memory link pair (the stand in for RTCDataChannel, which Node does not have).
import { afterEach, describe, expect, it } from 'vitest';
import { EventBus } from '../../src/bus.js';
import { createServer } from '../../src/server.js';
import { connect } from '../../src/ws.js';
import { attachP2P } from '../../src/p2p/engine.js';
import { registerMessage } from '../../src/p2p/messages.js';
import { Emitter } from '../../ui/lend/core/emitter.js';
import { bridgeLink, importRendezvous, Reassembler, splitFrame, PART_CHARS } from '../../ui/lend/core/p2p-pipe.js';
import { linkPair, until } from './helpers.js';
import { cleanHomes, tempHome } from '../p2p/helpers.js';

const open = [];
afterEach(async () => {
  for (const x of open.splice(0)) await x();
  cleanHomes();
});

async function engine(name) {
  const bus = new EventBus({});
  const server = createServer({ bus, hive: {}, scheduler: { prompts: new Map() }, approvals: {}, playbooks: {}, toolbox: {}, version: 'test' });
  const p2p = attachP2P({ bus, server, config: { home: tempHome(name), name }, nodeOptions: { iterations: 1000, handshakeMs: 4000 } });
  await server.listen(0);
  open.push(async () => {
    await p2p.close();
    await server.close();
    bus.close();
  });
  return { server, p2p };
}

/** What HiveSocket offers the lend code (command, on('live:...')), over src/ws.js. */
async function hiveOf(e) {
  const ws = await connect(`ws://127.0.0.1:${e.server.port}/ws?t=${e.server.token}`, { headers: { host: `127.0.0.1:${e.server.port}` } });
  const hive = new Emitter();
  let next = 1;
  const waiting = new Map();
  ws.on('message', (text) => {
    const m = JSON.parse(text);
    if (m.kind === 'reply') {
      const w = waiting.get(m.id);
      waiting.delete(m.id);
      if (m.ok) w?.resolve(m.result);
      else w?.reject(Object.assign(new Error(m.error.message), { code: m.error.code }));
    } else if (m.kind === 'live') hive.emit(`live:${m.type}`, m.data);
  });
  hive.command = (type, data = {}) => new Promise((resolve, reject) => {
    const id = `h${next++}`;
    waiting.set(id, { resolve, reject });
    ws.sendJson({ kind: 'command', id, type, data });
  });
  open.push(async () => ws.close());
  return hive;
}

describe('frame parts on the data channel', () => {
  it('splits a large frame and joins it again, refusing doubles and foreign parts', () => {
    const big = 'x'.repeat(PART_CHARS * 2 + 5);
    const parts = splitFrame(big);
    expect(parts).toHaveLength(3);
    const r = new Reassembler();
    expect(r.push(parts[0])).toBeNull();
    expect(r.push(parts[0])).toBeNull();
    expect(r.push(parts[2])).toBeNull();
    expect(r.push(parts[1])).toBe(big);
    expect(r.push('{"s":1}')).toBe('{"s":1}');
    expect(r.push('~bad')).toBeNull();
    expect(() => splitFrame('y'.repeat(PART_CHARS * 40))).toThrow(/too large/);
  });

  it('imports the engine meeting point as an AES-GCM key on the v2 topic', async () => {
    const rv = await importRendezvous({ topic: 'abc', seal: Buffer.alloc(32, 7).toString('base64url') });
    expect(rv.topic).toBe('hivedesk/v2/abc');
    expect(rv.key.algorithm.name).toBe('AES-GCM');
  });
});

registerMessage('city.event', { normalize: (b) => ({ blob: typeof b?.blob === 'string' ? b.blob : '' }) });

describe('bridgeLink between two engines', () => {
  it('carries the handshake and the session; a large frame crosses in parts', async () => {
    const host = await engine('rita');
    const guest = await engine('ben');
    const hw = await hiveOf(host);
    const gw = await hiveOf(guest);
    const invite = await hw.command('p2p.invite.create', { caps: [{ name: 'compute.cpu' }] });
    const join = await gw.command('p2p.join', { words: invite.words });
    const [la, lb] = linkPair();
    const requests = [];
    hw.on('live:p2p.join.request', (r) => requests.push(r));
    const updates = [];
    gw.on('live:p2p.join.update', (u) => updates.push(u));
    const [bh, bg] = await Promise.all([bridgeLink(hw, la, {}), bridgeLink(gw, lb, { joinId: join.joinId })]);
    expect(bh.pipeId).toMatch(/^pp_/);
    expect(bg.pipeId).toMatch(/^pp_/);
    await until(() => requests.length && updates.some((u) => u.phase === 'sas'), 5000);
    expect(updates.find((u) => u.phase === 'sas').sas).toEqual(requests[0].sas);
    // What the windows carried: handshake values and ciphertext only.
    const carried = [...la.sent, ...lb.sent].join('\n');
    expect(carried).not.toContain('rita');
    expect(carried).not.toContain(invite.words.join(' '));

    await hw.command('p2p.join.answer', { requestId: requests[0].requestId, accept: true, sasMatches: true, caps: requests[0].toggles.map((t) => ({ capability: t.capability, minutes: 10 })) });
    await until(() => updates.some((u) => u.phase === 'accepted'), 5000);

    const got = [];
    guest.p2p.node().handle('city.event', (msg) => got.push(msg.body.blob.length));
    const guestId = guest.p2p.node().identity.peerId;
    host.p2p.node().send(guestId, 'city.event', { blob: 'z'.repeat(200_000) });
    await until(() => got.length === 1, 5000);
    expect(got[0]).toBe(200_000);
    expect(la.sent.some((m) => m.startsWith('~'))).toBe(true);

    // The data channel closes: the engines' pipes close, the session ends.
    la.close();
    await until(async () => !(await hw.command('p2p.peers')).peers[0].online, 5000);
  });
});
