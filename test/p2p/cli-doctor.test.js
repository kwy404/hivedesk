// The invite, join and peers subcommands (headless and through a running engine) and the doctor
// P2P checks, with a local STUN server for the NAT classification.
import fs from 'node:fs';
import path from 'node:path';
import dgram from 'node:dgram';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
// GitHub's hosted Windows runners give new files extra ACL entries, so the owner only check cannot pass there;
// it runs on real Windows PCs and on every other platform.
const HOSTED_WINDOWS = process.platform === 'win32' && !!process.env.GITHUB_ACTIONS;
import { runInvite, runJoin, runPeers, engineClient, findPeer } from '../../src/p2p/cli.js';
import { runP2PChecks, classifyNat, parseStunResponse, probeBroker, stunRequest } from '../../src/p2p/doctor.js';
import { runDoctor } from '../../src/doctor.js';
import { EventBus } from '../../src/bus.js';
import { createServer } from '../../src/server.js';
import { attachP2P } from '../../src/p2p/engine.js';
import { loadOrCreateIdentity } from '../../src/p2p/identity.js';
import { AuditLog } from '../../src/p2p/audit.js';
import { cleanHomes, tempHome, until } from './helpers.js';

afterEach(cleanHomes);

const FAST = { iterations: 1000, handshakeMs: 4000 };

function term(answers = []) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let text = '';
  stdout.on('data', (c) => (text += c));
  for (const a of answers) stdin.write(a + '\n');
  return { stdin, stdout, stderr: stdout, get text() { return text; }, end: () => stdin.end() };
}

describe('hivedesk invite, join and peers over the LAN', () => {
  it('headless: invite prints the words, join shows the same check words, the host accepts in the terminal', async () => {
    const hostHome = tempHome('host');
    const guestHome = tempHome('guest');
    const host = term(['yes', 'y', 'y', '', 'y']);
    const inviting = runInvite(['--lan', '127.0.0.1:0', '--caps', 'compute.inference,compute.gpu', '--name', 'Rita'], { home: hostHome, ...host, engine: null, nodeOptions: FAST });
    await until(() => /hivedesk join "([a-z ]+)" --lan 127\.0\.0\.1:(\d+)/.test(host.text));
    const [, words, port] = /hivedesk join "([a-z ]+)" --lan 127\.0\.0\.1:(\d+)/.exec(host.text);
    const guest = term();
    const code = await runJoin([words, '--lan', `127.0.0.1:${port}`, '--caps', 'compute.inference', '--name', 'Ben'], { home: guestHome, ...guest, engine: null, nodeOptions: FAST });
    expect(await inviting).toBe(0);
    expect(code).toBe(0);
    const hostSas = /check words:\s+([a-z ]+)/.exec(host.text)[1].trim();
    const guestSas = /Check words: ([a-z ]+)/.exec(guest.text)[1].trim();
    expect(guestSas).toBe(hostSas);
    expect(guest.text).toMatch(/Accepted with city\.view, compute\.inference, compute\.gpu|Accepted with compute\.inference, compute\.gpu, city\.view/);

    const list = term();
    expect(await runPeers([], { home: hostHome, ...list, engine: null })).toBe(0);
    expect(list.text).toMatch(/Ben {2}hd1[a-z2-7]{4}-[a-z2-7]{4} {2}known/);
    expect(list.text).toMatch(/may here: {2}compute\.gpu/);

    const rev = term();
    expect(await runPeers(['--revoke', 'ben'], { home: hostHome, ...rev, engine: null })).toBe(0);
    expect(rev.text).toMatch(/Revoked 3 grants/);
    const blk = term();
    expect(await runPeers(['--block', 'Ben', '--json'], { home: hostHome, ...blk, engine: null })).toBe(0);
    const peers = JSON.parse(blk.text.slice(blk.text.indexOf('[')));
    expect(peers[0].trust).toBe('blocked');
    expect(new AuditLog({ dir: path.join(hostHome, 'audit') }).verify().ok).toBe(true);
  });

  it('the check words that do not match end in a refusal', async () => {
    const host = term(['no']);
    const inviting = runInvite(['--lan', '127.0.0.1:0'], { home: tempHome('h'), ...host, engine: null, nodeOptions: FAST });
    await until(() => /--lan 127\.0\.0\.1:(\d+)/.test(host.text));
    const [, words, port] = /hivedesk join "([a-z ]+)" --lan 127\.0\.0\.1:(\d+)/.exec(host.text);
    const guest = term();
    expect(await runJoin([words, '--lan', `127.0.0.1:${port}`], { home: tempHome('g'), ...guest, engine: null, nodeOptions: FAST })).toBe(1);
    expect(await inviting).toBe(1);
    expect(guest.text).toMatch(/Not accepted: sas_mismatch/);
  });

  it('says that relay pairing needs the window, and refuses unknown capabilities', async () => {
    const a = term();
    expect(await runInvite([], { home: tempHome(), ...a, engine: null })).toBe(2);
    expect(a.text).toMatch(/hivedesk window/);
    const b = term();
    expect(await runJoin(['abandon ability able about above absent'], { home: tempHome(), ...b, engine: null })).toBe(2);
    expect(b.text).toMatch(/--join/);
    const c = term();
    expect(await runInvite(['--lan', '127.0.0.1:0', '--caps', 'root.shell'], { home: tempHome(), ...c, engine: null })).toBe(2);
    expect(c.text).toMatch(/unknown capability: root\.shell/);
  });

  it('uses the running engine through its token when there is one', async () => {
    const home = tempHome('engine');
    const bus = new EventBus({});
    const server = createServer({ bus, hive: {}, scheduler: { prompts: new Map() }, approvals: {}, playbooks: {}, toolbox: {}, version: 'test' });
    const p2p = attachP2P({ bus, server, config: { home, name: 'Rita' }, nodeOptions: FAST });
    await server.listen(0);
    fs.writeFileSync(path.join(home, 'token'), server.token + '\n');
    try {
      const engine = await engineClient({ home, port: server.port });
      expect(engine).not.toBeNull();
      expect(await engineClient({ home: tempHome('none'), port: server.port })).toBeNull();
      const host = term(['yes', 'y', '', 'y']);
      const inviting = runInvite(['--lan', '127.0.0.1:0', '--caps', 'compute.cpu'], { home, ...host, engine });
      await until(() => /--lan 127\.0\.0\.1:(\d+)/.test(host.text));
      const [, words, port] = /hivedesk join "([a-z ]+)" --lan 127\.0\.0\.1:(\d+)/.exec(host.text);
      const guest = term();
      expect(await runJoin([words, '--lan', `127.0.0.1:${port}`, '--caps', 'compute.cpu'], { home: tempHome('g'), ...guest, engine: null, nodeOptions: FAST })).toBe(0);
      expect(await inviting).toBe(0);
      const peers = (await engine.call('p2p.peers')).peers;
      expect(peers[0].grants.map((g) => g.capability.name).sort()).toEqual(['city.view', 'compute.cpu']);
      expect(findPeer(peers, peers[0].identity.fingerprint.short).identity.peerId).toBe(peers[0].identity.peerId);
    } finally {
      await p2p.close();
      await server.close();
      bus.close();
    }
  });
});

/** A STUN server on 127.0.0.1 that reports the mapped address it is told to. */
async function fakeStun(mapped) {
  const sock = dgram.createSocket('udp4');
  sock.on('message', (msg, rinfo) => {
    if (msg.readUInt16BE(0) !== 0x0001) return;
    const res = Buffer.alloc(32);
    res.writeUInt16BE(0x0101, 0);
    res.writeUInt16BE(12, 2);
    msg.copy(res, 4, 4, 20);
    res.writeUInt16BE(0x0020, 20);
    res.writeUInt16BE(8, 22);
    res[25] = 0x01;
    res.writeUInt16BE((mapped.port ?? rinfo.port) ^ 0x2112, 26);
    const ip = mapped.address.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
    res.writeUInt32BE((ip ^ 0x2112a442) >>> 0, 28);
    sock.send(res, rinfo.port, rinfo.address);
  });
  await new Promise((r) => sock.bind(0, '127.0.0.1', r));
  return { url: `127.0.0.1:${sock.address().port}`, close: () => sock.close() };
}

describe('doctor P2P checks', () => {
  it('parses XOR-MAPPED-ADDRESS and classifies cone, symmetric and blocked NATs', async () => {
    const req = stunRequest();
    expect(req.bytes.readUInt32BE(4)).toBe(0x2112a442);
    expect(parseStunResponse(Buffer.alloc(10))).toBeNull();

    const a = await fakeStun({ address: '203.0.113.7', port: 40000 });
    const b = await fakeStun({ address: '203.0.113.7', port: 40000 });
    const c = await fakeStun({ address: '203.0.113.7', port: 40001 });
    try {
      const cone = await classifyNat({ servers: [a.url, b.url], timeoutMs: 1000 });
      expect(cone).toMatchObject({ type: 'cone', publicAddress: '203.0.113.7' });
      expect((await classifyNat({ servers: [a.url, c.url], timeoutMs: 1000 })).type).toBe('symmetric');
      expect((await classifyNat({ servers: [a.url, '127.0.0.1:9'], timeoutMs: 500 })).type).toBe('unknown');
      const open = await fakeStun({ address: '127.0.0.1' });
      expect((await classifyNat({ servers: [open.url], timeoutMs: 1000 })).type).toBe('open');
      open.close();
    } finally {
      a.close();
      b.close();
      c.close();
    }
    expect((await classifyNat({ servers: ['127.0.0.1:9', '127.0.0.1:7'], timeoutMs: 300 })).type).toBe('blocked');
  });

  it('a broker that does not answer is reported as unreachable', async () => {
    const r = await probeBroker('wss://127.0.0.1:9/mqtt', { timeoutMs: 1000 });
    expect(r.ok).toBe(false);
  });

  it.skipIf(HOSTED_WINDOWS)('reports the identity, the peers, the audit chain and the ports without writing to the home', async () => {
    const home = tempHome('doc');
    let checks = await runP2PChecks({ home, network: false, stablePort: 0, lanPort: 0 });
    expect(checks.find((c) => c.id === 'p2p.identity')).toMatchObject({ ok: true, detail: expect.stringMatching(/not created yet/) });
    expect(fs.readdirSync(home)).toEqual([]);

    const { identity } = loadOrCreateIdentity(home);
    const log = new AuditLog({ dir: path.join(home, 'audit') });
    log.append({ type: 'identity.created' });
    log.append({ type: 'grant', capability: 'compute.gpu' });
    checks = await runP2PChecks({ home, network: false, stablePort: 0, lanPort: 0 });
    const byId = Object.fromEntries(checks.map((c) => [c.id, c]));
    expect(byId['p2p.identity'].detail).toContain(identity.fingerprint.words.join(' '));
    expect(byId['p2p.key'].ok).toBe(true);
    expect(byId['p2p.audit']).toMatchObject({ ok: true, detail: '2 entries, chain intact' });
    expect(byId['p2p.peers'].ok).toBe(true);
    expect(byId['port.stable'].ok).toBe(true);

    const file = path.join(home, 'audit', fs.readdirSync(path.join(home, 'audit'))[0]);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('compute.gpu', 'compute.cpu'));
    checks = await runP2PChecks({ home, network: false, stablePort: 0, lanPort: 0 });
    expect(checks.find((c) => c.id === 'p2p.audit')).toMatchObject({ ok: false });

    // The engine doctor adds these checks with p2p.
    const report = await runDoctor({ home, hardware: { ramBytes: 16e9, freeRamBytes: 8e9, diskFreeBytes: 1e12, gpu: null }, fetchImpl: async () => { throw new Error('offline'); }, p2p: { network: false, stablePort: 0, lanPort: 0 } });
    expect(report.checks.map((c) => c.id)).toEqual(expect.arrayContaining(['p2p.identity', 'p2p.audit', 'port.stable', 'port.lan']));
  });
});
