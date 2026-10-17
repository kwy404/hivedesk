// Providers: connect cloud models (paste a key, test it, pick a model), choose a brain per worker,
// and see the tokens used per brain in this session. Keys never come back to the browser.

import { h, icon, clear } from '../dom.js';
import { register } from '../wm.js';
import { S, ui, onEvent } from '../store.js';
import { command } from '../net.js';
import { notify } from '../notify.js';
import { track, btn } from './util.js';

const V = window.V;
const box = V.reactive({ v: 0 });
let usageTimer = null;
onEvent((ev) => {
  if (ev.type === 'providers.changed' || ev.type === 'settings.changed') box.v++;
  if (ev.type === 'turn.ended' && !usageTimer) usageTimer = setTimeout(() => { usageTimer = null; box.v++; }, 1500);
});

async function send(type, data, fail) {
  try { return await command(type, data, { timeout: 60000 }); } catch (err) { notify({ title: fail, body: err.message, tone: 'bad', sound: 'error' }); return null; }
}

function card(id, p, refresh) {
  const key = h('input', { class: 'field-in', type: 'password', autocomplete: 'off', placeholder: p.configured ? 'Key saved (paste a new one to replace it)' : p.keyHint || 'API key', 'aria-label': `${p.label} API key` });
  const base = id === 'compatible' ? h('input', { class: 'field-in', placeholder: 'Base URL, for example http://127.0.0.1:8080/v1', value: p.baseUrl || '', 'aria-label': 'Base URL' }) : null;
  const model = h('select', { class: 'field-in', 'aria-label': `${p.label} model` }, h('option', { value: p.model || '', text: p.model || 'model' }));
  const status = h('span', { class: 'small muted grow', text: p.configured ? 'Configured' : 'Not configured' });
  const loadModels = async () => {
    const r = await send('provider.models', { provider: id }, 'Could not list the models');
    if (!r) return;
    clear(model);
    for (const m of r.models) model.append(h('option', { value: m, text: m, selected: m === p.model }));
  };
  const save = async () => {
    const r = await send('provider.setKey', { provider: id, key: key.value || undefined, model: model.value || undefined, ...(base ? { baseUrl: base.value } : {}) }, 'Could not save');
    if (r) { key.value = ''; notify({ title: `${p.label} saved`, tone: 'ok', timeout: 1600 }); refresh(); }
  };
  const test = async () => {
    status.textContent = 'Testing...';
    const r = await send('provider.test', { provider: id, model: model.value || undefined }, 'Test failed');
    status.textContent = r ? (r.ok ? `OK: ${r.model} answered in ${r.ms} ms` : `Error: ${r.error}`) : 'Test failed';
    status.className = `small grow ${r?.ok ? 'ok' : 'bad'}`;
  };
  const el = h('article', { class: 'appr prov' },
    h('div', { class: 'appr-h' }, h('div', { class: 'grow' }, h('div', { class: 'appr-t', text: p.label }), h('div', { class: 'small muted', text: id === 'compatible' ? 'OpenRouter, Groq, Mistral, a local server, or any other OpenAI compatible endpoint.' : '' }))),
    h('div', { class: 'prov-body' }, key, base, h('div', { class: 'row' }, model, btn('Models', loadModels, 'btn btn-xs btn-quiet'))),
    h('div', { class: 'appr-a' }, status,
      p.configured ? btn('Remove key', async () => { if (await send('provider.removeKey', { provider: id }, 'Could not remove')) refresh(); }, 'btn btn-xs btn-bad') : null,
      btn('Test connection', test, 'btn btn-xs btn-quiet'),
      btn('Save', save, 'btn btn-xs btn-ok')));
  if (ui.replay) for (const b of el.querySelectorAll('button, input, select')) b.disabled = true;
  return el;
}

register('providers', {
  title: 'Providers',
  glyph: () => icon('key'),
  size: [600, 640],
  min: [320, 280],
  cardH: 560,
  create(ctx) {
    const pane = h('div', { class: 'pane pane-pad' });
    ctx.body.append(pane);
    const refresh = () => box.v++;
    track(() => [box.v, ui.replay], async () => {
      const [list, state] = await Promise.all([send('provider.list', {}, 'Could not load the providers'), fetch('/api/state').then((r) => r.json()).catch(() => null)]);
      clear(pane);
      pane.append(h('p', { class: 'small prov-note', text: 'Cloud providers receive the prompts and the file contents sent to them, and they bill your account. Keys stay in ~/.hivedesk/keys.json on this computer; this page only sees whether a key is set.' }));
      if (!list) return;
      const providers = list.providers;
      for (const [id, p] of Object.entries(providers)) pane.append(card(id, p, refresh));
      // Per worker brain.
      const wb = S().settings.workerBrains || {};
      const choices = [['default', 'Same as the main brain'], ...Object.entries(providers).filter(([, p]) => p.configured).map(([id, p]) => [id, `${p.label}: ${p.model}`])];
      pane.append(h('h4', { text: 'Brain per worker' }), h('p', { class: 'tiny muted', text: 'For example Mel plans with a cloud model while Dev uses the local one. By default everyone uses the main brain.' }));
      const table = h('div', { class: 'prov-workers' });
      for (const w of S().crew) {
        const sel = h('select', { class: 'field-in', 'aria-label': `Brain for ${w.name}`, disabled: !!ui.replay, on: { change: async (e) => { const r = await send('settings.set', { workerBrains: { ...wb, [w.id]: e.target.value } }, 'Could not set the brain'); if (r?.problems?.length) notify({ title: 'Not applied', body: r.problems.join('. '), tone: 'warn' }); } } },
          ...choices.map(([v, label]) => h('option', { value: v, text: label, selected: (wb[w.id] || 'default') === v })));
        table.append(h('span', { class: 'small', text: w.name }), sel);
      }
      pane.append(table);
      // Usage this session.
      const usage = state?.usage || {};
      pane.append(h('h4', { text: 'Tokens used in this session' }));
      const rows = Object.entries(usage);
      pane.append(rows.length ? h('ul', { class: 'rep-list' }, ...rows.map(([brain, u]) => h('li', { class: 'small', text: `${brain}: ${u.prompt} prompt + ${u.completion} completion tokens in ${u.turns} turns` }))) : h('p', { class: 'small muted', text: 'No model turns yet.' }));
    });
  },
});

document.head.append(h('style', { text: `
.prov-note { padding: 10px; border: 1px solid rgb(255 181 49 / .25); border-radius: 10px; background: var(--honey-a); }
.prov-body { display: grid; gap: 8px; padding: 0 12px 10px; }
.prov-workers { display: grid; grid-template-columns: auto 1fr; gap: 6px 12px; align-items: center; }
.prov .ok { color: var(--ok); } .prov .bad { color: var(--bad); }
` }));
