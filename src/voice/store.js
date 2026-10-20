// Where the local voice keeps its files, what the user said yes to, and the download and unpack of
// a package (a whisper model, the whisper.cpp server, Piper, a Piper voice).
//
// <home>/voice/
//   consent.json   { accepted: { "<id>": { at, bytes, sha256: [..] } } }   a yes per exact file set
//   settings.json  { stt: { model, runtime }, tts: { voices: { "<locale>": "<voice id>" } } }
//   models/        ggml-*.bin
//   runtime/<id>/  the unpacked whisper.cpp server or Piper
//   voices/        Piper .onnx and .onnx.json
//
// Nothing downloads without a yes for that exact file (its size, source and license were shown in
// the consent dialog of the Voice settings), the same rule as the chat models (src/brain/catalog/consent.js).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { downloadModel } from '../brain/models.js';

export class VoiceStore {
  constructor(home) {
    this.dir = path.join(home, 'voice');
    this.consentFile = path.join(this.dir, 'consent.json');
    this.settingsFile = path.join(this.dir, 'settings.json');
    this.consent = readJson(this.consentFile, { accepted: {} });
    if (!this.consent.accepted || typeof this.consent.accepted !== 'object') this.consent.accepted = {};
    this.settings = readJson(this.settingsFile, {});
  }

  dirFor(pkg) {
    if (pkg.kind === 'stt') return path.join(this.dir, 'models');
    if (pkg.kind === 'tts') return path.join(this.dir, 'voices');
    return path.join(this.dir, 'runtime', pkg.id);
  }

  /** True when the user said yes to this package with the same checksums. */
  hasConsent(pkg) {
    const rec = this.consent.accepted[pkg.id];
    return !!rec && JSON.stringify(rec.sha256 || []) === JSON.stringify(shaList(pkg));
  }

  grant(pkg) {
    this.consent.accepted[pkg.id] = { at: new Date().toISOString(), bytes: pkg.bytes, sha256: shaList(pkg) };
    writeJson(this.consentFile, this.consent);
  }

  revoke(id) {
    delete this.consent.accepted[id];
    writeJson(this.consentFile, this.consent);
  }

  set(patch) {
    this.settings = { ...this.settings, ...patch };
    writeJson(this.settingsFile, this.settings);
  }

  /** True when every file is on disk with its size (the checksum was checked when it downloaded). */
  installed(pkg) {
    if (pkg.binary) return !!this.binaryOf(pkg);
    const dir = this.dirFor(pkg);
    return filesOf(pkg).every((f) => sizeOf(path.join(dir, f.file)) === f.bytes);
  }

  /** The path of a model or voice file. */
  pathOf(pkg, i = 0) {
    return path.join(this.dirFor(pkg), filesOf(pkg)[i].file);
  }

  /** The unpacked program of a runtime package (whisper-server, piper), or null. */
  binaryOf(pkg) {
    const name = process.platform === 'win32' && pkg.platform === 'win32' ? `${pkg.binary}.exe` : pkg.binary;
    return findFile(this.dirFor(pkg), name, 4);
  }

  /**
   * Downloads (resume, SHA-256) and, for an archive, unpacks a package. Needs the yes first.
   * @param {object} pkg  an entry of src/voice/catalog.js
   * @param {{ onProgress?: (p: { received: number, total: number, bps: number }) => void, signal?: AbortSignal, fetchImpl?: typeof fetch, untar?: typeof untar }} [opts]
   */
  async install(pkg, opts = {}) {
    if (!this.hasConsent(pkg)) throw Object.assign(new Error(`no yes for ${pkg.id}`), { code: 'needs_consent' });
    const dir = this.dirFor(pkg);
    if (this.installed(pkg)) return dir;
    const file = await downloadModel({ name: pkg.name, bytes: pkg.bytes, files: filesOf(pkg) }, { home: this.dir, dir, onProgress: opts.onProgress, signal: opts.signal, fetchImpl: opts.fetchImpl });
    if (pkg.binary) {
      await (opts.untar || untar)(file, dir);
      fs.rmSync(file, { force: true });
      // An antivirus that quarantines the program right after unpacking leaves no file behind.
      if (!this.binaryOf(pkg)) throw Object.assign(new Error(`${pkg.binary} is missing after unpacking ${pkg.file}; an antivirus may have quarantined it.`), { code: 'quarantined', hint: 'Allow the hivedesk folder in the antivirus, then press Retry.' });
      if (process.platform !== 'win32') { try { fs.chmodSync(this.binaryOf(pkg), 0o755); } catch { /* read only */ } }
    }
    return dir;
  }

  /** Deletes a downloaded package (and its yes, so it asks again next time). */
  remove(pkg) {
    if (pkg.binary) fs.rmSync(this.dirFor(pkg), { recursive: true, force: true });
    else for (const f of filesOf(pkg)) fs.rmSync(path.join(this.dirFor(pkg), f.file), { force: true });
    this.revoke(pkg.id);
  }
}

export function filesOf(pkg) {
  return Array.isArray(pkg.files) && pkg.files.length ? pkg.files : [{ file: pkg.file, bytes: pkg.bytes, sha256: pkg.sha256, url: pkg.url }];
}

function shaList(pkg) {
  return filesOf(pkg).map((f) => f.sha256).filter(Boolean);
}

/** Unpacks a .zip or .tar.gz with the system tar (bsdtar on Windows 10 and later reads zip too). */
export function untar(archive, dir) {
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  const args = /\.zip$/i.test(archive) && process.platform !== 'win32' ? null : ['-xf', archive, '-C', dir];
  return new Promise((resolve, reject) => {
    const child = args ? spawn(tar, args, { windowsHide: true }) : spawn('unzip', ['-o', '-q', archive, '-d', dir], { windowsHide: true });
    let err = '';
    child.stderr?.on('data', (c) => { err = (err + c).slice(-2000); });
    child.on('error', (e) => reject(Object.assign(new Error(`could not unpack ${path.basename(archive)}: ${e.message}`), { code: 'install_failed' })));
    child.on('close', (code) => (code === 0 ? resolve() : reject(Object.assign(new Error(`could not unpack ${path.basename(archive)}: ${err.trim() || `exit ${code}`}`), { code: 'install_failed' }))));
  });
}

function findFile(dir, name, depth) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) if (e.isFile() && e.name === name) return path.join(dir, e.name);
  if (depth <= 0) return null;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const hit = findFile(path.join(dir, e.name), name, depth - 1);
    if (hit) return hit;
  }
  return null;
}

function sizeOf(f) {
  try { return fs.statSync(f).size; } catch { return -1; }
}

function readJson(file, fallback) {
  try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); return d && typeof d === 'object' ? d : fallback; } catch { return fallback; }
}

function writeJson(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
    fs.renameSync(tmp, file);
  } catch { /* read only home: holds for this run */ }
}
