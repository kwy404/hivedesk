// Small visual effects: the quiet success acknowledgement, skeleton placeholders and a typing
// indicator. 1.0 design (docs/1.0/DESIGN.md): no confetti, no bursts. A finished job is a calm toast
// (main.js notify) plus a short success pulse where the work happened (the Office scene).
// Everything respects prefers-reduced-motion and the Motion setting.

import { h, reducedMotion } from './dom.js';
import { t } from './i18n.js';

/**
 * A finished job. The Office mode, when it is open, shows its success pulse
 * (window.hivedeskOffice.celebrate); otherwise the toast that announced it is enough.
 */
export function celebrate() {
  if (reducedMotion()) return;
  const office = window.hivedeskOffice;
  if (office && typeof office.celebrate === 'function') {
    try { office.celebrate(); } catch (err) { console.warn('[hivedesk] office success pulse failed', err.message); }
  }
}

/** Skeleton lines while something loads. `lines` widths in percent. */
export function skeleton(lines = [92, 76, 84, 60], { label } = {}) {
  return h('div', { class: 'skel', role: 'status', 'aria-label': label || t('fx.loading'), 'aria-busy': 'true' },
    lines.map((w) => h('span', { class: 'skel-line', style: `width:${w}%` })));
}

/** Skeleton rows with an avatar circle, for lists such as chat or files. */
export function skeletonRows(n = 4, { label } = {}) {
  return h('div', { class: 'skel', role: 'status', 'aria-label': label || t('fx.loading'), 'aria-busy': 'true' },
    Array.from({ length: n }, (_, i) => h('div', { class: 'skel-row' }, h('span', { class: 'skel-dot' }), h('span', { class: 'skel-line', style: `width:${60 + ((i * 17) % 35)}%` }))));
}

/** "Mel is typing" with three dots. */
export function typingIndicator(name) {
  return h('div', { class: 'typing', role: 'status', 'aria-live': 'polite' },
    h('span', { class: 'typing-dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')),
    h('span', { class: 'typing-t', text: t('fx.typing', { name }) }));
}
