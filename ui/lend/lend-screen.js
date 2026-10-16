// The friend's side: the Lend screen shown by `npx hivedesk --lend`.
// Six words, a QR code and a share link; then the confirmation words; then a live log of every
// request with a Stop lending button that works at any moment.

import { LendOffer } from './core/session.js';
import { LenderBridge } from './core/bridge.js';
import { lendLink } from './core/link.js';
import { LIMITS } from './core/frames.js';
import { DEFAULT_RATE } from './core/ratelimit.js';
import { T } from './text.js';
import { clear, copyText, failText, h, qrNode, requestLog, wordGrid } from './view.js';

/**
 * hive: a connected HiveSocket (or anything with command, notify, on, hello).
 * options: passed to LendOffer (brokers, iceServers, iterations, ...), plus linkBase.
 */
export function mountLendScreen(root, { hive, options = {}, linkBase } = {}) {
  root.classList.add('lend-screen');
  const state = { phase: 'idle', words: null, confirm: null, bridge: null, offer: null, peer: null, chatCommand: 'lend.chat' };
  const api = { state, start, stop, root };
  const model = () => hive.hello?.state?.brain?.model || hive.hello?.state?.settings?.brain?.model || '';
  let timer = null;

  const set = (phase, ...nodes) => {
    state.phase = phase;
    root.dataset.phase = phase;
    clearInterval(timer);
    clear(root).append(
      h('header', { class: 'lend-head' }, h('img', { src: '/assets/mascot.svg', alt: '', class: 'lend-mascot', width: 56, height: 56 }), h('div', null, h('h1', { text: T.lendTitle }), h('p', { class: 'lend-lead', text: T.lendLead }))),
      ...nodes,
    );
  };

  async function probe() {
    try {
      const s = await hive.command('lend.status');
      state.chatCommand = s.guarded ? 'lend.chat' : 'brain.chat';
    } catch {
      state.chatCommand = 'brain.chat'; // the lend plug-in is missing: the engine's own command
    }
  }

  async function start() {
    state.offer?.stop();
    const relays = h('p', { class: 'lend-status', text: T.lendRelaysWait });
    set('preparing', h('section', { class: 'lend-card' }, relays));
    const offer = new LendOffer(options);
    state.offer = offer;
    offer.on('status', (s) => (relays.textContent = T.lendRelays(s.connected.length, s.total)));
    offer.on('expired', () => state.phase === 'share' && set('expired', h('section', { class: 'lend-card' }, h('p', { text: T.lendExpired }), h('button', { class: 'lend-btn is-primary', text: T.newWords, on: { click: start } }))));
    offer.on('failed', (reason) => state.offer === offer && showFail(reason));
    offer.on('connected', (peer, words) => state.offer === offer && connected(peer, words));
    let words;
    try {
      words = await offer.start();
    } catch (err) {
      if (state.offer !== offer) return;
      set('failed', h('section', { class: 'lend-card' }, h('p', { class: 'lend-error', text: T.lendRelaysFail }), h('small', { text: err.message }), h('button', { class: 'lend-btn is-primary', text: T.newWords, on: { click: start } })));
      return;
    }
    if (state.offer !== offer) return;
    state.words = words;
    const link = lendLink(words, linkBase);
    state.link = link;
    const copyLinkBtn = h('button', { class: 'lend-btn', text: T.copyLink, on: { click: () => copyText(link, copyLinkBtn) } });
    const copyWordsBtn = h('button', { class: 'lend-btn', text: T.copyWords, on: { click: () => copyText(words.join(' '), copyWordsBtn) } });
    const expires = h('p', { class: 'lend-muted' });
    const tickExpiry = () => (expires.textContent = T.lendExpires(Math.max(0, Math.round((offer.creator.expires - Date.now()) / 1000))));
    set(
      'share',
      h(
        'section',
        { class: 'lend-card lend-share' },
        h('div', { class: 'lend-share-words' }, wordGrid(words, 'is-big'), h('p', { text: T.lendWordsHelp }), h('div', { class: 'lend-row' }, copyWordsBtn, copyLinkBtn), h('input', { class: 'lend-link', value: link, readOnly: true, attrs: { 'aria-label': T.copyLink }, on: { focus: (e) => e.target.select() } }), expires),
        qrNode(link, T.lendTitle),
      ),
      relays,
      limitsNote(),
    );
    tickExpiry();
    timer = setInterval(tickExpiry, 1000);
  }

  function limitsNote() {
    return h('p', { class: 'lend-muted lend-limits', text: T.limitsNote({ perMinute: DEFAULT_RATE.perMinute, promptChars: LIMITS.promptChars, maxTokens: LIMITS.maxTokens }) });
  }

  function showFail(reason) {
    set('failed', h('section', { class: 'lend-card' }, h('p', { class: 'lend-error', text: failText(reason) }), h('button', { class: 'lend-btn is-primary', text: T.newWords, on: { click: start } })));
  }

  function connected(peer, confirmWords) {
    state.peer = peer;
    state.confirm = confirmWords;
    const bridge = new LenderBridge({ hive, peer, info: { label: hive.hello?.label || 'friend', model: model() || undefined }, chatCommand: state.chatCommand });
    state.bridge = bridge;
    const log = requestLog({ title: T.logTitle, empty: T.logEmpty, withPreview: true });
    bridge.on('log', (e) => log.add(e));
    bridge.on('stopped', (reason) => stopped(reason));
    const wait = h('p', { class: 'lend-muted', text: T.confirmWaitFriend, hidden: true });
    const yes = h('button', {
      class: 'lend-btn is-primary',
      text: T.confirmYes,
      dataset: { act: 'confirm' },
      on: {
        click: () => {
          peer.confirmLocal();
          yes.disabled = no.disabled = true;
          if (!peer.ready) wait.hidden = false;
        },
      },
    });
    const no = h('button', { class: 'lend-btn', text: T.confirmNo, on: { click: () => mismatch() } });
    set('confirm', h('section', { class: 'lend-card' }, h('h2', { text: T.confirmTitle }), h('p', { text: T.confirmHelp }), wordGrid(confirmWords, 'is-confirm'), h('div', { class: 'lend-row' }, yes, no), wait));
    peer.on('ready', () => lending(bridge, log));
    if (peer.ready) lending(bridge, log);
  }

  function mismatch() {
    state.bridge?.stop('The confirmation words did not match');
    set('mismatch', h('section', { class: 'lend-card' }, h('p', { class: 'lend-error', text: T.confirmMismatch }), h('button', { class: 'lend-btn is-primary', text: T.newWords, on: { click: start } })));
  }

  function lending(bridge, log) {
    if (state.phase === 'lending') return;
    const who = bridge.peer.remoteHello?.label || 'your friend';
    const counters = h('p', { class: 'lend-counters' });
    const refresh = () => {
      const used = bridge.limiter.usage().requests;
      const refused = bridge.log.filter((e) => e.status === 'refused').length;
      counters.textContent = `${bridge.served} ${T.served} · ${refused} ${T.refused} · ${T.perMinute(used, bridge.limiter.perMinute)}`;
    };
    bridge.on('log', refresh);
    refresh();
    const m = model();
    set(
      'lending',
      h(
        'section',
        { class: 'lend-card lend-live' },
        h('div', { class: 'lend-live-head' }, h('span', { class: 'lend-dot is-on', attrs: { 'aria-hidden': 'true' } }), h('h2', { text: T.lendingTo(who) }), h('button', { class: 'lend-btn is-danger', text: T.stopLending, dataset: { act: 'stop' }, on: { click: () => stop() } })),
        h('p', { class: 'lend-muted', text: m ? T.lendingModel(m) : T.lendingNoModel }),
        counters,
        limitsNote(),
      ),
      log.el,
    );
    state.log = log;
  }

  /** Stop lending at any moment: the bridge refuses new requests, tells the host and closes. */
  function stop(reason) {
    state.bridge?.stop(reason);
  }

  function stopped() {
    const logEl = state.log?.el;
    hive.command('lend.stop', { reason: 'stopped' }).catch(() => {});
    set(
      'stopped',
      h('section', { class: 'lend-card' }, h('span', { class: 'lend-dot', attrs: { 'aria-hidden': 'true' } }), h('p', { text: T.stopped }), h('button', {
        class: 'lend-btn is-primary',
        text: T.lendAgain,
        on: {
          click: async () => {
            await hive.command('lend.resume').catch(() => {});
            start();
          },
        },
      })),
      logEl,
    );
  }

  probe().then(start);
  return api;
}
