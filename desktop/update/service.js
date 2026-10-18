// The update service inside the app: checks the signed manifest of the latest release on start and every
// 6 hours, downloads the package for this install in the background (with resume), stages it, and applies it
// on restart through the guard (desktop/update/guard.js). Installs that cannot update themselves (npx, the
// .deb and .rpm, a hand unpacked zip) get a notice with the command or the download page instead.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { verifyManifest, notesFor, MANIFEST_NAME, SIGNATURE_NAME } from './manifest.js';
import { isNewer, fitsChannel, compareVersions, CHANNELS } from './version.js';
import { downloadFile } from './download.js';
import { stage, readState, writeState, writeHealth, markHealthy, writeAtomic } from './apply.js';
import { canSelfUpdate } from './layout.js';
import { UPDATE_PUBLIC_KEY } from './pubkey.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = 'kwy404/hivedesk';
export const STABLE_BASE = `https://github.com/${REPO}/releases/latest/download`;
export const RELEASES_API = `https://api.github.com/repos/${REPO}/releases?per_page=20`;
export const RELEASES_PAGE = `https://github.com/${REPO}/releases`;
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
export const SNOOZE_MS = 24 * 60 * 60 * 1000;

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

async function getBytes(fetchImpl, url, accept) {
  const res = await fetchImpl(url, { redirect: 'follow', headers: accept ? { accept } : {} });
  if (!res.ok) throw fail('http', `HTTP ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Fetches and verifies the manifest for a channel.
 * stable: latest.json of the latest release (GitHub skips pre-releases there).
 * beta: the newest release, pre-releases included, that carries a latest.json.
 * @returns {Promise<object>} the verified manifest
 */
export async function fetchManifest({ channel = 'stable', fetchImpl = globalThis.fetch, publicKey = UPDATE_PUBLIC_KEY }) {
  let base = STABLE_BASE;
  if (channel === 'beta') {
    const list = JSON.parse((await getBytes(fetchImpl, RELEASES_API, 'application/vnd.github+json')).toString('utf8'));
    const withManifest = (Array.isArray(list) ? list : [])
      .filter((r) => r && !r.draft && Array.isArray(r.assets) && r.assets.some((a) => a.name === MANIFEST_NAME) && r.assets.some((a) => a.name === SIGNATURE_NAME))
      .sort((a, b) => compareVersions(b.tag_name, a.tag_name));
    if (!withManifest.length) throw fail('no_release', 'no release with an update manifest yet');
    base = `https://github.com/${REPO}/releases/download/${encodeURIComponent(withManifest[0].tag_name)}`;
  }
  const [bytes, sig] = await Promise.all([
    getBytes(fetchImpl, `${base}/${MANIFEST_NAME}`),
    getBytes(fetchImpl, `${base}/${SIGNATURE_NAME}`)
  ]);
  return verifyManifest(bytes, sig.toString('utf8'), publicKey);
}

/** Decides what a verified manifest means for this copy. */
export function evaluate(manifest, { version, channel, install, prefs = {}, now = Date.now(), manual = false }) {
  if (!fitsChannel(manifest.version, channel) || !isNewer(manifest.version, version)) return { status: 'current' };
  if ((prefs.failed || []).includes(manifest.version)) return { status: 'current', skipped: manifest.version };
  const asset = install.asset ? manifest.assets[install.asset] : null;
  const snoozed = !manual && prefs.snoozedVersion === manifest.version && now < (prefs.snoozedUntil || 0);
  if (!canSelfUpdate(install) || !asset) return { status: 'notice', snoozed };
  return { status: 'available', asset, snoozed };
}

/**
 * @typedef {{ status: 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'ready' | 'applying' | 'notice' | 'error',
 *   version?: string, notes?: string, size?: number, got?: number, speed?: number, eta?: number, when?: 'close' | null,
 *   error?: string, kind: string, command?: string, page?: string, snoozed?: boolean, rolledBack?: string | null,
 *   autoUpdate: boolean, channel: string, checkedAt?: number }} UpdateState
 */
export class UpdateService extends EventEmitter {
  /**
   * @param {{ home: string, version: string, locale?: string, install: object, fetchImpl?: typeof fetch,
   *   publicKey?: string, log?: (s: string) => void, platform?: string, env?: object, now?: () => number,
   *   intervalMs?: number, spawnImpl?: typeof spawn, requestQuit?: () => void }} o
   */
  constructor(o) {
    super();
    this.o = o;
    this.home = o.home;
    this.version = o.version;
    this.install = o.install;
    this.fetchImpl = o.fetchImpl || globalThis.fetch;
    this.publicKey = o.publicKey || UPDATE_PUBLIC_KEY;
    this.clock = o.now || Date.now;
    this.log = o.log || (() => {});
    this.dir = path.join(o.home, 'update');
    this.prefsFile = path.join(this.dir, 'prefs.json');
    this.manifest = null;
    this.file = null;
    this.timer = null;
    this.busy = null;
    this.noticeLogged = null;
    this.lastEmit = 0;
    this.s = { status: 'idle', kind: this.install.kind, when: null, rolledBack: null, ...this.settings() };
    const env = o.env || process.env;
    const st = readState(this.install);
    const failed = env.HIVEDESK_UPDATE_ROLLED_BACK || (st.state === 'rolledBack' && !st.seen ? st.failed : null);
    if (failed) {
      this.s.rolledBack = failed;
      const prefs = this.prefs();
      this.savePrefs({ failed: [...new Set([...(prefs.failed || []), failed])] });
      if (st.state === 'rolledBack') writeState(this.install, { ...st, seen: true });
    }
  }

  prefs() {
    try { return JSON.parse(fs.readFileSync(this.prefsFile, 'utf8')) || {}; } catch { return {}; }
  }

  savePrefs(patch) {
    const next = { ...this.prefs(), ...patch };
    writeAtomic(this.prefsFile, JSON.stringify(next, null, 2));
    return next;
  }

  settings() {
    const p = this.prefs();
    return { autoUpdate: p.autoUpdate !== false, channel: CHANNELS.includes(p.channel) ? p.channel : 'stable' };
  }

  setSettings(patch = {}) {
    const p = {};
    if (typeof patch.autoUpdate === 'boolean') p.autoUpdate = patch.autoUpdate;
    if (CHANNELS.includes(patch.channel)) p.channel = patch.channel;
    this.savePrefs(p);
    const before = this.s.channel;
    this.set(this.settings());
    if (p.autoUpdate === true || (p.channel && p.channel !== before)) this.check({ manual: false }).catch(() => {});
    this.schedule();
    return this.state();
  }

  state() {
    return { ...this.s, current: this.version };
  }

  set(patch) {
    Object.assign(this.s, patch);
    this.emit('change', this.state());
  }

  /** Starts the timers: a first check a few seconds after start, then every 6 hours. */
  start({ firstDelayMs = 8000 } = {}) {
    this.schedule(firstDelayMs);
    return this;
  }

  schedule(delay) {
    clearTimeout(this.timer);
    if (!this.s.autoUpdate) return;
    const every = this.o.intervalMs || CHECK_EVERY_MS;
    this.timer = setTimeout(async () => {
      try { await this.check({ manual: false }); } catch { /* shown in the state */ }
      this.schedule(every);
    }, delay ?? every);
    this.timer.unref?.();
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
  }

  /** The first launch of a new version is healthy once the window is up. */
  reportHealthy() {
    writeHealth(this.home, this.version);
    const st = readState(this.install);
    if (st.state === 'trial' && st.version === this.version) {
      // The guard normally ends the trial right away; if it is gone (reboot), end it here.
      const t = setTimeout(() => {
        const again = readState(this.install);
        if (again.state === 'trial' && again.version === this.version) markHealthy(this.install, this.version);
      }, 15000);
      t.unref?.();
    }
  }

  async check({ manual = false } = {}) {
    if (this.busy) return this.state();
    if (['downloading', 'ready', 'applying'].includes(this.s.status)) return this.state();
    this.set({ status: 'checking', error: undefined });
    let manifest;
    try {
      manifest = await fetchManifest({ channel: this.s.channel, fetchImpl: this.fetchImpl, publicKey: this.publicKey });
    } catch (err) {
      this.log(`update check: ${err.message}`);
      this.set({ status: manual ? 'error' : 'idle', error: err.code === 'bad_signature' ? 'signature' : err.code === 'no_release' ? 'none' : 'network', checkedAt: this.clock() });
      return this.state();
    }
    const r = evaluate(manifest, { version: this.version, channel: this.s.channel, install: this.install, prefs: this.prefs(), now: this.clock(), manual });
    const base = { checkedAt: this.clock(), version: manifest.version, notes: notesFor(manifest, this.o.locale || 'en'), page: `${RELEASES_PAGE}/tag/v${manifest.version}`, snoozed: !!r.snoozed };
    if (r.status === 'current') {
      this.manifest = null;
      this.set({ status: 'current', ...base, version: undefined, notes: undefined });
      return this.state();
    }
    this.manifest = manifest;
    if (r.status === 'notice') {
      this.set({ status: 'notice', ...base, command: this.noticeCommand(manifest.version) });
      if (this.noticeLogged !== manifest.version) {
        this.noticeLogged = manifest.version;
        this.emit('notice', { version: manifest.version, command: this.s.command, page: base.page });
      }
      return this.state();
    }
    this.set({ status: 'available', ...base, size: r.asset.size, got: 0 });
    const out = this.state();
    if (this.s.autoUpdate || manual) this.download().catch(() => {});
    return out;
  }

  noticeCommand(version) {
    if (this.install.kind === 'npx') return 'npx hivedesk@latest';
    if (this.install.kind === 'package') {
      return this.install.manager === 'dnf' ? `sudo dnf install ./hivedesk-${version}-1.x86_64.rpm` : `sudo apt install ./hivedesk_${version}_amd64.deb`;
    }
    return null;
  }

  /** Downloads (resuming a partial file) and stages the update. */
  async download() {
    if (!this.manifest) throw fail('no_update', 'no update to download');
    if (this.busy) return this.busy;
    const asset = this.manifest.assets[this.install.asset];
    const version = this.manifest.version;
    const dest = this.install.kind === 'appimage' ? `${this.install.appimage}.new` : path.join(this.dir, 'downloads', asset.file.replace(/(\.[a-z.]+)$/i, `-${version}$1`));
    const samples = [];
    this.set({ status: 'downloading', got: 0, size: asset.size, speed: 0, eta: null, error: undefined });
    this.busy = (async () => {
      try {
        await downloadFile({
          url: asset.url, dest, size: asset.size, sha256: asset.sha256, fetchImpl: this.fetchImpl,
          onProgress: ({ got }) => {
            const t = this.clock();
            samples.push([t, got]);
            while (samples.length > 2 && t - samples[0][0] > 5000) samples.shift();
            const [t0, g0] = samples[0];
            const speed = t > t0 ? ((got - g0) * 1000) / (t - t0) : 0;
            if (t - this.lastEmit < 250 && got < asset.size) { this.s.got = got; return; }
            this.lastEmit = t;
            this.set({ got, speed: Math.round(speed), eta: speed > 0 ? Math.ceil((asset.size - got) / speed) : null });
          }
        });
        this.file = dest;
        stage(this.install, { version, file: dest, platform: this.o.platform });
        if (this.install.kind !== 'appimage') fs.rmSync(dest, { force: true });
        this.set({ status: 'ready', got: asset.size });
        this.log(`update ${version} downloaded and ready`);
      } catch (err) {
        this.log(`update download: ${err.message}`);
        this.set({ status: 'error', error: err.code === 'checksum' ? 'checksum' : err.code === 'not_writable' ? 'not_writable' : 'download' });
        throw err;
      } finally {
        this.busy = null;
      }
    })();
    return this.busy;
  }

  /** "Remind me later": hide the panel for this version for a day. */
  later() {
    if (this.s.version) this.savePrefs({ snoozedVersion: this.s.version, snoozedUntil: this.clock() + SNOOZE_MS });
    this.set({ snoozed: true, when: null });
    return this.state();
  }

  /** "When I close the app": apply on quit. */
  onClose() {
    this.set({ when: 'close', snoozed: true });
    if (this.s.status === 'available' || this.s.status === 'error') this.download().catch(() => {});
    return this.state();
  }

  /** "Update now": download if needed, then restart into the new version. */
  async updateNow() {
    this.set({ when: 'now' });
    if (this.s.status !== 'ready') await this.download();
    return this.apply();
  }

  /** Called when the app quits: applies a ready update the user chose to install on close. */
  applyOnQuit() {
    if (this.s.status === 'ready' && this.s.when === 'close') return this.spawnGuard();
    return false;
  }

  apply() {
    if (this.s.status !== 'ready') throw fail('not_ready', 'the update is not ready');
    this.set({ status: 'applying' });
    this.spawnGuard();
    this.o.requestQuit?.();
    return this.state();
  }

  spawnGuard() {
    const plan = { install: this.install, version: this.manifest.version, home: this.home, waitPid: process.pid, platform: this.o.platform || process.platform };
    const planFile = path.join(this.dir, 'apply.json');
    writeAtomic(planFile, JSON.stringify(plan, null, 2));
    const run = this.o.spawnImpl || spawn;
    const child = run(process.execPath, [path.join(HERE, 'guard.js'), planFile], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on?.('error', () => {});
    child.unref?.();
    this.log(`update ${plan.version}: restarting into the new version`);
    return true;
  }
}
