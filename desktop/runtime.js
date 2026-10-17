// Gets the desktop runtime binary for this machine: bundled in a package, cached, or downloaded once.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { target, cacheDir, BINARIES } from './platform.js';
import { extractEntry } from './zip.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

function verifiedFile(file, t) {
  try {
    const buf = fs.readFileSync(file);
    return buf.length === t.bytes && sha256(buf) === t.sha256;
  } catch {
    return false;
  }
}

/** Downloads a URL into memory with progress; checks the size against `expect` when given. */
async function download(url, { fetchImpl, onProgress, expect, signal }) {
  const res = await fetchImpl(url, { redirect: 'follow', signal });
  if (!res.ok) throw fail('http', `HTTP ${res.status} for ${url}`);
  const total = Number(res.headers?.get?.('content-length')) || expect || 0;
  if (!res.body || typeof res.body.getReader !== 'function') {
    const buf = Buffer.from(await res.arrayBuffer());
    onProgress?.(buf.length, total || buf.length);
    return buf;
  }
  const reader = res.body.getReader();
  const parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(Buffer.from(value));
    got += value.length;
    if (expect && got > expect * 2) throw fail('too_big', `${url} is larger than expected`);
    onProgress?.(got, total);
  }
  return Buffer.concat(parts);
}

/**
 * Finds or fetches the runtime binary.
 * Order: HIVEDESK_RUNTIME (a path), the copy bundled in a package (desktop/bin/), the cache
 * (~/.hivedesk/runtime/desktop-<version>/), then a download checked against the pinned SHA-256.
 * @param {{ home: string, key: string, appVersion?: string, env?: object, bundledDir?: string,
 *   fetchImpl?: typeof fetch, onStart?: (t: object) => void, onProgress?: (got: number, total: number) => void,
 *   log?: (line: string) => void, signal?: AbortSignal, target?: object }} o  (target: tests only)
 * @returns {Promise<{ path: string, source: 'env' | 'bundled' | 'cache' | 'download', target: object }>}
 */
export async function ensureRuntime(o) {
  const t = o.target || target(o.key, { appVersion: o.appVersion });
  if (!t) throw fail('unsupported', `no desktop runtime for ${o.key}`);
  const env = o.env || process.env;
  if (env.HIVEDESK_RUNTIME) {
    if (fs.existsSync(env.HIVEDESK_RUNTIME)) return { path: path.resolve(env.HIVEDESK_RUNTIME), source: 'env', target: t };
    throw fail('not_found', `HIVEDESK_RUNTIME points to a missing file: ${env.HIVEDESK_RUNTIME}`);
  }
  const bundledDir = o.bundledDir ?? path.join(HERE, 'bin');
  for (const name of [t.localName, t.file]) {
    const p = path.join(bundledDir, name);
    // The macOS package bundles the universal binary, which runs on both CPUs.
    const ok = verifiedFile(p, t) || (t.os === 'macos' && !o.target && verifiedFile(p, BINARIES.mac_universal));
    if (fs.existsSync(p) && ok) return { path: p, source: 'bundled', target: t };
  }
  const dir = cacheDir(o.home);
  const cached = path.join(dir, t.localName);
  if (fs.existsSync(cached) && verifiedFile(cached, t)) return { path: cached, source: 'cache', target: t };

  const fetchImpl = o.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw fail('download_failed', 'this Node version has no fetch');
  o.onStart?.(t);
  const errors = [];
  for (const src of t.sources) {
    try {
      let bin;
      if (src.kind === 'file') {
        bin = await download(src.url, { fetchImpl, onProgress: o.onProgress, expect: t.bytes, signal: o.signal });
      } else {
        const zip = await download(src.url, { fetchImpl, onProgress: o.onProgress, expect: src.bytes, signal: o.signal });
        if (sha256(zip) !== src.sha256) throw fail('checksum', 'the runtime archive does not match its published checksum');
        bin = extractEntry(zip, src.entry);
        if (!bin) throw fail('bad_zip', `${src.entry} is not in the archive`);
      }
      if (bin.length !== t.bytes || sha256(bin) !== t.sha256) throw fail('checksum', 'the runtime does not match its pinned checksum');
      fs.mkdirSync(dir, { recursive: true });
      const part = `${cached}.${process.pid}.part`;
      fs.writeFileSync(part, bin, { mode: 0o755 });
      fs.renameSync(part, cached);
      try { fs.chmodSync(cached, 0o755); } catch { /* Windows */ }
      return { path: cached, source: 'download', target: t };
    } catch (err) {
      errors.push(err);
      o.log?.(`desktop runtime: ${src.url}: ${err.message}`);
      if (o.signal?.aborted) break;
    }
  }
  const checksum = errors.find((e) => e.code === 'checksum');
  const last = checksum || errors[errors.length - 1];
  throw fail(checksum ? 'checksum' : 'download_failed', last ? last.message : 'download failed');
}
