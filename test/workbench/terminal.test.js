import { describe, it, expect, afterEach } from 'vitest';
import { startBench, fakeClient, fakeP2p, PEER_A, PEER_B } from './harness.js';
import { loadPty, resetPtyCache, defaultShell, basicShell } from '../../src/workbench/pty.js';
import { grantAllows } from '../../src/workbench/share.js';
import { TERMINAL_COMMANDS } from '../../src/workbench/origin.js';

const until = async (fn, ms = 15000) => {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 30));
  }
};
const output = (c) => c.of('term.data').map((d) => d.data).join('');

describe('terminal loading', () => {
  afterEach(() => resetPtyCache());
  it('falls back to the basic terminal when node-pty cannot load, and says why', async () => {
    const m = await loadPty(() => Promise.reject(new Error("Cannot find package 'node-pty'")));
    expect(m).toEqual({ error: 'node-pty is not installed' });
    resetPtyCache();
    const m2 = await loadPty(() => Promise.reject(new Error('The module was compiled against a different Node.js version')));
    expect(m2.error).toMatch(/could not load: The module was compiled/);
  });
  it('picks the user shell and a pipe friendly shell for the basic terminal', () => {
    expect(defaultShell('/usr/bin/fish', 'linux')).toEqual({ file: '/usr/bin/fish', args: [] });
    expect(basicShell('', 'win32', { ComSpec: 'C:\\Windows\\cmd.exe' })).toEqual({ file: 'C:\\Windows\\cmd.exe', args: ['/Q', '/K'] });
    expect(basicShell('/bin/bash', 'linux', {})).toEqual({ file: '/bin/bash', args: ['-i'] });
  });
});

describe('terminals on this machine', () => {
  let b;
  afterEach(async () => { await b?.close(); b = null; resetPtyCache(); });

  it('runs a real PTY when node-pty is available', async () => {
    b = await startBench();
    const cap = (await b.run('wb.info', {})).terminal;
    if (cap.kind !== 'pty') return; // no prebuilt node-pty here: the basic test covers it
    const c = fakeClient('t1');
    const t = await b.run('wb.term.open', { cols: 100, rows: 30 }, c);
    expect(t.kind).toBe('pty');
    // Wait for the prompt: some shells drop what is typed before they are ready.
    await until(() => output(c).length > 0);
    await new Promise((r) => setTimeout(r, 800));
    await b.run('wb.term.input', { termId: t.termId, data: 'echo wb-pty-ok\r' });
    // The command's own output line (the echo of what was typed may wrap anywhere).
    const plain = () => output(c).replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g, '');
    await until(() => /(^|\n)wb-pty-ok\s*(\r|\n)/.test(plain()));
    expect(await b.run('wb.term.resize', { termId: t.termId, cols: 120, rows: 40 })).toEqual({ cols: 120, rows: 40 });
    const again = fakeClient('t2');
    const att = await b.run('wb.term.attach', { termId: t.termId }, again);
    expect(att.scrollback).toContain('wb-pty-ok');
    await b.run('wb.term.close', { termId: t.termId });
    await until(() => c.of('term.exit').length > 0);
  });

  it('runs a basic terminal over pipes, labeled, when there is no PTY', async () => {
    b = await startBench({ forceBasicTerminal: true });
    expect((await b.run('wb.info', {})).terminal.kind).toBe('basic');
    const c = fakeClient('t3');
    const t = await b.run('wb.term.open', {}, c);
    expect(t.kind).toBe('basic');
    await b.run('wb.term.input', { termId: t.termId, data: 'echo wb-basic-ok\n' });
    await until(() => output(c).includes('wb-basic-ok'));
    await b.run('wb.term.close', { termId: t.termId });
    await until(() => c.of('term.exit').length > 0);
    await expect(b.run('wb.term.input', { termId: t.termId, data: 'x' })).rejects.toMatchObject({ code: 'conflict' });
  });

  it('refuses every terminal command for a peer, an agent or a forged origin', async () => {
    const p2p = fakeP2p({ peers: [{ peerId: PEER_A, name: 'Rita', online: true }] });
    p2p.give(PEER_A, 'workspace.propose');
    p2p.give(PEER_A, 'terminal.share.write');
    b = await startBench({ p2p, forceBasicTerminal: true });
    const peer = fakeClient('p', { kind: 'peer', peerId: PEER_A });
    const crew = fakeClient('w', { kind: 'crew', agentId: 'dev' });
    const odd = fakeClient('o', { kind: 'admin' });
    for (const type of TERMINAL_COMMANDS) {
      await expect(b.run(type, { termId: 'x', cols: 80, rows: 24 }, peer)).rejects.toMatchObject({ code: 'forbidden' });
      await expect(b.run(type, { termId: 'x' }, crew)).rejects.toMatchObject({ code: 'forbidden' });
      await expect(b.run(type, { termId: 'x' }, odd)).rejects.toMatchObject({ code: 'forbidden' });
    }
    expect(TERMINAL_COMMANDS).toContain('wb.term.open');
    expect(TERMINAL_COMMANDS).toContain('wb.term.share');
  });
});

describe('sharing a terminal with a peer', () => {
  let b;
  afterEach(async () => { await b?.close(); b = null; });

  it('is unavailable without the P2P plane', async () => {
    b = await startBench({ forceBasicTerminal: true });
    const c = fakeClient('h');
    const t = await b.run('wb.term.open', {}, c);
    await expect(b.run('wb.term.share', { termId: t.termId, peerId: PEER_A, mode: 'read' })).rejects.toMatchObject({ code: 'p2p_unavailable' });
  });

  it('needs a per session grant for that peer and that terminal, read only unless write was granted', async () => {
    const p2p = fakeP2p({ peers: [{ peerId: PEER_A, name: 'Rita', online: true }, { peerId: PEER_B, name: 'Bo', online: true }] });
    b = await startBench({ p2p, forceBasicTerminal: true });
    const c = fakeClient('h');
    const t = await b.run('wb.term.open', {}, c);
    // Before any share: nothing reaches the peer.
    expect(() => b.wb.handlePeerMessage({ peerId: PEER_A }, { t: 'term.attach', body: { termId: t.termId } })).toThrow(/not shared/);
    // A standing grant from somewhere else does not open this terminal either.
    p2p.give(PEER_A, 'terminal.share.write');
    expect(() => b.wb.handlePeerMessage({ peerId: PEER_A }, { t: 'term.attach', body: { termId: t.termId } })).toThrow(/not shared/);

    const s = await b.run('wb.term.share', { termId: t.termId, peerId: PEER_A, mode: 'read', minutes: 15 });
    const g = p2p.grants.find((x) => x.id === s.grantId);
    expect(g).toMatchObject({ peerId: PEER_A, scope: 'session', grantedBy: 'user', capability: { name: 'terminal.share.read', limits: { terminalId: t.termId } } });
    const mins = (Date.parse(g.expiresAt) - Date.now()) / 60000;
    expect(mins).toBeGreaterThan(14);
    expect(mins).toBeLessThanOrEqual(15);
    expect(p2p.sent.find((m) => m.t === 'term.offer')).toMatchObject({ peerId: PEER_A, body: { termId: t.termId, mode: 'read' } });

    // Another peer gets nothing.
    expect(() => b.wb.handlePeerMessage({ peerId: PEER_B }, { t: 'term.attach', body: { termId: t.termId } })).toThrow(/not shared/);
    // Peers can never open, resize or close.
    for (const tt of ['term.open', 'term.resize', 'term.close']) expect(() => b.wb.handlePeerMessage({ peerId: PEER_A }, { t: tt, body: { termId: t.termId } })).toThrow(/cannot open/);

    const att = b.wb.handlePeerMessage({ peerId: PEER_A }, { t: 'term.attach', body: { termId: t.termId } });
    expect(att).toMatchObject({ termId: t.termId, mode: 'read' });
    expect(() => b.wb.handlePeerMessage({ peerId: PEER_A }, { t: 'term.input', body: { termId: t.termId, data: 'dir\n' } })).toThrow(/not shared|view only/);
    await b.run('wb.term.input', { termId: t.termId, data: 'echo shared-out\n' });
    await until(() => p2p.sent.some((m) => m.t === 'term.data' && m.body.data.includes('shared-out')));

    // Upgrade to write: input works, and is audited as a byte count, never as content.
    await b.run('wb.term.share', { termId: t.termId, peerId: PEER_A, mode: 'write', minutes: 5 });
    b.wb.handlePeerMessage({ peerId: PEER_A }, { t: 'term.attach', body: { termId: t.termId } });
    const r = b.wb.handlePeerMessage({ peerId: PEER_A }, { t: 'term.input', body: { termId: t.termId, data: 'echo from-peer\n' } });
    expect(r.bytes).toBe(15);
    await until(() => output(c).includes('from-peer'));
    await b.run('wb.term.unshare', { termId: t.termId, peerId: PEER_A });
    const kinds = p2p.audited.map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(['terminal.share.start', 'terminal.share.attach', 'terminal.share.input', 'terminal.share.stop']));
    expect(JSON.stringify(p2p.audited)).not.toContain('from-peer');
    expect(p2p.audited.find((e) => e.kind === 'terminal.share.input').bytes).toBe(15);
    expect(p2p.grants.filter((x) => x.capability.limits?.terminalId === t.termId).every((x) => x.revokedAt)).toBe(true);
    expect(() => b.wb.handlePeerMessage({ peerId: PEER_A }, { t: 'term.input', body: { termId: t.termId, data: 'x' } })).toThrow(/not shared/);
  });

  it('stops at once when the grant is revoked on the P2P side or expires', async () => {
    const p2p = fakeP2p({ peers: [{ peerId: PEER_A, name: 'Rita', online: true }] });
    b = await startBench({ p2p, forceBasicTerminal: true });
    const c = fakeClient('h');
    const t = await b.run('wb.term.open', {}, c);
    const s = await b.run('wb.term.share', { termId: t.termId, peerId: PEER_A, mode: 'write' });
    b.wb.handlePeerMessage({ peerId: PEER_A }, { t: 'term.attach', body: { termId: t.termId } });
    p2p.revoke(s.grantId);
    expect(b.wb.shares.list(t.termId)).toEqual([]);
    expect(p2p.sent.some((m) => m.t === 'term.closed')).toBe(true);
    expect(() => b.wb.handlePeerMessage({ peerId: PEER_A }, { t: 'term.input', body: { termId: t.termId, data: 'x' } })).toThrow(/not shared/);

    const g = { peerId: PEER_A, grantedBy: 'user', scope: 'session', capability: { name: 'terminal.share.read', limits: { terminalId: 't1' } }, expiresAt: new Date(Date.now() - 1000).toISOString() };
    expect(grantAllows(g, { peerId: PEER_A, names: ['terminal.share.read'], termId: 't1' })).toBe(false);
    expect(grantAllows({ ...g, expiresAt: new Date(Date.now() + 60000).toISOString() }, { peerId: PEER_A, names: ['terminal.share.read'], termId: 't1' })).toBe(true);
    expect(grantAllows({ ...g, expiresAt: new Date(Date.now() + 60000).toISOString(), scope: 'standing' }, { peerId: PEER_A, names: ['terminal.share.read'], termId: 't1' })).toBe(false);
    expect(grantAllows({ ...g, expiresAt: null }, { peerId: PEER_A, names: ['terminal.share.read'], termId: 't1' })).toBe(false);
  });
});
