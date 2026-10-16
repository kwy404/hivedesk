// Timeline: every job with its task graph (dependency order), status and assignee.

import { h, icon, clear, fmtDuration, ago } from '../dom.js';
import { beeAvatar } from '../bees.js';
import { register } from '../wm.js';
import { S, rev, ui, jobTasks, worker, extra } from '../store.js';
import { brainInfo } from '../brainstate.js';
import { provide } from '../menu.js';
import * as act from '../actions.js';
import { track, stateBox, btn, TASK_LABEL, TASK_CHIP } from './util.js';
import * as wm from '../wm.js';

const JOB_CHIP = { planning: ['hchip-honey', 'Planning'], running: ['hchip-honey', 'Running'], done: ['hchip-ok', 'Done'], failed: ['hchip-bad', 'Failed'], cancelled: ['', 'Cancelled'] };

const taskIcon = { done: 'check', failed: 'x', running: 'arrow', blocked: 'lock', review: 'qa' };

export function taskMenu(t) {
  const s = S();
  const others = s.crew.filter((w) => w.id !== t.assignee);
  const live = !['done', 'skipped', 'cancelled'].includes(t.status);
  return [
    { header: t.title.length > 34 ? `${t.title.slice(0, 32)}...` : t.title },
    { label: 'Retry', icon: 'replay', disabled: !['failed', 'blocked', 'done'].includes(t.status), action: () => act.retryTask(t.id) },
    { label: 'Reassign', icon: 'hire', disabled: !live || !others.length, items: () => others.map((w) => ({ label: w.name, iconEl: beeAvatar(w, 18, { ring: false }), action: () => act.reassignTask(t.id, w.id) })) },
    { label: `Open ${worker(t.assignee).name}`, icon: 'chat', action: () => wm.open('worker', t.assignee) },
    { sep: true },
    { label: 'Cancel task', icon: 'stop', danger: true, disabled: !live, action: () => act.cancelTask(t.id) },
  ];
}

function taskRow(t, i, tasks) {
  const w = worker(t.assignee);
  const dur = t.startedAt ? fmtDuration((t.finishedAt ? Date.parse(t.finishedAt) : Date.now()) - Date.parse(t.startedAt)) : '';
  const qa = extra.qa[t.id];
  const prevDeps = t.dependsOn?.length && i > 0;
  const row = h('div', { class: `task${prevDeps ? ' dep' : ''}`, tabindex: '0', role: 'listitem', dataset: { s: t.status, task: t.id }, style: `--depth:${Math.min(t.depth || 0, 2)}`, 'aria-label': `${t.title}, ${TASK_LABEL[t.status] || t.status}, ${w.name}` },
    h('div', { class: 'task-hex' }, taskIcon[t.status] ? icon(taskIcon[t.status]) : null),
    h('div', { class: 'task-t' },
      h('div', { class: 'ellipsis', text: t.title }),
      h('div', { class: 'task-n ellipsis' },
        [t.kind && !['build', 'qa'].includes(t.kind) ? t.kind.toUpperCase() : null, t.attempts > 1 ? `attempt ${t.attempts}` : null, dur || null, t.note || (qa ? (qa.passed ? 'QA passed' : `QA found ${qa.issues?.length || 0} issue${qa.issues?.length === 1 ? '' : 's'}`) : null)].filter(Boolean).join(' · ') || (t.dependsOn?.length ? `after ${t.dependsOn.length} task${t.dependsOn.length > 1 ? 's' : ''}` : TASK_LABEL[t.status]))),
    h('div', { class: 'task-r' },
      t.status !== 'pending' && t.status !== 'ready' ? h('span', { class: `hchip ${TASK_CHIP[t.status] || ''}`, text: TASK_LABEL[t.status] || t.status }) : null,
      beeAvatar(w, 20, { ring: true })));
  row.__task = t;
  void tasks;
  return row;
}

function jobCard(j, isCur) {
  const s = S();
  const tasks = jobTasks(s, j);
  const done = tasks.filter((t) => t.status === 'done').length;
  const [chipCls, chipLabel] = JOB_CHIP[j.status] || ['', j.status];
  const pb = j.playbookId && s.playbooks.find((p) => p.id === j.playbookId);
  const card = h('article', { class: `job${isCur ? ' cur' : ''}`, 'aria-label': j.request },
    h('div', { class: 'job-h' },
      h('div', { class: 'grow' },
        h('div', { class: 'job-q', text: j.request }),
        h('div', { class: 'job-m' },
          h('span', { class: `hchip ${chipCls}`, text: chipLabel }),
          tasks.length ? h('span', { text: `${done} of ${tasks.length} tasks` }) : null,
          h('span', { text: ago(j.createdAt) }),
          j.approval === false ? h('span', { class: 'hchip hchip-warn', text: 'No approvals' }) : null,
          pb ? h('span', { class: 'hchip hchip-info', style: 'max-width:100%', title: `Plan reused from the playbook: ${pb.title}` }, icon('playbook', 'ico-sm'), h('span', { class: 'ellipsis', text: pb.title })) : null)),
      ['planning', 'running'].includes(j.status) && !ui.replay ? btn('Cancel', () => act.cancelJob(j.id), 'btn btn-xs btn-quiet', 'stop') : null));
  if (j.status === 'planning' && !tasks.length) {
    card.append(h('div', { class: 'tasks' }, h('div', { class: 'task', dataset: { s: 'running' } },
      h('div', { class: 'task-hex' }, icon('plan')), h('div', { class: 'task-t' }, h('div', { class: 'ellipsis', text: 'Mel is planning the tasks' }), h('div', { class: 'task-n', text: 'Turning your request into a task graph' })),
      h('div', { class: 'task-r' }, beeAvatar(worker('mel'), 20)))));
  }
  if (tasks.length) card.append(h('div', { class: 'tasks', role: 'list' }, tasks.map((t, i) => taskRow(t, i, tasks))));
  if (j.status === 'done' && j.summary) card.append(h('div', { class: 'small muted', style: 'padding:0 12px 11px', text: j.summary }));
  if (j.status === 'failed' && j.error) card.append(h('div', { class: 'honest bad', style: 'margin:0 12px 12px' }, icon('x'), h('div', { text: typeof j.error === 'string' ? j.error : j.error.message || 'The job failed.' })));
  return card;
}

register('timeline', {
  title: 'Timeline',
  glyph: () => icon('plan'),
  size: [440, 560],
  min: [300, 220],
  cardH: 460,
  create(ctx) {
    const pane = h('div', { class: 'pane', role: 'region', 'aria-label': 'Jobs and tasks' });
    ctx.body.append(pane);
    provide(pane, (target) => {
      const row = target.closest?.('.task');
      if (row?.__task) return taskMenu(row.__task);
      return null;
    });
    pane.addEventListener('click', (e) => {
      const row = e.target.closest('.task');
      if (row?.__task) wm.open('worker', row.__task.assignee);
    });
    pane.addEventListener('keydown', (e) => {
      const row = e.target.closest('.task');
      if (row?.__task && e.key === 'Enter') wm.open('worker', row.__task.assignee);
    });
    let tick = 0;
    const timer = setInterval(() => { tick++; if (S().jobs.some((j) => j.status === 'running')) rerender(); }, 5000);
    ctx.onDispose(() => clearInterval(timer));
    let rerender = () => {};
    track(() => [rev.jobs, rev.tasks, rev.crew, rev.brain, rev.playbooks, ui.connection, ui.hello, ui.replay], () => {
      rerender = render;
      render();
    });
    function render() {
      const s = S();
      const top = pane.scrollTop;
      clear(pane);
      const jobs = s.jobs.slice().reverse();
      const running = jobs.find((j) => ['planning', 'running'].includes(j.status));
      ctx.setSub(running ? 'working' : jobs.length ? `${jobs.length} job${jobs.length > 1 ? 's' : ''}` : '');
      if (!jobs.length) {
        const b = brainInfo();
        if (b.key === 'none' || b.key === 'needs_download' || b.key === 'error' || b.key === 'runtime-failed') {
          pane.append(stateBox({ img: '/assets/mascot-dark.svg', title: b.label, text: `${b.detail} Ollama, LM Studio or an endpoint with a key also work.`, actions: [btn('Open Settings', () => wm.open('settings'), 'btn btn-sm btn-primary', 'model')] }));
        } else if (b.key === 'loading' || b.key === 'downloading' || b.key === 'runtime') {
          pane.append(stateBox({ img: '/assets/mascot-dark.svg', title: b.label, text: b.detail }));
        } else {
          pane.append(stateBox({ img: '/assets/mascot-dark.svg', title: 'Nothing planned yet', text: 'Type a request in the bar above. Mel turns it into tasks for the crew, and every step shows up here.', actions: [btn('Write a request', () => document.querySelector('#ask')?.focus(), 'btn btn-sm btn-primary', 'plan')] }));
        }
        return;
      }
      for (const j of jobs) pane.append(jobCard(j, j === running));
      pane.scrollTop = top;
      void tick;
    }
  },
});
