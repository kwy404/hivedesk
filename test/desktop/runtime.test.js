// The desktop runtime: platform matrix, download with checksum, zip fallback, cache hit. No network.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { platformKey, target, TARGETS, BINARIES, cacheDir } from '../../desktop/platform.js';
import { ensureRuntime, sha256 } from '../../desktop/runtime.js';
import { extractEntry } from '../../desktop/zip.js';

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** A real zip (deflated entries) built in memory. */
function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const comp = zlib.deflateRawSync(data);
    const nameBuf = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc32(data), 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameBuf.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc32(data), 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, nameBuf, comp);
    centrals.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** A fetch stub: url -> Buffer | number (HTTP status) | Error. Records the calls. */
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const r = routes[url];
    if (r instanceof Error) throw r;
    if (typeof r === 'number' || r === undefined) return { ok: false, status: r || 404, headers: new Map() };
    return {
      ok: true, status: 200, headers: { get: (h) => (h === 'content-length' ? String(r.length) : null) },
      body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(r.subarray(0, 3))); c.enqueue(new Uint8Array(r.subarray(3))); c.close(); } })
    };
  };
  fn.calls = calls;
  return fn;
}

describe('platform matrix', () => {
  it('maps every supported OS and CPU to a runtime binary', () => {
    expect(platformKey('win32', 'x64')).toBe('win-x64');
    expect(platformKey('win32', 'arm64')).toBe('win-arm64');
    expect(platformKey('darwin', 'x64')).toBe('mac-x64');
    expect(platformKey('darwin', 'arm64')).toBe('mac-arm64');
    expect(platformKey('linux', 'x64')).toBe('linux-x64');
    expect(platformKey('linux', 'arm64')).toBe('linux-arm64');
    expect(platformKey('linux', 'arm')).toBe('linux-arm');
    expect(target('win-x64').file).toBe('neutralino-win_x64.exe');
    expect(target('win-arm64')).toMatchObject({ file: 'neutralino-win_x64.exe', emulated: true, os: 'windows', arch: 'arm64' });
    expect(target('mac-arm64').file).toBe('neutralino-mac_arm64');
    expect(target('linux-arm64').file).toBe('neutralino-linux_arm64');
  });

  it('says no for systems without a build', () => {
    expect(platformKey('win32', 'ia32')).toBeNull();
    expect(platformKey('freebsd', 'x64')).toBeNull();
    expect(platformKey('aix', 'ppc64')).toBeNull();
    expect(target('freebsd-x64')).toBeNull();
  });

  it('pins a SHA-256 and a size for every binary, and lists the release asset first', () => {
    for (const key of Object.keys(TARGETS)) {
      const t = target(key, { appVersion: '1.2.3' });
      expect(t.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(t.bytes).toBeGreaterThan(1_000_000);
      expect(t.sources[0].url).toBe(`https://github.com/kwy404/hivedesk/releases/download/v1.2.3/${t.asset}`);
      expect(t.sources[1]).toMatchObject({ kind: 'zip', entry: t.file });
    }
    expect(target('win-x64').asset).toBe('hivedesk-runtime-win-x64.exe');
    expect(target('mac-arm64').asset).toBe('hivedesk-runtime-mac-arm64');
    expect(Object.keys(BINARIES)).toContain('mac_universal');
  });
});

describe('ensureRuntime', () => {
  let home;
  let bundled;
  const bin = Buffer.from('fake runtime binary bytes '.repeat(40));
  const zip = makeZip({ 'other-file': Buffer.from('nope'), 'neutralino-test': bin });
  const fakeTarget = (over = {}) => ({
    key: 'win-x64', os: 'windows', arch: 'x64', file: 'neutralino-test', localName: 'hivedesk-runtime.exe',
    sha256: sha256(bin), bytes: bin.length,
    sources: [
      { kind: 'file', url: 'https://example.test/runtime.exe' },
      { kind: 'zip', url: 'https://example.test/all.zip', sha256: sha256(zip), bytes: zip.length, entry: 'neutralino-test' }
    ],
    ...over
  });
  const env = {};

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-rt-'));
    bundled = path.join(home, 'nobundle');
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it('downloads the binary, checks it and caches it; the next run is a cache hit', async () => {
    const fetchImpl = fakeFetch({ 'https://example.test/runtime.exe': bin });
    const seen = [];
    const r = await ensureRuntime({ home, key: 'win-x64', env, bundledDir: bundled, target: fakeTarget(), fetchImpl, onProgress: (g, t) => seen.push([g, t]) });
    expect(r.source).toBe('download');
    expect(r.path).toBe(path.join(cacheDir(home), 'hivedesk-runtime.exe'));
    expect(fs.readFileSync(r.path)).toEqual(bin);
    expect(seen.at(-1)).toEqual([bin.length, bin.length]);
    const again = fakeFetch({});
    const r2 = await ensureRuntime({ home, key: 'win-x64', env, bundledDir: bundled, target: fakeTarget(), fetchImpl: again });
    expect(r2.source).toBe('cache');
    expect(again.calls).toEqual([]);
  });

  it('falls back to the upstream zip when the release asset is missing', async () => {
    const fetchImpl = fakeFetch({ 'https://example.test/runtime.exe': 404, 'https://example.test/all.zip': zip });
    const r = await ensureRuntime({ home, key: 'win-x64', env, bundledDir: bundled, target: fakeTarget(), fetchImpl });
    expect(r.source).toBe('download');
    expect(fetchImpl.calls).toEqual(['https://example.test/runtime.exe', 'https://example.test/all.zip']);
    expect(fs.readFileSync(r.path)).toEqual(bin);
  });

  it('refuses a binary that does not match the pinned checksum and keeps nothing', async () => {
    const evil = Buffer.from(bin);
    evil[5] ^= 0xff;
    const badZip = makeZip({ 'neutralino-test': evil });
    const fetchImpl = fakeFetch({ 'https://example.test/runtime.exe': evil, 'https://example.test/all.zip': badZip });
    await expect(ensureRuntime({ home, key: 'win-x64', env, bundledDir: bundled, target: fakeTarget(), fetchImpl })).rejects.toMatchObject({ code: 'checksum' });
    expect(fs.existsSync(path.join(cacheDir(home), 'hivedesk-runtime.exe'))).toBe(false);
  });

  it('replaces a corrupt cached copy', async () => {
    fs.mkdirSync(cacheDir(home), { recursive: true });
    fs.writeFileSync(path.join(cacheDir(home), 'hivedesk-runtime.exe'), 'truncated');
    const fetchImpl = fakeFetch({ 'https://example.test/runtime.exe': bin });
    const r = await ensureRuntime({ home, key: 'win-x64', env, bundledDir: bundled, target: fakeTarget(), fetchImpl });
    expect(r.source).toBe('download');
  });

  it('reports a network failure as download_failed (the caller falls back to the browser window)', async () => {
    const fetchImpl = fakeFetch({ 'https://example.test/runtime.exe': new Error('ENOTFOUND'), 'https://example.test/all.zip': new Error('ENOTFOUND') });
    await expect(ensureRuntime({ home, key: 'win-x64', env, bundledDir: bundled, target: fakeTarget(), fetchImpl })).rejects.toMatchObject({ code: 'download_failed' });
  });

  it('prefers the copy bundled in a package, and HIVEDESK_RUNTIME over everything', async () => {
    fs.mkdirSync(bundled, { recursive: true });
    fs.writeFileSync(path.join(bundled, 'hivedesk-runtime.exe'), bin);
    const fetchImpl = fakeFetch({});
    const r = await ensureRuntime({ home, key: 'win-x64', env, bundledDir: bundled, target: fakeTarget(), fetchImpl });
    expect(r.source).toBe('bundled');
    const custom = path.join(home, 'my-runtime');
    fs.writeFileSync(custom, 'x');
    const r2 = await ensureRuntime({ home, key: 'win-x64', env: { HIVEDESK_RUNTIME: custom }, bundledDir: bundled, target: fakeTarget(), fetchImpl });
    expect(r2).toMatchObject({ source: 'env', path: custom });
    expect(fetchImpl.calls).toEqual([]);
  });

  it('says unsupported for an unknown platform key', async () => {
    await expect(ensureRuntime({ home, key: 'freebsd-x64', env, fetchImpl: fakeFetch({}) })).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('reads stored and deflated zip entries', () => {
    expect(extractEntry(zip, 'neutralino-test')).toEqual(bin);
    expect(extractEntry(zip, 'missing')).toBeNull();
    expect(() => extractEntry(Buffer.from('not a zip at all, sorry'), 'x')).toThrow(/zip/);
  });
});
