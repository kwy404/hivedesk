// The lender side of a pooled model: rpc-server, started only under an explicit share with limits.
//
// Rules (0.2.1 lend rules, applied to compute):
//   * Off by default. GPU and CPU are separate shares, each with its own limits (clampShare in
//     catalog/pool.js): VRAM for the GPU; threads and RAM for the CPU; minutes and concurrent jobs for both.
//   * Only peers on the allowlist get a lease. A lease has an id, a kind, limits and an expiry.
//   * rpc-server listens on 127.0.0.1 only; the peer reaches it through the tunnel (tunnel.js).
//   * No cloud key, no tool, no file: rpc-server only computes tensors.
//   * Limits are enforced: the lease ends at its expiry, and a watchdog stops rpc-server when its memory
//     goes over the limit (RAM of the process for the CPU, VRAM used since the start for the GPU).
//   * Revoke, Stop and the end of the lease kill the process at once.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { clampShare, shareDefaults } from '../catalog/pool.js';

export class LendError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function run(cmd, args, ms = 4000) {
  return new Promise((resolve) => execFile(cmd, args, { timeout: ms, windowsHide: true }, (err, out) => resolve(err ? null : String(out))));
}

/** Resident memory of a process in bytes, or null. */
export async function processMemory(pid, platform = process.platform, runImpl = run) {
  if (platform === 'win32') {
    const out = await runImpl('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
    const m = out && /"([\d.,\s]+)\s*K"\s*$/m.exec(out.trim());
    return m ? Number(m[1].replace(/[^\d]/g, '')) * 1024 : null;
  }
  if (platform === 'linux') {
    try { const s = fs.readFileSync(`/proc/${pid}/status`, 'utf8'); const m = /VmRSS:\s+(\d+) kB/.exec(s); return m ? Number(m[1]) * 1024 : null; } catch { return null; }
  }
  const out = await runImpl('ps', ['-o', 'rss=', '-p', String(pid)]);
  return out && /\d/.test(out) ? Number(out.trim()) * 1024 : null;
}

/** VRAM used on the first NVIDIA GPU, in bytes, or null (other GPUs: the lease limit and expiry still apply). */
export async function gpuUsed(runImpl = run) {
  const out = await runImpl('nvidia-smi', ['--query-gpu=memory.used', '--format=csv,noheader,nounits']);
  const n = out ? Number(out.trim().split(/\r?\n/)[0]) : NaN;
  return Number.isFinite(n) ? n * 1024 * 1024 : null;
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function waitPort(port, ms) {
  const until = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const c = net.connect({ host: '127.0.0.1', port }, () => { c.destroy(); resolve(); });
      c.on('error', () => { c.destroy(); if (Date.now() > until) reject(new Error('rpc-server did not start')); else setTimeout(tryOnce, 200); });
    };
    tryOnce();
  });
}

/** The device name rpc-server should serve for a GPU share, by build. */
export function gpuDevice(hw) {
  const b = hw?.gpu?.backend;
  if (b === 'cuda') return 'CUDA0';
  if (b === 'metal' || (hw?.os || process.platform) === 'darwin') return 'MTL0';
  return 'Vulkan0';
}

export class RpcLender {
  /**
   * @param {{ home: string | null, hw: any, bus?: any, binaries: (kind: 'gpu'|'cpu') => Promise<{ rpc: string } | null>,
   *   spawnImpl?: typeof spawn, memoryOf?: (pid: number) => Promise<number | null>, vramUsed?: () => Promise<number | null>,
   *   now?: () => number, watchMs?: number, log?: (s: string) => void }} opts
   */
  constructor(opts) {
    this.hw = opts.hw;
    this.bus = opts.bus;
    this.binaries = opts.binaries;
    this.spawn = opts.spawnImpl || spawn;
    this.memoryOf = opts.memoryOf || ((pid) => processMemory(pid));
    this.vramUsed = opts.vramUsed || (() => gpuUsed());
    this.now = opts.now || Date.now;
    this.watchMs = opts.watchMs ?? 2000;
    this.log = opts.log || (() => {});
    this.file = opts.home ? path.join(opts.home, 'pool', 'share.json') : null;
    let saved = {};
    try { saved = this.file ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : {}; } catch { saved = {}; }
    this.share = clampShare(saved.share || shareDefaults(), this.hw);
    this.peers = Array.isArray(saved.peers) ? saved.peers.filter((p) => typeof p === 'string').slice(0, 64) : [];
    /** @type {Map<string, any>} */
    this.leases = new Map();
  }

  emit(type, data) { this.bus?.emit?.(type, data); }

  settings() {
    return { share: this.share, peers: [...this.peers], active: [...this.leases.values()].map(publicLease) };
  }

  /** Sets the shares and the allowlist (from Settings, by the person at this PC). Turning a share off ends its leases. */
  configure({ share, peers } = {}) {
    if (share) this.share = clampShare(share, this.hw);
    if (Array.isArray(peers)) this.peers = [...new Set(peers.filter((p) => typeof p === 'string' && /^[\w:.-]{1,64}$/.test(p)))].slice(0, 64);
    for (const l of [...this.leases.values()]) {
      if (!this.share[l.kind].enabled) this.revoke(l.id, 'sharing_off');
      else if (!this.peers.includes(l.peerId)) this.revoke(l.id, 'not_granted');
    }
    if (this.file) { try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify({ share: this.share, peers: this.peers }, null, 1)); } catch { /* read only */ } }
    this.emit('pool.share.changed', { gpu: this.share.gpu.enabled, cpu: this.share.cpu.enabled, peers: this.peers.length });
    return this.settings();
  }

  /**
   * A lease for one peer, or a refusal with a code: sharing_off, not_granted, busy.
   * @param {{ peerId: string, kind: 'gpu' | 'cpu', minutes?: number }} req
   */
  lease(req = {}) {
    const kind = req.kind === 'cpu' ? 'cpu' : req.kind === 'gpu' ? 'gpu' : null;
    if (!kind) throw new LendError('bad_input', 'kind must be gpu or cpu');
    const s = this.share[kind];
    if (!s.enabled) { this.emit('pool.lend.refused', { kind, code: 'sharing_off' }); throw new LendError('sharing_off', `${kind.toUpperCase()} sharing is off on this PC`); }
    if (!this.peers.includes(String(req.peerId))) { this.emit('pool.lend.refused', { kind, code: 'not_granted' }); throw new LendError('not_granted', 'this peer is not on the allowlist'); }
    const running = [...this.leases.values()].filter((l) => l.kind === kind).length;
    if (running >= s.maxJobs) { this.emit('pool.lend.refused', { kind, code: 'busy' }); throw new LendError('busy', `already lending ${running} ${kind.toUpperCase()} job(s), the limit is ${s.maxJobs}`); }
    const minutes = Math.min(s.maxMinutes, Math.max(1, Number(req.minutes) || s.maxMinutes));
    const l = {
      id: `ls_${crypto.randomBytes(6).toString('hex')}`, peerId: String(req.peerId), kind,
      limits: kind === 'gpu' ? { vramBytes: s.maxVramBytes } : { ramBytes: s.maxRamBytes, threads: s.maxThreads },
      grantedAt: this.now(), expiresAt: this.now() + minutes * 60_000, state: 'granted', port: null, proc: null, timer: null, watch: null
    };
    this.leases.set(l.id, l);
    l.timer = setTimeout(() => this.revoke(l.id, 'expired'), minutes * 60_000);
    l.timer.unref?.();
    this.emit('pool.lend.granted', publicLease(l));
    return publicLease(l);
  }

  /**
   * A lease under p2p grants (1.0): the grants this person gave the peer are the consent and the limits
   * (compute.pool for the lease, compute.gpu for VRAM, compute.cpu and compute.ram for threads and RAM),
   * clamped to this machine. The share settings above are not used on this path.
   * @param {{ peerId: string, kind: 'gpu' | 'cpu', limits: { vramBytes?: number, ramBytes?: number, threads?: number }, minutes: number, maxLeases: number }} req
   */
  leaseGranted(req) {
    const kind = req.kind === 'cpu' ? 'cpu' : req.kind === 'gpu' ? 'gpu' : null;
    if (!kind) throw new LendError('bad_input', 'kind must be gpu or cpu');
    const mine = [...this.leases.values()].filter((l) => l.peerId === req.peerId).length;
    if (mine >= Math.max(1, req.maxLeases || 1)) throw new LendError('busy', `this peer already holds ${mine} lease(s) here`);
    const clamp = clampShare({
      gpu: { enabled: kind === 'gpu', maxVramBytes: req.limits?.vramBytes || 0, maxMinutes: req.minutes, maxJobs: 4 },
      cpu: { enabled: kind === 'cpu', maxThreads: req.limits?.threads || 0, maxRamBytes: req.limits?.ramBytes || 0, maxMinutes: req.minutes, maxJobs: 4 }
    }, this.hw)[kind];
    if (!clamp.enabled) throw new LendError(kind === 'gpu' ? 'vram' : 'ram', `the granted ${kind === 'gpu' ? 'VRAM' : 'threads and RAM'} do not fit this machine`);
    const minutes = Math.min(clamp.maxMinutes, Math.max(1, Number(req.minutes) || 60));
    const l = {
      id: `ls_${crypto.randomBytes(6).toString('hex')}`, peerId: String(req.peerId), kind,
      limits: kind === 'gpu' ? { vramBytes: clamp.maxVramBytes } : { ramBytes: clamp.maxRamBytes, threads: clamp.maxThreads },
      grantedAt: this.now(), expiresAt: this.now() + minutes * 60_000, state: 'granted', port: null, proc: null, timer: null, watch: null
    };
    this.leases.set(l.id, l);
    l.timer = setTimeout(() => this.revoke(l.id, 'expired'), minutes * 60_000);
    l.timer.unref?.();
    this.emit('pool.lend.granted', publicLease(l));
    return publicLease(l);
  }

  /** The leases of one peer (to end them all when a grant goes away). */
  leasesOf(peerId) {
    return [...this.leases.values()].filter((l) => l.peerId === peerId).map(publicLease);
  }

  /** Starts rpc-server for a lease; resolves with the 127.0.0.1 port the tunnel dials. */
  async start(leaseId) {
    const l = this.leases.get(leaseId);
    if (!l) throw new LendError('not_granted', 'no such lease');
    if (l.proc) return { port: l.port };
    const bins = await this.binaries(l.kind);
    if (!bins?.rpc) throw new LendError('model_missing', 'llama.cpp is not installed on this PC (Settings, Sharing installs it with your yes)');
    l.port = await freePort();
    const args = ['-H', '127.0.0.1', '-p', String(l.port)];
    if (l.kind === 'cpu') args.push('-d', 'CPU', '-t', String(l.limits.threads));
    else args.push('-d', gpuDevice(this.hw));
    l.baseVram = l.kind === 'gpu' ? await this.vramUsed() : null;
    const proc = this.spawn(bins.rpc, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    l.proc = proc;
    let tail = '';
    proc.stderr?.on('data', (c) => { tail = (tail + c).slice(-2000); });
    proc.on('exit', (code) => {
      if (this.leases.get(leaseId) === l && l.state !== 'ended') this._end(l, code === 0 ? 'exited' : 'crashed', tail);
    });
    l.state = 'running';
    try {
      await waitPort(l.port, 20_000);
    } catch (err) {
      this._end(l, 'crashed', tail);
      throw new LendError('crashed', `${err.message}: ${tail.slice(-300)}`);
    }
    l.watch = setInterval(() => this._check(l).catch(() => {}), this.watchMs);
    l.watch.unref?.();
    this.emit('pool.lend.started', publicLease(l));
    this.log(`lending ${l.kind.toUpperCase()} to ${l.peerId} until ${new Date(l.expiresAt).toLocaleTimeString()}`);
    return { port: l.port };
  }

  async _check(l) {
    if (l.state !== 'running' || !l.proc?.pid) return;
    if (l.kind === 'cpu') {
      const used = await this.memoryOf(l.proc.pid);
      if (used != null && used > l.limits.ramBytes * 1.05) this.revoke(l.id, 'ram');
    } else if (l.limits.vramBytes) {
      const used = await this.vramUsed();
      if (used != null && l.baseVram != null && used - l.baseVram > l.limits.vramBytes * 1.05) this.revoke(l.id, 'vram');
    }
  }

  _end(l, why, detail) {
    if (l.state === 'ended') return;
    l.state = 'ended';
    clearTimeout(l.timer);
    clearInterval(l.watch);
    try { l.proc?.kill(); } catch { /* gone */ }
    this.leases.delete(l.id);
    this.emit('pool.lend.ended', { id: l.id, peerId: l.peerId, kind: l.kind, why, ...(detail ? { detail: String(detail).slice(-200) } : {}) });
  }

  /** Ends a lease now: revoke, expiry, a limit, sharing turned off. */
  revoke(leaseId, why = 'revoked') {
    const l = this.leases.get(leaseId);
    if (!l) return false;
    this._end(l, why);
    return true;
  }

  stopAll(why = 'stopped') {
    for (const l of [...this.leases.values()]) this._end(l, why);
  }
}

function publicLease(l) {
  return { id: l.id, peerId: l.peerId, kind: l.kind, limits: { ...l.limits }, expiresAt: new Date(l.expiresAt).toISOString(), state: l.state, port: l.port };
}
