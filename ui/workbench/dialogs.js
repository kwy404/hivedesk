// Small dialogs for the workbench on the desktop's modal (ui/js/dialog.js): confirm, prompt,
// a choice between buttons, and a context menu.

import { h } from '/js/dom.js';
import { openDialog } from '/js/dialog.js';
import { tw } from './strings.js';

/**
 * Buttons: [{ id, label, primary?, danger? }]. Resolves with the id of the button, or null.
 * @returns {Promise<string | null>}
 */
export function choose({ title, text, detail, buttons }) {
  return new Promise((resolve) => {
    let answer = null;
    const row = h('div', { class: 'wb-dlg-btns' });
    const body = h('div', { class: 'wb-dlg' }, text ? h('p', { class: 'wb-dlg-text', text }) : null, detail || null, row);
    const dlg = openDialog({ title, body, onClose: () => resolve(answer) });
    buttons.forEach((b, i) => {
      row.append(h('button', {
        type: 'button',
        class: `wb-btn${b.primary ? ' is-primary' : ''}${b.danger ? ' is-danger' : ''}`,
        text: b.label,
        dataset: { id: b.id, ...(b.primary || i === buttons.length - 1 ? { autofocus: '' } : {}) },
        on: { click: () => { answer = b.id; dlg.close(); } },
      }));
    });
    row.querySelector('[data-autofocus]')?.focus();
  });
}

export async function confirm({ title, text, detail, ok, danger = false }) {
  const r = await choose({ title, text, detail, buttons: [{ id: 'cancel', label: tw('wb.cancel') }, { id: 'ok', label: ok || tw('wb.ok'), primary: !danger, danger }] });
  return r === 'ok';
}

/** Resolves with the text, or null when cancelled. `check(value)` returns an error text or ''. */
export function prompt({ title, label, value = '', ok, check, select }) {
  return new Promise((resolve) => {
    let answer = null;
    const input = h('input', { class: 'wb-input', type: 'text', value, spellcheck: false, attrs: { 'aria-label': label || title, 'data-autofocus': '' } });
    const err = h('p', { class: 'wb-dlg-err', attrs: { role: 'alert' } });
    const okBtn = h('button', { type: 'button', class: 'wb-btn is-primary', text: ok || tw('wb.ok') });
    const body = h('div', { class: 'wb-dlg' }, label ? h('label', { class: 'wb-dlg-label', text: label }) : null, input, err,
      h('div', { class: 'wb-dlg-btns' }, h('button', { type: 'button', class: 'wb-btn', text: tw('wb.cancel'), on: { click: () => dlg.close() } }), okBtn));
    const dlg = openDialog({ title, body, onClose: () => resolve(answer) });
    const validate = () => {
      const msg = check ? check(input.value) : '';
      err.textContent = msg || '';
      okBtn.disabled = !!msg;
      return !msg;
    };
    const submit = () => {
      if (!validate()) return;
      answer = input.value;
      dlg.close();
    };
    input.addEventListener('input', validate);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    okBtn.addEventListener('click', submit);
    setTimeout(() => {
      input.focus();
      if (select) input.setSelectionRange(select[0], select[1]);
      else input.select();
      validate();
    }, 0);
  });
}

let menuEl = null;
export function closeMenu() {
  menuEl?.remove();
  menuEl = null;
}

/** A context menu at a point. items: [{ label, keys?, run, danger?, disabled? } | 'sep']. */
export function contextMenu(x, y, items) {
  closeMenu();
  const list = h('div', { class: 'wb-menu', role: 'menu' });
  const btns = [];
  for (const it of items) {
    if (it === 'sep') { list.append(h('div', { class: 'wb-menu-sep', role: 'separator' })); continue; }
    const b = h('button', { type: 'button', class: `wb-menu-it${it.danger ? ' is-danger' : ''}`, role: 'menuitem', disabled: !!it.disabled, on: { click: () => { closeMenu(); it.run(); } } },
      h('span', { text: it.label }), it.keys ? h('span', { class: 'wb-menu-k', text: it.keys }) : null);
    btns.push(b);
    list.append(b);
  }
  document.body.append(list);
  const r = list.getBoundingClientRect();
  list.style.left = `${Math.max(4, Math.min(x, innerWidth - r.width - 4))}px`;
  list.style.top = `${Math.max(4, Math.min(y, innerHeight - r.height - 4))}px`;
  menuEl = list;
  let i = 0;
  btns[0]?.focus();
  list.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeMenu(); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      i = (i + (e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length;
      btns[i].focus();
    }
  });
  setTimeout(() => {
    const away = (e) => { if (!list.contains(e.target)) { closeMenu(); removeEventListener('pointerdown', away, true); } };
    addEventListener('pointerdown', away, true);
  }, 0);
  return list;
}
