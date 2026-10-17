// Playbooks: plans saved from jobs that ended well. Mel reuses similar ones.

import { h, icon, clear, ago } from '../dom.js';
import { register } from '../wm.js';
import { S, rev, ui, worker } from '../store.js';
import { beeAvatar } from '../bees.js';
import { provide } from '../menu.js';
import { notify } from '../notify.js';
import * as act from '../actions.js';
import { t } from '../i18n.js';
import { setTip } from '../tooltip.js';
import { track, stateBox, btn } from './util.js';

export function usePlaybook(p) {
  ui.askPlaybook = { id: p.id, title: p.title };
  const ask = document.querySelector('#ask');
  if (ask) { if (!ask.value) ask.value = p.request; ask.focus(); ask.select(); }
}

function confirmDelete(p) {
  notify({
    title: t('playbooks.delete.title', { title: p.title }), body: t('playbooks.delete.body'), tone: 'warn', icon: 'playbook', sticky: true, key: `pbdel-${p.id}`,
    actions: [{ label: t('playbooks.delete.confirm'), danger: true, run: () => act.deletePlaybook(p.id) }, { label: t('playbooks.delete.keep'), run: () => {} }],
  });
}

register('playbooks', {
  title: () => t('playbooks.title'),
  glyph: () => icon('playbook'),
  size: [440, 480],
  min: [300, 220],
  cardH: 440,
  create(ctx) {
    const search = h('input', { class: 'field-in', type: 'search', tp: 'playbooks.filter', ta: 'playbooks.filter', style: 'height:30px' });
    const pane = h('div', { class: 'pane' });
    ctx.body.append(h('div', { class: 'tb' }, search), pane);
    search.addEventListener('input', render);
    provide(pane, (target) => {
      const card = target.closest?.('.pb');
      const p = card?.__pb;
      if (!p) return null;
      return [
        { label: t('playbooks.menu.use'), icon: 'plan', disabled: !!ui.replay, action: () => usePlaybook(p) },
        { label: t('playbooks.menu.copy'), icon: 'copy', action: () => act.copy(p.request, t('playbooks.copied')) },
        { sep: true },
        { label: t('playbooks.menu.delete'), icon: 'x', danger: true, disabled: !!ui.replay, action: () => confirmDelete(p) },
      ];
    });
    function render() {
      const s = S();
      const q = search.value.trim().toLowerCase();
      clear(pane);
      const all = (s.playbooks || []).slice().sort((a, b) => (b.uses || 0) - (a.uses || 0) || String(b.createdAt).localeCompare(String(a.createdAt)));
      ctx.setSub(all.length ? t('playbooks.saved', { count: all.length }) : '');
      if (!all.length) {
        pane.append(stateBox({ icon: 'playbook', title: t('playbooks.empty.title'), text: t('playbooks.empty.text') }));
        return;
      }
      const list = all.filter((p) => !q || `${p.title} ${p.request} ${(p.keywords || []).join(' ')}`.toLowerCase().includes(q));
      if (!list.length) { pane.append(h('div', { class: 'state', style: 'min-height:100px' }, h('p', { text: t('playbooks.noMatch') }))); return; }
      for (const p of list) {
        const assignees = [...new Set((p.tasks || []).map((task) => task.assignee))].slice(0, 5);
        const card = h('article', { class: 'pb', tabindex: '0' },
          h('div', { class: 'row' },
            h('div', { class: 'grow' }, h('div', { class: 'pb-t', text: p.title }), h('div', { class: 'pb-q ellipsis', text: p.request })),
            setTip(btn(t('playbooks.use'), () => usePlaybook(p), 'btn btn-xs btn-quiet', 'plan'), { key: 'tip.playbooks.use' })),
          h('div', { class: 'row tiny muted', style: 'margin-top:8px;gap:10px' },
            h('span', { class: 'row', style: 'gap:2px' }, assignees.map((a) => beeAvatar(worker(a), 18, { ring: false }))),
            h('span', { text: t('playbooks.tasks', { count: (p.tasks || []).length }) }),
            h('span', { text: t('playbooks.uses', { count: p.uses || 0 }) }),
            p.createdAt ? h('span', { text: ago(p.createdAt) }) : null),
          p.keywords?.length ? h('div', { class: 'pb-k' }, p.keywords.slice(0, 6).map((k) => h('span', { class: 'hchip', text: k }))) : null);
        card.__pb = p;
        pane.append(card);
      }
    }
    track(() => [rev.playbooks, ui.replay], render);
  },
});
