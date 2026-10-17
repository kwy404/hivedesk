// Parent side of the extension sandbox: one child process per extension, started on its first
// tool call and stopped after a quiet minute, so idle extensions cost no memory.
// Each child runs only its own extension's code, and the parent binds every message from a child
// to the extension it started that child for: an id sent by the child is never trusted, so one
// extension cannot use another one's granted capabilities.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { permissionFlag } from '../tools/run.js';

const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sandbox-child.js');
export const CALL_TIMEOUT = 20_000;
const IDLE_MS = 60_000;

export class Sandbox {
  /**
   * @param {{ onCapability: (extId: string, cap: string, args: any) => Promise<any>, onLog?: (extId: string, level: string, text: string) => void, idleMs?: number, timeoutMs?: number }} opts
   */
  constructor(opts) {
    this.onCapability = opts.onCapability;
    this.onLog = opts.onLog || (() => {});
    this.idleMs = opts.idleMs ?? IDLE_MS;
    this.timeoutMs = opts.timeoutMs ?? CALL_TIMEOUT;
    /** @type {Map<string, { files: Record<string,string>, entry: string }>} code to load into a fresh child */
    this.sources = new Map();
    /** @type {Map<string, { child: any, ready: Promise<void>, tools: string[] | null, pending: Map<string, any>, idle: any, isolated: boolean }>} */
    this.children = new Map();
    this.seq = 0;
  }

  /** True when a running child runs under Node's permission model. */
  get isolated() {
    for (const c of this.children.values()) if (c.isolated) return true;
    return false;
  }

  /** Remembers an extension's code; it is evaluated in its own child on its first call (a reload reuses that child). */
  set(extId, files, entry) {
    this.sources.set(extId, { files, entry });
    const c = this.children.get(extId);
    if (c) {
      c.tools = null;
      this._send(extId, c, { t: 'unload', extId }).catch(() => {});
    }
  }

  /** Forgets an extension's code and stops its child, or unloads it there while a call is under way (a reload). */
  remove(extId) {
    this.sources.delete(extId);
    const c = this.children.get(extId);
    if (!c) return;
    if (c.starting || c.pending.size) {
      c.tools = null;
      this._send(extId, c, { t: 'unload', extId }).catch(() => {});
      return;
    }
    this._stopOne(extId);
  }

  /** Loads the code now and returns the exported tool names (used to check a manifest). */
  async exports(extId) {
    const c = await this._start(extId);
    return this._ensure(extId, c);
  }

  async call(extId, tool, args) {
    const c = await this._start(extId);
    await this._ensure(extId, c);
    return this._send(extId, c, { t: 'call', extId, tool, args });
  }

  async _ensure(extId, c) {
    if (c.tools) return c.tools;
    const src = this.sources.get(extId);
    if (!src) throw new Error(`extension ${extId} has no code`);
    const r = await this._send(extId, c, { t: 'load', extId, files: src.files, entry: src.entry });
    c.tools = r.tools;
    return r.tools;
  }

  async _start(extId) {
    if (!this.sources.has(extId)) throw new Error(`extension ${extId} has no code`);
    const have = this.children.get(extId);
    if (have) { this._touch(extId, have); await have.ready; return have; }
    const flag = permissionFlag();
    const args = [];
    if (flag) args.push(flag, `--allow-fs-read=${CHILD}`);
    args.push('--experimental-vm-modules', '--no-warnings', '--max-old-space-size=64', '--disallow-code-generation-from-strings', CHILD);
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true, env: { NODE_OPTIONS: '' } });
    const c = { child, ready: null, tools: null, pending: new Map(), idle: null, isolated: false, starting: true };
    this.children.set(extId, c);
    let stderr = '';
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    c.ready = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('the extension sandbox did not start')), 10_000);
      child.once('message', (m) => { clearTimeout(t); c.isolated = !!m?.permission; resolve(); });
      child.once('exit', (code) => { clearTimeout(t); reject(new Error(`the extension sandbox stopped (${code}): ${stderr.trim().slice(0, 300)}`)); });
    });
    c.ready.then(() => { c.starting = false; }, () => { c.starting = false; });
    // Every message of this child is bound to extId, whatever id the child puts in it.
    child.on('message', (m) => this._onMessage(extId, c, m));
    child.on('error', () => { /* a send after the child stopped; the pending calls fail below */ });
    child.on('exit', () => {
      if (this.children.get(extId) === c) this.children.delete(extId);
      clearTimeout(c.idle);
      for (const p of c.pending.values()) { clearTimeout(p.timer); p.reject(new Error('the extension sandbox stopped')); }
      c.pending.clear();
    });
    child.unref();
    child.channel?.unref?.();
    this._touch(extId, c);
    await c.ready;
    return c;
  }

  _touch(extId, c) {
    clearTimeout(c.idle);
    c.idle = setTimeout(() => this._stopOne(extId), this.idleMs);
    c.idle.unref?.();
  }

  _send(extId, c, msg) {
    const id = `m${++this.seq}`;
    if (this.children.get(extId) !== c) return Promise.reject(new Error('the extension sandbox is not running'));
    this._touch(extId, c);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        c.pending.delete(id);
        reject(new Error(`the extension took longer than ${Math.round(this.timeoutMs / 1000)} s and was stopped`));
        this._stopOne(extId);
      }, this.timeoutMs);
      c.pending.set(id, { resolve, reject, timer });
      try { c.child.send({ ...msg, id }); } catch (err) { clearTimeout(timer); c.pending.delete(id); reject(err); }
    });
  }

  async _onMessage(extId, c, m) {
    if (!m || typeof m !== 'object') return;
    if (m.t === 'reply') {
      const p = c.pending.get(m.id);
      if (!p) return;
      c.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.ok) p.resolve(m.result); else p.reject(new Error(m.error));
      return;
    }
    if (m.t === 'log') { this.onLog(extId, m.level, m.text); return; }
    if (m.t === 'cap') {
      let reply;
      try { reply = { t: 'capResult', id: m.id, ok: true, result: await this.onCapability(extId, m.cap, m.args) }; } catch (err) { reply = { t: 'capResult', id: m.id, ok: false, error: String(err?.message || err) }; }
      try { c.child?.send(reply); } catch { /* stopped meanwhile */ }
    }
  }

  _stopOne(extId) {
    const c = this.children.get(extId);
    if (!c) return;
    this.children.delete(extId);
    clearTimeout(c.idle);
    try { c.child.kill(); } catch { /* gone */ }
  }

  stop() {
    for (const id of [...this.children.keys()]) this._stopOne(id);
  }
}
