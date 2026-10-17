// Helpers for widgets: reactive re-render on store revisions, batched to one frame.

import { h, icon } from '../dom.js';
import { L, tmap } from '../i18n.js';

const V = window.V;

/**
 * Re-runs `render` (outside of tracking, once per frame at most) whenever any value read
 * by `deps` changes. Must be called inside a window's effect scope so it stops on close.
 */
export function track(deps, render) {
  let queued = false;
  const flush = () => { queued = false; try { render(); } catch (err) { console.error(err); } };
  V.effect(() => {
    deps();
    void L.v; // a language switch re-renders too
    if (!queued) { queued = true; requestAnimationFrame(flush); }
  });
  flush();
}

export function stateBox({ icon: ic, img, title, text, actions = [] }) {
  return h('div', { class: 'state' },
    img ? h('img', { class: 'mel', src: img, alt: '' }) : h('div', { class: 'hexi' }, icon(ic || 'hive')),
    h('h3', { text: title }),
    text ? h('p', { text }) : null,
    actions.length ? h('div', { class: 'row' }, actions) : null);
}

export function btn(label, onClick, cls = 'btn btn-sm btn-quiet', ic) {
  return h('button', { type: 'button', class: cls, on: { click: onClick } }, ic ? icon(ic, 'ico-sm') : null, label);
}

/** Worker status words (translated at read time). */
export const STATUS_LABEL = tmap('status.worker');

/** Task status words (translated at read time). */
export const TASK_LABEL = tmap('status.task');

export const TASK_CHIP = { running: 'hchip-honey', done: 'hchip-ok', failed: 'hchip-bad', review: 'hchip-info', blocked: 'hchip-warn' };

/** Keeps a scroll container pinned to the bottom unless the user scrolled up. */
export function stickyScroll(el) {
  let pinned = true;
  el.addEventListener('scroll', () => { pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 40; });
  return {
    before: () => pinned,
    after: (force) => { if (pinned || force) el.scrollTop = el.scrollHeight; },
  };
}
