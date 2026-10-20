// Model catalog (official Qwen GGUF repositories), the choice by hardware, and a resumable verified download.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { once } from 'node:events';
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
  /** @param {'no_disk'|'no_network'|'not_found'|'forbidden'|'rate_limited'|'server'|'http'|'aborted'|'io'|'locked'|'checksum'|'too_big'} code */
  constructor(code, message, hint, extra) {
    super(message);
    this.code = code;
    this.hint = hint;
    if (extra) Object.assign(this, extra);
  }
}

function networkCode(err) {
  const c = err?.cause?.code || err?.code || '';
  return /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|UND_ERR/.test(c) || err?.name === 'TypeError';
}

/** A file in use by another program (an antivirus scan, a second window): Windows says EBUSY or EPERM. */
const LOCKED = /^(EBUSY|EPERM|EACCES|EISDIR|ETXTBSY)$/;

async function hashFile(file, hash) {
  await new Promise((resolve, reject) => {
    fs.createReadStream(file).on('data', (c) => hash.update(c)).on('end', resolve).on('error', reject);
  });
}

const hostOf = (url) => { try { return new URL(url).host; } catch { return 'the download server'; } };
const sleep = (ms, signal) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

/** Downloads in progress, by target file: a second download of the same model waits for the first. */
const inflight = new Map();

/**
 * Downloads a model into the cache with resume (`.part`) and SHA-256 verification of every file.
 * A split model (catalog picks of the biggest files) downloads its parts one after the other.
 * @param {{ name: string, bytes: number, file?: string, url?: string, sha256?: string | null, files?: { file?: string, path?: string, bytes: number, sha256: string, url: string }[] }} model
 * @param {{ home: string, dir?: string, onProgress?: (p: { received: number, total: number, bps: number, part?: number, parts?: number }) => void, signal?: AbortSignal, fetchImpl?: typeof fetch, freeBytes?: number | null, retryDelayMs?: number }} opts
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
  const key = path.resolve(dir, parts[0].file).toLowerCase();
  while (inflight.has(key)) { try { await inflight.get(key); } catch { /* this one tries for itself */ } }
  const job = downloadParts(model, parts, dir, opts);
  inflight.set(key, job);
  try { return await job; } finally { inflight.delete(key); }
}

async function downloadParts(model, parts, dir, opts) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (err) {
    throw new DownloadError(LOCKED.test(err.code) ? 'locked' : 'io', `Could not create the folder ${dir} (${err.code || err.message}).`, 'Check that the folder can be written, then press Retry.');
  }
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
      'Free some space, use a smaller model, point --model at a GGUF file you already have, or run Ollama or LM Studio.', { need, free });
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

/** Retry-After in seconds (a number or an HTTP date), or null. */
function retryAfter(res) {
  const v = res.headers?.get?.('retry-after');
  if (!v) return null;
  const n = Number(v);
  if (Number.isFinite(n)) return Math.max(0, Math.ceil(n));
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, Math.ceil((t - Date.now()) / 1000)) : null;
}

/** The error for an HTTP status, with what to do. */
function httpError(res, name, url) {
  const host = hostOf(url);
  const st = res.status;
  if (st === 404 || st === 410) return new DownloadError('not_found', `${name} is no longer at ${host} (HTTP ${st}).`, 'Use another model; updating hivedesk refreshes the catalog. Press Retry if the server was being updated.', { status: st });
  if (st === 401 || st === 403) return new DownloadError('forbidden', `${host} refused the download of ${name} (HTTP ${st}).`, 'Press Retry later or use another model. A network filter or proxy can also block it.', { status: st });
  if (st === 429) {
    const after = retryAfter(res);
    return new DownloadError('rate_limited', `${host} asks to wait before downloading again (HTTP 429)${after ? `, about ${after} seconds` : ''}.`, 'Wait a little and press Retry; the download continues where it stopped.', { status: st, retryAfter: after });
  }
  if (st >= 500) return new DownloadError('server', `${host} had a problem sending ${name} (HTTP ${st}).`, 'Press Retry in a few minutes; the download continues where it stopped.', { status: st });
  return new DownloadError('http', `The download of ${name} failed with HTTP ${st}.`, 'Press Retry later, or use another model.', { status: st });
}

/** Moves the verified part into place, waiting out a short lock (an antivirus scanning the new file). */
async function moveIntoPlace(part, final, opts) {
  const delay = opts.retryDelayMs ?? 500;
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(part, final);
      return final;
    } catch (err) {
      if (!LOCKED.test(err?.code || '')) throw new DownloadError('io', `Could not save ${final} (${err.code || err.message}).`, 'Check that the folder can be written, then press Retry.');
      if (i >= 5) {
        throw new DownloadError('locked', `${final} is in use by another program (${err.code}), so the verified download could not be put in place.`,
          'An antivirus scan or another hivedesk window may hold it: wait a moment, or allow the hivedesk folder in the antivirus, then press Retry. The verified download is kept.');
      }
      await sleep(delay * (i + 1));
    }
  }
}

async function downloadFile(p, final, opts) {
  const f = opts.fetchImpl || fetch;
  const part = final + '.part';
  const host = hostOf(p.url);
  let have = 0;
  try { have = fs.statSync(part).size; } catch { /* fresh */ }
  if (have > p.bytes) { fs.rmSync(part, { force: true }); have = 0; }
  const hash = crypto.createHash('sha256');
  if (have > 0) await hashFile(part, hash);
  if (have === p.bytes) {
    // A complete part left by a crash or a lock: verify it, no request needed.
    if (hash.digest('hex') === String(p.sha256).toLowerCase()) return moveIntoPlace(part, final, opts);
    fs.rmSync(part, { force: true });
    return downloadFile(p, final, opts);
  }
  const report = (received, bps) => opts.onProgress?.({ received: opts.offset + received, total: opts.total, bps, ...(opts.count > 1 ? { part: opts.index + 1, parts: opts.count } : {}) });
  const aborted = () => new DownloadError('aborted', 'The download was stopped.', 'Press Retry to continue where it stopped.');
  let res;
  for (let tries = 0; ; tries++) {
    try {
      res = await f(p.url, { headers: have ? { range: `bytes=${have}-` } : {}, redirect: 'follow', signal: opts.signal });
    } catch (err) {
      if (opts.signal?.aborted) throw aborted();
      if (networkCode(err)) {
        throw new DownloadError('no_network', `Could not reach ${host} to download ${opts.name}.`,
          'Check the connection and press Retry, or use --model <file.gguf>, or --demo to look around.');
      }
      throw new DownloadError('io', String(err.message || err), 'Press Retry.');
    }
    // Too many requests with a short wait named by the server: wait and ask again, twice at most.
    const wait = res.status === 429 ? retryAfter(res) : null;
    if (wait != null && wait <= 30 && tries < 2) {
      await res.body?.cancel?.().catch(() => {});
      await sleep(wait * 1000, opts.signal);
      if (opts.signal?.aborted) throw aborted();
      continue;
    }
    break;
  }
  const restart = async () => {
    await res.body?.cancel?.().catch(() => {});
    fs.rmSync(part, { force: true });
    return downloadFile(p, final, opts);
  };
  // The server ignored the range, or could not serve it: start over.
  if (have && (res.status === 200 || res.status === 416)) return restart();
  if (have && res.status === 206) {
    const m = /bytes (\d+)-/.exec(res.headers?.get?.('content-range') || '');
    if (m && Number(m[1]) !== have) return restart();
  }
  if (!res.ok && res.status !== 206) {
    await res.body?.cancel?.().catch(() => {});
    throw httpError(res, opts.name, p.url);
  }
  let out = null;
  let wErr = null;
  let received = have;
  let lastTick = 0;
  let lastBytes = received;
  let lastTime = Date.now();
  let bps = 0;
  try {
    if (!res.body) throw new Error('empty body');
    out = fs.createWriteStream(part, { flags: have ? 'a' : 'w' });
    // A write error (disk full, the file locked) must end the download, never crash or hang it.
    out.on('error', (e) => { wErr ||= e; });
    for await (const chunk of res.body) {
      if (wErr) throw wErr;
      hash.update(chunk);
      received += chunk.length;
      // Never more than the size the catalog names: a server sending more is cut off and the part is dropped.
      if (received > p.bytes) throw Object.assign(new Error('too big'), { tooBig: true });
      if (!out.write(chunk)) await once(out, 'drain');
      const now = Date.now();
      if (now - lastTick > 250) {
        const dt = (now - lastTime) / 1000;
        if (dt > 0.5) { bps = (received - lastBytes) / dt; lastBytes = received; lastTime = now; }
        lastTick = now;
        report(received, bps);
      }
    }
    await new Promise((resolve, reject) => out.end((err) => (err || wErr ? reject(err || wErr) : resolve())));
  } catch (err) {
    const e = wErr || err;
    await new Promise((resolve) => { if (!out || out.closed) return resolve(); out.once('close', resolve); out.destroy(); });
    res.body?.cancel?.().catch(() => {});
    if (err?.tooBig) { fs.rmSync(part, { force: true }); throw new DownloadError('checksum', `The server sent more than the ${formatBytes(p.bytes)} of ${opts.name}.`, 'It was deleted; press Retry to download it again.'); }
    if (opts.signal?.aborted) throw aborted();
    if (e?.code === 'ENOSPC') throw new DownloadError('no_disk', 'The disk is full.', 'Free some space and press Retry; the download continues where it stopped.');
    if (LOCKED.test(e?.code || '')) {
      throw new DownloadError('locked', `${part} is in use by another program (${e.code}).`,
        'An antivirus scan or another hivedesk window may hold it: wait a moment, or allow the hivedesk folder in the antivirus, then press Retry.');
    }
    if (e?.syscall) throw new DownloadError('io', `Could not write ${part} (${e.code || e.message}).`, 'Check that the folder can be written and has free space, then press Retry.');
    throw new DownloadError('no_network', `The connection dropped at ${formatBytes(opts.offset + received)} of ${formatBytes(opts.total)}.`, 'Check the connection and press Retry; the download continues where it stopped.');
  }
  report(received, bps);
  if (p.bytes && received < p.bytes) {
    // The body ended early without an error: keep the part, the next try resumes.
    throw new DownloadError('no_network', `The connection dropped at ${formatBytes(opts.offset + received)} of ${formatBytes(opts.total)}.`, 'Check the connection and press Retry; the download continues where it stopped.');
  }
  const digest = hash.digest('hex');
  if (digest !== String(p.sha256).toLowerCase()) {
    fs.rmSync(part, { force: true });
    throw new DownloadError('checksum', `The downloaded file for ${opts.name} is corrupt (checksum mismatch).`, 'It was deleted; press Retry to download it again.');
  }
  return moveIntoPlace(part, final, opts);
}
