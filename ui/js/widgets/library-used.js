// "Playbooks used": the expert playbooks picked for a job (on the brief, before the plan) and for each of
// its tasks, with the score and the matched words, and a Swap button while the task has not started.
// Shown inside the Brief and report window. Events: library.preview, library.selected, library.checks.

import { h, clear, debounce } from '../dom.js';
import { S, ui, onEvent } from '../store.js';
import { command } from '../net.js';
import { notify } from '../notify.js';
import { btn } from './util.js';
import { tr } from './library-strings.js';
import { openEntry } from './library.js';

const V = window.V;
export const usedBox = V.reactive({ v: 0 });
/** jobId -> { preview: picks[], tasks: Map<taskId, picks[]>, loaded: boolean } */
const jobs = new Map();

function entry(jobId) {
  if (!jobs.has(jobId)) jobs.set(jobId, { preview: [], tasks: new Map(), loaded: false });
  return jobs.get(jobId);
}

onEvent((ev) => {
  const d = ev.data || {};
  if (!ev.jobId) return;
  if (ev.type === 'library.preview') { entry(ev.jobId).preview = d.picks || []; usedBox.v++; }
  else if (ev.type === 'library.selected') {
    const e = entry(ev.jobId);
    for (const t of d.tasks || []) e.tasks.set(t.taskId, t.picks || []);
    usedBox.v++;
  } else if (ev.type === 'task.status' || ev.type === 'job.done' || ev.type === 'job.failed') usedBox.v++;
});

async function load(jobId) {
  const e = entry(jobId);
  if (e.loaded) return;
  e.loaded = true;
  try {
    const r = await command('library.job', { jobId });
    if (r.preview?.length && !e.preview.length) e.preview = r.preview;
    for (const t of r.tasks || []) if (!e.tasks.has(t.taskId)) e.tasks.set(t.taskId, t.picks);
    usedBox.v++;
  } catch { /* an older engine without the library */ }
}

/** A small search to choose the replacement of one playbook. */
function picker(jobId, taskId, from, done) {
  const input = h('input', { class: 'field-in', type: 'search', placeholder: tr('library.search'), 'aria-label': tr('library.swapFor', { title: from?.title || '' }), style: 'height:28px' });
  const list = h('ul', { class: 'lib-list' });
  const run = async () => {
    let r = null;
    try { r = await command('library.list', { q: input.value || from?.title || '', limit: 8 }); } catch { r = null; }
    clear(list);
    for (const e of (r?.entries || []).filter((x) => x.id !== from?.id).slice(0, 8)) {
      list.append(h('li', {}, h('button', { type: 'button', class: 'btn btn-xs btn-quiet lib-pick', text: `${e.title} (${e.category})`, on: { click: async () => {
        try {
          await command('library.swap', { jobId, ...(taskId ? { taskId } : {}), ...(from ? { from: from.id } : {}), to: e.id });
          notify({ title: tr('library.swapped'), tone: 'ok', timeout: 1600 });
          done();
        } catch (err) { notify({ title: tr('library.locked'), body: err.message, tone: 'bad' }); }
      } } })));
    }
  };
  input.addEventListener('input', debounce(run, 150));
  run();
  return h('div', { class: 'lib-picker' }, h('div', { class: 'small', text: from ? tr('library.swapFor', { title: from.title }) : tr('library.addTo') }), input, list, btn(tr('library.cancel'), done, 'btn btn-xs btn-quiet'));
}

function picksList(jobId, taskId, picks, canSwap) {
  const ul = h('ul', { class: 'rep-list lib-used' });
  if (!picks.length) ul.append(h('li', { class: 'small muted', text: tr('library.none') }));
  for (const p of picks) {
    const li = h('li', { class: 'small' },
      h('button', { type: 'button', class: 'linkish', text: p.title, on: { click: () => openEntry(p.id) }, title: tr('library.open') }), ' ',
      h('span', { class: 'tiny faint', text: p.swapped || p.pinned ? `(${tr('library.swapped')})` : tr('library.why', { score: p.score, terms: (p.terms || []).join(', ') }) }), ' ');
    if (canSwap) li.append(btn(tr('library.swap'), () => li.replaceChildren(picker(jobId, taskId, p, () => usedBox.v++)), 'btn btn-xs btn-quiet'));
    ul.append(li);
  }
  if (canSwap && picks.length < 3) {
    const li = h('li', {});
    li.append(btn(tr('library.addTo'), () => li.replaceChildren(picker(jobId, taskId, null, () => usedBox.v++)), 'btn btn-xs btn-quiet'));
    ul.append(li);
  }
  return ul;
}

/** The "Playbooks used" block of a job. */
export function usedView(jobId) {
  load(jobId);
  const e = entry(jobId);
  const s = S();
  const job = s.jobs.find((j) => j.id === jobId);
  const tasks = (job?.taskIds || []).map((id) => s.tasks[id]).filter(Boolean);
  const box = h('section', { class: 'lib-usedbox', 'aria-label': tr('library.used') }, h('h4', { text: tr('library.used') }));
  const replay = !!ui.replay;
  if (!tasks.length) {
    if (!e.preview.length) return null;
    box.append(h('p', { class: 'tiny muted', text: tr('library.planned') }), picksList(jobId, null, e.preview, !replay && ['awaiting_brief', 'refining', 'planning', 'queued'].includes(job?.status)));
    return box;
  }
  for (const t of tasks) {
    const picks = e.tasks.get(t.id);
    if (!picks) continue;
    box.append(h('div', { class: 'small lib-task' }, h('span', { class: `hchip ${t.status === 'done' ? 'hchip-ok' : ''}`, text: t.assignee }), ' ', h('span', { text: t.title })),
      picksList(jobId, t.id, picks, !replay && t.status === 'pending'));
  }
  return box.childElementCount > 1 ? box : null;
}

document.head.append(h('style', { text: `
.lib-usedbox { margin: 4px 12px 12px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 10px; }
.lib-usedbox h4 { margin: 4px 0 6px; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--text-2); }
.lib-task { margin-top: 6px; }
.lib-used { margin-bottom: 4px; }
.lib-used .linkish { background: none; border: 0; padding: 0; color: var(--honey-2); cursor: pointer; font: inherit; text-decoration: underline; }
.lib-picker { display: grid; gap: 6px; padding: 6px 0; }
.lib-pick { justify-content: flex-start; text-align: left; white-space: normal; height: auto; min-height: 26px; }
` }));
