// Top bar: brand, the request box, the task timeline strip and the model status.

import { h, icon, clear } from './dom.js';
import { beeAvatar } from './bees.js';
import { S, rev, ui, extra, worker, currentJob, jobTasks, exitReplay } from './store.js';
import { brainInfo } from './brainstate.js';
import * as act from './actions.js';
import * as wm from './wm.js';
import { historyView } from './notify.js';
import { isMuted, setMuted, preview } from './sound.js';
import { openPalette } from './palette.js';
import { track } from './widgets/util.js';
import { TASK_LABEL } from './widgets/util.js';

const V = window.V;

export const LOGO = '<svg viewBox="0 0 32 32" class="brand-mark" aria-hidden="true"><defs><linearGradient id="lg-h" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFD072"/><stop offset="1" stop-color="#F29A1F"/></linearGradient><clipPath id="lg-c"><path d="M16 2.2 28 9.1v13.8L16 29.8 4 22.9V9.1z"/></clipPath></defs><path d="M16 2.2 28 9.1v13.8L16 29.8 4 22.9V9.1z" fill="url(#lg-h)"/><g clip-path="url(#lg-c)" fill="#24160C"><rect x="0" y="12.2" width="32" height="3"/><rect x="0" y="18.6" width="32" height="3"/></g><path d="M16 2.2 28 9.1v13.8L16 29.8 4 22.9V9.1z" fill="none" stroke="#24160C" stroke-width="1.4"/><path d="M8 9.6 16 5" stroke="#fff" stroke-opacity=".55" stroke-width="1.3" stroke-linecap="round"/></svg>';

let pop = null;
function closePop() { pop?.remove(); pop = null; document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', escPop, true); }
function outside(e) { if (pop && !pop.contains(e.target) && !e.target.closest('[data-pop-owner]')) closePop(); }
function escPop(e) { if (e.key === 'Escape' && pop) { e.stopPropagation(); const o = pop.__owner; closePop(); o?.focus(); } }
function openPop(owner, build, { align = 'right' } = {}) {
  if (pop && pop.__owner === owner) { closePop(); return; }
  closePop();
  pop = h('div', { class: 'pop', role: 'dialog', 'aria-label': owner.getAttribute('aria-label') || '' });
  pop.__owner = owner;
  pop.append(build());
  document.body.append(pop);
  const r = owner.getBoundingClientRect();
  const pr = pop.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  let left = align === 'right' ? r.right - pr.width : r.left;
  left = Math.max(8, Math.min(left, vw - pr.width - 8));
  pop.style.left = `${left}px`;
  pop.style.top = `${r.bottom + 8}px`;
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', escPop, true);
  pop.querySelector('button, [tabindex]')?.focus();
}

function queueView() {
  const s = S();
  const bi = brainInfo();
  const box = h('div');
  box.append(h('div', { class: 'pop-h', text: 'Model' }),
    h('div', { class: 'q-row' }, h('span', { class: `sdot sdot-${bi.dot}` }), h('div', { class: 'grow' }, h('div', { text: bi.label }), bi.detail ? h('div', { class: 'tiny muted', text: bi.detail }) : null),
      bi.key === 'ready' && extra.stats.tps ? h('span', { class: 'hchip hchip-mono', text: `${extra.stats.tps.toFixed(1)} tok/s` }) : null));
  const running = s.queue.running || [];
  const waiting = s.queue.waiting || [];
  box.append(h('div', { class: 'pop-h', text: `On the model now` }));
  if (!running.length) box.append(h('div', { class: 'q-row muted small', text: 'Nobody. The model is free.' }));
  for (const q of running) {
    const t = s.tasks[q.taskId];
    box.append(h('div', { class: 'q-row' }, beeAvatar(worker(q.workerId), 24), h('div', { class: 'grow' }, h('div', { text: worker(q.workerId).name }), h('div', { class: 'tiny muted ellipsis', text: t?.title || '' })), h('span', { class: 'spin' })));
  }
  box.append(h('div', { class: 'pop-h', text: `Waiting for a turn${waiting.length ? ` (${waiting.length})` : ''}` }));
  if (!waiting.length) box.append(h('div', { class: 'q-row muted small', text: 'Nobody is waiting.' }));
  waiting.forEach((q, i) => {
    const t = s.tasks[q.taskId];
    box.append(h('div', { class: 'q-row' }, h('span', { class: 'mono tiny faint', style: 'width:14px', text: String(i + 1) }), beeAvatar(worker(q.workerId), 24), h('div', { class: 'grow' }, h('div', { text: worker(q.workerId).name }), h('div', { class: 'tiny muted ellipsis', text: t?.title || '' }))));
  });
  const slots = Math.max(1, (s.brains || []).length);
  box.append(h('div', { class: 'pop-note', text: slots > 1
    ? `${slots} brains are attached, so ${slots} workers can take a turn at the same time. Everyone else waits in this fair queue.`
    : 'All workers share one model and take turns, one at a time, in a fair queue. That is why a job takes minutes, not seconds.' }));
  box.append(h('div', { class: 'row', style: 'padding:4px 6px 4px;justify-content:flex-end' }, h('button', { type: 'button', class: 'btn btn-xs btn-quiet', text: 'Model settings', on: { click: () => { closePop(); wm.open('settings'); } } })));
  return box;
}

export function init(el) {
  const brand = h('div', { class: 'brand' }, h('span', { html: LOGO }), h('span', { text: 'hivedesk' }), h('small', { class: 'ver' }));
  const demoTag = h('span', { class: 'demo-tag', hidden: true, title: 'No model is running. The crew follows a script.' }, 'Demo');
  const replayTag = h('button', { type: 'button', class: 'demo-tag replay-tag', hidden: true, title: 'Back to live', on: { click: () => exitReplay() } });
  const brandWrap = h('div', { class: 'row', style: 'gap:10px' }, brand, demoTag, replayTag);

  const input = h('input', { id: 'ask', type: 'text', autocomplete: 'off', spellcheck: false, placeholder: 'What should the crew build today?', 'aria-label': 'What should the crew build today?', maxLength: 2000 });
  const pbChip = h('span', { class: 'ask-pb', title: 'Mel will start from this playbook' }, icon('playbook', 'ico-sm'), h('span', { class: 'ellipsis', style: 'max-width:140px' }),
    h('button', { type: 'button', 'aria-label': 'Do not use this playbook', on: { click: () => { ui.askPlaybook = null; } } }, icon('x', 'ico-sm')));
  const hint = h('span', { class: 'ask-hint' });
  const send = h('button', { type: 'button', class: 'ask-send' }, 'Build', icon('arrow', 'ico-sm'));
  const ask = h('form', { class: 'ask', role: 'search', 'aria-label': 'New request' }, icon('hive'), input, pbChip, hint, send);

  const strip = h('div', { class: 'strip', 'aria-label': 'Current job' });
  const modelPill = h('button', { type: 'button', class: 'pill model', 'aria-label': 'Model and queue', 'aria-haspopup': 'dialog', 'data-pop-owner': '' });
  const apprBtn = h('button', { type: 'button', class: 'ibtn', 'aria-label': 'Approvals', title: 'Approvals', on: { click: () => wm.open('approvals') } }, icon('approval'));
  const bell = h('button', { type: 'button', class: 'ibtn', 'aria-label': 'Notifications', title: 'Notifications', 'aria-haspopup': 'dialog', 'data-pop-owner': '' }, h('span', { html: '<svg class="ico" viewBox="0 0 24 24"><path d="M6 16.5V11a6 6 0 1 1 12 0v5.5l1.5 2h-15z"/><path d="M10 20.5a2.2 2.2 0 0 0 4 0"/></svg>' }));
  const soundBtn = h('button', { type: 'button', class: 'ibtn', 'aria-label': 'Sound', title: 'Sound' });
  const kBtn = h('button', { type: 'button', class: 'ibtn', 'aria-label': 'Command palette (Ctrl K)', title: 'Command palette  Ctrl K', on: { click: () => openPalette() } }, h('span', { html: '<svg class="ico" viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.2"/><path d="M15.2 15.2 20 20"/></svg>' }));
  const right = h('div', { class: 'bar-right' }, modelPill, apprBtn, bell, soundBtn, kBtn);
  el.append(brandWrap, ask, strip, right);

  modelPill.addEventListener('click', () => openPop(modelPill, queueView));
  bell.addEventListener('click', () => openPop(bell, () => h('div', {}, h('div', { class: 'pop-h', text: 'Notifications' }), historyView())));
  const paintSound = () => {
    soundBtn.setAttribute('aria-pressed', String(!isMuted()));
    soundBtn.title = isMuted() ? 'Sound is off' : 'Sound is on';
    soundBtn.innerHTML = isMuted()
      ? '<svg class="ico" viewBox="0 0 24 24"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/></svg>'
      : '<svg class="ico" viewBox="0 0 24 24"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4.2 4.2 0 0 1 0 6M18 6.5a8 8 0 0 1 0 11"/></svg>';
  };
  soundBtn.addEventListener('click', () => { setMuted(!isMuted()); paintSound(); act.setSettings({ sound: !isMuted() }); if (!isMuted()) preview('task'); });
  paintSound();
  track(() => [rev.settings], () => { const s = S().settings; if (s.sound === false && !isMuted()) { setMuted(true); paintSound(); } });

  const submit = async (e) => {
    e?.preventDefault();
    const text = input.value.trim();
    const bi = brainInfo();
    if (!text) { input.focus(); return; }
    if (!bi.canRequest || ui.replay) return;
    send.disabled = true;
    const r = await act.createJob(text, { playbookId: ui.askPlaybook?.id });
    send.disabled = false;
    if (r) { input.value = ''; ui.askPlaybook = null; wm.open('timeline', undefined, { focus: false }); }
  };
  ask.addEventListener('submit', submit);
  send.addEventListener('click', submit);

  track(() => [ui.version, ui.demo, ui.replay], () => {
    brand.querySelector('.ver').textContent = ui.version ? `v${ui.version}` : '';
    demoTag.hidden = !ui.demo;
    replayTag.hidden = !ui.replay;
    if (ui.replay) replayTag.textContent = `Replay #${ui.replay.seq} · back to live`;
  });

  track(() => [rev.brain, ui.connection, ui.hello, ui.replay, ui.askPlaybook], () => {
    const bi = brainInfo();
    const off = !bi.canRequest || !!ui.replay;
    input.disabled = ui.connection !== 'open' || !!ui.replay;
    send.disabled = off;
    ask.classList.toggle('ask-off', off);
    clear(hint);
    if (ui.replay) hint.append('Replaying the log');
    else if (!bi.canRequest && ui.connection === 'open' && ui.hello) {
      hint.append(h('button', { type: 'button', class: 'btn btn-xs btn-ghost', style: 'color:var(--warn)', text: bi.key === 'none' ? 'No model yet: choose one' : bi.label, on: { click: () => wm.open('settings') } }));
    } else if (bi.canRequest) hint.append(h('kbd', { class: 'kbd', text: '/' }));
    pbChip.classList.toggle('on', !!ui.askPlaybook);
    pbChip.children[1].textContent = ui.askPlaybook?.title || '';

    clear(modelPill);
    const stats = extra.stats;
    const s = S();
    const waiting = (s.queue.waiting || []).length;
    modelPill.append(h('span', { class: `sdot sdot-${bi.dot}` }), h('span', { class: 'pill-txt ellipsis', style: 'max-width:240px', text: bi.label }));
    if (bi.key === 'ready') {
      if (stats.tps) modelPill.append(h('span', { class: 'sep' }), h('span', { class: 'num tps', title: 'Tokens per second, last turn' }, h('b', { text: stats.tps.toFixed(1) }), ' tok/s'));
      modelPill.append(h('span', { class: 'sep' }), h('span', { class: 'num', title: 'Turns waiting for the model' }, icon('queue', 'ico-sm')), h('span', { class: 'num qn', text: String(waiting) }));
    }
    if (bi.progress != null || bi.indeterminate) modelPill.append(h('span', { class: `pill-bar${bi.progress == null ? ' indet' : ''}` }, h('i', { style: bi.progress != null ? `width:${bi.progress * 100}%` : '' })));
    modelPill.title = bi.detail || bi.label;
  });
  track(() => [rev.queue, rev.live], () => {
    // the queue count lives inside the pill: repaint cheaply by nudging the brain revision
    const s = S();
    const q = modelPill.querySelector('.qn');
    if (q) q.textContent = String((s.queue.waiting || []).length);
    const tps = modelPill.querySelector('.tps b');
    if (tps && extra.stats.tps) tps.textContent = extra.stats.tps.toFixed(1);
  });

  track(() => [rev.approvals, ui.notifications], () => {
    const n = (S().approvals || []).length;
    apprBtn.querySelector('.count')?.remove();
    if (n) apprBtn.append(h('span', { class: 'count', text: String(n) }));
    apprBtn.setAttribute('aria-label', n ? `Approvals, ${n} waiting` : 'Approvals');
    bell.querySelector('.count')?.remove();
    if (ui.notifications) bell.append(h('span', { class: 'count', text: String(Math.min(ui.notifications, 99)) }));
  });

  track(() => [rev.jobs, rev.tasks], () => {
    const s = S();
    const j = currentJob(s);
    clear(strip);
    if (!j) return;
    const tasks = jobTasks(s, j);
    const done = tasks.filter((t) => t.status === 'done').length;
    strip.append(h('div', { class: 'strip-cells', role: 'img', 'aria-label': `${done} of ${tasks.length} tasks done` },
      tasks.length ? tasks.map((t) => h('span', { class: 'cell', dataset: { s: t.status }, title: `${t.title}: ${TASK_LABEL[t.status] || t.status}` })) : h('span', { class: 'cell', dataset: { s: 'running' } })),
    h('button', { type: 'button', class: 'strip-label', style: 'border:0;background:none;cursor:pointer;text-align:left', title: j.request, on: { click: () => wm.open('timeline') } },
      j.status === 'planning' ? 'Mel is planning' : ['running'].includes(j.status) ? `${done} of ${tasks.length} · ${j.request}` : `${j.status === 'done' ? 'Done' : j.status === 'failed' ? 'Failed' : 'Cancelled'} · ${j.request}`));
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !e.ctrlKey && !e.metaKey && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) && !document.activeElement?.isContentEditable) {
      e.preventDefault(); input.focus();
    }
  });
  void V;
}
