// Model catalog (official Qwen GGUF repositories), the choice by hardware, and a resumable verified download.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { diskFree, formatBytes } from './hardware.js';

const HF = 'https://huggingface.co';

/** Smallest first. Sizes and SHA-256 come from the Hugging Face file listing. */
export const MODELS = [
  {
    id: 'qwen2.5-coder-0.5b', short: '0.5b',
    name: 'Qwen2.5-Coder 0.5B Instruct (Q4_K_M)',
    repo: 'Qwen/Qwen2.5-Coder-0.5B-Instruct-GGUF',
    file: 'qwen2.5-coder-0.5b-instruct-q4_k_m.gguf',
    bytes: 491400064,
    sha256: '1d9614638d18024d0fbb36575a15f1302a3adf044df10345688ec4f6e1c4ff32'
  },
  {
    id: 'qwen2.5-coder-1.5b', short: '1.5b',
    name: 'Qwen2.5-Coder 1.5B Instruct (Q4_K_M)',
    repo: 'Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF',
    file: 'qwen2.5-coder-1.5b-instruct-q4_k_m.gguf',
    bytes: 1117320768,
    sha256: 'cc324af070c2ecbfd324a30884d2f951a7ff756aba85cb811a6ec436933bb046'
  },
  {
    id: 'qwen2.5-coder-3b', short: '3b',
    name: 'Qwen2.5-Coder 3B Instruct (Q4_K_M)',
    repo: 'Qwen/Qwen2.5-Coder-3B-Instruct-GGUF',
    file: 'qwen2.5-coder-3b-instruct-q4_k_m.gguf',
    bytes: 2104932800,
    sha256: '724fb256bec1ff062b2f65e4569e871ad2e95ab2a3989723d1769c54294730b7'
  },
  {
    id: 'qwen2.5-coder-7b', short: '7b',
    name: 'Qwen2.5-Coder 7B Instruct (Q4_K_M)',
    repo: 'Qwen/Qwen2.5-Coder-7B-Instruct-GGUF',
    file: 'qwen2.5-coder-7b-instruct-q4_k_m.gguf',
    bytes: 4683073536,
    sha256: '509287f78cb4d4cf6b3843734733b914b2c158e43e22a7f4bf5e963800894d3c'
  },
  {
    id: 'qwen2.5-coder-14b', short: '14b',
    name: 'Qwen2.5-Coder 14B Instruct (Q4_K_M)',
    repo: 'Qwen/Qwen2.5-Coder-14B-Instruct-GGUF',
    file: 'qwen2.5-coder-14b-instruct-q4_k_m.gguf',
    bytes: 8988110272,
    sha256: 'c1e659736d89ac1065fb495330fb824d94001974a4bfa78e7270e43476a8d940'
  }
].map((m) => ({ ...m, url: `${HF}/${m.repo}/resolve/main/${m.file}`, source: `${HF}/${m.repo}` }));

/** By id ("qwen2.5-coder-3b"), short name ("3b", "3B") or display name. */
export function modelById(id) {
  const key = String(id || '').toLowerCase();
  return MODELS.find((m) => m.id === key || m.short === key || m.name.toLowerCase() === key) || null;
}

const GB = 1e9;

function gb(n) {
  return `${(n / GB).toFixed(1)} GB`;
}

/**
 * The table from FIRST-RUN.md (all Qwen2.5-Coder Instruct, Q4_K_M):
 *   GPU with 10 GB of VRAM or more: 14B.  GPU with 7 to 10 GB: 7B.  GPU with 4 to 7 GB: 3B fully on the GPU.
 *   No usable GPU and 16 GB of RAM or more: 3B on the CPU.  8 to 16 GB of RAM: 1.5B on the CPU.
 *   Under 8 GB of RAM: 0.5B, with a warning.
 * Cards report a little less than their label (a "6 GB" card is about 6.4e9 bytes, an "8 GB" one about 8.6e9),
 * so the limits sit just under the round numbers.
 * @param {{ gpu: null | { name?: string, vramBytes: number }, ramBytes: number }} hw
 * @param {{ gpu?: boolean }} [opts] gpu:false chooses for the CPU
 * @returns {{ model: typeof MODELS[number], gpu: boolean, reason: string, warning?: string }}
 */
export function chooseModel(hw, opts = {}) {
  const vram = opts.gpu !== false && hw.gpu ? hw.gpu.vramBytes || 0 : 0;
  const ram = hw.ramBytes || 0;
  const gpuName = hw.gpu?.name ? `${hw.gpu.name} (${gb(vram)} VRAM)` : `GPU with ${gb(vram)} VRAM`;
  const pick = (id, gpu, why, warning) => {
    const model = modelById(id);
    const where = gpu ? 'fully on the GPU' : 'on the CPU';
    return { model, gpu, reason: `${why}: using ${model.name.replace(' Instruct (Q4_K_M)', '')} (${gb(model.bytes)}), ${where}.`, ...(warning ? { warning } : {}) };
  };
  if (vram >= 9.5 * GB) return pick('qwen2.5-coder-14b', true, `${gpuName} found`);
  if (vram >= 6.9 * GB) return pick('qwen2.5-coder-7b', true, `${gpuName} found`);
  if (vram >= 3.8 * GB) return pick('qwen2.5-coder-3b', true, `${gpuName} found`);
  const noGpu = hw.gpu && opts.gpu !== false ? `${gpuName} is too small to help` : 'No usable GPU';
  if (ram >= 15.5 * GB) return pick('qwen2.5-coder-3b', false, `${noGpu}, ${gb(ram)} RAM`);
  if (ram >= 7.5 * GB) return pick('qwen2.5-coder-1.5b', false, `${noGpu}, ${gb(ram)} RAM`);
  return pick('qwen2.5-coder-0.5b', false, `${noGpu}, only ${gb(ram)} RAM`,
    'Results with the 0.5B model will be basic. For better work, use Ollama, LM Studio or an endpoint with a key (--brain).');
}

/** The model from the table above. */
export function pickModel(hw, opts = {}) {
  return chooseModel(hw, opts).model;
}

/** The next smaller model, or null. */
export function smallerModel(model) {
  const i = MODELS.findIndex((m) => m.id === model.id);
  return i > 0 ? MODELS[i - 1] : null;
}

export function modelsDir(home) {
  return path.join(home, 'models');
}

export function modelPath(home, model) {
  return path.join(modelsDir(home), model.file);
}

/** GGUF files present in the cache folder (and any extra folders). */
export function listModelFiles(dirs) {
  const out = [];
  for (const dir of dirs) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!/\.gguf$/i.test(name)) continue;
      const p = path.join(dir, name);
      try { out.push({ file: name, path: p, bytes: fs.statSync(p).size }); } catch { /* gone */ }
    }
  }
  return out;
}

/** True when the cached file has the expected size (the checksum was verified when it was downloaded). */
export function isCached(home, model) {
  try { return fs.statSync(modelPath(home, model)).size === model.bytes; } catch { return false; }
}

export class DownloadError extends Error {
  /** @param {'no_disk'|'no_network'|'http'|'aborted'|'io'|'checksum'} code */
  constructor(code, message, hint) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

function networkCode(err) {
  const c = err?.cause?.code || err?.code || '';
  return /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|UND_ERR/.test(c) || err?.name === 'TypeError';
}

async function hashFile(file, hash) {
  await new Promise((resolve, reject) => {
    fs.createReadStream(file).on('data', (c) => hash.update(c)).on('end', resolve).on('error', reject);
  });
}

/**
 * Downloads a model into the cache with resume (`.part`) and SHA-256 verification.
 * @param {typeof MODELS[number]} model
 * @param {{ home: string, onProgress?: (p: { received: number, total: number, bps: number }) => void, signal?: AbortSignal, fetchImpl?: typeof fetch, freeBytes?: number | null }} opts
 * @returns {Promise<string>} final path
 */
export async function downloadModel(model, opts) {
  const f = opts.fetchImpl || fetch;
  const dir = modelsDir(opts.home);
  fs.mkdirSync(dir, { recursive: true });
  const final = modelPath(opts.home, model);
  const part = final + '.part';
  let have = 0;
  try { have = fs.statSync(part).size; } catch { /* fresh */ }
  if (have > model.bytes) { fs.rmSync(part, { force: true }); have = 0; }
  const free = opts.freeBytes !== undefined ? opts.freeBytes : diskFree(dir);
  const need = model.bytes - have + 100e6;
  if (free != null && free < need) {
    throw new DownloadError('no_disk', `Not enough disk space for ${model.name}: needs ${formatBytes(need)}, ${formatBytes(free)} free in ${dir}.`,
      'Free some space, use a smaller model, point --model at a GGUF file you already have, or run Ollama or LM Studio.');
  }
  const hash = crypto.createHash('sha256');
  if (have > 0) await hashFile(part, hash);
  let res;
  try {
    res = await f(model.url, { headers: have ? { range: `bytes=${have}-` } : {}, redirect: 'follow', signal: opts.signal });
  } catch (err) {
    if (opts.signal?.aborted) throw new DownloadError('aborted', 'The download was stopped.', 'Press Retry to continue where it stopped.');
    if (networkCode(err)) {
      throw new DownloadError('no_network', `Could not reach huggingface.co to download ${model.name}.`,
        'Check the connection and press Retry, or use --model <file.gguf>, or --demo to look around.');
    }
    throw new DownloadError('io', String(err.message || err), 'Press Retry.');
  }
  if (have && res.status === 200) {
    // The server ignored the range: start over.
    fs.rmSync(part, { force: true });
    have = 0;
    hash.destroy?.();
    return downloadModel(model, opts);
  }
  if (!res.ok && res.status !== 206) throw new DownloadError('http', `The download failed with HTTP ${res.status}.`, 'Press Retry later, or use --model <file.gguf>.');
  const out = fs.createWriteStream(part, { flags: have ? 'a' : 'w' });
  let received = have;
  let lastTick = 0;
  let lastBytes = received;
  let lastTime = Date.now();
  let bps = 0;
  try {
    for await (const chunk of res.body) {
      hash.update(chunk);
      received += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      const now = Date.now();
      if (now - lastTick > 250) {
        const dt = (now - lastTime) / 1000;
        if (dt > 0.5) { bps = (received - lastBytes) / dt; lastBytes = received; lastTime = now; }
        lastTick = now;
        opts.onProgress?.({ received, total: model.bytes, bps });
      }
    }
  } catch (err) {
    out.end();
    if (opts.signal?.aborted) throw new DownloadError('aborted', 'The download was stopped.', 'Press Retry to continue where it stopped.');
    if (err?.code === 'ENOSPC') throw new DownloadError('no_disk', 'The disk is full.', 'Free some space and press Retry; the download continues where it stopped.');
    throw new DownloadError('no_network', `The connection dropped at ${formatBytes(received)} of ${formatBytes(model.bytes)}.`, 'Press Retry; the download continues where it stopped.');
  }
  await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
  opts.onProgress?.({ received, total: model.bytes, bps });
  const digest = hash.digest('hex');
  if (model.sha256 && digest !== model.sha256) {
    fs.rmSync(part, { force: true });
    throw new DownloadError('checksum', `The downloaded file for ${model.name} is corrupt (checksum mismatch).`, 'It was deleted; press Retry to download it again.');
  }
  fs.renameSync(part, final);
  return final;
}
