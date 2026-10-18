// Shared test helpers for voice mode: the translator of a locale with the voice part files merged
// over the main strings, the way the window merges them (ui/js/voice/strings.js).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { translator } from '../../i18n/index.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'i18n');
const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { return {}; } };

export function table(code) {
  return { ...read(`${code}.json`), ...read(`parts/voice.${code}.json`) };
}

export function tr(code) {
  return translator(code, table(code), table('en'));
}

/** A sine tone (speech stand in) or silence, in 20 ms blocks at 16 kHz. */
export function blocks(ms, amp = 0, rate = 16000, freq = 220) {
  const n = Math.round((ms / 20));
  const size = rate / 50;
  const out = [];
  for (let b = 0; b < n; b++) {
    const f = new Float32Array(size);
    for (let i = 0; i < size; i++) f[i] = amp * Math.sin((2 * Math.PI * freq * (b * size + i)) / rate) + (amp ? 0 : (Math.random() - 0.5) * 0.0004);
    out.push(f);
  }
  return out;
}
