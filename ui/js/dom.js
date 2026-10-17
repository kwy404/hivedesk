// Small DOM helpers shared by every module. No framework: Voodoo.js handles reactivity
// (see store.js) and these helpers only build nodes.

import { t, fmtBytes as iBytes, fmtTime as iTime, fmtDuration as iDuration, fmtAgo } from './i18n.js';

/**
 * Creates an element. `props` keys: class, text, html (trusted strings only), style,
 * dataset, attrs, on (event map), and any other key is set as a property.
 * Translated props (they follow a live language switch, see i18n.js):
 *   tx: key     text content          ta: key   aria-label
 *   tp: key     placeholder           txArgs: { ... } parameters for those keys
 *   tip: key    rich tooltip, reads <key>.title and <key>.help (tooltip.js)
 *   kb: 'Ctrl K'  shortcut shown in the tooltip
 * @param {string} tag
 * @param {object} [props]
 * @param {...(Node|string|null|false|Array)} children
 */
export function h(tag, props, ...children) {
  const el = tag === 'svg' || tag.startsWith('svg:')
    ? document.createElementNS('http://www.w3.org/2000/svg', tag.replace('svg:', ''))
    : document.createElement(tag);
  if (props) {
    const a = props.txArgs;
    if (a) el.setAttribute('data-tx-args', JSON.stringify(a));
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'txArgs') continue;
      if (k === 'tx') { el.dataset.tx = v; el.textContent = t(v, a); continue; }
      if (k === 'ta') { el.dataset.ta = v; el.setAttribute('aria-label', t(v, a)); continue; }
      if (k === 'tp') { el.dataset.tp = v; el.setAttribute('placeholder', t(v, a)); continue; }
      if (k === 'tip') { el.dataset.tip = v; continue; }
      if (k === 'kb') { el.dataset.kb = v; continue; }
      if (k === 'class') el.setAttribute('class', Array.isArray(v) ? v.filter(Boolean).join(' ') : v);
      else if (k === 'text') el.textContent = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'style') el.setAttribute('style', v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'attrs') for (const [a, av] of Object.entries(v)) { if (av != null && av !== false) el.setAttribute(a, av === true ? '' : av); }
      else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
      else if (k.startsWith('aria-') || k.startsWith('data-') || k === 'role' || k === 'for' || k === 'tabindex') el.setAttribute(k, v === true ? '' : v);
      else el[k] = v;
    }
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** Icon from the shared sprite in /assets/icons/sprite.svg (inlined at boot). */
export function icon(name, cls = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', `ico ${cls}`.trim());
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('viewBox', '0 0 24 24');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function clear(el) { while (el.firstChild) el.firstChild.remove(); return el; }

export const fmtBytes = (n) => iBytes(n);

export const fmtTime = (ts) => iTime(ts);

export const fmtDuration = (ms) => iDuration(ms);

export const ago = (ts) => fmtAgo(ts);

export const reducedMotion = () => document.documentElement.dataset.motion === 'reduce'
  || matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Keeps a container's children in sync with `items` by key, creating, updating and removing nodes. */
export function syncList(container, items, key, create, update) {
  const existing = new Map();
  for (const child of [...container.children]) if (child.dataset.key != null) existing.set(child.dataset.key, child);
  let prev = null;
  const seen = new Set();
  for (const item of items) {
    const k = String(key(item));
    seen.add(k);
    let node = existing.get(k);
    if (!node) { node = create(item); node.dataset.key = k; }
    else if (update) update(node, item);
    const want = prev ? prev.nextSibling : container.firstChild;
    if (want !== node) container.insertBefore(node, want);
    prev = node;
  }
  for (const [k, node] of existing) if (!seen.has(k)) node.remove();
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function copyText(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const ta = h('textarea', { value: text, style: 'position:fixed;opacity:0' });
  document.body.append(ta); ta.select();
  try { document.execCommand('copy'); } finally { ta.remove(); }
  return Promise.resolve();
}

export function uid(p = 'u') { return `${p}${Math.random().toString(36).slice(2, 9)}`; }

/** Very small markdown: code blocks, inline code, bold, links as text. Returns a fragment. */
export function richText(text) {
  const frag = document.createDocumentFragment();
  const parts = String(text ?? '').split(/```(\w*)\n?([\s\S]*?)```/g);
  for (let i = 0; i < parts.length; i++) {
    if (i % 3 === 0) {
      const lines = parts[i].split('\n');
      lines.forEach((line, li) => {
        for (const seg of line.split(/(`[^`]+`|\*\*[^*]+\*\*)/g)) {
          if (!seg) continue;
          if (seg.startsWith('`') && seg.endsWith('`') && seg.length > 1) frag.append(h('code', { class: 'ic', text: seg.slice(1, -1) }));
          else if (seg.startsWith('**') && seg.endsWith('**')) frag.append(h('strong', { text: seg.slice(2, -2) }));
          else frag.append(seg);
        }
        if (li < lines.length - 1) frag.append(h('br'));
      });
    } else if (i % 3 === 2) {
      frag.append(h('pre', { class: 'cb' }, h('code', { text: parts[i].replace(/\n$/, '') })));
    }
  }
  return frag;
}
