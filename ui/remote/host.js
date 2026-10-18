// The host side of remote screen in the window: the accept dialog (who asks, what they ask for, nothing
// ticked, a countdown), the capture of one or more screens, and the session bar that stays on top of
// everything while anyone is connected, with what they may do, Pause, chat, files and Stop.

import { h, icon } from '../js/dom.js';
import * as net from '../js/net.js';
import { openDialog } from '../js/dialog.js';
import { notify } from '../js/notify.js';
import { tr, why, fmtLeft, avatar, cmd, store, refresh, transferList, chatPanel, dropFiles } from './common.js';
import { MediaLink } from './media.js';
import { hub } from '/city/hub.js';
import { avatarEl } from '/profile/ui.js';
import { CAPTURE } from './abr.js';

const dialogs = new Map();     // request id -> { close }
const links = new Map();       // session id -> { link, streams: MediaStream[] }
let bar = null;
let barTimer = null;
let pop = null;

// ---------- the accept dialog ----------

export function syncRequests(s) {
  const live = new Set((s.requests || []).map((r) => r.id));
  for (const [id, d] of dialogs) if (!live.has(id)) { d.close(); dialogs.delete(id); }
  for (const r of s.requests || []) if (!dialogs.has(r.id)) dialogs.set(r.id, acceptDialog(r, s));
}

function acceptDialog(r, s) {
  const support = s.support || {};
  const isAgent = !!r.agentId;
  let minutes = s.defaultMinutes || 15;
  const box = (key, asked, extra) => {
    const input = h('input', { type: 'checkbox', disabled: !asked });
    const row = h('label', { class: `rd-check ${asked ? '' : 'off'}` }, input, h('span', { text: tr(key) }), asked ? null : h('span', { class: 'small muted', text: ` ${tr('remote.perm.notAsked')}` }), extra || null);
    return { input, row };
  };
  const asks = r.asks || { view: true };
  const canControl = !isAgent && r.wants === 'control' && support.control;
  const view = box('remote.perm.view', true);
  const control = box('remote.perm.control', canControl);
  const clipDir = h('select', { class: 'rd-clipdir', disabled: true },
    ...['both', 'to_viewer', 'to_host'].map((d) => h('option', { value: d, text: tr(`remote.clipdir.${d}`, { name: r.name }) })));
  const clip = box('remote.perm.clipboard', !isAgent && !!asks.clipboard, clipDir);
  const files = box('remote.perm.files', !isAgent && !!asks.files);
  const acceptBtn = h('button', { type: 'button', class: 'btn btn-primary', disabled: true, text: tr(isAgent ? 'remote.ask.acceptAgent' : 'remote.ask.accept'), on: { click: () => decide(true) } });
  const sync = () => {
    // Control implies seeing the screen.
    if (control.input.checked) view.input.checked = true;
    clipDir.disabled = !clip.input.checked;
    acceptBtn.disabled = !(view.input.checked || control.input.checked);
  };
  for (const b of [view, control, clip, files]) b.input.addEventListener('change', sync);
  const durSeg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': tr('remote.ask.duration') },
    ...(s.durations || [5, 15, 60]).map((m) => h('button', {
      type: 'button', role: 'radio', 'aria-checked': String(m === minutes), text: tr('remote.ask.minutes', { n: m }),
      on: { click: (e) => { minutes = m; for (const b of durSeg.children) b.setAttribute('aria-checked', String(b === e.currentTarget)); } }
    })));
  const countdown = h('div', { class: 'small rd-countdown' });
  const deadline = Date.now() + (r.msLeft ?? 60000);
  const tick = setInterval(() => {
    const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    countdown.textContent = tr('remote.ask.countdown', { s: left });
    if (!left) clearInterval(tick);
  }, 250);
  const body = h('div', { class: 'rd-ask' },
    // Always the address derived avatar: a caller cannot choose how it looks here. The picture the caller chose
    // (docs/1.0/PROFILE.md) may only appear smaller, labeled as self chosen.
    h('div', { class: 'rd-who' }, avatar(r.avatar, 52),
      h('div', {},
        h('div', { class: 'rd-who-name', text: tr(isAgent ? 'remote.ask.agent' : 'remote.ask.lead', { name: r.name }) }),
        r.addressText ? h('div', { class: 'small muted rd-mono', text: tr('remote.ask.address', { address: r.addressText }) }) : null,
        hub.peers.peers[r.peerId]?.profile ? h('div', { class: 'small muted rd-self-chosen' }, avatarEl(hub.peers.peers[r.peerId].profile, 20), h('span', { text: ` ${tr('remote.ask.selfChosen')}` })) : null)),
    r.words?.length ? h('p', { class: 'small rd-words', text: tr('remote.ask.words', { name: r.name, words: r.words.join(' ') }) }) : null,
    r.reason ? h('p', { class: 'small muted', text: tr('remote.ask.reason', { reason: r.reason }) }) : null,
    h('p', { class: 'small', text: tr('remote.ask.perms', { name: r.name }) }),
    h('div', { class: 'rd-perms' }, view.row, isAgent ? null : control.row, isAgent ? null : clip.row, isAgent ? null : files.row),
    r.wants === 'control' && !support.control && !isAgent ? h('p', { class: 'small rd-warn', text: tr('remote.ask.controlOff', { why: why(support.reason) }) }) : null,
    h('div', { class: 'rd-field' }, h('div', { class: 'small muted', text: tr('remote.ask.duration') }), durSeg),
    h('p', { class: 'small muted', text: support.hotkey ? tr('remote.ask.killHotkey', { hotkey: s.hotkey }) : tr('remote.ask.killNoHotkey') }),
    h('div', { class: 'rd-actions' }, countdown, h('span', { class: 'grow' }),
      h('button', { type: 'button', class: 'btn btn-quiet', text: tr('remote.ask.reject'), on: { click: () => decide(false) } }), acceptBtn));
  let answered = false;
  const dlg = openDialog({ title: tr('remote.ask.title'), body, cls: 'rd-dlg', onClose: () => { clearInterval(tick); if (!answered) decide(false); } });

  async function decide(allow) {
    if (answered) return;
    answered = true;
    clearInterval(tick);
    dialogs.delete(r.id);
    dlg.close();
    if (!allow) { net.command('remote.answer', { requestId: r.id, allow: false }).catch(() => {}); return; }
    const answer = {
      requestId: r.id, allow: true, minutes, view: view.input.checked, control: control.input.checked,
      clipboard: clip.input.checked ? clipDir.value : 'off', files: files.input.checked
    };
    if (isAgent) { await cmd('remote.answer', answer).catch(() => {}); return; }
    // The screen picker needs this click, so it opens before anything is granted. No screen, no access.
    let stream;
    try { stream = await navigator.mediaDevices.getDisplayMedia(CAPTURE); } catch {
      notify({ title: tr('remote.ask.pickFailed'), tone: 'warn' });
      net.command('remote.answer', { requestId: r.id, allow: false }).catch(() => {});
      return;
    }
    let res;
    try { res = await cmd('remote.answer', answer); } catch { stream.getTracks().forEach((x) => x.stop()); return; }
    if (!res.allowed) { stream.getTracks().forEach((x) => x.stop()); return; }
    await startShare(r.sessionId, stream);
  }
  return dlg;
}

// ---------- capture ----------

async function reportTrack(sessionId, stream, index) {
  const track = stream.getVideoTracks()[0];
  const st = track.getSettings ? track.getSettings() : {};
  await cmd('remote.share.started', { sessionId, index, surface: st.displaySurface || 'unknown', width: st.width || 0, height: st.height || 0 }).catch(() => {});
  track.addEventListener('ended', () => {
    const l = links.get(sessionId);
    if (!l) return;
    const i = l.streams.indexOf(stream);
    if (i <= 0) stopShare(sessionId, true);
    else { l.streams.splice(i, 1); l.link.remove(i); net.command('remote.share.removed', { sessionId, index: i }).catch(() => {}); }
  });
}

async function startShare(sessionId, stream) {
  const link = new MediaLink({
    role: 'host',
    signal: (sig) => net.command('remote.signal', { sessionId, signal: sig }),
    onState: (st, detail) => {
      if (st === 'rejected') notify({ title: tr('remote.view.rejected'), tone: 'bad' });
      if (st === 'stats') { const l = links.get(sessionId); if (l) l.stats = detail; }
      if (st === 'closed' && detail !== 'stopped') stopShare(sessionId, true);
    }
  });
  links.set(sessionId, { link, streams: [stream], stats: '' });
  await reportTrack(sessionId, stream, 0);
  await link.share(stream).catch((err) => { notify({ title: tr('remote.error', { message: err.message }), tone: 'bad' }); stopShare(sessionId, true); });
  pullSignals(sessionId);
}

/** Another screen: the host picks it (the browser always asks), then it replaces track 0 or is added. */
async function chooseScreen(sessionId, op) {
  const l = links.get(sessionId);
  if (!l) return;
  let stream;
  try { stream = await navigator.mediaDevices.getDisplayMedia(CAPTURE); } catch { return; }
  if (op === 'add' && l.streams.length < 4) {
    l.streams.push(stream);
    await reportTrack(sessionId, stream, l.streams.length - 1);
    await l.link.share(stream).catch(() => {});
  } else {
    const old = l.streams[0];
    l.streams[0] = stream;
    await l.link.replace(0, stream).catch(() => {});
    old?.getTracks().forEach((x) => x.stop());
    await reportTrack(sessionId, stream, 0);
  }
}

export function stopShare(sessionId, tellEngine) {
  const l = links.get(sessionId);
  if (!l) return;
  links.delete(sessionId);
  for (const s of l.streams) s.getTracks().forEach((x) => x.stop());
  l.link.close('stopped');
  if (tellEngine) net.command('remote.stop', { sessionId }).catch(() => {});
}

export async function pullSignals(sessionId, target) {
  let r;
  try { r = await net.command('remote.signals', { sessionId }); } catch { return; }
  const l = links.get(sessionId);
  const to = target || l?.link;
  if (l && r.quality && r.quality !== l.quality) { l.quality = r.quality; l.link.setPreset(r.quality); }
  for (const s of r.signals || []) await to?.handle(s).catch(() => {});
}

export function hasShare(id) { return links.has(id); }

export function syncShares(s) {
  const live = new Map((s.shares || []).map((x) => [x.sessionId, x]));
  for (const id of [...links.keys()]) if (!live.has(id)) stopShare(id, false);
  for (const [id, x] of live) {
    const l = links.get(id);
    if (!l) continue;
    l.link.setPaused(x.paused);
    if (x.quality && x.quality !== l.quality) { l.quality = x.quality; l.link.setPreset(x.quality); }
  }
}

// ---------- the session bar ----------

function closePop() { pop?.dispose?.(); pop?.el.remove(); pop = null; }

function openPop(kind, sessionId, anchor) {
  if (pop?.kind === kind && pop.sessionId === sessionId) { closePop(); return; }
  closePop();
  const panel = kind === 'chat' ? chatPanel(sessionId) : transferList(sessionId);
  const el = h('div', { class: 'rd-pop', role: 'dialog' }, panel.el);
  document.body.append(el);
  const r = anchor.getBoundingClientRect();
  el.style.top = `${r.bottom + 6}px`;
  el.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
  pop = { el, kind, sessionId, dispose: panel.dispose, load: panel.load };
  panel.focus?.();
}

export function onChat(sessionId) { if (pop?.kind === 'chat' && pop.sessionId === sessionId) pop.load(); }

export function renderBar(s) {
  const shares = s?.available ? s.shares || [] : [];
  document.documentElement.classList.toggle('rd-shared', shares.length > 0);
  if (!shares.length) { bar?.remove(); bar = null; clearInterval(barTimer); barTimer = null; closePop(); return; }
  if (!bar) { bar = h('div', { class: 'rd-banner', role: 'region', 'aria-label': tr('remote.title') }); document.body.append(bar); }
  const lockedNow = s.lock?.locked === true;
  const rows = shares.map((x) => {
    const chips = [
      h('span', { class: 'rd-chip', text: tr(x.mode === 'control' ? 'remote.chip.control' : 'remote.chip.view') }),
      x.clipboard !== 'off' ? h('span', { class: 'rd-chip on', text: tr('remote.clip.syncedDir', { dir: tr(`remote.clipdir.${x.clipboard}`, { name: x.name }) }) }) : null,
      x.files ? h('span', { class: 'rd-chip', text: tr('remote.chip.files') }) : null,
      x.via === 'unattended' ? h('span', { class: 'rd-chip warn', text: tr('remote.bar.unattended') }) : null,
      x.paused ? h('span', { class: 'rd-chip warn', text: tr('remote.bar.paused') }) : null
    ];
    const ask = x.screenAsk ? h('span', { class: 'rd-ask-screen' },
      h('span', { text: tr('remote.bar.screenAsk', { name: x.name, what: tr(`remote.bar.screenAsk.${x.screenAsk.op}`) }) }),
      h('button', { type: 'button', class: 'btn btn-xs btn-primary', text: tr('remote.bar.screenAsk.do'), on: { click: () => chooseScreen(x.sessionId, x.screenAsk.op) } })) : null;
    const pick = x.mode === 'control' && x.controlReason === 'pick_display' && s.displays?.length > 1
      ? h('label', { class: 'rd-pick' }, h('span', { text: tr('remote.bar.pick') }),
        h('select', { on: { change: (e) => cmd('remote.display', { sessionId: x.sessionId, index: Number(e.target.value) }).catch(() => {}) } },
          h('option', { value: '', text: '...' }), ...s.displays.map((d, i) => h('option', { value: String(i), text: `${i + 1}: ${d.w} x ${d.h}${d.primary ? ' *' : ''}` }))))
      : null;
    const chatBtn = h('button', { type: 'button', class: 'btn btn-xs btn-quiet', text: tr('remote.bar.chat'), on: { click: (e) => openPop('chat', x.sessionId, e.currentTarget) } });
    const filesBtn = x.files ? h('button', { type: 'button', class: 'btn btn-xs btn-quiet', text: tr('remote.bar.files'), on: { click: (e) => openPop('files', x.sessionId, e.currentTarget) } }) : null;
    const row = h('div', { class: 'rd-bar-row' },
      h('b', { class: 'rd-bar-name', text: x.name }), ...chips, ask, pick, h('span', { class: 'grow' }),
      h('span', { class: 'small rd-left', dataset: { exp: String(x.expiresAt) }, text: tr('remote.bar.left', { time: fmtLeft(x.expiresAt - Date.now()) }) }),
      links.get(x.sessionId)?.streams.length < 4 ? h('button', { type: 'button', class: 'btn btn-xs btn-quiet', text: tr('remote.bar.addScreen'), on: { click: () => chooseScreen(x.sessionId, 'add') } }) : null,
      chatBtn, filesBtn,
      h('button', { type: 'button', class: 'btn btn-xs btn-quiet', text: tr(x.paused ? 'remote.bar.resume' : 'remote.bar.pause'), on: { click: () => cmd('remote.pause', { sessionId: x.sessionId, on: !x.paused }).catch(() => {}) } }),
      shares.length > 1 ? h('button', { type: 'button', class: 'btn btn-xs btn-bad', text: tr('remote.bar.stop'), on: { click: () => cmd('remote.stop', { sessionId: x.sessionId }).catch(() => {}) } }) : null);
    if (x.files) dropFiles(row, x.sessionId);
    return row;
  });
  bar.replaceChildren(
    h('div', { class: 'rd-bar-head' }, icon('preview', 'ico-sm'),
      h('b', { text: tr('remote.bar.with', { names: [...new Set(shares.map((x) => x.name))].join(', ') }) }),
      lockedNow ? h('span', { class: 'rd-lockedtag', text: tr('remote.bar.locked') }) : null,
      h('span', { class: 'grow' }),
      s.support?.hotkey ? h('span', { class: 'small', text: tr('remote.bar.hotkey', { hotkey: s.hotkey }) }) : null,
      h('button', { type: 'button', class: 'btn btn-sm btn-bad rd-stop', text: tr(shares.length > 1 ? 'remote.bar.stopAll' : 'remote.bar.stop'), on: { click: () => cmd('remote.stopAll', { from: 'banner' }).catch(() => {}) } })),
    ...rows);
  if (!barTimer) barTimer = setInterval(() => { for (const el of bar?.querySelectorAll('.rd-left') || []) el.textContent = tr('remote.bar.left', { time: fmtLeft(Number(el.dataset.exp) - Date.now()) }); }, 1000);
}

export function refreshSoon() { refresh(); }
export { store };
