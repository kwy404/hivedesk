// The local speech to text: a whisper.cpp server process on 127.0.0.1 with a random port, started
// when the first turn comes in and stopped after a quiet minute so its memory is free again.
// The window sends a 16 kHz WAV to the engine (POST /api/voice/stt), the engine forwards it to this
// process over loopback, and the audio never leaves the computer.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

/** A whisper-server the user installed (Homebrew, a package, a build of their own), or null. */
export function systemWhisper(env = process.env) {
  if (env.HIVEDESK_WHISPER_SERVER && fs.existsSync(env.HIVEDESK_WHISPER_SERVER)) return env.HIVEDESK_WHISPER_SERVER;
  return which(process.platform === 'win32' ? 'whisper-server.exe' : 'whisper-server', env);
}

export function which(name, env = process.env) {
  for (const dir of String(env.PATH || env.Path || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, name);
    try { if (fs.statSync(p).isFile()) return p; } catch { /* not here */ }
  }
  return null;
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

/** Cleans a whisper transcript: no [BLANK_AUDIO], (music) or similar markers, single spaces. */
export function cleanTranscript(text) {
  return String(text || '')
    .replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export class WhisperServer {
  /**
   * @param {{ binary: string, model: string, gpu?: boolean, threads?: number, idleMs?: number, spawnImpl?: typeof spawn, fetchImpl?: typeof fetch, log?: (s: string) => void }} o
   */
  constructor(o) {
    this.o = { idleMs: 60000, threads: Math.max(1, Math.min(8, (os.cpus().length || 4) - 1)), ...o };
    this.child = null;
    this.port = 0;
    this.ready = null;
    this.idle = null;
    this.queue = Promise.resolve();
    this.device = o.gpu ? 'gpu' : 'cpu';
  }

  get running() { return !!this.child; }

  same(binary, model, gpu) {
    return this.o.binary === binary && this.o.model === model && !!this.o.gpu === !!gpu;
  }

  async start() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      this.port = await freePort();
      const args = ['-m', this.o.model, '--host', '127.0.0.1', '--port', String(this.port), '-t', String(this.o.threads), '-l', 'auto', '-nt', '-sns'];
      if (!this.o.gpu) args.push('-ng');
      const sp = this.o.spawnImpl || spawn;
      const child = sp(this.o.binary, args, { cwd: path.dirname(this.o.binary), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      this.child = child;
      let tail = '';
      const onData = (c) => { tail = (tail + c).slice(-3000); };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
      child.on('error', (err) => { tail += String(err.message); });
      exited.then(() => { if (this.child === child) { this.child = null; this.ready = null; } });
      const f = this.o.fetchImpl || fetch;
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r(undefined), 250))]);
        if (code !== undefined) throw Object.assign(new Error(`whisper-server stopped: ${tail.split(/\r?\n/).filter(Boolean).slice(-2).join(' ') || `exit ${code}`}`), { code: 'stt_failed' });
        try {
          // The server answers only after the model is loaded.
          const r = await f(`http://127.0.0.1:${this.port}/health`, { signal: AbortSignal.timeout(1000) });
          if (r.status) return;
        } catch { /* not up yet */ }
      }
      this.stop();
      throw Object.assign(new Error('whisper-server did not start within a minute'), { code: 'stt_failed' });
    })();
    try { await this.ready; } catch (err) { this.ready = null; throw err; }
    return this.ready;
  }

  /**
   * One turn of speech to text, one at a time.
   * @param {Buffer} wav  16 kHz mono 16 bit
   * @param {string} lang  whisper language code or "auto"
   */
  transcribe(wav, lang = 'auto', signal) {
    const run = async () => {
      clearTimeout(this.idle);
      await this.start();
      const f = this.o.fetchImpl || fetch;
      const form = new FormData();
      form.append('file', new Blob([wav], { type: 'audio/wav' }), 'turn.wav');
      form.append('response_format', 'json');
      form.append('temperature', '0.0');
      form.append('language', lang || 'auto');
      const started = Date.now();
      try {
        const r = await f(`http://127.0.0.1:${this.port}/inference`, { method: 'POST', body: form, signal });
        const body = await r.json().catch(() => ({}));
        if (!r.ok || body.error) throw Object.assign(new Error(`whisper-server: ${body.error || r.status}`), { code: 'stt_failed' });
        return { text: cleanTranscript(body.text), ms: Date.now() - started, device: this.device };
      } finally {
        this._armIdle();
      }
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  _armIdle() {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.stop(), this.o.idleMs);
    this.idle.unref?.();
  }

  stop() {
    clearTimeout(this.idle);
    const c = this.child;
    this.child = null;
    this.ready = null;
    if (c) { try { c.kill(); } catch { /* gone */ } }
  }
}
