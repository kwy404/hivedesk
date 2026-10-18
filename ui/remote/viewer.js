// The viewer side of remote screen: one window per session with the partner's screens and a toolbar
// (screen switch, side by side, quality, control on or off, Ctrl+Alt+Del, clipboard, files, chat,
// full screen, end session). Input goes to the local engine, which forwards it; the host checks it all.

import { h, icon } from '../js/dom.js';
import * as net from '../js/net.js';
import * as wm from '../js/wm.js';
import { notify } from '../js/notify.js';
import { tr, why, fmtLeft, cmd, store, onState, refresh, transferList, chatPanel, dropFiles } from './common.js';
import { MediaLink } from './media.js';
import { normalizePoint, wheelUnits, buttonOf, InputBatcher, HeldInput } from './pointer.js';
import { pullSignals } from './host.js';

export const viewers = new Map();   // session id -> controller

const QUALITY = ['auto', 'balanced', 'quality', 'speed'];

/** Reads this window's clipboard (text, HTML, PNG) for a paste into the partner's computer. */
export async function readBrowserClipboard() {
  try {
    if (navigator.clipboard.read) {
      for (const it of await navigator.clipboard.read()) {
        if (it.types.includes('image/png')) {
          const b = new Uint8Array(await (await it.getType('image/png')).arrayBuffer());
          let s = '';
          for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
          return { kind: 'image', png: btoa(s) };
        }
        if (it.types.includes('text/plain') || it.types.includes('text/html')) {
          const text = it.types.includes('text/plain') ? await (await it.getType('text/plain')).text() : '';
          const html = it.types.includes('text/html') ? await (await it.getType('text/html')).text() : undefined;
          return { kind: 'text', text, html };
        }
      }
      return null;
    }
    const text = await navigator.clipboard.readText();
    return text ? { kind: 'text', text } : null;
  } catch { return null; }
}

/** Writes an item from the partner into this window's clipboard (needs focus). */
export async function writeBrowserClipboard(item) {
  if (item.kind === 'image') {
    const bin = atob(item.png);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })]);
    return;
  }
  if (item.html && window.ClipboardItem) {
    await navigator.clipboard.write([new ClipboardItem({ 'text/plain': new Blob([item.text || ''], { type: 'text/plain' }), 'text/html': new Blob([item.html], { type: 'text/html' }) })]);
    return;
  }
  await navigator.clipboard.writeText(item.text || '');
}

wm.register('remote', {
  title: () => tr('remote.title'),
  glyph: () => icon('preview'),
  size: [980, 640],
  min: [380, 280],
  multi: true,
  create(ctx, sessionId) {
    const tiles = h('div', { class: 'rd-tiles' });
    const note = h('div', { class: 'rd-note' });
    const card = h('div', { class: 'rd-lock', hidden: true });
    const stage = h('div', { class: 'rd-stage', tabindex: '0' }, tiles, note, card);
    const left = h('span', { class: 'small muted rd-mono' });
    const screenSel = h('select', { class: 'rd-sel', hidden: true, 'aria-label': tr('remote.tb.screen') });
    const askSel = h('select', { class: 'rd-sel', hidden: true, 'aria-label': tr('remote.tb.screen') });
    const sideBtn = h('button', { type: 'button', class: 'btn btn-xs btn-quiet', hidden: true, 'aria-pressed': 'false', text: tr('remote.tb.sideBySide') });
    const qualitySel = h('select', { class: 'rd-sel', 'aria-label': tr('remote.tb.quality') }, ...QUALITY.map((q) => h('option', { value: q, text: tr(`remote.quality.${q}`) })));
    const controlBox = h('input', { type: 'checkbox' });
    const controlLbl = h('label', { class: 'rd-check rd-tb-ctl', title: '' }, controlBox, h('span', { text: tr('remote.tb.control') }));
    const cadBtn = h('button', { type: 'button', class: 'btn btn-xs btn-quiet', disabled: true, title: tr('remote.tb.cadNo'), 'aria-label': `${tr('remote.tb.cad')}: ${tr('remote.tb.cadNo')}`, text: tr('remote.tb.cad') });
    const clipChip = h('span', { class: 'rd-chip on', hidden: true, text: tr('remote.clip.synced') });
    const clipBtn = h('button', { type: 'button', class: 'btn btn-xs btn-quiet', hidden: true, text: tr('remote.tb.clipboard') });
    const filesBtn = h('button', { type: 'button', class: 'btn btn-xs btn-quiet', hidden: true, 'aria-pressed': 'false', text: tr('remote.tb.files') });
    const chatBtn = h('button', { type: 'button', class: 'btn btn-xs btn-quiet', 'aria-pressed': 'false', text: tr('remote.tb.chat') });
    const fullBtn = h('button', { type: 'button', class: 'btn btn-xs btn-quiet', text: tr('remote.tb.fullscreen') });
    const endBtn = h('button', { type: 'button', class: 'btn btn-xs btn-bad', text: tr('remote.tb.end'), on: { click: () => ctx.close() } });
    const drawer = h('div', { class: 'rd-drawer', hidden: true });
    const tb = h('div', { class: 'tb rd-tb' }, screenSel, sideBtn, askSel, qualitySel, controlLbl, cadBtn, clipChip, clipBtn, filesBtn, chatBtn, h('span', { class: 'grow' }), left, fullBtn, endBtn);
    ctx.body.append(tb, h('div', { class: 'rd-main' }, stage, drawer));
    dropFiles(stage, sessionId);

    const held = new HeldInput();
    const batch = new InputBatcher((events) => { net.command('remote.input', { sessionId, events }).catch(() => {}); });
    const v = { link: null, view: null, update, connected: false, streams: [], current: 0, side: false, controlOn: false, drawerKind: null, chat: null };
    viewers.set(sessionId, v);
    const timer = setInterval(() => { if (v.view?.expiresAt) left.textContent = tr('remote.bar.left', { time: fmtLeft(v.view.expiresAt - Date.now()) }); }, 1000);

    const granted = () => v.view?.state === 'granted';
    const controlling = () => granted() && v.view.mode === 'control' && v.view.control && !v.view.locked && !v.view.paused && v.controlOn;
    const clipToHost = () => granted() && ['both', 'to_host'].includes(v.view.clipboard);

    controlBox.addEventListener('change', () => {
      v.controlOn = controlBox.checked;
      if (!v.controlOn) for (const e of held.releaseEvents()) batch.push(e);
      stage.classList.toggle('rd-controlling', v.controlOn);
      if (v.controlOn) stage.focus();
    });
    qualitySel.addEventListener('change', () => cmd('remote.quality', { sessionId, preset: qualitySel.value }).catch(() => {}));
    screenSel.addEventListener('change', () => { v.current = Number(screenSel.value) || 0; renderTiles(); });
    sideBtn.addEventListener('click', () => { v.side = !v.side; sideBtn.setAttribute('aria-pressed', String(v.side)); renderTiles(); });
    askSel.addEventListener('change', () => {
      const val = askSel.value;
      askSel.value = '';
      if (!val) return;
      const [op, d] = val.split(':');
      cmd('remote.screen', { sessionId, op, display: d === '' ? null : Number(d) }).catch(() => {});
    });
    clipBtn.addEventListener('click', async () => {
      const item = await readBrowserClipboard();
      if (!item) { notify({ title: tr('remote.clip.empty'), tone: 'warn' }); return; }
      await cmd('remote.clip.send', { sessionId, item }).then(() => notify({ title: tr('remote.clip.sent'), tone: 'ok' })).catch(() => {});
    });
    const toggleDrawer = (kind) => {
      if (v.drawerKind === kind) { v.drawerKind = null; drawer.hidden = true; drawer.replaceChildren(); v.panel?.dispose?.(); v.chat = null; }
      else {
        v.panel?.dispose?.();
        v.drawerKind = kind;
        const p = kind === 'chat' ? chatPanel(sessionId) : transferList(sessionId);
        v.panel = p;
        v.chat = kind === 'chat' ? p : null;
        drawer.replaceChildren(p.el);
        drawer.hidden = false;
        p.focus?.();
      }
      chatBtn.setAttribute('aria-pressed', String(v.drawerKind === 'chat'));
      filesBtn.setAttribute('aria-pressed', String(v.drawerKind === 'files'));
    };
    chatBtn.addEventListener('click', () => toggleDrawer('chat'));
    filesBtn.addEventListener('click', () => toggleDrawer('files'));
    fullBtn.addEventListener('click', () => { if (document.fullscreenElement) document.exitFullscreen(); else stage.requestFullscreen?.().catch(() => {}); });

    function renderTiles() {
      const list = v.streams;
      const show = v.side ? list.map((s, i) => [s, i]) : list[v.current] ? [[list[v.current], v.current]] : list[0] ? [[list[0], 0]] : [];
      tiles.classList.toggle('side', v.side && list.length > 1);
      tiles.replaceChildren(...show.map(([s, i]) => {
        const video = h('video', { class: 'rd-video', autoplay: true, playsInline: true, muted: true, dataset: { d: String(i) } });
        video.srcObject = s;
        hookPointer(video, i);
        return video;
      }));
    }

    function update() {
      const view = (store.state?.views || []).find((x) => x.sessionId === sessionId) || null;
      v.view = view;
      if (!view) { note.textContent = ''; return; }
      ctx.setTitle(`${view.name}${view.address ? ` (${view.address.replace(/^(\d{3})(\d{3})(\d{3})(\d)$/, '$1 $2 $3 $4')})` : ''}`);
      if (view.state === 'asking') { note.textContent = tr('remote.view.waiting', { name: view.name }); return; }
      const ctlOk = view.mode === 'control';
      controlBox.disabled = !ctlOk || !view.control;
      if (controlBox.disabled && v.controlOn) { controlBox.checked = false; v.controlOn = false; for (const e of held.releaseEvents()) batch.push(e); }
      controlLbl.title = ctlOk ? (view.control ? tr('remote.tb.controlOn', { name: view.name }) : tr('remote.view.controlOff', { why: why(view.reason) })) : why('view_only');
      const clipOn = view.clipboard && view.clipboard !== 'off';
      clipChip.hidden = !clipOn;
      clipChip.textContent = clipOn ? tr('remote.clip.syncedDir', { dir: tr(`remote.clipdir.${view.clipboard === 'to_viewer' ? 'to_host' : view.clipboard === 'to_host' ? 'to_viewer' : 'both'}`, { name: view.name }) }) : '';
      clipChip.title = store.state?.clipboard?.native ? '' : tr('remote.clip.browserOnly');
      clipBtn.hidden = !clipToHost() || !!store.state?.clipboard?.native;
      filesBtn.hidden = !view.files;
      qualitySel.value = view.quality || 'auto';
      // Screens: the shared tracks, and the host's monitors that could be asked for.
      const n = Math.max(view.tracks || 0, v.streams.length);
      screenSel.hidden = n < 2;
      sideBtn.hidden = n < 2;
      screenSel.replaceChildren(...Array.from({ length: n }, (_, i) => h('option', { value: String(i), text: tr('remote.tb.screenN', { n: i + 1 }) })));
      screenSel.value = String(Math.min(v.current, Math.max(0, n - 1)));
      const displays = view.displays || [];
      askSel.hidden = displays.length < 2 && n < 2;
      askSel.replaceChildren(h('option', { value: '', text: tr('remote.tb.screen') }),
        ...displays.map((d, i) => h('option', { value: `switch:${i}`, text: `${tr('remote.tb.askScreen', { n: i + 1 })} (${d.w} x ${d.h})` })),
        h('option', { value: 'add:', text: tr('remote.bar.addScreen') }));
      card.hidden = !(view.locked || view.paused);
      card.textContent = view.locked ? tr('remote.view.locked', { name: view.name }) : view.paused ? tr('remote.view.paused', { name: view.name }) : '';
      if (!v.connected) note.textContent = tr('remote.view.connecting', { name: view.name });
      else note.textContent = '';
      if (!v.link) {
        v.link = new MediaLink({
          role: 'viewer',
          signal: (sig) => net.command('remote.signal', { sessionId, signal: sig }),
          onTracks: (streams) => { v.streams = streams; v.connected = streams.length > 0; renderTiles(); update(); },
          onState: (st) => { if (st === 'rejected') note.textContent = tr('remote.view.rejected'); }
        });
        pullSignals(sessionId, v.link);
      }
      if (!controlling()) for (const e of held.releaseEvents()) batch.push(e);
    }

    function hookPointer(video, d) {
      const point = (e) => normalizePoint(e.clientX, e.clientY, video.getBoundingClientRect(), video.videoWidth, video.videoHeight);
      video.addEventListener('pointermove', (e) => { if (!controlling()) return; const p = point(e); if (p?.inside) batch.push({ k: 'move', x: p.x, y: p.y, d }); });
      video.addEventListener('pointerdown', (e) => {
        stage.focus();
        if (!controlling()) return;
        const b = buttonOf(e.button);
        const p = point(e);
        if (b == null || !p?.inside) return;
        e.preventDefault();
        video.setPointerCapture?.(e.pointerId);
        held.button(b, true);
        batch.push({ k: 'move', x: p.x, y: p.y, d });
        batch.push({ k: 'btn', b, down: true });
      });
      video.addEventListener('pointerup', (e) => {
        const b = buttonOf(e.button);
        if (b == null || !held.buttons.has(b)) return;
        held.button(b, false);
        batch.push({ k: 'btn', b, down: false });
      });
      video.addEventListener('contextmenu', (e) => { if (controlling()) e.preventDefault(); });
      video.addEventListener('wheel', (e) => { if (!controlling()) return; e.preventDefault(); const w = wheelUnits(e); if (w.dx || w.dy) batch.push({ k: 'wheel', ...w }); }, { passive: false });
    }

    stage.addEventListener('keydown', async (e) => {
      if (!controlling()) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      // Ctrl+V in the window: hand this computer's clipboard over first (browser path), then press the keys.
      if (e.code === 'KeyV' && (e.ctrlKey || e.metaKey) && clipToHost() && !store.state?.clipboard?.native) {
        const item = await readBrowserClipboard();
        if (item) await net.command('remote.clip.send', { sessionId, item }).catch(() => {});
        await new Promise((r) => setTimeout(r, 150));
      }
      held.key(e.code, true);
      batch.push({ k: 'key', code: e.code, down: true });
    });
    stage.addEventListener('keyup', (e) => {
      if (!held.keys.has(e.code)) return;
      e.preventDefault();
      held.key(e.code, false);
      batch.push({ k: 'key', code: e.code, down: false });
    });
    stage.addEventListener('blur', () => { for (const e of held.releaseEvents()) batch.push(e); });
    // The browser clipboard path: focusing the window offers its clipboard to a partner that may receive it.
    stage.addEventListener('focus', async () => {
      if (!clipToHost() || store.state?.clipboard?.native) return;
      const item = await readBrowserClipboard();
      if (item && item !== v.lastClip) { v.lastClip = item; net.command('remote.clip.send', { sessionId, item }).catch(() => {}); }
    });

    const off = onState(() => update());
    update();
    ctx.onDispose(() => {
      off();
      clearInterval(timer);
      for (const e of held.releaseEvents()) batch.push(e);
      batch.flush();
      v.panel?.dispose?.();
      v.link?.close('stopped');
      viewers.delete(sessionId);
      if (store.state?.views?.some((x) => x.sessionId === sessionId)) net.command('remote.stop', { sessionId }).catch(() => {});
    });
  }
});

/** Asks the host of a p2p session for its screen (called from a peer's panel in the City). */
export async function askRemote(sessionId, { control = false, clipboard = false, files = false, reason = '' } = {}) {
  await cmd('remote.ask', { sessionId, control, clipboard, files, reason });
  await refresh();
  wm.open('remote', sessionId);
}
