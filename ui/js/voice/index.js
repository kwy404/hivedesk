// Voice mode in the browser: the mic button, push to talk (hold Ctrl+Space) or toggle, the
// floating orb (waveform while listening, spinner while thinking), Mel's spoken replies in the
// UI language, the confirmation card, and the Voice section of Settings.
//
// Honest about privacy: the browser's speech recognition may send audio to the browser maker's
// service. Mel's voice (speechSynthesis) is made on this computer when a local voice exists.
// A fully local recognizer is shown as "coming soon": it is not shipped yet.

import { h, icon, reducedMotion } from '../dom.js';
import { t, locale, onLocale, LOCALES } from '../i18n.js';
import { S, ui, worker, currentJob, jobTasks } from '../store.js';
import { command } from '../net.js';
import * as act from '../actions.js';
import * as wm from '../wm.js';
import { setTip } from '../tooltip.js';
import { createVoiceSession } from './session.js';
import { createListener, recognizerClass, speechLang } from './listener.js';

const KEY = 'hivedesk.voice';
const defaults = { voice: '', rate: 1, autoSpeak: true, mode: 'push', privacySeen: false };
const prefs = (() => { try { return { ...defaults, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return { ...defaults }; } })();
const savePrefs = () => { try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch {} };

const Recognition = recognizerClass();
export const supported = !!Recognition;
const canSpeak = typeof speechSynthesis !== 'undefined';

let orb = null;
let parts = {};
let listener = null;
let phase = 'idle'; // idle | listening | thinking | speaking
let micBtn = null;
let meter = null;

/* ---------- speaking ---------- */

export function voicesFor(code = locale()) {
  if (!canSpeak) return [];
  const tag = speechLang(code).toLowerCase();
  const lang = tag.split('-')[0];
  return speechSynthesis.getVoices().filter((v) => v.lang && (v.lang.toLowerCase() === tag || v.lang.toLowerCase().split(/[-_]/)[0] === lang));
}

function pickVoice() {
  const list = voicesFor();
  if (!list.length) return null;
  return list.find((v) => v.voiceURI === prefs.voice)
    || list.find((v) => /natural/i.test(v.name) && v.lang.toLowerCase() === speechLang(locale()).toLowerCase())
    || list.find((v) => v.lang.toLowerCase() === speechLang(locale()).toLowerCase() && v.localService)
    || list.find((v) => v.lang.toLowerCase() === speechLang(locale()).toLowerCase())
    || list[0];
}

function speak(text) {
  if (!canSpeak || !prefs.autoSpeak || !text) return Promise.resolve();
  return new Promise((resolve) => {
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      const v = pickVoice();
      if (v) u.voice = v;
      u.lang = v?.lang || speechLang(locale());
      u.rate = prefs.rate;
      u.onstart = () => setPhase('speaking');
      const end = () => { if (phase === 'speaking') setPhase('idle'); resolve(); };
      u.onend = end;
      u.onerror = end;
      speechSynthesis.speak(u);
      setTimeout(resolve, Math.min(20000, 1500 + text.length * 90));
    } catch { resolve(); }
  });
}

/* ---------- what Mel can do ---------- */

function statusText() {
  const s = S();
  const j = currentJob(s);
  if (!j) return t('voice.say.statusIdle');
  if (j.status === 'planning') return t('voice.say.statusPlanning', { request: j.request });
  const tasks = jobTasks(s, j);
  const done = tasks.filter((x) => x.status === 'done').length;
  const running = (s.queue.running || []).map((q) => worker(q.workerId).name);
  const waiting = (s.approvals || []).length;
  if (j.status === 'running') {
    return t('voice.say.statusRunning', { done, count: tasks.length, who: running.join(', ') || t('voice.say.nobody'), approvals: waiting });
  }
  return t('voice.say.statusEnded', { status: j.status, request: j.request });
}

/** The client side of runIntent: github.intent, a confirmation, then github.confirm or github.cancel. */
async function runIntent(text, { confirm }) {
  const r = await command('github.intent', { text });
  if (!r?.plan) return { ok: false, ran: false, message: r?.message || t('voice.say.noGit') };
  const yes = (await confirm(r.plan)) === true;
  if (!yes) { command('github.cancel', { planId: r.plan.id }).catch(() => {}); return { ok: true, ran: false, plan: r.plan }; }
  const result = await command('github.confirm', { planId: r.plan.id });
  return { ok: true, ran: true, plan: r.plan, result };
}

const session = createVoiceSession({
  t,
  lang: () => locale(),
  speak,
  onUpdate: (st) => paint(st),
  actions: {
    createJob: (request) => act.createJob(request),
    approvals: () => S().approvals || [],
    resolveApproval: (id, ok) => act.resolveApproval(id, ok),
    status: statusText,
    openWindow: (type) => { if (!wm.typeDef(type)) return false; wm.open(type); return true; },
    runIntent,
    planTitle: (plan) => (plan.titleKey && t(plan.titleKey, plan.titleParams) !== plan.titleKey ? t(plan.titleKey, plan.titleParams) : plan.title),
  },
});

/* ---------- the orb ---------- */

function buildOrb() {
  parts.label = h('div', { class: 'vo-label' });
  parts.heard = h('div', { class: 'vo-heard', 'aria-live': 'polite' });
  parts.reply = h('div', { class: 'vo-reply', 'aria-live': 'polite' });
  parts.bars = h('div', { class: 'vo-wave', 'aria-hidden': 'true' }, Array.from({ length: 7 }, () => h('i')));
  parts.ball = h('button', { type: 'button', class: 'vo-ball', ta: 'voice.mic', tip: 'tip.voice.ball', on: { click: () => toggle() } },
    h('img', { src: '/assets/crew/mel.svg', alt: '', width: 44, height: 44, onerror: (e) => { e.target.src = '/assets/mascot-dark.svg'; } }), h('span', { class: 'vo-spin', 'aria-hidden': 'true' }));
  parts.card = h('div', { class: 'vo-card', hidden: true });
  parts.note = h('div', { class: 'vo-note', hidden: true });
  const close = h('button', { type: 'button', class: 'ibtn ibtn-sm vo-x', ta: 'voice.close', tip: 'tip.voice.close', kb: 'Esc', on: { click: () => hideOrb() } }, icon('x', 'ico-sm'));
  orb = h('div', { class: 'vo', role: 'dialog', 'aria-modal': 'false', ta: 'voice.title', hidden: true },
    h('div', { class: 'vo-top' }, parts.ball, h('div', { class: 'grow' }, parts.label, parts.bars), close),
    parts.heard, parts.reply, parts.card, parts.note);
  orb.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); hideOrb(); } });
  document.body.append(orb);
  onLocale(() => paint(session.state));
}

function showOrb() {
  if (!orb) buildOrb();
  if (orb.hidden) {
    orb.hidden = false;
    requestAnimationFrame(() => orb.classList.add('on'));
  }
  if (!prefs.privacySeen) {
    parts.note.hidden = false;
    parts.note.replaceChildren(icon('lock', 'ico-sm'), h('span', { text: t('voice.privacy') }),
      h('button', { type: 'button', class: 'btn btn-xs btn-quiet', text: t('voice.gotIt'), on: { click: () => { prefs.privacySeen = true; savePrefs(); parts.note.hidden = true; } } }));
  }
}

function hideOrb() {
  listener?.abort();
  if (canSpeak) speechSynthesis.cancel();
  if (session.pending) session.cancel();
  setPhase('idle');
  if (!orb) return;
  orb.classList.remove('on');
  setTimeout(() => { if (!orb.classList.contains('on')) orb.hidden = true; }, reducedMotion() ? 0 : 220);
  micBtn?.focus({ preventScroll: true });
}

function setPhase(p) {
  phase = p;
  if (orb) orb.dataset.phase = p;
  if (micBtn) { micBtn.dataset.phase = p; micBtn.setAttribute('aria-pressed', String(p === 'listening')); }
  if (p === 'listening') startMeter(); else stopMeter();
  paint(session.state);
}

function paint(st) {
  if (!orb) return;
  parts.label.textContent = t(`voice.phase.${phase}`);
  parts.heard.textContent = st.heard ? `"${st.heard}"` : '';
  parts.reply.textContent = st.reply || '';
  const p = st.pending;
  parts.card.hidden = !p;
  if (p) {
    parts.card.replaceChildren(
      h('div', { class: 'vo-card-t', text: p.summary }),
      p.details?.length ? h('ul', { class: 'vo-card-d' }, p.details.slice(0, 6).map((d) => h('li', { text: d }))) : null,
      h('div', { class: 'vo-card-h tiny muted', text: t('voice.card.say') }),
      h('div', { class: 'row vo-card-a' },
        h('button', { type: 'button', class: 'btn btn-sm btn-primary', text: t('voice.card.confirm'), tip: 'tip.voice.confirm', on: { click: () => session.confirm() } }),
        h('button', { type: 'button', class: 'btn btn-sm btn-quiet', text: t('voice.card.cancel'), tip: 'tip.voice.cancel', on: { click: () => session.cancel() } })));
  }
}

/* waveform: the real microphone level when the browser allows it, a gentle pulse otherwise */
let meterStop = null;
async function startMeter() {
  stopMeter();
  if (!orb || reducedMotion() || !navigator.mediaDevices?.getUserMedia) return;
  let stream; let ctx; let raf = 0; let stopped = false;
  meterStop = () => { stopped = true; cancelAnimationFrame(raf); stream?.getTracks().forEach((x) => x.stop()); ctx?.close().catch(() => {}); orb?.classList.remove('vo-live'); };
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (stopped) { stream.getTracks().forEach((x) => x.stop()); return; }
    ctx = new AudioContext();
    const an = ctx.createAnalyser();
    an.fftSize = 64;
    ctx.createMediaStreamSource(stream).connect(an);
    const data = new Uint8Array(an.frequencyBinCount);
    const bars = [...parts.bars.children];
    orb.classList.add('vo-live');
    const loop = () => {
      an.getByteFrequencyData(data);
      bars.forEach((b, i) => { const v = data[2 + i * 3] / 255; b.style.transform = `scaleY(${(0.15 + v * 0.85).toFixed(3)})`; });
      raf = requestAnimationFrame(loop);
    };
    loop();
  } catch { /* the CSS pulse stays */ }
}
function stopMeter() { meterStop?.(); meterStop = null; if (parts.bars) for (const b of parts.bars.children) b.style.transform = ''; }

/* ---------- listening ---------- */

function ensureListener() {
  if (listener || !supported) return listener;
  listener = createListener(Recognition, {
    lang: speechLang(locale()),
    onStart: () => setPhase('listening'),
    onInterim: (text) => { session.state.heard = text; paint(session.state); },
    onEnd: () => { if (phase === 'listening') setPhase('idle'); },
    onFinal: (text) => {
      setPhase('thinking');
      session.hear(text).finally(() => { if (phase === 'thinking') setPhase('idle'); });
    },
    onError: (code) => {
      setPhase('idle');
      const key = { 'not-allowed': 'voice.err.denied', 'service-not-allowed': 'voice.err.denied', 'language-not-supported': 'voice.err.lang', network: 'voice.err.network', 'no-speech': 'voice.err.silence', 'audio-capture': 'voice.err.mic' }[code];
      if (key) { session.state.reply = t(key); paint(session.state); }
    },
  });
  onLocale(() => { listener?.abort(); listener = null; });
  return listener;
}

export function start() {
  showOrb();
  if (!supported) { session.state.reply = t('voice.err.unsupported'); paint(session.state); return; }
  if (canSpeak) speechSynthesis.cancel();
  ensureListener()?.start();
}
export function stop() { listener?.stop(); }
export function toggle() { if (listener?.active) stop(); else start(); }

/** Feeds a typed sentence to Mel, as if spoken (also used by the tests in the browser). */
export function say(text) { showOrb(); setPhase('thinking'); return session.hear(text).finally(() => setPhase('idle')); }

// Push to talk: hold Ctrl+Space. In toggle mode a press starts or stops.
let holding = false;
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey && (e.code === 'Space' || e.key === ' '))) return;
  e.preventDefault();
  if (e.repeat) return;
  if (prefs.mode === 'toggle') { toggle(); return; }
  if (!holding) { holding = true; start(); }
}, true);
document.addEventListener('keyup', (e) => {
  if (!holding) return;
  if (e.code === 'Space' || e.key === ' ' || e.key === 'Control') { holding = false; stop(); }
}, true);

/* ---------- top bar button ---------- */

export function micButton() {
  micBtn = h('button', { type: 'button', class: 'ibtn mic-btn', ta: 'voice.mic', 'aria-pressed': 'false', dataset: { tipPos: 'bottom', tour: 'voice' } },
    h('span', { html: '<svg class="ico" viewBox="0 0 24 24"><rect x="9" y="3.5" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v2.5"/></svg>' }));
  const paintTip = () => setTip(micBtn, { key: 'tip.voice.mic', title: t('tip.voice.mic.title'), help: supported ? t(prefs.mode === 'toggle' ? 'tip.voice.mic.helpToggle' : 'tip.voice.mic.help') : t('voice.err.unsupported'), kb: 'Ctrl Space' });
  paintTip();
  onLocale(paintTip);
  micBtn.addEventListener('click', () => toggle());
  if (!supported) micBtn.classList.add('mic-off');
  return micBtn;
}

/* ---------- Settings: the Voice section ---------- */

export function voiceSettings() {
  const sec = h('section', { class: 'set-sec set-voice', 'aria-labelledby': 'set-voice-h' });
  const render = () => {
    const voices = voicesFor();
    const sel = h('select', { class: 'input', id: 'vo-voice', tip: 'tip.voice.voice', on: { change: (e) => { prefs.voice = e.target.value; savePrefs(); speak(t('voice.sample')); } } },
      h('option', { value: '', text: t('voice.set.auto') }),
      voices.map((v) => h('option', { value: v.voiceURI, text: `${v.name} (${v.lang})`, selected: v.voiceURI === prefs.voice })));
    const rate = h('input', { type: 'range', min: '0.7', max: '1.4', step: '0.05', value: String(prefs.rate), id: 'vo-rate', tip: 'tip.voice.rate', on: { change: (e) => { prefs.rate = Number(e.target.value); savePrefs(); speak(t('voice.sample')); } } });
    const auto = h('input', { type: 'checkbox', id: 'vo-auto', checked: prefs.autoSpeak, tip: 'tip.voice.autoSpeak', on: { change: (e) => { prefs.autoSpeak = e.target.checked; savePrefs(); } } });
    const mode = h('div', { class: 'seg', role: 'radiogroup', 'aria-labelledby': 'vo-mode-l' },
      ['push', 'toggle'].map((m) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(prefs.mode === m), tip: `tip.voice.mode.${m}`, text: t(`voice.set.mode.${m}`), on: { click: () => { prefs.mode = m; savePrefs(); render(); } } })));
    const engine = h('div', { class: 'seg', role: 'radiogroup', 'aria-labelledby': 'vo-engine-l' },
      h('button', { type: 'button', role: 'radio', 'aria-checked': 'true', tip: 'tip.voice.engine.browser', text: t('voice.set.engine.browser') }),
      h('button', { type: 'button', role: 'radio', 'aria-checked': 'false', 'aria-disabled': 'true', class: 'soon', tip: 'tip.voice.engine.local' }, t('voice.set.engine.local'), h('span', { class: 'hchip hchip-honey', text: t('voice.set.soon') })));
    sec.replaceChildren(
      h('h3', { id: 'set-voice-h', class: 'set-h', tip: 'tip.voice.section', text: t('voice.set.title') }),
      h('p', { class: 'small muted', text: supported ? t('voice.set.lead') : t('voice.err.unsupported') }),
      h('div', { class: 'set-row' }, h('span', { id: 'vo-engine-l', class: 'set-l', text: t('voice.set.engine') }), engine),
      h('p', { class: 'tiny muted vo-privacy' }, icon('lock', 'ico-sm'), ' ', t('voice.privacy'), ' ', t('voice.set.localNote')),
      h('div', { class: 'set-row' }, h('label', { class: 'set-l', for: 'vo-voice', text: t('voice.set.voice') }), sel),
      !voices.length ? h('p', { class: 'tiny muted', text: t('voice.set.noVoice', { lang: LOCALES.find((l) => l.code === locale())?.name || locale() }) }) : null,
      h('div', { class: 'set-row' }, h('label', { class: 'set-l', for: 'vo-rate', text: t('voice.set.rate') }), rate, h('span', { class: 'mono tiny', text: `${prefs.rate.toFixed(2)}x` })),
      h('div', { class: 'set-row' }, h('label', { class: 'set-l', for: 'vo-auto', text: t('voice.set.autoSpeak') }), auto),
      h('div', { class: 'set-row' }, h('span', { id: 'vo-mode-l', class: 'set-l', text: t('voice.set.mode') }), mode),
      h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn btn-sm btn-quiet', tip: 'tip.voice.test', text: t('voice.set.test'), on: { click: () => speak(t('voice.sample')) } })));
  };
  render();
  const off = onLocale(render);
  if (canSpeak) speechSynthesis.addEventListener?.('voiceschanged', render);
  return { el: sec, dispose: () => { off(); if (canSpeak) speechSynthesis.removeEventListener?.('voiceschanged', render); } };
}

window.hivedeskVoice = { supported, start, stop, toggle, say, get pending() { return session.pending; }, session };
void ui;
