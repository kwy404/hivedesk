// Hardware detection without native dependencies: RAM and CPU from node:os, NVIDIA through nvidia-smi
// (with the driver and CUDA version), AMD and Intel GPUs for Vulkan from the OS, Apple Silicon unified
// memory, CPU cores and AVX2 / AVX-512, the RAM speed where the OS reports it, free disk through fs.statfs.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

function exec(cmd, args, ms = 4000) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: ms, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout) => resolve(err ? null : String(stdout)));
    } catch {
      resolve(null);
    }
  });
}

export async function detectNvidia(execImpl = exec) {
  const out = await execImpl('nvidia-smi', ['--query-gpu=name,memory.total,memory.free,driver_version', '--format=csv,noheader,nounits']);
  if (!out) return null;
  const rows = out.trim().split('\n').map((l) => l.split(',').map((s) => s.trim())).filter((r) => r.length >= 3);
  if (!rows.length) return null;
  // Use the GPU with the most VRAM.
  const best = rows.map(([name, total, free, driver]) => ({ name, vramBytes: Number(total) * 1024 * 1024, freeVramBytes: Number(free) * 1024 * 1024, backend: 'cuda', ...(driver ? { driver } : {}) }))
    .sort((a, b) => b.vramBytes - a.vramBytes)[0];
  if (!Number.isFinite(best.vramBytes)) return null;
  const head = await execImpl('nvidia-smi', []);
  const cuda = /CUDA Version:\s*([\d.]+)/.exec(head || '');
  if (cuda) best.cuda = cuda[1];
  return best;
}

export function diskFree(dir) {
  try {
    if (typeof fs.statfsSync !== 'function') return null;
    const s = fs.statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

/**
 * AVX2 and AVX-512 from the CPU name when the OS does not say:
 * Intel Core from the 4th generation (Haswell) and every AMD Ryzen have AVX2; AVX-512 on Intel Core 11th
 * generation, Xeon Scalable and AMD Zen 4 or newer (Ryzen 7000 and later, EPYC 9004).
 */
export function inferCpuFeatures(name = '') {
  const n = String(name);
  let avx2 = false;
  let avx512 = false;
  const core = /Core(?:\(TM\))?\s*i[3579]-?\s*(\d{4,5})/i.exec(n);
  if (core) {
    const num = core[1];
    const gen = num.length === 5 ? Number(num.slice(0, 2)) : Number(num[0]);
    avx2 = gen >= 4;
    avx512 = gen === 11;
  }
  if (/Core(?:\(TM\))?\s*Ultra/i.test(n)) avx2 = true;
  if (/Xeon.*(Gold|Silver|Platinum|Bronze)|Xeon\s*w\d/i.test(n)) { avx2 = true; avx512 = true; }
  if (/Ryzen|EPYC|Threadripper/i.test(n)) avx2 = true;
  const ryzen = /Ryzen\s*(?:Threadripper\s*)?(?:PRO\s*)?\d\s+(\d)\d{3}/i.exec(n);
  if (ryzen && Number(ryzen[1]) >= 7) avx512 = true;
  if (/EPYC\s*9\d{3}/i.test(n)) avx512 = true;
  return { avx2, avx512 };
}

const WIN_PROBE = [
  "$ErrorActionPreference='SilentlyContinue'",
  "$k=Add-Type -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern bool IsProcessorFeaturePresent(uint f);' -Name K32 -Namespace HD -PassThru",
  '$p=Get-CimInstance Win32_Processor | Select-Object -First 1',
  '$m=@(Get-CimInstance Win32_PhysicalMemory | ForEach-Object { [int]$_.ConfiguredClockSpeed })',
  '$g=@()',
  "Get-ChildItem 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}' | ForEach-Object { $q=Get-ItemProperty $_.PSPath; if ($q.DriverDesc) { $g += @{ name=$q.DriverDesc; vram=[int64]$q.'HardwareInformation.qwMemorySize' } } }",
  '@{ cores=$p.NumberOfCores; threads=$p.NumberOfLogicalProcessors; avx2=$k::IsProcessorFeaturePresent(40); avx512=$k::IsProcessorFeaturePresent(41); ram=$m; gpus=$g } | ConvertTo-Json -Compress -Depth 4'
].join('; ');

/** Cores, AVX2 / AVX-512, RAM speed and the display adapters, from the OS. Null when it cannot tell. */
export async function probeOs(execImpl = exec, platform = process.platform, readFile = (f) => fs.readFileSync(f, 'utf8')) {
  if (platform === 'win32') {
    const out = await execImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WIN_PROBE], 20000);
    try {
      const j = JSON.parse(String(out || '').trim());
      const ram = (Array.isArray(j.ram) ? j.ram : [j.ram]).filter((x) => x > 0);
      return {
        cores: j.cores || null, threads: j.threads || null, avx2: !!j.avx2, avx512: !!j.avx512,
        ramMts: ram.length ? Math.min(...ram) : null, ramModules: ram.length || null,
        gpus: (Array.isArray(j.gpus) ? j.gpus : j.gpus ? [j.gpus] : []).map((g) => ({ name: String(g.name), vramBytes: Number(g.vram) || 0 }))
      };
    } catch {
      return null;
    }
  }
  if (platform === 'linux') {
    let info = '';
    try { info = readFile('/proc/cpuinfo'); } catch { return null; }
    const flags = /^flags\s*:\s*(.*)$/m.exec(info)?.[1].split(/\s+/) || [];
    const coresPer = Number(/^cpu cores\s*:\s*(\d+)/m.exec(info)?.[1]) || null;
    const sockets = new Set([...info.matchAll(/^physical id\s*:\s*(\d+)/gm)].map((m) => m[1])).size || 1;
    const gpus = [];
    try {
      for (const card of fs.readdirSync('/sys/class/drm').filter((c) => /^card\d+$/.test(c))) {
        const dev = path.join('/sys/class/drm', card, 'device');
        const vendor = readFile(path.join(dev, 'vendor')).trim();
        let vram = 0;
        try { vram = Number(readFile(path.join(dev, 'mem_info_vram_total')).trim()); } catch { /* not AMD */ }
        const name = vendor === '0x1002' ? 'AMD Radeon GPU' : vendor === '0x8086' ? 'Intel GPU' : null;
        if (name) gpus.push({ name, vramBytes: vram });
      }
    } catch { /* no drm */ }
    return { cores: coresPer ? coresPer * sockets : null, threads: os.cpus().length, avx2: flags.includes('avx2'), avx512: flags.includes('avx512f'), ramMts: null, ramModules: null, gpus };
  }
  if (platform === 'darwin') {
    const out = await execImpl('sysctl', ['-n', 'hw.physicalcpu', 'machdep.cpu.brand_string'], 3000);
    const lines = String(out || '').trim().split('\n');
    const x86 = process.arch === 'x64';
    const avx = x86 ? await execImpl('sysctl', ['-n', 'hw.optional.avx2_0', 'hw.optional.avx512f'], 3000) : null;
    const a = String(avx || '').trim().split('\n');
    return { cores: Number(lines[0]) || null, threads: os.cpus().length, avx2: a[0] === '1', avx512: a[1] === '1', chip: lines[1] || null, ramMts: null, ramModules: null, gpus: [] };
  }
  return null;
}

/** A GPU that is not NVIDIA but that the runtime can use through Vulkan (AMD Radeon, Intel Arc). */
export function vulkanGpu(gpus = []) {
  const usable = gpus.filter((g) => /radeon|amd|intel.*arc|\barc\b/i.test(g.name) && !/nvidia/i.test(g.name))
    .sort((a, b) => (b.vramBytes || 0) - (a.vramBytes || 0))[0];
  // Integrated graphics report little or no dedicated memory: not worth a model.
  if (!usable || (usable.vramBytes || 0) < 2e9) return null;
  return { name: usable.name, vramBytes: usable.vramBytes, backend: 'vulkan' };
}

function readCache(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * @param {{ dir?: string, home?: string, execImpl?: typeof exec, probe?: boolean }} [opts]
 *   home: where the OS probe result is cached (hardware.json), so later starts do not pay for it. Without
 *   home (or with probe: false) the slower OS probe is skipped and AVX2 / AVX-512 come from the CPU name.
 */
export async function detectHardware(opts = {}) {
  const cpus = os.cpus();
  const cpuModel = cpus[0]?.model?.trim() || 'unknown';
  const execImpl = opts.execImpl || exec;
  const cacheFile = opts.home ? path.join(opts.home, 'hardware.json') : null;
  const cacheKey = `${process.platform}|${os.release()}|${cpuModel}|${os.totalmem()}`;
  const cached = cacheFile ? readCache(cacheFile) : null;
  const probeP = opts.probe === false || (!cacheFile && opts.probe !== true) ? Promise.resolve(null)
    : cached?.key === cacheKey ? Promise.resolve(cached.probe)
    : probeOs(execImpl).then((p) => {
      if (p && cacheFile) { try { fs.mkdirSync(path.dirname(cacheFile), { recursive: true }); fs.writeFileSync(cacheFile, JSON.stringify({ key: cacheKey, probe: p })); } catch { /* read only */ } }
      return p;
    });
  const [nv, probe] = await Promise.all([detectNvidia(execImpl), probeP]);
  let gpu = nv;
  if (!gpu && process.platform === 'darwin' && process.arch === 'arm64') {
    // Apple Silicon: the GPU uses unified memory; macOS lets the GPU wire about two thirds (three quarters above 32 GB).
    const total = os.totalmem();
    gpu = { name: probe?.chip ? `${probe.chip} GPU` : 'Apple Silicon GPU', vramBytes: Math.floor(total * (total > 32e9 ? 0.75 : 0.66)), backend: 'metal', unified: true, chip: probe?.chip || null };
  }
  if (!gpu && probe?.gpus?.length) gpu = vulkanGpu(probe.gpus);
  const inferred = inferCpuFeatures(cpuModel);
  const cpu = {
    model: cpuModel,
    threads: cpus.length,
    cores: probe?.cores || null,
    avx2: probe ? !!probe.avx2 : inferred.avx2,
    avx512: probe ? !!probe.avx512 : inferred.avx512,
    featuresFrom: probe ? 'os' : 'name',
    ramMts: probe?.ramMts || null,
    ramModules: probe?.ramModules || null
  };
  return {
    os: process.platform,
    arch: process.arch,
    cpus: cpus.length,
    cpuModel,
    cpu,
    ramBytes: os.totalmem(),
    freeRamBytes: os.freemem(),
    gpu,
    diskFreeBytes: diskFree(opts.dir || os.homedir()),
    node: process.version
  };
}

export function formatBytes(n) {
  if (n == null || !Number.isFinite(n)) return 'unknown';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  // Decimal units, the same as the sizes Hugging Face shows.
  while (v >= 1000 && i < u.length - 1) { v /= 1000; i++; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}
