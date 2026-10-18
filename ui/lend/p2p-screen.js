// The 1.0 Lend screen and Join window, on the engine's control plane (src/p2p/, src/lend/share.js):
//   lender:   the form (GPU, CPU, RAM, storage, each with its limit) -> lend.offer -> six words
//             -> the window meets the friend on the relays (PipeOffer) -> the engine's join
//             request -> the SAS words with "Do these words match on their screen?" -> lend.accept
//             -> Lending now, with Revoke per person and Stop lending (real revokes)
//   borrower: six words -> p2p.join -> PipeJoin -> the SAS words to read out -> accepted or not
// The window never holds a key; it renders what the engine reports and asks.

import { PipeJoin, PipeOffer } from './core/p2p-pipe.js';
import { BORROW_REQUEST, DEFAULT_FORM, MINUTE_CHOICES, canLend, capLine, confirmModel, joinModel, lendingModel, readForm } from './p2p-model.js';
import { lineText, loadI18n, tx } from './p2p-text.js';
import { clear, copyText, h, wordGrid } from './view.js';

const field = (label, input) => h('label', { class: 'lend-field' }, h('span', { text: label }), input);
const check = (on) => h('input', { type: 'checkbox', checked: on });
const num = (value, min, max, step = 1) => h('input', { type: 'number', class: 'lend-num', value: String(value), attrs: { min: String(min), max: String(max), step: String(step) } });
const btn = (cls, text, onClick, extra = {}) => h('button', { class: cls, text, on: { click: onClick }, ...extra });

/** The lender's screen. hive: a connected HiveSocket. */
export async function mountP2PLend(root, { hive, options = {} } = {}) {
  await loadI18n();
  root.classList.add('lend-screen', 'is-p2p');
  // offer: the invite waiting on the relays; links: offers whose data channel carries a session
  // (they stay open after the words are used, until the session ends or the screen goes away).
  const state = { phase: 'form', form: readForm(DEFAULT_FORM), offer: null, links: [], invite: null, request: null };
  const dropOffer = () => {
    const o = state.offer;
    state.offer = null;
    if (!o) return;
    if (o.bridge) {
      o.creator.stop();
      state.links.push(o);
      o.on('closed', () => (state.links = state.links.filter((x) => x !== o)));
    } else o.stop();
  };
  const offs = [];
  const head = () => h('header', { class: 'lend-head' }, h('img', { src: '/assets/mascot.svg', alt: '', class: 'lend-mascot', width: 56, height: 56 }), h('div', null, h('h1', { text: tx('lend.title') }), h('p', { class: 'lend-lead', text: tx('lend.p2p.formHelp') })));
  const set = (phase, ...nodes) => {
    state.phase = phase;
    root.dataset.phase = phase;
    clear(root).append(head(), ...nodes, lendingCard());
  };

  // ---- Lending now (always under the current phase) ----
  const lendingBox = h('section', { class: 'lend-card lend-now' });
  function lendingCard() {
    return lendingBox;
  }
  async function refreshLending() {
    let lending = [];
    try {
      lending = (await hive.command('lend.grants')).lending;
    } catch { /* the engine went away */ }
    const rows = lendingModel(lending);
    clear(lendingBox).append(h('h2', { text: tx('lend.p2p.lendingTitle') }));
    if (!rows.length) lendingBox.append(h('p', { class: 'lend-muted', text: tx('lend.p2p.nobody') }));
    for (const r of rows) {
      lendingBox.append(h('div', { class: 'lend-peer', dataset: { peer: r.peerId } },
        h('div', { class: 'lend-live-head' },
          h('span', { class: `lend-dot ${r.online ? 'is-on' : ''}`, attrs: { 'aria-hidden': 'true' } }),
          h('b', { text: r.name }),
          h('span', { class: 'lend-muted', text: tx(r.online ? 'lend.p2p.online' : 'lend.p2p.offline') }),
          btn('lend-btn is-danger', tx('lend.p2p.revoke'), () => hive.command('lend.revoke', { peerId: r.peerId }).then(refreshLending), { dataset: { act: 'revoke' } })),
        h('p', { class: 'lend-muted', text: tx('lend.p2p.theirFingerprint', { words: r.fingerprint.join(' ') }) }),
        h('ul', { class: 'lend-caps' }, r.lines.map((l) => h('li', { text: `${lineText(l)}${l.left !== null ? ` (${tx('lend.p2p.left', { n: l.left })})` : ''}` })))));
    }
    if (rows.length) lendingBox.append(btn('lend-btn is-danger', tx('lend.p2p.stopAll'), () => hive.command('lend.stop', {}).then(refreshLending), { dataset: { act: 'stop' } }));
  }
  offs.push(hive.on('live:p2p.peers', () => refreshLending()));

  // ---- 1. the form ----
  function showForm(message) {
    dropOffer();
    const f = state.form;
    const gpuOn = check(f.gpu.on);
    const vram = num(f.gpu.maxVramGB, 0.5, 1024, 0.5);
    const cpuOn = check(f.cpu.on);
    const threads = num(f.cpu.threads, 1, 256);
    const load = num(f.cpu.maxLoadPct, 1, 100);
    const ramOn = check(f.ram.on);
    const ram = num(f.ram.maxGB, 0.5, 4096, 0.5);
    const stOn = check(f.storage.on);
    const st = num(f.storage.maxGB, 0, 16384);
    const dl = check(f.storage.modelDownload);
    const minutes = h('select', { class: 'lend-select' }, MINUTE_CHOICES.map((m) => h('option', { value: String(m), text: tx('lend.p2p.minutesN', { n: m }), selected: m === f.minutes })));
    const note = h('p', { class: 'lend-error', text: message || '' });
    const read = () => readForm({
      gpu: { on: gpuOn.checked, maxVramGB: vram.value },
      cpu: { on: cpuOn.checked, threads: threads.value, maxLoadPct: load.value },
      ram: { on: ramOn.checked, maxGB: ram.value },
      storage: { on: stOn.checked, maxGB: st.value, modelDownload: dl.checked },
      minutes: minutes.value,
    });
    const go = btn('lend-btn is-primary', tx('lend.p2p.makeWords'), () => {
      state.form = read();
      if (!canLend(state.form)) {
        note.textContent = tx('lend.p2p.nothing');
        return;
      }
      offer();
    }, { dataset: { act: 'offer' } });
    set('form', h('section', { class: 'lend-card lend-form' },
      h('h2', { text: tx('lend.p2p.formTitle') }),
      h('fieldset', { class: 'lend-part' }, h('legend', null, h('label', null, gpuOn, h('span', { text: tx('lend.p2p.gpu') }))), field(tx('lend.p2p.gpuVram'), vram)),
      h('fieldset', { class: 'lend-part' }, h('legend', null, h('label', null, cpuOn, h('span', { text: tx('lend.p2p.cpu') }))), field(tx('lend.p2p.cpuThreads'), threads), field(tx('lend.p2p.cpuLoad'), load)),
      h('fieldset', { class: 'lend-part' }, h('legend', null, h('label', null, ramOn, h('span', { text: tx('lend.p2p.ram') }))), field(tx('lend.p2p.ramGB'), ram)),
      h('fieldset', { class: 'lend-part' }, h('legend', null, h('label', null, stOn, h('span', { text: tx('lend.p2p.storage') }))), field(tx('lend.p2p.storageGB'), st), h('label', { class: 'lend-field' }, dl, h('span', { text: tx('lend.p2p.modelDownload') }))),
      field(tx('lend.p2p.minutes'), minutes),
      note,
      h('div', { class: 'lend-row' }, go)));
  }

  // ---- 2. the words ----
  async function offer() {
    let inv;
    try {
      inv = await hive.command('lend.offer', { form: state.form });
    } catch (err) {
      return showForm(err.message);
    }
    state.invite = inv;
    const relays = h('p', { class: 'lend-status', text: '' });
    const expires = h('p', { class: 'lend-muted' });
    const copyBtn = btn('lend-btn', tx('lend.copyWords'), () => copyText(inv.words.join(' '), copyBtn));
    set('share', h('section', { class: 'lend-card lend-share' },
      h('div', { class: 'lend-share-words' },
        wordGrid(inv.words, 'is-big'),
        h('div', { class: 'lend-row' }, copyBtn, btn('lend-btn', tx('lend.newWords'), () => showForm())),
        h('p', { class: 'lend-muted', text: tx('lend.p2p.offering') }),
        h('ul', { class: 'lend-caps' }, inv.offeredCaps.map((c) => h('li', { text: lineText(capLine(c)) }))),
        expires, relays,
        h('p', { class: 'lend-muted', text: tx('lend.p2p.windowOpen') }))));
    const tick = () => {
      const s = Math.max(0, Math.round((Date.parse(inv.expiresAt) - Date.now()) / 1000));
      expires.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    };
    tick();
    const timer = setInterval(tick, 1000);
    offs.push(() => clearInterval(timer));
    const po = new PipeOffer({ hive, rendezvous: inv.rendezvous, options });
    state.offer = po;
    po.on('status', (s) => (relays.textContent = `${s.connected?.length ?? 0} / ${s.total ?? 0}`));
    po.on('failed', (reason) => state.offer === po && state.phase === 'share' && showForm(String(reason)));
    po.on('expired', () => state.offer === po && state.phase === 'share' && showForm());
    po.start().catch((err) => showForm(err.message));
  }

  // ---- 3. the join request: SAS words, then the person decides ----
  offs.push(hive.on('live:p2p.join.request', (req) => {
    state.request = req;
    const m = confirmModel(req, state.invite?.offeredCaps || []);
    const answer = (sasMatches) => async () => {
      try {
        if (sasMatches) await hive.command('lend.accept', { requestId: m.requestId, form: state.form, sasMatches: true });
        else await hive.command('p2p.join.answer', { requestId: m.requestId, accept: false, sasMatches: false });
      } catch (err) {
        return showForm(err.message);
      }
      if (!sasMatches) {
        state.offer?.stop();
        state.offer = null;
      }
      if (sasMatches) showForm();
      else set('mismatch', h('section', { class: 'lend-card' }, h('p', { class: 'lend-error', text: tx('lend.p2p.mismatch') }), btn('lend-btn is-primary', tx('lend.p2p.makeWords'), () => showForm())));
      refreshLending();
    };
    set('confirm', h('section', { class: 'lend-card lend-confirm' },
      h('h2', { text: tx(m.knownBefore ? 'lend.p2p.requestKnown' : 'lend.p2p.request', { name: m.name }) }),
      h('p', { class: 'lend-muted', text: tx('lend.p2p.theirFingerprint', { words: m.fingerprint.join(' ') }) }),
      h('p', { class: 'lend-sas-q', text: tx('lend.p2p.sasQuestion') }),
      wordGrid(m.sas, 'is-big is-confirm'),
      h('p', { class: 'lend-muted', text: tx('lend.p2p.sasHelp') }),
      h('ul', { class: 'lend-caps' }, m.lines.map((l) => h('li', { text: lineText(l) }))),
      m.expiresIn !== null ? h('p', { class: 'lend-muted', text: tx('lend.p2p.decideIn', { n: m.expiresIn }) }) : '',
      h('div', { class: 'lend-row' }, btn('lend-btn is-primary', tx('lend.p2p.match'), answer(true), { dataset: { act: 'match' } }), btn('lend-btn', tx('lend.p2p.noMatch'), answer(false), { dataset: { act: 'nomatch' } }))));
  }));
  offs.push(hive.on('live:p2p.invite.burned', () => state.phase === 'share' && set('burned', h('section', { class: 'lend-card' }, h('p', { class: 'lend-error', text: tx('lend.p2p.burned') }), btn('lend-btn is-primary', tx('lend.p2p.makeWords'), () => showForm())))));

  showForm();
  refreshLending();
  const api = {
    state,
    root,
    unmount() {
      for (const off of offs) off?.();
      state.offer?.stop();
      for (const o of state.links) o.stop();
    },
  };
  return api;
}

/** The borrower's side of a join with six words (the words come from the Join window). */
export async function runP2PJoin(root, { hive, words, options = {} }) {
  await loadI18n();
  const box = h('section', { class: 'lend-card lend-p2p-join' });
  clear(root).append(box);
  const status = h('p', { class: 'lend-status', text: tx('lend.p2p.join.meeting') });
  box.append(status);
  let join;
  try {
    join = await hive.command('p2p.join', { words, requestedCaps: BORROW_REQUEST });
  } catch (err) {
    status.textContent = tx('lend.p2p.join.failed.words');
    status.className = 'lend-error';
    return { failed: err.message, stop: () => {} };
  }
  const pj = new PipeJoin({ hive, rendezvous: join.rendezvous, joinId: join.joinId, options });
  const render = (u) => {
    const m = joinModel(u);
    clear(box);
    if (m.phase === 'handshake') box.append(h('p', { class: 'lend-status', text: tx('lend.p2p.join.handshake') }));
    if (m.sas) {
      box.append(h('p', { text: tx('lend.p2p.join.sas') }), wordGrid(m.sas, 'is-big is-confirm'), h('p', { class: 'lend-muted', text: tx('lend.p2p.join.hostFingerprint', { words: (m.hostFingerprint || []).join(' ') }) }));
      if (m.phase === 'sas') box.append(h('p', { class: 'lend-muted', text: tx('lend.p2p.join.waiting') }));
    }
    if (m.phase === 'accepted') box.append(h('p', { class: 'lend-ok', text: tx('lend.p2p.join.accepted') }), h('ul', { class: 'lend-caps' }, m.lines.map((l) => h('li', { text: lineText(l) }))));
    if (m.phase === 'refused') box.append(h('p', { class: 'lend-error', text: tx(m.reason === 'sas_mismatch' ? 'lend.p2p.join.refusedMismatch' : 'lend.p2p.join.refused') }));
    if (m.phase === 'failed') box.append(h('p', { class: 'lend-error', text: tx(m.reasonKey) }));
    root.dataset.phase = m.phase;
    if (m.phase === 'failed' || m.phase === 'refused') pj.stop();
  };
  const off = hive.on('live:p2p.join.update', (u) => u.joinId === join.joinId && render(u));
  pj.on('failed', () => render({ phase: 'failed', reason: 'timeout' }));
  pj.on('timeout', () => render({ phase: 'failed', reason: 'timeout' }));
  await pj.start();
  return { joinId: join.joinId, stop: () => { off(); pj.stop(); } };
}
