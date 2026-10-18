// Voice mode in the browser: talk to Mel like a person. One tap on the mic (or Ctrl+Space, or the
// wake word "Mel" when it is on) opens a hands free conversation: Mel listens, knows when you are
// done, answers out loud sentence by sentence while the text appears, stops at once when you talk
// over her, and listens again for the follow up. "That is all", Esc or a tap ends it.
//
// Privacy: speech to text runs on this computer by default (whisper.cpp in the engine, the audio
// goes only to 127.0.0.1). The browser's recognizer is an opt in fallback with an honest notice: the
// browser maker may process that audio in its cloud. Mel's voice is the system voices or the local
// Piper voice. Mel always asks before she acts (session.js).

import { h, icon, reducedMotion, clear, append } from '../dom.js';
import { t, locale, onLocale, LOCALES, setLocale } from '../i18n.js';
import { format } from '/i18n/index.js';
import { S, worker, currentJob, jobTasks, onEvent } from '../store.js';
import { command, on as onFrame, token } from '../net.js';
import * as act from '../actions.js';
import * as wm from '../wm.js';
import { setTip } from '../tooltip.js';
import { openDialog } from '../dialog.js';
import { play } from '../sound.js';
import { createVoiceSession } from './session.js';
import { msgText } from '../widgets/chat.js';
import { createListener, recognizerClass, speechLang } from './listener.js';
import { createConversation } from './conversation.js';
import { createSpeaker } from './speaker.js';
import { createMic } from './mic.js';
import { encodeWav } from './audio.js';
import { chooseStt, chooseTts, sttPlan, modelHint } from './engines.js';
import { matchWake } from './wake.js';
import { validCard } from './questions.js';

const KEY = 'hivedesk.voice';
const defaults = { voice: '', rate: 1, autoSpeak: true, talk: 'hands', wake: false, stt: 'local', browserOk: false, tts: 'system', privacySeen: false };
const prefs = (() => {
  try {
    const p = { ...defaults, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
    if (p.mode && !p.talk) p.talk = p.mode === 'push' ? 'push' : 'hands';
    return p;
  } catch { return { ...defaults }; }
})();
const savePrefs = () => { try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch {} };

const Recognition = recognizerClass();
const canSpeak = typeof speechSynthesis !== 'undefined';
const canListen = !!navigator.mediaDevices?.getUserMedia;
export const supported = canListen || !!Recognition;

/* ---------- strings: the voice part files over the main ones ---------- */

let parts = {};
async function loadStrings() {
  try { parts = (await command('voice.strings', { lang: locale() })).strings || {}; } catch { parts = {}; }
  paint();
  settingsRender?.();
}
/** A voice string in the current language (the part file first, then the main strings). */
export function vt(key, params) {
  const m = parts[key];
  if (m != null) { try { return format(locale(), m, params); } catch { return m; } }
  return t(key, params);
}
onLocale(() => { loadStrings(); listener = null; });

/* ---------- engine status ---------- */

let status = null;
const downloads = new Map(); // id -> { received, total, error? }
async function refreshStatus() {
  try { status = await command('voice.status', {}, { timeout: 20000 }); } catch { status = null; }
  paint();
  settingsRender?.();
  return status;
}
onFrame('live', (f) => {
  if (f.type !== 'voice.download') return;
  const d = f.data || {};
  if (d.done) { downloads.delete(d.id); refreshStatus(); } else downloads.set(d.id, d);
  paintDownloads();
});

const sttChoice = () => chooseStt({ engine: prefs.stt, browserOk: prefs.browserOk }, { localReady: !!status?.stt?.ready, browserAvailable: !!Recognition });
const ttsChoice = () => (prefs.autoSpeak ? chooseTts({ tts: prefs.tts }, { piperReady: status?.tts?.ready || [], lang: locale(), systemAvailable: canSpeak }) : 'none');

/* ---------- Mel's voice ---------- */

export function voicesFor(code = locale()) {
  if (!canSpeak) return [];
  const tag = speechLang(code).toLowerCase();
  const lang = tag.split('-')[0];
  return speechSynthesis.getVoices().filter((v) => v.lang && (v.lang.toLowerCase().replace('_', '-') === tag || v.lang.toLowerCase().split(/[-_]/)[0] === lang));
}

function pickVoice() {
  const list = voicesFor();
  if (!list.length) return null;
  const tag = speechLang(locale()).toLowerCase();
  const same = (v) => v.lang.toLowerCase().replace('_', '-') === tag;
  return list.find((v) => v.voiceURI === prefs.voice)
    || list.find((v) => /natural|neural|online/i.test(v.name) && same(v))
    || list.find((v) => same(v) && v.localService)
    || list.find(same)
    || list[0];
}

let playCtx = null;
let outAnalyser = null;
const audioOut = () => {
  if (!playCtx) {
    try { playCtx = new AudioContext(); outAnalyser = playCtx.createAnalyser(); outAnalyser.fftSize = 512; outAnalyser.connect(playCtx.destination); } catch { playCtx = null; }
  }
  if (playCtx?.state === 'suspended') playCtx.resume().catch(() => {});
  return playCtx;
};

const authHeaders = (extra = {}) => ({ ...extra, ...(token ? { Authorization: `Bearer ${token}` } : {}) });

let conv = null;
const speaker = createSpeaker({
  engine: ttsChoice,
  synth: canSpeak ? speechSynthesis : null,
  Utterance: typeof SpeechSynthesisUtterance !== 'undefined' ? SpeechSynthesisUtterance : null,
  voice: pickVoice,
  lang: () => speechLang(locale()),
  rate: () => prefs.rate,
  audio: audioOut,
  output: () => outAnalyser,
  // Piper on this computer: the engine answers with a WAV for one sentence
  fetchWav: async (text, signal) => {
    const r = await fetch('/api/voice/tts', { method: 'POST', headers: authHeaders({ 'content-type': 'application/json' }), body: JSON.stringify({ text, lang: locale(), rate: prefs.rate }), signal });
    if (!r.ok) throw new Error(`tts ${r.status}`);
    return r.arrayBuffer();
  },
  onStart: () => conv?.speakStart(),
  onIdle: () => conv?.speakEnd(),
});

const speak = (text) => speaker.say(text);

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

/**
 * Git and GitHub go through runIntent(text, { confirm }) from the GitHub module (ui/github/):
 * it plans, calls our confirm (Mel reads the plan and waits for a clear yes) and only then runs.
 */
let gh = null;
async function github() {
  gh ||= Promise.all([import('/github/index.js'), import('/github/t.js')]).then(([m, tm]) => ({ ...m, T: tm.T }));
  return gh;
}
async function runIntent(text, opts) {
  const m = await github();
  return m.runIntent(text, { ...opts, quiet: true });
}
let ghT = null;
github().then((m) => { ghT = m; }).catch(() => {});
const planTitle = (plan) => {
  if (ghT && plan.titleKey) { const s = ghT.T(plan.titleKey, plan.titleParams); if (s && s !== plan.titleKey) return s; }
  return plan.title || '';
};
const planSteps = (plan) => (plan.steps || []).map((st) => { try { return ghT ? ghT.stepLabel(st, plan) : st.text; } catch { return st.text; } }).filter(Boolean);

/**
 * Without the voice plug-in: send to #general and wait for the reply. jobs: false, so the chat can
 * never start a job from speech without the read back and the yes.
 */
async function askCrew(text) {
  const r = await command('chat.send', { channel: 'general', text, lang: locale(), jobs: false }).catch(() => null);
  if (!r?.id) return '';
  const started = Date.now();
  while (Date.now() - started < 120000) {
    const m = (S().chat.general || []).find((x) => x.replyTo === r.id);
    if (m) return msgText(m);
    await new Promise((res) => setTimeout(res, 400));
  }
  return '';
}

const unknownCommand = (err) => /unknown command/.test(err?.message || '');
let replySeq = 0;
let currentReply = null;
/** One streamed answer from the engine (voice.reply), tokens through voice.token live frames. */
async function reply(text, { mode, onToken }) {
  const replyId = `r${Date.now().toString(36)}${++replySeq}`;
  currentReply = replyId;
  const off = onFrame('live', (f) => {
    if (f.type === 'voice.token' && f.data?.replyId === replyId) onToken(f.data.text || '');
  });
  try {
    return await command('voice.reply', { text, lang: locale(), replyId, mode }, { timeout: 120000 });
  } catch (err) {
    if (unknownCommand(err)) return { kind: 'answer', text: await askCrew(text) };
    throw err;
  } finally {
    off();
    if (currentReply === replyId) currentReply = null;
  }
}

const session = createVoiceSession({
  t: vt,
  lang: () => locale(),
  speak,
  speakStream: () => speaker.stream(),
  onUpdate: () => paint(),
  actions: {
    createJob: (request) => act.createJob(request),
    ask: askCrew,
    reply,
    approvals: () => S().approvals || [],
    resolveApproval: (id, ok) => act.resolveApproval(id, ok),
    status: statusText,
    openWindow: (type) => { if (!wm.typeDef(type)) return false; wm.open(type); return true; },
    runIntent,
    planTitle,
    planSteps,
    // friends of the City (src/p2p/); null when this build has no peer to peer layer
    peers: async () => {
      try { return ((await command('p2p.peers')).peers || []).map((p) => ({ peerId: p.identity?.peerId || p.peerId, name: p.identity?.name || p.name, online: !!p.online })); } catch (err) { if (unknownCommand(err)) return null; throw err; }
    },
    share: async ({ peerId, resource }) => {
      // the share block turns on (within its limits), then the person gets the grants for 24 hours
      await command('compute.share.set', { change: { [resource]: { enabled: true } } });
      await command('p2p.grant', { peerId, capability: 'compute.inference', minutes: 24 * 60 });
      await command('p2p.grant', { peerId, capability: `compute.${resource}`, minutes: 24 * 60 });
    },
    connect: (address) => command('remote.connect', { address }, { timeout: 60000 }),
    answerQuestion: (payload) => command('crew.answer', payload),
    end: () => conv.close(),
  },
});

/* ---------- speech to text for one turn ---------- */

let lastStt = null;
async function sttLocal(audio, { signal }) {
  const r = await fetch(`/api/voice/stt?lang=${encodeURIComponent(locale())}`, { method: 'POST', headers: authHeaders({ 'content-type': 'audio/wav' }), body: encodeWav(audio), signal });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(body.error?.message || `stt ${r.status}`), { code: body.error?.code || 'stt_failed' });
  lastStt = { ms: body.ms, model: body.model, device: body.device };
  return body.text || '';
}

/* The browser fallback: our voice activity detection marks the turn, the browser's recognizer writes it. */
let listener = null;
let browserWait = null;
function ensureListener() {
  if (listener || !Recognition) return listener;
  listener = createListener(Recognition, {
    lang: speechLang(locale()),
    onInterim: (text) => { session.state.heard = text; paint(); },
    onFinal: (text) => { browserWait?.(text); browserWait = null; },
    onEnd: () => { setTimeout(() => { browserWait?.(''); browserWait = null; }, 300); },
    onError: (code) => { browserWait?.(''); browserWait = null; if (code !== 'no-speech' && code !== 'aborted') showError(code); },
  });
  return listener;
}
function sttBrowser(audio, { signal }) {
  return new Promise((resolve) => {
    browserWait = resolve;
    signal.addEventListener('abort', () => { listener?.abort(); resolve(''); }, { once: true });
    if (listener?.active) listener.stop(); else { browserWait = null; resolve(''); }
    setTimeout(() => { if (browserWait === resolve) { browserWait = null; resolve(''); } }, 5000);
  });
}

function stt(audio, o) {
  const c = sttChoice();
  const heard = c.engine === 'browser' ? sttBrowser(audio, o) : c.engine === 'local' ? sttLocal(audio, o) : null;
  if (!heard) return Promise.reject(Object.assign(new Error(c.reason), { code: c.reason }));
  // a real voice conversation counts for the local profile (docs/1.0/PROFILE.md)
  return heard.then((text) => { if (String(text || '').trim()) command('profile.milestone', { kind: 'voice' }).catch(() => {}); return text; });
}

/* ---------- the conversation ---------- */

const mic = createMic({ onFrame: (s) => conv.frame(s) });
conv = createConversation({
  mic,
  stt,
  session,
  speaker,
  wake: (text) => matchWake(text, vt, locale()),
  cancelReply: () => { if (currentReply) command('voice.reply.cancel', { replyId: currentReply }).catch(() => {}); },
  chime: (kind) => play(kind === 'open' ? 'tick' : 'task'),
  onState: (state, phase) => setPhase(phase, state),
  onError: (err) => showError(err?.code || err?.name || 'error', err),
  onSpeechStart: () => { if (sttChoice().engine === 'browser') ensureListener()?.start(); },
  prefs: () => ({ handsFree: prefs.talk !== 'push', wake: prefs.wake }),
  followupMs: 15000,
});

function showError(code, err) {
  const key = {
    NotAllowedError: 'voice.err.denied', 'not-allowed': 'voice.err.denied', 'service-not-allowed': 'voice.err.denied',
    NotFoundError: 'voice.err.mic', 'audio-capture': 'voice.err.mic', 'language-not-supported': 'voice.err.lang', network: 'voice.err.network',
    needs_download: 'voice.ui.errNeedsModel', needs_browser_consent: 'voice.ui.errNeedsBrowserOk', browser_unsupported: 'voice.err.unsupported',
    stt_failed: 'voice.ui.errStt', timeout: 'voice.ui.errTimeout',
  }[code];
  session.state.reply = key ? vt(key) : vt('voice.say.failed', { message: err?.message || code });
  showOrb();
  paint();
  if (code === 'needs_download') openSttConsent();
  if (code === 'needs_browser_consent') openBrowserNotice();
}

/** Can a turn be heard right now? If not, say why and open what fixes it. */
async function ready() {
  if (!status) await refreshStatus();
  const c = sttChoice();
  if (c.engine) return true;
  showError(c.reason);
  return false;
}

export async function start() {
  showOrb();
  audioOut(); // the click is the user gesture that allows audio output
  if (!(await ready())) return;
  if (conv.state === 'off' || conv.state === 'dormant') conv.open();
}
export function stop() { conv.close(); }
export function toggle() { if (conv.state === 'off' || conv.state === 'dormant') start(); else stop(); }

/** Feeds a typed sentence to Mel, as if spoken (also used by the tests in the browser). */
export function say(text) { showOrb(); session.state.heard = text; paint(); return conv.say(text); }

// Questions from the crew (crew.question cards): read aloud while the conversation is open.
const seenCards = new Set();
function onCard(card) {
  if (!validCard(card) || seenCards.has(card.id)) return;
  seenCards.add(card.id);
  conv.announce(() => session.question(card));
}
onEvent((ev) => {
  if (ev.type === 'crew.question') onCard(ev.data);
  if (ev.type === 'crew.answer' || ev.type === 'crew.answered' || ev.type === 'crew.question.closed') session.dropQuestion(ev.data?.id);
});
onFrame('live', (f) => { if (f.type === 'crew.question') onCard(f.data); });

/* ---------- the orb ---------- */

let orb = null;
const el = {};
let phase = 'idle';
let convState = 'off';
let micBtn = null;
let raf = 0;

function loadCss() {
  if (document.getElementById('vo-css')) return;
  document.head.append(h('link', { id: 'vo-css', rel: 'stylesheet', href: '/css/voice.css' }));
}

function buildOrb() {
  loadCss();
  el.label = h('div', { class: 'vo-label', 'aria-live': 'polite' });
  el.engine = h('div', { class: 'vo-engine tiny' });
  el.canvas = h('canvas', { class: 'vo-canvas', width: 520, height: 110, 'aria-hidden': 'true' });
  el.ball = h('button', { type: 'button', class: 'vo-ball', ta: 'voice.mic', on: { click: () => toggle() } },
    h('img', { src: '/assets/crew/mel.svg', alt: '', width: 44, height: 44, onerror: (e) => { e.target.src = '/assets/mascot-dark.svg'; } }), h('span', { class: 'vo-spin', 'aria-hidden': 'true' }));
  el.heard = h('div', { class: 'vo-heard', 'aria-live': 'polite' });
  el.reply = h('div', { class: 'vo-reply', 'aria-live': 'polite' });
  el.card = h('div', { class: 'vo-card', hidden: true });
  el.note = h('div', { class: 'vo-note', hidden: true });
  el.dl = h('div', { class: 'vo-dl', hidden: true });
  el.hint = h('span', { class: 'tiny muted vo-hint' });
  el.mute = h('button', { type: 'button', class: 'ibtn ibtn-sm vo-mute', 'aria-pressed': 'false', on: { click: () => setMute(!conv.muted) } },
    h('span', { html: '<svg class="ico ico-sm" viewBox="0 0 24 24"><rect x="9" y="3.5" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v2.5"/><path class="vo-slash" d="M4 4l16 16"/></svg>' }));
  el.end = h('button', { type: 'button', class: 'btn btn-xs btn-quiet vo-endbtn', on: { click: () => stop() } });
  el.x = h('button', { type: 'button', class: 'ibtn ibtn-sm vo-x', ta: 'voice.close', kb: 'Esc', on: { click: () => hideOrb() } }, icon('x', 'ico-sm'));
  orb = h('div', { class: 'vo vo2', role: 'dialog', 'aria-modal': 'false', ta: 'voice.title', hidden: true },
    h('div', { class: 'vo-top' }, el.ball, h('div', { class: 'grow' }, el.label, el.engine), el.mute, el.x),
    el.canvas, el.heard, el.reply, el.card, el.dl, el.note,
    h('div', { class: 'vo-foot' }, el.hint, el.end));
  orb.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); if (conv.state !== 'off' && conv.state !== 'dormant') stop(); else hideOrb(); } });
  document.body.append(orb);
  onLocale(() => paint());
}

function showOrb() {
  if (!orb) buildOrb();
  if (orb.hidden) {
    orb.hidden = false;
    requestAnimationFrame(() => orb.classList.add('on'));
    draw();
  }
  if (!status) refreshStatus();
  paint();
}

function hideOrb() {
  conv.close();
  if (session.pending) session.cancel();
  if (!orb) return;
  orb.classList.remove('on');
  cancelAnimationFrame(raf);
  setTimeout(() => { if (!orb.classList.contains('on')) orb.hidden = true; }, reducedMotion() ? 0 : 220);
  micBtn?.focus({ preventScroll: true });
}

function setMute(on) {
  conv.mute(on);
  paint();
}

function setPhase(p, state) {
  phase = p;
  convState = state;
  if (orb) orb.dataset.phase = p;
  if (micBtn) { micBtn.dataset.phase = p; micBtn.setAttribute('aria-pressed', String(state !== 'off' && state !== 'dormant')); }
  paint();
}

function engineLine() {
  const c = sttChoice();
  const sttName = c.engine === 'browser' ? vt('voice.ui.engineBrowser')
    : status?.stt?.model ? vt('voice.ui.engineLocal', { model: status.stt.model, device: status.stt.runtime?.device === 'gpu' ? 'GPU' : 'CPU' }) : vt('voice.ui.engineNone');
  const tts = ttsChoice();
  const ttsName = tts === 'piper' ? vt('voice.ui.voicePiper') : tts === 'system' ? vt('voice.ui.voiceSystem') : vt('voice.ui.voiceOff');
  const ms = lastStt?.ms ? `, ${vt('voice.ui.lastMs', { ms: lastStt.ms })}` : '';
  return `${sttName}${ms}. ${ttsName}.`;
}

function paint() {
  if (!orb) return;
  const st = session.state;
  el.label.textContent = conv.muted ? vt('voice.ui.muted') : vt(`voice.ui.state.${convState}`);
  el.engine.textContent = engineLine();
  el.heard.textContent = st.heard || '';
  el.reply.textContent = st.reply || '';
  el.mute.setAttribute('aria-pressed', String(conv.muted));
  el.mute.setAttribute('aria-label', vt(conv.muted ? 'voice.ui.unmute' : 'voice.ui.mute'));
  el.mute.classList.toggle('on', conv.muted);
  setTip(el.mute, { title: vt(conv.muted ? 'voice.ui.unmute' : 'voice.ui.mute'), kb: 'Ctrl Shift Space' });
  const idle = convState === 'off' || convState === 'dormant';
  setTip(el.ball, { title: vt(idle ? 'voice.ui.tapStart' : 'voice.ui.tapEnd'), kb: 'Ctrl Space' });
  el.end.textContent = vt('voice.ui.end');
  el.end.hidden = idle;
  el.hint.textContent = convState === 'dormant' ? vt('voice.ui.hintWake') : convState === 'off' ? vt('voice.ui.hintTap') : prefs.talk === 'push' ? vt('voice.ui.hintPush') : vt('voice.ui.hintHands');
  const p = st.pending;
  el.card.hidden = !p;
  if (p) {
    const isQ = p.kind === 'question';
    append(clear(el.card), [
      h('div', { class: 'vo-card-t', text: p.summary }),
      p.details?.length ? h(isQ ? 'ol' : 'ul', { class: 'vo-card-d' }, p.details.slice(0, 8).map((d) => h('li', { text: isQ ? d.replace(/^\d+\.\s*/, '') : d }))) : null,
      h('div', { class: 'vo-card-h tiny muted', text: isQ ? vt('voice.q.how') : t('voice.card.say') }),
      isQ ? null : h('div', { class: 'row vo-card-a' },
        h('button', { type: 'button', class: 'btn btn-sm btn-primary', text: t('voice.card.confirm'), tip: 'tip.voice.confirm', on: { click: () => session.confirm() } }),
        h('button', { type: 'button', class: 'btn btn-sm btn-quiet', text: t('voice.card.cancel'), tip: 'tip.voice.cancel', on: { click: () => session.cancel() } }))]);
  }
  el.note.hidden = sttChoice().engine !== 'browser' || prefs.privacySeen;
  if (!el.note.hidden) {
    el.note.replaceChildren(icon('lock', 'ico-sm'), h('span', { text: vt('voice.ui.browserNotice') }),
      h('button', { type: 'button', class: 'btn btn-xs btn-quiet', text: t('voice.gotIt'), on: { click: () => { prefs.privacySeen = true; savePrefs(); paint(); } } }));
  }
  paintDownloads();
}

const pct = (d) => Math.floor(((d.received || 0) / (d.total || 1)) * 100);
function paintDownloads() {
  if (!orb || !el.dl) return;
  const list = [...downloads.entries()];
  el.dl.hidden = !list.length;
  el.dl.replaceChildren(...list.map(([id, d]) => h('div', { class: 'vo-dl-i' },
    h('span', { class: 'tiny', text: d.error ? vt('voice.ui.dlFailed', { id, error: d.error }) : vt('voice.ui.dlProgress', { id, pct: pct(d) }) }),
    d.error ? null : h('div', { class: 'vo-bar' }, h('i', { style: `width:${pct(d)}%` })))));
}

/* The live waveform: the microphone while listening, Mel's voice while she speaks, a calm line otherwise. */
const freq = new Uint8Array(256);
const wave = new Uint8Array(512);
function draw() {
  cancelAnimationFrame(raf);
  if (!orb || orb.hidden) return;
  const cv = el.canvas;
  const g = cv.getContext('2d');
  if (!g) return;
  const W = cv.width; const H = cv.height;
  const css = getComputedStyle(orb);
  const honey = css.getPropertyValue('--honey').trim() || '#FFB531';
  const sky = css.getPropertyValue('--info').trim() || '#86A9D6';
  const frame = (ts) => {
    const t0 = ts / 1000;
    g.clearRect(0, 0, W, H);
    const mid = H / 2;
    let an = null;
    if (phase === 'listening' && mic.analyser && !conv.muted) an = mic.analyser;
    else if (phase === 'speaking' && ttsChoice() === 'piper' && outAnalyser) an = outAnalyser;
    g.lineWidth = 2.5;
    g.lineCap = 'round';
    if (an) {
      an.getByteTimeDomainData(wave);
      an.getByteFrequencyData(freq);
      let sum = 0;
      for (let i = 2; i < 60; i++) sum += freq[i];
      const level = sum / (58 * 255);
      g.strokeStyle = phase === 'speaking' ? sky : honey;
      g.globalAlpha = 0.95;
      g.beginPath();
      const step = wave.length / W;
      for (let x = 0; x < W; x++) {
        const v = (wave[Math.floor(x * step)] - 128) / 128;
        const env = Math.sin((x / W) * Math.PI);
        const y = mid + v * mid * 0.95 * env * (0.6 + level * 2);
        if (x) g.lineTo(x, y); else g.moveTo(x, y);
      }
      g.stroke();
    } else {
      // no level to show (a system voice, thinking, idle): a drawn wave whose energy tells the state
      const amp = phase === 'speaking' ? 0.55 : phase === 'thinking' ? 0.18 : phase === 'listening' ? 0.1 : 0.05;
      const speed = phase === 'thinking' ? 3 : phase === 'speaking' ? 5 : 1.2;
      for (const [k, alpha, color] of [[1, 0.9, phase === 'speaking' ? sky : honey], [1.7, 0.35, honey], [2.6, 0.2, sky]]) {
        g.strokeStyle = color;
        g.globalAlpha = alpha;
        g.beginPath();
        for (let x = 0; x <= W; x += 4) {
          const env = Math.sin((x / W) * Math.PI);
          const jitter = phase === 'speaking' ? 0.6 + 0.4 * Math.sin(t0 * 7.3 + k) * Math.sin(t0 * 3.1) : 1;
          const y = mid + Math.sin(x / (34 / k) + t0 * speed * k) * mid * amp * env * jitter;
          if (x) g.lineTo(x, y); else g.moveTo(x, y);
        }
        g.stroke();
      }
    }
    g.globalAlpha = 1;
    if (!reducedMotion() && orb && !orb.hidden) raf = requestAnimationFrame(frame);
  };
  if (reducedMotion()) frame(0); else raf = requestAnimationFrame(frame);
}

/* ---------- keyboard ---------- */

// Ctrl+Space: hands free opens or ends the conversation; push to talk is held while speaking.
// Ctrl+Shift+Space: mute or unmute the microphone. Esc in the orb ends the conversation.
let holding = false;
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey && (e.code === 'Space' || e.key === ' '))) return;
  e.preventDefault();
  if (e.repeat) return;
  if (e.shiftKey) { if (orb && !orb.hidden) setMute(!conv.muted); return; }
  if (prefs.talk !== 'push') { toggle(); return; }
  if (!holding) {
    holding = true;
    showOrb();
    audioOut();
    ready().then((ok) => { if (ok && holding) mic.start().then(() => { if (holding) conv.pttDown(); }).catch((err) => showError(err?.name || 'error', err)); });
  }
}, true);
document.addEventListener('keyup', (e) => {
  if (!holding) return;
  if (e.code === 'Space' || e.key === ' ' || e.key === 'Control') { holding = false; conv.pttUp(); }
}, true);

/* ---------- top bar button ---------- */

export function micButton() {
  micBtn = h('button', { type: 'button', class: 'ibtn mic-btn', ta: 'voice.mic', 'aria-pressed': 'false', dataset: { tipPos: 'bottom', tour: 'voice' } },
    h('span', { html: '<svg class="ico" viewBox="0 0 24 24"><rect x="9" y="3.5" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v2.5"/></svg>' }));
  const paintTip = () => setTip(micBtn, { key: 'tip.voice.mic', title: t('tip.voice.mic.title'), help: supported ? vt(prefs.talk === 'push' ? 'voice.ui.tipPush' : 'voice.ui.tipHands') : t('voice.err.unsupported'), kb: 'Ctrl Space' });
  paintTip();
  onLocale(paintTip);
  micBtn.addEventListener('click', () => toggle());
  if (!supported) micBtn.classList.add('mic-off');
  return micBtn;
}

/* ---------- consent dialogs ---------- */

const mb = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`);
let consentDlg = null;

/** The local speech model: which model and build, how big, from where, under which license; nothing downloads before the button. */
export async function openSttConsent() {
  if (consentDlg) return;
  loadCss();
  const st = status || await refreshStatus();
  if (!st) return;
  const rec = st.stt.recommended || {};
  let pickModel = rec.model;
  let pickRuntime = st.stt.runtime ? null : (rec.device === 'gpu' && rec.gpuRuntime ? rec.gpuRuntime : rec.runtime);
  const body = h('div', { class: 'vo-consent' });
  consentDlg = openDialog({ title: vt('voice.ui.consentTitle'), body, wide: true, onClose: () => { consentDlg = null; } });
  const render = () => {
    const plan = sttPlan(st, { model: pickModel, runtime: pickRuntime });
    const gpu = (st.stt.runtimes || []).find((r) => r.id === pickRuntime)?.gpu || st.stt.runtime?.device === 'gpu';
    const device = gpu ? 'gpu' : 'cpu';
    append(clear(body), [
      h('p', { class: 'vo-lead', text: vt('voice.ui.consentLead') }),
      h('fieldset', { class: 'vo-pick' }, h('legend', { class: 'tiny muted', text: vt('voice.ui.pickModel') }),
        st.stt.models.map((m) => h('label', { class: `vo-opt${m.id === pickModel ? ' on' : ''}` },
          h('input', { type: 'radio', name: 'vo-model', value: m.id, checked: m.id === pickModel, on: { change: () => { pickModel = m.id; render(); } } }),
          h('span', { class: 'vo-opt-b' },
            h('span', { class: 'vo-opt-h' }, h('b', { text: m.name }), m.recommended ? h('span', { class: 'hchip hchip-honey', text: vt('voice.ui.recommended') }) : null, m.installed ? h('span', { class: 'hchip hchip-ok', text: vt('voice.ui.installed') }) : null),
            h('span', { class: 'tiny muted', text: vt('voice.ui.modelLine', { size: m.size, ram: m.ramText, speed: vt(`voice.ui.speed.${modelHint(m, device)}`) }) }),
            h('span', { class: 'tiny muted', text: vt(`voice.ui.quality.${m.id}`) }))))),
      !st.stt.runtime && (st.stt.runtimes || []).length ? h('fieldset', { class: 'vo-pick' }, h('legend', { class: 'tiny muted', text: vt('voice.ui.pickBuild') }),
        st.stt.runtimes.map((r) => h('label', { class: `vo-opt${r.id === pickRuntime ? ' on' : ''}` },
          h('input', { type: 'radio', name: 'vo-rt', value: r.id, checked: r.id === pickRuntime, on: { change: () => { pickRuntime = r.id; render(); } } }),
          h('span', { class: 'vo-opt-b' }, h('span', { class: 'vo-opt-h' }, h('b', { text: r.name }), r.recommended ? h('span', { class: 'hchip hchip-honey', text: vt('voice.ui.recommended') }) : null),
            h('span', { class: 'tiny muted', text: `${r.size}. ${r.gpu ? vt('voice.ui.buildGpu') : vt('voice.ui.buildCpu')}` }))))) : null,
      plan.needsSystem ? h('p', { class: 'small vo-warn', text: vt('voice.ui.needsSystem') }) : null,
      h('dl', { class: 'kv vo-kv' },
        h('dt', { text: vt('voice.ui.total') }), h('dd', { text: plan.files.length ? mb(plan.bytes) : vt('voice.ui.nothing') }),
        h('dt', { text: vt('voice.ui.source') }), h('dd', { class: 'mono tiny', text: [...new Set(plan.files.map((f) => f.source))].join(', ') || '-' }),
        h('dt', { text: vt('voice.ui.license') }), h('dd', { text: 'MIT' }),
        h('dt', { text: vt('voice.ui.privacy') }), h('dd', { text: vt('voice.ui.privacyLocal') })),
      h('div', { class: 'vo-actions' },
        h('button', { type: 'button', class: 'btn btn-primary', 'data-autofocus': '', disabled: !plan.possible, on: { click: () => download(plan) } }, icon('download', 'ico-sm'), plan.files.length ? vt('voice.ui.download', { size: mb(plan.bytes) }) : vt('voice.ui.use')),
        h('button', { type: 'button', class: 'btn btn-quiet', text: vt('voice.ui.later'), on: { click: () => consentDlg?.close() } }),
        Recognition ? h('button', { type: 'button', class: 'btn btn-quiet btn-xs', text: vt('voice.ui.useBrowser'), on: { click: () => { consentDlg?.close(); openBrowserNotice(); } } }) : null)]);
  };
  const download = async (plan) => {
    try {
      for (const f of plan.files) await command('voice.consent', { id: f.id, yes: true });
      await command('voice.select', { stt: { model: pickModel, ...(pickRuntime ? { runtime: pickRuntime } : {}) } });
      prefs.stt = 'local';
      savePrefs();
      consentDlg?.close();
      showOrb();
      refreshStatus();
    } catch (err) { body.append(h('p', { class: 'small vo-warn', text: err.message })); }
  };
  render();
}

/** The browser recognizer is opt in: the user reads where the audio may go and says yes. */
export function openBrowserNotice() {
  if (consentDlg) return;
  loadCss();
  const body = h('div', { class: 'vo-consent' },
    h('p', { class: 'vo-lead', text: vt('voice.ui.browserLead') }),
    h('p', { class: 'small', text: vt('voice.ui.browserNotice') }),
    h('div', { class: 'vo-actions' },
      h('button', { type: 'button', class: 'btn btn-primary', text: vt('voice.ui.browserYes'), on: { click: () => { prefs.stt = 'browser'; prefs.browserOk = true; prefs.privacySeen = true; savePrefs(); consentDlg?.close(); paint(); settingsRender?.(); } } }),
      h('button', { type: 'button', class: 'btn btn-quiet', 'data-autofocus': '', text: vt('voice.ui.browserNo'), on: { click: () => consentDlg?.close() } })));
  consentDlg = openDialog({ title: vt('voice.ui.browserTitle'), body, onClose: () => { consentDlg = null; } });
}

/** Piper and the voice of this language, behind the same kind of consent. */
export async function openPiperConsent() {
  if (consentDlg) return;
  loadCss();
  const st = status || await refreshStatus();
  if (!st) return;
  const v = (st.tts.voices || []).find((x) => x.locale === locale());
  const rt = st.tts.runtime;
  const body = h('div', { class: 'vo-consent' });
  consentDlg = openDialog({ title: vt('voice.ui.piperTitle'), body, wide: true, onClose: () => { consentDlg = null; } });
  if (!v || !rt) { body.append(h('p', { text: vt(!rt ? 'voice.ui.piperNoBuild' : 'voice.ui.piperNoVoice', { lang: LOCALES.find((l) => l.code === locale())?.name || locale() }) })); return; }
  const files = [rt, v].filter((f) => !f.installed);
  const total = files.reduce((n, f) => n + f.bytes, 0);
  body.append(
    h('p', { class: 'vo-lead', text: vt('voice.ui.piperLead') }),
    h('dl', { class: 'kv vo-kv' },
      h('dt', { text: vt('voice.ui.voiceName') }), h('dd', { text: v.name }),
      h('dt', { text: vt('voice.ui.total') }), h('dd', { text: files.length ? mb(total) : vt('voice.ui.nothing') }),
      h('dt', { text: vt('voice.ui.source') }), h('dd', { class: 'mono tiny', text: `${rt.source}, ${v.source}` }),
      h('dt', { text: vt('voice.ui.license') }), h('dd', { text: vt('voice.ui.piperLicense') })),
    h('div', { class: 'vo-actions' },
      h('button', { type: 'button', class: 'btn btn-primary', 'data-autofocus': '', on: { click: async () => {
        try { for (const f of files) await command('voice.consent', { id: f.id, yes: true }); prefs.tts = 'piper'; savePrefs(); consentDlg?.close(); settingsRender?.(); } catch (err) { body.append(h('p', { class: 'small vo-warn', text: err.message })); }
      } } }, icon('download', 'ico-sm'), files.length ? vt('voice.ui.download', { size: mb(total) }) : vt('voice.ui.use')),
      h('button', { type: 'button', class: 'btn btn-quiet', text: vt('voice.ui.later'), on: { click: () => consentDlg?.close() } })));
}

/* ---------- Settings: the Voice section ---------- */

let settingsRender = null;
export function voiceSettings() {
  loadCss();
  const sec = h('section', { class: 'set-sec set-voice', 'aria-labelledby': 'set-voice-h' });
  const seg = (id, value, options, set) => h('div', { class: 'seg', role: 'radiogroup', 'aria-labelledby': id },
    options.map(([v, label]) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(value === v), text: label, on: { click: () => { set(v); savePrefs(); render(); } } })));
  const render = () => {
    const st = status;
    const voices = voicesFor();
    const sttLine = !st ? vt('voice.ui.loading')
      : st.stt.ready ? vt('voice.ui.sttReady', { model: st.stt.model, device: st.stt.runtime?.device === 'gpu' ? 'GPU' : 'CPU' })
        : vt('voice.ui.sttMissing');
    const installed = (st?.stt.models || []).filter((m) => m.installed);
    const piperHere = (st?.tts.ready || []).includes(locale());
    const dl = [...downloads.values()].find((d) => !d.error);
    append(clear(sec), [
      h('h3', { id: 'set-voice-h', class: 'set-h', tip: 'tip.voice.section', text: t('voice.set.title') }),
      h('p', { class: 'small muted', text: vt('voice.ui.setLead') }),
      h('div', { class: 'set-row' }, h('span', { id: 'vo-stt-l', class: 'set-l', text: vt('voice.ui.setStt') }),
        seg('vo-stt-l', prefs.stt, [['local', vt('voice.ui.sttLocal')], ['browser', vt('voice.ui.sttBrowser')]], (v) => { if (v === 'browser' && !prefs.browserOk) { openBrowserNotice(); return; } prefs.stt = v; })),
      h('p', { class: 'tiny muted vo-privacy' }, icon('lock', 'ico-sm'), ' ', prefs.stt === 'browser' ? vt('voice.ui.browserNotice') : vt('voice.ui.privacyLocal')),
      prefs.stt === 'local' ? h('div', { class: 'set-row' }, h('span', { class: 'set-l', text: vt('voice.ui.setModel') }),
        h('span', { class: 'small', text: sttLine }),
        installed.length > 1 ? h('select', { class: 'input', 'aria-label': vt('voice.ui.setModel'), on: { change: async (e) => { await command('voice.select', { stt: { model: e.target.value } }).catch(() => {}); refreshStatus(); } } },
          installed.map((m) => h('option', { value: m.id, text: m.name, selected: m.id === st.stt.model }))) : null,
        h('button', { type: 'button', class: 'btn btn-sm btn-quiet', text: st?.stt.ready ? vt('voice.ui.otherModel') : vt('voice.ui.getModel'), on: { click: () => openSttConsent() } })) : null,
      dl ? h('div', { class: 'vo-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct(dl)) }, h('i', { style: `width:${pct(dl)}%` })) : null,
      h('div', { class: 'set-row' }, h('span', { id: 'vo-talk-l', class: 'set-l', text: vt('voice.ui.setTalk') }),
        seg('vo-talk-l', prefs.talk, [['hands', vt('voice.ui.talkHands')], ['push', vt('voice.ui.talkPush')]], (v) => { prefs.talk = v; })),
      h('div', { class: 'set-row' }, h('label', { class: 'set-l', for: 'vo-wake', text: vt('voice.ui.setWake') }),
        h('input', { type: 'checkbox', id: 'vo-wake', checked: prefs.wake, on: { change: async (e) => { prefs.wake = e.target.checked; savePrefs(); if (prefs.wake && !(await ready())) { prefs.wake = false; savePrefs(); render(); return; } conv.rest(); render(); } } })),
      h('p', { class: 'tiny muted', text: vt('voice.ui.wakeNote') }),
      h('div', { class: 'set-row' }, h('span', { id: 'vo-tts-l', class: 'set-l', text: vt('voice.ui.setVoiceKind') }),
        seg('vo-tts-l', prefs.tts, [['system', vt('voice.ui.voiceSystem')], ['piper', vt('voice.ui.voicePiper')]], (v) => { if (v === 'piper' && !piperHere) { openPiperConsent(); return; } prefs.tts = v; })),
      prefs.tts === 'system' || !piperHere ? h('div', { class: 'set-row' }, h('label', { class: 'set-l', for: 'vo-voice', text: t('voice.set.voice') }),
        h('select', { class: 'input', id: 'vo-voice', on: { change: (e) => { prefs.voice = e.target.value; savePrefs(); audioOut(); speak(t('voice.sample')); } } },
          h('option', { value: '', text: t('voice.set.auto') }),
          voices.map((v) => h('option', { value: v.voiceURI, text: `${v.name} (${v.lang})`, selected: v.voiceURI === prefs.voice })))) : null,
      !voices.length ? h('p', { class: 'tiny muted', text: t('voice.set.noVoice', { lang: LOCALES.find((l) => l.code === locale())?.name || locale() }) }) : null,
      h('div', { class: 'set-row' }, h('label', { class: 'set-l', for: 'vo-rate', text: t('voice.set.rate') }),
        h('input', { type: 'range', min: '0.7', max: '1.4', step: '0.05', value: String(prefs.rate), id: 'vo-rate', on: { change: (e) => { prefs.rate = Number(e.target.value); savePrefs(); render(); audioOut(); speak(t('voice.sample')); } } }),
        h('span', { class: 'mono tiny', text: `${prefs.rate.toFixed(2)}x` })),
      h('div', { class: 'set-row' }, h('label', { class: 'set-l', for: 'vo-auto', text: t('voice.set.autoSpeak') }),
        h('input', { type: 'checkbox', id: 'vo-auto', checked: prefs.autoSpeak, on: { change: (e) => { prefs.autoSpeak = e.target.checked; savePrefs(); } } })),
      h('div', { class: 'set-row' }, h('label', { class: 'set-l', for: 'vo-lang', text: vt('voice.ui.setLang') }),
        h('select', { class: 'input', id: 'vo-lang', on: { change: (e) => setLocale(e.target.value) } }, LOCALES.map((l) => h('option', { value: l.code, text: l.name, selected: l.code === locale() })))),
      h('p', { class: 'tiny muted', text: vt('voice.ui.keys') }),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn btn-sm btn-quiet', tip: 'tip.voice.test', text: t('voice.set.test'), on: { click: () => { audioOut(); speak(t('voice.sample')); } } }),
        h('button', { type: 'button', class: 'btn btn-sm btn-primary', text: vt('voice.ui.talkNow'), on: { click: () => start() } }))]);
  };
  settingsRender = render;
  render();
  refreshStatus();
  const off = onLocale(render);
  if (canSpeak) speechSynthesis.addEventListener?.('voiceschanged', render);
  return { el: sec, dispose: () => { off(); settingsRender = null; if (canSpeak) speechSynthesis.removeEventListener?.('voiceschanged', render); } };
}

loadStrings();
refreshStatus().then(() => { if (prefs.wake && sttChoice().engine) conv.rest(); });

window.hivedeskVoice = { supported, start, stop, toggle, say, get pending() { return session.pending; }, session, conv, get state() { return conv.state; }, openSttConsent, openPiperConsent };
