// Live preview of the workspace (served by the engine at /preview/).

import { h, icon, clear, debounce } from '../dom.js';
import { register } from '../wm.js';
import * as wm from '../wm.js';
import { S, rev, ui, onEvent } from '../store.js';
import { provide } from '../menu.js';
import { track, stateBox } from './util.js';

const V = window.V;
const pv = V.reactive({ path: '', device: 'desktop', auto: true, nonce: 0 });
try { const d = localStorage.getItem('hivedesk.preview.device'); if (d) pv.device = d; } catch {}

export function previewPath(path) {
  pv.path = path === 'index.html' ? '' : path;
  pv.nonce++;
  wm.open('preview');
}

register('preview', {
  title: 'Live preview',
  glyph: () => icon('preview'),
  size: [760, 560],
  min: [320, 240],
  cardH: 520,
  create(ctx) {
    const url = h('div', { class: 'url' }, icon('lock'), h('span', { class: 'ellipsis grow' }));
    const devSeg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Device width' },
      ...[['desktop', 'Desktop'], ['tablet', 'Tablet'], ['phone', 'Phone']].map(([k, label]) => h('button', { type: 'button', 'aria-pressed': String(pv.device === k), dataset: { k }, title: label, on: { click: () => { pv.device = k; try { localStorage.setItem('hivedesk.preview.device', k); } catch {} } } }, label)));
    const reload = h('button', { class: 'ibtn', type: 'button', title: 'Reload', 'aria-label': 'Reload preview', on: { click: () => pv.nonce++ } },
      h('span', { html: '<svg class="ico" viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v4.6h-4.6"/></svg>' }));
    const autoBtn = h('button', { class: 'ibtn', type: 'button', title: 'Reload when files change', 'aria-label': 'Reload when files change', 'aria-pressed': String(pv.auto), on: { click: () => { pv.auto = !pv.auto; autoBtn.setAttribute('aria-pressed', String(pv.auto)); } } }, icon('replay'));
    const ext = h('a', { class: 'ibtn', title: 'Open in a new tab', 'aria-label': 'Open in a new tab', target: '_blank', rel: 'noopener' },
      h('span', { html: '<svg class="ico" viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>' }));
    const wrap = h('div', { class: 'pv-wrap' });
    ctx.body.append(h('div', { class: 'tb' }, url, autoBtn, reload, devSeg, ext), wrap);
    provide(wrap, () => [
      { label: 'Reload', icon: 'replay', action: () => pv.nonce++ },
      { label: 'Device', icon: 'preview', items: [['desktop', 'Desktop'], ['tablet', 'Tablet'], ['phone', 'Phone']].map(([k, l]) => ({ label: l, checked: pv.device === k, action: () => { pv.device = k; } })) },
      { label: 'Reload when files change', checked: pv.auto, action: () => { pv.auto = !pv.auto; } },
      { label: 'Open in a new tab', icon: 'arrow', action: () => ext.click() },
    ]);

    const bumpLater = debounce(() => { if (pv.auto && !ui.replay) pv.nonce++; }, 900);
    const off = onEvent((ev) => { if (ev.type === 'file.changed') bumpLater(); });
    ctx.onDispose(off);

    let frame = null;
    let current = '';
    track(() => [rev.files, pv.nonce, pv.device, pv.path, ui.replay], () => {
      const s = S();
      for (const b of devSeg.children) b.setAttribute('aria-pressed', String(b.dataset.k === pv.device));
      wrap.dataset.dev = pv.device;
      const hasIndex = !!s.files[pv.path || 'index.html'] || Object.keys(s.files).some((p) => /(^|\/)index\.html?$/i.test(p));
      const src = `/preview/${pv.path}`; // no token: the preview is public to localhost, sandboxed, read only
      url.querySelector('span').textContent = `workspace/${pv.path || 'index.html'}`;
      ext.href = src;
      ctx.setSub(ui.replay ? 'shows the files on disk now' : '');
      if (!hasIndex) {
        frame = null; current = '';
        clear(wrap).append(stateBox({ icon: 'preview', title: 'Nothing to preview yet', text: 'When the crew writes an index.html in the workspace, the page runs here and reloads as files change.' }));
        return;
      }
      const key = `${src}#${pv.nonce}`;
      if (frame && current === key) return;
      current = key;
      // The workspace is code written by the crew: it runs sandboxed, in its own origin,
      // so it can never call the hivedesk API with your session.
      frame = h('iframe', { title: 'Live preview of the workspace', src, sandbox: 'allow-scripts allow-forms allow-modals allow-popups', referrerpolicy: 'no-referrer' });
      clear(wrap).append(frame);
    });
  },
});
