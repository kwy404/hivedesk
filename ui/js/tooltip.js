// Rich tooltips for the whole desktop: a title, one line of help and the shortcut, translated.
// One delegated listener covers every element with data-tip (a key: <key>.title and <key>.help
// in i18n), data-tip-title / data-tip-help (plain text set by code) or a native title attribute
// (moved into data-tip-title so the browser tooltip never doubles it).
// Shows after a short delay on hover and on keyboard focus, fades in with a slight rise,
// flips and clamps to stay on screen and is always placed outside the target's box, so it never
// covers what the pointer is on.

import { t, has, fmtKeys, onLocale } from './i18n.js';

const HOVER_DELAY = 420;
const FOCUS_DELAY = 260;
const GAP = 8;
const MARGIN = 8;

let tip;
let titleEl;
let helpEl;
let kbEl;
let target = null;
let timer = null;
let shownAt = 0;
let lastHide = 0;
let tabbedAt = 0; // focus tooltips only follow real keyboard navigation (Tab), not focus moved by code

const SELECTOR = '[data-tip],[data-tip-title],[title]';

/** Sets tooltip text on an element from code (already translated strings). */
export function setTip(el, { title, help, kb, key } = {}) {
  if (!el) return el;
  if (key != null) el.dataset.tip = key; else delete el.dataset.tip;
  if (title != null) el.dataset.tipTitle = title; else delete el.dataset.tipTitle;
  if (help != null && help !== '') el.dataset.tipHelp = help; else delete el.dataset.tipHelp;
  if (kb) el.dataset.kb = kb;
  el.removeAttribute('title');
  if (el === target && tip?.classList.contains('on')) fill(el);
  return el;
}

function content(el) {
  if (el.hasAttribute('title')) {
    const raw = el.getAttribute('title');
    el.removeAttribute('title');
    if (raw && !el.dataset.tipTitle && !el.dataset.tip) el.dataset.tipTitle = raw;
  }
  const key = el.dataset.tip;
  let title = el.dataset.tipTitle || '';
  let help = el.dataset.tipHelp || '';
  if (key) {
    if (!title) title = has(`${key}.title`) ? t(`${key}.title`) : has(key) ? t(key) : '';
    if (!help && has(`${key}.help`)) help = t(`${key}.help`);
  }
  if (!title) title = el.getAttribute('aria-label') || '';
  return { title, help, kb: el.dataset.kb || '' };
}

function fill(el) {
  const c = content(el);
  titleEl.textContent = c.title;
  helpEl.textContent = c.help;
  helpEl.hidden = !c.help;
  kbEl.replaceChildren(...fmtKeys(c.kb).map((k) => { const e = document.createElement('kbd'); e.className = 'kbd'; e.textContent = k; return e; }));
  kbEl.hidden = !c.kb;
  return !!(c.title || c.help);
}

/** Places the tooltip outside the target box: preferred side first, then the others. */
function place(el) {
  const r = el.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  tip.style.left = '0px';
  tip.style.top = '0px';
  tip.style.maxWidth = `${Math.min(300, vw - MARGIN * 2)}px`;
  const tr = tip.getBoundingClientRect();
  const pref = el.dataset.tipPos || (r.top < 80 ? 'bottom' : 'top');
  const order = { top: ['top', 'bottom', 'right', 'left'], bottom: ['bottom', 'top', 'right', 'left'], right: ['right', 'left', 'top', 'bottom'], left: ['left', 'right', 'top', 'bottom'] }[pref] || ['top', 'bottom', 'right', 'left'];
  const fits = {
    top: r.top - GAP - tr.height >= MARGIN,
    bottom: r.bottom + GAP + tr.height <= vh - MARGIN,
    right: r.right + GAP + tr.width <= vw - MARGIN,
    left: r.left - GAP - tr.width >= MARGIN,
  };
  const side = order.find((s) => fits[s]) || order[0];
  let x;
  let y;
  if (side === 'top' || side === 'bottom') {
    x = r.left + r.width / 2 - tr.width / 2;
    y = side === 'top' ? r.top - GAP - tr.height : r.bottom + GAP;
  } else {
    y = r.top + r.height / 2 - tr.height / 2;
    x = side === 'right' ? r.right + GAP : r.left - GAP - tr.width;
  }
  x = Math.max(MARGIN, Math.min(x, vw - tr.width - MARGIN));
  y = Math.max(MARGIN, Math.min(y, vh - tr.height - MARGIN));
  tip.style.left = `${Math.round(x)}px`;
  tip.style.top = `${Math.round(y)}px`;
  tip.dataset.side = side;
  // the little arrow points at the target's centre
  const ax = Math.max(10, Math.min(tr.width - 10, r.left + r.width / 2 - x));
  const ay = Math.max(10, Math.min(tr.height - 10, r.top + r.height / 2 - y));
  tip.style.setProperty('--ax', `${Math.round(ax)}px`);
  tip.style.setProperty('--ay', `${Math.round(ay)}px`);
}

function show(el) {
  if (!el.isConnected || !fill(el)) return;
  target = el;
  tip.classList.remove('on');
  tip.hidden = false;
  place(el);
  void tip.offsetWidth;
  tip.classList.add('on');
  shownAt = performance.now();
  const prev = el.getAttribute('aria-describedby') || '';
  if (!prev.split(' ').includes('hd-tip')) { el.dataset.tipDesc = prev; el.setAttribute('aria-describedby', `${prev} hd-tip`.trim()); }
}

export function hide() {
  clearTimeout(timer);
  timer = null;
  if (!target) return;
  if (target.dataset.tipDesc != null) {
    if (target.dataset.tipDesc) target.setAttribute('aria-describedby', target.dataset.tipDesc); else target.removeAttribute('aria-describedby');
    delete target.dataset.tipDesc;
  }
  target = null;
  tip.classList.remove('on');
  lastHide = performance.now();
}

function schedule(el, delay) {
  clearTimeout(timer);
  // moving straight from one tooltip to the next skips the delay
  const warm = performance.now() - lastHide < 300;
  timer = setTimeout(() => show(el), warm ? 40 : delay);
}

function findTarget(node) {
  const el = node instanceof Element ? node.closest(SELECTOR) : null;
  if (!el || el.closest('.hd-tip') || el.hasAttribute('data-no-tip')) return null;
  if (el.matches('[aria-disabled="true"] *')) return null;
  return el;
}

export function init() {
  tip = document.createElement('div');
  tip.className = 'hd-tip';
  tip.id = 'hd-tip';
  tip.setAttribute('role', 'tooltip');
  tip.hidden = true;
  titleEl = document.createElement('div');
  titleEl.className = 'hd-tip-t';
  helpEl = document.createElement('div');
  helpEl.className = 'hd-tip-h';
  kbEl = document.createElement('div');
  kbEl.className = 'hd-tip-k';
  tip.append(titleEl, helpEl, kbEl);
  document.body.append(tip);

  document.addEventListener('pointerover', (e) => {
    if (e.pointerType === 'touch') return;
    const el = findTarget(e.target);
    if (el === target) { clearTimeout(timer); return; }
    if (!el) { if (target) hide(); else clearTimeout(timer); return; }
    if (target) hide();
    // take the native title now so the browser does not show its own tooltip
    if (el.hasAttribute('title')) content(el);
    schedule(el, HOVER_DELAY);
  }, true);
  document.addEventListener('pointerout', (e) => {
    const to = e.relatedTarget instanceof Element ? findTarget(e.relatedTarget) : null;
    if (to && to === target) return;
    if (target && (!e.relatedTarget || !target.contains(e.relatedTarget))) hide();
    else if (!target) clearTimeout(timer);
  }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Tab') tabbedAt = performance.now(); }, true);
  document.addEventListener('focusin', (e) => {
    if (performance.now() - tabbedAt > 600) return;
    const el = findTarget(e.target);
    if (!el || el !== e.target) return;
    let visible = true;
    try { visible = el.matches(':focus-visible'); } catch {}
    if (!visible) return;
    if (target && target !== el) hide();
    schedule(el, FOCUS_DELAY);
  }, true);
  document.addEventListener('focusout', (e) => { if (e.target === target || !target) hide(); }, true);
  document.addEventListener('pointerdown', () => hide(), true);
  document.addEventListener('keydown', (e) => { if (target && (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ')) hide(); }, true);
  document.addEventListener('scroll', () => { if (target && performance.now() - shownAt > 50) hide(); }, true);
  window.addEventListener('blur', hide);
  window.addEventListener('resize', hide);
  onLocale(() => { if (target) { fill(target); place(target); } });
  // a target removed from the page (a closed window) takes its tooltip with it
  setInterval(() => { if (target && !target.isConnected) hide(); }, 400);
}

export const current = () => target;
