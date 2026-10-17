// Hire dialog: create a worker with a role prompt, avatar color and allowed tools.
// The same dialog edits the role of an existing worker.

import { h, icon } from '../dom.js';
import { beeAvatar } from '../bees.js';
import { S, ui } from '../store.js';
import * as act from '../actions.js';
import { notify } from '../notify.js';
import { play } from '../sound.js';
import { t, onLocale } from '../i18n.js';

const COLORS = ['#FFB531', '#F08A5D', '#E37BB0', '#B39DDB', '#86A9D6', '#5AA9E6', '#6CC9A0', '#C5D86D', '#D9B38C', '#A8A29A'];
// tool ids are protocol values; their descriptions live under hire.tool.<id>
const TOOLS = ['list', 'read', 'write', 'edit', 'run', 'preview'];
// role and prompt are translated when the preset is picked: hire.preset.<id>.role / .prompt
const PRESETS = [
  { id: 'translator', tools: ['list', 'read', 'write', 'edit'] },
  { id: 'reviewer', tools: ['list', 'read'] },
  { id: 'accessibility', tools: ['list', 'read', 'edit', 'preview'] },
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
  const prevBox = h('div', { class: 'hire-prev' }, prevAv, h('div', { class: 'grow' }, prevName, prevRole, h('div', { class: 'tiny faint', style: 'margin-top:4px', tx: 'hire.preview.shared' })));
  const paint = () => {
    prevBox.style.setProperty('--wc', st.color);
    prevAv.replaceChildren(beeAvatar({ id: existing?.id || 'w_new', name: st.name || '?', role: st.role, color: st.color }, 64));
    prevName.textContent = st.name || t('hire.preview.name');
    prevRole.textContent = st.role || t('hire.preview.role');
  };

  const nameIn = h('input', { class: 'field-in', id: 'hire-name', maxLength: 24, value: st.name, required: true, autocomplete: 'off', tp: 'hire.field.namePlaceholder', disabled: editing && existing.builtin });
  const roleIn = h('input', { class: 'field-in', id: 'hire-role', maxLength: 40, value: st.role, tp: 'hire.field.rolePlaceholder' });
  const promptIn = h('textarea', { class: 'field-ta', id: 'hire-prompt', rows: 5, maxLength: 2000, value: st.prompt, tp: 'hire.field.promptPlaceholder' });
  const err = h('div', { class: 'help', role: 'alert', style: 'color:var(--bad)' });
  nameIn.addEventListener('input', () => { st.name = nameIn.value; paint(); });
  roleIn.addEventListener('input', () => { st.role = roleIn.value; paint(); });
  promptIn.addEventListener('input', () => { st.prompt = promptIn.value; });

  const sw = h('div', { class: 'swatches', role: 'radiogroup', ta: 'hire.field.color' }, COLORS.map((c) => h('button', {
    type: 'button', class: 'sw', role: 'radio', 'aria-label': c, 'aria-checked': String(c === st.color), style: `--c:${c}`, tip: 'tip.hire.color',
    on: { click: (e) => { st.color = c; for (const b of sw.children) b.setAttribute('aria-checked', String(b === e.currentTarget)); paint(); } },
  })));
  sw.addEventListener('keydown', (e) => {
    const btns = [...sw.children];
    const i = btns.indexOf(document.activeElement);
    if (['ArrowRight', 'ArrowLeft'].includes(e.key) && i >= 0) { e.preventDefault(); const n = btns[(i + (e.key === 'ArrowRight' ? 1 : -1) + btns.length) % btns.length]; n.focus(); n.click(); }
  });

  const toolsEl = h('div', { class: 'toolpick' }, TOOLS.map((tool) => h('label', { class: 'toolopt' },
    h('input', { type: 'checkbox', checked: st.tools.has(tool), tip: `tip.hire.tool.${tool}`, on: { change: (e) => { if (e.target.checked) st.tools.add(tool); else st.tools.delete(tool); } } }),
    h('div', {}, h('b', { text: tool }), h('span', { tx: `hire.tool.${tool}` }), tool === 'run' ? h('span', { style: 'display:block;color:var(--warn)', tx: 'hire.tool.runApproval' }) : null))));

  const presets = editing ? null : h('div', { class: 'row', style: 'flex-wrap:wrap;gap:6px' }, h('span', { class: 'tiny muted', tx: 'hire.startFrom' }), PRESETS.map((p) => h('button', {
    type: 'button', class: 'btn btn-xs btn-quiet', tx: `hire.preset.${p.id}.role`, tip: 'tip.hire.preset',
    on: { click: () => { roleIn.value = st.role = t(`hire.preset.${p.id}.role`); promptIn.value = st.prompt = t(`hire.preset.${p.id}.prompt`); st.tools = new Set(p.tools); for (const cb of toolsEl.querySelectorAll('input')) cb.checked = st.tools.has(cb.closest('label').querySelector('b').textContent); paint(); } },
  })));

  const submit = h('button', { type: 'submit', class: 'btn btn-sm btn-primary', tip: editing ? 'tip.hire.save' : 'tip.hire.hire', kb: 'Enter' }, icon(editing ? 'check' : 'hire', 'ico-sm'), h('span', { tx: editing ? 'hire.save' : 'hire.hire' }));
  const form = h('form', { method: 'dialog', style: 'display:contents' },
    h('div', { class: 'dlg-h' }, h('div', { class: 'win-glyph', style: 'width:34px;height:38px;color:var(--honey)' }, icon(editing ? 'writer' : 'hire', 'ico-lg')),
      h('div', { class: 'grow' }, h('h2', { id: 'hire-t', tx: editing ? 'hire.editTitle' : 'hire.title', txArgs: editing ? { name: existing.name } : null }), h('p', { tx: editing ? 'hire.editIntro' : 'hire.intro' })),
      h('button', { type: 'button', class: 'ibtn', ta: 'hire.close', tip: 'tip.hire.close', kb: 'Esc', on: { click: () => dlg.close() } }, icon('x'))),
    h('div', { class: 'dlg-b' },
      prevBox,
      presets,
      h('div', { class: 'hire-grid' },
        h('div', {}, h('label', { class: 'lbl', for: 'hire-name', tx: 'hire.field.name' }), nameIn),
        h('div', {}, h('label', { class: 'lbl', for: 'hire-role', tx: 'hire.field.role' }), roleIn)),
      h('div', {}, h('label', { class: 'lbl', for: 'hire-prompt', tx: 'hire.field.prompt' }), promptIn, h('div', { class: 'help', tx: 'hire.field.promptHelp' })),
      h('div', {}, h('div', { class: 'lbl', tx: 'hire.field.color' }), sw),
      h('div', {}, h('div', { class: 'lbl', tx: 'hire.field.tools' }), toolsEl, h('div', { class: 'help', tx: 'hire.field.toolsHelp' })),
      err),
    h('div', { class: 'dlg-f' }, h('button', { type: 'button', class: 'btn btn-sm btn-quiet', tx: 'hire.cancel', tip: 'tip.hire.cancel', kb: 'Esc', on: { click: () => dlg.close() } }), submit));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = st.name.trim();
    const taken = S().crew.some((w) => w.name.toLowerCase() === name.toLowerCase() && w.id !== existing?.id);
    if (!name) { err.textContent = t('hire.error.noName'); nameIn.focus(); return; }
    if (taken) { err.textContent = t('hire.error.taken', { name }); nameIn.focus(); return; }
    if (st.prompt.trim().length < 10) { err.textContent = t('hire.error.shortPrompt'); promptIn.focus(); return; }
    if (!st.tools.size) { err.textContent = t('hire.error.noTools'); return; }
    err.textContent = '';
    submit.disabled = true;
    const data = { name, role: st.role.trim() || t('hire.defaultRole'), prompt: st.prompt.trim(), color: st.color, tools: [...st.tools] };
    const r = editing ? await act.updateWorker(existing.id, data) : await act.hire(data);
    submit.disabled = false;
    if (!r) return;
    dlg.close();
    if (!editing) {
      play('tick');
      notify({ title: t('hire.toast.joined', { name }), body: t('hire.toast.joinedBody', { role: data.role, name }), tone: 'ok', worker: r.worker || data });
      if (r.worker?.id) import('../wm.js').then((wm) => wm.open('worker', r.worker.id));
    } else notify({ title: t('hire.toast.updated', { name }), tone: 'ok', timeout: 2500 });
  });

  dlg = h('dialog', { class: 'dlg', 'aria-labelledby': 'hire-t' }, form);
  const me = dlg;
  const offLocale = onLocale(paint); // the preview placeholders follow a language switch
  me.addEventListener('close', () => { offLocale(); setTimeout(() => me.remove(), 10); });
  document.body.append(dlg);
  paint();
  dlg.showModal();
  (editing ? promptIn : nameIn).focus();
}
