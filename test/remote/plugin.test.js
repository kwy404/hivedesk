import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import registerRemote, { COMMANDS } from '../../src/remote/index.js';
import { deriveAddress, formatAddress } from '../../src/remote/address.js';
import { LinuxClipboard, linuxClipboardKind, uriListToPaths } from '../../src/remote/clipnative.js';
import { createInprocPair, flush, FakeHelper } from './inproc-port.js';
import { tmpDir } from '../helpers.js';

const WIN = { view: true, control: true, kind: 'win-input', hotkey: true, indicator: true, reason: null };
const dirs = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function fakeServer() {
  const commands = new Map();
  const routes = [];
  const live = [];
  return {
    live,
    bus: { live: (type, data) => live.push({ type, data }) },
    server: { command: (n, fn) => commands.set(n, fn), route: (m, p, fn) => routes.push({ m, p, fn }) },
    // The engine router calls a handler with (data, client, { origin }).
    run: (n, d = {}, origin) => commands.get(n)(d, null, origin ? { origin } : undefined),
    commands, routes
  };
}

function engines() {
  const pair = createInprocPair();
  const root = tmpDir('hivedesk-plugin-');
  dirs.push(root);
  const mk = (p2p, name) => {
    const s = fakeServer();
    const helpers = [];
    const api = registerRemote({
      bus: s.bus, server: s.server, p2p, home: path.join(root, name), downloadsDir: path.join(root, `${name}-dl`), support: WIN, clipboardProvider: null,
      startHelper: () => { const h = new FakeHelper(); helpers.push(h); setImmediate(() => { h.ready(); h.lock(false); }); return h; }
    });
    return { ...s, api, helpers };
  };
  return { pair, host: mk(pair.host.port, 'host'), viewer: mk(pair.viewer.port, 'viewer') };
}

describe('remote plug-in', () => {
  it('without p2p it says so for every command and simulates nothing', async () => {
    const s = fakeServer();
    const api = registerRemote({ bus: s.bus, server: s.server });
    expect(api.available).toBe(false);
    expect(await s.run('remote.state')).toMatchObject({ available: false, reason: 'no_p2p' });
    for (const n of COMMANDS.filter((x) => x !== 'remote.state')) await expect(s.run(n)).rejects.toThrow(/p2p control plane/);
  });

  it('refuses commands from a peer or crew origin', async () => {
    const e = engines();
    await expect(e.host.run('remote.stopAll', {}, { kind: 'peer', peerId: 'x' })).rejects.toThrow(/person at this computer/);
    await expect(e.host.run('remote.answer', { requestId: 'rq_x', allow: true }, { kind: 'crew', agentId: 'mel' })).rejects.toThrow(/person at this computer/);
    expect(await e.host.run('remote.state', {}, { kind: 'user' })).toMatchObject({ available: true });
  });

  it('shows this machine\'s 10 digit address and connects to a partner by address, then the host must accept', async () => {
    const e = engines();
    const hostAddr = deriveAddress(e.pair.host.publicKey);
    expect(await e.host.run('remote.address')).toEqual({ address: hostAddr, text: formatAddress(hostAddr), grouped: formatAddress(hostAddr, '334') });
    // Nobody listens yet: the dial fails.
    await expect(e.viewer.run('remote.connect', { address: formatAddress(hostAddr) })).rejects.toThrow(/nobody answers/);
    await e.host.run('remote.listen', { on: true });
    // A typo is caught before anything goes on the network.
    const typo = hostAddr.slice(0, 9) + String((Number(hostAddr[9]) + 1) % 10);
    await expect(e.viewer.run('remote.connect', { address: typo })).rejects.toThrow(/typo/);
    const { sessionId } = await e.viewer.run('remote.connect', { address: hostAddr, control: true, clipboard: true, files: true });
    await flush();
    const st = await e.host.run('remote.state');
    expect(st.requests).toHaveLength(1);
    const rq = st.requests[0];
    expect(rq).toMatchObject({ name: 'Rita', address: deriveAddress(e.pair.viewer.publicKey), wants: 'control', asks: { view: true, control: true, clipboard: true, files: true } });
    expect(rq.addressText).toMatch(/^\d{3} \d{3} \d{3} \d$/);
    expect(rq.avatar.initials).toBe('RI');
    // No access at all before Accept.
    await expect(e.viewer.run('remote.input', { sessionId, events: [{ k: 'move', x: 0, y: 0 }] })).rejects.toThrow(/no remote desktop session/);
    expect(e.pair.host.grants.size).toBe(0);
    const res = await e.host.run('remote.answer', { requestId: rq.id, allow: true, view: true, control: true, clipboard: 'both' });
    expect(res).toMatchObject({ allowed: true, mode: 'control', clipboard: 'both', files: false });
    await flush(40);
    const vs = await e.viewer.run('remote.state');
    expect(vs.views[0]).toMatchObject({ state: 'granted', mode: 'control', clipboard: 'both', files: false });
  });

  it('unattended access is off by default, then lets a known peer in with the password only', async () => {
    const e = engines();
    const sid = e.pair.open();
    await e.viewer.run('remote.unattended.connect', { sessionId: sid, password: 'Correct-Horse-9' });
    await flush(40);
    expect(e.pair.host.grants.size).toBe(0);
    expect(e.pair.auditKinds(e.pair.host)).toContain('remote.unattended.refused');
    await expect(e.host.run('remote.unattended.set', { enabled: true, password: 'short' })).rejects.toThrow(/too short/);
    await e.host.run('remote.unattended.set', { enabled: true, password: 'Correct-Horse-9', allow: { control: false }, minutes: 5 });
    await e.viewer.run('remote.unattended.connect', { sessionId: sid, password: 'Correct-Horse-9', control: true });
    await flush(40);
    const hs = await e.host.run('remote.state');
    expect(hs.shares[0]).toMatchObject({ via: 'unattended', mode: 'view' });
    expect(hs.shares[0].expiresAt - Date.now()).toBeLessThanOrEqual(5 * 60_000);
    // The kill switch still ends it.
    await e.host.run('remote.stopAll', { from: 'banner' });
    expect((await e.host.run('remote.state')).shares).toHaveLength(0);
  });

  it('live frames carry no content: clipboard text and chat are pulled with a command', async () => {
    const e = engines();
    const sid = e.pair.open();
    await e.viewer.run('remote.ask', { sessionId: sid, clipboard: true });
    await flush();
    const [rq] = (await e.host.run('remote.state')).requests;
    await e.host.run('remote.answer', { requestId: rq.id, allow: true, view: true, clipboard: 'both' });
    await flush(40);
    await e.viewer.run('remote.chat.send', { sessionId: sid, text: 'private words' });
    await flush(40);
    expect(JSON.stringify(e.host.live)).not.toMatch(/private words/);
    expect((await e.host.run('remote.chat.log', { sessionId: sid })).lines[0].text).toBe('private words');
  });
});

describe('Linux clipboard (xclip and wl-clipboard)', () => {
  it('picks the tool for the session type', () => {
    const has = (n) => ['xclip', 'wl-paste', 'wl-copy'].includes(n);
    expect(linuxClipboardKind({ DISPLAY: ':0' }, has)).toBe('xclip');
    expect(linuxClipboardKind({ XDG_SESSION_TYPE: 'wayland' }, has)).toBe('wl');
    expect(linuxClipboardKind({ XDG_SESSION_TYPE: 'wayland' }, () => false)).toBe(null);
    expect(uriListToPaths('file:///home/r/a%20b.txt\r\n# comment\nfile:///tmp/x\n')).toEqual(['/home/r/a b.txt', '/tmp/x']);
  });

  it('reads text and HTML, writes files as a uri list, and reports the lock state', async () => {
    const calls = [];
    const clip = { types: 'UTF8_STRING\ntext/html\nTARGETS', UTF8_STRING: 'hello', 'text/html': '<i>hello</i>' };
    const execFile = (cmd, args, o, cb) => {
      calls.push([cmd, ...args]);
      if (cmd === 'loginctl') { cb(null, Buffer.from('no')); return {}; }
      const t = args[args.indexOf('-t') + 1];
      if (args.includes('-o')) { cb(null, Buffer.from(t === 'TARGETS' ? clip.types : clip[t] || '')); return {}; }
      cb(null, Buffer.from(''));
      return { stdin: { on() {}, end(v) { calls.push(['stdin', String(v)]); } } };
    };
    const c = new LinuxClipboard({ kind: 'xclip', execFile, env: { XDG_SESSION_ID: '3' }, setInterval: () => ({ unref() {} }), clearInterval: () => {} });
    expect(await c.read()).toEqual({ text: 'hello', html: '<i>hello</i>' });
    await c._tick();
    expect(c.lockState.locked).toBe(false);
    await c.set({ kind: 'files', paths: ['/home/r/a b.txt'] });
    expect(calls).toContainEqual(['xclip', '-selection', 'clipboard', '-t', 'text/uri-list', '-i']);
    expect(calls).toContainEqual(['stdin', 'file:///home/r/a%20b.txt']);
    c.close();
  });
});
