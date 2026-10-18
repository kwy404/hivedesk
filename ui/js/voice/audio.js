// Audio helpers for voice mode, pure so they run in the tests: resample the microphone to 16 kHz,
// keep a short pre roll so the first syllable is not cut, and write the 16 bit WAV the engine takes.

export const STT_RATE = 16000;

/** Linear resampling of mono float samples. */
export function resample(input, from, to = STT_RATE) {
  if (from === to) return Float32Array.from(input);
  const ratio = from / to;
  const n = Math.floor(input.length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i * ratio;
    const j = Math.floor(x);
    const f = x - j;
    const a = input[j] ?? 0;
    const b = input[j + 1] ?? a;
    out[i] = a + (b - a) * f;
  }
  return out;
}

/** 16 bit PCM mono WAV bytes. */
export function encodeWav(samples, rate = STT_RATE) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buf);
}

/**
 * Collects one turn of speech: a ring of the last preRollMs while quiet, everything from the start
 * of speech until the end. Samples are already at 16 kHz.
 */
export function createRecorder({ preRollMs = 350, maxMs = 30000, rate = STT_RATE } = {}) {
  const pre = Math.round((preRollMs / 1000) * rate);
  const max = Math.round((maxMs / 1000) * rate);
  let ring = [];
  let ringLen = 0;
  let turn = null;
  let turnLen = 0;
  return {
    push(chunk) {
      if (turn) {
        if (turnLen < max) { turn.push(chunk); turnLen += chunk.length; }
        return;
      }
      ring.push(chunk);
      ringLen += chunk.length;
      while (ring.length > 1 && ringLen - ring[0].length >= pre) ringLen -= ring.shift().length;
    },
    /** Speech started: keep the pre roll. */
    begin() { turn = ring.slice(); turnLen = ringLen; ring = []; ringLen = 0; },
    /** Speech ended: the samples of the turn. */
    end() {
      const parts = turn || [];
      turn = null;
      const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
      let o = 0;
      for (const p of parts) { out.set(p, o); o += p.length; }
      turnLen = 0;
      return out;
    },
    get recording() { return !!turn; },
  };
}

/** Joins two turns (the user went on talking after a pause that looked like the end). */
export function concat(a, b) {
  const out = new Float32Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
