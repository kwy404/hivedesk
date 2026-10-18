// Remote control on X11 through the xdotool program (when the person has it installed; never shipped)
// and the lock state from loginctl LockedHint. Same events and methods as WinHelper in helper.js.
// No hotkey and no always on top indicator here: the window banner and the tray are the kill switch.

import { execFile as nodeExecFile } from 'node:child_process';
import { EventEmitter } from 'node:events';

const BTN = [1, 2, 3];
const MAX_ARGS = 400;

/** Monitors from `xrandr --listmonitors`, e.g. " 0: +*DP-1 1920/527x1080/296+0+0  DP-1". */
export function parseMonitors(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const m = /^\s*\d+:\s+\+?(\*?)\S*\s+(\d+)\/\d+x(\d+)\/\d+\+(-?\d+)\+(-?\d+)/.exec(line);
    if (m) out.push({ x: Number(m[4]), y: Number(m[5]), w: Number(m[2]), h: Number(m[3]), primary: m[1] === '*' });
  }
  return out;
}

/** "yes" or "no" from loginctl, anything else is unknown. */
export function parseLockedHint(text) {
  const v = String(text || '').trim().toLowerCase();
  return v === 'yes' ? true : v === 'no' ? false : null;
}

export class X11Helper extends EventEmitter {
  constructor({ execFile = nodeExecFile, env = process.env, pollMs = 1000, setInterval: si = setInterval, clearInterval: ci = clearInterval } = {}) {
    super();
    this.execFile = execFile;
    this.env = env;
    this.closed = false;
    this.queue = [];
    this.busy = false;
    this.keys = new Set();
    this.buttons = new Set();
    this.info = null;
    this.clearInterval = ci;
    this._displays().then((displays) => {
      if (this.closed) return;
      this.info = { displays, hotkey: false };
      this.emit('ready', { t: 'ready', displays, hotkey: false });
      this._poll();
    });
    this.timer = si(() => this._poll(), pollMs);
    this.timer.unref?.();
  }

  _run(cmd, args) {
    return new Promise((resolve) => {
      try {
        this.execFile(cmd, args, { timeout: 4000, env: this.env }, (err, stdout) => resolve(err ? null : String(stdout)));
      } catch { resolve(null); }
    });
  }

  async _displays() {
    const mons = parseMonitors(await this._run('xrandr', ['--listmonitors']));
    if (mons.length) return mons;
    const g = /^(\d+)\s+(\d+)/.exec(String(await this._run('xdotool', ['getdisplaygeometry'])).trim());
    return g ? [{ x: 0, y: 0, w: Number(g[1]), h: Number(g[2]), primary: true }] : [];
  }

  async _session() {
    if (this.env.XDG_SESSION_ID && /^[\w-]+$/.test(this.env.XDG_SESSION_ID)) return this.env.XDG_SESSION_ID;
    const uid = typeof process.getuid === 'function' ? String(process.getuid()) : null;
    if (!uid) return null;
    const s = String(await this._run('loginctl', ['show-user', uid, '-p', 'Display', '--value']) || '').trim();
    return /^[\w-]+$/.test(s) ? s : null;
  }

  async _poll() {
    if (this.closed) return;
    const sid = await this._session();
    const locked = sid ? parseLockedHint(await this._run('loginctl', ['show-session', sid, '-p', 'LockedHint', '--value'])) : null;
    if (this.closed) return;
    if (locked !== false) this.release();
    this.emit('lock', { t: 'lock', locked, source: sid ? 'loginctl' : 'none' });
  }

  _push(...args) {
    if (this.closed) return false;
    // Consecutive moves collapse into the last one.
    if (args[0] === 'mousemove' && this.queue.length >= 3 && this.queue[this.queue.length - 3] === 'mousemove') this.queue.splice(-3, 3);
    this.queue.push(...args);
    if (this.queue.length > MAX_ARGS * 4) this.queue.splice(0, this.queue.length - MAX_ARGS * 4);
    this._flush();
    return true;
  }

  _flush() {
    if (this.busy || !this.queue.length || this.closed) return;
    this.busy = true;
    const args = this.queue.splice(0, MAX_ARGS);
    this._run('xdotool', args).then(() => { this.busy = false; this._flush(); });
  }

  move(px, py) { return this._push('mousemove', String(px | 0), String(py | 0)); }

  button(b, down) {
    if (!BTN[b]) return false;
    if (down) this.buttons.add(b); else if (!this.buttons.delete(b)) return false;
    return this._push(down ? 'mousedown' : 'mouseup', String(BTN[b]));
  }

  wheel(dx, dy) {
    const clicks = (d) => Math.min(10, Math.max(1, Math.round(Math.abs(d) / 120)));
    // X11 buttons: 4 up, 5 down, 6 left, 7 right. A positive delta is down or right, as in the browser.
    if (dy) this._push('click', '--repeat', String(clicks(dy)), dy < 0 ? '4' : '5');
    if (dx) this._push('click', '--repeat', String(clicks(dx)), dx < 0 ? '6' : '7');
    return true;
  }

  key(entry, down) {
    if (!entry?.x) return false;
    if (down) this.keys.add(entry.x); else if (!this.keys.delete(entry.x)) return false;
    return this._push(down ? 'keydown' : 'keyup', entry.x);
  }

  release() {
    const args = [];
    for (const k of this.keys) args.push('keyup', k);
    for (const b of this.buttons) args.push('mouseup', String(BTN[b]));
    this.keys.clear();
    this.buttons.clear();
    if (args.length && !this.closed) { this.queue.push(...args); this._flush(); }
    return true;
  }

  ping() { this.emit('pong', { t: 'pong' }); return true; }
  indicator() { return false; }

  close() {
    if (this.closed) return;
    this.release();
    this.closed = true;
    this.clearInterval(this.timer);
    this.emit('exit', { code: 0 });
  }
}
