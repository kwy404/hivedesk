// Native clipboard on Linux for clipboard sync: X11 through xclip, Wayland through wl-clipboard
// (wl-paste and wl-copy), each only when the person has it installed; nothing is shipped.
// Changes are found by polling once a second (the formats list and a hash of the content).
// The lock state comes from loginctl LockedHint, as for control; unknown means locked.
// On Windows the input helper process does the clipboard too (desktop/helpers/win-input.ps1).
// macOS has no native path in this version: the window's own clipboard (text and images, with focus) is used.

import crypto from 'node:crypto';
import { execFile as nodeExecFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { parseLockedHint } from './x11.js';

const MAX_BUF = 12 * 1024 * 1024;

/** Which Linux clipboard tool to use, or null. */
export function linuxClipboardKind(env, has) {
  const wayland = env.XDG_SESSION_TYPE === 'wayland' || (!!env.WAYLAND_DISPLAY && env.XDG_SESSION_TYPE !== 'x11');
  if (wayland) return has('wl-paste') && has('wl-copy') ? 'wl' : null;
  if (env.DISPLAY && has('xclip')) return 'xclip';
  return null;
}

/** file:// URIs of a text/uri-list to local paths. */
export function uriListToPaths(text) {
  return String(text || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('file://'))
    .map((l) => { try { return decodeURIComponent(new URL(l).pathname); } catch { return null; } }).filter(Boolean);
}

export class LinuxClipboard extends EventEmitter {
  constructor({ kind, execFile = nodeExecFile, env = process.env, pollMs = 1000, setInterval: si = setInterval, clearInterval: ci = clearInterval } = {}) {
    super();
    this.kind = kind;
    this.execFile = execFile;
    this.env = env;
    this.watching = false;
    this.last = null;
    this.lockState = { locked: null, at: 0 };
    this.clearInterval = ci;
    this.timer = si(() => this._tick(), pollMs);
    this.timer.unref?.();
  }

  _run(cmd, args, input) {
    return new Promise((resolve) => {
      try {
        const child = this.execFile(cmd, args, { timeout: 4000, env: this.env, encoding: 'buffer', maxBuffer: MAX_BUF }, (err, stdout) => resolve(err ? null : Buffer.from(stdout || '')));
        if (input != null && child?.stdin) { child.stdin.on('error', () => {}); child.stdin.end(input); }
      } catch { resolve(null); }
    });
  }

  _get(type) {
    return this.kind === 'wl' ? this._run('wl-paste', ['--no-newline', '--type', type]) : this._run('xclip', ['-selection', 'clipboard', '-o', '-t', type]);
  }

  async _targets() {
    const out = this.kind === 'wl' ? await this._run('wl-paste', ['--list-types']) : await this._run('xclip', ['-selection', 'clipboard', '-o', '-t', 'TARGETS']);
    return out ? String(out).split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [];
  }

  async _lock() {
    const sid = this.env.XDG_SESSION_ID && /^[\w-]+$/.test(this.env.XDG_SESSION_ID) ? this.env.XDG_SESSION_ID : null;
    const locked = sid ? parseLockedHint(String(await this._run('loginctl', ['show-session', sid, '-p', 'LockedHint', '--value']) || '')) : null;
    this.lockState = { locked, at: Date.now() };
    this.emit('lock', { t: 'lock', locked, source: sid ? 'loginctl' : 'none' });
  }

  /** Reads the clipboard: files first, then a PNG, then text with HTML. */
  async read() {
    const types = await this._targets();
    const has = (t) => types.includes(t);
    if (has('text/uri-list')) {
      const paths = uriListToPaths(await this._get('text/uri-list'));
      if (paths.length) return { files: paths };
    }
    if (has('image/png')) {
      const png = await this._get('image/png');
      if (png?.length) return { png };
    }
    const text = has('text/plain;charset=utf-8') || has('UTF8_STRING') || has('text/plain') ? await this._get(has('text/plain;charset=utf-8') ? 'text/plain;charset=utf-8' : has('UTF8_STRING') ? 'UTF8_STRING' : 'text/plain') : null;
    const html = has('text/html') ? await this._get('text/html') : null;
    if (text?.length || html?.length) return { text: text ? text.toString('utf8') : '', html: html ? html.toString('utf8') : undefined };
    return null;
  }

  async _tick() {
    await this._lock();
    if (!this.watching) return;
    const item = await this.read();
    if (!item) return;
    const h = crypto.createHash('sha256').update(JSON.stringify({ ...item, png: item.png ? item.png.toString('base64') : undefined })).digest('hex');
    if (h === this.last) return;
    const first = this.last === null;
    this.last = h;
    if (!first) this.emit('clip', item);
  }

  watch(on) { this.watching = on === true; if (!on) this.last = null; }

  /** Writes one item; the next poll sees it as unchanged, so it is not echoed back. */
  async set(item) {
    let ok = null;
    if (item.kind === 'files') {
      const list = item.paths.map((p) => `file://${encodeURI(p)}`).join('\n');
      ok = this.kind === 'wl' ? await this._run('wl-copy', ['--type', 'text/uri-list'], list) : await this._run('xclip', ['-selection', 'clipboard', '-t', 'text/uri-list', '-i'], list);
    } else if (item.kind === 'image') {
      ok = this.kind === 'wl' ? await this._run('wl-copy', ['--type', 'image/png'], item.png) : await this._run('xclip', ['-selection', 'clipboard', '-t', 'image/png', '-i'], item.png);
    } else {
      // One selection holds one type with these tools: HTML when there is HTML, else plain text.
      const html = item.html && this.kind === 'xclip';
      ok = this.kind === 'wl' ? await this._run('wl-copy', ['--type', 'text/plain;charset=utf-8'], item.text) : await this._run('xclip', ['-selection', 'clipboard', '-t', html ? 'text/html' : 'UTF8_STRING', '-i'], html ? item.html : item.text);
    }
    const now = await this.read();
    if (now) this.last = crypto.createHash('sha256').update(JSON.stringify({ ...now, png: now.png ? now.png.toString('base64') : undefined })).digest('hex');
    return ok !== null;
  }

  close() { this.clearInterval(this.timer); this.watching = false; }
}
