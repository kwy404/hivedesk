// The host's side: the "Use a friend's PC" window. Six word boxes (a whole phrase or the share
// link pasted into one box fills all six), an optional QR scan, then the confirmation words,
// then the friend's model joins the turn scheduler as one more brain.

import { LendJoin } from './core/session.js';
import { HostBridge } from './core/bridge.js';
import { WORD_COUNT, normalizeWord, resolvePhrase, resolveWord, suggestWords } from './core/words.js';
import { readJoinInput, wordsFromLink } from './core/link.js';
import { looksLikePaste, spread } from './core/paste.js';
import { T } from './text.js';
import { clear, failText, h, requestLog, wordGrid } from './view.js';

/**
 * hive: a connected HiveSocket. options: passed to LendJoin. initial: a link or phrase to prefill
 * (for example the page hash #w=...); with six good words it connects right away.
 */
export function mountJoinWindow(root, { hive, options = {}, initial = '', label = 'host' } = {}) {
  root.classList.add('lend-join');
  const state = { phase: 'idle', join: null, peer: null, bridge: null, confirm: null };
  const api = { state, connect, root, fill };
  let inputs = [];

  const set = (phase, ...nodes) => {
    state.phase = phase;
    root.dataset.phase = phase;
    clear(root).append(h('header', { class: 'lend-head is-small' }, h('div', null, h('h2', { text: T.joinTitle }), h('p', { class: 'lend-lead', text: T.joinLead }))), ...nodes);
  };

  function form(values = []) {
    const hints = [];
    const msg = h('p', { class: 'lend-muted', attrs: { 'aria-live': 'polite' } });
    inputs = Array.from({ length: WORD_COUNT }, (_, i) => {
      const input = h('input', {
        id: `lend-w${i}`,
        class: 'lend-box',
        value: values[i] || '',
        autocomplete: 'off',
        autocapitalize: 'none',
        spellcheck: false,
        attrs: { 'aria-label': T.joinWord(i + 1), inputmode: 'text', enterkeyhint: i < WORD_COUNT - 1 ? 'next' : 'go' },
      });
      hints.push(h('small', { class: 'lend-hint' }));
      return input;
    });
    const update = () =>
      inputs.forEach((input, i) => {
        const raw = input.value.trim();
        const r = resolveWord(raw);
        input.parentElement?.classList.toggle('is-ok', !!r);
        input.parentElement?.classList.toggle('is-bad', !!raw && !r && raw.length >= 3);
        hints[i].textContent = r && r.how !== 'exact' ? r.word : raw && !r && raw.length >= 3 ? T.joinUnknown : '';
      });
    const doSpread = (i, text) => {
      const r = spread(inputs.map((x) => x.value), i, text);
      if (!r) return false;
      r.values.forEach((v, k) => (inputs[k].value = v));
      update();
      inputs[r.focus].focus();
      if (resolvePhrase(r.values).ok) go();
      return true;
    };
    inputs.forEach((input, i) => {
      input.addEventListener('paste', (e) => {
        if (doSpread(i, e.clipboardData?.getData('text') ?? '')) e.preventDefault();
      });
      input.addEventListener('input', (e) => {
        // Phone keyboards often insert clipboard text without a paste event.
        if (looksLikePaste(input.value) && doSpread(i, input.value)) return;
        update();
        if (e.inputType && !e.inputType.startsWith('insert')) return;
        const raw = normalizeWord(input.value);
        const r = resolveWord(raw);
        if (r?.how === 'exact' && (raw.length >= 4 || suggestWords(raw, 2).length === 1) && i < WORD_COUNT - 1) inputs[i + 1].focus();
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (i < WORD_COUNT - 1 && !input.value.trim()) inputs[i + 1].focus();
          else go();
        } else if (e.key === ' ' && input.value.trim() && i < WORD_COUNT - 1) {
          e.preventDefault();
          inputs[i + 1].focus();
        } else if (e.key === 'Backspace' && !input.value && i > 0) inputs[i - 1].focus();
      });
      input.addEventListener('blur', () => {
        const r = resolveWord(input.value);
        if (r && r.how !== 'exact') input.value = r.word;
        update();
      });
    });
    const go = () => {
      const res = resolvePhrase(inputs.map((x) => x.value));
      if (!res.ok) {
        msg.textContent = T.joinIncomplete;
        inputs[res.missing[0] ?? 0]?.focus();
        return;
      }
      connect(res.words);
    };
    const scan = scanButton((text) => {
      const words = wordsFromLink(text);
      if (words) doSpread(0, text);
    });
    set(
      'form',
      h(
        'form',
        { class: 'lend-card lend-form', on: { submit: (e) => (e.preventDefault(), go()) } },
        h('div', { class: 'lend-boxes' }, inputs.map((input, i) => h('label', { class: 'lend-cell' }, h('span', { class: 'lend-n', text: String(i + 1) }), input, hints[i]))),
        h('div', { class: 'lend-row' }, h('button', { class: 'lend-btn is-primary', type: 'submit', text: T.joinGo, dataset: { act: 'join' } }), scan),
        msg,
      ),
    );
    update();
  }

  function fill(text) {
    const r = readJoinInput(text);
    form(r.words.map((w, i) => w || ''));
    if (r.ok) connect(r.words);
  }

  async function connect(words) {
    state.join?.stop();
    const status = h('p', { class: 'lend-status', text: T.joinKnocking });
    set('knocking', h('section', { class: 'lend-card' }, wordGrid(words), status));
    const join = new LendJoin(options);
    state.join = join;
    join.on('timeout', () => state.join === join && !state.peer && ended(T.joinTimeout));
    join.on('failed', (reason) => state.join === join && ended(failText(reason)));
    join.on('connected', (peer, cw) => state.join === join && connected(peer, cw));
    try {
      await join.start(words);
    } catch (err) {
      if (state.join === join) ended(err.message);
    }
  }

  function connected(peer, confirmWords) {
    state.peer = peer;
    state.confirm = confirmWords;
    const bridge = new HostBridge({ hive, peer, label });
    state.bridge = bridge;
    const log = requestLog({ title: T.borrowLog, empty: T.logEmpty });
    bridge.on('log', (e) => log.add({ ...e, status: e.kind }));
    bridge.on('detached', (why) => ended(T.borrowEnded(why)));
    bridge.on('attached', () => borrowing(bridge, log));
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
    const no = h('button', { class: 'lend-btn', text: T.confirmNo, on: { click: () => (bridge.stop('The confirmation words did not match'), ended(T.confirmMismatch)) } });
    set('confirm', h('section', { class: 'lend-card' }, h('h3', { text: T.confirmTitle }), h('p', { text: T.confirmHelp }), wordGrid(confirmWords, 'is-confirm'), h('div', { class: 'lend-row' }, yes, no), wait));
  }

  function borrowing(bridge, log) {
    const f = bridge.friend || {};
    const who = `${f.label || 'friend'}${f.model ? ` (${f.model})` : ''}`;
    set(
      'borrowing',
      h(
        'section',
        { class: 'lend-card lend-live' },
        h('div', { class: 'lend-live-head' }, h('span', { class: 'lend-dot is-on', attrs: { 'aria-hidden': 'true' } }), h('h3', { text: T.borrowing(who) }), h('button', { class: 'lend-btn is-danger', text: T.stopBorrowing, dataset: { act: 'stop' }, on: { click: () => bridge.stop() } })),
        h('p', { class: 'lend-muted', text: T.borrowingNote }),
      ),
      log.el,
    );
  }

  function ended(text) {
    if (state.phase === 'ended') return;
    state.join?.stop();
    state.peer = null;
    set('ended', h('section', { class: 'lend-card' }, h('p', { class: 'lend-error', text }), h('button', { class: 'lend-btn is-primary', text: T.joinAgain, on: { click: () => form() } })));
  }

  if (initial && readJoinInput(initial).ok) fill(initial);
  else form();
  return api;
}

/** A "Scan QR code" button when the browser can read QR codes from the camera, else nothing. */
function scanButton(onText) {
  const Detector = globalThis.BarcodeDetector;
  if (!Detector || !navigator.mediaDevices?.getUserMedia) return null;
  let stream = null;
  const video = h('video', { class: 'lend-video', playsInline: true, muted: true, hidden: true });
  const btn = h('button', { class: 'lend-btn', type: 'button', text: T.joinScan });
  const stop = () => {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    video.hidden = true;
    btn.textContent = T.joinScan;
  };
  btn.addEventListener('click', async () => {
    if (stream) return stop();
    try {
      const detector = new Detector({ formats: ['qr_code'] });
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      video.srcObject = stream;
      video.hidden = false;
      await video.play();
      btn.textContent = T.joinScanStop;
      const look = async () => {
        if (!stream) return;
        const codes = await detector.detect(video).catch(() => []);
        const hit = codes.find((c) => wordsFromLink(c.rawValue));
        if (hit) {
          stop();
          onText(hit.rawValue);
        } else requestAnimationFrame(look);
      };
      look();
    } catch {
      stop();
    }
  });
  return h('span', { class: 'lend-scan' }, btn, video);
}
