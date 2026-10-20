// Starts the native window (the runtime binary with a generated app folder) and talks to it.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { connectWs } from './wsclient.js';
import { MIN } from './state.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ICONS = path.join(HERE, 'app', 'resources', 'icons');

// Only what the controller uses. No file system, no process spawning, no shell commands.
export const NATIVE_ALLOW = [
  'app.exit', 'window.*', 'os.setTray', 'os.showNotification', 'os.showFolderDialog', 'os.showOpenDialog', 'os.open'
];

// The native helpers of remote desktop (docs/1.0/PLAN.md section 12.3). This list is the only way a helper
// gets into the desktop packages and the only thing src/remote/helper.js starts: a shipped helper must be
// listed here with the SHA-256 of its text (line endings normalized to LF), and an external program is
// called by name, never bundled. test/remote/helpers.test.js fails when a file in desktop/helpers/ is not listed.
export const NATIVE_HELPERS = Object.freeze([
  Object.freeze({
    id: 'win-input', platform: 'win32', file: 'helpers/win-input.ps1', runner: 'powershell',
    sha256: '2af78e3f6118206a78669f70ad9068c06b11fe2511d7c4f2cd8784330068d05e',
    does: ['input', 'hotkey', 'indicator', 'lock'], license: 'MIT (ours)'
  }),
  Object.freeze({
    id: 'x11-xdotool', platform: 'linux', external: 'xdotool',
    does: ['input'], license: 'xdotool is a separate program under its own license; called when installed, never shipped'
  }),
  Object.freeze({
    id: 'loginctl', platform: 'linux', external: 'loginctl',
    does: ['lock'], license: 'part of systemd; called when present, never shipped'
  })
]);

/** SHA-256 of a helper's text with CRLF turned into LF, so a Windows checkout and a Linux build agree. */
export function helperHash(text) {
  return createHash('sha256').update(String(text).replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

/**
 * The path of a listed, shipped helper whose content matches its pinned hash, or an error code.
 * @returns {{ ok: true, path: string, helper: object } | { ok: false, code: 'not_listed' | 'missing' | 'hash_mismatch' | 'external' }}
 */
export function verifiedHelper(id) {
  const helper = NATIVE_HELPERS.find((h) => h.id === id);
  if (!helper) return { ok: false, code: 'not_listed' };
  if (!helper.file) return { ok: false, code: 'external' };
  const abs = path.join(HERE, helper.file);
  let text;
  try { text = fs.readFileSync(abs, 'utf8'); } catch { return { ok: false, code: 'missing' }; }
  if (helperHash(text) !== helper.sha256) return { ok: false, code: 'hash_mismatch' };
  return { ok: true, path: abs, helper };
}

/** True when a path inside desktop/ may go into a package: anything outside helpers/, or a listed helper file. */
export function packagedHelperAllowed(relFromDesktop) {
  const rel = String(relFromDesktop).replace(/\\/g, '/');
  if (!rel.startsWith('helpers/') && rel !== 'helpers') return true;
  if (rel === 'helpers') return true;
  return NATIVE_HELPERS.some((h) => h.file === rel);
}

/** The runtime config for one run (written to ~/.hivedesk/desktop/app/neutralino.config.json). */
export function runtimeConfig({ url, title = 'hivedesk', state, frame = 'custom', hidden = false, version = '0.0.0' }) {
  const win = {
    title, icon: '/resources/icons/appIcon.png',
    width: state.width, height: state.height, minWidth: MIN.width, minHeight: MIN.height,
    borderless: frame !== 'system', resizable: true, maximizable: true,
    exitProcessOnClose: false, useSavedState: false, enableInspector: false,
    hidden: !!hidden, skipTaskbar: !!hidden, center: state.x === undefined
  };
  if (state.x !== undefined && !hidden) { win.x = state.x; win.y = state.y; }
  // Only the system frame starts natively maximized. A borderless window maximized by the runtime covers the
  // whole monitor on Windows (taskbar included), so the custom frame opens at normal bounds (or already on
  // the work area) and the controller maximizes it (desktop/workarea.js).
  if (state.maximized && !hidden && frame === 'system') win.maximize = true;
  return {
    applicationId: 'io.github.kwy404.hivedesk', version, defaultMode: 'window', port: 0,
    documentRoot: '/resources/', url, enableServer: true, enableNativeAPI: true,
    tokenSecurity: 'one-time', logging: { enabled: false, writeToLogFile: false },
    nativeAllowList: NATIVE_ALLOW, globalVariables: {},
    modes: { window: win },
    cli: { binaryName: 'hivedesk', resourcesPath: '/resources/' }
  };
}

function prepareAppDir(appDir, config) {
  const iconDir = path.join(appDir, 'resources', 'icons');
  fs.mkdirSync(iconDir, { recursive: true });
  for (const f of fs.readdirSync(ICONS)) fs.copyFileSync(path.join(ICONS, f), path.join(iconDir, f));
  fs.writeFileSync(path.join(appDir, 'neutralino.config.json'), JSON.stringify(config, null, 2));
  fs.rmSync(path.join(appDir, '.tmp'), { recursive: true, force: true });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Launches the window. Resolves once the runtime answers on its local socket.
 * @param {{ binary: string, appDir: string, config: object, timeoutMs?: number, log?: (s: string) => void }} o
 * @returns {Promise<NativeWindow>}
 */
export async function launchNative(o) {
  prepareAppDir(o.appDir, o.config);
  const child = spawn(o.binary, [`--path=${o.appDir}`, '--load-dir-res', '--export-auth-info'], {
    cwd: o.appDir, stdio: 'ignore', windowsHide: false
  });
  let exited = null;
  let spawnError = null;
  child.on('error', (err) => { spawnError = err; });
  child.on('exit', (code, signal) => { exited = { code, signal }; });
  const authFile = path.join(o.appDir, '.tmp', 'auth_info.json');
  const deadline = Date.now() + (o.timeoutMs || 15000);
  let info = null;
  while (!info) {
    if (spawnError) throw Object.assign(new Error(spawnError.message), { code: 'start_failed' });
    if (exited) throw Object.assign(new Error(`the runtime exited with code ${exited.code ?? exited.signal}`), { code: 'start_failed' });
    if (Date.now() > deadline) { child.kill(); throw Object.assign(new Error('the runtime did not start in time'), { code: 'start_failed' }); }
    await sleep(100);
    try { info = JSON.parse(fs.readFileSync(authFile, 'utf8')); } catch { info = null; }
  }
  // The token file is only for us: read it, then delete it.
  fs.rmSync(path.join(o.appDir, '.tmp'), { recursive: true, force: true });
  let ws;
  try {
    ws = await connectWs(`ws://127.0.0.1:${info.nlPort}/?connectToken=${encodeURIComponent(info.nlConnectToken)}`);
  } catch (err) {
    child.kill();
    throw Object.assign(new Error(`could not reach the runtime: ${err.message}`), { code: 'start_failed' });
  }
  // tokenSecurity "one-time": once connected, take the one copy the runtime would hand to a page, so nobody else can.
  await new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: info.nlPort, path: '/__neutralino_globals.js', timeout: 2000 }, (res) => { res.resume(); res.on('end', resolve); });
    req.on('error', resolve);
    req.on('timeout', () => { req.destroy(); resolve(); });
  });
  return new NativeWindow(child, ws, info.nlToken, () => exited);
}

export class NativeWindow extends EventEmitter {
  constructor(child, ws, token, exitedFn) {
    super();
    this.child = child;
    this.ws = ws;
    this.token = token;
    this.seq = 0;
    this.pending = new Map();
    this.closed = false;
    ws.on('message', (text) => {
      let msg;
      try { msg = JSON.parse(text); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        clearTimeout(timer);
        this.pending.delete(msg.id);
        if (msg.error || msg.data?.error) reject(Object.assign(new Error(msg.error?.message || msg.data?.error?.message || 'runtime error'), { code: msg.error?.code || msg.data?.error?.code }));
        else resolve(msg.data?.returnValue ?? msg.data);
      } else if (msg.event) {
        this.emit('event', msg.event, msg.data);
        this.emit(msg.event, msg.data);
      }
    });
    const gone = () => {
      if (this.closed) return;
      this.closed = true;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('the window is closed')); }
      this.pending.clear();
      this.emit('exit');
    };
    ws.on('close', gone);
    ws.on('error', gone);
    child.on('exit', gone);
    if (exitedFn()) setImmediate(gone);
  }

  call(method, data = {}, timeoutMs = 10000) {
    if (this.closed) return Promise.reject(new Error('the window is closed'));
    const id = `h${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, accessToken: this.token, data }));
    });
  }

  /** Closes the window and the runtime process. */
  async exit() {
    if (this.closed) return;
    try { await this.call('app.exit', { code: 0 }, 1500); } catch { /* exiting */ }
    await sleep(200);
    this.kill();
  }

  kill() {
    try { this.ws.close(); } catch { /* closed */ }
    if (this.child.exitCode === null && this.child.signalCode === null) {
      try { this.child.kill(); } catch { /* gone */ }
    }
    if (!this.closed) { this.closed = true; this.emit('exit'); }
  }
}
