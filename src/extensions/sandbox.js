// Parent side of the extension sandbox: one shared child process for every extension, started
// on the first tool call and stopped after a quiet minute, so idle extensions cost no memory.
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
    this.child = null;
    this.loaded = new Map();
    this.pending = new Map();
    this.seq = 0;
    this.idle = null;
    this.isolated = false;
  }

  /** Remembers an extension's code; it is evaluated in the child on its first call. */
  set(extId, files, entry) {
    this.sources.set(extId, { files, entry });
    this.loaded.delete(extId);
    if (this.child) this._send({ t: 'unload', extId }).catch(() => {});
  }

  remove(extId) {
    this.sources.delete(extId);
    this.loaded.delete(extId);
    if (this.child) this._send({ t: 'unload', extId }).catch(() => {});
  }

  /** Loads the code now and returns the exported tool names (used to check a manifest). */
  async exports(extId) {
    await this._start();
    return this._ensure(extId);
  }

  async call(extId, tool, args) {
    await this._start();
    await this._ensure(extId);
    return this._send({ t: 'call', extId, tool, args });
  }

  async _ensure(extId) {
    if (this.loaded.has(extId)) return this.loaded.get(extId);
    const src = this.sources.get(extId);
    if (!src) throw new Error(`extension ${extId} has no code`);
    const r = await this._send({ t: 'load', extId, files: src.files, entry: src.entry });
    this.loaded.set(extId, r.tools);
    return r.tools;
  }

  _start() {
    if (this.child) { this._touch(); return this.ready; }
    const flag = permissionFlag();
    const args = [];
    if (flag) args.push(flag, `--allow-fs-read=${CHILD}`);
    args.push('--experimental-vm-modules', '--no-warnings', '--max-old-space-size=64', '--disallow-code-generation-from-strings', CHILD);
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true, env: { NODE_OPTIONS: '' } });
    this.child = child;
    this.loaded = new Map();
    let stderr = '';
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    this.ready = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('the extension sandbox did not start')), 10_000);
      child.once('message', (m) => { clearTimeout(t); this.isolated = !!m?.permission; resolve(); });
      child.once('exit', (code) => { clearTimeout(t); reject(new Error(`the extension sandbox stopped (${code}): ${stderr.trim().slice(0, 300)}`)); });
    });
    child.on('message', (m) => this._onMessage(m));
    child.on('error', () => { /* a send after the child stopped; the pending calls fail below */ });
    child.on('exit', () => {
      if (this.child === child) this.child = null;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('the extension sandbox stopped')); }
      this.pending.clear();
    });
    child.unref();
    child.channel?.unref?.();
    this._touch();
    return this.ready;
  }

  _touch() {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.stop(), this.idleMs);
    this.idle.unref?.();
  }

  _send(msg) {
    const id = `m${++this.seq}`;
    const child = this.child;
    if (!child) return Promise.reject(new Error('the extension sandbox is not running'));
    this._touch();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`the extension took longer than ${Math.round(this.timeoutMs / 1000)} s and was stopped`));
        this.stop();
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.send({ ...msg, id });
    });
  }

  async _onMessage(m) {
    if (!m || typeof m !== 'object') return;
    if (m.t === 'reply') {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.ok) p.resolve(m.result); else p.reject(new Error(m.error));
      return;
    }
    if (m.t === 'log') { this.onLog(m.extId, m.level, m.text); return; }
    if (m.t === 'cap') {
      let reply;
      try { reply = { t: 'capResult', id: m.id, ok: true, result: await this.onCapability(m.extId, m.cap, m.args) }; } catch (err) { reply = { t: 'capResult', id: m.id, ok: false, error: String(err?.message || err) }; }
      try { this.child?.send(reply); } catch { /* stopped meanwhile */ }
    }
  }

  stop() {
    clearTimeout(this.idle);
    const c = this.child;
    this.child = null;
    this.loaded = new Map();
    if (c) { try { c.kill(); } catch { /* gone */ } }
  }
}
