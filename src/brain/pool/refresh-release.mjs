#!/usr/bin/env node
// Pins one llama.cpp build for pooled models (rpc-server on the lenders, llama-server on the borrower)
// and stores its official release assets with their SHA-256 (the GitHub release digests).
// Every peer must run the same build: the RPC protocol changes between builds.
//
//   node src/brain/pool/refresh-release.mjs [bNNNNN]     writes src/brain/pool/llama-release.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'llama-release.json');
const API = 'https://api.github.com/repos/ggml-org/llama.cpp/releases';

/** platform key -> asset name pattern ({tag} is replaced). The CUDA builds need the cudart zip next to them. */
export const WANTED = {
  'win-cpu-x64': ['llama-{tag}-bin-win-cpu-x64.zip'],
  'win-vulkan-x64': ['llama-{tag}-bin-win-vulkan-x64.zip'],
  'win-cuda-x64': ['llama-{tag}-bin-win-cuda-12.4-x64.zip', 'cudart-llama-bin-win-cuda-12.4-x64.zip'],
  'win-cpu-arm64': ['llama-{tag}-bin-win-cpu-arm64.zip'],
  'macos-arm64': ['llama-{tag}-bin-macos-arm64.tar.gz'],
  'macos-x64': ['llama-{tag}-bin-macos-x64.tar.gz'],
  'linux-x64': ['llama-{tag}-bin-ubuntu-x64.tar.gz'],
  'linux-vulkan-x64': ['llama-{tag}-bin-ubuntu-vulkan-x64.tar.gz'],
  'linux-arm64': ['llama-{tag}-bin-ubuntu-arm64.tar.gz']
};

async function main() {
  const want = process.argv[2];
  const r = await fetch(want ? `${API}/tags/${want}` : `${API}?per_page=10`, { headers: { accept: 'application/vnd.github+json' } });
  if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
  const j = await r.json();
  const rel = Array.isArray(j) ? j.find((x) => /^b\d+$/.test(x.tag_name) && x.assets.length > 10) : j;
  if (!rel) throw new Error('no build release with assets found');
  const tag = rel.tag_name;
  const platforms = {};
  for (const [key, names] of Object.entries(WANTED)) {
    const files = [];
    for (const n of names) {
      const name = n.replace('{tag}', tag);
      const a = rel.assets.find((x) => x.name === name);
      if (!a || !/^sha256:[0-9a-f]{64}$/.test(a.digest || '')) { files.length = 0; break; }
      files.push({ name, url: a.browser_download_url, bytes: a.size, sha256: a.digest.slice(7) });
    }
    if (files.length) platforms[key] = files;
  }
  const out = { tag, published: rel.published_at, source: rel.html_url, license: 'MIT', platforms };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
  console.log(`wrote ${OUT}: ${tag}, ${Object.keys(platforms).length} platforms`);
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) main().catch((err) => { console.error(err.message || err); process.exit(1); });
