// Model sizes, memory needs and speeds for the resource scheduler (PLAN section 7).
// Seeds are rough by model size and device; measured speeds (an exponential average of finished turns)
// replace them per target and model as soon as one turn ran there.
import { MODELS } from '../brain/models.js';

const GiB = 1024 ** 3;

/** Billions of parameters from an id, file or display name ("qwen2.5-coder-7b", "qwen2.5-coder:7b", "...14B..."). */
export function paramsOf(model) {
  const s = String(model || '').toLowerCase();
  const cat = catalogOf(s);
  const src = cat ? cat.id : s;
  const m = src.match(/(?:^|[^a-z0-9.])(\d+(?:\.\d+)?)\s*b(?![a-z])/) || src.match(/[-:_](\d+(?:\.\d+)?)b/);
  return m ? Number(m[1]) : null;
}

/** The built in model for an id, short name, file or display name. */
export function catalogOf(model) {
  const s = String(model || '').toLowerCase().trim();
  if (!s) return null;
  return MODELS.find((m) => m.id === s || m.short === s || m.file.toLowerCase() === s || m.name.toLowerCase() === s || s.endsWith(`/${m.file.toLowerCase()}`) || s.endsWith(`\\${m.file.toLowerCase()}`)) || null;
}

/** "Qwen2.5-Coder 7B" for people. */
export function modelLabel(model) {
  const cat = catalogOf(model);
  if (cat) return cat.name.replace(/\s+Instruct.*$/i, '');
  const s = String(model || 'a model');
  return s.split(/[\\/]/).pop().replace(/\.gguf$/i, '');
}

/**
 * Does a requested model (an allowlist entry or the job's model) name the model a target serves?
 * Catalog ids, short names and file names of the same model all match each other.
 */
export function sameModel(a, b) {
  if (!a || !b) return false;
  const ca = catalogOf(a);
  const cb = catalogOf(b);
  if (ca && cb) return ca.id === cb.id;
  const norm = (x) => String(x).toLowerCase().trim().split(/[\\/]/).pop().replace(/\.gguf$/, '');
  if (norm(a) === norm(b)) return true;
  // A catalog pick id names a quant ("qwen2.5-coder-3b:Q4_K_M"); a model id without one covers every quant of it.
  const [ma, qa] = norm(a).split(':');
  const [mb, qb] = norm(b).split(':');
  return ma === mb && (!qa || !qb);
}

/** Bytes of the weights: the catalog size, or about 0.6 bytes per parameter for a Q4_K_M file. */
export function modelBytes(model, known) {
  if (Number.isFinite(known) && known > 0) return known;
  const cat = catalogOf(model);
  if (cat) return cat.bytes;
  const p = paramsOf(model);
  return p ? Math.round(p * 0.6e9) : null;
}

/** KV cache bytes per token (f16), from the Qwen2.5 layer, KV head and head size numbers. */
export function kvBytesPerToken(model) {
  const p = paramsOf(model);
  if (p == null) return 64 * 1024;
  if (p <= 0.6) return 12_288;
  if (p <= 2) return 28_672;
  if (p <= 4) return 36_864;
  if (p <= 8) return 57_344;
  if (p <= 15) return 196_608;
  return Math.round(14_000 * p);
}

export const kvCache = (model, tokens) => kvBytesPerToken(model) * Math.max(0, tokens);

/** VRAM to load a model with a context: weights, its KV cache and about 300 MB of compute buffers. */
export function modelVram(model, ctx = 4096, bytes) {
  const w = modelBytes(model, bytes);
  return w == null ? null : Math.round(w * 1.05 + kvCache(model, ctx) + 300 * 1024 ** 2);
}

/** Prompt tokens from characters (the engine's rough rule: 4 characters per token). */
export function promptTokensOf(messages) {
  let chars = 0;
  for (const m of messages || []) chars += String(m?.content || '').length;
  return Math.ceil(chars / 4);
}

const SEED = {
  gpu: [[0.5, 180, 3600], [1.5, 110, 2200], [3, 70, 1400], [7, 38, 760], [14, 20, 400], [32, 9, 180]],
  cpu: [[0.5, 45, 270], [1.5, 22, 130], [3, 11, 66], [7, 5, 30], [14, 2.5, 15], [32, 1, 6]]
};

/** Seed speeds { tg, pp } in tokens per second for a model size on a device. */
export function seedSpeed(model, device) {
  const p = paramsOf(model) ?? 7;
  const rows = SEED[device === 'cpu' ? 'cpu' : 'gpu'];
  let best = rows[0];
  for (const r of rows) if (Math.abs(Math.log(r[0] / p)) < Math.abs(Math.log(best[0] / p))) best = r;
  return { tg: best[1], pp: best[2], measured: false };
}

/** Measured speeds per target and model: an exponential average of finished turns. */
export class SpeedTable {
  constructor(alpha = 0.3) {
    this.alpha = alpha;
    /** @type {Map<string, { tg: number, pp: number, n: number }>} */
    this.map = new Map();
  }

  key(target, model) {
    return `${target}|${catalogOf(model)?.id || String(model || '').toLowerCase()}`;
  }

  /** @param {string} target @param {string} model @param {'gpu'|'cpu'} device */
  get(target, model, device) {
    const m = this.map.get(this.key(target, model));
    return m ? { tg: m.tg, pp: m.pp, measured: true } : seedSpeed(model, device);
  }

  /** @param {{ promptTokens: number, completionTokens: number, ms: number }} turn */
  observe(target, model, device, turn) {
    if (!turn || !(turn.completionTokens > 0) || !(turn.ms > 0)) return;
    const cur = this.get(target, model, device);
    const genSec = Math.max(0.05, turn.ms / 1000 - (turn.promptTokens || 0) / cur.pp);
    const tg = Math.max(0.1, Math.min(2000, turn.completionTokens / genSec));
    const k = this.key(target, model);
    const prev = this.map.get(k);
    this.map.set(k, prev ? { tg: prev.tg + this.alpha * (tg - prev.tg), pp: prev.pp, n: prev.n + 1 } : { tg, pp: cur.pp, n: 1 });
  }
}

export const fmtGB = (n) => `${(n / GiB).toFixed(1)}`;
export const fmtSeconds = (ms) => {
  const s = ms / 1000;
  if (s < 10) return `${Math.max(1, Math.round(s))} s`;
  if (s < 120) return `${Math.round(s)} s`;
  return `${Math.round(s / 60)} min`;
};
