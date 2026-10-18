// Auto update: versions, the signed manifest, the check, the download with resume, staging, the swap,
// the rollback and the guard, on fake installs with Windows style and POSIX style layouts. No network.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { compareVersions, isNewer, fitsChannel, parseVersion } from '../../desktop/update/version.js';
import { signManifest, verifyManifest, buildManifest, rawPublicKey, notesFor, SIGN_CONTEXT } from '../../desktop/update/manifest.js';
import { downloadFile } from '../../desktop/update/download.js';
import { extractZip } from '../../desktop/zip.js';
import { extractTarGz } from '../../desktop/update/tar.js';
import { detectInstall, canSelfUpdate } from '../../desktop/update/layout.js';
import { stage, commit, rollback, markHealthy, readState, currentVersion, writeHealth, launchCommand } from '../../desktop/update/apply.js';
import { runGuard } from '../../desktop/update/guard.js';
import { fetchManifest, evaluate, UpdateService, STABLE_BASE, RELEASES_API } from '../../desktop/update/service.js';
import { UPDATE_PUBLIC_KEY } from '../../desktop/update/pubkey.js';
import { makeZip, makeTarGz, fakeFetch } from './fixtures.js';

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const keys = () => {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' });
  return { pem, pub: rawPublicKey(pem) };
};
const NOTES = { en: 'New things.', 'pt-BR': 'Novidades.' };

let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hivedesk-update-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('versions', () => {
  it('compares by the semantic versioning rules', () => {
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.1', '1.0.0')).toBe(1);
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1);
    expect(compareVersions('2.0.0', '10.0.0')).toBe(-1);
    expect(compareVersions('1.1.0-beta.1', '1.1.0')).toBe(-1);
    expect(compareVersions('1.1.0-beta.2', '1.1.0-beta.10')).toBe(-1);
    expect(compareVersions('1.1.0-beta.2', '1.1.0-alpha.9')).toBe(1);
    expect(compareVersions('1.1.0-beta', '1.1.0-beta.1')).toBe(-1);
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('nonsense', '0.0.1')).toBe(-1);
    expect(isNewer('1.0.1', '1.0.0')).toBe(true);
    expect(isNewer('1.0.0', '1.0.0')).toBe(false);
    expect(parseVersion('1.2')).toBe(null);
  });
  it('keeps pre-releases on the beta channel', () => {
    expect(fitsChannel('1.1.0', 'stable')).toBe(true);
    expect(fitsChannel('1.1.0-beta.1', 'stable')).toBe(false);
    expect(fitsChannel('1.1.0-beta.1', 'beta')).toBe(true);
  });
});

function manifestFor(version, files, extra = {}) {
  return buildManifest({ version, notes: NOTES, files, date: '2026-10-17T00:00:00.000Z', ...extra });
}

describe('manifest signature', () => {
  const k = keys();
  const m = manifestFor('1.1.0', { 'hivedesk-windows-x64.zip': { size: 10, sha256: 'a'.repeat(64) } });
  const bytes = Buffer.from(JSON.stringify(m, null, 2));

  it('accepts a good signature', () => {
    const sig = signManifest(bytes, k.pem);
    const v = verifyManifest(bytes, sig, k.pub);
    expect(v.version).toBe('1.1.0');
    expect(v.assets['windows-x64'].url).toBe('https://github.com/kwy404/hivedesk/releases/download/v1.1.0/hivedesk-windows-x64.zip');
  });
  it('rejects a signature made by another key', () => {
    const other = keys();
    expect(() => verifyManifest(bytes, signManifest(bytes, other.pem), k.pub)).toThrow(expect.objectContaining({ code: 'bad_signature' }));
  });
  it('rejects a tampered manifest', () => {
    const sig = signManifest(bytes, k.pem);
    const evil = Buffer.from(bytes.toString('utf8').replace('a'.repeat(64), 'b'.repeat(64)));
    expect(() => verifyManifest(evil, sig, k.pub)).toThrow(expect.objectContaining({ code: 'bad_signature' }));
    const flipped = Buffer.from(sig, 'base64');
    flipped[5] ^= 1;
    expect(() => verifyManifest(bytes, flipped.toString('base64'), k.pub)).toThrow(expect.objectContaining({ code: 'bad_signature' }));
  });
  it('rejects a missing or malformed signature', () => {
    expect(() => verifyManifest(bytes, '', k.pub)).toThrow(expect.objectContaining({ code: 'bad_signature' }));
    expect(() => verifyManifest(bytes, 'abc', k.pub)).toThrow(expect.objectContaining({ code: 'bad_signature' }));
  });
  it('signs with a context, so a plain signature of the bytes does not pass', () => {
    const plain = crypto.sign(null, bytes, crypto.createPrivateKey(k.pem)).toString('base64');
    expect(() => verifyManifest(bytes, plain, k.pub)).toThrow(expect.objectContaining({ code: 'bad_signature' }));
    expect(SIGN_CONTEXT).toMatch(/hivedesk/);
  });
  it('rejects a signed manifest whose assets point outside the hivedesk releases', () => {
    const bad = JSON.parse(bytes);
    bad.assets['windows-x64'].url = 'https://example.org/evil.zip';
    const b = Buffer.from(JSON.stringify(bad));
    expect(() => verifyManifest(b, signManifest(b, k.pem), k.pub)).toThrow(expect.objectContaining({ code: 'bad_manifest' }));
  });
  it('marks pre-releases as beta and picks the notes by language', () => {
    expect(manifestFor('1.2.0-beta.1', { 'hivedesk-windows-x64.zip': { size: 1, sha256: 'c'.repeat(64) } }).channel).toBe('beta');
    expect(notesFor(m, 'pt-BR')).toBe('Novidades.');
    expect(notesFor(m, 'pt-PT')).toBe('Novidades.');
    expect(notesFor(m, 'ja')).toBe('New things.');
  });
  it('embeds a real 32 byte public key in the app', () => {
    expect(Buffer.from(UPDATE_PUBLIC_KEY, 'base64').length).toBe(32);
  });
});

describe('the update check', () => {
  const k = keys();
  const install = { kind: 'versioned', asset: 'windows-x64', root: '/x', stateFile: '/x/s.json' };
  const publish = (m) => {
    const bytes = Buffer.from(JSON.stringify(m));
    return { bytes, sig: Buffer.from(signManifest(bytes, k.pem)) };
  };

  it('reads latest.json of the latest release on the stable channel', async () => {
    const m = manifestFor('1.1.0', { 'hivedesk-windows-x64.zip': { size: 5, sha256: 'd'.repeat(64) } });
    const p = publish(m);
    const f = fakeFetch({ [`${STABLE_BASE}/latest.json`]: p.bytes, [`${STABLE_BASE}/latest.json.sig`]: p.sig });
    const got = await fetchManifest({ channel: 'stable', fetchImpl: f, publicKey: k.pub });
    expect(got.version).toBe('1.1.0');
    expect(evaluate(got, { version: '1.0.0', channel: 'stable', install }).status).toBe('available');
    expect(evaluate(got, { version: '1.1.0', channel: 'stable', install }).status).toBe('current');
    expect(evaluate(got, { version: '1.2.0', channel: 'stable', install }).status).toBe('current');
  });
  it('picks the newest release with a manifest on the beta channel', async () => {
    const m = manifestFor('1.2.0-beta.2', { 'hivedesk-windows-x64.zip': { size: 5, sha256: 'e'.repeat(64) } }, { tag: 'v1.2.0-beta.2' });
    const p = publish(m);
    const assets = [{ name: 'latest.json' }, { name: 'latest.json.sig' }];
    const list = [
      { tag_name: 'v1.1.0', assets },
      { tag_name: 'v1.2.0-beta.2', prerelease: true, assets },
      { tag_name: 'v1.3.0', draft: true, assets },
      { tag_name: 'v1.2.5', assets: [] }
    ];
    const base = 'https://github.com/kwy404/hivedesk/releases/download/v1.2.0-beta.2';
    const f = fakeFetch({ [RELEASES_API]: Buffer.from(JSON.stringify(list)), [`${base}/latest.json`]: p.bytes, [`${base}/latest.json.sig`]: p.sig });
    const got = await fetchManifest({ channel: 'beta', fetchImpl: f, publicKey: k.pub });
    expect(got.version).toBe('1.2.0-beta.2');
    expect(evaluate(got, { version: '1.1.0', channel: 'beta', install }).status).toBe('available');
    expect(evaluate(got, { version: '1.1.0', channel: 'stable', install }).status).toBe('current');
  });
  it('gives a notice to installs that cannot update themselves, and respects the snooze and failed versions', () => {
    const m = manifestFor('1.1.0', { 'hivedesk-windows-x64.zip': { size: 5, sha256: 'd'.repeat(64) } });
    expect(evaluate(m, { version: '1.0.0', channel: 'stable', install: { kind: 'npx', asset: null } }).status).toBe('notice');
    const snoozed = evaluate(m, { version: '1.0.0', channel: 'stable', install, prefs: { snoozedVersion: '1.1.0', snoozedUntil: Date.now() + 1000 } });
    expect(snoozed.snoozed).toBe(true);
    expect(evaluate(m, { version: '1.0.0', channel: 'stable', install, prefs: { snoozedVersion: '1.1.0', snoozedUntil: Date.now() + 1000 }, manual: true }).snoozed).toBe(false);
    expect(evaluate(m, { version: '1.0.0', channel: 'stable', install, prefs: { failed: ['1.1.0'] } }).status).toBe('current');
  });
});

describe('download with resume', () => {
  const data = crypto.randomBytes(25000);
  const url = 'https://github.com/kwy404/hivedesk/releases/download/v1.1.0/hivedesk-windows-x64.zip';

  it('downloads and checks the SHA-256', async () => {
    const dest = path.join(tmp, 'a.zip');
    const r = await downloadFile({ url, dest, size: data.length, sha256: sha(data), fetchImpl: fakeFetch({ [url]: data }) });
    expect(r.downloaded).toBe(data.length);
    expect(fs.readFileSync(dest).equals(data)).toBe(true);
  });
  it('rejects and deletes a file whose SHA-256 does not match', async () => {
    const dest = path.join(tmp, 'b.zip');
    await expect(downloadFile({ url, dest, size: data.length, sha256: 'f'.repeat(64), fetchImpl: fakeFetch({ [url]: data }) }))
      .rejects.toMatchObject({ code: 'checksum' });
    expect(fs.existsSync(dest)).toBe(false);
    expect(fs.existsSync(`${dest}.part`)).toBe(false);
  });
  it('rejects a file larger than the manifest says', async () => {
    const dest = path.join(tmp, 'c.zip');
    await expect(downloadFile({ url, dest, size: 100, sha256: sha(data), fetchImpl: fakeFetch({ [url]: data }) })).rejects.toMatchObject({ code: 'too_big' });
  });
  it('resumes an interrupted download with a Range request', async () => {
    const dest = path.join(tmp, 'd.zip');
    await expect(downloadFile({ url, dest, size: data.length, sha256: sha(data), fetchImpl: fakeFetch({ [url]: data }, { failAfter: 12000 }) })).rejects.toThrow('connection reset');
    expect(fs.statSync(`${dest}.part`).size).toBe(12000);
    const f = fakeFetch({ [url]: data });
    const r = await downloadFile({ url, dest, size: data.length, sha256: sha(data), fetchImpl: f });
    expect(f.calls[0].range).toBe('bytes=12000-');
    expect(r.resumed).toBe(12000);
    expect(r.downloaded).toBe(data.length - 12000);
    expect(fs.readFileSync(dest).equals(data)).toBe(true);
  });
  it('starts over when the server ignores the Range header', async () => {
    const dest = path.join(tmp, 'e.zip');
    fs.writeFileSync(`${dest}.part`, data.subarray(0, 5000));
    const r = await downloadFile({ url, dest, size: data.length, sha256: sha(data), fetchImpl: fakeFetch({ [url]: data }, { ignoreRange: true }) });
    expect(r.resumed).toBe(0);
    expect(fs.readFileSync(dest).equals(data)).toBe(true);
  });
  it('catches a corrupt partial file at the end, after resuming', async () => {
    const dest = path.join(tmp, 'f.zip');
    const bad = Buffer.from(data.subarray(0, 5000));
    bad[10] ^= 0xff;
    fs.writeFileSync(`${dest}.part`, bad);
    await expect(downloadFile({ url, dest, size: data.length, sha256: sha(data), fetchImpl: fakeFetch({ [url]: data }) })).rejects.toMatchObject({ code: 'checksum' });
    expect(fs.existsSync(`${dest}.part`)).toBe(false);
  });
});

describe('archives', () => {
  it('extracts a zip with modes and links, dropping the top folder', () => {
    const zip = makeZip({ 'hivedesk/app/a.txt': 'A', 'hivedesk/node/bin/node': { data: 'bin', mode: 0o755 }, 'hivedesk/link': { link: 'app/a.txt' } });
    const n = extractZip(zip, tmp, { strip: 1 });
    expect(n).toBe(3);
    expect(fs.readFileSync(path.join(tmp, 'app', 'a.txt'), 'utf8')).toBe('A');
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.join(tmp, 'node', 'bin', 'node')).mode & 0o777).toBe(0o755);
      expect(fs.readlinkSync(path.join(tmp, 'link'))).toBe('app/a.txt');
    }
  });
  it('refuses entries and links that leave the folder', () => {
    expect(() => extractZip(makeZip({ '../evil.txt': 'x' }), tmp)).toThrow(/unsafe/);
    expect(() => extractZip(makeZip({ 'C:/evil.txt': 'x' }), tmp)).toThrow(/unsafe/);
    expect(() => extractTarGz(makeTarGz({ 'hivedesk/../../evil': 'x' }), tmp, { strip: 1 })).toThrow(/unsafe/);
    if (process.platform !== 'win32') expect(() => extractTarGz(makeTarGz({ 'hivedesk/l': { link: '../../etc/passwd' } }), tmp, { strip: 1 })).toThrow(/unsafe link/);
  });
  it('extracts a tar.gz with modes', () => {
    const n = extractTarGz(makeTarGz({ 'hivedesk/': '', 'hivedesk/app/x.js': 'x', 'hivedesk/hivedesk': { data: '#!/bin/sh', mode: 0o755 } }), tmp, { strip: 1 });
    expect(n).toBe(2);
    expect(fs.readFileSync(path.join(tmp, 'app', 'x.js'), 'utf8')).toBe('x');
    if (process.platform !== 'win32') expect(fs.statSync(path.join(tmp, 'hivedesk')).mode & 0o777).toBe(0o755);
  });
});

// Fake installs.
const winPackage = (v) => ({
  [`hivedesk/hivedesk.exe`]: `launcher ${v}`, [`hivedesk/node/node.exe`]: 'node', [`hivedesk/app/desktop/main.js`]: `// ${v}`, [`hivedesk/app/package.json`]: JSON.stringify({ version: v })
});
const posixPackage = (v) => ({
  [`hivedesk/hivedesk`]: { data: `#!/bin/sh\n# ${v}`, mode: 0o755 }, [`hivedesk/node/bin/node`]: { data: 'node', mode: 0o755 }, [`hivedesk/app/desktop/main.js`]: `// ${v}`
});

function versionedInstall(root, version, platform) {
  const dir = path.join(root, 'versions', version);
  if (platform === 'win32') {
    extractZip(makeZip(winPackage(version)), dir, { strip: 1 });
    fs.copyFileSync(path.join(dir, 'hivedesk.exe'), path.join(root, 'hivedesk.exe'));
  } else {
    extractTarGz(makeTarGz(posixPackage(version)), dir, { strip: 1 });
    fs.copyFileSync(path.join(dir, 'hivedesk'), path.join(root, 'hivedesk'));
  }
  fs.writeFileSync(path.join(root, 'current.txt'), `${version}\n`);
  return detectInstall({ desktopDir: path.join(dir, 'app', 'desktop'), home: path.join(root, 'home'), platform, env: {} });
}

describe('install layouts', () => {
  it('detects each kind', () => {
    const root = path.join(tmp, 'Programs', 'hivedesk');
    const w = versionedInstall(root, '1.0.0', 'win32');
    expect(w).toMatchObject({ kind: 'versioned', asset: 'windows-x64', root });
    expect(canSelfUpdate(w)).toBe(true);
    const mac = detectInstall({ desktopDir: '/Applications/hivedesk.app/Contents/Resources/app/desktop', home: tmp, platform: 'darwin', env: {} });
    expect(mac).toMatchObject({ kind: 'mac-app', bundle: path.resolve('/Applications/hivedesk.app'), asset: 'macos-universal' });
    const img = path.join(tmp, 'hivedesk.AppImage');
    fs.writeFileSync(img, 'x');
    expect(detectInstall({ desktopDir: '/tmp/.mount_x/usr/lib/hivedesk/app/desktop', home: tmp, platform: 'linux', env: { APPIMAGE: img } }).kind).toBe('appimage');
    expect(detectInstall({ desktopDir: '/opt/hivedesk/app/desktop', home: tmp, platform: 'linux', env: {} }).kind).toBe('package');
    expect(detectInstall({ desktopDir: path.join(tmp, 'unzipped', 'hivedesk', 'app', 'desktop'), home: tmp, platform: 'win32', env: { HIVEDESK_DESKTOP: '1' } }).kind).toBe('portable');
    expect(detectInstall({ desktopDir: path.join(tmp, 'node_modules', 'hivedesk', 'desktop'), home: tmp, platform: 'linux', env: {} }).kind).toBe('npx');
  });
});

for (const platform of ['win32', 'linux']) {
  const style = platform === 'win32' ? 'Windows style' : 'POSIX style';
  describe(`apply and rollback, ${style} versioned layout`, () => {
    let root;
    let install;
    let pkgFile;
    beforeEach(() => {
      root = path.join(tmp, 'hivedesk');
      install = versionedInstall(root, '1.0.0', platform);
      pkgFile = path.join(tmp, platform === 'win32' ? 'pkg.zip' : 'pkg.tar.gz');
      fs.writeFileSync(pkgFile, platform === 'win32' ? makeZip(winPackage('1.1.0')) : makeTarGz(posixPackage('1.1.0')));
    });

    it('stages beside the running version, then swaps the pointer', () => {
      stage(install, { version: '1.1.0', file: pkgFile, platform });
      expect(currentVersion(install)).toBe('1.0.0');
      expect(fs.existsSync(path.join(root, 'versions', '1.1.0', 'app', 'desktop', 'main.js'))).toBe(true);
      expect(fs.readdirSync(path.join(root, 'versions')).sort()).toEqual(['1.0.0', '1.1.0']);
      commit(install, '1.1.0');
      expect(currentVersion(install)).toBe('1.1.0');
      expect(readState(install)).toMatchObject({ state: 'trial', version: '1.1.0', previous: '1.0.0' });
    });
    it('keeps one previous version and swaps the root launcher once healthy', () => {
      stage(install, { version: '1.1.0', file: pkgFile, platform });
      commit(install, '1.1.0');
      fs.mkdirSync(path.join(root, 'versions', '0.9.0'));
      const calls = [];
      fs.writeFileSync(path.join(root, 'uninstall.exe'), 'u');
      expect(markHealthy(install, '1.1.0', { platform, exec: (c, a) => calls.push([c, ...a]) })).toBe(true);
      expect(fs.readdirSync(path.join(root, 'versions')).sort()).toEqual(['1.0.0', '1.1.0']);
      const launcher = platform === 'win32' ? 'hivedesk.exe' : 'hivedesk';
      expect(fs.readFileSync(path.join(root, launcher), 'utf8')).toContain('1.1.0');
      expect(readState(install).state).toBe('ok');
      if (platform === 'win32') expect(calls[0]).toEqual(expect.arrayContaining(['reg', 'DisplayVersion', '1.1.0']));
      else expect(calls).toEqual([]);
    });
    it('rolls back to the previous version and deletes the failed one', () => {
      stage(install, { version: '1.1.0', file: pkgFile, platform });
      commit(install, '1.1.0');
      rollback(install);
      expect(currentVersion(install)).toBe('1.0.0');
      expect(fs.existsSync(path.join(root, 'versions', '1.1.0'))).toBe(false);
      expect(readState(install)).toMatchObject({ state: 'rolledBack', failed: '1.1.0' });
    });
    it('refuses a package without the app or without Node, and leaves the install as it was', () => {
      const broken = path.join(tmp, platform === 'win32' ? 'broken.zip' : 'broken.tar.gz');
      const files = platform === 'win32' ? winPackage('1.1.0') : posixPackage('1.1.0');
      delete files[platform === 'win32' ? 'hivedesk/node/node.exe' : 'hivedesk/node/bin/node'];
      fs.writeFileSync(broken, platform === 'win32' ? makeZip(files) : makeTarGz(files));
      expect(() => stage(install, { version: '1.1.0', file: broken, platform })).toThrow(/Node runtime/);
      expect(currentVersion(install)).toBe('1.0.0');
      expect(() => commit(install, '1.1.0')).toThrow(/not staged/);
    });
    it('the guard keeps a healthy update', async () => {
      stage(install, { version: '1.1.0', file: pkgFile, platform });
      const home = path.join(tmp, 'home');
      const starts = [];
      const r = await runGuard({
        install, version: '1.1.0', home, platform, pollMs: 5, timeoutMs: 2000,
        start: (cmd, args, env) => {
          starts.push({ cmd, trial: env.HIVEDESK_UPDATE_TRIAL });
          setTimeout(() => writeHealth(home, '1.1.0'), 30);
          return Object.assign(new EventEmitter(), { kill() {} });
        }
      });
      expect(r.ok).toBe(true);
      expect(starts).toEqual([{ cmd: launchCommand(install, platform).cmd, trial: '1.1.0' }]);
      expect(currentVersion(install)).toBe('1.1.0');
      expect(readState(install).state).toBe('ok');
    });
    it('the guard rolls back when the new version exits before it is healthy', async () => {
      stage(install, { version: '1.1.0', file: pkgFile, platform });
      const home = path.join(tmp, 'home');
      const starts = [];
      const r = await runGuard({
        install, version: '1.1.0', home, platform, pollMs: 5, timeoutMs: 2000,
        start: (cmd, args, env) => {
          starts.push(env.HIVEDESK_UPDATE_ROLLED_BACK || 'trial');
          const child = Object.assign(new EventEmitter(), { kill() {} });
          if (starts.length === 1) setTimeout(() => child.emit('exit', 1), 20);
          return child;
        }
      });
      expect(r).toMatchObject({ ok: false, rolledBack: true });
      expect(starts).toEqual(['trial', '1.1.0']);
      expect(currentVersion(install)).toBe('1.0.0');
      expect(readState(install)).toMatchObject({ state: 'rolledBack', failed: '1.1.0' });
    });
    it('the guard rolls back when no health mark comes in time', async () => {
      stage(install, { version: '1.1.0', file: pkgFile, platform });
      let killed = 0;
      const r = await runGuard({
        install, version: '1.1.0', home: path.join(tmp, 'home'), platform, pollMs: 5, timeoutMs: 80,
        start: () => Object.assign(new EventEmitter(), { kill() { killed++; } })
      });
      expect(r).toMatchObject({ ok: false, reason: 'timeout' });
      expect(killed).toBe(1);
      expect(currentVersion(install)).toBe('1.0.0');
    });
  });
}

describe('apply and rollback, macOS bundle and AppImage', () => {
  it('replaces the .app bundle and puts it back on rollback', () => {
    const apps = path.join(tmp, 'Applications');
    const bundle = path.join(apps, 'hivedesk.app');
    fs.mkdirSync(path.join(bundle, 'Contents', 'MacOS'), { recursive: true });
    fs.writeFileSync(path.join(bundle, 'Contents', 'Info.plist'), '1.0.0');
    const install = { kind: 'mac-app', bundle, asset: 'macos-universal', stateFile: path.join(tmp, 'state.json') };
    const zip = path.join(tmp, 'mac.zip');
    fs.writeFileSync(zip, makeZip({
      'hivedesk.app/Contents/Info.plist': '1.1.0',
      'hivedesk.app/Contents/MacOS/hivedesk': { data: '#!/bin/sh', mode: 0o755 },
      'hivedesk.app/Contents/Resources/app/desktop/main.js': '//'
    }));
    stage(install, { version: '1.1.0', file: zip });
    expect(fs.readFileSync(path.join(bundle, 'Contents', 'Info.plist'), 'utf8')).toBe('1.0.0');
    commit(install, '1.1.0');
    expect(fs.readFileSync(path.join(bundle, 'Contents', 'Info.plist'), 'utf8')).toBe('1.1.0');
    expect(fs.readdirSync(apps).sort()).toEqual(['.hivedesk-previous.app', 'hivedesk.app']);
    rollback(install);
    expect(fs.readFileSync(path.join(bundle, 'Contents', 'Info.plist'), 'utf8')).toBe('1.0.0');
    expect(fs.readdirSync(apps)).toEqual(['hivedesk.app']);
  });
  it('drops the old bundle once the new one is healthy', () => {
    const apps = path.join(tmp, 'Applications');
    const bundle = path.join(apps, 'hivedesk.app');
    fs.mkdirSync(path.join(bundle, 'Contents'), { recursive: true });
    const install = { kind: 'mac-app', bundle, asset: 'macos-universal', stateFile: path.join(tmp, 'state.json') };
    const zip = path.join(tmp, 'mac.zip');
    fs.writeFileSync(zip, makeZip({ 'hivedesk.app/Contents/Info.plist': 'x', 'hivedesk.app/Contents/MacOS/hivedesk': 'x', 'hivedesk.app/Contents/Resources/app/desktop/main.js': 'x' }));
    stage(install, { version: '1.1.0', file: zip });
    commit(install, '1.1.0');
    markHealthy(install, '1.1.0');
    expect(fs.readdirSync(apps)).toEqual(['hivedesk.app']);
  });
  it('replaces the AppImage file and puts it back on rollback', () => {
    const img = path.join(tmp, 'hivedesk.AppImage');
    fs.writeFileSync(img, Buffer.concat([Buffer.from('\x7fELF', 'latin1'), Buffer.from('old')]));
    const install = { kind: 'appimage', appimage: img, asset: 'linux-x64-appimage', stateFile: path.join(tmp, 'state.json') };
    const next = path.join(tmp, 'download.AppImage');
    fs.writeFileSync(next, Buffer.concat([Buffer.from('\x7fELF', 'latin1'), Buffer.from('new')]));
    stage(install, { version: '1.1.0', file: next });
    commit(install, '1.1.0');
    expect(fs.readFileSync(img, 'latin1')).toContain('new');
    rollback(install);
    expect(fs.readFileSync(img, 'latin1')).toContain('old');
    const notElf = path.join(tmp, 'x.AppImage');
    fs.writeFileSync(notElf, 'nope');
    expect(() => stage(install, { version: '1.2.0', file: notElf })).toThrow(/not an AppImage/);
  });
});

describe('the update service', () => {
  it('checks, downloads in the background, stages, and restarts through the guard', async () => {
    const k = keys();
    const root = path.join(tmp, 'hivedesk');
    const install = versionedInstall(root, '1.0.0', 'win32');
    const pkg = makeZip(winPackage('1.1.0'));
    const m = manifestFor('1.1.0', { 'hivedesk-windows-x64.zip': { size: pkg.length, sha256: sha(pkg) } });
    const bytes = Buffer.from(JSON.stringify(m));
    const f = fakeFetch({
      [`${STABLE_BASE}/latest.json`]: bytes,
      [`${STABLE_BASE}/latest.json.sig`]: Buffer.from(signManifest(bytes, k.pem)),
      [m.assets['windows-x64'].url]: pkg
    });
    const spawned = [];
    let quit = 0;
    const svc = new UpdateService({
      home: path.join(tmp, 'home'), version: '1.0.0', locale: 'pt-BR', install, fetchImpl: f, publicKey: k.pub, platform: 'win32', env: {},
      spawnImpl: (cmd, args) => { spawned.push(args); return { unref() {}, on() {} }; }, requestQuit: () => { quit++; }
    });
    const s = await svc.check({ manual: false });
    expect(s).toMatchObject({ status: 'available', version: '1.1.0', notes: 'Novidades.', kind: 'versioned' });
    await svc.busy;
    expect(svc.state().status).toBe('ready');
    expect(fs.existsSync(path.join(root, 'versions', '1.1.0', 'app', 'desktop', 'main.js'))).toBe(true);
    expect(currentVersion(install)).toBe('1.0.0');
    svc.onClose();
    expect(svc.applyOnQuit()).toBe(true);
    const plan = JSON.parse(fs.readFileSync(spawned[0][1], 'utf8'));
    expect(spawned[0][0]).toMatch(/guard\.js$/);
    expect(plan).toMatchObject({ version: '1.1.0', waitPid: process.pid });
    svc.set({ when: 'now' });
    await svc.updateNow();
    expect(quit).toBe(1);
  });
  it('rejects a manifest signed by another key and says so on a manual check', async () => {
    const k = keys();
    const other = keys();
    const m = manifestFor('1.1.0', { 'hivedesk-windows-x64.zip': { size: 5, sha256: 'd'.repeat(64) } });
    const bytes = Buffer.from(JSON.stringify(m));
    const f = fakeFetch({ [`${STABLE_BASE}/latest.json`]: bytes, [`${STABLE_BASE}/latest.json.sig`]: Buffer.from(signManifest(bytes, other.pem)) });
    const svc = new UpdateService({ home: tmp, version: '1.0.0', install: { kind: 'versioned', asset: 'windows-x64', root: tmp, stateFile: path.join(tmp, 's.json') }, fetchImpl: f, publicKey: k.pub, env: {} });
    expect(await svc.check({ manual: true })).toMatchObject({ status: 'error', error: 'signature' });
  });
  it('tells npx users the command, and keeps the settings', async () => {
    const k = keys();
    const m = manifestFor('1.1.0', { 'hivedesk-windows-x64.zip': { size: 5, sha256: 'd'.repeat(64) } });
    const bytes = Buffer.from(JSON.stringify(m));
    const f = fakeFetch({ [`${STABLE_BASE}/latest.json`]: bytes, [`${STABLE_BASE}/latest.json.sig`]: Buffer.from(signManifest(bytes, k.pem)) });
    const svc = new UpdateService({ home: tmp, version: '1.0.0', install: { kind: 'npx', asset: null, stateFile: path.join(tmp, 's.json') }, fetchImpl: f, publicKey: k.pub, env: {} });
    const notices = [];
    svc.on('notice', (n) => notices.push(n));
    expect(await svc.check()).toMatchObject({ status: 'notice', command: 'npx hivedesk@latest' });
    await svc.check();
    expect(notices.length).toBe(1);
    expect(svc.setSettings({ autoUpdate: false, channel: 'beta' })).toMatchObject({ autoUpdate: false, channel: 'beta' });
    expect(new UpdateService({ home: tmp, version: '1.0.0', install: { kind: 'npx', stateFile: path.join(tmp, 's.json') }, env: {} }).settings()).toEqual({ autoUpdate: false, channel: 'beta' });
    svc.stop();
  });
  it('remembers a rolled back version and does not offer it again', () => {
    const svc = new UpdateService({ home: tmp, version: '1.0.0', install: { kind: 'versioned', asset: 'windows-x64', root: tmp, stateFile: path.join(tmp, 's.json') }, env: { HIVEDESK_UPDATE_ROLLED_BACK: '1.1.0' } });
    expect(svc.state().rolledBack).toBe('1.1.0');
    expect(svc.prefs().failed).toEqual(['1.1.0']);
  });
});
