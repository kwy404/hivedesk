// Library: the expert playbooks the crew picks per task (src/crew/library/). Search them, read one,
// mark favorites and add your own (saved in ~/.hivedesk/library/). Commands: library.list, library.get,
// library.favorite, library.add, library.remove.

import { h, icon, clear, debounce } from '../dom.js';
import { register, open } from '../wm.js';
import { ui } from '../store.js';
import { command } from '../net.js';
import { notify } from '../notify.js';
import { track, stateBox, btn } from './util.js';
import { tr, CATEGORY_KEYS } from './library-strings.js';

const V = window.V;
/** What the window shows: the list, one entry, or the form for a new one. */
const nav = V.reactive({ view: 'list', id: null, v: 0 });
const ROLES = ['mel', 'architect', 'dev', 'designer', 'qa', 'reviewer', 'writer', 'ops'];

/** Opens the Library window on one entry. */
export function openEntry(id) {
  nav.view = 'entry';
  nav.id = id;
  nav.v++;
  open('library');
}

async function send(type, data, fail) {
  try { return await command(type, data); } catch (err) { notify({ title: fail, body: err.message, tone: 'bad', sound: 'error' }); return null; }
}

const chip = (text, cls = '') => h('span', { class: `hchip ${cls}`, text });

function star(e, after) {
  const b = btn(e.favorite ? tr('library.unfavorite') : tr('library.favorite'), async (ev) => {
    ev.stopPropagation();
    if (await send('library.favorite', { id: e.id, on: !e.favorite }, tr('library.error.save'))) { e.favorite = !e.favorite; after(); }
  }, `btn btn-xs btn-quiet lib-star${e.favorite ? ' on' : ''}`, 'star');
  b.setAttribute('aria-pressed', String(!!e.favorite));
  if (ui.replay) b.disabled = true;
  return b;
}

function row(e, after) {
  const r = h('li', { class: 'lib-row', tabindex: '0', role: 'button', 'aria-label': e.title, on: { click: () => openEntry(e.id), keydown: (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openEntry(e.id); } } } },
    h('div', { class: 'row' },
      h('div', { class: 'grow' }, h('div', { class: 'lib-t', text: e.title }), h('div', { class: 'tiny muted ellipsis', text: e.when })),
      star(e, after)),
    h('div', { class: 'row lib-meta' }, chip(e.category, 'hchip-honey'), e.source === 'user' ? chip(tr('library.yours')) : null,
      ...e.tags.slice(0, 4).map((t) => chip(t)), h('span', { class: 'tiny faint', text: tr('library.tokens', { count: e.size }) })));
  return r;
}

function entryView(e, after) {
  const section = (title, body) => (body ? [h('h4', { text: title }), body] : []);
  const remove = e.source === 'user' ? btn(tr('library.remove'), async () => { if (await send('library.remove', { id: e.id }, tr('library.error.save'))) { nav.view = 'list'; nav.v++; } }, 'btn btn-xs btn-bad', 'x') : null;
  return h('article', { class: 'lib-entry' },
    h('div', { class: 'row' }, btn(tr('library.back'), () => { nav.view = 'list'; nav.v++; }, 'btn btn-xs btn-quiet'), h('h3', { class: 'grow', text: e.title }), star(e, after), remove),
    h('div', { class: 'row lib-meta' }, chip(e.category, 'hchip-honey'), chip(e.id), h('span', { class: 'tiny faint', text: `${tr('library.tokens', { count: e.size })}, v${e.version}` })),
    ...section(tr('library.when'), h('p', { class: 'small', text: e.when })),
    ...section(tr('library.roles'), h('div', { class: 'row lib-meta' }, ...e.roles.map((r) => chip(r)))),
    ...section(tr('library.inputs'), e.inputs?.length ? h('ul', { class: 'rep-list' }, ...e.inputs.map((x) => h('li', { class: 'small', text: x }))) : null),
    ...section(tr('library.prompt'), h('pre', { class: 'brief-text', text: e.prompt })),
    ...section(tr('library.checks'), e.checks?.length ? h('div', { class: 'row lib-meta' }, ...e.checks.map((c) => chip(c))) : null),
    ...section(tr('library.example'), e.examples?.[0] ? h('p', { class: 'small' }, h('span', { class: 'mono', text: e.examples[0].input }), ' ', icon('arrow', 'ico-sm'), ' ', h('span', { text: e.examples[0].output })) : null));
}

function formView() {
  const field = (label, el) => h('label', { class: 'lib-field' }, h('span', { class: 'small', text: label }), el);
  const title = h('input', { class: 'field-in', required: true, maxlength: 70 });
  const category = h('select', { class: 'field-in' }, ...CATEGORY_KEYS.map((c) => h('option', { value: c, text: c, selected: c === 'custom' })));
  const tags = h('input', { class: 'field-in' });
  const when = h('input', { class: 'field-in', maxlength: 260 });
  const prompt = h('textarea', { class: 'brief-edit', rows: 12 });
  prompt.value = 'Goal: \nSteps:\n1. \nQuality bar:\n- \nPitfalls:\n- \nVerify:\n- [ ] \nOutput: ';
  const roles = h('fieldset', { class: 'lib-roles' }, h('legend', { class: 'small', text: tr('library.form.roles') }),
    ...ROLES.map((r) => h('label', { class: 'row small' }, h('input', { type: 'checkbox', value: r, checked: r === 'dev' }), ` ${r}`)));
  const form = h('form', { class: 'lib-form', on: { submit: async (ev) => {
    ev.preventDefault();
    const entry = { title: title.value, category: category.value, tags: tags.value, when: when.value, prompt: prompt.value, roles: [...roles.querySelectorAll('input:checked')].map((x) => x.value) };
    const r = await send('library.add', { entry }, tr('library.error.save'));
    if (r) { notify({ title: tr('library.saved'), tone: 'ok', timeout: 2000 }); openEntry(r.entry.id); }
  } } },
    h('div', { class: 'row' }, btn(tr('library.back'), () => { nav.view = 'list'; nav.v++; }, 'btn btn-xs btn-quiet'), h('h3', { class: 'grow', text: tr('library.add') })),
    field(tr('library.form.title'), title), field(tr('library.form.category'), category), roles,
    field(tr('library.form.tags'), tags), field(tr('library.form.when'), when), field(tr('library.form.prompt'), prompt),
    h('button', { type: 'submit', class: 'btn btn-sm btn-ok', text: tr('library.form.save'), disabled: !!ui.replay }));
  return form;
}

register('library', {
  title: () => tr('library.title'),
  glyph: () => icon('playbook'),
  size: [560, 620],
  min: [320, 280],
  cardH: 560,
  create(ctx) {
    const search = h('input', { class: 'field-in', type: 'search', placeholder: tr('library.search'), 'aria-label': tr('library.search'), style: 'height:30px' });
    const category = h('select', { class: 'field-in', 'aria-label': tr('library.allCategories'), style: 'height:30px;max-width:150px' },
      h('option', { value: '', text: tr('library.allCategories') }), ...CATEGORY_KEYS.map((c) => h('option', { value: c, text: c })));
    const favs = h('input', { type: 'checkbox' });
    const add = btn(tr('library.add'), () => { nav.view = 'form'; nav.v++; }, 'btn btn-xs btn-quiet', 'sparkle');
    const pane = h('div', { class: 'pane pane-pad' });
    ctx.body.append(h('div', { class: 'tb row lib-tb' }, search, category, h('label', { class: 'row small' }, favs, ` ${tr('library.favoritesOnly')}`), add), pane);
    const refresh = () => nav.v++;
    search.addEventListener('input', debounce(refresh, 150));
    category.addEventListener('change', refresh);
    favs.addEventListener('change', refresh);
    let seq = 0;
    track(() => [nav.v, nav.view, ui.replay], async () => {
      const mine = ++seq;
      add.disabled = !!ui.replay;
      if (nav.view === 'form') { clear(pane).append(formView()); return; }
      if (nav.view === 'entry' && nav.id) {
        const r = await send('library.get', { id: nav.id }, tr('library.error.load'));
        if (mine !== seq) return;
        clear(pane);
        if (r) pane.append(entryView(r.entry, refresh));
        return;
      }
      const r = await send('library.list', { q: search.value, category: category.value || undefined, favorites: favs.checked }, tr('library.error.load'));
      if (mine !== seq) return;
      clear(pane);
      const list = r?.entries || [];
      ctx.setSub(tr('library.count', { count: r?.total || 0 }));
      if (!list.length) { pane.append(stateBox({ icon: 'playbook', title: tr('library.empty'), text: '' })); return; }
      pane.append(h('ul', { class: 'lib-list' }, ...list.slice(0, 200).map((e) => row(e, refresh))));
    });
  },
});

document.head.append(h('style', { text: `
.lib-tb { flex-wrap: wrap; gap: 6px; }
.lib-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.lib-row { padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; cursor: pointer; }
.lib-row:hover, .lib-row:focus-visible { border-color: rgb(255 181 49 / .45); outline: none; }
.lib-t { font-weight: 600; font-size: 13px; }
.lib-meta { flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.lib-star.on { color: var(--honey-2); }
.lib-entry h3, .lib-form h3 { margin: 0; font-size: 15px; }
.lib-entry h4 { margin: 12px 0 6px; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--text-2); }
.lib-form { display: grid; gap: 10px; }
.lib-field { display: grid; gap: 4px; }
.lib-roles { display: flex; flex-wrap: wrap; gap: 8px; border: 1px solid var(--line); border-radius: 8px; padding: 6px 10px; }
` }));
