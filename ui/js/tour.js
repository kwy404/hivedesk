// First run tour with Mel as the guide. A spotlight follows real elements of the desktop and a
// speech bubble with a small animated Mel explains each one. Next, Back, Skip, progress dots,
// keyboard (Right or Enter, Left, Esc), live language switch, and a bottom sheet layout on phones.
// Replay it from Help or the command palette. Step 1 can launch a short "try it" job.

import { tourMayStart, onboardingState } from './onboarding-gate.js';
import { h, icon, reducedMotion } from './dom.js';
import { t, onLocale } from './i18n.js';
import { ui } from './store.js';
import { brainInfo } from './brainstate.js';
import * as wm from './wm.js';
import * as act from './actions.js';
import { notify } from './notify.js';
import { hide as hideTip } from './tooltip.js';

const DONE_KEY = 'hivedesk.tour.v1';
const phone = () => matchMedia('(max-width: 760px)').matches;

/**
 * Steps: `find()` returns the element to spotlight (or null), `prepare()` opens what the step
 * needs first. A step whose `optional` target is missing is skipped (Office mode).
 */
const STEPS = [
  { id: 'request', find: () => document.querySelector('.ask'), demo: true },
  { id: 'refiner', prepare: () => openWin('brief'), find: () => document.querySelector('[data-tour="refiner"]') || win('brief') },
  { id: 'timeline', prepare: () => openWin('timeline'), find: () => win('timeline') || document.querySelector('.strip') },
  { id: 'crew', find: () => document.querySelector('[data-tour="crew"]') },
  { id: 'chat', prepare: () => openWin('chat'), find: () => win('chat') },
  { id: 'files', prepare: () => openWin('files'), find: () => win('files') },
  { id: 'preview', prepare: () => openWin('preview'), find: () => win('preview') },
  { id: 'approvals', prepare: () => openWin('approvals'), find: () => win('approvals') || document.querySelector('.hdock [data-win="approvals"]') },
  { id: 'office', optional: true, find: () => document.querySelector('[data-tour="office"], .of-seg, .office-btn') },
  { id: 'lend', find: () => document.querySelector('.hdock [data-win="lend"]') },
  { id: 'settings', find: () => document.querySelector('[data-tour="language"]') || document.querySelector('.hdock [data-win="settings"]') },
];

function win(type) {
  const w = wm.get(type);
  return w && !w.min ? w.el : null;
}
function openWin(type) {
  if (!wm.typeDef(type)) return;
  const w = wm.get(type);
  if (!w || w.min) wm.open(type, undefined, { focus: false });
  else wm.focus(type, { quiet: true });
}

let state = null; // { i, steps, els... }

export const isRunning = () => !!state;

/** Starts the tour after the first connection, once per browser. */
export function maybeAutoStart() {
  let seen = false;
  try { seen = localStorage.getItem(DONE_KEY) === 'done'; } catch {}
  if (seen || ui.lend || state) return;
  // The profile and City card goes first; the tour waits until it is closed or skipped (onboarding-gate.js).
  const t0 = Date.now();
  const tick = () => {
    if (state) return;
    const ok = tourMayStart({
      dialogOpen: !!document.querySelector('.hd-dlg, .qsheet-back'),
      onboardingOpen: !!document.querySelector('.ct-ob'),
      onboardingDecided: onboardingState().decided !== false,
      waitedMs: Date.now() - t0,
    });
    if (ok) startTour();
    else if (!document.querySelector('.hd-dlg') || Date.now() - t0 < 120_000) setTimeout(tick, 600);
  };
  setTimeout(tick, 900);
}

export function startTour({ at = 0 } = {}) {
  if (state) stopTour(false);
  hideTip();
  const steps = STEPS.filter((s) => !s.optional || s.find());
  const spot = h('div', { class: 'tour-spot', 'aria-hidden': 'true' });
  const shade = h('div', { class: 'tour-shade', 'aria-hidden': 'true' });
  const bubble = h('div', { class: 'tour-bubble', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'tour-t', 'aria-describedby': 'tour-x', tabindex: '-1' });
  document.body.append(shade, spot, bubble);
  document.documentElement.classList.add('tour-on');
  state = { i: -1, steps, spot, shade, bubble, timer: null, off: null, target: null };
  bubble.addEventListener('keydown', onKey);
  document.addEventListener('keydown', onDocKey, true);
  state.off = onLocale(() => render());
  const ro = () => place();
  window.addEventListener('resize', ro);
  state.unresize = () => window.removeEventListener('resize', ro);
  // windows animate and move: follow the target a few times per second
  state.timer = setInterval(() => place(), 250);
  go(at);
  // the desktop may still move focus while it restores windows: bring it back to the tour once
  setTimeout(() => { if (state && !state.bubble.contains(document.activeElement)) state.bubble.querySelector('[data-primary]')?.focus({ preventScroll: true }); }, 700);
}

function onDocKey(e) {
  if (!state || document.querySelector('.cmenu, .hd-dlg, .kpal')) return;
  const a = document.activeElement;
  const typing = a && (/INPUT|TEXTAREA|SELECT/.test(a.tagName) || a.isContentEditable);
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); stopTour(true); return; }
  if (typing || e.ctrlKey || e.altKey || e.metaKey) return;
  if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); next(); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); back(); }
}

function onKey(e) {
  if (e.target.closest('input, textarea')) return;
  if (e.key === 'Enter' && e.target === state.bubble) { e.preventDefault(); next(); }
  else if (e.key === 'Tab') {
    const f = [...state.bubble.querySelectorAll('button')];
    if (!f.length) return;
    if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
  }
}

function next() { if (!state) return; if (state.i >= state.steps.length - 1) stopTour(true); else go(state.i + 1); }
function back() { if (state && state.i > 0) go(state.i - 1); }

function go(i) {
  const step = state.steps[i];
  state.i = i;
  try { step.prepare?.(); } catch (err) { console.warn('[hivedesk] tour step', step.id, err.message); }
  // give a window that just opened one frame to appear
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (!state) return;
    state.target = step.find();
    if (state.target && phone()) state.target.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
    render();
    place();
    state.bubble.focus({ preventScroll: true });
    state.bubble.querySelector('[data-primary]')?.focus({ preventScroll: true });
  }));
}

function mel() {
  return h('div', { class: 'tour-mel', 'aria-hidden': 'true' },
    h('img', { src: '/assets/crew/mel.svg', alt: '', width: 56, height: 56, onerror: (e) => { e.target.src = '/assets/mascot-dark.svg'; } }));
}

function render() {
  if (!state) return;
  const { i, steps, bubble } = state;
  const step = steps[i];
  const last = i === steps.length - 1;
  const canTry = step.demo && brainInfo().canRequest && !ui.replay;
  const dots = h('div', { class: 'tour-dots', role: 'tablist', 'aria-label': t('tour.progressLabel') },
    steps.map((s, k) => h('button', {
      type: 'button', role: 'tab', class: k === i ? 'on' : k < i ? 'seen' : '', 'aria-selected': String(k === i),
      'aria-label': t('tour.goTo', { n: k + 1, title: t(`tour.${s.id}.title`) }), tabindex: k === i ? '0' : '-1',
      on: { click: () => go(k) },
    })));
  bubble.replaceChildren(...[
    h('div', { class: 'tour-head' }, mel(),
      h('div', { class: 'grow' },
        h('div', { class: 'tour-count', text: t('tour.count', { n: i + 1, total: steps.length }) }),
        h('h2', { id: 'tour-t', class: 'tour-title', text: t(`tour.${step.id}.title`) })),
      h('button', { type: 'button', class: 'ibtn ibtn-sm tour-x', 'aria-label': t('tour.skip'), tip: 'tip.tour.skip', kb: 'Esc', on: { click: () => stopTour(true) } }, icon('x', 'ico-sm'))),
    h('p', { id: 'tour-x', class: 'tour-text', text: t(`tour.${step.id}.text`) }),
    !state.target ? h('p', { class: 'tour-miss tiny muted', text: t('tour.missing') }) : null,
    canTry ? h('button', { type: 'button', class: 'btn btn-sm btn-quiet tour-try', tip: 'tip.tour.try', on: { click: tryIt } }, icon('sparkle', 'ico-sm'), h('span', { text: ui.demo ? t('tour.tryDemo') : t('tour.try') })) : null,
    h('div', { class: 'tour-foot' }, dots,
      h('div', { class: 'tour-btns' },
        h('button', { type: 'button', class: 'btn btn-sm btn-ghost tour-skip', tip: 'tip.tour.skip', kb: 'Esc', text: t('tour.skip'), on: { click: () => stopTour(true) } }),
        i > 0 ? h('button', { type: 'button', class: 'btn btn-sm btn-quiet', tip: 'tip.tour.back', kb: 'Left', text: t('tour.back'), on: { click: back } }) : null,
        h('button', { type: 'button', class: 'btn btn-sm btn-primary', 'data-primary': '', tip: 'tip.tour.next', kb: 'Right', text: last ? t('tour.done') : t('tour.next'), on: { click: next } }))),
  ].filter(Boolean));
  bubble.dataset.step = step.id;
}

async function tryIt() {
  const text = t('tour.demoRequest');
  const input = document.querySelector('#ask');
  if (input) { input.value = text; input.dispatchEvent(new Event('input', { bubbles: true })); }
  const r = await act.createJob(text);
  if (r) {
    if (input) input.value = '';
    notify({ title: t('tour.tryStarted'), body: text, tone: 'info', icon: 'sparkle', timeout: 4000 });
    next();
  }
}

/** Places the spotlight on the target and the bubble next to it, outside the target box. */
function place() {
  if (!state) return;
  const { spot, bubble, shade } = state;
  // a window that opens late, or a better target that appears (the brief columns): follow it
  const step = state.steps[state.i];
  if (step) {
    const fresh = step.find();
    if (fresh && fresh !== state.target) {
      const had = !!(state.target && state.target.isConnected);
      state.target = fresh;
      if (!had) render();
    }
  }
  const target = state.target && state.target.isConnected ? state.target : null;
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const pad = 6;
  if (target) {
    const r = target.getBoundingClientRect();
    const x = Math.max(4, r.left - pad);
    const y = Math.max(4, r.top - pad);
    const w = Math.min(vw - 8, r.right + pad) - x;
    const hh = Math.min(vh - 8, r.bottom + pad) - y;
    Object.assign(spot.style, { transform: `translate(${Math.round(x)}px, ${Math.round(y)}px)`, width: `${Math.round(w)}px`, height: `${Math.round(hh)}px` });
    spot.hidden = false;
    shade.hidden = true;
  } else {
    spot.hidden = true;
    shade.hidden = false;
  }
  if (phone()) {
    bubble.classList.add('sheet');
    bubble.style.left = '';
    bubble.style.top = '';
    return;
  }
  bubble.classList.remove('sheet');
  const br = bubble.getBoundingClientRect();
  const GAP = 14;
  let left;
  let top;
  if (!target) { left = (vw - br.width) / 2; top = (vh - br.height) / 2; }
  else {
    const r = target.getBoundingClientRect();
    const room = { below: vh - r.bottom, above: r.top, right: vw - r.right, left: r.left };
    if (room.below >= br.height + GAP + 8) { top = r.bottom + GAP; left = r.left + r.width / 2 - br.width / 2; }
    else if (room.above >= br.height + GAP + 8) { top = r.top - GAP - br.height; left = r.left + r.width / 2 - br.width / 2; }
    else if (room.right >= br.width + GAP + 8) { left = r.right + GAP; top = r.top + r.height / 2 - br.height / 2; }
    else if (room.left >= br.width + GAP + 8) { left = r.left - GAP - br.width; top = r.top + r.height / 2 - br.height / 2; }
    else { left = r.left + 16; top = r.top + 16; } // a target as big as the screen: sit inside it
  }
  left = Math.max(10, Math.min(left, vw - br.width - 10));
  top = Math.max(10, Math.min(top, vh - br.height - 10));
  bubble.style.left = `${Math.round(left)}px`;
  bubble.style.top = `${Math.round(top)}px`;
}

export function stopTour(markDone = true) {
  if (!state) return;
  const { spot, bubble, shade } = state;
  clearInterval(state.timer);
  state.off?.();
  state.unresize?.();
  document.removeEventListener('keydown', onDocKey, true);
  document.documentElement.classList.remove('tour-on');
  bubble.classList.add('out');
  spot.classList.add('out');
  setTimeout(() => { spot.remove(); bubble.remove(); shade.remove(); }, reducedMotion() ? 0 : 220);
  const finished = state.i >= state.steps.length - 1;
  state = null;
  if (markDone) {
    try { localStorage.setItem(DONE_KEY, 'done'); } catch {}
    notify({ title: finished ? t('tour.finished') : t('tour.skipped'), body: t('tour.replayHint'), tone: 'info', icon: 'compass', timeout: 5000 });
  }
  document.querySelector('#ask')?.focus({ preventScroll: true });
}

// For tests and the palette.
window.hivedeskTour = { start: startTour, stop: stopTour, next: () => next(), back: () => back(), get step() { return state ? state.steps[state.i].id : null; }, get index() { return state ? state.i : -1; }, get total() { return state ? state.steps.length : 0; } };
