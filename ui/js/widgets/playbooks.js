// Playbooks: plans saved from jobs that ended well. Mel reuses similar ones.

import { h, icon, clear, ago } from '../dom.js';
import { register } from '../wm.js';
import { S, rev, ui, worker } from '../store.js';
import { beeAvatar } from '../bees.js';
import { provide } from '../menu.js';
import { notify } from '../notify.js';
import * as act from '../actions.js';
import { track, stateBox, btn } from './util.js';

export function usePlaybook(p) {
  ui.askPlaybook = { id: p.id, title: p.title };
  const ask = document.querySelector('#ask');
  if (ask) { if (!ask.value) ask.value = p.request; ask.focus(); ask.select(); }
}

function confirmDelete(p) {
  notify({
    title: `Delete "${p.title}"?`, body: 'Mel will stop reusing this plan. Past jobs keep their history.', tone: 'warn', icon: 'playbook', sticky: true, key: `pbdel-${p.id}`,
    actions: [{ label: 'Delete', danger: true, run: () => act.deletePlaybook(p.id) }, { label: 'Keep', run: () => {} }],
  });
}

register('playbooks', {
  title: 'Playbooks',
  glyph: () => icon('playbook'),
  size: [440, 480],
  min: [300, 220],
  cardH: 440,
  create(ctx) {
    const search = h('input', { class: 'field-in', type: 'search', placeholder: 'Filter playbooks', 'aria-label': 'Filter playbooks', style: 'height:30px' });
    const pane = h('div', { class: 'pane' });
    ctx.body.append(h('div', { class: 'tb' }, search), pane);
    search.addEventListener('input', render);
    provide(pane, (target) => {
      const card = target.closest?.('.pb');
      const p = card?.__pb;
      if (!p) return null;
      return [
        { label: 'Use for a new request', icon: 'plan', disabled: !!ui.replay, action: () => usePlaybook(p) },
        { label: 'Copy request', icon: 'copy', action: () => act.copy(p.request, 'Request copied') },
        { sep: true },
        { label: 'Delete', icon: 'x', danger: true, disabled: !!ui.replay, action: () => confirmDelete(p) },
      ];
    });
    function render() {
      const s = S();
      const q = search.value.trim().toLowerCase();
      clear(pane);
      const all = (s.playbooks || []).slice().sort((a, b) => (b.uses || 0) - (a.uses || 0) || String(b.createdAt).localeCompare(String(a.createdAt)));
      ctx.setSub(all.length ? `${all.length} saved` : '');
      if (!all.length) {
        pane.append(stateBox({ icon: 'playbook', title: 'No playbooks yet', text: 'When a job ends well, its plan is saved here. Mel looks for a similar playbook before planning the next request, so repeat work gets faster.' }));
        return;
      }
      const list = all.filter((p) => !q || `${p.title} ${p.request} ${(p.keywords || []).join(' ')}`.toLowerCase().includes(q));
      if (!list.length) { pane.append(h('div', { class: 'state', style: 'min-height:100px' }, h('p', { text: 'No playbook matches that filter.' }))); return; }
      for (const p of list) {
        const assignees = [...new Set((p.tasks || []).map((t) => t.assignee))].slice(0, 5);
        const card = h('article', { class: 'pb', tabindex: '0' },
          h('div', { class: 'row' },
            h('div', { class: 'grow' }, h('div', { class: 'pb-t', text: p.title }), h('div', { class: 'pb-q ellipsis', text: p.request })),
            btn('Use', () => usePlaybook(p), 'btn btn-xs btn-quiet', 'plan')),
          h('div', { class: 'row tiny muted', style: 'margin-top:8px;gap:10px' },
            h('span', { class: 'row', style: 'gap:2px' }, assignees.map((a) => beeAvatar(worker(a), 18, { ring: false }))),
            h('span', { text: `${(p.tasks || []).length} tasks` }),
            h('span', { text: p.uses ? `used ${p.uses} time${p.uses > 1 ? 's' : ''}` : 'not reused yet' }),
            p.createdAt ? h('span', { text: ago(p.createdAt) }) : null),
          p.keywords?.length ? h('div', { class: 'pb-k' }, p.keywords.slice(0, 6).map((k) => h('span', { class: 'hchip', text: k }))) : null);
        card.__pb = p;
        pane.append(card);
      }
    }
    track(() => [rev.playbooks, ui.replay], render);
  },
});
