#!/usr/bin/env node
// Rebuilds catalog.json from families.js and the Hugging Face API: the exact file of every quantization,
// its size, its SHA-256 (the LFS object id) and the repository revision, plus the license of the base model.
//
//   node src/brain/catalog/refresh.mjs            writes src/brain/catalog/catalog.json
//   node src/brain/catalog/refresh.mjs --check    prints what changed, writes nothing
//
// Needs the network. The tests never run it: they validate the stored JSON.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAMILIES, QUANTS, TRUSTED, LICENSES } from './families.js';
import { vramTable, memoryNeed, GIANT_VRAM, QUANT_BITS, staticSpeedClass, QUANT_QUALITY } from './estimate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'catalog.json');
const API = 'https://huggingface.co/api/models';
const HF = 'https://huggingface.co';
const check = process.argv.includes('--check');

async function getJson(url, tries = 4) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { headers: { accept: 'application/json' } });
      if (r.status === 404 || r.status === 401) return { status: r.status, json: null, link: null };
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return { status: r.status, json: await r.json(), link: r.headers.get('link') };
    } catch (err) {
      if (i >= tries - 1) throw new Error(`${url}: ${err.message}`);
      await new Promise((res) => setTimeout(res, 1500 * (i + 1)));
    }
  }
}

const trees = new Map();
async function tree(repo) {
  if (trees.has(repo)) return trees.get(repo);
  const p = (async () => {
    const info = await getJson(`${API}/${repo}`);
    if (!info.json) return null;
    const files = [];
    let url = `${API}/${repo}/tree/main?recursive=true`;
    while (url) {
      const r = await getJson(url);
      for (const f of r.json || []) if (f.type === 'file') files.push(f);
      const next = /<([^>]+)>;\s*rel="next"/.exec(r.link || '');
      url = next ? next[1] : null;
    }
    return { revision: info.json.sha, gated: info.json.gated || false, files };
  })();
  trees.set(repo, p);
  return p;
}

async function license(base) {
  const r = await getJson(`${API}/${base}`);
  const card = r.json?.cardData || {};
  const id = card.license === 'other' ? card.license_name : card.license;
  return { id: id || null, gated: r.json?.gated || false };
}

/** The file (or the parts of a split file) of one quantization in a repository tree. */
export function findQuant(files, quant) {
  const re = new RegExp(`(?:^|[-._])${quant}(?:-(\\d{5})-of-(\\d{5}))?\\.gguf$`, 'i');
  const hits = files.filter((f) => {
    const base = f.path.split('/').pop();
    return re.test(base) && !/(^|[-_.])UD-/i.test(base) && !/mmproj|imatrix/i.test(base) && f.lfs?.oid;
  });
  const single = hits.filter((f) => !/-\d{5}-of-\d{5}\.gguf$/i.test(f.path));
  if (single.length) return [single.sort((a, b) => a.path.length - b.path.length)[0]];
  if (!hits.length) return null;
  const m = /-(\d{5})-of-(\d{5})\.gguf$/i.exec(hits[0].path);
  const total = Number(m[2]);
  const stem = hits[0].path.replace(/-\d{5}-of-\d{5}\.gguf$/i, '');
  const parts = hits.filter((f) => f.path.startsWith(stem)).sort((a, b) => a.path.localeCompare(b.path));
  return parts.length === total ? parts : null;
}

async function build(spec) {
  const lic = await license(spec.base);
  const variants = [];
  for (const quant of QUANTS) {
    for (const repo of spec.sources) {
      const owner = repo.split('/')[0];
      if (!TRUSTED[owner]) throw new Error(`${repo}: ${owner} is not a trusted publisher or quantizer`);
      const t = await tree(repo);
      if (!t) continue;
      const parts = findQuant(t.files, quant);
      if (!parts) continue;
      const files = parts.map((f) => ({
        path: f.path, bytes: f.lfs.size ?? f.size, sha256: f.lfs.oid,
        url: `${HF}/${repo}/resolve/${t.revision}/${f.path.split('/').map(encodeURIComponent).join('/')}`
      }));
      const bytes = files.reduce((n, f) => n + f.bytes, 0);
      const vram = vramTable(spec.arch, bytes);
      variants.push({
        quant, bits: QUANT_BITS[quant], repo, revision: t.revision, trust: TRUSTED[owner], files, bytes, vram,
        giant: memoryNeed(spec.arch, bytes, 4096) > GIANT_VRAM
      });
      break;
    }
  }
  const q4 = variants.find((v) => v.quant === 'Q4_K_M');
  const known = LICENSES[spec.license] || {};
  return {
    id: spec.id, family: spec.family, name: spec.name, tasks: spec.tasks, params: spec.params,
    ...(spec.activeParams ? { activeParams: spec.activeParams } : {}),
    arch: spec.arch, contextLength: spec.arch.ctx,
    license: { id: spec.license, name: known.name || spec.license, ...(known.url ? { url: known.url } : { url: `${HF}/${spec.base}/blob/main/LICENSE` }), commercial: known.commercial ?? null, ...(known.notes ? { notes: known.notes } : {}), apiId: lic.id, gatedBase: !!lic.gated },
    base: `${HF}/${spec.base}`, quality: spec.quality, speedClass: staticSpeedClass(spec),
    giant: q4 ? q4.giant : variants.every((v) => v.giant),
    ...(spec.notes ? { notes: spec.notes } : {}),
    variants
  };
}

async function main() {
  const models = [];
  const queue = [...FAMILIES];
  const workers = Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const spec = queue.shift();
      const m = await build(spec);
      if (m.license.apiId && m.license.apiId !== m.license.id) console.warn(`license differs for ${m.id}: catalog ${m.license.id}, Hugging Face ${m.license.apiId}`);
      const missing = QUANTS.filter((q) => !m.variants.some((v) => v.quant === q));
      console.log(`${m.id}: ${m.variants.length} files${missing.length ? ` (no ${missing.join(', ')})` : ''}`);
      models.push(m);
    }
  });
  await Promise.all(workers);
  models.sort((a, b) => FAMILIES.findIndex((f) => f.id === a.id) - FAMILIES.findIndex((f) => f.id === b.id));
  const out = {
    version: 1,
    generated: new Date().toISOString(),
    source: API,
    quants: QUANTS,
    trusted: TRUSTED,
    heuristics: {
      memory: 'weights + 2 x layers x kv heads x head size x 2 bytes per token of context + compute (120 MB + vocab x 1 KB + 40 KB per token) + 350 MB runtime reserve; see estimate.js',
      giant: `needs more than ${GIANT_VRAM / 1e9} GB at 4096 tokens`,
      quality: 'rounded reading of the published model cards and leaderboards for the Q8_0 file, lowered per quantization (see quantQuality) and more for small models; a ranking aid, not a measurement',
      quantQuality: QUANT_QUALITY,
      speedClass: 'fast: up to 4B parameters per token, medium: up to 9B, slow: up to 16B, very_slow: more'
    },
    models
  };
  const json = JSON.stringify(out, null, 1) + '\n';
  if (check) {
    const old = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { models: [] };
    const key = (m) => m.variants.map((v) => `${m.id}/${v.quant}/${v.files.map((f) => f.sha256).join('+')}`);
    const a = new Set(old.models.flatMap(key));
    const b = new Set(out.models.flatMap(key));
    const added = [...b].filter((x) => !a.has(x));
    const gone = [...a].filter((x) => !b.has(x));
    console.log(`${added.length} new or changed files, ${gone.length} removed or changed`);
    for (const x of added) console.log(`  + ${x}`);
    for (const x of gone) console.log(`  - ${x}`);
    return;
  }
  fs.writeFileSync(OUT, json);
  const n = models.reduce((s, m) => s + m.variants.length, 0);
  console.log(`wrote ${OUT}: ${models.length} models, ${n} files`);
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) main().catch((err) => { console.error(err.message || err); process.exit(1); });
