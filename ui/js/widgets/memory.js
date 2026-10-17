// Memory: what the crew remembers about this project and about you, and the past sessions.
// Everything shown here lives in .hivedesk/memory.json, ~/.hivedesk/memory.json and .hivedesk/sessions/.

import { h, icon, clear, copyText } from '../dom.js';
import { register } from '../wm.js';
import { S, ui, onEvent } from '../store.js';
import { command } from '../net.js';
import { notify } from '../notify.js';
import { track, stateBox, btn } from './util.js';

const V = window.V;
const box = V.reactive({ v: 0 });
onEvent((ev) => { if (['memory.changed', 'memory.used', 'job.report', 'job.done', 'settings.changed', 'worker.note'].includes(ev.type)) box.v++; });

async function send(type, data, fail) {
  try { return await command(type, data); } catch (err) { notify({ title: fail, body: err.message, tone: 'bad', sound: 'error' }); return null; }
}

function entryRow(e, refresh) {
  const text = h('span', { class: 'grow small', text: e.text });
  const edit = async () => {
    const area = h('textarea', { class: 'brief-edit', rows: 2 });
    area.value = e.text;
    const save = btn('Save', async () => { if (await send('memory.update', { id: e.id, text: area.value }, 'Could not save')) refresh(); }, 'btn btn-xs btn-ok');
    row.replaceChildren(area, save);
    area.focus();
  };
  const row = h('li', { class: 'mem-row' },
    h('span', { class: `hchip ${e.pinned ? 'hchip-honey' : ''}`, text: e.kind }),
    h('span', { class: 'hchip', text: e.scope === 'user' ? 'you' : 'project' }),
    text,
    btn(e.pinned ? 'Unpin' : 'Pin', async () => { if (await send('memory.update', { id: e.id, pinned: !e.pinned }, 'Could not pin')) refresh(); }, 'btn btn-xs btn-quiet'),
    btn('Edit', edit, 'btn btn-xs btn-quiet'),
    btn('Delete', async () => { if (await send('memory.delete', { id: e.id }, 'Could not delete')) refresh(); }, 'btn btn-xs btn-bad'));
  if (ui.replay) for (const b of row.querySelectorAll('button')) b.disabled = true;
  return row;
}

function sessionRow(s, refresh) {
  const detail = h('div', { class: 'mem-session', hidden: true });
  const input = h('input', { class: 'field-in', placeholder: 'What next? (empty: finish what was missing)', 'aria-label': 'What to do next' });
  const open = async () => {
    detail.hidden = !detail.hidden;
    if (detail.hidden || detail.childElementCount) return;
    const r = await send('session.get', { id: s.id }, 'Could not open the session');
    if (!r) return;
    const report = [...r.records].reverse().find((x) => x.type === 'report');
    const decisions = r.records.filter((x) => x.type === 'decision');
    detail.append(
      report?.report ? h('p', { class: 'small', text: report.report.built || '' }) : h('p', { class: 'small muted', text: 'No report for this session.' }),
      report?.improvedPrompt ? h('div', { class: 'rep-prompt' }, h('div', { class: 'row' }, h('h4', { class: 'grow', text: 'Improved prompt' }), btn('Copy', () => copyText(report.improvedPrompt), 'btn btn-xs btn-quiet', 'copy')), h('pre', { class: 'brief-text', text: report.improvedPrompt })) : null,
      decisions.length ? h('ul', { class: 'rep-list' }, ...decisions.map((d) => h('li', { class: 'small', text: `${d.workerId}: ${d.text}` }))) : null,
      h('div', { class: 'row', style: 'margin-top:8px' }, input, btn('Continue this session', async () => { const x = await send('session.continue', { id: s.id, request: input.value }, 'Could not continue'); if (x) notify({ title: 'Continuing the session', tone: 'ok', timeout: 1800 }); }, 'btn btn-xs btn-ok')));
  };
  return h('li', { class: 'mem-srow' },
    h('div', { class: 'row' },
      h('span', { class: `hchip ${s.status === 'done' ? 'hchip-ok' : s.status === 'failed' ? 'hchip-bad' : ''}`, text: s.status }),
      h('span', { class: 'grow small ellipsis', text: s.request }),
      h('span', { class: 'tiny faint', text: s.startedAt ? new Date(s.startedAt).toLocaleString() : '' }),
      btn('Open', open, 'btn btn-xs btn-quiet')),
    detail);
}

register('memory', {
  title: 'Memory',
  glyph: () => icon('playbook'),
  size: [560, 600],
  min: [320, 260],
  cardH: 520,
  create(ctx) {
    const search = h('input', { class: 'field-in', type: 'search', placeholder: 'Search memories', 'aria-label': 'Search memories', style: 'height:30px' });
    const forget = h('input', { class: 'field-in', placeholder: 'Forget this: type what to forget', 'aria-label': 'Forget this', style: 'height:30px' });
    const pane = h('div', { class: 'pane pane-pad' });
    ctx.body.append(h('div', { class: 'tb row' }, search, forget, btn('Forget', async () => {
      const r = await send('memory.forget', { text: forget.value }, 'Nothing forgotten');
      if (r) { notify({ title: 'Forgotten', body: r.forgotten.text, tone: 'ok', timeout: 2200 }); forget.value = ''; box.v++; }
    }, 'btn btn-xs btn-quiet')), pane);
    const refresh = () => box.v++;
    search.addEventListener('input', refresh);
    track(() => [box.v, ui.replay], async () => {
      const [list, sessions] = await Promise.all([send('memory.list', { q: search.value }, 'Could not load the memory'), send('session.list', {}, 'Could not load the sessions')]);
      clear(pane);
      const enabled = list ? list.enabled : true;
      const s = S();
      const job = s.jobs[s.jobs.length - 1];
      pane.append(
        h('div', { class: 'row' },
          h('label', { class: 'row grow small' }, h('input', { type: 'checkbox', checked: enabled, disabled: !!ui.replay, on: { change: (e) => send('settings.set', { memory: e.target.checked }, 'Could not switch the memory') } }), ' Use memory in new jobs')),
        h('p', { class: 'tiny muted', text: 'Memory stays on this computer. A few relevant entries go into the prompts of the brain that serves the job; a cloud provider only sees them when it is the selected brain.' }));
      if (job?.memories?.length) pane.append(h('h4', { text: `Used in the last job (${job.id})` }), h('ul', { class: 'rep-list' }, ...job.memories.map((m) => h('li', { class: 'small', text: m.text }))));
      pane.append(h('h4', { text: 'Memories' }));
      const entries = list?.entries || [];
      ctx.setSub(`${entries.length} entries`);
      if (!entries.length) pane.append(stateBox({ icon: 'playbook', title: 'Nothing remembered yet', text: 'Decisions the crew notes, finished sessions and your preferences show up here.' }));
      else pane.append(h('ul', { class: 'mem-list' }, ...entries.slice().sort((a, b) => (b.pinned - a.pinned) || String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt))).map((e) => entryRow(e, refresh))));
      pane.append(h('h4', { text: 'Sessions' }));
      const ss = sessions?.sessions || [];
      if (!ss.length) pane.append(h('p', { class: 'small muted', text: 'No sessions yet.' }));
      else pane.append(h('ul', { class: 'mem-list' }, ...ss.map((x) => sessionRow(x, refresh))));
    });
  },
});

document.head.append(h('style', { text: `
.mem-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.mem-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 6px 8px; border: 1px solid var(--line); border-radius: 8px; }
.mem-srow { padding: 6px 8px; border: 1px solid var(--line); border-radius: 8px; }
.mem-session { padding: 8px 0 2px; }
` }));
