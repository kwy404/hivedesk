// Pooled giant models: the unlock meter. A giant model needs more memory than one consumer machine has;
// friends in the City can pool what they explicitly shared (GPU VRAM and, separately, CPU RAM and threads).
// Pure math, no I/O. Execution across machines (llama.cpp RPC) is a separate, experimental step: this
// file never says a model is runnable, only whether the pooled memory and the estimated speed are enough.
//
// Honest weighting: capacity counts VRAM and RAM the same (a layer fits in either), but every layer kept on
// a CPU worker is read at CPU memory speed, and every remote worker adds a network round trip per token.
// So the meter shows VRAM and RAM as two segments, and the unlock also needs an estimated speed of at
// least MIN_POOL_TPS tokens per second.
import { memoryNeed, GPU_EFF, CPU_EFF } from './estimate.js';
import { budgets, gpuBandwidth, cpuBandwidth } from './recommend.js';

export const MIN_POOL_TPS = 1;
/** What a typical friend shares, for the "invite 2 to 3 friends" hint. */
export const FRIEND_GPU_SHARE = [8e9, 12e9];
/** Round trip per remote worker per token: same network vs internet. */
export const RTT = { lan: 0.002, internet: 0.06 };
const CPU_WORKER_BW = 20e9;

/** Sharing settings: GPU and CPU are separate capabilities, each with its own limits, both off by default. */
export function shareDefaults() {
  return {
    gpu: { enabled: false, maxVramBytes: 0, maxMinutes: 60, maxJobs: 1 },
    cpu: { enabled: false, maxThreads: 0, maxRamBytes: 0, maxMinutes: 60, maxJobs: 1 }
  };
}

/**
 * Clamps sharing settings to the machine: never more VRAM than the card has minus 1 GB, never every core,
 * never the RAM the OS needs. Missing or unknown fields fall back to the defaults (off).
 */
export function clampShare(share, hw) {
  const d = shareDefaults();
  const s = share && typeof share === 'object' ? share : {};
  const num = (v, lo, hi, def) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : def);
  const vramCap = Math.max(0, (hw?.gpu && !hw.gpu.unified ? hw.gpu.vramBytes : 0) - 1e9);
  const cores = hw?.cpu?.cores || hw?.cpus || 1;
  const ramCap = Math.max(0, (hw?.ramBytes || 0) - 4e9);
  // The compute plane names (maxJobSeconds, maxConcurrentJobs) are read too.
  const alias = (x) => ({ ...x, maxMinutes: x.maxMinutes ?? (x.maxJobSeconds != null ? Number(x.maxJobSeconds) / 60 : undefined), maxJobs: x.maxJobs ?? x.maxConcurrentJobs });
  const g = alias(s.gpu || {});
  const c = alias(s.cpu || {});
  const out = {
    gpu: {
      enabled: g.enabled === true && vramCap > 0,
      maxVramBytes: num(g.maxVramBytes, 0, vramCap, d.gpu.maxVramBytes),
      maxMinutes: num(g.maxMinutes, 5, 480, d.gpu.maxMinutes),
      maxJobs: Math.round(num(g.maxJobs, 1, 4, d.gpu.maxJobs))
    },
    cpu: {
      enabled: c.enabled === true && cores > 1 && ramCap > 0,
      maxThreads: Math.round(num(c.maxThreads, 0, Math.max(0, cores - 1), d.cpu.maxThreads)),
      maxRamBytes: num(c.maxRamBytes, 0, ramCap, d.cpu.maxRamBytes),
      maxMinutes: num(c.maxMinutes, 5, 480, d.cpu.maxMinutes),
      maxJobs: Math.round(num(c.maxJobs, 1, 4, d.cpu.maxJobs))
    }
  };
  if (out.gpu.enabled && !out.gpu.maxVramBytes) out.gpu.enabled = false;
  if (out.cpu.enabled && (!out.cpu.maxRamBytes || !out.cpu.maxThreads)) out.cpu.enabled = false;
  return out;
}

/**
 * What one peer contributes: only what it explicitly shared, only while it is online and its share has not
 * expired. Self reported numbers are capped by clampShare against the hardware the peer reported.
 * @param {{ id: string, name?: string, online?: boolean, hw?: any, share?: any, sharedUntil?: number, network?: 'lan' | 'internet', gpuName?: string }} peer
 */
export function contribution(peer, now = Date.now()) {
  const none = { id: peer.id, name: peer.name || peer.id, vram: 0, ram: 0, threads: 0, gpuBw: 0, network: peer.network === 'lan' ? 'lan' : 'internet', ...(Number.isFinite(peer.rttMs) ? { rttMs: peer.rttMs } : {}) };
  if (!peer || peer.online === false || !peer.share) return none;
  if (peer.sharedUntil && peer.sharedUntil < now) return none;
  // Limits from p2p grants were clamped by the friend's own engine to its machine; a self reported share is clamped here.
  const s = peer.granted ? peer.share : clampShare(peer.share, peer.hw || {});
  return {
    ...none,
    vram: s.gpu.enabled ? s.gpu.maxVramBytes : 0,
    ram: s.cpu.enabled ? s.cpu.maxRamBytes : 0,
    threads: s.cpu.enabled ? s.cpu.maxThreads : 0,
    gpuBw: s.gpu.enabled ? gpuBandwidth(peer.hw?.gpu || { name: peer.gpuName || '', vramBytes: s.gpu.maxVramBytes }) : 0
  };
}

/**
 * The meter for one giant entry.
 * @param {{ bytes: number, arch: any, params: number, activeParams?: number }} p  a catalog pick
 * @param {number} ctx
 * @param {any} hw  this machine
 * @param {any[]} peers  City machines of friends
 */
export function poolMeter(p, ctx, hw, peers = [], now = Date.now()) {
  const need = memoryNeed(p.arch, p.bytes, ctx);
  const b = budgets(hw);
  const me = { id: 'me', vram: b.vram, ram: b.unified ? 0 : b.cpuRam, gpuBw: gpuBandwidth(b.gpu), cpuBw: cpuBandwidth(hw) };
  const friends = peers.map((x) => contribution(x, now));
  const sharedVram = friends.reduce((n, f) => n + f.vram, 0);
  const sharedRam = friends.reduce((n, f) => n + f.ram, 0);
  const vram = me.vram + sharedVram;
  const ram = me.ram + sharedRam;
  const total = vram + ram;
  const missing = Math.max(0, need - total);
  const missingVram = Math.max(0, need - vram);
  // Place the weights: fastest memory first (GPUs by bandwidth, then RAM), and time one token.
  const overhead = need - p.bytes;
  const slots = [
    { who: 'me', kind: 'gpu', bytes: Math.max(0, me.vram - overhead), bw: me.gpuBw * GPU_EFF, remote: false },
    ...friends.filter((f) => f.vram > 0).map((f) => ({ who: f.id, kind: 'gpu', bytes: f.vram, bw: f.gpuBw * GPU_EFF, remote: true, network: f.network, rttMs: f.rttMs })),
    { who: 'me', kind: 'cpu', bytes: me.ram, bw: me.cpuBw * CPU_EFF, remote: false },
    ...friends.filter((f) => f.ram > 0).map((f) => ({ who: f.id, kind: 'cpu', bytes: f.ram, bw: CPU_WORKER_BW * CPU_EFF * Math.min(1, f.threads / 4), remote: true, network: f.network, rttMs: f.rttMs }))
  ].filter((s) => s.bytes > 0 && s.bw > 0).sort((x, y) => (y.kind === 'gpu') - (x.kind === 'gpu') || y.bw - x.bw);
  const active = p.activeParams ? p.activeParams / p.params : 1;
  let left = p.bytes;
  let seconds = 0;
  const plan = [];
  const remotes = new Set();
  for (const s of slots) {
    if (left <= 0) break;
    const take = Math.min(left, s.bytes);
    left -= take;
    seconds += (take * active) / s.bw;
    plan.push({ who: s.who, kind: s.kind, bytes: take });
    // A remote worker costs about two round trips per token (send the activations, get the result).
    if (s.remote) { remotes.add(s.who); seconds += Number.isFinite(s.rttMs) ? (2 * s.rttMs) / 1000 : RTT[s.network] || RTT.internet; }
  }
  const fits = left <= 0;
  const tps = fits && seconds > 0 ? Math.round((1 / seconds) * 10) / 10 : 0;
  const allLan = [...remotes].every((id) => friends.find((f) => f.id === id)?.network === 'lan');
  const friendsHint = missingVram > 0 ? [Math.ceil(missingVram / FRIEND_GPU_SHARE[1]), Math.ceil(missingVram / FRIEND_GPU_SHARE[0])] : [0, 0];
  return {
    need, vram, ram, sharedVram, sharedRam, total, missing, missingVram,
    mine: { vram: me.vram, ram: me.ram },
    peers: friends,
    plan, tps,
    unlocked: fits && tps >= MIN_POOL_TPS && remotes.size > 0,
    network: remotes.size === 0 ? 'none' : allLan ? 'lan' : 'internet',
    friendsHint
  };
}
