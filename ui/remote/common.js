// Shared pieces of the remote screen windows: strings, formatting, the state pulled from the engine.

import { h } from '../js/dom.js';
import * as net from '../js/net.js';
import { notify } from '../js/notify.js';
import { t, has, locale } from '../js/i18n.js';
import { format } from '/i18n/index.js';
import { EN } from './strings.js';

export const tr = (k, p) => (has(k) ? t(k, p) : format(locale(), EN[k] ?? k, p || {}));
export const why = (code) => (code && (has(`remote.why.${code}`) || EN[`remote.why.${code}`]) ? tr(`remote.why.${code}`) : String(code || ''));

export const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`);
export const fmtLeft = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

export { groupDigits } from './digits.js';

/** A round avatar with initials and a hue that comes from the caller's address. */
export function avatar(av, size = 40) {
  const a = av || { initials: '?', hue: 30 };
  return h('div', { class: 'rd-avatar', style: { width: `${size}px`, height: `${size}px`, background: `hsl(${a.hue} 55% 42%)`, fontSize: `${Math.round(size * 0.4)}px` }, text: a.initials, 'aria-hidden': 'true' });
}

export const cmd = (type, data) => net.command(type, data).catch((err) => { notify({ title: tr('remote.error', { message: err.message }), tone: 'bad' }); throw err; });

/** The last remote.state, and who wants to hear when it changes. */
export const store = { state: null, fns: new Set() };
export function onState(fn) { store.fns.add(fn); return () => store.fns.delete(fn); }

let pending = null;
export function refresh() {
  if (pending) return pending;
  pending = net.command('remote.state').then((s) => {
    store.state = s;
    for (const fn of store.fns) { try { fn(s); } catch (err) { console.error(err); } }
    return s;
  }).catch(() => store.state).finally(() => { pending = null; });
  return pending;
}

/** Sends one file from the window to the peer of a session (a drop or a picker). */
export async function uploadFile(sessionId, f) {
  notify({ title: tr('remote.file.sending', { file: f.name }), tone: 'info' });
  const url = net.withToken(`/api/remote/upload?sessionId=${encodeURIComponent(sessionId)}&name=${encodeURIComponent(f.name)}`);
  const res = await fetch(url, { method: 'POST', headers: { 'x-hivedesk-upload': '1', 'content-type': 'application/octet-stream', ...(net.token ? { authorization: `Bearer ${net.token}` } : {}) }, body: f }).catch(() => null);
  if (!res?.ok) {
    let msg = '';
    try { msg = (await res.json()).error.message; } catch { msg = String(res?.status || 'offline'); }
    notify({ title: tr('remote.error', { message: msg }), tone: 'bad' });
  }
}

/** A drop zone: files dropped on `el` are sent to the session. */
export function dropFiles(el, sessionId) {
  el.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); el.classList.add('rd-drop-on'); } });
  el.addEventListener('dragleave', () => el.classList.remove('rd-drop-on'));
  el.addEventListener('drop', (e) => {
    el.classList.remove('rd-drop-on');
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    e.preventDefault();
    for (const f of files) uploadFile(sessionId, f);
  });
}

/** The list of transfers of one session, with progress, pause and cancel. */
export function transferList(sessionId) {
  const list = h('div', { class: 'rd-transfers' });
  const pick = h('input', { type: 'file', multiple: true, hidden: true, on: { change: () => { for (const f of pick.files || []) uploadFile(sessionId, f); pick.value = ''; } } });
  const zone = h('div', { class: 'rd-drop' }, h('span', { text: tr('remote.files.drop') }), h('button', { type: 'button', class: 'btn btn-xs btn-quiet', text: tr('remote.files.pick'), on: { click: () => pick.click() } }), pick);
  dropFiles(zone, sessionId);
  const el = h('div', { class: 'rd-files' }, zone, list);
  const render = (s) => {
    const rows = (s?.transfers || []).filter((x) => x.sessionId === sessionId);
    if (!rows.length) { list.replaceChildren(h('div', { class: 'small muted', text: tr('remote.files.none') })); return; }
    list.replaceChildren(...rows.map((x) => {
      const pct = x.size ? Math.round((x.done / x.size) * 100) : 100;
      return h('div', { class: 'rd-tr' },
        h('span', { class: 'rd-tr-dir', text: x.dir === 'out' ? '↑' : '↓', 'aria-hidden': 'true' }),
        h('div', { class: 'grow' },
          h('div', { class: 'small ellipsis', text: `${x.name} (${fmtSize(x.size)})${x.paused ? `, ${tr('remote.files.paused')}` : ''}` }),
          h('div', { class: 'rd-bar' }, h('div', { style: { width: `${pct}%` } }))),
        h('button', { type: 'button', class: 'btn btn-xs btn-quiet', text: tr(x.paused ? 'remote.files.resume' : 'remote.files.pause'), on: { click: () => cmd('remote.file.pause', { id: x.id, on: !x.paused }).catch(() => {}) } }),
        h('button', { type: 'button', class: 'btn btn-xs btn-quiet', text: tr('remote.files.cancel'), on: { click: () => cmd('remote.file.cancel', { id: x.id }).catch(() => {}) } }));
    }));
  };
  render(store.state);
  const off = onState(render);
  return { el, dispose: off };
}

/** A chat panel of one session. */
export function chatPanel(sessionId) {
  const log = h('div', { class: 'rd-chatlog', role: 'log', 'aria-live': 'polite' });
  const input = h('input', { type: 'text', class: 'grow', maxlength: '2000', placeholder: tr('remote.chat.placeholder') });
  const send = async () => { const text = input.value.trim(); if (!text) return; input.value = ''; await cmd('remote.chat.send', { sessionId, text }).catch(() => {}); load(); };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); send(); } e.stopPropagation(); });
  const el = h('div', { class: 'rd-chat' }, log, h('div', { class: 'row' }, input, h('button', { type: 'button', class: 'btn btn-xs btn-primary', text: tr('remote.chat.send'), on: { click: send } })));
  async function load() {
    let r;
    try { r = await net.command('remote.chat.log', { sessionId }); } catch { return; }
    log.replaceChildren(...(r.lines.length ? r.lines.map((l) => h('div', { class: `rd-msg ${l.mine ? 'mine' : ''}`, text: l.text })) : [h('div', { class: 'small muted', text: tr('remote.chat.empty') })]));
    log.scrollTop = log.scrollHeight;
  }
  load();
  return { el, load, focus: () => input.focus() };
}
