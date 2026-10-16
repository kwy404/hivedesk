// Bottom dock: the crew (with live status), the widgets, Lend and Settings.
// Minimized windows fly into their dock item.

import { h, icon, clear } from './dom.js';
import { beeAvatar } from './bees.js';
import { S, rev, ui, worker } from './store.js';
import * as wm from './wm.js';
import { provide } from './menu.js';
import { workerMenu, workerStatus } from './widgets/worker.js';
import { openHire } from './widgets/hire.js';
import { track } from './widgets/util.js';

export const WIDGETS = [
  ['timeline', 'Timeline', 'plan'],
  ['chat', '#general', 'chat'],
  ['files', 'Files', 'folder'],
  ['preview', 'Live preview', 'preview'],
  ['runlog', 'Run log', 'terminal'],
  ['playbooks', 'Playbooks', 'playbook'],
  ['replay', 'Replay', 'replay'],
  ['approvals', 'Approvals', 'approval'],
];

const items = new Map(); // window id -> dock button
let tip;

function showTip(btn, text, sub) {
  tip.replaceChildren(text, sub ? h('span', { class: 'faint', text: sub }) : '');
  const r = btn.getBoundingClientRect();
  tip.classList.add('on');
  const tr = tip.getBoundingClientRect();
  tip.style.left = `${Math.max(8, Math.min(r.left + r.width / 2 - tr.width / 2, innerWidth - tr.width - 8))}px`;
  tip.style.top = `${r.top - tr.height - 10}px`;
}
const hideTip = () => tip.classList.remove('on');

function dockBtn(id, label, content, onClick, sub) {
  const b = h('button', { type: 'button', class: 'dk', 'aria-label': label, dataset: { win: id } }, content);
  b.addEventListener('click', onClick);
  b.addEventListener('pointerenter', () => showTip(b, label, typeof sub === 'function' ? sub() : sub));
  b.addEventListener('pointerleave', hideTip);
  b.addEventListener('focus', () => showTip(b, label, typeof sub === 'function' ? sub() : sub));
  b.addEventListener('blur', hideTip);
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
  tip = h('div', { class: 'dk-tip', role: 'tooltip' });
  document.body.append(tip);
  const crewBox = h('div', { class: 'row', style: 'gap:4px' });
  const widgetBox = h('div', { class: 'row', style: 'gap:4px' });
  const extraBox = h('div', { class: 'row', style: 'gap:4px' });
  const shelf = h('nav', { class: 'dock-shelf', 'aria-label': 'Dock' }, crewBox, h('div', { class: 'dock-sep' }), widgetBox, extraBox, h('div', { class: 'dock-sep' }),
    dockBtn('lend', 'Lend your PC', h('span', { class: 'dk-hex' }, icon('lend')), () => wm.toggleFromDock(ui.lend ? 'lending' : 'lend'), () => (ui.lend ? 'you are lending this PC' : "use a friend's model")),
    dockBtn('settings', 'Settings', h('span', { class: 'dk-hex' }, icon('model')), () => wm.toggleFromDock('settings')));
  el.append(shelf);
  wm.setDockTarget((id) => items.get(id === 'lending' ? 'lend' : id) || items.get(id.split(':')[0]) || null);

  for (const [type, label, ic] of WIDGETS) widgetBox.append(dockBtn(type, label, h('span', { class: 'dk-hex' }, icon(ic)), () => wm.toggleFromDock(type)));

  provide(shelf, (target) => {
    const b = target.closest?.('.dk');
    if (!b) return desktopMenu();
    const id = b.dataset.win;
    if (id === 'hire') return [{ label: 'Hire a worker', icon: 'hire', action: () => openHire() }];
    if (id.startsWith('worker:')) {
      const w = S().crew.find((x) => x.id === id.slice(7));
      return workerMenu(w);
    }
    const win = wm.get(id);
    return [
      { label: win ? (win.min ? 'Restore' : 'Focus') : 'Open', icon: 'arrow', action: () => (win ? wm.restore(id) : wm.open(...id.split(/:(.*)/s).slice(0, 2))) },
      { label: 'Minimize', icon: 'stop', disabled: !win || win.min, action: () => wm.minimize(id) },
      { sep: true },
      { label: 'Close', icon: 'x', disabled: !win, action: () => wm.close(id) },
    ];
  });

  track(() => [rev.crew, rev.workers, rev.queue, ui.unread.__v], () => {
    const s = S();
    for (const k of [...items.keys()]) if (k.startsWith('worker:') || k === 'hire') items.delete(k);
    clear(crewBox);
    for (const w of s.crew) {
      const st = workerStatus(w.id);
      const b = dockBtn(`worker:${w.id}`, w.name, beeAvatar(w, 38, { ring: true, status: st.key }), () => wm.toggleFromDock('worker', w.id), () => `${w.role || ''} · ${workerStatus(w.id).label}`);
      const unread = ui.unread[`dm:${w.id}`];
      if (unread) b.append(h('span', { class: 'badge-n', text: String(unread) }));
      crewBox.append(b);
    }
    crewBox.append(dockBtn('hire', 'Hire a worker', h('span', { class: 'dk-hex', style: 'background:transparent;outline:1px dashed rgba(242,233,218,.18);outline-offset:-1px' }, icon('hire')), () => openHire(), 'role prompt, color, tools'));
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
      if (w.type === 'code') extraBox.append(dockBtn(w.id, w.arg.split('/').pop(), h('span', { class: 'dk-hex' }, icon('code')), () => wm.toggleFromDock('code', w.arg), w.arg));
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
