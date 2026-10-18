// Terminals on this machine. A real PTY through the optional `node-pty` package; when it cannot
// load (not installed, or no prebuilt binary for this Node), a "basic terminal" over pipes with
// no TTY, labeled as such in the UI. The shell is the user's default and starts in a granted
// project root. Output goes only to the subscribers this module is given: local windows, and
// peers holding a terminal share grant (src/workbench/share.js).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { WorkbenchError } from './origin.js';

export const MAX_TERMINALS = 8;
const SCROLLBACK_BYTES = 256 * 1024;
const MAX_INPUT = 64 * 1024;

let ptyModule;
/** Loads node-pty once. Returns { pty } or { error }. */
export async function loadPty(importer = () => import('node-pty')) {
  if (ptyModule !== undefined) return ptyModule;
  try {
    const m = await importer();
    const api = m.spawn ? m : m.default;
    if (typeof api?.spawn !== 'function') throw new Error('node-pty has no spawn()');
    ptyModule = { pty: api };
  } catch (err) {
    ptyModule = { error: /Cannot find (package|module)/.test(String(err.message)) ? 'node-pty is not installed' : `node-pty could not load: ${String(err.message).split('\n')[0].slice(0, 200)}` };
  }
  return ptyModule;
}
export const resetPtyCache = () => { ptyModule = undefined; };

function exists(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function onPath(name) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of String(process.env.PATH || process.env.Path || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) if (exists(path.join(dir, name + ext))) return path.join(dir, name + ext);
  }
  return null;
}

/** The user's default shell: the setting, then the platform default. */
export function defaultShell(setting = '', platform = process.platform, env = process.env) {
  if (setting) return { file: setting, args: [] };
  if (platform === 'win32') {
    const ps = onPath('pwsh') || onPath('powershell');
    if (ps) return { file: ps, args: ['-NoLogo'] };
    return { file: env.ComSpec || 'cmd.exe', args: [] };
  }
  const sh = env.SHELL && exists(env.SHELL) ? env.SHELL : exists('/bin/bash') ? '/bin/bash' : '/bin/sh';
  return { file: sh, args: [] };
}

/** The shell for the basic (pipe) terminal: one that reads commands from stdin without a TTY. */
export function basicShell(setting = '', platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    if (setting && /cmd(\.exe)?$/i.test(setting)) return { file: setting, args: ['/Q', '/K'] };
    if (setting && /(pwsh|powershell)(\.exe)?$/i.test(setting)) return { file: setting, args: ['-NoLogo', '-NoProfile', '-Command', '-'] };
    return { file: env.ComSpec || 'cmd.exe', args: ['/Q', '/K'] };
  }
  const sh = setting || (env.SHELL && exists(env.SHELL) ? env.SHELL : '/bin/sh');
  return { file: sh, args: /(bash|zsh)$/.test(sh) ? ['-i'] : [] };
}

function shellEnv() {
  const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'hivedesk' };
  // The engine's own access token and test knobs are not for the shell.
  for (const k of Object.keys(env)) if (/^HIVEDESK_(TOKEN|TEST)/.test(k)) delete env[k];
  return env;
}

let termSeq = 0;

export class Terminal {
  constructor({ id, kind, proc, shell, cwd, rootId, cols, rows }) {
    this.id = id;
    this.kind = kind; // 'pty' | 'basic'
    this.proc = proc;
    this.shell = shell;
    this.cwd = cwd;
    this.rootId = rootId;
    this.cols = cols;
    this.rows = rows;
    this.createdAt = new Date().toISOString();
    this.exit = null;
    this.buffer = '';
    this.listeners = new Set();
    this.exitListeners = new Set();
    this.bytesOut = 0;
  }

  info() {
    return { termId: this.id, kind: this.kind, shell: path.basename(this.shell), cwd: this.cwd, rootId: this.rootId, cols: this.cols, rows: this.rows, createdAt: this.createdAt, exit: this.exit };
  }

  _data(text) {
    this.bytesOut += text.length;
    this.buffer += text;
    if (this.buffer.length > SCROLLBACK_BYTES) this.buffer = this.buffer.slice(this.buffer.length - SCROLLBACK_BYTES);
    for (const fn of this.listeners) { try { fn(text); } catch { /* a subscriber failed */ } }
  }

  _exit(code, signal) {
    if (this.exit) return;
    this.exit = { code: code ?? null, signal: signal ?? null, at: new Date().toISOString() };
    for (const fn of this.exitListeners) { try { fn(this.exit); } catch { /* ignore */ } }
  }

  onData(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  onExit(fn) { this.exitListeners.add(fn); return () => this.exitListeners.delete(fn); }

  write(data) {
    if (this.exit) throw new WorkbenchError('conflict', 'the terminal has exited');
    const s = String(data ?? '');
    if (s.length > MAX_INPUT) throw new WorkbenchError('bad_request', 'input too large');
    if (this.kind === 'pty') this.proc.write(s);
    else this.proc.stdin.write(s.replace(/\r(?!\n)/g, process.platform === 'win32' ? '\r\n' : '\n'));
    return s.length;
  }

  resize(cols, rows) {
    const c = Math.min(500, Math.max(2, Math.round(Number(cols) || 80)));
    const r = Math.min(300, Math.max(1, Math.round(Number(rows) || 24)));
    this.cols = c;
    this.rows = r;
    if (this.kind === 'pty' && !this.exit) { try { this.proc.resize(c, r); } catch { /* exited */ } }
  }

  kill() {
    if (this.exit) return;
    try {
      if (this.kind === 'pty') this.proc.kill();
      else if (process.platform === 'win32' && this.proc.pid) spawn('taskkill', ['/pid', String(this.proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
      else this.proc.kill('SIGHUP');
    } catch { /* gone */ }
  }
}

export class TerminalManager {
  /** @param {{ settings?: () => object, importer?: () => Promise<any>, forceBasic?: boolean }} [o] */
  constructor(o = {}) {
    this.o = o;
    this.terms = new Map();
  }

  async capability() {
    if (this.o.forceBasic) return { kind: 'basic', reason: 'basic terminal forced' };
    const m = await loadPty(this.o.importer);
    return m.pty ? { kind: 'pty' } : { kind: 'basic', reason: m.error };
  }

  /**
   * @param {{ cwd: string, rootId: string, cols?: number, rows?: number }} o
   * @returns {Promise<Terminal>}
   */
  async open({ cwd, rootId, cols = 80, rows = 24 }) {
    const live = [...this.terms.values()].filter((t) => !t.exit).length;
    if (live >= MAX_TERMINALS) throw new WorkbenchError('busy', `at most ${MAX_TERMINALS} terminals at once`);
    if (!fs.existsSync(cwd)) throw new WorkbenchError('not_found', 'the folder for the terminal does not exist');
    const settings = this.o.settings?.() || {};
    const setting = settings.terminal?.shell || '';
    const id = `t${++termSeq}_${Date.now().toString(36)}`;
    const c = Math.min(500, Math.max(2, Math.round(cols)));
    const r = Math.min(300, Math.max(1, Math.round(rows)));
    const cap = await this.capability();
    let term;
    if (cap.kind === 'pty') {
      const { pty } = await loadPty(this.o.importer);
      const sh = defaultShell(setting);
      let proc;
      try {
        proc = pty.spawn(sh.file, sh.args, { name: 'xterm-256color', cols: c, rows: r, cwd, env: shellEnv(), useConpty: process.platform === 'win32' ? true : undefined });
      } catch (err) {
        throw new WorkbenchError('spawn_failed', `could not start ${sh.file}: ${err.message}`);
      }
      term = new Terminal({ id, kind: 'pty', proc, shell: sh.file, cwd, rootId, cols: c, rows: r });
      proc.onData((d) => term._data(d));
      proc.onExit(({ exitCode, signal }) => term._exit(exitCode, signal));
    } else {
      const sh = basicShell(setting);
      const proc = spawn(sh.file, sh.args, { cwd, env: shellEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      term = new Terminal({ id, kind: 'basic', proc, shell: sh.file, cwd, rootId, cols: c, rows: r });
      term.reason = cap.reason;
      proc.stdout.setEncoding('utf8');
      proc.stderr.setEncoding('utf8');
      proc.stdout.on('data', (d) => term._data(d));
      proc.stderr.on('data', (d) => term._data(d));
      proc.on('error', (err) => { term._data(`\r\n[${err.message}]\r\n`); term._exit(null, 'error'); });
      proc.on('exit', (code, signal) => term._exit(code, signal));
      proc.stdin.on('error', () => {});
    }
    this.terms.set(id, term);
    term.onExit(() => {
      // Keep an exited terminal for a minute so its window can show the exit code.
      const t = setTimeout(() => this.terms.delete(id), 60_000);
      t.unref?.();
    });
    return term;
  }

  get(id) {
    const t = this.terms.get(String(id || ''));
    if (!t) throw new WorkbenchError('not_found', 'no such terminal');
    return t;
  }

  list() {
    return [...this.terms.values()].map((t) => t.info());
  }

  close(id) {
    const t = this.get(id);
    t.kill();
    return t;
  }

  closeAll() {
    for (const t of this.terms.values()) t.kill();
  }
}

