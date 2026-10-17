// Approvals: destructive actions wait here until you answer (approval mode).

import { h, icon, clear, ago } from '../dom.js';
import { beeAvatar } from '../bees.js';
import { register } from '../wm.js';
import { S, rev, ui, worker } from '../store.js';
import { diffView } from '../diff.js';
import * as act from '../actions.js';
import { t } from '../i18n.js';
import { setTip } from '../tooltip.js';
import { track, stateBox, btn } from './util.js';

/** "Rosa wants to edit a file", in the current language (also used for the toasts in main.js). */
export function approvalTitle(a) {
  const w = worker(a.workerId);
  return t('approvals.ask', { name: w.name, tool: a.tool });
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
      ui.replay ? h('span', { class: 'small muted', text: t('approvals.replayOff') }) : null,
      setTip(btn(t('approvals.reject'), () => answer(false), 'btn btn-sm btn-bad', 'x'), { key: 'tip.approvals.reject' }),
      setTip(btn(t('approvals.approve'), () => answer(true), 'btn btn-sm btn-ok', 'check'), { key: 'tip.approvals.approve' })));
  if (ui.replay) for (const b of card.querySelectorAll('button')) b.disabled = true;
  return card;
}

register('approvals', {
  title: () => t('approvals.title'),
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
      const on = !!s.settings.approvalMode;
      ctx.setSub(list.length ? t('approvals.waiting', { count: list.length }) : '');
      clear(pane);
      clear(foot).append(icon('lock', 'ico-sm'), h('span', { class: 'grow', text: on ? t('approvals.modeOn') : t('approvals.modeOff') }),
        setTip(btn(on ? t('approvals.turnOff') : t('approvals.turnOn'), () => act.setSettings({ approvalMode: !on }), 'btn btn-xs btn-quiet'), { key: on ? 'tip.approvals.turnOff' : 'tip.approvals.turnOn' }));
      if (!list.length) {
        pane.append(stateBox({ icon: 'approval', title: t('approvals.empty.title'), text: t('approvals.empty.text') }));
        return;
      }
      for (const a of list) pane.append(approvalCard(a));
      pane.querySelector('.btn-ok')?.setAttribute('data-autofocus', '');
    });
  },
});
