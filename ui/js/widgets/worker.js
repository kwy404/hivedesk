// A worker's own window: avatar, status, current task, live model output, tool calls
// and a direct chat.

import { h, icon, clear, fmtDuration } from '../dom.js';
import { beeAvatar } from '../bees.js';
import { register } from '../wm.js';
import * as wm from '../wm.js';
import { S, rev, ui, worker, extra } from '../store.js';
import { provide } from '../menu.js';
import * as act from '../actions.js';
import { chatFeed } from './chat.js';
import { track, STATUS_LABEL, btn } from './util.js';
import { openHire } from './hire.js';

const feeds = new Map();

export function workerStatus(id) {
  const s = S();
  const w = worker(id);
  const st = s.workers[id] || { status: 'idle' };
  if (w.paused) return { key: 'queued', label: 'Paused' };
  let label = STATUS_LABEL[st.status] || st.status;
  if (st.status === 'queued') {
    const pos = (s.queue.waiting || []).findIndex((q) => q.workerId === id);
    if (pos > 0) label = `Waiting for its turn (${pos} ahead)`;
    else if (pos === 0) label = 'Next in line for the model';
  }
  if (st.status === 'tool' && st.detail) label = `Using ${st.detail}`;
  return { key: st.status || 'idle', label };
}

export function assignTask(id) {
  wm.open('worker', id);
  requestAnimationFrame(() => feeds.get(id)?.prefill('Task: '));
}

export function workerMenu(w) {
  if (!w) return null;
  const builtin = w.builtin || ['mel', 'dev', 'designer', 'qa', 'writer'].includes(w.id);
  return [
    { header: `${w.name} · ${w.role || 'worker'}` },
    { label: 'Chat', icon: 'chat', action: () => wm.open('worker', w.id) },
    { label: 'Assign task', icon: 'plan', disabled: !!ui.replay, action: () => assignTask(w.id) },
    { label: w.paused ? 'Resume' : 'Pause', icon: w.paused ? 'arrow' : 'stop', disabled: !!ui.replay, action: () => act.pauseWorker(w.id, !w.paused) },
    { label: 'Edit role', icon: 'writer', disabled: !!ui.replay, action: () => openHire(w) },
    { sep: true },
    { label: builtin ? 'Fire (builtin crew stays)' : `Fire ${w.name}`, icon: 'x', danger: true, disabled: builtin || !!ui.replay, action: () => confirmFire(w) },
  ];
}

export function confirmFire(w) {
  import('../notify.js').then(({ notify }) => notify({
    title: `Fire ${w.name}?`, body: 'Their chat history stays in the log. Tasks assigned to them go back to Mel.', tone: 'warn', icon: 'hire', sticky: true, key: `fire-${w.id}`,
    actions: [{ label: 'Fire', danger: true, run: () => act.fire(w.id) }, { label: 'Keep', run: () => {} }],
  }));
}

register('worker', {
  title: (id) => worker(id).name,
  glyph: (id) => beeAvatar(worker(id), 24, { ring: false }),
  size: [420, 600],
  min: [300, 300],
  cardH: 560,
  create(ctx, id) {
    const head = h('div', { class: 'wk-head' });
    const stream = h('div', { class: 'stream', hidden: true });
    const tools = h('div', { class: 'tools-l' });
    const feed = chatFeed(`dm:${id}`, { placeholder: `Message ${worker(id).name} directly`, emptyTitle: 'No direct messages', emptyText: 'Write here to steer this worker. During a job the message is added to its context for the next turn.' });
    feeds.set(id, feed);
    ctx.onDispose(() => feeds.delete(id));
    ctx.body.append(head, stream, tools, feed.root);
    provide(head, () => workerMenu(worker(id)));

    track(() => [rev.crew, rev.workers, rev.queue, rev.tasks, ui.replay], () => {
      const w = worker(id);
      const s = S();
      const st = workerStatus(id);
      const taskId = s.workers[id]?.taskId;
      const task = taskId && s.tasks[taskId];
      ctx.setTitle(w.name);
      ctx.setSub(st.label);
      ctx.setGlyph(beeAvatar(w, 24, { ring: false }));
      head.style.setProperty('--wc', w.color || '#FFB531');
      clear(head);
      head.append(beeAvatar(w, 48, { ring: true, status: w.paused ? 'queued' : st.key }),
        h('div', { class: 'grow' },
          h('div', { class: 'wk-name', text: w.name }),
          h('div', { class: 'wk-role ellipsis', text: w.role || '' }),
          h('div', { class: 'wk-stat' }, h('span', { class: `sdot sdot-${st.key}` }), h('span', { class: 'ellipsis', text: task && st.key !== 'idle' ? `${st.label} · ${task.title}` : st.label }))),
        h('button', { class: 'ibtn', type: 'button', 'aria-label': `${w.name} actions`, 'aria-haspopup': 'menu', on: { click: (e) => import('../menu.js').then((m) => { const r = e.currentTarget.getBoundingClientRect(); m.open({ x: r.left, y: r.bottom + 4, items: workerMenu(w) }); }) } },
          h('span', { html: '<svg class="ico" viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"/></svg>' })));
    });

    track(() => [rev.live, rev.workers], () => {
      const t = extra.turns[id];
      const st = S().workers[id]?.status;
      if (!t || ui.replay) { stream.hidden = true; return; }
      const active = !t.ended && ['thinking', 'tool'].includes(st);
      stream.hidden = !t.text && !active;
      if (stream.hidden) return;
      const pre = stream.querySelector('pre') || h('pre', { 'aria-live': 'off' });
      const label = active ? `Turn ${t.n || ''} · streaming from the model` : `Last turn${t.ms ? ` · ${fmtDuration(t.ms)}` : ''}${t.tps ? ` · ${t.tps.toFixed(1)} tokens/s` : ''}`;
      if (!stream.firstChild) stream.append(h('div', { class: 'stream-h' }, icon('model', 'ico-sm'), h('span', { class: 'grow lbl-t' }), h('span', { class: 'spin' })), pre);
      stream.querySelector('.lbl-t').textContent = label;
      stream.querySelector('.spin').hidden = !active;
      let txt = t.text.length > 4000 ? `...${t.text.slice(-4000)}` : t.text;
      if (!active) { try { txt = JSON.stringify(JSON.parse(t.text), null, 2); } catch {} }
      pre.textContent = txt;
      if (active && !t.text) pre.append(h('span', { class: 'faint', text: 'Waiting for the first words from the model ' }));
      if (active) pre.append(h('span', { class: 'caret' }));
      pre.scrollTop = pre.scrollHeight;
    });

    track(() => [rev.tools], () => {
      const list = (extra.tools[id] || []).slice(-3).reverse();
      clear(tools);
      for (const c of list) {
        const target = c.args?.path || c.args?.command || '';
        tools.append(h('div', { class: 'tool' },
          c.state === 'running' ? h('span', { class: 'spin' }) : icon(c.state === 'ok' ? 'check' : 'x', 'ico-sm'),
          h('span', { class: 'mono', text: c.tool }),
          h('span', { class: 'grow ellipsis muted', text: target }),
          c.args?.path ? btn('Open', () => openFile(c.args.path), 'btn btn-xs btn-quiet') : null));
      }
    });
  },
});

function openFile(path) {
  import('./files.js').then((m) => m.showFile(path));
}
