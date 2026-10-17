// Soft ambient sounds for the Office, synthesized with Web Audio (no files).
// Quiet by design: a warm room tone, keyboard ticks while bees type, a light wing hum
// while someone flies, and small pops for notes and hand offs. Mutable, and it also
// follows the global sound switch of the top bar.

import { isMuted } from '/js/sound.js';

const KEY = 'hivedesk.office.ambient';
let ctx = null;
let master = null;
let room = null;
let buzz = null;
let on = true;
try { on = localStorage.getItem(KEY) !== '0'; } catch { /* storage may be blocked */ }
let active = false;
let typing = 0;
let flying = 0;
let tickTimer = null;

export const ambientOn = () => on;

export function setAmbient(v) {
  on = !!v;
  try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* ignore */ }
  apply();
}

/** The Office is on screen (true) or hidden (false). */
export function setActive(v) { active = !!v; apply(); }

function audible() { return on && active && !isMuted() && !document.hidden; }

function ac() {
  if (!ctx) {
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return null;
    ctx = new C();
    master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

function noiseBuffer(c, seconds, brown) {
  const len = Math.floor(c.sampleRate * seconds);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    if (brown) { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.2; } else d[i] = w;
  }
  return buf;
}

function startRoom(c) {
  if (room) return;
  const src = c.createBufferSource();
  src.buffer = noiseBuffer(c, 4, true);
  src.loop = true;
  const lp = c.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 520;
  const g = c.createGain();
  g.gain.value = 0.05;
  // a slow swell so the room breathes
  const lfo = c.createOscillator();
  const lg = c.createGain();
  lfo.frequency.value = 0.07;
  lg.gain.value = 0.018;
  lfo.connect(lg).connect(g.gain);
  src.connect(lp).connect(g).connect(master);
  src.start();
  lfo.start();
  room = { src, lfo };

  // the wing hum, faded in while someone flies
  const o = c.createOscillator();
  o.type = 'sawtooth';
  o.frequency.value = 196;
  const vib = c.createOscillator();
  const vg = c.createGain();
  vib.frequency.value = 23;
  vg.gain.value = 9;
  vib.connect(vg).connect(o.frequency);
  const bl = c.createBiquadFilter();
  bl.type = 'lowpass';
  bl.frequency.value = 700;
  const bg = c.createGain();
  bg.gain.value = 0;
  o.connect(bl).connect(bg).connect(master);
  o.start();
  vib.start();
  buzz = bg;
}

function apply() {
  if (!audible()) {
    if (master && ctx) master.gain.setTargetAtTime(0, ctx.currentTime, 0.15);
    clearInterval(tickTimer);
    tickTimer = null;
    return;
  }
  const c = ac();
  if (!c) return;
  startRoom(c);
  master.gain.setTargetAtTime(0.9, c.currentTime, 0.4);
  if (!tickTimer) tickTimer = setInterval(ticks, 90);
  setLevels(typing, flying);
}

function ticks() {
  if (!typing || !audible() || !ctx || ctx.state !== 'running') return;
  if (Math.random() > Math.min(0.75, 0.3 + typing * 0.2)) return;
  const t = ctx.currentTime + Math.random() * 0.05;
  const src = ctx.createBufferSource();
  src.buffer = clickBuf || (clickBuf = noiseBuffer(ctx, 0.03, false));
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 2400 + Math.random() * 1800;
  bp.Q.value = 2.5;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.05, t + 0.003);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.035);
  src.connect(bp).connect(g).connect(master);
  src.start(t);
  src.stop(t + 0.05);
}
let clickBuf = null;

/** How many bees type and fly right now; called every frame, cheap when nothing changes. */
let lastAudible = null;
export function setLevels(nTyping, nFlying) {
  typing = nTyping;
  const au = audible();
  if (au !== lastAudible) { lastAudible = au; apply(); }
  if (nFlying !== flying || buzz) {
    flying = nFlying;
    if (buzz && ctx) buzz.gain.setTargetAtTime(audible() && flying ? Math.min(0.012, 0.006 + flying * 0.003) : 0, ctx.currentTime, 0.12);
  }
}

function tone(c, t, freq, { dur = 0.18, gain = 0.035, type = 'sine', to } = {}) {
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur * 0.8);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master);
  o.start(t);
  o.stop(t + dur + 0.02);
}

const FX = {
  pop: (c, t) => { tone(c, t, 520, { to: 880, dur: 0.14, gain: 0.04 }); },
  blip: (c, t) => { tone(c, t, 990, { dur: 0.08, gain: 0.012 }); tone(c, t + 0.05, 1320, { dur: 0.08, gain: 0.01 }); },
  stick: (c, t) => { tone(c, t, 300, { to: 180, dur: 0.09, gain: 0.04, type: 'triangle' }); },
  peel: (c, t) => { tone(c, t, 700, { to: 1100, dur: 0.07, gain: 0.015, type: 'triangle' }); },
  whoosh: (c, t) => {
    const src = c.createBufferSource();
    src.buffer = noiseBuffer(c, 0.4, false);
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass'; bp.Q.value = 1.2;
    bp.frequency.setValueAtTime(500, t); bp.frequency.exponentialRampToValueAtTime(1600, t + 0.3);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.025, t + 0.08); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.38);
    src.connect(bp).connect(g).connect(master); src.start(t); src.stop(t + 0.4);
  },
  pass: (c, t) => { tone(c, t, 880, { dur: 0.16, gain: 0.03 }); tone(c, t + 0.09, 1318.5, { dur: 0.3, gain: 0.03 }); },
  fail: (c, t) => { tone(c, t, 330, { dur: 0.2, gain: 0.035, type: 'triangle' }); tone(c, t + 0.12, 262, { dur: 0.3, gain: 0.03, type: 'triangle' }); },
  stuck: (c, t) => { tone(c, t, 660, { dur: 0.25, gain: 0.02, type: 'triangle' }); },
  level: (c, t) => { [784, 988, 1175, 1568].forEach((f, i) => tone(c, t + i * 0.07, f, { dur: 0.22, gain: 0.025 })); },
  confetti: (c, t) => { for (let i = 0; i < 7; i++) tone(c, t + i * 0.045 + Math.random() * 0.02, 900 + Math.random() * 900, { dur: 0.1, gain: 0.012 }); },
  build: (c, t) => { for (let i = 0; i < 4; i++) tone(c, t + 0.25 + i * 0.22, 150, { to: 90, dur: 0.12, gain: 0.06, type: 'triangle' }); tone(c, t + 1.3, 1046.5, { dur: 0.4, gain: 0.03 }); },
  type: () => {},
};

let lastFx = {};
export function fx(name) {
  if (!audible() || !ctx || ctx.state !== 'running') return;
  const now = performance.now();
  if (now - (lastFx[name] || 0) < 70) return;
  lastFx[name] = now;
  const f = FX[name];
  if (f) f(ctx, ctx.currentTime + 0.01);
}

document.addEventListener('visibilitychange', apply);
