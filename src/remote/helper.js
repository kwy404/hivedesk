// The native input helper (docs/1.0/PLAN.md section 12.3, option 1): what this system supports, and
// starting the helper. Windows: desktop/helpers/win-input.ps1 in one long lived PowerShell process,
// started only after its hash matched desktop/native.js. X11: xdotool and loginctl when installed
// (src/remote/x11.js). macOS: view only, because control needs a signed app and the downloads are not signed.
// Wayland: view only, because input there needs the desktop portal, which 1.0 does not implement.

import { spawn as nodeSpawn, execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { verifiedHelper } from '../../desktop/native.js';
import { X11Helper } from './x11.js';

/**
 * What remote desktop can do on this system. View works wherever the window can capture the screen.
 * @returns {{ view: boolean, control: boolean, kind: string | null, hotkey: boolean, indicator: boolean, reason: string | null }}
 */
export function helperSupport({ platform = process.platform, env = process.env, has = hasProgram } = {}) {
  if (platform === 'win32') {
    const v = verifiedHelper('win-input');
    if (!v.ok) return { view: true, control: false, kind: null, hotkey: false, indicator: false, reason: `helper_${v.code}` };
    return { view: true, control: true, kind: 'win-input', hotkey: true, indicator: true, reason: null };
  }
  if (platform === 'darwin') return { view: true, control: false, kind: null, hotkey: false, indicator: false, reason: 'macos_unsigned' };
  if (platform === 'linux') {
    const wayland = env.XDG_SESSION_TYPE === 'wayland' || (!!env.WAYLAND_DISPLAY && env.XDG_SESSION_TYPE !== 'x11');
    if (wayland) return { view: true, control: false, kind: null, hotkey: false, indicator: false, reason: 'wayland' };
    if (!env.DISPLAY) return { view: true, control: false, kind: null, hotkey: false, indicator: false, reason: 'no_display' };
    if (!has('xdotool')) return { view: true, control: false, kind: null, hotkey: false, indicator: false, reason: 'no_xdotool' };
    if (!has('loginctl')) return { view: true, control: false, kind: null, hotkey: false, indicator: false, reason: 'no_lock_detection' };
    return { view: true, control: true, kind: 'x11-xdotool', hotkey: false, indicator: false, reason: null };
  }
  return { view: true, control: false, kind: null, hotkey: false, indicator: false, reason: 'unsupported_os' };
}

/** True when a program is on PATH (POSIX `command -v`). */
export function hasProgram(name) {
  if (!/^[a-z0-9_-]+$/i.test(name)) return false;
  try {
    execFileSync('sh', ['-c', `command -v ${name}`], { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch { return false; }
}

/**
 * The Windows helper: one PowerShell process, JSON lines out, one command per line in.
 * Events: 'ready' { displays, hotkey }, 'lock' { locked, source }, 'hotkey', 'stop', 'pong', 'cursor', 'exit' { code }.
 */
export class WinHelper extends EventEmitter {
  constructor({ spawn = nodeSpawn, test = false, file } = {}) {
    super();
    const v = file ? { ok: true, path: file } : verifiedHelper('win-input');
    if (!v.ok) throw Object.assign(new Error(`the input helper is not usable: ${v.code}`), { code: v.code });
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', v.path];
    if (test) args.push('-Test');
    this.child = spawn('powershell.exe', args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.closed = false;
    this.info = null;
    let buf = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (d) => {
      buf += d;
      if (buf.length > 1 << 20) buf = '';
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (!m || typeof m.t !== 'string') continue;
        if (m.t === 'ready') this.info = { displays: Array.isArray(m.displays) ? m.displays : [], hotkey: m.hotkey === true };
        this.emit(m.t, m);
      }
    });
    this.child.stderr.on('data', (d) => this.emit('stderr', String(d).slice(0, 2000)));
    this.child.on('error', (err) => this._gone(err.message));
    this.child.on('exit', (code) => this._gone(code));
    this.child.stdin.on('error', () => {});
  }

  _gone(code) {
    if (this.closed) return;
    this.closed = true;
    this.emit('exit', { code });
  }

  _w(line) {
    if (this.closed) return false;
    try { return this.child.stdin.write(line + '\n'); } catch { return false; }
  }

  move(px, py) { return this._w(`M ${px | 0} ${py | 0}`); }
  button(b, down) { return this._w(`B ${b | 0} ${down ? 1 : 0}`); }
  wheel(dx, dy) { return this._w(`W ${dx | 0} ${dy | 0}`); }
  key(entry, down) { return this._w(`K ${entry.vk | 0} ${entry.ext ? 1 : 0} ${down ? 1 : 0}`); }
  release() { return this._w('R'); }
  ping() { return this._w('P'); }
  cursor() { return this._w('C'); }
  /** Clipboard sync (src/remote/clipsync.js): watch for copies, and put a synced item on the clipboard. */
  clipWatch(on) { return this._w(`CW ${on ? 1 : 0}`); }
  clipSet(item) {
    const b = (s) => Buffer.from(String(s), 'utf8').toString('base64');
    if (item.kind === 'text') return this._w(`CT ${b(item.text || '')} ${item.html ? b(item.html) : '-'}`);
    if (item.kind === 'image') return this._w(`CI ${item.png.toString('base64')}`);
    if (item.kind === 'files' && item.paths?.length) return this._w(`CF ${item.paths.map(b).join(' ')}`);
    return false;
  }

  indicator(mode, text = '') {
    const m = ['off', 'view', 'control'].includes(mode) ? mode : 'off';
    return this._w(`I ${m} ${Buffer.from(String(text).slice(0, 120), 'utf8').toString('base64')}`);
  }

  close() {
    if (this.closed) return;
    this.release();
    try { this.child.stdin.end(); } catch { /* gone */ }
    const t = setTimeout(() => { try { this.child.kill(); } catch { /* gone */ } }, 3000);
    t.unref?.();
  }
}

/** Starts the helper for a support result of helperSupport(). */
export function startHelper(support, o = {}) {
  if (support.kind === 'win-input') return new WinHelper(o);
  if (support.kind === 'x11-xdotool') return new X11Helper(o);
  return null;
}
