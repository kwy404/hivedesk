// The mini widget: a 360 by 480 view that can live in its own window or in a
// picture-in-picture window. It opens its own WebSocket to this hivedesk (same token,
// same events) and rebuilds the state with the same store as the Hive.

import * as net from '/js/net.js';
import { S, rev, ui, worker, loadHello, applyEvent, applyLive, onEvent, currentJob, jobTasks } from '/js/store.js';
import { beeAvatar } from '/js/bees.js';
import { reducedMotion } from '/js/dom.js';
import { OfficeScene, doneCount } from '/office/scene.js';

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

function connPaint(c) {
  el.conn.dataset.s = c.state;
  el.conn.textContent = c.state === 'open' ? 'live' : c.state === 'unauthorized' ? 'needs the secret link' : c.state === 'offline' ? 'offline' : 'connecting';
}

function paint() {
  const s = S();
  el.demo.hidden = !ui.demo;
  // job and progress
  const j = [...(s.jobs || [])].reverse().find((x) => ['refining', 'awaiting_brief', 'planning', 'running'].includes(x.status)) || currentJob(s);
  if (j) {
    const tasks = jobTasks(s, j);
    const done = tasks.filter((t) => t.status === 'done' || t.status === 'skipped').length;
    const running = tasks.filter((t) => t.status === 'running').length;
    const pct = j.status === 'done' ? 100 : tasks.length ? Math.round(((done + running * 0.4) / tasks.length) * 100) : 4;
    el.req.textContent = j.request;
    el.req.title = j.request;
    el.fill.style.width = `${pct}%`;
    el.bar.setAttribute('aria-valuenow', String(pct));
    el.sub.replaceChildren(
      node('span', { text: j.status === 'refining' ? 'Mel writes the brief' : j.status === 'awaiting_brief' ? 'Waiting for your brief check' : j.status === 'planning' ? 'Mel is planning' : j.status === 'done' ? 'Job done' : j.status === 'failed' ? 'Job failed' : `${done} of ${tasks.length} tasks` }),
      node('span', { class: 'wg-honey', text: `${doneCount(s)} honey` }));
  } else {
    el.req.textContent = ui.hello ? 'The crew is napping' : 'Connecting...';
    el.fill.style.width = '0%';
    el.sub.replaceChildren(node('span', { text: 'Start a job in the Hive and watch them wake up.' }), node('span', { class: 'wg-honey', text: `${doneCount(s)} honey` }));
  }
  // the queue for the one shared model
  const run = s.queue.running || [];
  const wait = s.queue.waiting || [];
  const q = [node('span', { class: 'wg-k', text: 'Model' })];
  if (run.length) {
    for (const r of run) q.push(beeAvatar(worker(r.workerId), 26, { ring: true, status: 'thinking' }));
    q.push(node('span', { class: 'grow', text: `${worker(run[0].workerId).name}: ${s.tasks[run[0].taskId]?.title || 'thinking'}` }));
  } else q.push(node('span', { class: 'grow muted', text: 'free' }));
  if (wait.length) {
    q.push(node('span', { class: 'wg-k', text: 'Queue' }));
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
  if (last) el.chat.replaceChildren(beeAvatar(worker(last.from), 26, { ring: true }), node('div', { class: 'txt' }, node('b', { text: worker(last.from).name }), String(last.text || '').replace(/\s+/g, ' ')));
  else el.chat.replaceChildren(node('span', { class: 'muted', text: 'All quiet. The first chat line shows up here.' }));
  // approval: a tool call, or Mel's brief for a new job
  const a = (s.approvals || [])[0];
  const brief = !a && ((s.jobs || []).find((x) => x.status === 'awaiting_brief') || (scene.briefWait && (s.jobs || []).find((x) => x.id === scene.briefWait)));
  el.appr.hidden = !a && !brief;
  if (a) el.appr.replaceChildren(node('b', { text: `${worker(a.workerId).name} needs your approval: ` }), String(a.summary || a.args?.command || a.args?.path || a.tool));
  else if (brief) el.appr.replaceChildren(node('b', { text: 'Mel wrote a brief: ' }), 'Approve uses it as written. Open the Hive to edit it.');
  el.approve.disabled = (!a && !brief) || !!ui.replay;
  el.approve.textContent = (s.approvals || []).length > 1 ? `Approve (${s.approvals.length})` : 'Approve';
  // pause
  const crew = (s.crew || []).filter((w) => !w.paused);
  const allPaused = (s.crew || []).length > 0 && !crew.length;
  el.pause.textContent = allPaused ? 'Resume crew' : 'Pause crew';
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
  } catch (err) { el.appr.hidden = false; el.appr.textContent = `Could not approve: ${err.message}`; }
  schedule();
});

el.pause.addEventListener('click', async () => {
  const s = S();
  const allPaused = (s.crew || []).length > 0 && s.crew.every((w) => w.paused);
  el.pause.disabled = true;
  try {
    for (const w of s.crew) if (!!w.paused === allPaused) await net.command('crew.update', { workerId: w.id, paused: !allPaused });
  } catch (err) { el.chat.textContent = `Could not ${allPaused ? 'resume' : 'pause'}: ${err.message}`; }
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

try { const i18n = await import('/js/i18n.js'); await i18n.init(); } catch { /* English fallbacks are fine here */ }
connPaint(net.connection);
scene.resize(el.stage.clientWidth, el.stage.clientHeight);
scene.start();
net.connect();
