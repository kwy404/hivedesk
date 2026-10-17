// Entry point of Lend your PC in the browser.
//
// For the desktop (ui/): the window type and the dock slot the UI shell registers.
//   import { lendWindow, mountLend } from '/lend/index.js'
//   lendWindow.mount(el)       the host's "Use a friend's PC" window
//   mountLend(el)              the full Lend screen, for a hivedesk started with --lend
// Standalone: /lend/ (ui/lend/index.html) picks the right screen from the hello frame, so
// lending also works on its own. It loads the strings itself (no Voodoo there) and shows a
// small language picker.

import { HiveSocket } from './hive.js';
import { mountJoinWindow } from './join-window.js';
import { mountLendScreen } from './lend-screen.js';
import { T } from './text.js';
import { coreText, h, liveScope } from './view.js';
import { LOCALES, init, locale, onLocale, setLocale, t } from '/js/i18n.js';
import { init as initTips } from '/js/tooltip.js';

let shared = null;

/** One socket for the lend bridges, separate from the desktop's own socket. */
export function lendSocket() {
  shared ??= (() => {
    const hive = new HiveSocket();
    const ready = hive.connect().then(() => hive);
    hive.on('close', () => (shared = null));
    return ready;
  })();
  return shared;
}

function pageOptions() {
  // Test hooks: a page may set window.hivedeskLendOptions (brokers, iceServers) before boot.
  return globalThis.hivedeskLendOptions || {};
}

/** The words a page was opened with: /?w=..., #w=... (from `hivedesk --join <link>` or a pasted link). */
export function initialWords(loc = globalThis.location) {
  const m = /(?:^|[#&?])w=([A-Za-z-]+)/.exec(`${loc.search}${loc.hash}`);
  return m ? `#w=${m[1]}` : '';
}

export async function mountLend(el, { options = pageOptions() } = {}) {
  const hive = await lendSocket();
  const api = mountLendScreen(el, { hive, options });
  globalThis.hivedeskLend = api;
  return api;
}

export async function mountJoin(el, { options = pageOptions(), initial = initialWords() } = {}) {
  const hive = await lendSocket();
  const api = mountJoinWindow(el, { hive, options, initial });
  globalThis.hivedeskJoin = api;
  return api;
}

/** The window type and dock slot for the desktop shell. title and label read the current language. */
export const lendWindow = {
  type: 'lend',
  get title() {
    return T.joinTitle;
  },
  icon: 'link',
  dock: {
    slot: 'lend',
    get label() {
      return T.joinTitle;
    },
  },
  mount: (el, opts) => mountJoin(el, opts),
};

/** The language picker of the standalone page. */
function languagePicker() {
  const select = h(
    'select',
    { class: 'lend-lang-select', ta: 'lend.page.language', tip: 'tip.lend.language', on: { change: () => setLocale(select.value) } },
    LOCALES.map((l) => h('option', { value: l.code, text: l.name, attrs: { lang: l.code } })),
  );
  select.value = locale();
  onLocale((code) => (select.value = code));
  return h('div', { class: 'lend-lang' }, select);
}

/** Boots the standalone page: the Lend screen with --lend, the Join window otherwise. */
export async function boot(el = document.getElementById('lend-root')) {
  try {
    await init();
  } catch (err) {
    console.warn('[hivedesk] lend page strings unavailable, using English', err?.message);
  }
  const page = () => (document.title = t('lend.page.title'));
  page();
  onLocale(page);
  try {
    initTips();
  } catch (err) {
    console.warn('[hivedesk] tooltips unavailable', err?.message);
  }
  document.body.prepend(languagePicker());
  const hive = await lendSocket();
  return hive.hello?.lend ? mountLend(el) : mountJoin(el);
}

/** Shows why the standalone page could not start, in the current language. */
export function bootFailed(err, el = document.getElementById('lend-root')) {
  el.replaceChildren(liveScope(el).text('p', { class: 'lend-error' }, () => t('lend.page.error', { message: coreText(err?.message || err) })));
}
