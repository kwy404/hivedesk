// Remote screen in the hivedesk window: install() once after the net connection exists.
// Live frames from the engine only say that something changed; the data is pulled with commands.

import { h } from '../js/dom.js';
import * as net from '../js/net.js';
import * as wm from '../js/wm.js';
import { notify } from '../js/notify.js';
import { tr, fmtSize, cmd, store, onState, refresh } from './common.js';
import { syncRequests, syncShares, renderBar, stopShare, pullSignals, onChat } from './host.js';
import { viewers, askRemote, writeBrowserClipboard } from './viewer.js';
import './home.js';
import { syncListening, onDialPipe } from './pipes.js';

export { askRemote };

let installed = false;

async function onClip(d) {
  let item;
  try { item = await net.command('remote.clip.take', { id: d.id }); } catch { return; }
  const what = tr(`remote.clip.what.${item.kind === 'image' ? 'image' : 'text'}`);
  // With focus, the window writes it at once (the seamless path); without, a click does it.
  if (document.hasFocus()) {
    try { await writeBrowserClipboard(item); return; } catch { /* the browser said no: ask for a click */ }
  }
  notify({
    title: tr('remote.clip.got', { name: item.from || '', what }), tone: 'info', sticky: true, key: `rd-clip-${d.id}`,
    actions: [{ label: tr('remote.clip.copy'), primary: true, run: () => writeBrowserClipboard(item).catch((err) => notify({ title: tr('remote.error', { message: err.message }), tone: 'bad' })) }]
  });
}

function onClipFiles(d) {
  const f = (store.state?.clipboard?.pendingFiles || []).find((x) => x.id === d.id);
  if (f && f.state !== 'offered') return;
  const name = [...(store.state?.shares || []), ...(store.state?.views || [])].find((x) => x.sessionId === d.sessionId)?.name || '';
  notify({
    title: tr('remote.clip.files', { name, count: d.count, size: fmtSize(d.total || 0) }), tone: 'info', sticky: true, key: `rd-cf-${d.id}`,
    actions: [{ label: tr('remote.clip.paste'), primary: true, run: () => cmd('remote.clip.fetch', { id: d.id }).catch(() => {}) }]
  });
}

async function onFile(d) {
  const s = await refresh();
  if (d.kind === 'received') { notify({ title: tr('remote.file.saved', { file: '' }).trim(), tone: 'ok' }); return; }
  const f = (s?.incoming || []).find((x) => x.id === d.id);
  if (!f) return;
  notify({
    title: tr('remote.file.got', { name: f.from, file: f.name, size: fmtSize(f.size) }), tone: 'info', sticky: true, key: `rd-file-${f.id}`,
    actions: [
      { label: tr('remote.file.accept'), primary: true, run: () => cmd('remote.file.answer', { id: f.id, accept: true }).catch(() => {}) },
      { label: tr('remote.file.decline'), run: () => cmd('remote.file.answer', { id: f.id, accept: false }).catch(() => {}) }
    ]
  });
}

/** Starts the remote screen UI. */
export function install() {
  if (installed) return;
  installed = true;
  if (!document.querySelector('link[data-rd-css]')) document.head.append(h('link', { rel: 'stylesheet', href: '/remote/remote.css', attrs: { 'data-rd-css': '1' } }));
  onState((s) => {
    if (!s?.available) { renderBar(s); return; }
    syncListening(!!s.listening);
    syncRequests(s);
    syncShares(s);
    for (const v of s.views || []) if (v.state === 'granted' && !viewers.has(v.sessionId)) wm.open('remote', v.sessionId);
    renderBar(s);
  });
  net.on('live', (f) => {
    const d = f.data || {};
    switch (f.type) {
      case 'p2p.dial.pipe': onDialPipe(d); break;
      case 'remote.changed': refresh(); break;
      case 'remote.signal': pullSignals(d.sessionId, viewers.get(d.sessionId)?.link); break;
      case 'remote.quality': pullSignals(d.sessionId); break;
      case 'remote.clip': onClip(d); break;
      case 'remote.clip.files': refresh().then(() => onClipFiles(d)); break;
      case 'remote.clip.filesDone': refresh().then((s) => {
        notify({ title: tr('remote.clip.filesReady', { folder: s?.clipboard?.folder || tr('remote.clip.folderDefault') }), body: d.native ? tr('remote.clip.filesNative') : '', tone: 'ok' });
      }); break;
      case 'remote.chat': {
        viewers.get(d.sessionId)?.chat?.load();
        onChat(d.sessionId);
        const who = [...(store.state?.shares || []), ...(store.state?.views || [])].find((x) => x.sessionId === d.sessionId)?.name || '';
        if (!d.mine) notify({ title: `${tr('remote.tb.chat')}: ${who}`, tone: 'info', key: `rd-chat-${d.sessionId}`, quiet: !!viewers.get(d.sessionId)?.chat });
        break;
      }
      case 'remote.file': onFile(d); break;
      case 'remote.ended': {
        stopShare(d.sessionId, false);
        const v = viewers.get(d.sessionId);
        if (v) {
          notify({ title: d.reason === 'refused' ? tr('remote.view.refused', { name: v.view?.name || '' }) : tr('remote.view.ended', { reason: d.reason || '' }), tone: 'info' });
          v.link?.close('stopped');
          v.link = null;
          v.connected = false;
        }
        refresh();
        break;
      }
      default:
    }
  });
  net.on('connection', (c) => { if (c.state === 'open') refresh(); });
  refresh();
  window.hivedeskRemote = { askRemote, openHome: () => wm.open('remote-home'), stopAll: () => net.command('remote.stopAll', { from: 'banner' }) };
}
