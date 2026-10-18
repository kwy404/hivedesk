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
/** The largest single file a model download may have (the biggest catalog part is about 50 GB). */
export const MAX_PART_BYTES = 128 * 1024 ** 3;

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

/** The files of a model: one, or the parts of a split GGUF (catalog picks). */
export function modelParts(model) {
  if (Array.isArray(model.files) && model.files.length) return model.files.map((f) => ({ file: f.file || f.path.split('/').pop(), bytes: f.bytes, sha256: f.sha256, url: f.url }));
  return [{ file: model.file, bytes: model.bytes, sha256: model.sha256, url: model.url }];
}

/** The path to load: the file, or the first part of a split file (llama.cpp finds the others next to it). */
export function modelPath(home, model) {
  return path.join(modelsDir(home), modelParts(model)[0].file);
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

/** True when every file is cached with the expected size (the checksum was verified when it was downloaded). */
export function isCached(home, model) {
  try { return modelParts(model).every((p) => fs.statSync(path.join(modelsDir(home), p.file)).size === p.bytes); } catch { return false; }
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
 * Downloads a model into the cache with resume (`.part`) and SHA-256 verification of every file.
 * A split model (catalog picks of the biggest files) downloads its parts one after the other.
 * @param {{ name: string, bytes: number, file?: string, url?: string, sha256?: string | null, files?: { file?: string, path?: string, bytes: number, sha256: string, url: string }[] }} model
 * @param {{ home: string, dir?: string, onProgress?: (p: { received: number, total: number, bps: number, part?: number, parts?: number }) => void, signal?: AbortSignal, fetchImpl?: typeof fetch, freeBytes?: number | null }} opts
 * @returns {Promise<string>} the path to load (the first part)
 */
export async function downloadModel(model, opts) {
  const dir = opts.dir || modelsDir(opts.home);
  const parts = modelParts(model);
  // Every part needs its SHA-256 and a real size under the cap: nothing unverified or unbounded is downloaded.
  for (const p of parts) {
    if (typeof p.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(p.sha256)) throw new DownloadError('checksum', `${model.name} has a part without a SHA-256, so it is not downloaded.`, 'Pick a model from the catalog, or point --model at a GGUF file you already have.');
    if (!Number.isSafeInteger(p.bytes) || p.bytes <= 0 || p.bytes > MAX_PART_BYTES) throw new DownloadError('too_big', `${model.name} has a part with no size or one over ${formatBytes(MAX_PART_BYTES)}.`, 'Pick a model from the catalog, or point --model at a GGUF file you already have.');
    if (typeof p.file !== 'string' || !p.file || p.file !== path.basename(p.file) || p.file.startsWith('.')) throw new DownloadError('io', `${model.name} has a part with a bad file name.`, 'Pick a model from the catalog.');
  }
  fs.mkdirSync(dir, { recursive: true });
  const total = parts.reduce((n, p) => n + p.bytes, 0);
  const sizeOf = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };
  // Disk: what is still missing, plus room.
  let missing = 0;
  for (const p of parts) {
    const final = path.join(dir, p.file);
    if (sizeOf(final) === p.bytes) continue;
    const have = Math.min(sizeOf(final + '.part'), p.bytes);
    missing += p.bytes - have;
  }
  const free = opts.freeBytes !== undefined ? opts.freeBytes : diskFree(dir);
  const need = missing + 100e6;
  if (missing > 0 && free != null && free < need) {
    throw new DownloadError('no_disk', `Not enough disk space for ${model.name}: needs ${formatBytes(need)}, ${formatBytes(free)} free in ${dir}.`,
      'Free some space, use a smaller model, point --model at a GGUF file you already have, or run Ollama or LM Studio.');
  }
  let done = 0;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const final = path.join(dir, p.file);
    if (sizeOf(final) !== p.bytes) {
      await downloadFile(p, final, { ...opts, name: model.name, offset: done, total, index: i, count: parts.length });
    }
    done += p.bytes;
  }
  return path.join(dir, parts[0].file);
}

async function downloadFile(p, final, opts) {
  const f = opts.fetchImpl || fetch;
  const part = final + '.part';
  let have = 0;
  try { have = fs.statSync(part).size; } catch { /* fresh */ }
  if (have > p.bytes) { fs.rmSync(part, { force: true }); have = 0; }
  const hash = crypto.createHash('sha256');
  if (have > 0) await hashFile(part, hash);
  const report = (received, bps) => opts.onProgress?.({ received: opts.offset + received, total: opts.total, bps, ...(opts.count > 1 ? { part: opts.index + 1, parts: opts.count } : {}) });
  let res;
  try {
    res = await f(p.url, { headers: have ? { range: `bytes=${have}-` } : {}, redirect: 'follow', signal: opts.signal });
  } catch (err) {
    if (opts.signal?.aborted) throw new DownloadError('aborted', 'The download was stopped.', 'Press Retry to continue where it stopped.');
    if (networkCode(err)) {
      throw new DownloadError('no_network', `Could not reach huggingface.co to download ${opts.name}.`,
        'Check the connection and press Retry, or use --model <file.gguf>, or --demo to look around.');
    }
    throw new DownloadError('io', String(err.message || err), 'Press Retry.');
  }
  if (have && res.status === 200) {
    // The server ignored the range: start over.
    fs.rmSync(part, { force: true });
    hash.destroy?.();
    return downloadFile(p, final, opts);
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
      // Never more than the size the catalog names: a server sending more is cut off and the part is dropped.
      if (received > p.bytes) { out.destroy(); fs.rmSync(part, { force: true }); throw Object.assign(new Error('too big'), { tooBig: true }); }
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      const now = Date.now();
      if (now - lastTick > 250) {
        const dt = (now - lastTime) / 1000;
        if (dt > 0.5) { bps = (received - lastBytes) / dt; lastBytes = received; lastTime = now; }
        lastTick = now;
        report(received, bps);
      }
    }
  } catch (err) {
    out.end();
    if (err?.tooBig) { fs.rmSync(part, { force: true }); throw new DownloadError('checksum', `The server sent more than the ${formatBytes(p.bytes)} of ${opts.name}.`, 'It was deleted; press Retry to download it again.'); }
    if (opts.signal?.aborted) throw new DownloadError('aborted', 'The download was stopped.', 'Press Retry to continue where it stopped.');
    if (err?.code === 'ENOSPC') throw new DownloadError('no_disk', 'The disk is full.', 'Free some space and press Retry; the download continues where it stopped.');
    throw new DownloadError('no_network', `The connection dropped at ${formatBytes(opts.offset + received)} of ${formatBytes(opts.total)}.`, 'Press Retry; the download continues where it stopped.');
  }
  await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
  report(received, bps);
  if (p.bytes && received < p.bytes) {
    // The body ended early without an error: keep the part, the next try resumes.
    throw new DownloadError('no_network', `The connection dropped at ${formatBytes(opts.offset + received)} of ${formatBytes(opts.total)}.`, 'Press Retry; the download continues where it stopped.');
  }
  const digest = hash.digest('hex');
  if (digest !== String(p.sha256).toLowerCase()) {
    fs.rmSync(part, { force: true });
    throw new DownloadError('checksum', `The downloaded file for ${opts.name} is corrupt (checksum mismatch).`, 'It was deleted; press Retry to download it again.');
  }
  fs.renameSync(part, final);
  return final;
}
