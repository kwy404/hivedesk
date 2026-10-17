// Timeline: every job with its task graph (dependency order), status and assignee.

import { h, icon, clear, fmtDuration, ago } from '../dom.js';
import { beeAvatar } from '../bees.js';
import { register } from '../wm.js';
import { S, rev, ui, jobTasks, worker, extra } from '../store.js';
import { brainInfo } from '../brainstate.js';
import { provide } from '../menu.js';
import * as act from '../actions.js';
import { t } from '../i18n.js';
import { setTip } from '../tooltip.js';
import { track, stateBox, btn, TASK_LABEL, TASK_CHIP } from './util.js';
import * as wm from '../wm.js';

/** Chip class per job status; the label is timeline.job.<status>. */
const JOB_CHIP = { planning: 'hchip-honey', running: 'hchip-honey', done: 'hchip-ok', failed: 'hchip-bad', cancelled: '' };

const taskIcon = { done: 'check', failed: 'x', running: 'arrow', blocked: 'lock', review: 'qa' };

export function taskMenu(task) {
  const s = S();
  const others = s.crew.filter((w) => w.id !== task.assignee);
  const live = !['done', 'skipped', 'cancelled'].includes(task.status);
  return [
    { header: task.title.length > 34 ? `${task.title.slice(0, 32)}...` : task.title },
    { label: t('timeline.menu.retry'), icon: 'replay', disabled: !['failed', 'blocked', 'done'].includes(task.status), action: () => act.retryTask(task.id) },
    { label: t('timeline.menu.reassign'), icon: 'hire', disabled: !live || !others.length, items: () => others.map((w) => ({ label: w.name, iconEl: beeAvatar(w, 18, { ring: false }), action: () => act.reassignTask(task.id, w.id) })) },
    { label: t('timeline.menu.openWorker', { name: worker(task.assignee).name }), icon: 'chat', action: () => wm.open('worker', task.assignee) },
    { sep: true },
    { label: t('timeline.menu.cancelTask'), icon: 'stop', danger: true, disabled: !live, action: () => act.cancelTask(task.id) },
  ];
}

function qaNote(qa) {
  if (!qa) return null;
  return qa.passed ? t('timeline.task.qaPassed') : t('timeline.task.qaFound', { count: qa.issues?.length || 0 });
}

function taskRow(task, i, tasks) {
  const w = worker(task.assignee);
  const dur = task.startedAt ? fmtDuration((task.finishedAt ? Date.parse(task.finishedAt) : Date.now()) - Date.parse(task.startedAt)) : '';
  const qa = extra.qa[task.id];
  const prevDeps = task.dependsOn?.length && i > 0;
  const status = TASK_LABEL[task.status] || task.status;
  const row = h('div', { class: `task${prevDeps ? ' dep' : ''}`, tabindex: '0', role: 'listitem', tip: 'tip.timeline.task', kb: 'Enter', dataset: { s: task.status, task: task.id }, style: `--depth:${Math.min(task.depth || 0, 2)}`, 'aria-label': t('timeline.task.aria', { title: task.title, status, name: w.name }) },
    h('div', { class: 'task-hex' }, taskIcon[task.status] ? icon(taskIcon[task.status]) : null),
    h('div', { class: 'task-t' },
      h('div', { class: 'ellipsis', text: task.title }),
      h('div', { class: 'task-n ellipsis' },
        [task.kind && !['build', 'qa'].includes(task.kind) ? task.kind.toUpperCase() : null, task.attempts > 1 ? t('timeline.task.attempt', { count: task.attempts }) : null, dur || null, task.note || qaNote(qa)].filter(Boolean).join(' · ') || (task.dependsOn?.length ? t('timeline.task.after', { count: task.dependsOn.length }) : TASK_LABEL[task.status]))),
    h('div', { class: 'task-r' },
      task.status !== 'pending' && task.status !== 'ready' ? h('span', { class: `hchip ${TASK_CHIP[task.status] || ''}`, text: status }) : null,
      beeAvatar(w, 20, { ring: true })));
  row.__task = task;
  void tasks;
  return row;
}

function jobCard(j, isCur) {
  const s = S();
  const tasks = jobTasks(s, j);
  const done = tasks.filter((x) => x.status === 'done').length;
  const chipCls = JOB_CHIP[j.status] ?? '';
  const chipLabel = j.status in JOB_CHIP ? t(`timeline.job.${j.status}`) : j.status;
  const pb = j.playbookId && s.playbooks.find((p) => p.id === j.playbookId);
  const card = h('article', { class: `job${isCur ? ' cur' : ''}`, 'aria-label': j.request },
    h('div', { class: 'job-h' },
      h('div', { class: 'grow' },
        h('div', { class: 'job-q', text: j.request }),
        h('div', { class: 'job-m' },
          h('span', { class: `hchip ${chipCls}`, text: chipLabel }),
          tasks.length ? h('span', { text: t('timeline.job.progress', { done, count: tasks.length }) }) : null,
          h('span', { text: ago(j.createdAt) }),
          j.approval === false ? h('span', { class: 'hchip hchip-warn', text: t('timeline.job.noApprovals') }) : null,
          pb ? h('span', { class: 'hchip hchip-info', style: 'max-width:100%', 'data-tip-title': t('timeline.job.playbookReused', { title: pb.title }) }, icon('playbook', 'ico-sm'), h('span', { class: 'ellipsis', text: pb.title })) : null)),
      ['planning', 'running'].includes(j.status) && !ui.replay ? setTip(btn(t('timeline.job.cancel'), () => act.cancelJob(j.id), 'btn btn-xs btn-quiet', 'stop'), { key: 'tip.timeline.cancelJob' }) : null));
  if (j.status === 'planning' && !tasks.length) {
    card.append(h('div', { class: 'tasks' }, h('div', { class: 'task', dataset: { s: 'running' } },
      h('div', { class: 'task-hex' }, icon('plan')), h('div', { class: 'task-t' }, h('div', { class: 'ellipsis', text: t('timeline.planning.title') }), h('div', { class: 'task-n', text: t('timeline.planning.text') })),
      h('div', { class: 'task-r' }, beeAvatar(worker('mel'), 20)))));
  }
  if (tasks.length) card.append(h('div', { class: 'tasks', role: 'list' }, tasks.map((x, i) => taskRow(x, i, tasks))));
  if (j.status === 'done' && j.summary) card.append(h('div', { class: 'small muted', style: 'padding:0 12px 11px', text: j.summary }));
  if (j.status === 'failed' && j.error) card.append(h('div', { class: 'honest bad', style: 'margin:0 12px 12px' }, icon('x'), h('div', { text: typeof j.error === 'string' ? j.error : j.error.message || t('timeline.job.failedText') })));
  return card;
}

register('timeline', {
  title: () => t('timeline.title'),
  glyph: () => icon('plan'),
  size: [440, 560],
  min: [300, 220],
  cardH: 460,
  create(ctx) {
    const pane = h('div', { class: 'pane', role: 'region', ta: 'timeline.aria' });
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
      ctx.setSub(running ? t('timeline.sub.working') : jobs.length ? t('timeline.sub.jobs', { count: jobs.length }) : '');
      if (!jobs.length) {
        const b = brainInfo();
        if (b.key === 'none' || b.key === 'needs_download' || b.key === 'error' || b.key === 'runtime-failed') {
          pane.append(stateBox({ img: '/assets/mascot-dark.svg', title: b.label, text: t('timeline.empty.brainText', { detail: b.detail }), actions: [setTip(btn(t('timeline.empty.openSettings'), () => wm.open('settings'), 'btn btn-sm btn-primary', 'model'), { key: 'tip.timeline.openSettings' })] }));
        } else if (b.key === 'loading' || b.key === 'downloading' || b.key === 'runtime') {
          pane.append(stateBox({ img: '/assets/mascot-dark.svg', title: b.label, text: b.detail }));
        } else {
          pane.append(stateBox({ img: '/assets/mascot-dark.svg', title: t('timeline.empty.title'), text: t('timeline.empty.text'), actions: [setTip(btn(t('timeline.empty.write'), () => document.querySelector('#ask')?.focus(), 'btn btn-sm btn-primary', 'plan'), { key: 'tip.timeline.writeRequest', kb: '/' })] }));
        }
        return;
      }
      for (const j of jobs) pane.append(jobCard(j, j === running));
      pane.scrollTop = top;
      void tick;
    }
  },
});
