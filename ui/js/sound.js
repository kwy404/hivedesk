// Soft synthesized sounds (no audio files). Muted state follows settings.sound
// from the engine and is mirrored locally so it survives a reload before `hello`.

let ctx = null;
let muted = false;
try { muted = localStorage.getItem('hivedesk.muted') === '1'; } catch {}

export const isMuted = () => muted;
export function setMuted(v) {
  muted = !!v;
  try { localStorage.setItem('hivedesk.muted', muted ? '1' : '0'); } catch {}
}

function ac() {
  if (!ctx) {
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return null;
    ctx = new C();
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

// Browsers only allow audio after a user gesture: warm up on the first one.
addEventListener('pointerdown', () => { if (!muted) ac(); }, { once: true, capture: true });
addEventListener('keydown', () => { if (!muted) ac(); }, { once: true, capture: true });

function bell(c, t, freq, { dur = 1.1, gain = 0.06, type = 'sine' } = {}) {
  const out = c.createGain();
  out.gain.setValueAtTime(0.0001, t);
  out.gain.exponentialRampToValueAtTime(gain, t + 0.012);
  out.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  const lp = c.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 4200;
  out.connect(lp).connect(c.destination);
  for (const [mult, g] of [[1, 1], [2.01, 0.22], [3.98, 0.06]]) {
    const o = c.createOscillator();
    const og = c.createGain();
    o.type = type;
    o.frequency.value = freq * mult;
    og.gain.value = g;
    o.connect(og).connect(out);
    o.start(t);
    o.stop(t + dur + 0.05);
  }
}

const SOUNDS = {
  // a task finished: one soft chime
  task: (c, t) => { bell(c, t, 1318.5, { dur: 0.9, gain: 0.035 }); },
  // the whole job finished: a gentle rising triad
  job: (c, t) => { bell(c, t, 659.3, { gain: 0.045 }); bell(c, t + 0.11, 830.6, { gain: 0.04 }); bell(c, t + 0.22, 987.8, { dur: 1.6, gain: 0.045 }); },
  // waiting for the user's approval: two warm notes
  approval: (c, t) => { bell(c, t, 880, { dur: 0.6, gain: 0.04 }); bell(c, t + 0.16, 1174.7, { dur: 0.9, gain: 0.04 }); },
  // something failed: low and short, never harsh
  error: (c, t) => { bell(c, t, 392, { dur: 0.5, gain: 0.05, type: 'triangle' }); bell(c, t + 0.12, 311.1, { dur: 0.7, gain: 0.045, type: 'triangle' }); },
  // a soft tick for UI feedback (hire, model ready)
  tick: (c, t) => { bell(c, t, 1760, { dur: 0.35, gain: 0.022 }); },
};

export function play(name) {
  if (muted) return;
  const c = ac();
  if (!c || c.state !== 'running') return;
  const fn = globalThis.hivedeskSoundPack?.[name] || SOUNDS[name]; // the theme sound pack (ui/themes/sounds.js)
  if (fn) fn(c, c.currentTime + 0.01);
}

/** For the settings preview button; plays even if the context was never warmed. */
export function preview(name = 'job') {
  const c = ac();
  if (!c) return;
  const fn = globalThis.hivedeskSoundPack?.[name] || SOUNDS[name]; // the theme sound pack (ui/themes/sounds.js)
  if (fn) setTimeout(() => fn(c, c.currentTime + 0.02), 30);
}
