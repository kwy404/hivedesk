// Downloads one update file to disk with resume (HTTP Range on a .part file) and checks its size and SHA-256.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

function hashFile(file, hash) {
  return new Promise((resolve, reject) => {
    const s = fs.createReadStream(file);
    s.on('data', (c) => hash.update(c));
    s.on('end', resolve);
    s.on('error', reject);
  });
}

export async function sha256File(file) {
  const h = crypto.createHash('sha256');
  await hashFile(file, h);
  return h.digest('hex');
}

/**
 * @param {{ url: string, dest: string, size: number, sha256: string, fetchImpl?: typeof fetch,
 *   onProgress?: (p: { got: number, total: number, resumed: number }) => void, signal?: AbortSignal }} o
 * @returns {Promise<{ path: string, resumed: number, downloaded: number }>}
 *   resumed: bytes kept from an earlier, interrupted download
 */
export async function downloadFile(o) {
  const fetchImpl = o.fetchImpl || globalThis.fetch;
  const part = `${o.dest}.part`;
  fs.mkdirSync(path.dirname(o.dest), { recursive: true });
  // Already done and good.
  if (fs.existsSync(o.dest) && fs.statSync(o.dest).size === o.size && await sha256File(o.dest) === o.sha256) {
    return { path: o.dest, resumed: o.size, downloaded: 0 };
  }
  let have = 0;
  try { have = fs.statSync(part).size; } catch { have = 0; }
  if (have > o.size) { fs.rmSync(part, { force: true }); have = 0; }
  const hash = crypto.createHash('sha256');
  const headers = {};
  if (have > 0 && have < o.size) headers.range = `bytes=${have}-`;
  let res;
  if (have === o.size) res = null;
  else res = await fetchImpl(o.url, { redirect: 'follow', headers, signal: o.signal });
  let resumed = 0;
  if (res) {
    if (res.status === 206 && have > 0) {
      const range = res.headers?.get?.('content-range') || '';
      const m = /bytes (\d+)-/.exec(range);
      if (m && Number(m[1]) !== have) throw fail('http', 'the server resumed at the wrong offset');
      resumed = have;
    } else if (res.status === 200) {
      have = 0;
    } else if (res.status === 416 && have > 0) {
      // Range not satisfiable: start over.
      fs.rmSync(part, { force: true });
      return downloadFile(o);
    } else {
      throw fail('http', `HTTP ${res.status} for ${o.url}`);
    }
  } else {
    resumed = have;
  }
  if (resumed > 0) await hashFile(part, hash);
  if (res) {
    const out = fs.createWriteStream(part, { flags: resumed > 0 ? 'a' : 'w' });
    const done = new Promise((resolve, reject) => { out.on('finish', resolve); out.on('error', reject); });
    let got = resumed;
    try {
      let streamErr = null;
      out.on('error', (e) => { streamErr = e; });
      const write = async (buf) => {
        if (streamErr) throw streamErr;
        if (!out.write(buf)) await new Promise((r) => { out.once('drain', r); out.once('close', r); });
        if (streamErr) throw streamErr;
      };
      if (res.body && typeof res.body.getReader === 'function') {
        const reader = res.body.getReader();
        for (;;) {
          const { done: end, value } = await reader.read();
          if (end) break;
          const buf = Buffer.from(value);
          got += buf.length;
          if (got > o.size) throw fail('too_big', `${o.url} is larger than the manifest says`);
          hash.update(buf);
          await write(buf);
          o.onProgress?.({ got, total: o.size, resumed });
        }
      } else {
        const buf = Buffer.from(await res.arrayBuffer());
        got += buf.length;
        if (got > o.size) throw fail('too_big', `${o.url} is larger than the manifest says`);
        hash.update(buf);
        await write(buf);
        o.onProgress?.({ got, total: o.size, resumed });
      }
    } finally {
      out.end();
      await done.catch(() => {});
    }
    if (got !== o.size) throw fail('incomplete', `got ${got} of ${o.size} bytes`);
  }
  const digest = hash.digest('hex');
  if (digest !== o.sha256) {
    fs.rmSync(part, { force: true });
    throw fail('checksum', 'the downloaded update does not match its SHA-256, so it was deleted');
  }
  fs.rmSync(o.dest, { force: true });
  fs.renameSync(part, o.dest);
  return { path: o.dest, resumed, downloaded: o.size - resumed };
}
