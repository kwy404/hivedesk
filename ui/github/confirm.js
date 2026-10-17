// The confirmation card: Mel shows exactly what a plan will do, the user can edit the
// editable parts (repository name, visibility, commit message, pull request title and body)
// and only "Yes, do it" runs it. Esc, the scrim and "No" all mean no.

import { h, icon } from '/js/dom.js';
import { beeAvatar } from '/js/bees.js';
import { worker } from '/js/store.js';
import { T } from './t.js';

const fill = (text, params) => String(text ?? '').replace(/\{(\w+)\}/g, (m, k) => (params[k] !== undefined && params[k] !== '' ? String(params[k]) : m));

/** The values used to fill {name}, {visibility} and {message} in steps and facts. */
function live(plan, edits) {
  const e = { ...plan.edit, ...edits };
  return { name: e.name || '<name>', visibility: e.private === false ? T('github.vis.public') : T('github.vis.private'), message: String(e.message || '').split('\n')[0] };
}

export function stepLabel(step, plan, edits = {}) {
  const base = live(plan, edits);
  const params = Object.fromEntries(Object.entries(step.params || {}).map(([k, v]) => [k, fill(v, base)]));
  const text = T(step.key, { ...base, ...params });
  return text === step.key ? fill(step.text, { ...base, ...params }) : text;
}

const plain = (key, fallback, params) => { const v = T(key, params); return v === key ? fallback : v; };

let open = null;

/**
 * Shows the card and resolves to { yes, edits }.
 * @param {object} plan a plan from github.plan or github.intent
 * @param {{ origin?: string, text?: string }} [opts]
 */
export function confirmCard(plan, opts = {}) {
  if (open) open.finish(false);
  return new Promise((resolve) => {
    const edits = {};
    const returnTo = document.activeElement;
    const scrim = h('div', { class: 'ghc-scrim' });
    const stepsEl = h('ol', { class: 'ghc-steps' });
    const paintSteps = () => {
      stepsEl.replaceChildren(...plan.steps.map((s) => h('li', {},
        h('span', { class: 'grow', text: stepLabel(s, plan, edits) }),
        s.remote ? h('span', { class: 'hchip hchip-honey', text: T('github.card.remote') }) : h('span', { class: 'hchip', text: T('github.card.local') }))));
      for (const el of box.querySelectorAll('[data-template]')) el.textContent = fill(el.dataset.template, { name: edits.name ?? plan.edit?.name ?? '<name>' });
    };
    const facts = h('dl', { class: 'ghc-facts' });
    for (const f of plan.facts || []) {
      const label = plain(f.key, f.label);
      let value;
      if (f.edit === 'name') {
        value = h('input', { class: 'field-in', type: 'text', value: plan.edit.name || '', maxlength: 100, spellcheck: false, 'aria-label': label, placeholder: T('github.card.namePlaceholder'), on: { input: (e) => { edits.name = e.target.value.trim(); paintSteps(); } } });
      } else if (f.edit === 'private') {
        const group = `ghc-vis-${plan.id}`;
        const radio = (val, key) => h('label', { class: 'ghc-radio' }, h('input', { type: 'radio', name: group, value: val, checked: (plan.edit.private !== false) === (val === 'private'), on: { change: () => { edits.private = val === 'private'; paintSteps(); } } }), T(key));
        value = h('div', { class: 'row', role: 'radiogroup', 'aria-label': label }, radio('private', 'github.vis.private'), radio('public', 'github.vis.public'));
      } else if (f.edit === 'message' || f.edit === 'body') {
        value = h('div', {},
          h('textarea', { class: 'field-ta ghc-ta', rows: f.edit === 'body' ? 10 : 6, spellcheck: true, 'aria-label': label, value: plan.edit[f.edit] || '', on: { input: (e) => { edits[f.edit] = e.target.value; paintSteps(); } } }),
          f.edit === 'message' ? h('div', { class: 'tiny faint', text: plan.messageBy === 'mel' ? T('github.card.byMel') : plan.messageBy === 'you' ? T('github.card.byYou') : T('github.card.byReport') }) : null);
      } else if (f.edit === 'title') {
        value = h('input', { class: 'field-in', type: 'text', value: plan.edit.title || '', maxlength: 250, 'aria-label': label, on: { input: (e) => { edits.title = e.target.value; } } });
      } else if (Array.isArray(f.files)) {
        value = h('details', { class: 'ghc-files' }, h('summary', { text: T('github.card.fileCount', { count: f.files.length }) }),
          h('ul', {}, f.files.map((x) => h('li', {}, h('code', { text: x.path }), ' ', h('span', { class: 'faint', text: plain(`github.status.${x.status}`, x.status) })))));
      } else {
        const text = f.valueKey ? plain(f.valueKey, String(f.value)) : String(f.value ?? '');
        value = h('code', { class: 'ghc-v', text, ...(f.template ? { dataset: { template: f.template } } : {}) });
      }
      facts.append(h('dt', { text: label }), h('dd', {}, value));
    }
    const warnings = (plan.warnings || []).map((w) => h('p', { class: 'ghc-warn' }, icon('approval', 'ico-sm'), h('span', { text: plain(w.key, w.text, w.params) })));
    const yes = h('button', { type: 'button', class: 'btn btn-sm btn-primary', text: plan.remote ? T('github.card.yesRemote') : T('github.card.yes') });
    const no = h('button', { type: 'button', class: 'btn btn-sm btn-quiet', text: T('github.card.no') });
    const title = plain(plan.titleKey, plan.title, plan.titleParams);
    const box = h('div', { class: 'ghc', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': `ghc-t-${plan.id}`, 'aria-describedby': `ghc-d-${plan.id}` },
      h('div', { class: 'ghc-head' }, beeAvatar(worker('mel'), 36, { ring: true }),
        h('div', { class: 'grow' }, h('h2', { id: `ghc-t-${plan.id}`, text: title }), h('p', { id: `ghc-d-${plan.id}`, class: 'muted', text: opts.text ? T('github.card.fromChat', { text: opts.text }) : T('github.card.lead') }))),
      h('div', { class: 'ghc-body' },
        h('h3', { text: T('github.card.steps') }), stepsEl,
        (plan.facts || []).length ? h('h3', { text: T('github.card.details') }) : null, facts,
        warnings,
        plan.remote ? h('p', { class: 'tiny muted', text: T('github.card.remoteNote') }) : null),
      h('div', { class: 'ghc-foot' }, no, yes));
    const finish = (ok) => {
      if (!open || open.box !== box) return;
      open = null;
      scrim.remove(); box.remove();
      document.removeEventListener('keydown', onKey, true);
      if (returnTo && document.contains(returnTo)) returnTo.focus?.();
      resolve({ yes: ok, edits });
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
      if (e.key === 'Tab') {
        const f = [...box.querySelectorAll('button, input, textarea, summary, a[href]')].filter((x) => !x.disabled);
        if (!f.length) return;
        if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
      }
    };
    yes.addEventListener('click', () => {
      if (plan.edit && 'name' in plan.edit && !(edits.name ?? plan.edit.name)) { box.querySelector('input.field-in')?.focus(); return; }
      finish(true);
    });
    no.addEventListener('click', () => finish(false));
    scrim.addEventListener('pointerdown', () => finish(false));
    document.addEventListener('keydown', onKey, true);
    document.body.append(scrim, box);
    open = { box, finish };
    paintSteps();
    no.focus();
  });
}
