// The Code together window: share this session (host) or join someone's (guest).

import { collab, COLORS } from './client.js';
import { WORD_COUNT, resolvePhrase, resolveWord } from '../core/words.js';
import { spread, looksLikePaste } from '../core/paste.js';
import { lendLink, LINK_BASE } from '../core/link.js';
import { clear, copyText, h, qrNode, wordGrid } from '../view.js';

export const T = {
  title: 'Code together',
  lead: 'Friends join this session with six words. They see the crew, the chat, the files and the preview live, and can edit files with you. Nothing runs on their PC and they never get a shell.',
  name: 'Your name',
  color: 'Your color',
  share: 'Share this session',
  invite: 'Invite someone',
  stopShare: 'Stop sharing',
  people: 'People in this session',
  viewer: 'Viewer: sees everything, can chat',
  collaborator: 'Collaborator: can also ask the crew, approve steps and edit files',
  remove: 'Remove',
  you: 'you',
  host: 'host',
  waiting: 'Waiting for someone to enter these words...',
  inviteHelp: 'Your friend opens hivedesk, chooses Code together and enters these words, pastes the link or scans the QR code.',
  confirmHelp: 'Read these words to each other. They must match, in the same order.',
  match: 'They match',
  noMatch: 'They do not match',
  joinTitle: "Join someone's session",
  join: 'Join',
  joinHelp: 'Enter the six words from the host. A whole phrase or link pasted into one box fills every box.',
  knocking: "Looking for the host's session...",
  waitWelcome: 'Waiting for the host to check the words too...',
  joined: (who, role) => `You are in ${who}'s session as ${role === 'collaborator' ? 'a collaborator' : 'a viewer'}.`,
  viewerNote: 'As a viewer you can watch and chat. The host can make you a collaborator.',
  leave: 'Leave the session',
  lendBrain: 'Also lend my model to the host',
  lendingBrain: 'Your model takes turns for the host crew. Only prompts and answers travel.',
  stopLend: 'Stop lending my model',
  lentBrain: 'lends a model',
  ended: (why) => `The session ended: ${why}`,
  expired: 'These words expired.',
  failed: 'The connection failed. Try new words.',
  mismatch: 'The words did not match, so that connection was closed.',
};

/** The words in a Code together link (#cw=...), a lend link (#w=...) or typed text. */
export function collabLink(words) {
  return `${LINK_BASE}#cw=${words.join('-')}`;
}
const normalizeLink = (text) => String(text ?? '').replace(/([#&?])cw=/, '$1w=');

function profileFields(onChange) {
  const name = h('input', { class: 'lend-link', value: collab.profile.name, maxLength: 40, placeholder: T.name, attrs: { 'aria-label': T.name }, id: 'collab-name' });
  const swatches = h('div', { class: 'collab-swatches', role: 'radiogroup', attrs: { 'aria-label': T.color } });
  let color = collab.profile.color;
  const paint = () => {
    for (const b of swatches.children) b.setAttribute('aria-checked', String(b.dataset.color === color));
  };
  for (const c of COLORS) {
    swatches.append(h('button', { type: 'button', class: 'collab-swatch', role: 'radio', style: { background: c }, dataset: { color: c }, attrs: { 'aria-label': c }, on: { click: () => { color = c; paint(); onChange?.(); } } }));
  }
  paint();
  name.addEventListener('input', () => onChange?.());
  return { el: h('div', { class: 'collab-profile' }, h('label', { class: 'collab-field' }, h('span', { text: T.name }), name), h('div', { class: 'collab-field' }, h('span', { text: T.color }), swatches)), get: () => ({ name: name.value, color }) };
}

export function avatar(p, size = 26) {
  const letters = String(p.name || '?').trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase() || '?';
  return h('span', { class: 'collab-av', style: { background: p.color, width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.42)}px` }, text: letters, title: p.name, dataset: { id: p.id } });
}

function wordBoxes(onReady) {
  const inputs = Array.from({ length: WORD_COUNT }, (_, i) => h('input', { id: `collab-w${i}`, class: 'lend-box', autocomplete: 'off', autocapitalize: 'none', spellcheck: false, attrs: { 'aria-label': `Word ${i + 1}` } }));
  const paint = () => inputs.forEach((x) => x.parentElement?.classList.toggle('is-ok', !!resolveWord(x.value)));
  const fill = (i, text) => {
    const r = spread(inputs.map((x) => x.value), i, normalizeLink(text));
    if (!r) return false;
    r.values.forEach((v, k) => (inputs[k].value = v));
    paint();
    inputs[r.focus].focus();
    if (resolvePhrase(r.values).ok) onReady(resolvePhrase(r.values).words);
    return true;
  };
  inputs.forEach((input, i) => {
    input.addEventListener('paste', (e) => {
      if (fill(i, e.clipboardData?.getData('text') ?? '')) e.preventDefault();
    });
    input.addEventListener('input', () => {
      if (looksLikePaste(input.value) && fill(i, input.value)) return;
      paint();
      const r = resolveWord(input.value);
      if (r?.how === 'exact' && input.value.length >= 4 && i < WORD_COUNT - 1) inputs[i + 1].focus();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !input.value && i > 0) inputs[i - 1].focus();
    });
  });
  const el = h('div', { class: 'lend-boxes' }, inputs.map((x, i) => h('label', { class: 'lend-cell' }, h('span', { class: 'lend-n', text: String(i + 1) }), x)));
  return { el, words: () => resolvePhrase(inputs.map((x) => x.value)), fill };
}

export function mountCollab(root, { initial = '' } = {}) {
  root.classList.add('collab-panel', 'lend-join');
  const offs = [];
  const on = (type, fn) => offs.push(collab.on(type, fn));
  let guestState = { phase: 'form', confirm: null, peer: null, error: '' };

  const render = () => {
    root.dataset.mode = collab.mode;
    clear(root).append(h('header', { class: 'lend-head is-small' }, h('div', null, h('h2', { text: T.title }), h('p', { class: 'lend-lead', text: T.lead }))));
    if (collab.mode === 'host') root.append(hostView());
    else if (collab.mode === 'guest') root.append(guestJoined());
    else root.append(soloView());
  };

  function soloView() {
    const prof = profileFields();
    const shareBtn = h('button', { class: 'lend-btn is-primary', type: 'button', text: T.share, dataset: { act: 'share' }, on: { click: async () => { collab.setProfile(prof.get()); collab.startHosting(); await collab.invite().catch((err) => alertIn(err.message)); } } });
    const boxes = wordBoxes((words) => joinWith(words));
    const err = h('p', { class: 'lend-error', text: guestState.error, hidden: !guestState.error });
    const alertIn = (m) => { err.textContent = m; err.hidden = false; };
    const joinWith = async (words) => {
      collab.setProfile(prof.get());
      guestState = { phase: 'knocking', words };
      renderGuestProgress();
      try {
        const { confirm, peer } = await collab.join(words);
        guestState = { phase: 'confirm', confirm, peer };
        renderGuestProgress();
      } catch (e) {
        guestState = { phase: 'form', error: e.message };
        render();
      }
    };
    const joinBtn = h('button', { class: 'lend-btn', type: 'button', text: T.join, dataset: { act: 'join' }, on: { click: () => { const r = boxes.words(); if (r.ok) joinWith(r.words); else alertIn(T.joinHelp); } } });
    if (initial) setTimeout(() => boxes.fill(0, initial), 0);
    return h('div', { class: 'collab-cols' },
      h('section', { class: 'lend-card' }, prof.el),
      h('section', { class: 'lend-card' }, h('h3', { text: T.share }), h('p', { class: 'lend-muted', text: T.inviteHelp }), h('div', { class: 'lend-row' }, shareBtn)),
      h('section', { class: 'lend-card' }, h('h3', { text: T.joinTitle }), h('p', { class: 'lend-muted', text: T.joinHelp }), boxes.el, h('div', { class: 'lend-row' }, joinBtn), err));
  }

  function renderGuestProgress() {
    const box = h('section', { class: 'lend-card', dataset: { phase: guestState.phase } });
    if (guestState.phase === 'knocking') box.append(wordGrid(guestState.words), h('p', { class: 'lend-status', text: T.knocking }));
    if (guestState.phase === 'confirm') {
      const wait = h('p', { class: 'lend-muted', text: T.waitWelcome, hidden: true });
      const yes = h('button', { class: 'lend-btn is-primary', type: 'button', text: T.match, dataset: { act: 'confirm' }, on: { click: () => { collab.confirmHost(guestState.peer, true); yes.disabled = true; wait.hidden = false; } } });
      const no = h('button', { class: 'lend-btn', type: 'button', text: T.noMatch, on: { click: () => { collab.confirmHost(guestState.peer, false); guestState = { phase: 'form', error: T.mismatch }; render(); } } });
      box.append(h('h3', { text: 'Check the confirmation words' }), h('p', { text: T.confirmHelp }), wordGrid(guestState.confirm, 'is-confirm'), h('div', { class: 'lend-row' }, yes, no), wait);
    }
    clear(root).append(h('header', { class: 'lend-head is-small' }, h('div', null, h('h2', { text: T.joinTitle }))), box);
    root.dataset.phase = guestState.phase;
  }

  function peopleList(editable) {
    const lent = collab.mode === 'host' ? collab.lentBrains() : new Map();
    const me = collab.myId();
    const list = h('ul', { class: 'collab-people', attrs: { 'aria-label': T.people } });
    for (const p of collab.people()) {
      const role = p.role === 'host' ? h('span', { class: 'lend-pill', text: T.host })
        : editable ? h('select', { class: 'collab-role', dataset: { guest: p.id }, attrs: { 'aria-label': `${p.name} role` }, on: { change: (e) => collab.host.setRole(p.id, e.target.value) } },
          h('option', { value: 'viewer', text: 'Viewer', selected: p.role === 'viewer' }), h('option', { value: 'collaborator', text: 'Collaborator', selected: p.role === 'collaborator' }))
          : h('span', { class: 'lend-pill', text: p.role });
      list.append(h('li', { dataset: { id: p.id } }, avatar(p), h('div', { class: 'collab-who' }, h('b', { text: `${p.name}${p.id === me ? ` (${T.you})` : ''}` }), h('small', { text: [p.file, lent.has(p.id) ? T.lentBrain : ''].filter(Boolean).join(' · ') })), role,
        editable && p.role !== 'host' ? h('button', { class: 'lend-btn', type: 'button', text: T.remove, on: { click: () => collab.host.remove(p.id) } }) : null));
    }
    return list;
  }

  function inviteCard(entry) {
    const card = h('section', { class: 'lend-card collab-invite', dataset: { state: entry.state } });
    if (entry.state === 'waiting' && entry.words) {
      const link = collabLink(entry.words);
      const copyBtn = h('button', { class: 'lend-btn', type: 'button', text: 'Copy link', on: { click: () => copyText(link, copyBtn) } });
      card.append(h('div', { class: 'lend-share' }, h('div', { class: 'lend-share-words' }, wordGrid(entry.words, 'is-big collab-invite-words'), h('p', { class: 'lend-muted', text: T.inviteHelp }), h('div', { class: 'lend-row' }, copyBtn), h('input', { class: 'lend-link', value: link, readOnly: true }), h('p', { class: 'lend-status', text: T.waiting })), qrNode(link, T.title)));
    } else if (entry.state === 'confirm') {
      card.append(h('h3', { text: 'Check the confirmation words' }), h('p', { text: T.confirmHelp }), wordGrid(entry.confirm, 'is-confirm'),
        h('div', { class: 'lend-row' }, h('button', { class: 'lend-btn is-primary', type: 'button', text: T.match, dataset: { act: 'confirm-guest' }, on: { click: () => collab.confirmGuest(entry, true) } }), h('button', { class: 'lend-btn', type: 'button', text: T.noMatch, on: { click: () => collab.confirmGuest(entry, false) } })));
    } else if (entry.state === 'expired' || entry.state === 'failed' || entry.state === 'mismatch') {
      card.append(h('p', { class: 'lend-error', text: entry.state === 'expired' ? T.expired : entry.state === 'mismatch' ? T.mismatch : T.failed }));
    } else return null;
    return card;
  }

  function hostView() {
    const wrap = h('div', { class: 'collab-cols' });
    const invites = collab.pending.map(inviteCard).filter(Boolean);
    wrap.append(
      h('section', { class: 'lend-card' }, h('div', { class: 'lend-live-head' }, h('span', { class: 'lend-dot is-on' }), h('h3', { text: T.people }), h('button', { class: 'lend-btn is-danger', type: 'button', text: T.stopShare, on: { click: () => collab.stopHosting('The host stopped sharing') } })),
        peopleList(true), h('div', { class: 'lend-row' }, h('button', { class: 'lend-btn is-primary', type: 'button', text: T.invite, dataset: { act: 'invite' }, on: { click: () => collab.invite().catch(() => {}) } }))),
      ...invites,
    );
    return wrap;
  }

  function guestJoined() {
    const host = collab.people().find((p) => p.role === 'host');
    const role = collab.role();
    const lendBtn = collab.lender
      ? h('button', { class: 'lend-btn', type: 'button', text: T.stopLend, on: { click: () => collab.stopLendingMyBrain() } })
      : h('button', { class: 'lend-btn', type: 'button', text: T.lendBrain, on: { click: () => collab.lendMyBrain().catch((e) => console.warn(e)) } });
    return h('div', { class: 'collab-cols' },
      h('section', { class: 'lend-card', dataset: { joined: '1', role } }, h('div', { class: 'lend-live-head' }, h('span', { class: 'lend-dot is-on' }), h('h3', { text: T.joined(host?.name || 'the host', role) }), h('button', { class: 'lend-btn is-danger', type: 'button', text: T.leave, dataset: { act: 'leave' }, on: { click: () => collab.leave() } })),
        role === 'viewer' ? h('p', { class: 'lend-muted', text: T.viewerNote }) : null, peopleList(false)),
      h('section', { class: 'lend-card' }, h('p', { class: 'lend-muted', text: collab.lender ? T.lendingBrain : 'Your model can help the host crew too. Only prompts and answers travel; your files are never touched.' }), h('div', { class: 'lend-row' }, lendBtn)));
  }

  on('change', render);
  on('people', () => collab.mode !== 'solo' && render());
  on('role', render);
  on('invites', () => collab.mode === 'host' && render());
  on('lending', render);
  on('ended', (why) => { guestState = { phase: 'form', error: T.ended(why) }; render(); });
  render();
  return { root, dispose: () => offs.forEach((off) => off()) };
}
