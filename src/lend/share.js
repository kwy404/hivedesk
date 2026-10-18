// The Lend screen as an adapter onto grants (PLAN 1.1, "lend becomes a compatibility adapter").
// What the screen calls "lend my PC" is a set of compute capabilities, each with its limits:
//   compute.inference  the right to send inference jobs (concurrency, seconds, tokens, models)
//   compute.gpu        { maxVramBytes, gpus, maxUtilPct }
//   compute.cpu        { maxThreads, maxLoadPct }
//   compute.ram        { maxBytes }
//   compute.storage    { maxBytes, modelDownload }
// Lending to a friend creates these grants for that friend's verified peer id; Stop lending
// revokes them. The jobs themselves run in src/compute/ (the worker checks the grants).

import { COMPUTE_RESOURCES, GB, normalizeCapability } from '../p2p/caps.js';

export const LEND_CAPS = Object.freeze(['compute.inference', ...COMPUTE_RESOURCES]);

export const LEND_DEFAULTS = Object.freeze({
  gpu: { on: true, maxVramGB: 4, gpus: [] },
  cpu: { on: false, threads: 2, maxLoadPct: 50 },
  ram: { on: true, maxGB: 2 },
  storage: { on: false, maxGB: 0, modelDownload: false },
  minutes: 60,
  maxJobSeconds: 120,
  maxTokens: 2048,
  maxConcurrentJobs: 1,
  models: [],
});

const n = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const on = (v, d) => (typeof v === 'boolean' ? v : d);

/** Reads the Lend form (anything from the window) into clean settings. */
export function readLendForm(form = {}) {
  const f = form && typeof form === 'object' ? form : {};
  const d = LEND_DEFAULTS;
  return {
    gpu: { on: on(f.gpu?.on, d.gpu.on), maxVramGB: Math.max(0, n(f.gpu?.maxVramGB, d.gpu.maxVramGB)), gpus: Array.isArray(f.gpu?.gpus) ? f.gpu.gpus.map(String) : [] },
    cpu: { on: on(f.cpu?.on, d.cpu.on), threads: Math.max(1, Math.round(n(f.cpu?.threads, d.cpu.threads))), maxLoadPct: n(f.cpu?.maxLoadPct, d.cpu.maxLoadPct) },
    ram: { on: on(f.ram?.on, d.ram.on), maxGB: Math.max(0, n(f.ram?.maxGB, d.ram.maxGB)) },
    storage: { on: on(f.storage?.on, d.storage.on), maxGB: Math.max(0, n(f.storage?.maxGB, d.storage.maxGB)), modelDownload: on(f.storage?.modelDownload, false) },
    minutes: Math.max(1, Math.round(n(f.minutes, d.minutes))),
    maxJobSeconds: n(f.maxJobSeconds, d.maxJobSeconds),
    maxTokens: n(f.maxTokens, d.maxTokens),
    maxConcurrentJobs: n(f.maxConcurrentJobs, d.maxConcurrentJobs),
    models: Array.isArray(f.models) ? f.models.map(String) : [],
  };
}

/**
 * The capabilities a Lend form stands for, normalized and clamped by the catalog. Nothing is
 * lent when neither the GPU nor the CPU is on: inference needs one of them.
 */
export function lendCaps(form) {
  const f = readLendForm(form);
  if (!f.gpu.on && !f.cpu.on) return [];
  const caps = [normalizeCapability({ name: 'compute.inference', limits: { maxConcurrentJobs: f.maxConcurrentJobs, maxJobSeconds: f.maxJobSeconds, maxTokensPerJob: f.maxTokens, models: f.models } })];
  if (f.gpu.on) caps.push(normalizeCapability({ name: 'compute.gpu', limits: { maxVramBytes: Math.round(f.gpu.maxVramGB * GB), gpus: f.gpu.gpus } }));
  if (f.cpu.on) caps.push(normalizeCapability({ name: 'compute.cpu', limits: { maxThreads: f.cpu.threads, maxLoadPct: f.cpu.maxLoadPct } }));
  if (f.ram.on) caps.push(normalizeCapability({ name: 'compute.ram', limits: { maxBytes: Math.round(f.ram.maxGB * GB) } }));
  if (f.storage.on) caps.push(normalizeCapability({ name: 'compute.storage', limits: { maxBytes: Math.round(f.storage.maxGB * GB), modelDownload: f.storage.modelDownload } }));
  return caps;
}

/** The join dialog answer for a lend: the form's capabilities on, for the form's minutes, plus city.view. */
export function lendAnswer(form) {
  const f = readLendForm(form);
  return [{ capability: { name: 'city.view' }, minutes: f.minutes }, ...lendCaps(f).map((c) => ({ capability: c, minutes: f.minutes }))];
}

/** Who borrows what right now: peers with at least one active compute grant. */
export function lendingNow(peers) {
  return (peers || [])
    .map((p) => ({ peerId: p.identity.peerId, name: p.identity.name, fingerprint: p.identity.fingerprint.words, online: p.online, grants: p.grants.filter((g) => LEND_CAPS.includes(g.capability.name)) }))
    .filter((p) => p.grants.length);
}
