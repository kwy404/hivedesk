// Entry point of Lend your PC in the browser.
//
// For the desktop (ui/): the window type and the dock slot the UI shell registers.
//   import { lendWindow, mountLend } from '/lend/index.js'
//   lendWindow.mount(el)       the host's "Use a friend's PC" window
//   mountLend(el)              the full Lend screen, for a hivedesk started with --lend
// Standalone: /lend/ (ui/lend/index.html) picks the right screen from the hello frame, so
// lending also works on its own.

import { HiveSocket } from './hive.js';
import { mountJoinWindow } from './join-window.js';
import { mountLendScreen } from './lend-screen.js';
import { T } from './text.js';

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

/** The window type and dock slot for the desktop shell. */
export const lendWindow = {
  type: 'lend',
  title: T.joinTitle,
  icon: 'link',
  dock: { slot: 'lend', label: T.joinTitle },
  mount: (el, opts) => mountJoin(el, opts),
};

/** Boots the standalone page: the Lend screen with --lend, the Join window otherwise. */
export async function boot(el = document.getElementById('lend-root')) {
  const hive = await lendSocket();
  return hive.hello?.lend ? mountLend(el) : mountJoin(el);
}
