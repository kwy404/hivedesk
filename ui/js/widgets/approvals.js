// Approvals: destructive actions wait here until you answer (approval mode).

import { h, icon, clear, ago } from '../dom.js';
import { beeAvatar } from '../bees.js';
import { register } from '../wm.js';
import { S, rev, ui, worker } from '../store.js';
import { diffView } from '../diff.js';
import * as act from '../actions.js';
import { track, stateBox, btn } from './util.js';

const TOOL_WORD = { write: 'write a file', edit: 'edit a file', run: 'run a command', delete: 'delete a file' };

export function approvalTitle(a) {
  const w = worker(a.workerId);
  return `${w.name} wants to ${TOOL_WORD[a.tool] || `use ${a.tool}`}`;
}

export function approvalCard(a, { compact = false } = {}) {
  const w = worker(a.workerId);
  const target = a.args?.path || a.args?.command || '';
  const busy = (b) => { for (const x of card.querySelectorAll('button')) x.disabled = b; };
  const answer = async (yes) => { busy(true); const r = await act.resolveApproval(a.id, yes); if (!r) busy(false); };
  const card = h('article', { class: 'appr', 'aria-label': approvalTitle(a) },
    h('div', { class: 'appr-h' }, beeAvatar(w, 30),
      h('div', { class: 'grow' }, h('div', { class: 'appr-t', text: approvalTitle(a) }),
        h('div', { class: 'small muted ellipsis', text: a.summary || target }))),
    target ? h('div', { class: 'row', style: 'padding:0 12px 10px' }, h('span', { class: 'hchip hchip-mono', text: a.tool }), h('span', { class: 'mono small ellipsis', text: target }), h('span', { class: 'grow' }), h('span', { class: 'tiny faint', text: ago(a.createdAt) })) : null,
    a.diff && !compact ? diffView(a.diff) : null,
    h('div', { class: 'appr-a' },
      ui.replay ? h('span', { class: 'small muted', text: 'Replay: answering is off.' }) : null,
      btn('Reject', () => answer(false), 'btn btn-sm btn-bad', 'x'),
      btn('Approve', () => answer(true), 'btn btn-sm btn-ok', 'check')));
  if (ui.replay) for (const b of card.querySelectorAll('button')) b.disabled = true;
  return card;
}

register('approvals', {
  title: 'Approvals',
  glyph: () => icon('approval'),
  size: [520, 460],
  min: [320, 220],
  cardH: 440,
  create(ctx) {
    const pane = h('div', { class: 'pane' });
    const foot = h('div', { class: 'foot tiny muted row' });
    ctx.body.append(pane, foot);
    track(() => [rev.approvals, rev.settings, ui.replay], () => {
      const s = S();
      const list = s.approvals || [];
      ctx.setSub(list.length ? `${list.length} waiting` : '');
      clear(pane);
      clear(foot).append(icon('lock', 'ico-sm'), h('span', { class: 'grow', text: s.settings.approvalMode ? 'Approval mode is on: destructive actions wait for your answer.' : 'Approval mode is off: the crew acts without asking.' }),
        btn(s.settings.approvalMode ? 'Turn off' : 'Turn on', () => act.setSettings({ approvalMode: !s.settings.approvalMode }), 'btn btn-xs btn-quiet'));
      if (!list.length) {
        pane.append(stateBox({ icon: 'approval', title: 'Nothing is waiting for you', text: 'When a worker wants to do something destructive, it stops and asks here first.' }));
        return;
      }
      for (const a of list) pane.append(approvalCard(a));
      pane.querySelector('.btn-ok')?.setAttribute('data-autofocus', '');
    });
  },
});
