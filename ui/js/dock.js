// Bottom dock: the crew (with live status), the widgets, Lend and Settings.
// Minimized windows fly into their dock item.

import { h, icon, clear } from './dom.js';
import { beeAvatar } from './bees.js';
import { S, rev, ui, worker, roleName } from './store.js';
import * as wm from './wm.js';
import { provide } from './menu.js';
import { workerMenu, workerStatus } from './widgets/worker.js';
import { openHire } from './widgets/hire.js';
import { track } from './widgets/util.js';
import { t } from './i18n.js';
import { setTip } from './tooltip.js';

/** Dock widgets: [window type, icon]. Labels and tooltips come from dock.<type> and tip.dock.<type>. */
export const WIDGETS = [
  ['timeline', 'plan'],
  ['chat', 'chat'],
  ['files', 'folder'],
  ['preview', 'preview'],
  ['runlog', 'terminal'],
  ['playbooks', 'playbook'],
  ['replay', 'replay'],
  ['approvals', 'approval'],
];
export const widgetLabel = (type) => t(`dock.${type}`);

const items = new Map(); // window id -> dock button
let pluginBox = null;

/** Lets another module add its own dock button (the Office adds the mini widget). */
export function addDockItem({ id, label, sub, content, onClick, menu }) {
  const b = dockBtn(id, { raw: label, sub }, content, onClick);
  if (menu) provide(b, menu);
  pluginBox?.append(b);
  return b;
}

/**
 * A dock button. Fixed items pass translation keys (`label`, `tipKey`); crew and code items pass
 * plain text in `raw` with an optional `sub` line (a string, or a function read when hovered).
 */
function dockBtn(id, { label, raw, tipKey, sub }, content, onClick) {
  const b = h('button', { type: 'button', class: 'dk', dataset: { win: id, tipPos: 'top' } }, content);
  if (label) { b.dataset.ta = label; b.setAttribute('aria-label', t(label)); b.dataset.tip = tipKey; }
  else {
    b.setAttribute('aria-label', raw);
    const refresh = () => setTip(b, { title: raw, help: typeof sub === 'function' ? sub() : sub });
    refresh();
    if (typeof sub === 'function') { b.addEventListener('pointerenter', refresh); b.addEventListener('focus', refresh); }
  }
  b.addEventListener('click', onClick);
  items.set(id, b);
  return b;
}

export function bounce(id) {
  const b = items.get(id);
  if (!b || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  b.classList.remove('bounce');
  void b.offsetWidth;
  b.classList.add('bounce');
}

export function init(el, desktopMenu) {
  const crewBox = h('div', { class: 'row dock-crew', style: 'gap:4px', dataset: { tour: 'crew' } });
  const widgetBox = h('div', { class: 'row', style: 'gap:4px' });
  const extraBox = h('div', { class: 'row', style: 'gap:4px' });
  pluginBox = h('div', { class: 'row', style: 'gap:4px' });
  const shelf = h('nav', { class: 'dock-shelf', ta: 'dock.label' }, crewBox, h('div', { class: 'dock-sep' }), widgetBox, extraBox, pluginBox, h('div', { class: 'dock-sep' }),
    dockBtn('lend', { label: 'dock.lend', tipKey: 'tip.dock.lend' }, h('span', { class: 'dk-hex' }, icon('lend')), () => wm.toggleFromDock(ui.lend ? 'lending' : 'lend')),
    dockBtn('settings', { label: 'dock.settings', tipKey: 'tip.dock.settings' }, h('span', { class: 'dk-hex' }, icon('model')), () => wm.toggleFromDock('settings')));
  el.append(shelf);
  wm.setDockTarget((id) => items.get(id === 'lending' ? 'lend' : id) || items.get(id.split(':')[0]) || null);

  for (const [type, ic] of WIDGETS) widgetBox.append(dockBtn(type, { label: `dock.${type}`, tipKey: `tip.dock.${type}` }, h('span', { class: 'dk-hex' }, icon(ic)), () => wm.toggleFromDock(type)));

  provide(shelf, (target) => {
    const b = target.closest?.('.dk');
    if (!b) return desktopMenu();
    const id = b.dataset.win;
    if (id === 'hire') return [{ label: t('dock.hire'), icon: 'hire', action: () => openHire() }];
    if (id.startsWith('worker:')) {
      const w = S().crew.find((x) => x.id === id.slice(7));
      return workerMenu(w);
    }
    const win = wm.get(id);
    return [
      { label: win ? (win.min ? t('win.restore') : t('dock.focus')) : t('dock.open'), icon: 'arrow', action: () => (win ? wm.restore(id) : wm.open(...id.split(/:(.*)/s).slice(0, 2))) },
      { label: t('win.minimize'), icon: 'stop', disabled: !win || win.min, action: () => wm.minimize(id) },
      { sep: true },
      { label: t('win.close'), icon: 'x', disabled: !win, action: () => wm.close(id) },
    ];
  });

  track(() => [rev.crew, rev.workers, rev.queue, ui.unread.__v], () => {
    const s = S();
    for (const k of [...items.keys()]) if (k.startsWith('worker:') || k === 'hire') items.delete(k);
    clear(crewBox);
    for (const w of s.crew) {
      const st = workerStatus(w.id);
      const b = dockBtn(`worker:${w.id}`, { raw: w.name, sub: () => t('dock.workerSub', { role: roleName(w) || t('dock.worker'), status: workerStatus(w.id).label }) }, beeAvatar(w, 38, { ring: true, status: st.key }), () => wm.toggleFromDock('worker', w.id));
      b.dataset.status = st.key;
      const unread = ui.unread[`dm:${w.id}`];
      if (unread) b.append(h('span', { class: 'badge-n', text: String(unread) }));
      crewBox.append(b);
    }
    crewBox.append(dockBtn('hire', { label: 'dock.hire', tipKey: 'tip.dock.hire' }, h('span', { class: 'dk-hex', style: 'background:transparent;outline:1px dashed rgba(242,233,218,.18);outline-offset:-1px' }, icon('hire')), () => openHire()));
    paintState();
  });

  track(() => [rev.approvals, ui.unread.__v], () => {
    const n = (S().approvals || []).length;
    const ab = items.get('approvals');
    ab.querySelector('.badge-n')?.remove();
    if (n) ab.append(h('span', { class: 'badge-n', text: String(n) }));
    const cb = items.get('chat');
    cb.querySelector('.badge-n')?.remove();
    if (ui.unread.general) cb.append(h('span', { class: 'badge-n', text: String(Math.min(99, ui.unread.general)) }));
  });

  function paintState() {
    // windows that are not in the fixed dock (code viewers) get their own items
    clear(extraBox);
    for (const k of [...items.keys()]) if (k.startsWith('code:')) items.delete(k);
    for (const w of wm.list()) {
      if (w.type === 'code') extraBox.append(dockBtn(w.id, { raw: w.arg.split('/').pop(), sub: w.arg }, h('span', { class: 'dk-hex' }, icon('code')), () => wm.toggleFromDock('code', w.arg)));
    }
    for (const [id, b] of items) {
      const w = wm.get(id) || (id === 'lend' ? wm.get('lending') : null);
      b.dataset.open = String(!!w);
      b.dataset.focus = String(!!w && !w.min && ui.focused === w.id);
      b.setAttribute('aria-pressed', String(!!w && !w.min));
    }
  }

  wm.onChange(paintState);
  paintState();
}
