// The model catalog (catalog.json, rebuilt by refresh.mjs): every model, every quantization, and the
// downloadable entry ("pick") of one model at one quantization, in the shape downloadModel and the
// brain manager use.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { memoryNeed, qualityFor, QUANT_BITS } from './estimate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CATALOG_FILE = path.join(HERE, 'catalog.json');

let cache = null;

/** @returns {{ version: number, generated: string, quants: string[], trusted: Record<string, string>, models: any[] }} */
export function loadCatalog(file = CATALOG_FILE) {
  if (file === CATALOG_FILE && cache) return cache;
  const c = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (file === CATALOG_FILE) cache = c;
  return c;
}

export function catalogModel(id, catalog = loadCatalog()) {
  const key = String(id || '').toLowerCase();
  return catalog.models.find((m) => m.id === key) || null;
}

/**
 * A downloadable entry: one model at one quantization.
 * @returns {{ id: string, modelId: string, quant: string, name: string, short: string, repo: string, file: string,
 *   files: { path: string, file: string, bytes: number, sha256: string, url: string }[], bytes: number, sha256: string,
 *   url: string, source: string, license: any, arch: any, params: number, activeParams?: number, giant: boolean } | null}
 */
export function pick(modelId, quant = 'Q4_K_M', catalog = loadCatalog()) {
  const m = catalogModel(modelId, catalog);
  if (!m) return null;
  const v = m.variants.find((x) => x.quant.toUpperCase() === String(quant).toUpperCase());
  if (!v) return null;
  return toPick(m, v);
}

export function toPick(m, v) {
  const files = v.files.map((f) => ({ ...f, file: f.path.split('/').pop() }));
  return {
    id: `${m.id}:${v.quant}`, modelId: m.id, quant: v.quant, name: `${m.name} (${v.quant})`,
    short: m.id.replace(/^.*?-(\d[\w.]*b)$/i, '$1'),
    repo: v.repo, revision: v.revision, trust: v.trust,
    file: files[0].file, files, bytes: v.bytes, sha256: files.length === 1 ? files[0].sha256 : null,
    url: files[0].url, source: `https://huggingface.co/${v.repo}`,
    license: m.license, arch: m.arch, params: m.params, ...(m.activeParams ? { activeParams: m.activeParams } : {}),
    contextLength: m.contextLength, tasks: m.tasks, quality: m.quality, family: m.family, giant: !!v.giant, bits: v.bits ?? QUANT_BITS[v.quant]
  };
}

/** "qwen2.5-coder-7b:Q3_K_M", "qwen2.5-coder-7b q3_k_m", "qwen2.5-coder-7b" (Q4_K_M), or a known file name. */
export function resolvePick(spec, catalog = loadCatalog()) {
  const s = String(spec || '').trim();
  if (!s) return null;
  const m = /^([\w.-]+?)[:@ ]([\w]+)$/.exec(s);
  if (m) return pick(m[1], m[2], catalog);
  if (catalogModel(s, catalog)) return pick(s, 'Q4_K_M', catalog);
  const lower = s.toLowerCase();
  for (const model of catalog.models) {
    for (const v of model.variants) if (v.files.some((f) => lower.endsWith(f.path.split('/').pop().toLowerCase()) || lower.includes(`/${v.repo.toLowerCase()}/`) && lower.endsWith(f.path.toLowerCase()))) return toPick(model, v);
  }
  return null;
}

/** All entries, flattened, for listings and the recommendation. */
export function allPicks(catalog = loadCatalog()) {
  return catalog.models.flatMap((m) => m.variants.map((v) => toPick(m, v)));
}

export function needFor(p, ctx) {
  return memoryNeed(p.arch, p.bytes, ctx);
}

export function qualityOf(p, task) {
  const t = task === 'general' ? 'chat' : task;
  return qualityFor({ quality: p.quality, params: p.params }, p.quant, t);
}

/** Problems with a catalog (used by the tests and by refresh --check); [] when it is valid. */
export function validateCatalog(c) {
  const errors = [];
  if (!c || !Array.isArray(c.models) || !c.models.length) return ['no models'];
  const ids = new Set();
  for (const m of c.models) {
    const at = m.id || '(no id)';
    if (!/^[a-z0-9][a-z0-9.-]+$/.test(m.id || '')) errors.push(`${at}: bad id`);
    if (ids.has(m.id)) errors.push(`${at}: duplicate id`);
    ids.add(m.id);
    if (!m.name) errors.push(`${at}: no name`);
    if (!m.license?.id || !m.license?.name) errors.push(`${at}: no license`);
    if (m.license?.apiId && m.license.apiId !== m.license.id) errors.push(`${at}: license ${m.license.id} but Hugging Face says ${m.license.apiId}`);
    if (!(m.contextLength >= 2048)) errors.push(`${at}: no context length`);
    for (const k of ['layers', 'kvHeads', 'headDim', 'vocab']) if (!(m.arch?.[k] > 0)) errors.push(`${at}: arch.${k} missing`);
    for (const k of ['coding', 'reasoning', 'chat']) if (!(m.quality?.[k] >= 0 && m.quality[k] <= 100)) errors.push(`${at}: quality.${k} out of range`);
    if (!m.variants?.length) errors.push(`${at}: no files`);
    const quants = new Set();
    for (const v of m.variants || []) {
      const vat = `${at} ${v.quant}`;
      if (!c.quants.includes(v.quant)) errors.push(`${vat}: unknown quantization`);
      if (quants.has(v.quant)) errors.push(`${vat}: duplicate quantization`);
      quants.add(v.quant);
      const owner = String(v.repo || '').split('/')[0];
      if (!c.trusted?.[owner]) errors.push(`${vat}: ${owner} is not a trusted publisher or quantizer`);
      if (!/^[0-9a-f]{40}$/.test(v.revision || '')) errors.push(`${vat}: no pinned revision`);
      if (!v.files?.length) errors.push(`${vat}: no files`);
      let sum = 0;
      for (const f of v.files || []) {
        sum += f.bytes;
        if (!/^[0-9a-f]{64}$/.test(f.sha256 || '')) errors.push(`${vat}: ${f.path} has no SHA-256`);
        if (!(f.bytes > 1e7)) errors.push(`${vat}: ${f.path} has no size`);
        if (!/\.gguf$/i.test(f.path)) errors.push(`${vat}: ${f.path} is not a GGUF file`);
        const prefix = `https://huggingface.co/${v.repo}/resolve/${v.revision}/`;
        if (!String(f.url).startsWith(prefix)) errors.push(`${vat}: ${f.path} is not linked from ${v.repo} at its revision`);
      }
      if (sum !== v.bytes) errors.push(`${vat}: size is not the sum of its parts`);
      if (!v.vram || !v.vram['2048']) errors.push(`${vat}: no VRAM table`);
      for (const [ctx, need] of Object.entries(v.vram || {})) {
        if (need !== memoryNeed(m.arch, v.bytes, Number(ctx))) errors.push(`${vat}: VRAM for ${ctx} does not match the estimate`);
        if (need <= v.bytes) errors.push(`${vat}: VRAM for ${ctx} is less than the weights`);
      }
    }
  }
  return errors;
}
