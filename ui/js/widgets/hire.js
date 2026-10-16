// Hire dialog: create a worker with a role prompt, avatar color and allowed tools.
// The same dialog edits the role of an existing worker.

import { h, icon } from '../dom.js';
import { beeAvatar } from '../bees.js';
import { S, ui } from '../store.js';
import * as act from '../actions.js';
import { notify } from '../notify.js';
import { play } from '../sound.js';

const COLORS = ['#FFB531', '#F08A5D', '#E37BB0', '#B39DDB', '#86A9D6', '#5AA9E6', '#6CC9A0', '#C5D86D', '#D9B38C', '#A8A29A'];
const TOOLS = [
  ['list', 'See the files in the workspace'],
  ['read', 'Read a file'],
  ['write', 'Create or overwrite a file'],
  ['edit', 'Search and replace inside a file'],
  ['run', 'Run a command in the workspace, with a time limit'],
  ['preview', 'Open the workspace as a site'],
];
const PRESETS = [
  { role: 'Translator', prompt: 'You translate the copy and the docs of the workspace into Brazilian Portuguese. Keep the meaning, keep the tone, never change code.', tools: ['list', 'read', 'write', 'edit'] },
  { role: 'Reviewer', prompt: 'You review the code the crew wrote. Point out bugs, unclear names and missing edge cases in short notes. You do not rewrite files yourself.', tools: ['list', 'read'] },
  { role: 'Accessibility', prompt: 'You check pages for accessibility: labels, contrast, focus order, keyboard use. Fix small issues directly and report the rest.', tools: ['list', 'read', 'edit', 'preview'] },
];

let dlg = null;

export function openHire(existing = null) {
  if (ui.replay) return;
  dlg?.remove();
  const editing = !!existing;
  const st = {
    name: existing?.name || '',
    role: existing?.role || '',
    prompt: existing?.prompt || '',
    color: existing?.color || COLORS[(S().crew.length + 3) % COLORS.length],
    tools: new Set(existing?.tools || ['list', 'read', 'write', 'edit']),
  };

  const prevAv = h('div');
  const prevName = h('div', { class: 'wk-name' });
  const prevRole = h('div', { class: 'wk-role' });
  const prevBox = h('div', { class: 'hire-prev' }, prevAv, h('div', { class: 'grow' }, prevName, prevRole, h('div', { class: 'tiny faint', style: 'margin-top:4px', text: 'Shares the one model with the crew and waits for its turn like everyone else.' })));
  const paint = () => {
    prevBox.style.setProperty('--wc', st.color);
    prevAv.replaceChildren(beeAvatar({ id: existing?.id || 'w_new', name: st.name || '?', role: st.role, color: st.color }, 64));
    prevName.textContent = st.name || 'New worker';
    prevRole.textContent = st.role || 'Role';
  };

  const nameIn = h('input', { class: 'field-in', id: 'hire-name', maxLength: 24, value: st.name, required: true, autocomplete: 'off', placeholder: 'Rosa', disabled: editing && existing.builtin });
  const roleIn = h('input', { class: 'field-in', id: 'hire-role', maxLength: 40, value: st.role, placeholder: 'Translator' });
  const promptIn = h('textarea', { class: 'field-ta', id: 'hire-prompt', rows: 5, maxLength: 2000, value: st.prompt, placeholder: 'What this worker does, how it writes, what it must never do.' });
  const err = h('div', { class: 'help', role: 'alert', style: 'color:var(--bad)' });
  nameIn.addEventListener('input', () => { st.name = nameIn.value; paint(); });
  roleIn.addEventListener('input', () => { st.role = roleIn.value; paint(); });
  promptIn.addEventListener('input', () => { st.prompt = promptIn.value; });

  const sw = h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Avatar color' }, COLORS.map((c) => h('button', {
    type: 'button', class: 'sw', role: 'radio', 'aria-label': c, 'aria-checked': String(c === st.color), style: `--c:${c}`,
    on: { click: (e) => { st.color = c; for (const b of sw.children) b.setAttribute('aria-checked', String(b === e.currentTarget)); paint(); } },
  })));
  sw.addEventListener('keydown', (e) => {
    const btns = [...sw.children];
    const i = btns.indexOf(document.activeElement);
    if (['ArrowRight', 'ArrowLeft'].includes(e.key) && i >= 0) { e.preventDefault(); const n = btns[(i + (e.key === 'ArrowRight' ? 1 : -1) + btns.length) % btns.length]; n.focus(); n.click(); }
  });

  const toolsEl = h('div', { class: 'toolpick' }, TOOLS.map(([t, desc]) => h('label', { class: 'toolopt' },
    h('input', { type: 'checkbox', checked: st.tools.has(t), on: { change: (e) => { if (e.target.checked) st.tools.add(t); else st.tools.delete(t); } } }),
    h('div', {}, h('b', { text: t }), h('span', { text: desc }), t === 'run' ? h('span', { style: 'display:block;color:var(--warn)', text: 'Asks for approval when approval mode is on' }) : null))));

  const presets = editing ? null : h('div', { class: 'row', style: 'flex-wrap:wrap;gap:6px' }, h('span', { class: 'tiny muted', text: 'Start from' }), PRESETS.map((p) => h('button', {
    type: 'button', class: 'btn btn-xs btn-quiet', text: p.role,
    on: { click: () => { roleIn.value = st.role = p.role; promptIn.value = st.prompt = p.prompt; st.tools = new Set(p.tools); for (const cb of toolsEl.querySelectorAll('input')) cb.checked = st.tools.has(cb.closest('label').querySelector('b').textContent); paint(); } },
  })));

  const submit = h('button', { type: 'submit', class: 'btn btn-sm btn-primary' }, icon(editing ? 'check' : 'hire', 'ico-sm'), editing ? 'Save role' : 'Hire');
  const form = h('form', { method: 'dialog', style: 'display:contents' },
    h('div', { class: 'dlg-h' }, h('div', { class: 'win-glyph', style: 'width:34px;height:38px;color:var(--honey)' }, icon(editing ? 'writer' : 'hire', 'ico-lg')),
      h('div', { class: 'grow' }, h('h2', { id: 'hire-t', text: editing ? `Edit ${existing.name}` : 'Hire a worker' }), h('p', { text: editing ? 'Change how this worker thinks and what it may touch.' : 'Give the crew a new specialist. It joins the dock and the turn queue.' })),
      h('button', { type: 'button', class: 'ibtn', 'aria-label': 'Close', on: { click: () => dlg.close() } }, icon('x'))),
    h('div', { class: 'dlg-b' },
      prevBox,
      presets,
      h('div', { class: 'hire-grid' },
        h('div', {}, h('label', { class: 'lbl', for: 'hire-name', text: 'Name' }), nameIn),
        h('div', {}, h('label', { class: 'lbl', for: 'hire-role', text: 'Role' }), roleIn)),
      h('div', {}, h('label', { class: 'lbl', for: 'hire-prompt', text: 'Role prompt' }), promptIn, h('div', { class: 'help', text: 'Short and concrete works best with a small local model.' })),
      h('div', {}, h('div', { class: 'lbl', text: 'Avatar color' }), sw),
      h('div', {}, h('div', { class: 'lbl', text: 'Allowed tools' }), toolsEl, h('div', { class: 'help', text: 'Tools only reach the workspace folder. Nothing outside it can be read or written.' })),
      err),
    h('div', { class: 'dlg-f' }, h('button', { type: 'button', class: 'btn btn-sm btn-quiet', text: 'Cancel', on: { click: () => dlg.close() } }), submit));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = st.name.trim();
    const taken = S().crew.some((w) => w.name.toLowerCase() === name.toLowerCase() && w.id !== existing?.id);
    if (!name) { err.textContent = 'Give the worker a name.'; nameIn.focus(); return; }
    if (taken) { err.textContent = `${name} is already on the crew. Pick another name.`; nameIn.focus(); return; }
    if (st.prompt.trim().length < 10) { err.textContent = 'Write a role prompt of at least one sentence.'; promptIn.focus(); return; }
    if (!st.tools.size) { err.textContent = 'Allow at least one tool.'; return; }
    err.textContent = '';
    submit.disabled = true;
    const data = { name, role: st.role.trim() || 'Specialist', prompt: st.prompt.trim(), color: st.color, tools: [...st.tools] };
    const r = editing ? await act.updateWorker(existing.id, data) : await act.hire(data);
    submit.disabled = false;
    if (!r) return;
    dlg.close();
    if (!editing) {
      play('tick');
      notify({ title: `${name} joined the crew`, body: `${data.role}. Find ${name} in the dock.`, tone: 'ok', worker: r.worker || data });
      if (r.worker?.id) import('../wm.js').then((wm) => wm.open('worker', r.worker.id));
    } else notify({ title: `${name} updated`, tone: 'ok', timeout: 2500 });
  });

  dlg = h('dialog', { class: 'dlg', 'aria-labelledby': 'hire-t' }, form);
  const me = dlg;
  me.addEventListener('close', () => setTimeout(() => me.remove(), 10));
  document.body.append(dlg);
  paint();
  dlg.showModal();
  (editing ? promptIn : nameIn).focus();
}
