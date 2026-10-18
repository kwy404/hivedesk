// The phone remote against an in-process engine (startHive in a demo folder): pairing through the
// real handshake and session, the grant behind every command, approvals, the expired and reused QR,
// revoke, reconnect, rate limits, session expiry, the audit log, live updates and remote desktop.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startHive } from '../../src/index.js';
import registerPhone from '../../src/phone/index.js';
import { RemoteDesk } from '../../src/remote/desk.js';
import { FakeHelper } from '../remote/inproc-port.js';
import { PhoneClient } from '../../ui/phone/core/client.js';
import { readInviteHash, deriveInvite } from '../../ui/phone/core/invite.js';
import { OPS, GRANT_NAMES } from '../../ui/phone/core/grants.js';
import { linkPair, phoneIdentity, until, tick } from './helpers.js';

let app;
let phone;
let clock = Date.now();
const now = () => clock;
const advance = (ms) => { clock += ms; };

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hivedesk-phone-'));
  app = await startHive({ dir, demo: true, demoDelayMs: 0, demoApproveMs: 0, autoStartDemo: false, city: false });
  phone = await registerPhone({
    bus: app.bus, server: app.server, home: app.home, p2p: app.p2p, now, hostName: () => 'Studio PC', hubOptions: { handshakesPerMinute: 1000 },
    run: (type, data) => app.server.runCommand(type, data, null, { kind: 'user' })
  });
});

afterAll(async () => {
  await phone?.close();
  await app?.close();
});

const hub = () => phone.hub;
const all = (on = []) => Object.fromEntries(GRANT_NAMES.map((n) => [n, n === 'phone.status' || on.includes(n)]));

async function inviteFor() {
  const inv = await hub().createInvite();
  const { secret, pin } = readInviteHash(new URL(inv.url).hash);
  const d = await deriveInvite(secret);
  return { inv, invite: { topicId: d.topicId, psk: d.psk, pin } };
}

/** Scans (opens the invite), pairs, and the person accepts with these grants. */
async function pairPhone(grants = [], { name = 'Pixel 9', alg = 'ed25519' } = {}) {
  const id = await phoneIdentity(alg);
  const { invite } = await inviteFor();
  const { conn, link } = linkPair();
  hub().accept(conn);
  const client = new PhoneClient({ identity: id.identity, deviceId: id.deviceId, name, now });
  const r = await client.pair(link, invite);
  const req = await until(() => hub().pairRequests().find((x) => x.device.deviceId === id.deviceId));
  expect(req.sas).toEqual(r.sas);
  const states = [];
  client.on('state', (s) => states.push(s));
  const welcome = new Promise((res) => client.on('welcome', res));
  hub().answerPair(req.requestId, { accept: true, sasMatches: true, grants: all(grants) });
  expect((await r.decision).accepted).toBe(true);
  await welcome;
  return { client, id, r, req, states };
}

const audit = () => app.p2p.node().audit.tail(400).map((x) => x.entry);

describe('pairing', () => {
  it('pairs a phone: the same six words on both screens, the device named in the dialog, status on by default', async () => {
    const { client, req, r, id } = await pairPhone();
    expect(req.device.name).toBe('Pixel 9');
    expect(req.grants['phone.status']).toBe(true);
    expect(r.host.name).toBe('Studio PC');
    expect(client.grants).toEqual(['phone.status']);
    const listed = hub().phones().find((p) => p.deviceId === id.deviceId);
    expect(listed.online).toBe(true);
    expect(JSON.stringify(listed)).not.toMatch(/reconnect/);
    const file = path.join(app.home, 'phones', `${id.deviceId}.json`);
    expect(fs.existsSync(file)).toBe(true);
    expect(audit().some((e) => e.type === 'phone.pair.accepted' && e.deviceId === id.deviceId)).toBe(true);
    client.close();
  });

  it('works with an ECDSA P-256 phone key (browsers without Ed25519)', async () => {
    const { client, id } = await pairPhone([], { alg: 'p256', name: 'Old phone' });
    expect(id.alg).toBe('p256');
    expect(await client.cmd('state.get')).toHaveProperty('crew');
    client.close();
  });

  it('refuses Accept until the person confirms the words match, and a refuse closes the session', async () => {
    const id = await phoneIdentity();
    const { invite } = await inviteFor();
    const { conn, link } = linkPair();
    hub().accept(conn);
    const client = new PhoneClient({ identity: id.identity, deviceId: id.deviceId, name: 'Stranger', now });
    const r = await client.pair(link, invite);
    const req = await until(() => hub().pairRequests().find((x) => x.device.deviceId === id.deviceId));
    expect(() => hub().answerPair(req.requestId, { accept: true, grants: all() })).toThrow(/compare the six words/);
    hub().answerPair(req.requestId, { accept: false, sasMatches: false });
    expect((await r.decision).accepted).toBe(false);
    expect(hub().phones().some((p) => p.deviceId === id.deviceId)).toBe(false);
  });

  it('refuses an expired QR code', async () => {
    const id = await phoneIdentity();
    const { invite } = await inviteFor();
    advance(5 * 60_000 + 1);
    const { conn, link } = linkPair();
    hub().accept(conn);
    const client = new PhoneClient({ identity: id.identity, deviceId: id.deviceId, now });
    await expect(client.pair(link, invite)).rejects.toMatchObject({ code: 'expired' });
    expect(audit().some((e) => e.type === 'phone.invite.refused' && e.reason === 'expired')).toBe(true);
  });

  it('a QR code works once', async () => {
    const { invite } = await inviteFor();
    const a = await phoneIdentity();
    const p1 = linkPair();
    hub().accept(p1.conn);
    const first = new PhoneClient({ identity: a.identity, deviceId: a.deviceId, now });
    await first.pair(p1.link, invite);
    const b = await phoneIdentity();
    const p2 = linkPair();
    hub().accept(p2.conn);
    const second = new PhoneClient({ identity: b.identity, deviceId: b.deviceId, now });
    await expect(second.pair(p2.link, invite)).rejects.toMatchObject({ code: expect.stringMatching(/^(used|unknown)$/) });
    first.close();
  });

  it('only the local person makes invites or answers', async () => {
    await expect(hub().createInvite({ kind: 'peer', peerId: 'x' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(app.server.runCommand('phone.invite.create', {}, null, { kind: 'peer', peerId: 'hd1' + 'a'.repeat(49) })).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('grants', () => {
  const ARGS = {
    'job.create': { request: 'a tiny landing page' },
    'brief.approve': { jobId: 'j_none' },
    'chat.send': { text: 'hello crew' },
    'chat.log': {},
    'approval.get': { approvalId: 'a_none' },
    'approval.resolve': { approvalId: 'a_none', approved: true },
    'worker.pause': { workerId: 'dev' },
    'worker.resume': { workerId: 'dev' },
    'job.cancel': { jobId: 'j_none' },
    'notify.set': { on: true },
    'state.get': {}
  };

  it('every command is refused on the desktop without its grant', async () => {
    const { client } = await pairPhone([]);
    for (const op of Object.keys(OPS)) {
      if (OPS[op].grant === 'phone.status') continue;
      await expect(client.cmd(op, ARGS[op]), op).rejects.toMatchObject({ code: 'not_granted', grant: OPS[op].grant });
    }
    expect(audit().filter((e) => e.type === 'phone.refused' && e.code === 'not_granted').length).toBeGreaterThan(5);
    client.close();
  });

  it('status alone shows jobs and crew but neither approval cards nor chat', async () => {
    const { client } = await pairPhone([]);
    const s = await client.cmd('state.get');
    expect(s.crew.length).toBeGreaterThan(0);
    expect(s.approvals).toEqual({ count: expect.any(Number) });
    expect(s.chat).toBeUndefined();
    expect(JSON.stringify(s)).not.toMatch(/settings|providers|apiKey/);
    client.close();
  });

  it('a phone without status sees nothing, even with other grants', async () => {
    const { client, id } = await pairPhone(['phone.control']);
    hub().setGrants(id.deviceId, { 'phone.status': false });
    await until(() => !client.grants.includes('phone.status'));
    await expect(client.cmd('state.get')).rejects.toMatchObject({ code: 'not_granted' });
    expect((await client.cmd('worker.pause', { workerId: 'dev' })).paused).toBe(true);
    expect(app.bus.state.crew.find((w) => w.id === 'dev').paused).toBe(true);
    await client.cmd('worker.resume', { workerId: 'dev' });
    expect(app.bus.state.crew.find((w) => w.id === 'dev').paused).toBe(false);
    client.close();
  });

  it('crew: a request starts a job through the refiner and the phone approves the brief; chat reaches the crew', async () => {
    const { client, states } = await pairPhone(['phone.crew']);
    const { jobId } = await client.cmd('job.create', { request: 'make a todo app' });
    expect(jobId).toMatch(/^j_/);
    await until(() => states.some((s) => s.jobs.some((j) => j.id === jobId)));
    // A short request gets a question card first (src/crew/domains/): the person at the PC leaves it to the crew.
    const answerCard = async () => {
      const open = Object.values(app.bus.state.questions || {}).find((q) => q.jobId === jobId);
      if (open) await app.router.dispatch('crew.answer', { questionId: open.id, decide: true }, { origin: { kind: 'user' } }).catch(() => {});
      return app.bus.state.jobs.find((j) => j.id === jobId && j.status === 'awaiting_brief');
    };
    const job = await until(answerCard, 8000);
    expect(job.request).toBe('make a todo app');
    const seen = await until(() => states.find((s) => s.jobs.find((j) => j.id === jobId)?.brief));
    expect(seen.jobs.find((j) => j.id === jobId).brief.text.length).toBeGreaterThan(5);
    await client.cmd('brief.approve', { jobId, use: 'original' });
    await until(() => app.bus.state.jobs.find((j) => j.id === jobId).status !== 'awaiting_brief');
    await client.cmd('chat.send', { text: 'from the phone' });
    expect(app.bus.state.chat.general.some((m) => m.from === 'user' && m.text === 'from the phone')).toBe(true);
    const log = await client.cmd('chat.log');
    expect(log.lines.some((m) => m.text === 'from the phone')).toBe(true);
    await expect(client.cmd('chat.send', { channel: 'nobody', text: 'x' })).rejects.toMatchObject({ code: 'not_found' });
    try { app.hive.cancelJob(jobId); } catch { /* already over */ }
    client.close();
  });
});

describe('approvals', () => {
  it('only a phone holding phone.approve sees the card and decides', async () => {
    const pending = app.approvals.request({ jobId: 'j_x', workerId: 'dev', tool: 'run_command', args: { command: 'npm test' }, summary: 'Run npm test', diff: '--- a/x\n+++ b/x\n+line one\n+line two\n-old\n' });
    const approvalId = await until(() => app.bus.state.approvals.find((a) => a.summary === 'Run npm test')?.id);
    const plain = await pairPhone(['phone.crew']);
    const s = await plain.client.cmd('state.get');
    expect(s.approvals.count).toBeGreaterThan(0);
    expect(s.approvals.cards).toBeUndefined();
    await expect(plain.client.cmd('approval.resolve', { approvalId, approved: true })).rejects.toMatchObject({ code: 'not_granted' });
    await expect(plain.client.cmd('approval.get', { approvalId })).rejects.toMatchObject({ code: 'not_granted' });
    plain.client.close();

    const ok = await pairPhone(['phone.approve']);
    const card = await ok.client.cmd('approval.get', { approvalId });
    expect(card).toMatchObject({ tool: 'run_command', command: 'npm test', origin: { worker: 'Dev' }, diff: { added: 2, removed: 1 } });
    const st = await ok.client.cmd('state.get');
    expect(st.approvals.cards.some((c) => c.id === approvalId)).toBe(true);
    await ok.client.cmd('approval.resolve', { approvalId, approved: true });
    const decision = await pending;
    expect(decision.approved).toBe(true);
    expect(audit().some((e) => e.type === 'phone.cmd' && e.op === 'approval.resolve' && e.approved === true && e.ok)).toBe(true);
    ok.client.close();
  });

  it('a phone cannot approve what a model on another machine proposed, only reject it', async () => {
    const pending = app.approvals.request({ jobId: 'j_y', workerId: 'dev', tool: 'run_command', args: { command: 'rm -rf build' }, summary: 'Remote run', remoteOrigin: 'hd1' + 'b'.repeat(49) });
    const approvalId = await until(() => app.bus.state.approvals.find((a) => a.summary === 'Remote run')?.id);
    const { client } = await pairPhone(['phone.approve']);
    await expect(client.cmd('approval.resolve', { approvalId, approved: true })).rejects.toMatchObject({ code: 'forbidden' });
    await client.cmd('approval.resolve', { approvalId, approved: false });
    expect((await pending).approved).toBe(false);
    client.close();
  });
});

describe('strict approvals on the phone', () => {
  it('a phone cannot approve a strict approval or one with an origin, only reject it', async () => {
    const pending = app.approvals.request({ jobId: 'j_z', workerId: 'peer:Rita', tool: 'workbench.write', args: { path: 'a.txt' }, summary: 'Peer write', strict: true, origin: { kind: 'peer', id: 'p1', label: 'Rita' } });
    const approvalId = await until(() => app.bus.state.approvals.find((a) => a.summary === 'Peer write')?.id);
    const { client } = await pairPhone(['phone.approve']);
    await expect(client.cmd('approval.resolve', { approvalId, approved: true })).rejects.toMatchObject({ code: 'forbidden' });
    await client.cmd('approval.resolve', { approvalId, approved: false });
    expect((await pending).approved).toBe(false);
    client.close();
  });
});

describe('revoke, reconnect, limits and expiry', () => {
  async function reconnectOf(p) {
    const { conn, link } = linkPair();
    hub().accept(conn);
    const c = new PhoneClient({ identity: p.id.identity, deviceId: p.id.deviceId, now });
    const w = await c.reconnect(link, { host: { key: p.r.host.key, pin: hub().hostKey.pin }, reconnect: p.r.reconnect });
    return { c, w };
  }

  it('a known phone reconnects without a QR code, with its grants', async () => {
    const p = await pairPhone(['phone.crew']);
    p.client.close();
    await until(() => !hub().phones().find((x) => x.deviceId === p.id.deviceId).online);
    const { c, w } = await reconnectOf(p);
    expect(w.grants).toEqual(['phone.status', 'phone.crew']);
    expect(await c.cmd('chat.log')).toHaveProperty('lines');
    c.close();
  });

  it('revoke closes the session at once and refuses the next reconnect', async () => {
    const p = await pairPhone(['phone.crew']);
    const closed = new Promise((res) => p.client.on('close', res));
    hub().revoke(p.id.deviceId);
    expect(await closed).toMatch(/revoked/);
    await expect(reconnectOf(p)).rejects.toMatchObject({ code: 'unknown_phone' });
    expect(fs.existsSync(path.join(app.home, 'phones', `${p.id.deviceId}.json`))).toBe(false);
    expect(audit().some((e) => e.type === 'phone.revoked' && e.deviceId === p.id.deviceId)).toBe(true);
  });

  it('rate limits commands per phone', async () => {
    const { client } = await pairPhone(['phone.notify']);
    const results = [];
    for (let i = 0; i < 12; i++) results.push(await client.cmd('notify.set', { on: true }).then(() => 'ok', (e) => e.code));
    expect(results.filter((x) => x === 'ok')).toHaveLength(10);
    expect(results.slice(10)).toEqual(['rate_limited', 'rate_limited']);
    client.close();
  });

  it('limits handshakes per minute, so a flood of knocks cannot reach the dialog', async () => {
    const saved = hub().maxHandshakes;
    hub().handshakes = [];
    hub().maxHandshakes = 1;
    const id = await phoneIdentity();
    const a = linkPair();
    hub().accept(a.conn);
    const { invite } = await inviteFor();
    const b = linkPair();
    hub().accept(b.conn);
    const c = new PhoneClient({ identity: id.identity, deviceId: id.deviceId, now });
    await expect(c.pair(b.link, invite)).rejects.toMatchObject({ code: 'busy' });
    expect(audit().some((e) => e.type === 'phone.refused' && e.what === 'handshake' && e.code === 'rate_limited')).toBe(true);
    a.conn.close('test');
    hub().maxHandshakes = saved;
  });

  it('the session expires', async () => {
    const { client } = await pairPhone([]);
    const closed = new Promise((res) => client.on('close', res));
    advance(8 * 60 * 60_000 + 1000);
    hub().sweep();
    expect(await closed).toMatch(/expired/);
  });

  it('notifications go only to phones that hold phone.notify and asked for them', async () => {
    const a = await pairPhone(['phone.notify']);
    const b = await pairPhone([]);
    const na = [];
    const nb = [];
    a.client.on('notice', (n) => na.push(n));
    b.client.on('notice', (n) => nb.push(n));
    await a.client.cmd('notify.set', { on: true });
    const pending = app.approvals.request({ jobId: 'j_z', workerId: 'qa', tool: 'write_file', args: { path: 'a.txt' }, summary: 'Write a.txt' });
    await until(() => na.some((n) => n.kind === 'approval'));
    await tick(50);
    expect(nb).toHaveLength(0);
    const id = app.bus.state.approvals.find((x) => x.summary === 'Write a.txt').id;
    app.approvals.resolve(id, false, 'test', 'user');
    await pending;
    a.client.close();
    b.client.close();
  });
});

describe('remote desktop from the phone', () => {
  const WIN = { view: true, control: true, kind: 'win-input', hotkey: true, indicator: true, reason: null };

  it('asks only with phone.remote; the host grants view or control per session; revoke ends it', async () => {
    const helper = new FakeHelper();
    const desk = new RemoteDesk({ p2p: phone.port, support: WIN, startHelper: () => helper, now });
    const plain = await pairPhone([]);
    const errors = [];
    plain.client.on('remote', (m) => m.t === 'error' && errors.push(m.body.code));
    plain.client.send('cap.request', { capability: { name: 'remote.control' }, reason: 'from my phone' });
    await until(() => errors.includes('not_granted'));
    expect(desk.snapshot().requests).toHaveLength(0);
    plain.client.close();

    const p = await pairPhone(['phone.remote']);
    const got = [];
    p.client.on('remote', (m) => got.push(m));
    p.client.send('cap.request', { capability: { name: 'remote.control' }, reason: 'from my phone' });
    const [req] = await until(() => desk.snapshot().requests.length && desk.snapshot().requests);
    expect(req).toMatchObject({ name: 'Pixel 9', wants: 'control' });
    expect(req.words).toHaveLength(6);
    desk.answer(req.id, { allow: true, view: true, control: true, minutes: 15 });
    const ready = await until(() => got.find((m) => m.t === 'remote.ready'));
    expect(ready.body.mode).toBe('control');
    helper.ready();
    helper.lock(false);
    desk.shareStarted(req.sessionId, { surface: 'monitor', width: 1920, height: 1080 });
    p.client.send('remote.input', { events: [{ k: 'move', x: 0.5, y: 0.5 }, { k: 'btn', b: 0, down: true }, { k: 'btn', b: 0, down: false }] });
    await until(() => helper.calls.some((c) => c[0] === 'button'));
    // locked screen: input is dropped
    helper.lock(true);
    const before = helper.calls.length;
    p.client.send('remote.input', { events: [{ k: 'move', x: 0.1, y: 0.1 }] });
    await tick(60);
    expect(helper.calls.slice(before).some((c) => c[0] === 'move')).toBe(false);
    // turning phone.remote off ends the grant and the share
    hub().setGrants(p.id.deviceId, { 'phone.remote': false });
    await until(() => got.some((m) => m.t === 'remote.stop'));
    expect(phone.port.caps.find(p.id.deviceId, 'remote.control')).toBeNull();
    desk.close();
    p.client.close();
  });
});
