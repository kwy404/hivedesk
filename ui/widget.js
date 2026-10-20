// The mini widget: a 360 by 480 view that can live in its own window or in a
// picture-in-picture window. It opens its own WebSocket to this hivedesk (same token,
// same events) and rebuilds the state with the same store as the Hive.

import * as net from '/js/net.js';
import { S, rev, ui, worker, loadHello, applyEvent, applyLive, onEvent, currentJob, jobTasks } from '/js/store.js';
import { beeAvatar } from '/js/bees.js';
import { reducedMotion } from '/js/dom.js';
import { OfficeScene, doneCount } from '/office/scene.js';
import { t, init as initI18n, onLocale } from '/js/i18n.js';
import { mdLine } from '/js/md.js';

const V = window.V;
const $ = (sel) => document.querySelector(sel);
const el = {
  conn: $('.wg-conn'), demo: $('.wg-demo'), open: $('.wg-open'), stage: $('.wg-stage'), canvas: $('.wg-canvas'),
  req: $('.wg-req'), bar: $('.wg-bar'), fill: $('.wg-bar i'), sub: $('.wg-sub'), queue: $('.wg-queue'), chat: $('.wg-chat'),
  appr: $('.wg-appr'), approve: $('.wg-approve'), pause: $('.wg-pause'),
};

function node(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'text') n.textContent = v; else if (k === 'class') n.className = v; else n.setAttribute(k, v);
  }
  for (const c of kids) if (c != null && c !== false) n.append(c);
  return n;
}

const scene = new OfficeScene(el.canvas, { getState: S, mini: true, reduced: reducedMotion });
new ResizeObserver(() => scene.resize(el.stage.clientWidth, el.stage.clientHeight)).observe(el.stage);

// The strings live in i18n/<locale>.json: load them before the first paint.
try { await initI18n(document.documentElement.dataset.osLocale); } catch { /* the keys stay as they are */ }

const CONN = ['open', 'unauthorized', 'offline'];
function connPaint(c) {
  el.conn.dataset.s = c.state;
  el.conn.textContent = t(`office.widget.conn.${CONN.includes(c.state) ? c.state : 'connecting'}`);
}

/** Titles the HTML cannot translate by itself (data-tx and data-ta cover the rest). */
function paintStatic() {
  el.demo.title = t('office.widget.demoTitle');
  el.open.title = t('office.widget.open');
}
const SUB = ['refining', 'awaiting_brief', 'planning', 'done', 'failed'];

function paint() {
  const s = S();
  el.demo.hidden = !ui.demo;
  // job and progress
  const j = [...(s.jobs || [])].reverse().find((x) => ['refining', 'awaiting_brief', 'planning', 'running'].includes(x.status)) || currentJob(s);
  if (j) {
    const tasks = jobTasks(s, j);
    const done = tasks.filter((x) => x.status === 'done' || x.status === 'skipped').length;
    const running = tasks.filter((x) => x.status === 'running').length;
    const pct = j.status === 'done' ? 100 : tasks.length ? Math.round(((done + running * 0.4) / tasks.length) * 100) : 4;
    el.req.textContent = j.request;
    el.req.title = j.request;
    el.fill.style.width = `${pct}%`;
    el.bar.setAttribute('aria-valuenow', String(pct));
    el.sub.replaceChildren(
      node('span', { text: SUB.includes(j.status) ? t(`office.widget.sub.${j.status}`) : t('office.widget.progress', { done, total: tasks.length }) }),
      node('span', { class: 'wg-honey', text: t('office.widget.tasksDone', { count: doneCount(s) }) }));
  } else {
    el.req.textContent = ui.hello ? t('office.widget.napping') : t('office.widget.connecting');
    el.req.title = '';
    el.fill.style.width = '0%';
    el.sub.replaceChildren(node('span', { text: t('office.widget.nappingHint') }), node('span', { class: 'wg-honey', text: t('office.widget.tasksDone', { count: doneCount(s) }) }));
  }
  // the queue for the one shared model
  const run = s.queue.running || [];
  const wait = s.queue.waiting || [];
  const q = [node('span', { class: 'wg-k', text: t('office.widget.model') })];
  if (run.length) {
    for (const r of run) q.push(beeAvatar(worker(r.workerId), 26, { ring: true, status: 'thinking' }));
    q.push(node('span', { class: 'grow', text: `${worker(run[0].workerId).name}: ${mdLine(s.tasks[run[0].taskId]?.title || '', 80) || t('office.widget.thinking')}` }));
  } else q.push(node('span', { class: 'grow muted', text: t('office.widget.free') }));
  if (wait.length) {
    q.push(node('span', { class: 'wg-k', text: t('office.widget.queue') }));
    for (const w of wait.slice(0, 4)) q.push(beeAvatar(worker(w.workerId), 22, { ring: true }));
  }
  el.queue.replaceChildren(...q);
  // the latest line from a worker
  let last = null;
  for (const msgs of Object.values(s.chat || {})) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.from === 'user' || m.from === 'system') continue;
      if (!last || (m.seq || 0) > (last.seq || 0)) last = m;
      break;
    }
  }
  if (last) el.chat.replaceChildren(beeAvatar(worker(last.from), 26, { ring: true }), node('div', { class: 'txt' }, node('b', { text: worker(last.from).name }), mdLine(last.text, 200)));
  else el.chat.replaceChildren(node('span', { class: 'muted', text: t('office.widget.quiet') }));
  // approval: a tool call, or Mel's brief for a new job
  const a = (s.approvals || [])[0];
  const brief = !a && ((s.jobs || []).find((x) => x.status === 'awaiting_brief') || (scene.briefWait && (s.jobs || []).find((x) => x.id === scene.briefWait)));
  el.appr.hidden = !a && !brief;
  if (a) el.appr.replaceChildren(node('b', { text: `${t('office.widget.needsApproval', { name: worker(a.workerId).name })} ` }), mdLine(a.summary || a.args?.command || a.args?.path || a.tool, 160));
  else if (brief) el.appr.replaceChildren(node('b', { text: `${t('office.widget.briefBy')} ` }), t('office.widget.briefHint'));
  el.approve.disabled = (!a && !brief) || !!ui.replay;
  el.approve.textContent = (s.approvals || []).length > 1 ? t('office.widget.approveN', { count: s.approvals.length }) : t('office.widget.approve');
  // pause
  const crew = (s.crew || []).filter((w) => !w.paused);
  const allPaused = (s.crew || []).length > 0 && !crew.length;
  el.pause.textContent = allPaused ? t('office.widget.resume') : t('office.widget.pause');
  el.pause.setAttribute('aria-pressed', String(allPaused));
}

let queued = false;
function schedule() { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; paint(); }); } }

el.approve.addEventListener('click', async () => {
  const s = S();
  const a = (s.approvals || [])[0];
  const brief = !a && ((s.jobs || []).find((x) => x.status === 'awaiting_brief') || (scene.briefWait && (s.jobs || []).find((x) => x.id === scene.briefWait)));
  if (!a && !brief) return;
  el.approve.disabled = true;
  try {
    if (a) await net.command('approval.resolve', { approvalId: a.id, approved: true });
    else await net.command('brief.approve', { jobId: brief.id, use: 'refined' });
  } catch (err) { el.appr.hidden = false; el.appr.textContent = t('office.widget.approveFailed', { error: err.message }); }
  schedule();
});

el.pause.addEventListener('click', async () => {
  const s = S();
  const allPaused = (s.crew || []).length > 0 && s.crew.every((w) => w.paused);
  el.pause.disabled = true;
  try {
    for (const w of s.crew) if (!!w.paused === allPaused) await net.command('crew.update', { workerId: w.id, paused: !allPaused });
  } catch (err) { el.chat.textContent = t(allPaused ? 'office.widget.resumeFailed' : 'office.widget.pauseFailed', { error: err.message }); }
  el.pause.disabled = false;
  schedule();
});

el.open.addEventListener('click', () => {
  try { if (window.opener && !window.opener.closed) { window.opener.focus(); return; } } catch { /* other origin */ }
  window.open(net.withToken('/'), '_blank', 'noopener');
});

net.on('connection', connPaint);
net.on('hello', (f) => { loadHello(f); scene.reset(); schedule(); });
net.on('event', (f) => applyEvent(f.event));
net.on('live', (f) => applyLive(f));
onEvent((ev) => { scene.handle(ev); if (/^brief\./.test(ev.type)) schedule(); });
V.effect(() => { void [rev.jobs, rev.tasks, rev.queue, rev.chat, rev.approvals, rev.crew, rev.workers, ui.demo, ui.hello]; schedule(); });

document.addEventListener('visibilitychange', () => { if (document.hidden) scene.stop(); else scene.start(); });

onLocale(() => { paintStatic(); connPaint(net.connection); schedule(); });
paintStatic();
connPaint(net.connection);
scene.resize(el.stage.clientWidth, el.stage.clientHeight);
scene.start();
net.connect();
