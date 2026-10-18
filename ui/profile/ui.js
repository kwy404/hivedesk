// The local profile in the window (docs/1.0/PROFILE.md): the avatar button in the top bar, the
// Profile page (avatar, name, bio, member since, PeerId and remote address, real statistics,
// achievements, privacy), the avatar gallery used by onboarding and Settings, and the avatar of
// peers for the City, Machines, chat and the accept dialogs. Every number comes from the engine
// (profile.get); nothing here counts anything.

import { h, clear } from '/js/dom.js';
import * as net from '/js/net.js';
import * as wm from '/js/wm.js';
import { notify } from '/js/notify.js';
import { ui } from '/js/store.js';
import { t as ti, has, locale, fmtNumber, fmtDate } from '/js/i18n.js';
import { format } from '/i18n/index.js';
import { AVATARS, avatarSvg, monogramSvg } from './avatars.js';
import { badgeSvg } from './achievements.js';

/* ---------- strings: the merged tables first, then the design part from the engine ---------- */
let part = {};
let loading = null;
export function loadProfileStrings() {
  if (loading) return loading;
  loading = fetch('/api/profile/strings', { credentials: 'same-origin', cache: 'no-store', headers: net.token ? { authorization: `Bearer ${net.token}` } : {} })
    .then((r) => (r.ok ? r.json() : {})).then((m) => { if (m && typeof m === 'object') part = m; }).catch(() => {});
  return loading;
}
export function pt(key, params) {
  if (has(key)) return ti(key, params);
  const msg = part[key];
  if (msg == null) return key;
  try { return format(locale(), msg, params); } catch { return msg; }
}

/* ---------- state ---------- */
const state = { view: null, listeners: new Set() };
const changed = () => { for (const fn of state.listeners) { try { fn(state.view); } catch (err) { console.error(err); } } };
export const profileView = () => state.view;
export const onProfile = (fn) => { state.listeners.add(fn); return () => state.listeners.delete(fn); };

net.on('hello', (f) => {
  loadProfileStrings().then(changed);
  if (f.state?.profile) { state.view = f.state.profile; changed(); }
  else net.command('profile.get', {}).then((v) => { state.view = v; changed(); }).catch(() => {});
});
net.on('live', (f) => {
  if (f.type === 'profile.changed' && f.data) { state.view = f.data; changed(); }
  if (f.type === 'profile.unlocked' && f.data?.id) {
    // a quiet unlock toast: the badge, the name, nothing else
    notify({ title: pt('profile.toast.unlocked'), body: pt(`profile.ach.${f.data.id}.title`), tone: 'ok', timeout: 4200, key: `ach-${f.data.id}` });
  }
});

/* ---------- avatars as elements ---------- */
/** The avatar of a profile ({ name, avatar }) as an element; the monogram when there is no avatar. */
export function avatarEl(profile, size = 28, cls = '') {
  const el = h('span', { class: `pf-av ${cls}`.trim(), 'aria-hidden': 'true', style: `--pf:${size}px` });
  el.innerHTML = profile?.avatar ? avatarSvg(profile.avatar, { size, name: profile.name }) : monogramSvg(profile?.name || '?', { size });
  return el;
}
/** The local user's own avatar element, kept in sync. */
export function myAvatarEl(size = 24, cls = '') {
  const el = avatarEl(state.view?.profile, size, cls);
  onProfile((v) => { el.innerHTML = v?.profile?.avatar ? avatarSvg(v.profile.avatar, { size, name: v.profile.name }) : monogramSvg(v?.profile?.name || '?', { size }); });
  return el;
}
export const myName = () => state.view?.profile?.name || pt('profile.you');

/** The avatar gallery: 28 tiles plus the monogram; `onPick(id | null)`. */
export function avatarPicker(current, onPick, { size = 40, name = '' } = {}) {
  const grid = h('div', { class: 'pf-gallery', role: 'radiogroup', 'aria-label': pt('profile.avatar') });
  const paint = (sel) => {
    for (const b of grid.children) b.setAttribute('aria-checked', String((b.dataset.id || null) === (sel || null)));
  };
  const add = (id, html, label) => grid.append(h('button', {
    type: 'button', class: 'pf-tile', role: 'radio', title: label, 'aria-label': label, dataset: id ? { id } : {}, html,
    on: { click: () => { paint(id); onPick(id); } },
  }));
  add(null, monogramSvg(name || '?', { size }), pt('profile.avatar.monogram'));
  for (const a of AVATARS) add(a.id, avatarSvg(a.id, { size }), a.id.replace('-', ' '));
  paint(current);
  return grid;
}

/* ---------- the top bar button ---------- */
function addTopButton() {
  const right = document.querySelector('.topbar .bar-right');
  if (!right) { setTimeout(addTopButton, 300); return; }
  if (right.querySelector('.pf-top')) return;
  const b = h('button', { type: 'button', class: 'ibtn pf-top', 'aria-label': pt('profile.open'), title: pt('profile.open'), dataset: { tipPos: 'bottom' }, on: { click: () => wm.open('profile') } }, myAvatarEl(22));
  onProfile(() => { b.title = `${myName()} · ${pt('profile.open')}`; b.setAttribute('aria-label', b.title); });
  right.append(b);
}

/* ---------- the Profile page ---------- */
const copyBtn = (text) => h('button', {
  type: 'button', class: 'btn btn-xs btn-quiet', text: pt('profile.copy'),
  on: { click: async (e) => { try { await navigator.clipboard.writeText(text); e.target.textContent = pt('profile.copied'); setTimeout(() => { e.target.textContent = pt('profile.copy'); }, 1500); } catch { /* the field stays selectable */ } } },
});
const groupAddress = (a) => (/^\d{10}$/.test(a || '') ? `${a.slice(0, 3)} ${a.slice(3, 6)} ${a.slice(6, 9)} ${a.slice(9)}` : a);
const date = (iso) => { try { return fmtDate(iso); } catch { return String(iso).slice(0, 10); } };

function statCard(label, value, sub) {
  return h('div', { class: 'pf-stat' }, h('span', { class: 'pf-stat-k', text: label }), h('b', { class: 'num', text: value }), sub ? h('span', { class: 'pf-stat-s', text: sub }) : null);
}

function page(body, ctx) {
  let editing = false;
  const draft = {};
  const paint = () => {
    const v = state.view;
    clear(body);
    if (!v) { body.append(h('div', { class: 'state' }, h('p', { text: '...' }))); return; }
    const p = v.profile;
    const s = v.stats;
    // header
    const head = h('section', { class: 'pf-head' }, avatarEl(p, 72),
      h('div', { class: 'pf-who' },
        h('h2', { text: p.name || pt('profile.you') }),
        p.bio ? h('p', { class: 'pf-bio', text: p.bio }) : null,
        h('div', { class: 'pf-meta' }, h('span', { text: pt('profile.memberSince', { date: date(p.createdAt) }) }), ui.demo ? h('span', { class: 'hchip hchip-info', text: 'Demo' }) : null)),
      h('button', { type: 'button', class: 'btn btn-sm btn-quiet pf-edit', text: pt('profile.edit'), on: { click: () => { editing = true; Object.assign(draft, { name: p.name, bio: p.bio, avatar: p.avatar }); paint(); } } }));
    body.append(head);
    // identity rows
    const id = h('dl', { class: 'pf-ids' });
    id.append(h('dt', { text: pt('profile.peerId') }), h('dd', {}, v.peerShort ? h('code', { class: 'mono', title: v.peerId, text: v.peerShort }) : h('span', { class: 'muted', text: pt('profile.noIdentity') }), v.peerId ? copyBtn(v.peerId) : null));
    id.append(h('dt', { text: pt('profile.address') }), h('dd', {}, v.address ? h('code', { class: 'mono', text: groupAddress(v.address) }) : h('span', { class: 'muted', text: pt('profile.noAddress') }), v.address ? copyBtn(v.address) : null));
    body.append(id);
    if (editing) body.append(editor(p));
    // statistics
    const grid = h('div', { class: 'pf-stats' },
      statCard(pt('profile.stat.projects'), fmtNumber(s.projects)), statCard(pt('profile.stat.jobs'), fmtNumber(s.jobs)), statCard(pt('profile.stat.files'), fmtNumber(s.files)),
      statCard(pt('profile.stat.crewHours'), fmtNumber(s.crewHours)), statCard(pt('profile.stat.tokens'), fmtNumber(s.tokens)), statCard(pt('profile.stat.friends'), fmtNumber(s.friends)),
      statCard(pt('profile.stat.lentGpu'), fmtNumber(s.lentGpuHours)), statCard(pt('profile.stat.lentCpu'), fmtNumber(s.lentCpuHours)), statCard(pt('profile.stat.borrowed'), fmtNumber(s.borrowedHours)),
      statCard(pt('profile.stat.remote'), fmtNumber(s.remoteSessions)), statCard(pt('profile.stat.playbooks'), fmtNumber(s.playbooksUsed)),
      statCard(pt('profile.stat.streak'), fmtNumber(s.streak), `${pt('profile.stat.best', { n: s.bestStreak })} · ${pt('profile.stat.activeDays', { n: s.activeDays })}`));
    const max = Math.max(1, ...Object.values(s.tasksByDomain));
    const domains = h('div', { class: 'pf-domains' }, ...Object.entries(s.tasksByDomain).map(([k, n]) => h('div', { class: 'pf-dom' },
      h('span', { text: pt(`profile.domain.${k}`) }), h('span', { class: 'pf-dom-bar' }, h('i', { style: `width:${Math.round((n / max) * 100)}%` })), h('b', { class: 'num', text: fmtNumber(n) }))));
    const models = h('div', { class: 'pf-models' }, h('span', { class: 'pf-stat-k', text: pt('profile.stat.models') }),
      ...(s.models.length ? s.models.map((m) => h('span', { class: 'hchip hchip-mono', text: m })) : [h('span', { class: 'muted small', text: pt('profile.models.none') })]));
    body.append(h('section', { class: 'pf-sec' }, h('h3', { text: pt('profile.stats') }), h('p', { class: 'pf-sub', text: pt('profile.stats.sub') }), grid,
      h('h4', { class: 'pf-k', text: pt('profile.domains') }), domains, models));
    // achievements
    const got = v.achievements.filter((a) => a.unlockedAt).length;
    const list = h('div', { class: 'pf-achs' });
    const sorted = [...v.achievements].sort((a, b) => (!!b.unlockedAt - !!a.unlockedAt) || String(b.unlockedAt || '').localeCompare(String(a.unlockedAt || '')));
    for (const a of sorted) {
      list.append(h('div', { class: 'pf-ach', dataset: { on: String(!!a.unlockedAt) } }, h('span', { class: 'pf-badge', html: badgeSvg(a.id, !!a.unlockedAt, 44) }),
        h('div', {}, h('b', { text: pt(`profile.ach.${a.id}.title`) }),
          h('span', { text: a.unlockedAt ? pt('profile.ach.unlocked', { date: date(a.unlockedAt) }) : pt(`profile.ach.${a.id}.how`) }))));
    }
    body.append(h('section', { class: 'pf-sec' }, h('div', { class: 'row' }, h('h3', { class: 'grow', text: pt('profile.ach') }), h('span', { class: 'hchip num', text: pt('profile.ach.count', { n: got, total: v.achievements.length }) })), list));
    // privacy
    const share = h('input', { type: 'checkbox', checked: !!p.shareAchievements, on: { change: (e) => net.command('profile.set', { shareAchievements: e.target.checked }).catch(() => {}) } });
    const check = h('button', { type: 'button', class: 'btn btn-xs btn-quiet', text: pt('profile.check'), on: { click: async (e) => {
      e.target.disabled = true; e.target.textContent = pt('profile.check.running');
      try {
        const r = await net.command('profile.check', {}, { timeout: 60000 });
        notify({ title: r.ok ? pt('profile.check.ok') : pt('profile.check.fail', { list: (r.failed || []).join(', ') }), tone: r.ok ? 'ok' : 'warn', timeout: 5000 });
      } catch { /* the engine said why */ }
      e.target.disabled = false; e.target.textContent = pt('profile.check');
    } } });
    body.append(h('section', { class: 'pf-sec' }, h('h3', { text: pt('profile.privacy') }), h('p', { class: 'pf-sub', text: pt('profile.privacy.text') }),
      h('label', { class: 'row pf-switch' }, share, h('span', { text: pt('profile.privacy.share') })), h('div', { class: 'row' }, check)));
  };
  const editor = (p) => {
    const name = h('input', { class: 'field-in', type: 'text', maxLength: 32, value: draft.name || '', placeholder: pt('profile.namePlaceholder'), on: { input: (e) => { draft.name = e.target.value; } } });
    const bio = h('textarea', { class: 'field-ta', maxLength: 160, rows: 2, placeholder: pt('profile.bioPlaceholder'), on: { input: (e) => { draft.bio = e.target.value; } } });
    bio.value = draft.bio || '';
    return h('section', { class: 'pf-sec pf-editor' },
      h('label', { class: 'lbl', text: pt('profile.name') }), name, h('div', { class: 'help', text: pt('profile.nameHelp') }),
      h('label', { class: 'lbl', text: pt('profile.bio') }), bio,
      h('label', { class: 'lbl', text: pt('profile.avatar') }), avatarPicker(draft.avatar || null, (id) => { draft.avatar = id; }, { name: draft.name || p.name }),
      h('div', { class: 'row pf-acts' },
        h('button', { type: 'button', class: 'btn btn-sm btn-quiet', text: pt('profile.cancel'), on: { click: () => { editing = false; paint(); } } }),
        h('button', { type: 'button', class: 'btn btn-sm btn-primary', text: pt('profile.save'), on: { click: async () => {
          try { state.view = await net.command('profile.set', { name: draft.name, bio: draft.bio, avatar: draft.avatar || null }); editing = false; changed(); } catch (err) { notify({ title: err.message, tone: 'bad' }); }
        } } })));
  };
  paint();
  const off = onProfile(() => { if (!editing) paint(); });
  ctx.onDispose(off);
  if (!state.view) net.command('profile.get', {}).then((v) => { state.view = v; changed(); }).catch(() => {});
}

wm.register('profile', {
  title: () => pt('profile.title'),
  glyph: () => myAvatarEl(18),
  size: [640, 720],
  min: [360, 400],
  cardH: 760,
  create(ctx) {
    linkCss();
    const body = h('div', { class: 'pane pf' });
    ctx.body.append(body);
    page(body, ctx);
  },
});

function linkCss() {
  if (document.querySelector('link[data-profile]')) return;
  document.head.append(h('link', { rel: 'stylesheet', href: '/profile/profile.css', 'data-profile': '' }));
}
linkCss();
addTopButton();

// Command palette entry (ui/js/palette.js reads globalThis.hivedeskPalette).
(globalThis.hivedeskPalette = globalThis.hivedeskPalette || []).push(() => [{ group: pt('profile.title'), label: pt('profile.open'), run: () => wm.open('profile'), icon: 'hire' }]);
