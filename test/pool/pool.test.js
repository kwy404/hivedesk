// Pooled models over llama.cpp RPC: the lender's consent and limits, the tunnel, the build choice and
// the borrower's llama-server arguments. Fakes only: no rpc-server runs here (test/pool/e2e-pool.mjs runs one).
import { describe, it, expect } from 'vitest';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { RpcLender, processMemory, gpuDevice } from '../../src/brain/pool/lender.js';
import { loopback, ListenEnd, DialEnd, MAX_CHANNELS } from '../../src/brain/pool/tunnel.js';
import { platformKey, installBuild, RELEASE } from '../../src/brain/pool/release.js';
import { serverArgs } from '../../src/brain/pool/session.js';
import { tmpDir, waitFor } from '../helpers.js';

const GB = 1e9;
const HW = { os: 'win32', arch: 'x64', gpu: { name: 'NVIDIA GeForce GTX 1060 6GB', vramBytes: 6.44 * GB, backend: 'cuda' }, ramBytes: 16 * GB, cpus: 4, cpu: { cores: 4 } };

/** A fake rpc-server: listens on the port it was given, records its arguments. */
function fakeSpawn(record) {
  return (bin, args) => {
    const proc = new EventEmitter();
    proc.pid = 4242;
    proc.stderr = new EventEmitter();
    const port = Number(args[args.indexOf('-p') + 1]);
    const host = args[args.indexOf('-H') + 1];
    const server = net.createServer((s) => s.pipe(s)).listen(port, host);
    proc.kill = () => { if (proc.killed) return; proc.killed = true; server.close(); setImmediate(() => proc.emit('exit', 0)); };
    record.push({ bin, args, proc });
    return proc;
  };
}

function lender(opts = {}) {
  const spawned = [];
  const bus = { events: [], emit(type, data) { this.events.push({ type, data }); } };
  const l = new RpcLender({
    home: opts.home ?? null, hw: HW, bus, spawnImpl: fakeSpawn(spawned), watchMs: 20,
    binaries: async () => ({ rpc: 'ggml-rpc-server' }),
    memoryOf: opts.memoryOf || (async () => 0.5 * GB), vramUsed: opts.vramUsed || (async () => 1 * GB)
  });
  return { l, spawned, bus };
}
const shareOn = { gpu: { enabled: true, maxVramBytes: 4 * GB, maxMinutes: 30, maxJobs: 1 }, cpu: { enabled: true, maxThreads: 2, maxRamBytes: 3 * GB, maxMinutes: 30, maxJobs: 1 } };

describe('lending rpc-server: consent and limits', () => {
  it('is off by default: no lease, no process', () => {
    const { l, spawned } = lender();
    expect(l.settings().share.gpu.enabled).toBe(false);
    expect(l.settings().share.cpu.enabled).toBe(false);
    expect(() => l.lease({ peerId: 'p1', kind: 'cpu' })).toThrow(expect.objectContaining({ code: 'sharing_off' }));
    expect(spawned).toEqual([]);
  });

  it('leases only to peers on the allowlist, one kind at a time, within the job limit', () => {
    const { l } = lender();
    l.configure({ share: shareOn, peers: ['p1'] });
    expect(() => l.lease({ peerId: 'p2', kind: 'cpu' })).toThrow(expect.objectContaining({ code: 'not_granted' }));
    const a = l.lease({ peerId: 'p1', kind: 'cpu', minutes: 999 });
    expect(a.limits).toEqual({ ramBytes: 3 * GB, threads: 2 });
    expect(Date.parse(a.expiresAt) - Date.now()).toBeLessThanOrEqual(30 * 60_000);
    expect(() => l.lease({ peerId: 'p1', kind: 'cpu' })).toThrow(expect.objectContaining({ code: 'busy' }));
    expect(l.lease({ peerId: 'p1', kind: 'gpu' }).limits).toEqual({ vramBytes: 4 * GB });
    expect(() => l.lease({ peerId: 'p1', kind: 'disk' })).toThrow(expect.objectContaining({ code: 'bad_input' }));
    l.stopAll();
  });

  it('clamps the limits to the machine: never every core, never more VRAM than the card minus 1 GB', () => {
    const { l } = lender();
    const s = l.configure({ share: { gpu: { enabled: true, maxVramBytes: 99 * GB }, cpu: { enabled: true, maxThreads: 64, maxRamBytes: 99 * GB } }, peers: ['p1', 'bad peer id!'] });
    expect(s.share.gpu.maxVramBytes).toBe(5.44 * GB);
    expect(s.share.cpu.maxThreads).toBe(3);
    expect(s.share.cpu.maxRamBytes).toBe(12 * GB);
    expect(s.peers).toEqual(['p1']);
  });

  it('starts rpc-server on 127.0.0.1 with the CPU device and the thread limit, or the GPU device', async () => {
    const { l, spawned } = lender();
    l.configure({ share: shareOn, peers: ['p1'] });
    const c = l.lease({ peerId: 'p1', kind: 'cpu' });
    const { port } = await l.start(c.id);
    expect(spawned[0].args).toEqual(['-H', '127.0.0.1', '-p', String(port), '-d', 'CPU', '-t', '2']);
    const g = l.lease({ peerId: 'p1', kind: 'gpu' });
    await l.start(g.id);
    expect(spawned[1].args.slice(-2)).toEqual(['-d', 'CUDA0']);
    expect(gpuDevice({ gpu: { backend: 'vulkan' } })).toBe('Vulkan0');
    expect(gpuDevice({ os: 'darwin', gpu: { backend: 'metal' } })).toBe('MTL0');
    l.stopAll();
    await waitFor(() => spawned.every((s) => s.proc.killed));
  });

  it('revoke kills rpc-server at once; turning the share off or removing the peer ends its leases', async () => {
    const { l, spawned, bus } = lender();
    l.configure({ share: shareOn, peers: ['p1'] });
    const a = l.lease({ peerId: 'p1', kind: 'cpu' });
    await l.start(a.id);
    expect(l.revoke(a.id)).toBe(true);
    expect(spawned[0].proc.killed).toBe(true);
    expect(bus.events.find((e) => e.type === 'pool.lend.ended').data).toMatchObject({ id: a.id, why: 'revoked' });
    const b = l.lease({ peerId: 'p1', kind: 'cpu' });
    await l.start(b.id);
    l.configure({ share: { ...shareOn, cpu: { ...shareOn.cpu, enabled: false } } });
    expect(spawned[1].proc.killed).toBe(true);
    const g = l.lease({ peerId: 'p1', kind: 'gpu' });
    l.configure({ peers: [] });
    expect(bus.events.filter((e) => e.type === 'pool.lend.ended').map((e) => e.data.why)).toEqual(['revoked', 'sharing_off', 'not_granted']);
    expect(l.settings().active).toEqual([]);
    void g;
  });

  it('a watchdog stops rpc-server over its RAM or VRAM limit', async () => {
    let ram = 1 * GB;
    const { l, spawned, bus } = lender({ memoryOf: async () => ram });
    l.configure({ share: shareOn, peers: ['p1'] });
    const a = l.lease({ peerId: 'p1', kind: 'cpu' });
    await l.start(a.id);
    ram = 4 * GB;
    await waitFor(() => spawned[0].proc.killed);
    expect(bus.events.find((e) => e.type === 'pool.lend.ended').data.why).toBe('ram');
    let vram = 1 * GB;
    const g = lender({ vramUsed: async () => vram });
    g.l.configure({ share: shareOn, peers: ['p1'] });
    const gl = g.l.lease({ peerId: 'p1', kind: 'gpu' });
    await g.l.start(gl.id);
    vram = 6 * GB;
    await waitFor(() => g.spawned[0].proc.killed);
    expect(g.bus.events.find((e) => e.type === 'pool.lend.ended').data.why).toBe('vram');
  });

  it('the lease ends at its expiry', async () => {
    const { l, spawned, bus } = lender();
    l.configure({ share: { ...shareOn, cpu: { ...shareOn.cpu, maxMinutes: 5 } }, peers: ['p1'] });
    const a = l.lease({ peerId: 'p1', kind: 'cpu', minutes: 5 });
    await l.start(a.id);
    // Fast forward: the expiry timer fires revoke(id, 'expired').
    l.revoke(a.id, 'expired');
    expect(spawned[0].proc.killed).toBe(true);
    expect(bus.events.find((e) => e.type === 'pool.lend.ended').data.why).toBe('expired');
  });

  it('keeps the shares and the allowlist in pool/share.json', () => {
    const home = tmpDir();
    const a = lender({ home });
    a.l.configure({ share: shareOn, peers: ['p1'] });
    const b = lender({ home });
    expect(b.l.settings()).toMatchObject({ share: { cpu: { enabled: true, maxThreads: 2 } }, peers: ['p1'] });
  });

  it('reads the memory of a process on Windows, Linux and macOS', async () => {
    expect(await processMemory(7, 'win32', async () => '"rpc.exe","7","Console","1","1.234.567 K"\r\n')).toBe(1234567 * 1024);
    expect(await processMemory(7, 'darwin', async () => ' 2048\n')).toBe(2048 * 1024);
  });
});

describe('the tunnel', () => {
  it('carries bytes both ways through JSON frames, with flow control, on 127.0.0.1 only', async () => {
    const echo = net.createServer((s) => s.pipe(s));
    await new Promise((r) => echo.listen(0, '127.0.0.1', r));
    const { listen, dial } = loopback('ls_test', echo.address().port);
    const port = await listen.listen();
    expect(listen.server.address().address).toBe('127.0.0.1');
    const data = crypto.randomBytes(3 * 1024 * 1024);
    const got = await new Promise((resolve, reject) => {
      const chunks = [];
      let n = 0;
      const c = net.connect({ host: '127.0.0.1', port }, () => c.write(data));
      c.on('data', (b) => { chunks.push(b); n += b.length; if (n >= data.length) { c.destroy(); resolve(Buffer.concat(chunks)); } });
      c.on('error', reject);
    });
    expect(got.equals(data)).toBe(true);
    expect(listen.bytesOut).toBe(data.length);
    expect(dial.bytesIn).toBe(data.length);
    listen.close();
    dial.close();
    echo.close();
  });

  it('ignores frames of another lease, refuses a bad port, and caps the channels', () => {
    const sent = [];
    const d = new DialEnd({ lease: 'ls_a', port: 1, send: (f) => sent.push(f) });
    expect(d.receive({ k: 'open', lease: 'ls_b', ch: 0 })).toBe(false);
    expect(d.receive({ k: 'data', lease: 'ls_a', ch: 99, b64: 'AA==' })).toBe(false);
    expect(() => new DialEnd({ lease: 'x', port: 0, send() {} })).toThrow(/port/);
    expect(() => new ListenEnd({ lease: '', send() {} })).toThrow(/lease/);
    for (let i = 0; i < MAX_CHANNELS; i++) d.receive({ k: 'open', lease: 'ls_a', ch: i });
    expect(d.receive({ k: 'open', lease: 'ls_a', ch: 100 })).toBe(false);
    expect(sent.at(-1)).toMatchObject({ k: 'end', ch: 100, why: 'refused' });
    d.close();
  });
});

describe('the build and the borrower', () => {
  it('picks the official build for the machine and the role', () => {
    expect(platformKey({ os: 'win32', arch: 'x64', gpu: { backend: 'cuda' } }, 'gpu')).toBe('win-cuda-x64');
    expect(platformKey({ os: 'win32', arch: 'x64', gpu: { backend: 'cuda' } }, 'cpu')).toBe('win-cpu-x64');
    expect(platformKey({ os: 'win32', arch: 'x64', gpu: { backend: 'vulkan' } }, 'gpu')).toBe('win-vulkan-x64');
    expect(platformKey({ os: 'darwin', arch: 'arm64' }, 'gpu')).toBe('macos-arm64');
    expect(platformKey({ os: 'linux', arch: 'x64', gpu: null }, 'gpu')).toBe('linux-x64');
    for (const files of Object.values(RELEASE.platforms)) for (const f of files) {
      expect(f.url).toMatch(/^https:\/\/github\.com\/ggml-org\/llama\.cpp\/releases\/download\//);
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(RELEASE.platforms['win-cuda-x64']).toHaveLength(2);
  });

  it('never installs llama.cpp without a yes', async () => {
    await expect(installBuild(tmpDir(), 'win-cpu-x64', {})).rejects.toMatchObject({ code: 'needs_consent' });
  });

  it('runs llama-server on 127.0.0.1 with the RPC workers and the split from the plan', () => {
    const a = serverArgs({ model: 'm.gguf', rpcPorts: [5001, 5002], ctx: 4096, port: 9000, split: [0.75, 0.25] });
    expect(a).toEqual(['-m', 'm.gguf', '--rpc', '127.0.0.1:5001,127.0.0.1:5002', '-ngl', '999', '-c', '4096', '-np', '1', '--host', '127.0.0.1', '--port', '9000', '-ts', '0.75,0.25']);
    expect(serverArgs({ model: 'm', rpcPorts: [1], port: 2, split: [0.5, 0.5] })).not.toContain('-ts');
  });
});
