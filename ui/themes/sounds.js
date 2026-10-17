// Sound packs for themes, synthesized like ui/js/sound.js (no audio files). A pack is a map
// from the sound names (task, job, approval, error, tick) to (context, time) => void.
// "chime" is the desktop's own set, so it maps to null (sound.js uses its built-in sounds).

function tone(c, t, freq, { dur = 0.4, gain = 0.04, type = 'sine', attack = 0.008, cutoff = 5000 } = {}) {
  const out = c.createGain();
  out.gain.setValueAtTime(0.0001, t);
  out.gain.exponentialRampToValueAtTime(gain, t + attack);
  out.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  const lp = c.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = cutoff;
  out.connect(lp).connect(c.destination);
  const o = c.createOscillator();
  o.type = type;
  o.frequency.value = freq;
  o.connect(out);
  o.start(t);
  o.stop(t + dur + 0.05);
}

const silent = () => {};

export const PACKS = {
  chime: null,
  soft: {
    task: (c, t) => tone(c, t, 784, { dur: 0.7, gain: 0.025, cutoff: 2400 }),
    job: (c, t) => { tone(c, t, 523.3, { dur: 0.9, gain: 0.03, cutoff: 2200 }); tone(c, t + 0.14, 659.3, { dur: 1.1, gain: 0.03, cutoff: 2200 }); },
    approval: (c, t) => { tone(c, t, 587.3, { dur: 0.5, gain: 0.028, cutoff: 2200 }); tone(c, t + 0.18, 740, { dur: 0.7, gain: 0.028, cutoff: 2200 }); },
    error: (c, t) => tone(c, t, 293.7, { dur: 0.6, gain: 0.035, type: 'triangle', cutoff: 1400 }),
    tick: (c, t) => tone(c, t, 1046.5, { dur: 0.25, gain: 0.015, cutoff: 2600 })
  },
  wood: {
    task: (c, t) => tone(c, t, 880, { dur: 0.22, gain: 0.06, type: 'triangle', attack: 0.002, cutoff: 3200 }),
    job: (c, t) => { [659.3, 784, 987.8].forEach((f, i) => tone(c, t + i * 0.09, f, { dur: 0.26, gain: 0.055, type: 'triangle', attack: 0.002, cutoff: 3200 })); },
    approval: (c, t) => { tone(c, t, 698.5, { dur: 0.2, gain: 0.05, type: 'triangle', attack: 0.002 }); tone(c, t + 0.12, 880, { dur: 0.24, gain: 0.05, type: 'triangle', attack: 0.002 }); },
    error: (c, t) => { tone(c, t, 349.2, { dur: 0.22, gain: 0.06, type: 'triangle', attack: 0.002 }); tone(c, t + 0.1, 261.6, { dur: 0.3, gain: 0.06, type: 'triangle', attack: 0.002 }); },
    tick: (c, t) => tone(c, t, 1318.5, { dur: 0.08, gain: 0.03, type: 'triangle', attack: 0.001 })
  },
  pixel: {
    task: (c, t) => { tone(c, t, 988, { dur: 0.08, gain: 0.02, type: 'square', attack: 0.001 }); tone(c, t + 0.08, 1319, { dur: 0.12, gain: 0.02, type: 'square', attack: 0.001 }); },
    job: (c, t) => { [523, 659, 784, 1047].forEach((f, i) => tone(c, t + i * 0.08, f, { dur: 0.1, gain: 0.02, type: 'square', attack: 0.001 })); },
    approval: (c, t) => { tone(c, t, 784, { dur: 0.09, gain: 0.02, type: 'square', attack: 0.001 }); tone(c, t + 0.12, 784, { dur: 0.09, gain: 0.02, type: 'square', attack: 0.001 }); },
    error: (c, t) => { tone(c, t, 196, { dur: 0.14, gain: 0.025, type: 'square', attack: 0.001, cutoff: 1800 }); tone(c, t + 0.14, 147, { dur: 0.2, gain: 0.025, type: 'square', attack: 0.001, cutoff: 1800 }); },
    tick: (c, t) => tone(c, t, 1568, { dur: 0.05, gain: 0.015, type: 'square', attack: 0.001 })
  },
  off: { task: silent, job: silent, approval: silent, error: silent, tick: silent }
};

let ctx = null;
/** Plays one sound of a pack right away (the editor's preview button). */
export function previewPack(pack, name = 'job') {
  const p = PACKS[pack];
  if (!p) return false;
  const C = window.AudioContext || window.webkitAudioContext;
  if (!C) return false;
  ctx = ctx || new C();
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  p[name]?.(ctx, ctx.currentTime + 0.02);
  return true;
}
