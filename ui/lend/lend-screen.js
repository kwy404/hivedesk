// The friend's side: the Lend screen shown by `npx hivedesk --lend`.
// Six words, a QR code and a share link; then the confirmation words; then a live log of every
// request with a Stop lending button that works at any moment.
// Every text follows a live language switch (liveScope in view.js); unmount() unsubscribes.

import { LendOffer } from './core/session.js';
import { LenderBridge } from './core/bridge.js';
import { lendLink } from './core/link.js';
import { LIMITS } from './core/frames.js';
import { DEFAULT_RATE } from './core/ratelimit.js';
import { T } from './text.js';
import { clear, copyText, coreText, failText, h, liveScope, qrNode, requestLog, wordGrid } from './view.js';
import { mountP2PLend } from './p2p-screen.js';

/**
 * hive: a connected HiveSocket (or anything with command, notify, on, hello).
 * options: passed to LendOffer (brokers, iceServers, iterations, ...), plus linkBase.
 * A 1.0 engine (lend.status has p2p) gets the grant based screen of p2p-screen.js: identities,
 * the SAS check, per resource limits and real revokes. options.legacy keeps the 0.2 screen for a
 * friend who still runs 0.2.
 */
export function mountLendScreen(root, { hive, options = {}, linkBase } = {}) {
  root.classList.add('lend-screen');
  const state = { phase: 'idle', words: null, confirm: null, bridge: null, offer: null, peer: null, chatCommand: 'lend.chat' };
  const live = liveScope(root);
  const api = { state, start, stop, unmount, root };
  const model = () => hive.hello?.state?.brain?.model || hive.hello?.state?.settings?.brain?.model || '';
  let timer = null;

  const set = (phase, ...nodes) => {
    state.phase = phase;
    root.dataset.phase = phase;
    clearInterval(timer);
    clear(root).append(
      h('header', { class: 'lend-head' }, h('img', { src: '/assets/mascot.svg', alt: '', class: 'lend-mascot', width: 56, height: 56 }), h('div', null, live.text('h1', null, () => T.lendTitle), live.text('p', { class: 'lend-lead' }, () => T.lendLead))),
      ...nodes,
    );
  };

  const button = (cls, tip, label, onClick, extra = {}) => live.text('button', { class: cls, tip, on: { click: onClick }, ...extra }, label);
  const newWordsButton = () => button('lend-btn is-primary', 'tip.lend.newWords', () => T.newWords, start);

  async function probe() {
    try {
      const s = await hive.command('lend.status');
      state.chatCommand = s.guarded ? 'lend.chat' : 'brain.chat';
      return s;
    } catch {
      state.chatCommand = 'brain.chat'; // the lend plug-in is missing: the engine's own command
      return null;
    }
  }

  async function start() {
    state.offer?.stop();
    let relayStatus = null;
    const relays = live.text('p', { class: 'lend-status' }, () => (relayStatus ? T.lendRelays(relayStatus.connected.length, relayStatus.total) : T.lendRelaysWait));
    set('preparing', h('section', { class: 'lend-card' }, relays));
    const offer = new LendOffer(options);
    state.offer = offer;
    offer.on('status', (s) => {
      relayStatus = s;
      relays.textContent = relays.lendLabel();
    });
    offer.on('expired', () => state.phase === 'share' && set('expired', h('section', { class: 'lend-card' }, live.text('p', null, () => T.lendExpired), newWordsButton())));
    offer.on('failed', (reason) => state.offer === offer && showFail(reason));
    offer.on('connected', (peer, words) => state.offer === offer && connected(peer, words));
    let words;
    try {
      words = await offer.start();
    } catch (err) {
      if (state.offer !== offer) return;
      set('failed', h('section', { class: 'lend-card' }, live.text('p', { class: 'lend-error' }, () => T.lendRelaysFail), live.text('small', null, () => coreText(err.message)), newWordsButton()));
      return;
    }
    if (state.offer !== offer) return;
    state.words = words;
    const link = lendLink(words, linkBase);
    state.link = link;
    const copyLinkBtn = button('lend-btn', 'tip.lend.copyLink', () => T.copyLink, () => copyText(link, copyLinkBtn));
    const copyWordsBtn = button('lend-btn', 'tip.lend.copyWords', () => T.copyWords, () => copyText(words.join(' '), copyWordsBtn));
    const expires = h('p', { class: 'lend-muted' });
    const tickExpiry = () => (expires.textContent = T.lendExpires(Math.max(0, Math.round((offer.creator.expires - Date.now()) / 1000))));
    const qr = qrNode(link, T.lendTitle);
    set(
      'share',
      h(
        'section',
        { class: 'lend-card lend-share' },
        h(
          'div',
          { class: 'lend-share-words' },
          wordGrid(words, 'is-big'),
          live.text('p', null, () => T.lendWordsHelp),
          h('div', { class: 'lend-row' }, copyWordsBtn, copyLinkBtn),
          h('input', { class: 'lend-link', value: link, readOnly: true, ta: 'lend.shareLink', tip: 'tip.lend.link', on: { focus: (e) => e.target.select() } }),
          expires,
        ),
        qr,
      ),
      relays,
      limitsNote(),
    );
    live.add(() => qr.retitle(T.lendTitle), qr);
    live.add(tickExpiry, expires);
    timer = setInterval(tickExpiry, 1000);
  }

  function limitsNote() {
    return live.text('p', { class: 'lend-muted lend-limits' }, () => T.limitsNote({ perMinute: DEFAULT_RATE.perMinute, promptChars: LIMITS.promptChars, maxTokens: LIMITS.maxTokens }));
  }

  function showFail(reason) {
    set('failed', h('section', { class: 'lend-card' }, live.text('p', { class: 'lend-error' }, () => failText(reason)), newWordsButton()));
  }

  function connected(peer, confirmWords) {
    state.peer = peer;
    state.confirm = confirmWords;
    const bridge = new LenderBridge({ hive, peer, info: { label: hive.hello?.label || 'friend', model: model() || undefined }, chatCommand: state.chatCommand });
    state.bridge = bridge;
    const log = requestLog({ title: () => T.logTitle, empty: () => T.logEmpty, withPreview: true });
    live.add(log.relabel, log.el);
    bridge.on('log', (e) => log.add(e));
    bridge.on('stopped', (reason) => stopped(reason));
    const wait = live.text('p', { class: 'lend-muted', hidden: true }, () => T.confirmWaitFriend);
    const yes = button(
      'lend-btn is-primary',
      'tip.lend.confirmYes',
      () => T.confirmYes,
      () => {
        peer.confirmLocal();
        yes.disabled = no.disabled = true;
        if (!peer.ready) wait.hidden = false;
      },
      { dataset: { act: 'confirm' } },
    );
    const no = button('lend-btn', 'tip.lend.confirmNo', () => T.confirmNo, () => mismatch());
    set('confirm', h('section', { class: 'lend-card' }, live.text('h2', null, () => T.confirmTitle), live.text('p', null, () => T.confirmHelp), wordGrid(confirmWords, 'is-confirm'), h('div', { class: 'lend-row' }, yes, no), wait));
    peer.on('ready', () => lending(bridge, log));
    if (peer.ready) lending(bridge, log);
  }

  function mismatch() {
    state.bridge?.stop('The confirmation words did not match');
    set('mismatch', h('section', { class: 'lend-card' }, live.text('p', { class: 'lend-error' }, () => T.confirmMismatch), newWordsButton()));
  }

  function lending(bridge, log) {
    if (state.phase === 'lending') return;
    const label = bridge.peer.remoteHello?.label;
    const counters = h('p', { class: 'lend-counters' });
    const refresh = () => {
      const used = bridge.limiter.usage().requests;
      const refused = bridge.log.filter((e) => e.status === 'refused').length;
      counters.textContent = T.counters(bridge.served, refused, used, bridge.limiter.perMinute);
    };
    bridge.on('log', refresh);
    const m = model();
    set(
      'lending',
      h(
        'section',
        { class: 'lend-card lend-live' },
        h(
          'div',
          { class: 'lend-live-head' },
          h('span', { class: 'lend-dot is-on', attrs: { 'aria-hidden': 'true' } }),
          live.text('h2', null, () => T.lendingTo(label || T.yourFriend)),
          button('lend-btn is-danger', 'tip.lend.stop', () => T.stopLending, () => stop(), { dataset: { act: 'stop' } }),
        ),
        live.text('p', { class: 'lend-muted' }, () => (m ? T.lendingModel(m) : T.lendingNoModel)),
        counters,
        limitsNote(),
      ),
      log.el,
    );
    live.add(refresh, counters);
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
      h(
        'section',
        { class: 'lend-card' },
        h('span', { class: 'lend-dot', attrs: { 'aria-hidden': 'true' } }),
        live.text('p', null, () => T.stopped),
        button('lend-btn is-primary', 'tip.lend.lendAgain', () => T.lendAgain, async () => {
          await hive.command('lend.resume').catch(() => {});
          start();
        }),
      ),
      logEl,
    );
  }

  /** The screen goes away: stops the offer, the lending and the language subscription. */
  function unmount() {
    api.p2p?.unmount();
    live.stop();
    clearInterval(timer);
    state.offer?.stop();
    state.bridge?.stop();
  }

  probe().then((s) => {
    if (s?.p2p && !options.legacy) {
      live.stop();
      return mountP2PLend(root, { hive, options }).then((p) => (api.p2p = p));
    }
    return start();
  });
  return api;
}
