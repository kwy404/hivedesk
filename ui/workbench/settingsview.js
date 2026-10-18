// The Settings tab: the `workbench` section of ~/.hivedesk/settings.json (src/workbench/settings.js).
// Every change is saved by the engine at once and applied live to every editor and terminal.

import { h, clear } from '/js/dom.js';
import { wb } from './net.js';
import { tw } from './strings.js';

/**
 * @param {{ get: () => object, set: (s: object) => void, roots: () => Array<object>, addRoot: () => void, removeRoot: (id) => void, notify: (t, k?) => void, info: () => object }} ctx
 */
export function renderSettings(el, ctx) {
  let timer = null;
  let pending = {};
  const save = (patch) => {
    const terminal = { ...(pending.terminal || {}), ...(patch.terminal || {}) };
    pending = { ...pending, ...patch };
    if (Object.keys(terminal).length) pending.terminal = terminal;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const p = pending;
      pending = {};
      try {
        const r = await wb('wb.settings.set', { settings: p });
        ctx.set(r.settings);
      } catch (err) {
        ctx.notify(err.message, 'bad');
      }
    }, 250);
  };

  const row = (label, help, control) => h('div', { class: 'wb-set-row' }, h('div', { class: 'wb-set-l' }, h('label', { text: label }), help ? h('small', { text: help }) : null), h('div', { class: 'wb-set-c' }, control));
  const num = (key, min, max, sub) => {
    const v = sub ? ctx.get()[sub][key] : ctx.get()[key];
    const i = h('input', { class: 'wb-input is-num', type: 'number', min: String(min), max: String(max), value: String(v), attrs: { 'aria-label': key } });
    i.addEventListener('change', () => { const n = Number(i.value); if (Number.isFinite(n)) save(sub ? { [sub]: { [key]: n } } : { [key]: n }); });
    return i;
  };
  const bool = (key, sub) => {
    const v = sub ? ctx.get()[sub][key] : ctx.get()[key];
    const i = h('input', { type: 'checkbox', class: 'wb-switch', checked: !!v, attrs: { role: 'switch', 'aria-label': key } });
    i.addEventListener('change', () => save(sub ? { [sub]: { [key]: i.checked } } : { [key]: i.checked }));
    return i;
  };
  const pick = (key, options) => {
    const s = h('select', { class: 'wb-select', attrs: { 'aria-label': key } }, ...options.map(([value, label]) => h('option', { value, text: label, selected: ctx.get()[key] === value })));
    s.addEventListener('change', () => save({ [key]: s.value }));
    return s;
  };

  function paint() {
    const s = ctx.get();
    const info = ctx.info() || {};
    const excludes = h('textarea', { class: 'wb-input wb-set-area', rows: 4, spellcheck: false, value: (s.searchExcludes || []).join('\n'), attrs: { 'aria-label': tw('wb.set.excludes') } });
    excludes.addEventListener('change', () => save({ searchExcludes: excludes.value.split('\n').map((x) => x.trim()).filter(Boolean) }));
    const shell = h('input', { class: 'wb-input', type: 'text', value: s.terminal.shell || '', placeholder: tw('wb.set.shellDefault'), spellcheck: false, attrs: { 'aria-label': tw('wb.set.shell') } });
    shell.addEventListener('change', () => save({ terminal: { shell: shell.value.trim() } }));
    const roots = h('ul', { class: 'wb-set-roots' }, ...ctx.roots().map((r) => h('li', {},
      h('div', {}, h('b', { text: r.workspace ? tw('wb.ex.workspace') : r.name }), h('small', { class: 'wb-faint', text: r.path || '' }), r.missing ? h('small', { class: 'wb-warn', text: tw('wb.ex.missing') }) : null),
      r.workspace ? h('span', { class: 'wb-chip', text: tw('wb.set.always') }) : h('button', { class: 'wb-btn is-sm', type: 'button', text: tw('wb.set.removeRoot'), on: { click: () => ctx.removeRoot(r.id) } }))));
    clear(el).append(
      h('header', { class: 'wb-set-h' }, h('h2', { text: tw('wb.settings.title') }), h('p', { class: 'wb-faint', text: tw('wb.set.where') })),
      h('section', { class: 'wb-set-sec' }, h('h3', { text: tw('wb.set.editor') }),
        row(tw('wb.set.fontSize'), '', num('fontSize', 8, 32)),
        row(tw('wb.set.lineHeight'), tw('wb.set.lineHeightHelp'), num('lineHeight', 0, 60)),
        row(tw('wb.set.tabSize'), '', num('tabSize', 1, 8)),
        row(tw('wb.set.insertSpaces'), '', bool('insertSpaces')),
        row(tw('wb.set.wordWrap'), '', pick('wordWrap', [['off', tw('wb.set.off')], ['on', tw('wb.set.on')], ['bounded', tw('wb.set.bounded')]])),
        row(tw('wb.set.lineNumbers'), '', pick('lineNumbers', [['on', tw('wb.set.on')], ['relative', tw('wb.set.relative')], ['off', tw('wb.set.off')]])),
        row(tw('wb.set.whitespace'), '', pick('renderWhitespace', [['none', tw('wb.set.none')], ['selection', tw('wb.set.selection')], ['boundary', tw('wb.set.boundary')], ['all', tw('wb.set.all')]])),
        row(tw('wb.set.minimap'), '', bool('minimap')),
        row(tw('wb.set.sticky'), tw('wb.set.stickyHelp'), bool('stickyScroll')),
        row(tw('wb.set.formatOnSave'), tw('wb.set.formatOnSaveHelp'), bool('formatOnSave'))),
      h('section', { class: 'wb-set-sec' }, h('h3', { text: tw('wb.set.look') }),
        row(tw('wb.set.theme'), tw('wb.set.themeHelp'), pick('theme', [['desk', tw('wb.set.themeDesk')], ['hivedesk-dark', tw('wb.set.themeDark')], ['hivedesk-light', tw('wb.set.themeLight')]]))),
      h('section', { class: 'wb-set-sec' }, h('h3', { text: tw('wb.set.code') }),
        row(tw('wb.set.project'), tw('wb.set.projectHelp'), bool('projectDiagnostics')),
        row(tw('wb.set.excludes'), tw('wb.set.excludesHelp'), excludes)),
      h('section', { class: 'wb-set-sec' }, h('h3', { text: tw('wb.set.terminal') }),
        row(tw('wb.set.shell'), info.terminal?.kind === 'basic' ? tw('wb.set.shellBasic', { reason: info.terminal.reason || '' }) : tw('wb.set.shellHelp'), shell),
        row(tw('wb.set.termFont'), '', num('fontSize', 8, 32, 'terminal')),
        row(tw('wb.set.scrollback'), '', num('scrollback', 500, 50000, 'terminal')),
        row(tw('wb.set.cursorBlink'), '', bool('cursorBlink', 'terminal'))),
      h('section', { class: 'wb-set-sec' }, h('h3', { text: tw('wb.set.roots') }), h('p', { class: 'wb-faint', text: tw('wb.set.rootsHelp') }), roots,
        h('button', { class: 'wb-btn', type: 'button', text: tw('wb.ex.openFolder'), on: { click: () => ctx.addRoot() } })));
  }

  paint();
  return { paint };
}
