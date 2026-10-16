// Window types for Lend your PC. The content lives in ui/lend/ (owned by the lend module,
// see NOTES-ui.md): this file only hosts it in the window manager.
//   lend     "Use a friend's PC" (the host side), from lendWindow.mount(el)
//   lending  the full Lend screen, shown when this hivedesk runs with --lend

import { h, icon } from '../dom.js';
import { register } from '../wm.js';
import { stateBox } from './util.js';

let cssLinked = false;
function linkCss() {
  if (cssLinked) return;
  cssLinked = true;
  document.head.append(h('link', { rel: 'stylesheet', href: '/lend/lend.css' }));
}

function host(ctx, run, fallbackTitle) {
  const el = h('div', { class: 'pane lend-host' }, h('div', { class: 'state' }, h('span', { class: 'spin' }), h('p', { text: 'Opening...' })));
  ctx.body.append(el);
  let api = null;
  let closed = false;
  ctx.onDispose(() => {
    closed = true;
    // Closing the window ends the session, so nothing keeps lending or borrowing unseen.
    try {
      if (typeof api === 'function') { api(); return; }
      api?.stop?.();
      api?.state?.bridge?.stop?.('The window was closed');
      api?.state?.join?.stop?.();
    } catch (err) { console.error(err); }
  });
  linkCss();
  import('/lend/index.js').then(async (mod) => {
    if (closed) return;
    el.replaceChildren();
    api = await run(mod, el);
  }).catch((err) => {
    if (closed) return;
    console.warn('[hivedesk] lend panel unavailable:', err.message);
    el.replaceChildren(stateBox({ icon: 'lend', title: fallbackTitle, text: `${err.message}. Nothing is shared with anyone.` }));
  });
}

register('lend', {
  title: 'Use a friend\'s PC',
  glyph: () => icon('lend'),
  size: [560, 560],
  min: [320, 360],
  cardH: 620,
  create(ctx) {
    host(ctx, async (mod, el) => {
      if (mod.lendWindow?.title) ctx.setTitle(mod.lendWindow.title);
      return mod.lendWindow.mount(el);
    }, 'The lend panel did not load');
  },
});

register('lending', {
  title: 'Lending your PC',
  glyph: () => icon('lend'),
  size: [720, 640],
  min: [320, 420],
  cardH: 720,
  create(ctx) {
    host(ctx, (mod, el) => mod.mountLend(el), 'The Lend screen did not load');
  },
});
