// Brief and Report: Mel's improved brief before the crew starts (original next to improved, with Edit,
// Use this and Use mine), and the end of job report with the improved prompt and next prompts.
// It keeps its own small state from the engine events, so it does not depend on the store reducer.

import { h, icon, clear, copyText, fmtDuration } from '../dom.js';
import { register, open } from '../wm.js';
import { S, ui, onEvent, worker } from '../store.js';
import { beeAvatar } from '../bees.js';
import { command } from '../net.js';
import { notify } from '../notify.js';
import { t, tmap } from '../i18n.js';
import { setTip } from '../tooltip.js';
import { track, stateBox, btn } from './util.js';
import { usedView, usedBox } from './library-used.js';

const V = window.V;
const box = V.reactive({ v: 0 });
/** jobId -> { request, proposed, approved, report } */
const jobs = new Map();
/** How the approved brief was chosen: refined, edited, original (translated at read time). */
const USED = tmap('brief.used');

function entry(jobId) {
  if (!jobs.has(jobId)) {
    const j = S().jobs.find((x) => x.id === jobId);
    jobs.set(jobId, { request: j?.request || '', proposed: j?.briefProposed || null, approved: j?.brief || null, report: j?.report || null, status: j?.status });
  }
  return jobs.get(jobId);
}

function latest() {
  const all = S().jobs;
  for (let i = all.length - 1; i >= 0; i--) {
    const e = entry(all[i].id);
    e.status = all[i].status;
    if (e.proposed || e.report) return { id: all[i].id, ...e };
  }
  return null;
}

onEvent((ev) => {
  const d = ev.data || {};
  if (ev.type === 'brief.proposed') {
    const e = entry(ev.jobId);
    Object.assign(e, { request: d.original, proposed: d.brief, approved: null });
    box.v++;
    open('brief');
    notify({ title: t('brief.notify.title'), body: t('brief.notify.body'), tone: 'info', icon: 'plan', key: `brief-${ev.jobId}`, actions: [{ label: t('brief.notify.review'), primary: true, run: () => open('brief') }] });
  } else if (ev.type === 'brief.approved') {
    entry(ev.jobId).approved = { text: d.text, source: d.source };
    box.v++;
  } else if (ev.type === 'job.report') {
    entry(ev.jobId).report = { ...d.report, improvedPrompt: d.improvedPrompt, nextPrompts: d.nextPrompts };
    box.v++;
    open('brief');
  } else if (ev.type === 'job.created' || ev.type === 'job.done' || ev.type === 'job.failed') {
    box.v++;
  }
});

async function send(type, data, fail) {
  try { return await command(type, data); } catch (err) {
    notify({ title: fail, body: err.message, tone: 'bad', sound: 'error' });
    return null;
  }
}

function copyBtn(text, label, tip) {
  return setTip(btn(t('brief.copy'), () => copyText(text).then(() => notify({ title: label, tone: 'ok', timeout: 1600 }), () => notify({ title: t('brief.copyFailed'), tone: 'bad' })), 'btn btn-xs btn-quiet', 'copy'), { key: tip });
}

function newJob(request) {
  const ask = document.querySelector('#ask');
  if (ask) { ask.value = request; ask.focus(); return; }
  send('job.create', { request }, t('brief.error.job'));
}

function briefView(id, e) {
  const p = e.proposed;
  const waiting = !e.approved && e.status === 'awaiting_brief';
  const area = h('textarea', { class: 'brief-edit', rows: 14, 'aria-label': t('brief.editTitle') });
  area.value = p.text;
  const original = h('section', { class: 'brief-col' }, h('h4', { text: t('brief.request'), tip: 'tip.brief.head.request' }), h('p', { class: 'brief-orig', text: e.request }));
  const improved = h('section', { class: 'brief-col' }, h('h4', { tip: 'tip.brief.head.improved' }, t('brief.improved'), ' ', h('span', { class: 'hchip hchip-honey', text: t('brief.byMel') })), h('pre', { class: 'brief-text', text: p.text }));
  const editing = h('section', { class: 'brief-col brief-editing', hidden: true }, h('h4', { text: t('brief.editTitle'), tip: 'tip.brief.head.editing' }), area);
  const busy = (b) => { for (const x of actions.querySelectorAll('button')) x.disabled = b || !!ui.replay; };
  const approve = async (use) => {
    busy(true);
    const r = await send('brief.approve', { jobId: id, use, ...(use === 'edited' ? { text: area.value } : {}) }, t('brief.error.approve'));
    if (!r) busy(false);
  };
  const actions = h('div', { class: 'appr-a' });
  if (waiting) {
    actions.append(
      setTip(btn(t('brief.edit'), () => { editing.hidden = !editing.hidden; improved.hidden = !editing.hidden; if (!editing.hidden) area.focus(); }, 'btn btn-sm btn-quiet', 'code'), { key: 'tip.brief.edit' }),
      setTip(btn(t('brief.useMine'), () => approve('original'), 'btn btn-sm btn-quiet'), { key: 'tip.brief.useMine' }),
      setTip(btn(t('brief.useThis'), () => approve(editing.hidden ? 'refined' : 'edited'), 'btn btn-sm btn-ok', 'check'), { key: 'tip.brief.useThis' }));
  } else if (e.approved) {
    const used = USED[e.approved.source] || '';
    actions.append(h('span', { class: 'small muted grow', text: used }), copyBtn(e.approved.text, t('brief.copied'), 'tip.brief.copyBrief'));
  }
  busy(false);
  return h('article', { class: 'appr brief' },
    h('div', { class: 'appr-h' }, beeAvatar(worker('mel'), 30), h('div', { class: 'grow' }, h('div', { class: 'appr-t', text: waiting ? t('brief.check.title') : t('brief.heading') }), h('div', { class: 'small muted', text: waiting ? t('brief.check.sub') : '' }))),
    h('div', { class: 'brief-grid', 'data-tour': 'refiner' }, original, improved, editing),
    actions);
}

function reportView(id, r) {
  const files = h('ul', { class: 'rep-list' }, ...(r.files.length ? r.files.map((f) => h('li', {}, h('span', { class: 'mono', text: f.path }), ' ', h('span', { class: 'tiny faint', text: f.added || f.removed ? t('brief.report.fileStat', { op: f.op, added: f.added, removed: f.removed }) : f.op }))) : [h('li', { class: 'muted', text: t('brief.report.noFiles') })]));
  const checks = h('ul', { class: 'rep-list' }, ...(r.checks.length ? r.checks.map((c) => h('li', {}, h('span', { class: `hchip ${c.ok ? 'hchip-ok' : 'hchip-bad'}`, text: c.ok ? t('brief.report.checkOk') : t('brief.report.checkFailed') }), ' ', h('span', { class: 'mono small', text: c.name }), ' ', h('span', { class: 'tiny faint', text: c.detail || '' }))) : [h('li', { class: 'muted', text: t('brief.report.noChecks') })]));
  const missing = r.missing.length ? h('ul', { class: 'rep-list' }, ...r.missing.map((m) => h('li', { text: m }))) : h('p', { class: 'small muted', text: t('brief.report.noMissing') });
  const save = setTip(btn(t('brief.report.save'), async () => { const x = await send('playbook.save', { jobId: id }, t('brief.error.playbook')); if (x) notify({ title: t('brief.report.saved'), tone: 'ok', timeout: 1800 }); }, 'btn btn-xs btn-quiet', 'playbook'), { key: 'tip.brief.save' });
  if (ui.replay) save.disabled = true;
  return h('article', { class: 'appr report' },
    h('div', { class: 'appr-h' }, beeAvatar(worker('mel'), 30), h('div', { class: 'grow' }, h('div', { class: 'appr-t', text: t('brief.report.title') }), h('div', { class: 'small muted', text: t('brief.report.stats', { turns: r.turns, duration: fmtDuration(r.seconds * 1000) }) }))),
    h('div', { class: 'rep-body' },
      h('h4', { text: t('brief.report.built'), tip: 'tip.brief.head.built' }), h('p', { class: 'small', text: r.built }),
      h('h4', { text: t('brief.report.files'), tip: 'tip.brief.head.files' }), files,
      h('h4', { text: t('brief.report.checks'), tip: 'tip.brief.head.checks' }), checks,
      h('h4', { text: t('brief.report.missing'), tip: 'tip.brief.head.missing' }), missing,
      h('div', { class: 'rep-prompt' },
        h('div', { class: 'row' }, h('h4', { class: 'grow', text: t('brief.report.prompt'), tip: 'tip.brief.head.prompt' }), copyBtn(r.improvedPrompt, t('brief.report.promptCopied'), 'tip.brief.copyPrompt'), save),
        h('p', { class: 'small muted', text: t('brief.report.promptHelp') }),
        h('pre', { class: 'brief-text', text: r.improvedPrompt })),
      h('h4', { text: t('brief.report.next'), tip: 'tip.brief.head.next' }),
      h('div', { class: 'rep-next' }, ...(r.nextPrompts || []).map((p) => h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn btn-xs btn-quiet grow rep-next-b', text: p, tip: 'tip.brief.next', on: { click: () => newJob(p) }, disabled: !!ui.replay }),
        copyBtn(p, t('brief.report.nextCopied'), 'tip.brief.copyNext'))))));
}

register('brief', {
  title: () => t('brief.title'),
  glyph: () => icon('plan'),
  size: [620, 620],
  min: [320, 260],
  cardH: 560,
  create(ctx) {
    const pane = h('div', { class: 'pane pane-pad' });
    ctx.body.append(pane);
    track(() => [box.v, usedBox.v, ui.replay, S().jobs.length], () => {
      clear(pane);
      const j = latest();
      if (!j) {
        pane.append(stateBox({ icon: 'plan', title: t('brief.empty.title'), text: t('brief.empty.text') }));
        ctx.setSub('');
        return;
      }
      ctx.setSub(j.request.slice(0, 60));
      if (j.proposed) pane.append(briefView(j.id, j));
      const used = usedView(j.id);
      if (used) pane.append(used);
      if (j.report) pane.append(reportView(j.id, j.report));
    });
  },
});

// Styles live here so this window does not touch the shared stylesheet.
const css = `
.brief-grid { display: grid; grid-template-columns: 1fr 1.4fr; gap: 12px; padding: 0 12px 10px; }
.brief-grid h4, .rep-body h4 { margin: 10px 0 6px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: var(--muted-t); }
.brief-orig { margin: 0; padding: 10px; border: 1px dashed var(--line-2); border-radius: 6px; color: var(--text-2); }
.brief-text { margin: 0; padding: 10px; white-space: pre-wrap; word-break: break-word; font: 12.5px/1.5 var(--font-mono); background: var(--bg-2); border: 1px solid var(--line); border-radius: 6px; max-height: 340px; overflow: auto; }
.brief-editing { grid-column: 2; }
.brief-edit { width: 100%; box-sizing: border-box; font: 12.5px/1.5 var(--font-mono); color: var(--text); background: var(--bg-2); border: 1px solid var(--accent-line); border-radius: 6px; padding: 10px; resize: vertical; }
.rep-body { padding: 0 12px 12px; }
.rep-list { margin: 0; padding-left: 18px; display: grid; gap: 4px; font-size: 13px; }
.rep-prompt { margin-top: 12px; padding: 10px; border: 1px solid var(--line-2); border-radius: 6px; background: var(--panel-2); box-shadow: inset 2px 0 0 var(--honey); }
.rep-next { display: grid; gap: 6px; }
.rep-next-b { justify-content: flex-start; text-align: left; white-space: normal; height: auto; min-height: 28px; }
@media (max-width: 560px) { .brief-grid { grid-template-columns: 1fr; } .brief-editing { grid-column: 1; } }
`;
document.head.append(h('style', { text: css }));
