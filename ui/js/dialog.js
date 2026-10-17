// A small modal dialog: scrim, focus trap, Escape, return focus, fade and rise animation.

import { h, icon } from './dom.js';

let openCount = 0;

/**
 * @param {{ titleKey?: string, title?: string, body: Node, cls?: string, onClose?: () => void, labelledBy?: string }} o
 * @returns {{ el: HTMLElement, close: () => void }}
 */
export function openDialog({ titleKey, title, body, cls = '', onClose, wide = false }) {
  const returnTo = document.activeElement;
  const scrim = h('div', { class: 'hd-scrim' });
  const id = `dlg-${Math.random().toString(36).slice(2, 8)}`;
  const head = h('div', { class: 'hd-dlg-h' },
    h('h2', { id, class: 'hd-dlg-t', ...(titleKey ? { tx: titleKey } : { text: title || '' }) }),
    h('button', { type: 'button', class: 'ibtn', ta: 'dialog.close', tip: 'tip.dialog.close', kb: 'Esc', on: { click: () => close() } }, icon('x')));
  const el = h('div', { class: `hd-dlg ${wide ? 'hd-dlg-wide' : ''} ${cls}`.trim(), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': id }, head, h('div', { class: 'hd-dlg-b' }, body));
  document.body.append(scrim, el);
  openCount++;
  document.documentElement.classList.add('has-dialog');
  requestAnimationFrame(() => { scrim.classList.add('on'); el.classList.add('on'); });
  const focusables = () => [...el.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])')].filter((x) => x.offsetParent !== null);
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key === 'Tab') {
      const f = focusables();
      if (!f.length) return;
      const first = f[0]; const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };
  el.addEventListener('keydown', onKey);
  scrim.addEventListener('pointerdown', () => close());
  (el.querySelector('[data-autofocus]') || focusables()[1] || focusables()[0])?.focus();
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    scrim.classList.remove('on');
    el.classList.remove('on');
    setTimeout(() => { scrim.remove(); el.remove(); }, 200);
    openCount--;
    if (!openCount) document.documentElement.classList.remove('has-dialog');
    if (returnTo && document.contains(returnTo)) returnTo.focus({ preventScroll: true });
    onClose?.();
  }
  return { el, close };
}
