// One accessible context menu for the whole desktop.
// Opens with right click, a long press on touch, and the Menu key or Shift+F10.
// Roles menu / menuitem, arrow keys, Home and End, type-ahead, Escape, submenus,
// and viewport collision handling (flips and clamps to stay on screen).

import { h, icon } from './dom.js';

const providers = new WeakMap();
const stack = []; // open menus, root first
let returnFocus = null;
let lastOpenAt = 0;
let suppressClick = false;

/**
 * Registers a menu provider on an element. `fn(target, event)` returns the items, or
 * null to fall through to an ancestor provider.
 * Item: { label, icon?, kb?, action?, disabled?, danger?, checked?, items?, sep?, header? }
 */
export function provide(el, fn) { providers.set(el, fn); el.dataset.menu = ''; }

function itemsFor(target, ev) {
  let el = target instanceof Element ? target : target?.parentElement;
  while (el) {
    const fn = providers.get(el);
    if (fn) {
      const items = fn(target, ev);
      if (items && items.length) return items;
    }
    el = el.parentElement;
  }
  return null;
}

const isTextField = (el) => el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !['checkbox', 'radio', 'range', 'button', 'submit'].includes(el.type)) || el.isContentEditable);

export function init() {
  document.addEventListener('contextmenu', (e) => {
    if (e.target.closest?.('.cmenu')) { e.preventDefault(); return; }
    // Text fields keep the browser menu (cut, copy, paste, spelling).
    if (isTextField(e.target)) return;
    if (Date.now() - lastOpenAt < 700) { e.preventDefault(); return; }
    const items = itemsFor(e.target, e);
    if (!items) return;
    e.preventDefault();
    const kb = e.button !== 2 && e.clientX === 0 && e.clientY === 0;
    if (kb) openAtElement(document.activeElement || e.target, items);
    else open({ x: e.clientX, y: e.clientY, items });
  });

  document.addEventListener('keydown', (e) => {
    if (stack.length) return; // handled by the menu itself
    if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      const t = document.activeElement;
      if (isTextField(t)) return;
      const items = itemsFor(t || document.body, e);
      if (!items) return;
      e.preventDefault();
      openAtElement(t, items);
    }
  });

  // Long press on touch screens.
  let lp = null;
  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch' || isTextField(e.target)) return;
    const start = { x: e.clientX, y: e.clientY };
    const target = e.target;
    clearTimeout(lp?.timer);
    lp = {
      start,
      timer: setTimeout(() => {
        const items = itemsFor(target, e);
        if (!items) return;
        suppressClick = true;
        navigator.vibrate?.(8);
        open({ x: start.x, y: start.y, items });
      }, 520),
    };
  }, { passive: true });
  const cancel = (e) => {
    if (!lp) return;
    if (e.type === 'pointermove' && Math.hypot(e.clientX - lp.start.x, e.clientY - lp.start.y) < 10) return;
    clearTimeout(lp.timer);
    lp = null;
  };
  document.addEventListener('pointermove', cancel, { passive: true });
  document.addEventListener('pointerup', cancel, { passive: true });
  document.addEventListener('pointercancel', cancel, { passive: true });
  document.addEventListener('click', (e) => { if (suppressClick) { suppressClick = false; e.preventDefault(); e.stopPropagation(); } }, true);

  document.addEventListener('pointerdown', (e) => {
    if (stack.length && !e.target.closest('.cmenu')) closeAll(false);
  }, true);
  window.addEventListener('blur', () => closeAll(false));
  window.addEventListener('resize', () => closeAll(false));
}

function openAtElement(el, items) {
  const r = (el && el !== document.body ? el : document.querySelector('.desk')).getBoundingClientRect();
  open({ x: r.left + Math.min(24, r.width / 2), y: r.top + Math.min(r.height, 40), items });
}

/** Opens a root menu at a viewport point. */
export function open({ x, y, items }) {
  closeAll(false);
  returnFocus = document.activeElement;
  lastOpenAt = Date.now();
  const m = build(items, null);
  position(m.el, { x, y });
  m.focusIndex(0);
}

export function closeAll(restore = true) {
  while (stack.length) stack.pop().el.remove();
  if (restore && returnFocus && document.contains(returnFocus)) returnFocus.focus({ preventScroll: true });
  returnFocus = null;
}

function closeFrom(level) {
  while (stack.length > level) stack.pop().el.remove();
}

function build(items, parent) {
  const level = stack.length;
  const el = h('div', { class: 'cmenu', role: 'menu', tabindex: '-1', 'aria-orientation': 'vertical' });
  if (parent) el.setAttribute('aria-label', parent.label);
  const nodes = [];
  let subTimer = null;

  const m = {
    el, level, nodes,
    focusIndex(i) {
      const focusable = nodes.filter((n) => n);
      if (!focusable.length) { el.focus(); return; }
      const idx = (i + focusable.length) % focusable.length;
      focusable[idx].el.focus();
    },
  };

  for (const it of items) {
    if (!it) continue;
    if (it.sep) { el.append(h('div', { role: 'separator' })); continue; }
    if (it.header) { el.append(h('div', { class: 'cm-h', role: 'presentation', text: it.header })); continue; }
    const role = it.checked != null ? 'menuitemcheckbox' : 'menuitem';
    const b = h('button', {
      type: 'button', role, tabindex: '-1', class: it.danger ? 'danger' : '',
      'aria-disabled': it.disabled ? 'true' : null,
      'aria-checked': it.checked != null ? String(!!it.checked) : null,
      'aria-haspopup': it.items ? 'menu' : null,
      'aria-expanded': it.items ? 'false' : null,
    },
    it.checked != null ? h('span', { class: 'chk' }, it.checked ? icon('check', 'ico-sm') : null) : (it.iconEl || (it.icon ? icon(it.icon) : null)),
    h('span', { class: 'grow ellipsis', text: it.label }),
    it.kb ? h('span', { class: 'kb', text: it.kb }) : null,
    it.items ? h('span', { class: 'sub-ar', html: '<svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4.5 2.5 8 6l-3.5 3.5"/></svg>' }) : null);
    const node = { el: b, it };
    nodes.push(node);
    const openSub = (focusFirst) => {
      if (!it.items || it.disabled) return;
      closeFrom(level + 1);
      const sub = build(typeof it.items === 'function' ? it.items() : it.items, it);
      b.setAttribute('aria-expanded', 'true');
      const r = b.getBoundingClientRect();
      position(sub.el, { x: r.right - 2, y: r.top - 5, flipFrom: r });
      if (focusFirst) sub.focusIndex(0);
    };
    node.openSub = openSub;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (it.disabled) return;
      if (it.items) { openSub(true); return; }
      closeAll(true);
      try { it.action?.(); } catch (err) { console.error(err); }
    });
    b.addEventListener('pointerenter', () => {
      b.focus({ preventScroll: true });
      clearTimeout(subTimer);
      if (it.items) subTimer = setTimeout(() => openSub(false), 140);
      else subTimer = setTimeout(() => closeFrom(level + 1), 160);
    });
  }

  el.addEventListener('keydown', (e) => {
    const focusable = nodes;
    const cur = focusable.findIndex((n) => n.el === document.activeElement);
    const node = focusable[cur];
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); m.focusIndex(cur + 1); break;
      case 'ArrowUp': e.preventDefault(); m.focusIndex(cur < 0 ? -1 : cur - 1); break;
      case 'Home': e.preventDefault(); m.focusIndex(0); break;
      case 'End': e.preventDefault(); m.focusIndex(-1); break;
      case 'ArrowRight': if (node?.it.items) { e.preventDefault(); node.openSub(true); } break;
      case 'ArrowLeft':
        if (level > 0) { e.preventDefault(); closeFrom(level); const p = stack[level - 1]?.nodes.find((n) => n.it === parent); p?.el.setAttribute('aria-expanded', 'false'); p?.el.focus(); }
        break;
      case 'Escape':
        e.preventDefault(); e.stopPropagation();
        if (level > 0) { closeFrom(level); const p = stack[level - 1]?.nodes.find((n) => n.it === parent); p?.el.setAttribute('aria-expanded', 'false'); p?.el.focus(); }
        else closeAll(true);
        break;
      case 'Tab': e.preventDefault(); closeAll(true); break;
      case 'Enter': case ' ':
        e.preventDefault(); node?.el.click(); break;
      default:
        if (e.key.length === 1 && /\S/.test(e.key)) {
          const k = e.key.toLowerCase();
          const start = cur + 1;
          for (let i = 0; i < focusable.length; i++) {
            const n = focusable[(start + i) % focusable.length];
            if (n.it.label.toLowerCase().startsWith(k)) { n.el.focus(); break; }
          }
        }
    }
  });

  document.body.append(el);
  stack.push(m);
  return m;
}

function position(el, { x, y, flipFrom }) {
  el.style.left = '0px';
  el.style.top = '0px';
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const r = el.getBoundingClientRect();
  let left = x;
  let top = y;
  if (left + r.width > vw - 8) left = flipFrom ? flipFrom.left - r.width + 2 : vw - r.width - 8;
  if (left < 8) left = 8;
  if (top + r.height > vh - 8) top = Math.max(8, (flipFrom ? flipFrom.bottom + 5 : vh - 8) - r.height);
  if (top < 8) top = 8;
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
}

export const isOpen = () => stack.length > 0;
