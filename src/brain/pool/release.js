// The pinned llama.cpp build for pooled models (llama-release.json, rebuilt by refresh-release.mjs):
// which official release asset fits this machine, and its install with consent, resume and SHA-256.
// Downloaded only after a yes (the same consent store as the models, via 'models' or 'card').
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { downloadModel } from '../models.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const RELEASE = JSON.parse(fs.readFileSync(path.join(HERE, 'llama-release.json'), 'utf8'));

/**
 * The build for this machine and this role: a GPU lender or borrower wants CUDA (NVIDIA on Windows),
 * Vulkan (other GPUs) or Metal (macOS builds have it); a CPU lender takes the CPU build.
 * @param {{ os?: string, arch?: string, gpu?: { backend?: string } | null }} hw
 * @param {'gpu' | 'cpu'} [kind]
 */
export function platformKey(hw, kind = 'gpu') {
  const os = hw.os || process.platform;
  const arch = (hw.arch || process.arch) === 'arm64' ? 'arm64' : 'x64';
  const backend = kind === 'gpu' ? hw.gpu?.backend : null;
  if (os === 'darwin') return `macos-${arch}`;
  if (os === 'win32') {
    if (arch === 'arm64') return 'win-cpu-arm64';
    if (backend === 'cuda') return 'win-cuda-x64';
    if (backend === 'vulkan') return 'win-vulkan-x64';
    return 'win-cpu-x64';
  }
  if (arch === 'arm64') return 'linux-arm64';
  return backend && backend !== 'cpu' ? 'linux-vulkan-x64' : 'linux-x64';
}

export function buildDir(home, key) {
  return path.join(home, 'runtime', `llama-${RELEASE.tag}-${key}`);
}

const exe = (name) => (process.platform === 'win32' ? `${name}.exe` : name);

/** Where the binaries are (the archives unpack flat or into a build/bin folder). */
export function findBinaries(dir) {
  const names = { rpc: [exe('ggml-rpc-server'), exe('rpc-server')], server: [exe('llama-server')] };
  const out = {};
  const walk = (d, depth) => {
    let list = [];
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && depth < 3) walk(p, depth + 1);
      else if (!out.rpc && names.rpc.includes(e.name)) out.rpc = p;
      else if (!out.server && names.server.includes(e.name)) out.server = p;
    }
  };
  walk(dir, 0);
  return out.rpc && out.server ? out : null;
}

export function installed(home, key) {
  const dir = buildDir(home, key);
  return fs.existsSync(path.join(dir, '.verified')) ? findBinaries(dir) : null;
}

function unpack(file, dir) {
  // Windows 10 and later ship bsdtar as tar.exe, which reads zip and tar.gz; macOS and Linux have tar.
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  return new Promise((resolve, reject) => {
    execFile(tar, ['-xf', file, '-C', dir], { windowsHide: true, timeout: 300_000 }, (err) => (err ? reject(err) : resolve()));
  });
}

/**
 * Downloads (resume, SHA-256 from the release digests), unpacks and marks the build. Needs the yes first:
 * `consented` must be true (the pooled model dialog asks with the size, the source and the MIT license).
 * @returns {Promise<{ rpc: string, server: string, dir: string, tag: string }>}
 */
export async function installBuild(home, key, { consented, fetchImpl, onProgress, signal } = {}) {
  if (consented !== true) throw Object.assign(new Error('installing llama.cpp needs a yes'), { code: 'needs_consent' });
  const files = RELEASE.platforms[key];
  if (!files) throw Object.assign(new Error(`no llama.cpp build for ${key}`), { code: 'no_build' });
  const dir = buildDir(home, key);
  const have = installed(home, key);
  if (have) return { ...have, dir, tag: RELEASE.tag };
  fs.mkdirSync(dir, { recursive: true });
  const dl = path.join(dir, 'download');
  for (const f of files) {
    await downloadModel({ id: `llama:${f.name}`, name: f.name, files: [{ file: f.name, bytes: f.bytes, sha256: f.sha256, url: f.url }], bytes: f.bytes }, { home, dir: dl, fetchImpl, onProgress, signal });
    await unpack(path.join(dl, f.name), dir);
  }
  const bins = findBinaries(dir);
  if (!bins) throw Object.assign(new Error('the llama.cpp archive has no rpc-server or llama-server'), { code: 'bad_build' });
  fs.writeFileSync(path.join(dir, '.verified'), JSON.stringify({ tag: RELEASE.tag, files: files.map((f) => ({ name: f.name, sha256: f.sha256 })) }));
  fs.rmSync(dl, { recursive: true, force: true });
  return { ...bins, dir, tag: RELEASE.tag };
}
