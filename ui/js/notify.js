// In-app toasts, a notification history (the bell in the top bar) and optional
// system notifications when the tab is in the background.

import { h, icon, fmtTime } from './dom.js';
import { beeAvatar } from './bees.js';
import { ui } from './store.js';
import { play } from './sound.js';
import { t } from './i18n.js';

const history = [];
let host;
const MAX_VISIBLE = 3;
let sysAllowed = false;
try { sysAllowed = localStorage.getItem('hivedesk.sysnotify') === '1'; } catch {}

export function init() {
  host = h('div', { class: 'ntoasts', role: 'region', ta: 'notify.region', 'aria-live': 'polite' });
  document.body.append(host);
}

export const all = () => history;
export function markRead() { for (const n of history) n.read = true; ui.notifications = 0; }

export function systemEnabled() { return sysAllowed && 'Notification' in window && Notification.permission === 'granted'; }
export async function enableSystem(on) {
  if (!on) { sysAllowed = false; try { localStorage.setItem('hivedesk.sysnotify', '0'); } catch {} return false; }
  if (!('Notification' in window)) return false;
  const p = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
  sysAllowed = p === 'granted';
  try { localStorage.setItem('hivedesk.sysnotify', sysAllowed ? '1' : '0'); } catch {}
  return sysAllowed;
}

const TONE_ICON = { ok: 'check', bad: 'x', warn: 'approval', info: 'hive' };

/**
 * @param {{ title: string, body?: string, tone?: 'ok'|'bad'|'warn'|'info', icon?: string,
 *   worker?: object, actions?: Array<{label: string, primary?: boolean, danger?: boolean, run: ()=>void}>,
 *   sound?: string, sticky?: boolean, timeout?: number, key?: string, quiet?: boolean }} n
 */
export function notify(n) {
  const entry = { ...n, ts: Date.now(), read: false };
  if (n.key) {
    const i = history.findIndex((x) => x.key === n.key);
    if (i >= 0) history.splice(i, 1);
    host.querySelector(`[data-key="${CSS.escape(n.key)}"]`)?.remove();
  }
  history.unshift(entry);
  if (history.length > 60) history.pop();
  ui.notifications = history.filter((x) => !x.read).length;
  if (n.sound) play(n.sound);
  if (document.hidden && systemEnabled()) {
    try { new Notification(n.title, { body: n.body || '', tag: n.key || undefined, silent: true }); } catch {}
  }
  if (n.quiet) return entry;
  const lead = n.worker ? beeAvatar(n.worker, 28, { ring: true }) : h('div', { class: `ntoast-i ${n.tone || ''}` }, icon(n.icon || TONE_ICON[n.tone] || 'hive', 'ico-sm'));
  const closeBtn = h('button', { class: 'ibtn ibtn-sm', type: 'button', ta: 'notify.dismiss', tip: 'tip.notify.dismiss', on: { click: () => dismiss() } }, icon('x', 'ico-sm'));
  const actions = n.actions?.length ? h('div', { class: 'ntoast-a' }, n.actions.map((a) => h('button', {
    type: 'button', class: `btn btn-xs ${a.primary ? 'btn-primary' : a.danger ? 'btn-bad' : 'btn-quiet'}`, text: a.label,
    on: { click: () => { dismiss(); a.run(); } },
  }))) : null;
  const el = h('div', { class: 'ntoast', role: n.tone === 'bad' || n.tone === 'warn' ? 'alert' : 'status', dataset: n.key ? { key: n.key } : undefined },
    lead, h('div', { class: 'grow' }, h('div', { class: 'ntoast-t', text: n.title }), n.body ? h('div', { class: 'ntoast-b', text: n.body }) : null, actions), closeBtn);
  host.append(el);
  while (host.children.length > MAX_VISIBLE) host.firstElementChild.remove();
  let timer = null;
  const arm = () => { if (!n.sticky) timer = setTimeout(dismiss, n.timeout || (n.actions ? 12000 : 5200)); };
  el.addEventListener('pointerenter', () => clearTimeout(timer));
  el.addEventListener('pointerleave', arm);
  el.addEventListener('focusin', () => clearTimeout(timer));
  arm();
  function dismiss() {
    clearTimeout(timer);
    if (!el.isConnected) return;
    el.classList.add('out');
    setTimeout(() => el.remove(), 200);
  }
  entry.dismiss = dismiss;
  return entry;
}

export function dismissKey(key) {
  host.querySelector(`[data-key="${CSS.escape(key)}"]`)?.remove();
}

export function historyView(onAfter) {
  const listEl = h('div', { class: 'noti-list' });
  if (!history.length) listEl.append(h('div', { class: 'pop-note', style: 'border:0', text: t('notify.empty') }));
  for (const n of history.slice(0, 40)) {
    listEl.append(h('div', { class: 'noti' },
      h('div', { class: `ntoast-i ${n.tone || ''}` }, icon(n.icon || TONE_ICON[n.tone] || 'hive')),
      h('div', { class: 'grow' }, h('div', { class: 'row' }, h('b', { class: 'grow ellipsis', style: 'font-weight:600', text: n.title }), h('span', { class: 'tiny faint', text: fmtTime(n.ts) })),
        n.body ? h('div', { class: 'small muted', text: n.body }) : null)));
  }
  markRead();
  onAfter?.();
  return listEl;
}
