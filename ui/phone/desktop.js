// "Control from your phone" in the hivedesk window: the QR code of a one time invite, the accept
// dialog (the device, the six words to compare, the grants with everything but status off), the list
// of paired phones with their grants and Remove, and the listener that lets known phones come back.
// The window only carries ciphertext between the phone and the engine (bridge.js); the engine decides.
// install() once after net.connect(); window.hivedeskPhone.open() opens the window.

import { h } from '../js/dom.js';
import * as net from '../js/net.js';
import * as wm from '../js/wm.js';
import { openDialog } from '../js/dialog.js';
import { notify } from '../js/notify.js';
import { t, has, locale, fmtAgo } from '../js/i18n.js';
import { format } from '/i18n/index.js';
import { encodeQR, qrSvg } from '../lend/core/qr.js';
import { EN } from './strings.js';
import { GRANTS } from './core/grants.js';
import { PhoneListener, rendezvousOf } from './core/connect.js';
import { bridgePhone } from './bridge.js';

export const tr = (k, p) => (has(k) ? t(k, p) : format(locale(), EN[k] ?? k, p || {}));
/** A small inline glyph (the shared sprite has no phone). */
function glyph(kind) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'ico');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = kind === 'qr'
    ? '<path fill="none" stroke="currentColor" stroke-width="1.8" d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 18h2v2h-2zM14 18h2M18 14h2"/>'
    : '<rect x="7" y="2.5" width="10" height="19" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M10.5 18.5h3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>';
  return svg;
}

const left = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

const engine = {
  command: (type, data) => net.command(type, data),
  onLive: (fn) => net.on('live', (f) => fn(f.type, f.data))
};

const state = { status: null, fns: new Set() };
let pulling = null;
function refresh() {
  if (pulling) return pulling;
  pulling = net.command('phone.status').then((s) => {
    state.status = s;
    for (const fn of state.fns) { try { fn(s); } catch (err) { console.error(err); } }
    return s;
  }).catch(() => state.status).finally(() => { pulling = null; });
  return pulling;
}

const fail = (err) => notify({ title: tr('phone.err.engine', { message: err.message }), tone: 'bad' });

/** A phone connection that reached this window: hand it to the engine. */
function takeLink(link) {
  bridgePhone(engine, link).catch((err) => { try { link.close(); } catch { /* gone */ } fail(err); });
}

// ---------- known phones come back on the home topic ----------

let home = null;
let homeKeys = '';
async function syncHome() {
  let r;
  try { r = await net.command('phone.listen'); } catch { return; }
  const sig = JSON.stringify(r.keys.map((k) => k.deviceId));
  if (sig === homeKeys && home) return;
  homeKeys = sig;
  if (!r.keys.length) { home?.stop(); home = null; return; }
  const keys = await Promise.all(r.keys.map(async (k) => ({ ...(await rendezvousOf(r.topic, k.seal)), label: k.deviceId })));
  if (home) { home.setKeys(keys); return; }
  home = new PhoneListener({ topic: r.topic, keys });
  home.on('link', (link) => takeLink(link));
  home.start().catch(() => { home = null; homeKeys = ''; setTimeout(syncHome, 30_000); });
}

// ---------- the accept dialog ----------

const dialogs = new Map();
function syncDialogs(s) {
  const live = new Set((s.requests || []).map((r) => r.requestId));
  for (const [id, d] of dialogs) if (!live.has(id)) { d.close(); dialogs.delete(id); }
  for (const r of s.requests || []) if (!dialogs.has(r.requestId)) dialogs.set(r.requestId, acceptDialog(r));
}

function acceptDialog(r) {
  const toggles = new Map();
  const rows = GRANTS.map((g) => {
    const input = h('input', { type: 'checkbox', attrs: { 'data-grant': g.name } });
    input.checked = r.grants?.[g.name] === true;
    toggles.set(g.name, input);
    return h('label', { class: 'ph-check' }, input, h('span', { text: tr(`phone.grant.${g.name}`) }));
  });
  const grants = () => Object.fromEntries([...toggles].map(([n, i]) => [n, i.checked]));
  const countdown = h('div', { class: 'small ph-countdown', attrs: { 'aria-live': 'off' } });
  const deadline = Date.parse(r.expiresAt);
  const timer = setInterval(() => { countdown.textContent = tr('phone.ask.left', { time: left(deadline - Date.now()) }); }, 500);
  const answer = (accept, sasMatches) => {
    net.command('phone.pair.answer', { requestId: r.requestId, accept, sasMatches, grants: grants() })
      .then((res) => { if (res.accepted) notify({ title: tr('phone.note.paired', { name: r.device.name }), tone: 'ok', icon: 'check' }); refresh(); })
      .catch(fail);
    dlg.close();
  };
  const body = h('div', { class: 'ph-ask' },
    h('div', { class: 'ph-who' },
      h('div', { class: 'ph-dev', 'aria-hidden': 'true' }, glyph('phone')),
      h('div', {}, h('div', { class: 'ph-who-name', text: r.device.name }), h('div', { class: 'small muted ph-mono', text: r.device.words.join(' ') }))),
    r.device.pairedBefore ? h('div', { class: 'small muted', text: tr('phone.ask.again') }) : null,
    h('div', { class: 'ph-sas-q', text: tr('phone.ask.words') }),
    h('ol', { class: 'ph-sas', attrs: { 'aria-label': tr('phone.ask.words'), 'data-sas': r.sas.join(' ') } }, ...r.sas.map((w) => h('li', { text: w }))),
    h('div', { class: 'small muted', text: tr('phone.ask.wordsHelp') }),
    h('div', { class: 'ph-grants', role: 'group', 'aria-label': tr('phone.ask.grants') }, h('div', { class: 'ph-label', text: tr('phone.ask.grants') }), ...rows),
    h('div', { class: 'small muted', text: tr('phone.security') }),
    countdown,
    h('div', { class: 'ph-actions ph-actions-end' },
      h('button', { type: 'button', class: 'btn btn-quiet', text: tr('phone.ask.mismatch'), on: { click: () => answer(false, false) } }),
      h('button', { type: 'button', class: 'btn btn-quiet', text: tr('phone.ask.refuse'), on: { click: () => answer(false) } }),
      h('button', { type: 'button', class: 'btn btn-primary', text: tr('phone.ask.accept'), attrs: { 'data-autofocus': '1', 'data-phone-accept': '1' }, on: { click: () => answer(true, true) } })));
  const dlg = openDialog({ title: tr('phone.ask.title'), body, cls: 'ph-dlg', onClose: () => clearInterval(timer) });
  notify({ title: tr('phone.note.request', { name: r.device.name }), tone: 'info', icon: 'lock', key: `ph-${r.requestId}` });
  return { close: () => { clearInterval(timer); dlg.close?.(); } };
}

// ---------- the window ----------

function qrBox(url) {
  const box = h('div', { class: 'ph-qr', role: 'img', 'aria-label': tr('phone.scan'), attrs: { 'data-invite-url': url } });
  box.innerHTML = qrSvg(encodeQR(url, { ecl: 'M' }), { margin: 3, dark: '#141210', light: '#F7EEDF', title: tr('phone.scan') });
  return box;
}

wm.register('phone', {
  title: () => tr('phone.title'),
  glyph: () => glyph('phone'),
  size: [440, 640],
  min: [340, 420],
  create(ctx) {
    const root = h('div', { class: 'ph-win' });
    ctx.body.append(root);
    let invite = null;
    let listener = null;
    let tick = null;
    const stage = h('div', { class: 'ph-stage' });
    const list = h('div', { class: 'ph-list' });

    const stopInvite = () => {
      clearInterval(tick);
      listener?.stop();
      listener = null;
      if (invite && !invite.done) net.command('phone.invite.cancel', { inviteId: invite.inviteId }).catch(() => {});
      invite = null;
    };

    const intro = () => {
      stage.replaceChildren(
        h('p', { class: 'ph-intro', text: tr('phone.intro') }),
        h('button', { type: 'button', class: 'btn btn-primary ph-show', attrs: { 'data-phone-show': '1' }, on: { click: show } }, glyph('qr'), h('span', { text: tr('phone.show') })));
    };

    async function show() {
      stopInvite();
      let inv;
      try { inv = await net.command('phone.invite.create'); } catch (err) { fail(err); return; }
      invite = { ...inv, done: false };
      const status = h('div', { class: 'small muted ph-status', role: 'status', text: tr('phone.waiting') });
      const exp = h('div', { class: 'small ph-countdown' });
      stage.replaceChildren(
        h('div', { class: 'ph-scan', text: tr('phone.scan') }),
        qrBox(inv.url),
        exp,
        status,
        h('div', { class: 'ph-actions' }, h('button', { type: 'button', class: 'btn btn-quiet', text: tr('phone.cancel'), on: { click: () => { stopInvite(); intro(); } } })));
      const deadline = Date.parse(inv.expiresAt);
      const update = () => {
        const ms = deadline - Date.now();
        if (ms > 0) { exp.textContent = tr('phone.expires', { time: left(ms) }); return; }
        stopInvite();
        stage.replaceChildren(
          h('p', { class: 'ph-intro', text: tr('phone.expired') }),
          h('button', { type: 'button', class: 'btn btn-primary', text: tr('phone.newCode'), on: { click: show } }));
      };
      update();
      tick = setInterval(update, 500);
      try {
        const rv = await rendezvousOf(inv.rendezvous.topic, inv.rendezvous.seal);
        listener = new PhoneListener({ topic: rv.topic, keys: [{ key: rv.key, label: 'invite' }], once: true });
        listener.on('status', (s) => { status.textContent = `${tr('phone.waiting')}. ${tr('phone.relays', { n: s.connected.length, total: s.total })}`; });
        listener.on('link', (link) => {
          invite.done = true;
          status.textContent = tr('phone.connecting');
          takeLink(link);
        });
        await listener.start();
      } catch {
        status.textContent = tr('phone.err.relays');
      }
    }

    const renderList = (s) => {
      if ((s.requests || []).length === 0 && invite?.done) { stopInvite(); intro(); }
      const phones = s.phones || [];
      list.replaceChildren(
        h('h3', { class: 'ph-h', text: tr('phone.list.title') }),
        phones.length ? null : h('div', { class: 'small muted', text: tr('phone.list.empty') }),
        ...phones.map((p) => h('div', { class: 'ph-item', attrs: { 'data-device': p.deviceId } },
          h('div', { class: 'ph-item-h' },
            h('span', { class: `ph-dot ${p.online ? 'on' : ''}`, 'aria-hidden': 'true' }),
            h('div', { class: 'grow' }, h('div', { class: 'ph-who-name', text: p.name }), h('div', { class: 'small muted', text: p.online ? tr('phone.list.online') : tr('phone.list.offline', { when: fmtAgo(p.lastSeen) }) })),
            h('button', { type: 'button', class: 'btn btn-sm btn-danger', text: tr('phone.list.remove'), on: { click: () => {
              if (!confirm(tr('phone.list.removeConfirm', { name: p.name }))) return;
              net.command('phone.revoke', { deviceId: p.deviceId }).then(() => { notify({ title: tr('phone.list.removed', { name: p.name }), tone: 'ok' }); refresh(); }).catch(fail);
            } } })),
          h('div', { class: 'ph-grants' }, ...GRANTS.map((g) => {
            const input = h('input', { type: 'checkbox' });
            input.checked = p.grants[g.name] === true;
            input.addEventListener('change', () => net.command('phone.grants', { deviceId: p.deviceId, grants: { [g.name]: input.checked } }).then(refresh).catch((err) => { input.checked = !input.checked; fail(err); }));
            return h('label', { class: 'ph-check small' }, input, h('span', { text: tr(`phone.grant.${g.name}`) }));
          })))));
    };

    root.append(stage, list);
    intro();
    const off = onState(renderList);
    if (state.status) renderList(state.status);
    refresh();
    ctx.onDispose(() => { off(); stopInvite(); });
  }
});

export function onState(fn) { state.fns.add(fn); return () => state.fns.delete(fn); }

let installed = false;

/** Starts the phone remote UI: the accept dialog, the known phone listener and the window. */
export function install() {
  if (installed) return;
  installed = true;
  if (!document.querySelector('link[data-ph-css]')) document.head.append(h('link', { rel: 'stylesheet', href: '/phone/phone.css', attrs: { 'data-ph-css': '1' } }));
  onState((s) => { syncDialogs(s); syncHome(); });
  net.on('live', (f) => { if (f.type === 'phone.changed') refresh(); });
  net.on('connection', (c) => { if (c.state === 'open') refresh(); });
  refresh();
  window.hivedeskPhone = { open: () => wm.open('phone') };
}
