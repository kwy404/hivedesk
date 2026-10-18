// The quick picker at the top of the workbench: go to file (Ctrl+P), commands (Ctrl+Shift+P or
// ">"), symbols in the workspace (Ctrl+T or "#"), symbols in the file ("@"), a line (":"), and
// pickers for branches and peers. Providers may be async; stale answers are dropped.

import { h, esc } from '/js/dom.js';
import { parseQuickQuery } from './commands.js';
import { tw } from './strings.js';
import { scrollInto } from './util.js';

function marked(text, marks = []) {
  if (!marks.length) return esc(text);
  const set = new Set(marks);
  let out = '';
  for (let i = 0; i < text.length; i++) out += set.has(i) ? `<mark>${esc(text[i])}</mark>` : esc(text[i]);
  return out;
}

/**
 * @param {HTMLElement} host the workbench root
 * @param {{ provide: (mode: string, q: string) => Promise<Array<{ label: string, detail?: string, hint?: string, badge?: [string, string], marks?: number[], run: () => void, keys?: string[] }>> | Array, placeholder?: (mode: string) => string }} o
 */
export function createQuick(host, o) {
  let box = null;
  let returnTo = null;
  let fixedMode = null;
  let seq = 0;

  function close(restore = true) {
    box?.remove();
    box = null;
    if (restore && returnTo && document.contains(returnTo)) returnTo.focus({ preventScroll: true });
  }

  /** Opens with an initial text ("" files, ">" commands, "#" symbols) or a fixed picker mode. */
  function open(initial = '', { mode = null, placeholder } = {}) {
    close(false);
    returnTo = document.activeElement;
    fixedMode = mode;
    const input = h('input', { class: 'wb-quick-in', type: 'text', value: initial, spellcheck: false, autocomplete: 'off', attrs: { role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'wb-quick-list', 'aria-label': placeholder || tw('wb.quick.label') } });
    const list = h('div', { class: 'wb-quick-list', id: 'wb-quick-list', role: 'listbox' });
    box = h('div', { class: 'wb-quick', role: 'dialog', attrs: { 'aria-label': tw('wb.quick.label') } }, input, list);
    host.append(box);
    let items = [];
    let sel = 0;
    const paint = () => {
      list.replaceChildren();
      if (!items.length) {
        list.append(h('div', { class: 'wb-quick-empty', text: tw('wb.quick.empty') }));
        return;
      }
      items.forEach((it, i) => {
        const row = h('div', { class: 'wb-quick-it', role: 'option', id: `wbq-${i}`, attrs: { 'aria-selected': String(i === sel) }, on: { click: () => run(i), pointermove: () => { if (sel !== i) { sel = i; mark(); } } } },
          it.badge ? h('span', { class: 'wb-badge', style: { color: it.badge[1] }, text: it.badge[0] }) : null,
          h('span', { class: 'wb-quick-l', html: marked(it.label, it.marks) }),
          it.detail ? h('span', { class: 'wb-quick-d', text: it.detail }) : null,
          it.keys?.length ? h('span', { class: 'wb-quick-k' }, ...it.keys.map((k) => h('kbd', { text: k }))) : it.hint ? h('span', { class: 'wb-quick-k', text: it.hint }) : null);
        list.append(row);
      });
      mark();
    };
    const mark = () => {
      for (const el of list.children) el.setAttribute('aria-selected', String(el.id === `wbq-${sel}`));
      const cur = list.querySelector(`#wbq-${sel}`);
      if (cur) { input.setAttribute('aria-activedescendant', cur.id); scrollInto(list, cur); }
    };
    const run = (i) => {
      const it = items[i];
      if (!it) return;
      close(false);
      try { it.run(); } catch (err) { console.error(err); }
    };
    const update = async () => {
      const my = ++seq;
      const parsed = fixedMode ? { mode: fixedMode, q: input.value.trim() } : parseQuickQuery(input.value);
      input.placeholder = o.placeholder?.(parsed.mode) || '';
      let out = [];
      try { out = await o.provide(parsed.mode, parsed.q, input.value); } catch (err) { out = [{ label: err.message, run: () => {} }]; }
      if (my !== seq || !box) return;
      items = out.slice(0, 80);
      sel = 0;
      paint();
    };
    input.addEventListener('input', update);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); sel = (sel + 1) % Math.max(1, items.length); mark(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); sel = (sel - 1 + items.length) % Math.max(1, items.length); mark(); }
      else if (e.key === 'Enter') { e.preventDefault(); run(sel); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
      else if (e.key === 'Tab') e.preventDefault();
    });
    input.addEventListener('blur', () => setTimeout(() => { if (box && !box.contains(document.activeElement)) close(false); }, 120));
    input.focus({ preventScroll: true });
    input.setSelectionRange(input.value.length, input.value.length);
    update();
  }

  return { open, close, get isOpen() { return !!box; } };
}
