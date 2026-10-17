// Unified diff viewer.

import { h } from './dom.js';
import { t } from './i18n.js';

export function diffStats(diff) {
  let add = 0; let del = 0;
  for (const line of String(diff || '').split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) add++;
    else if (line.startsWith('-')) del++;
  }
  return { add, del };
}

/**
 * Renders a unified diff. When `diff` is empty and `content` is given (a new file), the
 * whole content is shown as added lines.
 * The root class is udiff, never diff: Monsoon's .diff is an image compare slider (a grid with
 * every child on row 1 and a round handle), which split the lines into columns.
 */
export function diffView(diff, content) {
  const root = h('div', { class: 'udiff', role: 'table', 'aria-label': t('diff.aria') });
  let text = String(diff || '');
  if (!text.trim() && content != null) text = `@@ -0,0 +1,${content.split('\n').length} @@\n${content.split('\n').map((l) => `+${l}`).join('\n')}`;
  if (!text.trim()) { root.append(h('div', { class: 'hunk', text: t('diff.empty') })); return root; }
  let a = 0; let b = 0;
  const frag = document.createDocumentFragment();
  let count = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('diff ') || line.startsWith('index ')) continue;
    if (count++ > 4000) { frag.append(h('div', { class: 'hunk', text: t('diff.truncated') })); break; }
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (m) { a = +m[1]; b = +m[2]; frag.append(h('div', { class: 'hunk', role: 'row', text: line })); continue; }
    if (line === '\\ No newline at end of file') continue;
    const sign = line[0];
    const body = line.slice(1);
    let cls = 'ctx'; let la = ''; let lb = '';
    if (sign === '+') { cls = 'add'; lb = b++; }
    else if (sign === '-') { cls = 'del'; la = a++; }
    else { la = a++; lb = b++; }
    frag.append(h('div', { class: `d ${cls}`, role: 'row' },
      h('span', { text: String(la) }), h('span', { text: String(lb) }), h('span', { text: sign === ' ' || !sign ? ' ' : sign }), h('span', { text: body || ' ' })));
  }
  root.append(frag);
  return root;
}
