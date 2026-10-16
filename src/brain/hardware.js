// Hardware detection without native dependencies: RAM and CPU from node:os, NVIDIA through nvidia-smi,
// Apple Silicon through unified memory, free disk through fs.statfs.
import os from 'node:os';
import fs from 'node:fs';
import { execFile } from 'node:child_process';

function exec(cmd, args, ms = 4000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: ms, windowsHide: true }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

export async function detectNvidia() {
  const out = await exec('nvidia-smi', ['--query-gpu=name,memory.total,memory.free', '--format=csv,noheader,nounits']);
  if (!out) return null;
  const rows = out.trim().split('\n').map((l) => l.split(',').map((s) => s.trim())).filter((r) => r.length >= 3);
  if (!rows.length) return null;
  // Use the GPU with the most VRAM.
  const best = rows.map(([name, total, free]) => ({ name, vramBytes: Number(total) * 1024 * 1024, freeVramBytes: Number(free) * 1024 * 1024, backend: 'cuda' }))
    .sort((a, b) => b.vramBytes - a.vramBytes)[0];
  return Number.isFinite(best.vramBytes) ? best : null;
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
 * @param {{ dir?: string }} [opts]
 * @returns {Promise<{ os: string, arch: string, cpus: number, cpuModel: string, ramBytes: number, freeRamBytes: number, gpu: null | { name: string, vramBytes: number, freeVramBytes?: number, backend: string, unified?: boolean }, diskFreeBytes: number | null, node: string }>}
 */
export async function detectHardware(opts = {}) {
  const cpus = os.cpus();
  let gpu = await detectNvidia();
  if (!gpu && process.platform === 'darwin' && process.arch === 'arm64') {
    // Apple Silicon: the GPU uses unified memory; about two thirds can hold a model.
    gpu = { name: 'Apple Silicon GPU', vramBytes: Math.floor(os.totalmem() * 0.66), backend: 'metal', unified: true };
  }
  return {
    os: process.platform,
    arch: process.arch,
    cpus: cpus.length,
    cpuModel: cpus[0]?.model?.trim() || 'unknown',
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
