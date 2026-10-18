// Stages, applies and rolls back an update for each install kind (desktop/update/layout.js).
//
// The order is always the same: stage the new version beside the running one (nothing in use changes),
// commit (one atomic rename: the pointer file, the bundle or the AppImage), start the new version in
// trial, and keep the previous one until the new one reports healthy. A failed trial rolls back with the
// same kind of rename. desktop/update/guard.js drives this across the restart.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { extractZip } from '../zip.js';
import { extractTarGz } from './tar.js';
import { POINTER, VERSIONS } from './layout.js';
import { parseVersion } from './version.js';

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** Writes a file through a temporary file and one rename, so a reader sees the old or the new content. */
export function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

export function readState(install) {
  return readJson(install.stateFile) || { state: 'ok' };
}

export function writeState(install, state) {
  writeAtomic(install.stateFile, JSON.stringify({ ...state, at: new Date().toISOString() }, null, 2));
  return state;
}

/** The version the pointer of a versioned install names. */
export function currentVersion(install) {
  try { return fs.readFileSync(path.join(install.root, POINTER), 'utf8').trim(); } catch { return null; }
}

function rename(from, to) {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); return true; } catch { return false; }
}

/** The files every package folder has: the app entry point and a Node runtime. */
export function checkPackageFolder(dir, platform = process.platform) {
  const node = platform === 'win32' ? path.join(dir, 'node', 'node.exe') : path.join(dir, 'node', 'bin', 'node');
  const main = path.join(dir, 'app', 'desktop', 'main.js');
  if (!fs.existsSync(main)) throw fail('bad_package', 'the update has no app/desktop/main.js');
  if (!fs.existsSync(node)) throw fail('bad_package', 'the update has no Node runtime');
  return true;
}

function checkBundle(bundle) {
  for (const rel of ['Contents/Info.plist', 'Contents/MacOS/hivedesk', 'Contents/Resources/app/desktop/main.js']) {
    if (!fs.existsSync(path.join(bundle, ...rel.split('/')))) throw fail('bad_package', `the update bundle has no ${rel}`);
  }
}

const versionName = (v) => {
  if (!parseVersion(v) || /[\\/]/.test(v)) throw fail('bad_version', `bad version ${v}`);
  return String(v);
};

/**
 * Puts the downloaded package next to the running version, verified and complete.
 * @param {object} install from detectInstall
 * @param {{ version: string, file: string, platform?: string }} o file: the verified download
 * @returns {{ staged: string }}
 */
export function stage(install, o) {
  const v = versionName(o.version);
  const platform = o.platform || process.platform;
  if (install.kind === 'versioned') {
    const versions = path.join(install.root, VERSIONS);
    const dir = path.join(versions, v);
    if (currentVersion(install) === v) throw fail('same_version', `${v} is already the current version`);
    const tmp = path.join(versions, `.${v}.staging`);
    rmrf(tmp);
    fs.mkdirSync(tmp, { recursive: true });
    const buf = fs.readFileSync(o.file);
    if (/\.zip$/i.test(o.file)) extractZip(buf, tmp, { strip: 1 });
    else extractTarGz(buf, tmp, { strip: 1 });
    checkPackageFolder(tmp, platform);
    rmrf(dir);
    fs.renameSync(tmp, dir);
    writeState(install, { ...readState(install), staged: v });
    return { staged: dir };
  }
  if (install.kind === 'mac-app') {
    const parent = path.dirname(install.bundle);
    const tmp = path.join(parent, `.hivedesk-${v}.staging`);
    rmrf(tmp);
    try { fs.mkdirSync(tmp, { recursive: true }); } catch (err) { throw fail('not_writable', `${parent} is not writable: ${err.message}`); }
    extractZip(fs.readFileSync(o.file), tmp);
    const bundle = path.join(tmp, 'hivedesk.app');
    checkBundle(bundle);
    writeState(install, { ...readState(install), staged: v, stagedPath: bundle });
    return { staged: bundle };
  }
  if (install.kind === 'appimage') {
    const next = `${install.appimage}.new`;
    if (path.resolve(o.file) !== path.resolve(next)) {
      try { fs.copyFileSync(o.file, next); } catch (err) { throw fail('not_writable', `${path.dirname(next)} is not writable: ${err.message}`); }
    }
    fs.chmodSync(next, 0o755);
    const head = Buffer.alloc(4);
    const fd = fs.openSync(next, 'r');
    try { fs.readSync(fd, head, 0, 4, 0); } finally { fs.closeSync(fd); }
    if (head.toString('latin1') !== '\x7fELF') throw fail('bad_package', 'the update is not an AppImage');
    writeState(install, { ...readState(install), staged: v, stagedPath: next });
    return { staged: next };
  }
  throw fail('unsupported', `a ${install.kind} install is updated outside the app`);
}

/**
 * Switches to the staged version with one rename and records the trial.
 * @returns {{ version: string, previous: string | null }}
 */
export function commit(install, version) {
  const v = versionName(version);
  const st = readState(install);
  if (install.kind === 'versioned') {
    if (!fs.existsSync(path.join(install.root, VERSIONS, v))) throw fail('not_staged', `${v} is not staged`);
    const previous = currentVersion(install);
    writeAtomic(path.join(install.root, POINTER), `${v}\n`);
    writeState(install, { state: 'trial', version: v, previous, starts: 0 });
    return { version: v, previous };
  }
  if (install.kind === 'mac-app' || install.kind === 'appimage') {
    const target = install.kind === 'mac-app' ? install.bundle : install.appimage;
    const staged = st.stagedPath;
    if (!staged || st.staged !== v || !fs.existsSync(staged)) throw fail('not_staged', `${v} is not staged`);
    const previous = install.kind === 'mac-app' ? path.join(path.dirname(target), '.hivedesk-previous.app') : `${target}.previous`;
    rmrf(previous);
    rename(target, previous);
    try {
      rename(staged, target);
    } catch (err) {
      rename(previous, target);
      throw err;
    }
    if (install.kind === 'mac-app') rmrf(path.dirname(staged));
    writeState(install, { state: 'trial', version: v, previous, starts: 0 });
    return { version: v, previous };
  }
  throw fail('unsupported', `a ${install.kind} install is updated outside the app`);
}

/** Puts the previous version back after a failed trial. */
export function rollback(install) {
  const st = readState(install);
  if (st.state !== 'trial') throw fail('no_trial', 'there is no update on trial');
  if (install.kind === 'versioned') {
    if (!st.previous || !fs.existsSync(path.join(install.root, VERSIONS, st.previous))) throw fail('no_previous', 'the previous version is gone');
    writeAtomic(path.join(install.root, POINTER), `${st.previous}\n`);
    rmrf(path.join(install.root, VERSIONS, st.version));
    writeState(install, { state: 'rolledBack', version: st.previous, failed: st.version });
    return { version: st.previous, failed: st.version };
  }
  const target = install.kind === 'mac-app' ? install.bundle : install.appimage;
  if (!st.previous || !fs.existsSync(st.previous)) throw fail('no_previous', 'the previous version is gone');
  const failed = install.kind === 'mac-app' ? path.join(path.dirname(target), '.hivedesk-failed.app') : `${target}.failed`;
  rmrf(failed);
  rename(target, failed);
  rename(st.previous, target);
  rmrf(failed);
  writeState(install, { state: 'rolledBack', failed: st.version });
  return { failed: st.version };
}

/**
 * The new version passed its first launch: end the trial, keep one previous version (versioned installs)
 * or drop it (bundle and AppImage), update the root launcher and the Apps and Features version.
 * @param {{ exec?: (cmd: string, args: string[]) => void, platform?: string }} [o]
 */
export function markHealthy(install, version, o = {}) {
  const st = readState(install);
  if (st.state !== 'trial' || st.version !== version) return false;
  if (install.kind === 'versioned') {
    prune(install, [version, st.previous]);
    refreshLauncher(install, version, o.platform);
    if ((o.platform || process.platform) === 'win32' && fs.existsSync(path.join(install.root, 'uninstall.exe'))) {
      const run = o.exec || ((cmd, args) => execFile(cmd, args, { windowsHide: true }, () => {}));
      run('reg', ['add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\hivedesk', '/v', 'DisplayVersion', '/d', version, '/f']);
    }
  } else if (st.previous) {
    rmrf(st.previous);
  }
  writeState(install, { state: 'ok', version, previous: install.kind === 'versioned' ? st.previous : null });
  return true;
}

/** Removes every version folder except the ones to keep, and staging leftovers. */
export function prune(install, keep) {
  const dir = path.join(install.root, VERSIONS);
  const k = new Set(keep.filter(Boolean));
  const removed = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return removed; }
  for (const name of names) {
    if (k.has(name)) continue;
    if (rmrf(path.join(dir, name))) removed.push(name);
  }
  return removed;
}

/**
 * The root launcher (hivedesk.exe or the hivedesk script next to current.txt) comes from the package. When
 * the new version ships a different one, swap it: a running .exe can be renamed on Windows, not overwritten.
 */
export function refreshLauncher(install, version, platform = process.platform) {
  const name = platform === 'win32' ? 'hivedesk.exe' : 'hivedesk';
  const src = path.join(install.root, VERSIONS, version, name);
  const dst = path.join(install.root, name);
  if (!fs.existsSync(src)) return false;
  try {
    if (fs.existsSync(dst) && fs.readFileSync(dst).equals(fs.readFileSync(src))) return false;
    const old = `${dst}.old`;
    rmrf(old);
    if (fs.existsSync(dst)) fs.renameSync(dst, old);
    fs.copyFileSync(src, dst);
    if (platform !== 'win32') fs.chmodSync(dst, 0o755);
    rmrf(old);
    return true;
  } catch {
    return false;
  }
}

/** How to start an install from outside (the guard after a swap): the root launcher, the bundle or the AppImage. */
export function launchCommand(install, platform = process.platform) {
  if (install.kind === 'versioned') {
    if (platform === 'win32') return { cmd: path.join(install.root, 'hivedesk.exe'), args: [] };
    return { cmd: path.join(install.root, 'hivedesk'), args: [] };
  }
  if (install.kind === 'mac-app') return { cmd: path.join(install.bundle, 'Contents', 'MacOS', 'hivedesk'), args: [] };
  if (install.kind === 'appimage') return { cmd: install.appimage, args: [] };
  return null;
}

/** The first launch health mark: the new version writes it once its window (or browser fallback) is up. */
export function healthFile(home) {
  return path.join(home, 'update', 'health.json');
}

export function writeHealth(home, version, extra = {}) {
  writeAtomic(healthFile(home), JSON.stringify({ version, pid: process.pid, at: Date.now(), ...extra }));
}

export function readHealth(home) {
  return readJson(healthFile(home));
}
