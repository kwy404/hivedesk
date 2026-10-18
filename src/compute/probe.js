// Resource probes (PLAN section 10): real CPU, RAM, GPU and VRAM numbers with their source.
// A value that cannot be measured is null and the UI says "not measured"; nothing is guessed.
//
//   CPU      model and threads from node:os; physical cores and AVX2 from the OS (CIM and
//            IsProcessorFeaturePresent on Windows, /proc/cpuinfo on Linux, sysctl on macOS);
//            load from os.cpus() time deltas.
//   RAM      os.totalmem() and os.freemem().
//   NVIDIA   nvidia-smi (name, VRAM total and used, utilization, driver; CUDA version from its header).
//   Windows  AMD, Intel (and NVIDIA without nvidia-smi): DXGI adapters plus the GPU Engine and GPU Adapter
//            Memory performance counters through src/compute/win-gpu.js; CIM and the registry as a fallback.
//   Linux    AMD through /sys/class/drm (gpu_busy_percent, mem_info_vram_*); Intel is listed, numbers unknown.
//   macOS    Apple Silicon has unified memory: the GPU shares RAM ("unified-estimate"); utilization is unknown.
//   runtime  when node-llama-cpp is loaded its own VRAM state fills a free VRAM value nothing else measured.
import os from 'node:os';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { WinGpuHelper } from './win-gpu.js';

const MiB = 1024 ** 2;

export function execText(cmd, args, ms = 4000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: ms, windowsHide: true, maxBuffer: 4 * MiB }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const numOrNull = (s) => {
  const t = String(s ?? '').trim();
  if (!t || /n\/a|not supported|\[/i.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

export const NVIDIA_QUERY = ['--query-gpu=index,name,memory.total,memory.used,memory.free,utilization.gpu,driver_version,pci.bus_id', '--format=csv,noheader,nounits'];

/** Parses the CSV of NVIDIA_QUERY. "[N/A]" and "[Not Supported]" become null, never 0. */
export function parseNvidiaCsv(text) {
  if (!text) return [];
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const c = line.split(',').map((s) => s.trim());
    if (c.length < 7 || !c[1]) continue;
    const total = numOrNull(c[2]);
    const used = numOrNull(c[3]);
    const free = numOrNull(c[4]);
    const util = numOrNull(c[5]);
    out.push({
      index: numOrNull(c[0]) ?? out.length,
      name: c[1],
      vramTotalBytes: total == null ? null : total * MiB,
      vramUsedBytes: used == null ? null : used * MiB,
      vramFreeBytes: free == null ? (total != null && used != null ? (total - used) * MiB : null) : free * MiB,
      utilPct: util == null ? null : Math.max(0, Math.min(100, util)),
      driver: c[6] && !/n\/a/i.test(c[6]) ? c[6] : undefined,
      pciBusId: c[7] || undefined
    });
  }
  return out;
}

/** "CUDA Version: 12.6" from the nvidia-smi header. */
export function parseCudaVersion(text) {
  const m = String(text || '').match(/CUDA Version:\s*([\d.]+)/i);
  return m ? m[1] : null;
}

/** Sum of the os.cpus() times, for load deltas. */
export function cpuTimes(cpus = os.cpus()) {
  let idle = 0;
  let total = 0;
  for (const c of cpus) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

/** Load in percent between two cpuTimes() readings, or null when there is no interval yet. */
export function cpuLoadPct(prev, cur) {
  if (!prev || !cur) return null;
  const dt = cur.total - prev.total;
  if (dt <= 0) return null;
  const busy = dt - (cur.idle - prev.idle);
  return Math.round(Math.max(0, Math.min(100, (busy / dt) * 100)) * 10) / 10;
}

/** Physical cores and AVX2 from /proc/cpuinfo. */
export function parseLinuxCpuinfo(text) {
  if (!text) return { cores: null, avx2: null };
  const pairs = new Set();
  let cpuCores = null;
  let flags = null;
  let phys = '0';
  for (const line of text.split('\n')) {
    const [k, v = ''] = line.split(':').map((s) => s.trim());
    if (k === 'physical id') phys = v;
    else if (k === 'core id') pairs.add(`${phys}:${v}`);
    else if (k === 'cpu cores' && cpuCores == null) cpuCores = Number(v) || null;
    else if (k === 'flags' && flags == null) flags = v.split(/\s+/);
  }
  return { cores: pairs.size || cpuCores, avx2: flags ? flags.includes('avx2') : null };
}

export function vendorOf(name = '', vendorId) {
  if (vendorId === 0x10de || /nvidia|geforce|quadro|rtx|gtx/i.test(name)) return 'nvidia';
  if (vendorId === 0x1002 || vendorId === 0x1022 || /\bamd\b|radeon|ati /i.test(name)) return 'amd';
  if (vendorId === 0x8086 || /intel/i.test(name)) return 'intel';
  if (vendorId === 0x106b || /apple/i.test(name)) return 'apple';
  return 'other';
}

/**
 * The 64 bit VRAM size of a Windows display adapter. Win32_VideoController.AdapterRAM is a 32 bit
 * field that stops at 4 GB, so a value at that ceiling means "at least 4 GB": the registry wins, and
 * without it the size is unknown.
 */
export function windowsVramTotal(controller, registry = []) {
  const reg = registry.find((r) => r && r.name === controller?.name && finite(r.qwMemorySize) && r.qwMemorySize > 0);
  if (reg) return reg.qwMemorySize;
  const ram = finite(controller?.adapterRam);
  if (ram && ram > 0 && ram < 4 * 1024 ** 3 - 2 * MiB) return ram;
  return null;
}

/**
 * Builds the non nvidia-smi GPU list on Windows from the helper's static and sample answers.
 * @param {any} st static answer @param {any} sm sample answer @param {{ skipNvidia: boolean }} opts
 */
export function windowsGpus(st, sm, opts) {
  if (!st) return [];
  const out = [];
  const driverOf = (name) => (st.controllers || []).find((c) => c.name === name)?.driver || undefined;
  if (Array.isArray(st.adapters) && st.adapters.length) {
    for (const a of st.adapters) {
      if (!a || (a.flags & 2) || a.vendorId === 0x1414) continue;   // software adapters (Basic Render Driver)
      const vendor = vendorOf(a.name, a.vendorId);
      if (vendor === 'nvidia' && opts.skipNvidia) continue;
      const luid = String(a.luid || '').toLowerCase();
      const total = finite(a.dedicated) && a.dedicated > 0 ? a.dedicated : null;
      const used = sm?.dedicated && finite(sm.dedicated[luid]) ? sm.dedicated[luid] : null;
      const util = sm?.util && finite(sm.util[luid]) ? Math.round(Math.max(0, Math.min(100, sm.util[luid])) * 10) / 10 : null;
      const integrated = vendor === 'intel' || (total != null && total < 512 * MiB);
      out.push({
        name: a.name, vendor, vramTotalBytes: total, vramUsedBytes: used,
        vramFreeBytes: total != null && used != null ? Math.max(0, total - used) : null,
        utilPct: util, driver: driverOf(a.name),
        sharedBytes: finite(a.shared) ? a.shared : null, integrated,
        luid, source: used != null || util != null ? 'wddm-counters' : 'dxgi'
      });
    }
    return out;
  }
  // No DXGI: names and sizes from CIM and the registry; live numbers are unknown because the
  // counters are keyed by adapter LUID and only DXGI maps a LUID to a name.
  for (const c of st.controllers || []) {
    if (!c?.name || /basic (render|display)/i.test(c.name)) continue;
    const vendor = vendorOf(c.name, /VEN_([0-9A-F]{4})/i.test(c.pnp || '') ? parseInt(c.pnp.match(/VEN_([0-9A-F]{4})/i)[1], 16) : undefined);
    if (vendor === 'nvidia' && opts.skipNvidia) continue;
    out.push({ name: c.name, vendor, vramTotalBytes: windowsVramTotal(c, st.registry), vramUsedBytes: null, vramFreeBytes: null, utilPct: null, driver: c.driver || undefined, integrated: vendor === 'intel', source: 'cim' });
  }
  return out;
}

/** AMD and Intel GPUs from /sys/class/drm on Linux. */
export function linuxDrmGpus({ readdir = (d) => { try { return fs.readdirSync(d); } catch { return []; } }, read = readText, skipNvidia = true } = {}) {
  const out = [];
  for (const card of readdir('/sys/class/drm').filter((n) => /^card\d+$/.test(n)).sort()) {
    const dev = `/sys/class/drm/${card}/device`;
    const vendorId = parseInt(String(read(`${dev}/vendor`) || '').trim(), 16);
    if (!Number.isFinite(vendorId)) continue;
    const deviceId = String(read(`${dev}/device`) || '').trim().replace(/^0x/, '');
    const vendor = vendorOf('', vendorId);
    if (vendor === 'nvidia' && skipNvidia) continue;
    const n = (f) => numOrNull(read(`${dev}/${f}`));
    const total = n('mem_info_vram_total');
    const used = n('mem_info_vram_used');
    const busy = n('gpu_busy_percent');
    const label = { amd: 'AMD GPU', intel: 'Intel GPU', nvidia: 'NVIDIA GPU' }[vendor] || 'GPU';
    out.push({
      name: `${label} ${vendorId.toString(16).padStart(4, '0')}:${deviceId}`, vendor,
      vramTotalBytes: total, vramUsedBytes: used,
      vramFreeBytes: total != null && used != null ? Math.max(0, total - used) : null,
      utilPct: busy == null ? null : Math.max(0, Math.min(100, busy)),
      integrated: vendor === 'intel', source: 'sysfs'
    });
  }
  return out;
}

/**
 * The probe. `staticInfo()` once, `sample()` as often as the caller wants (PLAN: 2 s with a window open,
 * 15 s otherwise). Every dependency can be injected for tests.
 */
export class ResourceProbe {
  /**
   * @param {{ platform?: string, arch?: string, exec?: typeof execText, read?: (f: string) => string | null,
   *           readdir?: (d: string) => string[], cpus?: () => any[], totalmem?: () => number, freemem?: () => number,
   *           winHelper?: { request: (cmd: string, ms: number) => Promise<any>, close?: () => void } | null, now?: () => number }} [opts]
   */
  constructor(opts = {}) {
    this.platform = opts.platform || process.platform;
    this.arch = opts.arch || process.arch;
    this.exec = opts.exec || execText;
    this.read = opts.read || readText;
    this.readdir = opts.readdir;
    this.cpus = opts.cpus || (() => os.cpus());
    this.totalmem = opts.totalmem || (() => os.totalmem());
    this.freemem = opts.freemem || (() => os.freemem());
    this.now = opts.now || Date.now;
    this.win = opts.winHelper !== undefined ? opts.winHelper : (this.platform === 'win32' ? new WinGpuHelper() : null);
    this._static = null;
    this._staticPromise = null;
    this._prevCpu = null;
    /** @type {null | (() => Promise<{ total: number, used: number, free: number, unifiedSize?: number } | null>)} */
    this.runtimeVram = null;
    this.runtimeGpu = null;
  }

  /** The runtime's own VRAM reader (node-llama-cpp `llama.getVramState`) and the GPU it uses. */
  setRuntime(getVram, gpu = null) {
    this.runtimeVram = typeof getVram === 'function' ? getVram : null;
    this.runtimeGpu = gpu;
  }

  staticInfo() {
    if (this._static) return Promise.resolve(this._static);
    this._staticPromise ||= this._readStatic().then((s) => (this._static = s));
    return this._staticPromise;
  }

  async _readStatic() {
    const cpus = this.cpus();
    const cpu = { model: cpus[0]?.model?.trim() || null, threads: cpus.length || null, cores: null, avx2: null, sources: { model: 'os', threads: 'os', cores: null, avx2: null } };
    let nvidiaHeader = null;
    let win = null;
    const smi = await this.exec('nvidia-smi', NVIDIA_QUERY, 5000);
    const nvidia = parseNvidiaCsv(smi);
    if (nvidia.length) nvidiaHeader = await this.exec('nvidia-smi', [], 5000);
    if (this.platform === 'win32') {
      win = this.win ? await this.win.request('static', 30000) : null;
      if (win?.cpu) {
        if (win.cpu.cores > 0) { cpu.cores = win.cpu.cores; cpu.sources.cores = 'cim'; }
        if (!cpu.model && win.cpu.name) cpu.model = win.cpu.name;
      }
      if (typeof win?.avx2 === 'boolean') { cpu.avx2 = win.avx2; cpu.sources.avx2 = 'IsProcessorFeaturePresent'; }
    } else if (this.platform === 'linux') {
      const info = parseLinuxCpuinfo(this.read('/proc/cpuinfo'));
      if (info.cores) { cpu.cores = info.cores; cpu.sources.cores = '/proc/cpuinfo'; }
      if (info.avx2 != null) { cpu.avx2 = info.avx2; cpu.sources.avx2 = '/proc/cpuinfo'; }
    } else if (this.platform === 'darwin') {
      const cores = numOrNull(await this.exec('sysctl', ['-n', 'hw.physicalcpu'], 2000));
      if (cores) { cpu.cores = cores; cpu.sources.cores = 'sysctl'; }
      if (this.arch === 'arm64') { cpu.avx2 = false; cpu.sources.avx2 = 'arm64 (no x86 vector extensions)'; } else {
        const leaf7 = await this.exec('sysctl', ['-n', 'machdep.cpu.leaf7_features'], 2000);
        if (leaf7 != null) { cpu.avx2 = /\bAVX2\b/.test(leaf7); cpu.sources.avx2 = 'sysctl'; }
      }
    }
    return { cpu, nvidia: nvidia.length > 0, cuda: parseCudaVersion(nvidiaHeader), win };
  }

  /**
   * One live reading. Shape: the `Resource` of PLAN section 2 without machineId, peerId, models, share and busy
   * (the caller adds those), plus `sources` for the Machines panel tooltips.
   */
  async sample() {
    const st = await this.staticInfo();
    const cur = cpuTimes(this.cpus());
    const loadPct = cpuLoadPct(this._prevCpu, cur);
    this._prevCpu = cur;
    const gpus = [];
    if (st.nvidia) {
      const rows = parseNvidiaCsv(await this.exec('nvidia-smi', NVIDIA_QUERY, 5000));
      for (const r of rows) {
        gpus.push({ ...r, vendor: 'nvidia', cuda: st.cuda || undefined, backend: st.cuda ? 'cuda' : undefined, source: 'nvidia-smi' });
      }
    }
    if (this.platform === 'win32' && st.win) {
      const sm = this.win ? await this.win.request('sample', 15000) : null;
      gpus.push(...windowsGpus(st.win, sm, { skipNvidia: st.nvidia }));
    } else if (this.platform === 'linux') {
      gpus.push(...linuxDrmGpus({ readdir: this.readdir, read: this.read, skipNvidia: st.nvidia }));
    } else if (this.platform === 'darwin' && this.arch === 'arm64') {
      // Unified memory: the GPU can use most of RAM; what is free for it is what the OS reports free.
      gpus.push({ name: `${(st.cpu.model || 'Apple Silicon').replace(/\s+CPU$/i, '')} GPU`, vendor: 'apple', vramTotalBytes: this.totalmem(), vramUsedBytes: null, vramFreeBytes: this.freemem(), utilPct: null, backend: 'metal', unified: true, source: 'unified-estimate' });
    }
    gpus.forEach((g, i) => { g.index = i; });
    if (this.runtimeVram) {
      try {
        const v = await this.runtimeVram();
        const g = this.runtimeGpu != null ? gpus[this.runtimeGpu] : gpus.find((x) => x.vramFreeBytes == null) || null;
        if (v && g && g.vramFreeBytes == null && finite(v.free)) {
          g.vramFreeBytes = v.free;
          g.vramUsedBytes = finite(v.used) ? v.used : g.vramUsedBytes;
          if (g.vramTotalBytes == null && finite(v.total)) g.vramTotalBytes = v.total;
          g.source = 'runtime';
        }
      } catch { /* the runtime went away */ }
    }
    return {
      sampledAt: this.now(),
      cpu: { model: st.cpu.model || 'unknown', cores: st.cpu.cores, threads: st.cpu.threads, avx2: st.cpu.avx2, loadPct },
      ram: { totalBytes: this.totalmem(), freeBytes: this.freemem() },
      gpus,
      sources: { cpu: { ...st.cpu.sources, loadPct: 'os.cpus deltas' }, ram: 'os' }
    };
  }

  close() {
    try { this.win?.close?.(); } catch { /* gone */ }
  }
}

/**
 * Decides whether a new sample is worth a logged `resources.changed` event (PLAN section 1.3): free VRAM
 * of a GPU moved by 10 percent of its total, free RAM by 10 percent, or the set of GPUs changed.
 */
export function significantChange(prev, next) {
  if (!prev) return true;
  if (prev.gpus.length !== next.gpus.length) return true;
  for (let i = 0; i < next.gpus.length; i++) {
    const a = prev.gpus[i];
    const b = next.gpus[i];
    if (a.name !== b.name) return true;
    if ((a.vramFreeBytes == null) !== (b.vramFreeBytes == null)) return true;
    if (b.vramTotalBytes && a.vramFreeBytes != null && b.vramFreeBytes != null && Math.abs(a.vramFreeBytes - b.vramFreeBytes) >= 0.1 * b.vramTotalBytes) return true;
  }
  return Math.abs(prev.ram.freeBytes - next.ram.freeBytes) >= 0.1 * next.ram.totalBytes;
}

