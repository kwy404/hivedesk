// ShareSettings: what this machine lends to peers, kept in ~/.hivedesk/settings.json under "share".
// GPU and CPU are separate capabilities and both are OFF by default. The owner's engine enforces
// these limits on every job (src/compute/worker.js); a copy a peer sees in a resource advert is advisory.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SHARE_VERSION = 1;
const GiB = 1024 ** 3;
const PEER_ID = /^hd1[a-z2-7]{49}$/;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** @param {number} [threads] logical CPU threads of this machine */
export function defaultShare(threads = os.cpus().length || 1) {
  return derive({
    v: SHARE_VERSION,
    gpu: { enabled: false, maxVramBytes: null, maxConcurrentJobs: 1, maxJobSeconds: 120, remoteInference: false, modelDownload: false },
    cpu: { enabled: false, maxThreads: Math.max(1, Math.floor(threads / 2)), maxRamBytes: null },
    maxTokensPerJob: 2048,
    modelAllowlist: [],
    peers: 'known'
  });
}

const int = (v, lo, hi, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d;
};
const bool = (v, d) => (typeof v === 'boolean' ? v : d);
const bytesOrNull = (v, lo, d) => {
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.max(lo, Math.round(n)) : d;
};

/** The frozen top level fields of PLAN section 2 mirror the GPU block. */
function derive(s) {
  s.enabled = !!(s.gpu.enabled || s.cpu.enabled);
  s.remoteInference = s.gpu.remoteInference;
  s.modelDownload = s.gpu.modelDownload;
  s.maxConcurrentJobs = s.gpu.maxConcurrentJobs;
  s.maxVramBytes = s.gpu.maxVramBytes;
  s.maxJobSeconds = s.gpu.maxJobSeconds;
  return s;
}

/**
 * Clamps and cleans any input (a stored file, a command from the window, a CLI change) into ShareSettings.
 * Unknown fields are dropped. A 0.x style flat object (enabled, maxVramBytes, ...) is read as the GPU block.
 * @param {any} input @param {{ threads?: number }} [opts]
 */
export function normalizeShare(input, opts = {}) {
  const threads = opts.threads || os.cpus().length || 1;
  const d = defaultShare(threads);
  const src = input && typeof input === 'object' ? input : {};
  const g = src.gpu && typeof src.gpu === 'object' ? src.gpu : {
    enabled: src.enabled, maxVramBytes: src.maxVramBytes, maxConcurrentJobs: src.maxConcurrentJobs,
    maxJobSeconds: src.maxJobSeconds, remoteInference: src.remoteInference, modelDownload: src.modelDownload
  };
  const c = src.cpu && typeof src.cpu === 'object' ? src.cpu : {};
  const out = {
    v: SHARE_VERSION,
    gpu: {
      enabled: bool(g.enabled, d.gpu.enabled),
      maxVramBytes: bytesOrNull(g.maxVramBytes, 256 * 1024 ** 2, d.gpu.maxVramBytes),
      maxConcurrentJobs: int(g.maxConcurrentJobs, 1, 4, d.gpu.maxConcurrentJobs),
      maxJobSeconds: int(g.maxJobSeconds, 10, 1800, d.gpu.maxJobSeconds),
      remoteInference: bool(g.remoteInference, d.gpu.remoteInference),
      modelDownload: bool(g.modelDownload, d.gpu.modelDownload)
    },
    cpu: {
      enabled: bool(c.enabled, d.cpu.enabled),
      maxThreads: int(c.maxThreads, 1, threads, d.cpu.maxThreads),
      maxRamBytes: bytesOrNull(c.maxRamBytes, 512 * 1024 ** 2, d.cpu.maxRamBytes)
    },
    maxTokensPerJob: int(src.maxTokensPerJob, 1, 8192, d.maxTokensPerJob),
    modelAllowlist: Array.isArray(src.modelAllowlist)
      ? [...new Set(src.modelAllowlist.filter((m) => typeof m === 'string' && m.trim() && m.length <= 200).map((m) => m.trim()))].slice(0, 16)
      : d.modelAllowlist,
    peers: Array.isArray(src.peers) ? [...new Set(src.peers.filter((p) => typeof p === 'string' && PEER_ID.test(p)))].slice(0, 64) : 'known'
  };
  if (src.hours && HHMM.test(String(src.hours.from)) && HHMM.test(String(src.hours.to)) && src.hours.from !== src.hours.to) {
    out.hours = { from: src.hours.from, to: src.hours.to };
  }
  return derive(out);
}

/** Applies a partial change ({ gpu: { enabled: true } }, { maxTokensPerJob: 1024 }, { hours: null }) to settings. */
export function patchShare(current, change, opts = {}) {
  const base = normalizeShare(current, opts);
  const ch = change && typeof change === 'object' ? change : {};
  const next = {
    ...base,
    gpu: { ...base.gpu, ...(ch.gpu && typeof ch.gpu === 'object' ? ch.gpu : {}) },
    cpu: { ...base.cpu, ...(ch.cpu && typeof ch.cpu === 'object' ? ch.cpu : {}) }
  };
  for (const k of ['maxTokensPerJob', 'modelAllowlist', 'peers']) if (k in ch) next[k] = ch[k];
  if ('hours' in ch) {
    if (ch.hours) next.hours = ch.hours;
    else delete next.hours;
  }
  return normalizeShare(next, opts);
}

/** Is local time `now` inside the optional hours window? A window may wrap midnight (22:00 to 06:00). */
export function insideHours(share, now = new Date()) {
  if (!share.hours) return true;
  const mins = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  const t = now.getHours() * 60 + now.getMinutes();
  const a = mins(share.hours.from);
  const b = mins(share.hours.to);
  return a < b ? t >= a && t < b : t >= a || t < b;
}

export function settingsFile(home) {
  return path.join(home, 'settings.json');
}

/** Reads ShareSettings; a missing or broken file gives the defaults (everything off). */
export function loadShare(home, opts = {}) {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(home), 'utf8'));
    return normalizeShare(raw?.share, opts);
  } catch {
    return defaultShare(opts.threads);
  }
}

/** Writes ShareSettings and keeps every other section of settings.json (tmp file plus rename). */
export function saveShare(home, share, opts = {}) {
  const file = settingsFile(home);
  let doc = {};
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { /* first write */ }
  if (typeof doc !== 'object' || Array.isArray(doc)) doc = {};
  const clean = normalizeShare(share, opts);
  doc.v = doc.v || 1;
  doc.share = clean;
  fs.mkdirSync(home, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n');
  fs.renameSync(tmp, file);
  return clean;
}

/** "6GB", "6 GB", "6144MB", "512M", "0.5g", or a plain byte count. Binary units, like VRAM sizes. */
export function parseSize(text) {
  const m = String(text ?? '').trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(b|k|kb|m|mb|g|gb|t|tb)?$/);
  if (!m) return null;
  const mult = { b: 1, k: 1024, kb: 1024, m: 1024 ** 2, mb: 1024 ** 2, g: GiB, gb: GiB, t: 1024 ** 4, tb: 1024 ** 4 }[m[2] || 'b'];
  return Math.round(Number(m[1]) * mult);
}

export function formatGiB(n) {
  return n == null ? 'unknown' : `${(n / GiB).toFixed(1)} GB`;
}

/** Plain words for the CLI and the Settings tab. */
export function describeShare(s) {
  const lines = [];
  const g = s.gpu;
  lines.push(`GPU sharing: ${g.enabled ? 'on' : 'off'}`);
  if (g.enabled) {
    lines.push(`  peer jobs on the GPU: ${g.remoteInference ? 'allowed' : 'not allowed (remote inference is off)'}`);
    lines.push(`  VRAM for peer jobs: ${g.maxVramBytes == null ? 'what is free minus 1 GB' : `at most ${formatGiB(g.maxVramBytes)}`}`);
    lines.push(`  jobs at once: ${g.maxConcurrentJobs}, longest job: ${g.maxJobSeconds} s`);
    lines.push(`  download a model for a peer: ${g.modelDownload ? 'allowed (built in models only)' : 'never'}`);
  }
  lines.push(`CPU sharing: ${s.cpu.enabled ? 'on' : 'off'}`);
  if (s.cpu.enabled) {
    lines.push(`  threads for peer jobs: at most ${s.cpu.maxThreads}`);
    lines.push(`  RAM for peer jobs: ${s.cpu.maxRamBytes == null ? 'what is free minus 2 GB' : `at most ${formatGiB(s.cpu.maxRamBytes)}`}`);
  }
  lines.push(`Tokens per job: at most ${s.maxTokensPerJob}`);
  lines.push(`Models peers may use: ${s.modelAllowlist.length ? s.modelAllowlist.join(', ') : 'none listed (peers get "model not allowed")'}`);
  lines.push(`Who: ${s.peers === 'known' ? 'known peers you granted compute.inference' : `${s.peers.length} listed peers`}`);
  lines.push(`Hours: ${s.hours ? `${s.hours.from} to ${s.hours.to} local time` : 'any time'}`);
  return lines;
}
