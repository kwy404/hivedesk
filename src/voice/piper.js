// The optional local neural voice: Piper turns one sentence into speech on this computer. One short
// process per sentence (Piper loads a medium voice in well under a second), raw PCM on stdout,
// wrapped into a WAV for the window.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pcmToWav } from './wav.js';
import { startError, relativeTo } from './whisper.js';

export const MAX_TTS_CHARS = 600;

/** The sample rate a Piper voice speaks at (its .onnx.json), 22050 when it does not say. */
export function voiceRate(configFile) {
  try { return Number(JSON.parse(fs.readFileSync(configFile, 'utf8')).audio?.sample_rate) || 22050; } catch { return 22050; }
}

/**
 * @param {{ binary: string, model: string, config: string, text: string, rate?: number, lengthScale?: number, spawnImpl?: typeof spawn, timeoutMs?: number, signal?: AbortSignal }} o
 * @returns {Promise<Buffer>} a WAV file
 */
export function piperSpeak(o) {
  const text = String(o.text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TTS_CHARS);
  if (!text) return Promise.reject(Object.assign(new Error('nothing to say'), { code: 'bad_request' }));
  const rate = o.rate || voiceRate(o.config);
  // Piper, like whisper.cpp, reads ANSI arguments on Windows: paths relative to the voice folder keep
  // accented user folders out of them (its espeak-ng data too, found next to the program).
  const cwd = path.dirname(o.model);
  const args = ['-m', relativeTo(cwd, o.model), '-c', relativeTo(cwd, o.config), '--output_raw', '-q'];
  const espeak = path.join(path.dirname(o.binary), 'espeak-ng-data');
  if (fs.existsSync(espeak)) args.push('--espeak_data', relativeTo(cwd, espeak));
  if (o.lengthScale && Number.isFinite(o.lengthScale)) args.push('--length_scale', String(Math.min(2, Math.max(0.5, o.lengthScale))));
  return new Promise((resolve, reject) => {
    const sp = o.spawnImpl || spawn;
    const child = sp(o.binary, args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];
    let err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, o.timeoutMs || 30000);
    const onAbort = () => { try { child.kill(); } catch { /* gone */ } };
    o.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (c) => chunks.push(c));
    child.stderr?.on('data', (c) => { err = (err + c).slice(-1500); });
    child.on('error', (e) => { clearTimeout(timer); reject(Object.assign(new Error(`piper: ${startError(-1, '', e, o.binary).message}`), { code: e.code === 'ENOENT' ? 'tts_missing' : 'tts_failed' })); });
    child.on('close', (code) => {
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);
      const pcm = Buffer.concat(chunks);
      if (o.signal?.aborted) return reject(Object.assign(new Error('stopped'), { code: 'aborted' }));
      if (code !== 0 || !pcm.length) return reject(Object.assign(new Error(`piper: ${code !== 0 ? startError(code, err, null, o.binary).message.replace(/^whisper-server stopped: /, '') : err.trim().split(/\r?\n/).pop() || 'no audio'}`), { code: 'tts_failed' }));
      resolve(pcmToWav(pcm.length % 2 ? pcm.subarray(0, pcm.length - 1) : pcm, rate));
    });
    child.stdin.end(`${text}\n`);
  });
}
