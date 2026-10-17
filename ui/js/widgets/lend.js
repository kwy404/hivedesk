// Window types for Lend your PC. The content lives in ui/lend/ (owned by the lend module,
// see NOTES-ui.md): this file only hosts it in the window manager.
//   lend     "Use a friend's PC" (the host side), from lendWindow.mount(el)
//   lending  the full Lend screen, shown when this hivedesk runs with --lend

import { h, icon } from '../dom.js';
import { register } from '../wm.js';
import { t } from '../i18n.js';
import { stateBox } from './util.js';

let cssLinked = false;
let lendMod = null;
function linkCss() {
  if (cssLinked) return;
  cssLinked = true;
  document.head.append(h('link', { rel: 'stylesheet', href: '/lend/lend.css' }));
}

/** fallbackKey: translation key of the title shown when the lend module does not load. */
function host(ctx, run, fallbackKey) {
  const el = h('div', { class: 'pane lend-host' }, h('div', { class: 'state' }, h('span', { class: 'spin' }), h('p', { tx: 'lendwin.opening' })));
  ctx.body.append(el);
  let api = null;
  let closed = false;
  ctx.onDispose(() => {
    closed = true;
    // Closing the window ends the session, so nothing keeps lending or borrowing unseen.
    // The reason goes to the other PC as is (not translated: its language may differ).
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
    el.replaceChildren(stateBox({ icon: 'lend', title: t(fallbackKey), text: t('lendwin.failText', { error: err.message }) }));
  });
}

register('lend', {
  // The lend module's own title once it is loaded (a getter in the current language), so a
  // language switch renames the window; ctx.setTitle would freeze it.
  title: () => lendMod?.lendWindow?.title || t('lendwin.lend.title'),
  glyph: () => icon('lend'),
  size: [560, 560],
  min: [320, 360],
  cardH: 620,
  create(ctx) {
    host(ctx, async (mod, el) => {
      lendMod = mod;
      return mod.lendWindow.mount(el);
    }, 'lendwin.lend.failed');
  },
});

register('lending', {
  title: () => t('lendwin.lending.title'),
  glyph: () => icon('lend'),
  size: [720, 640],
  min: [320, 420],
  cardH: 720,
  create(ctx) {
    host(ctx, (mod, el) => mod.mountLend(el), 'lendwin.lending.failed');
  },
});
