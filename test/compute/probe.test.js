import { describe, it, expect } from 'vitest';
import {
  parseNvidiaCsv, parseCudaVersion, cpuTimes, cpuLoadPct, parseLinuxCpuinfo, windowsVramTotal, windowsGpus,
  linuxDrmGpus, ResourceProbe, significantChange, NVIDIA_QUERY
} from '../../src/compute/probe.js';
import { encodeCommand, WIN_HELPER_SCRIPT, WinGpuHelper } from '../../src/compute/win-gpu.js';

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

// Real answers of the Windows helper on a PC with a GTX 1060 and an Intel HD 4600 (trimmed).
const WIN_STATIC = {
  type: 'static',
  cpu: { name: 'Intel(R) Core(TM) i5-4440 CPU @ 3.10GHz', cores: 4, threads: 4 },
  avx2: true,
  adapters: [
    { name: 'NVIDIA GeForce GTX 1060 6GB', vendorId: 4318, dedicated: 6321864704, shared: 8528857088, luid: '0x00000000_0x0000b173', flags: 0 },
    { name: 'Intel(R) HD Graphics 4600', vendorId: 32902, dedicated: 117964800, shared: 2147483648, luid: '0x00000000_0x0000e42d', flags: 0 },
    { name: 'Microsoft Basic Render Driver', vendorId: 5140, dedicated: 0, shared: 8528857088, luid: '0x00000000_0x0000e3f6', flags: 2 }
  ],
  controllers: [
    { name: 'Intel(R) HD Graphics 4600', adapterRam: 1073741824, driver: '20.19.15.4531', pnp: 'PCI\\VEN_8086&DEV_0412' },
    { name: 'NVIDIA GeForce GTX 1060 6GB', adapterRam: 4293918720, driver: '32.0.15.6094', pnp: 'PCI\\VEN_10DE&DEV_1B83' }
  ],
  registry: [{ name: 'NVIDIA GeForce GTX 1060 6GB', qwMemorySize: 6442450944 }, { name: 'Intel(R) HD Graphics 4600', qwMemorySize: null }]
};
const WIN_SAMPLE = {
  type: 'sample',
  util: { '0x00000000_0x0000b173': 1.4585, '0x00000000_0x0000e42d': 37.25 },
  dedicated: { '0x00000000_0x0000b173': 604413952, '0x00000000_0x0000e42d': 32768 },
  shared: {}
};

describe('NVIDIA through nvidia-smi', () => {
  it('parses the query and keeps unknown values unknown', () => {
    const rows = parseNvidiaCsv('0, NVIDIA GeForce GTX 1060 6GB, 6144, 568, 5576, 7, 560.94, 00000000:01:00.0\r\n1, Tesla T4, 15360, [N/A], [N/A], [Not Supported], 535.1, 00000000:02:00.0\n');
    expect(rows[0]).toEqual({ index: 0, name: 'NVIDIA GeForce GTX 1060 6GB', vramTotalBytes: 6144 * MiB, vramUsedBytes: 568 * MiB, vramFreeBytes: 5576 * MiB, utilPct: 7, driver: '560.94', pciBusId: '00000000:01:00.0' });
    expect(rows[1]).toMatchObject({ name: 'Tesla T4', vramUsedBytes: null, vramFreeBytes: null, utilPct: null });
    expect(parseNvidiaCsv(null)).toEqual([]);
    expect(parseNvidiaCsv('garbage')).toEqual([]);
  });

  it('reads the CUDA version from the header', () => {
    expect(parseCudaVersion('| NVIDIA-SMI 560.94   Driver Version: 560.94   CUDA Version: 12.6 |')).toBe('12.6');
    expect(parseCudaVersion('')).toBe(null);
  });
});

describe('CPU', () => {
  it('computes load from time deltas, and nothing before the first interval', () => {
    const a = cpuTimes([{ times: { user: 100, nice: 0, sys: 50, idle: 850, irq: 0 } }]);
    const b = cpuTimes([{ times: { user: 400, nice: 0, sys: 50, idle: 1550, irq: 0 } }]);
    expect(cpuLoadPct(null, a)).toBe(null);
    expect(cpuLoadPct(a, b)).toBe(30);
    expect(cpuLoadPct(b, b)).toBe(null);
  });

  it('reads cores and AVX2 from /proc/cpuinfo', () => {
    const text = ['processor : 0', 'physical id : 0', 'core id : 0', 'cpu cores : 2', 'flags : fpu sse avx avx2 fma', '', 'processor : 1', 'physical id : 0', 'core id : 1', '', 'processor : 2', 'physical id : 0', 'core id : 0', ''].join('\n');
    expect(parseLinuxCpuinfo(text)).toEqual({ cores: 2, avx2: true });
    expect(parseLinuxCpuinfo('flags : sse sse2')).toEqual({ cores: null, avx2: false });
    expect(parseLinuxCpuinfo(null)).toEqual({ cores: null, avx2: null });
  });
});

describe('Windows GPUs', () => {
  it('never trusts the 4 GB ceiling of AdapterRAM', () => {
    expect(windowsVramTotal({ name: 'X', adapterRam: 4293918720 }, [])).toBe(null);
    expect(windowsVramTotal({ name: 'X', adapterRam: 4293918720 }, [{ name: 'X', qwMemorySize: 8 * GiB }])).toBe(8 * GiB);
    expect(windowsVramTotal({ name: 'Y', adapterRam: 2 * GiB }, [])).toBe(2 * GiB);
  });

  it('maps DXGI adapters to the performance counters by LUID', () => {
    const gpus = windowsGpus(WIN_STATIC, WIN_SAMPLE, { skipNvidia: true });
    expect(gpus).toHaveLength(1);   // NVIDIA comes from nvidia-smi; the software adapter is skipped
    expect(gpus[0]).toMatchObject({ name: 'Intel(R) HD Graphics 4600', vendor: 'intel', vramTotalBytes: 117964800, vramUsedBytes: 32768, utilPct: 37.3, driver: '20.19.15.4531', integrated: true, source: 'wddm-counters' });
    const all = windowsGpus(WIN_STATIC, WIN_SAMPLE, { skipNvidia: false });
    expect(all[0]).toMatchObject({ vendor: 'nvidia', vramTotalBytes: 6321864704, vramFreeBytes: 6321864704 - 604413952, utilPct: 1.5 });
  });

  it('first sample has no utilization yet, and says so', () => {
    const gpus = windowsGpus(WIN_STATIC, { ...WIN_SAMPLE, util: null }, { skipNvidia: true });
    expect(gpus[0].utilPct).toBe(null);
  });

  it('falls back to CIM names and sizes without inventing live numbers', () => {
    const gpus = windowsGpus({ ...WIN_STATIC, adapters: null }, WIN_SAMPLE, { skipNvidia: false });
    expect(gpus.map((g) => g.name)).toEqual(['Intel(R) HD Graphics 4600', 'NVIDIA GeForce GTX 1060 6GB']);
    expect(gpus[1]).toMatchObject({ vendor: 'nvidia', vramTotalBytes: 6442450944, vramFreeBytes: null, utilPct: null, source: 'cim' });
  });

  it('the helper script travels as an encoded command and fails soft without PowerShell', async () => {
    expect(Buffer.from(encodeCommand(WIN_HELPER_SCRIPT), 'base64').toString('utf16le')).toBe(WIN_HELPER_SCRIPT);
    const h = new WinGpuHelper({ spawnImpl: () => { throw new Error('ENOENT'); } });
    expect(await h.request('static', 1000)).toBe(null);
    expect(h.failed).toMatch(/ENOENT/);
  });
});

describe('Linux GPUs', () => {
  it('reads AMD from sysfs and lists Intel without numbers', () => {
    const files = {
      '/sys/class/drm/card0/device/vendor': '0x1002\n', '/sys/class/drm/card0/device/device': '0x73bf\n',
      '/sys/class/drm/card0/device/mem_info_vram_total': String(16 * GiB), '/sys/class/drm/card0/device/mem_info_vram_used': String(2 * GiB),
      '/sys/class/drm/card0/device/gpu_busy_percent': '42',
      '/sys/class/drm/card1/device/vendor': '0x8086', '/sys/class/drm/card1/device/device': '0x9a49'
    };
    const gpus = linuxDrmGpus({ readdir: () => ['card0', 'card0-DP-1', 'card1', 'renderD128'], read: (f) => files[f] ?? null });
    expect(gpus[0]).toEqual({ name: 'AMD GPU 1002:73bf', vendor: 'amd', vramTotalBytes: 16 * GiB, vramUsedBytes: 2 * GiB, vramFreeBytes: 14 * GiB, utilPct: 42, integrated: false, source: 'sysfs' });
    expect(gpus[1]).toMatchObject({ vendor: 'intel', vramTotalBytes: null, utilPct: null });
  });
});

describe('ResourceProbe', () => {
  const cpus = (idle, user = 100) => [{ model: 'Test CPU', times: { user, nice: 0, sys: 0, idle, irq: 0 } }, { model: 'Test CPU', times: { user, nice: 0, sys: 0, idle, irq: 0 } }];

  it('on Windows: nvidia-smi for NVIDIA, the helper for the rest, CPU cores and AVX2 from the OS', async () => {
    let idle = 100;
    const calls = [];
    const probe = new ResourceProbe({
      platform: 'win32',
      exec: async (cmd, args) => { calls.push([cmd, args[0]]); if (args.length === 0) return 'CUDA Version: 12.6'; return '0, NVIDIA GeForce GTX 1060 6GB, 6144, 568, 5576, 3, 560.94, 0:1:0'; },
      winHelper: { request: async (cmd) => (cmd === 'static' ? WIN_STATIC : WIN_SAMPLE) },
      cpus: () => { idle += 100; return cpus(idle, idle); }, totalmem: () => 16 * GiB, freemem: () => 9 * GiB, now: () => 42
    });
    const a = await probe.sample();
    expect(a.cpu).toEqual({ model: 'Test CPU', cores: 4, threads: 2, avx2: true, loadPct: null });
    expect(a.gpus.map((g) => [g.index, g.vendor, g.source])).toEqual([[0, 'nvidia', 'nvidia-smi'], [1, 'intel', 'wddm-counters']]);
    expect(a.gpus[0]).toMatchObject({ cuda: '12.6', backend: 'cuda', vramFreeBytes: 5576 * MiB });
    expect(a.ram).toEqual({ totalBytes: 16 * GiB, freeBytes: 9 * GiB });
    expect(a.sources.cpu.avx2).toBe('IsProcessorFeaturePresent');
    const b = await probe.sample();
    expect(b.cpu.loadPct).toBe(50);
    expect(calls.filter(([, a0]) => a0 === NVIDIA_QUERY[0])).toHaveLength(3);   // static once, then each sample
  });

  it('with no GPU at all reports none, not a guess', async () => {
    const probe = new ResourceProbe({ platform: 'linux', exec: async () => null, read: () => null, readdir: () => [], cpus: () => cpus(1), winHelper: null });
    const s = await probe.sample();
    expect(s.gpus).toEqual([]);
    expect(s.cpu.avx2).toBe(null);
    expect(s.cpu.cores).toBe(null);
  });

  it('Apple Silicon: unified memory, utilization not measured', async () => {
    const probe = new ResourceProbe({ platform: 'darwin', arch: 'arm64', exec: async (cmd, args) => (cmd === 'sysctl' && args[1] === 'hw.physicalcpu' ? '8\n' : null), cpus: () => [{ model: 'Apple M2', times: { user: 1, nice: 0, sys: 0, idle: 1, irq: 0 } }], totalmem: () => 16 * GiB, freemem: () => 6 * GiB, winHelper: null });
    const s = await probe.sample();
    expect(s.cpu).toMatchObject({ cores: 8, avx2: false });
    expect(s.gpus).toEqual([{ index: 0, name: 'Apple M2 GPU', vendor: 'apple', vramTotalBytes: 16 * GiB, vramUsedBytes: null, vramFreeBytes: 6 * GiB, utilPct: null, backend: 'metal', unified: true, source: 'unified-estimate' }]);
  });

  it('the runtime fills free VRAM only where nothing else measured it', async () => {
    const probe = new ResourceProbe({ platform: 'win32', exec: async () => null, winHelper: { request: async (cmd) => (cmd === 'static' ? { ...WIN_STATIC, adapters: null } : null) }, cpus: () => cpus(1) });
    probe.setRuntime(async () => ({ total: 6 * GiB, used: 2 * GiB, free: 4 * GiB }), 1);
    const s = await probe.sample();
    expect(s.gpus[1]).toMatchObject({ name: 'NVIDIA GeForce GTX 1060 6GB', vramFreeBytes: 4 * GiB, source: 'runtime' });
    expect(s.gpus[0].vramFreeBytes).toBe(null);
  });

  it('logs a change only when it matters', () => {
    const base = { ram: { totalBytes: 16 * GiB, freeBytes: 8 * GiB }, gpus: [{ name: 'A', vramTotalBytes: 10 * GiB, vramFreeBytes: 5 * GiB }] };
    expect(significantChange(null, base)).toBe(true);
    expect(significantChange(base, { ...base, gpus: [{ name: 'A', vramTotalBytes: 10 * GiB, vramFreeBytes: 4.5 * GiB }] })).toBe(false);
    expect(significantChange(base, { ...base, gpus: [{ name: 'A', vramTotalBytes: 10 * GiB, vramFreeBytes: 3.9 * GiB }] })).toBe(true);
    expect(significantChange(base, { ...base, ram: { totalBytes: 16 * GiB, freeBytes: 6 * GiB } })).toBe(true);
    expect(significantChange(base, { ...base, gpus: [] })).toBe(true);
  });
});
