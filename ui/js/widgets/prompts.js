// Prompt debug: the exact assembled prompt of each recent model turn, its token budget and the answer.
// For transparency; the engine keeps the last 40 turns in memory only, and prompts never hold API keys.

import { h, icon, clear, copyText } from '../dom.js';
import { register } from '../wm.js';
import { onEvent, worker } from '../store.js';
import { command } from '../net.js';
import { track, btn } from './util.js';

const V = window.V;
const box = V.reactive({ v: 0 });
let pending = null;
onEvent((ev) => { if (ev.type === 'turn.ended' && !pending) pending = setTimeout(() => { pending = null; box.v++; }, 800); });

function budgetLine(b) {
  if (!b) return 'no budget recorded';
  const parts = Object.entries(b.sections || {}).map(([k, v]) => `${k} ${v}`).join(', ');
  return `${b.family}: ${b.used} of ${b.limit} tokens (${parts})${b.trimmed?.length ? `; trimmed: ${b.trimmed.join(', ')}` : ''}; prompts v${b.version}`;
}

register('prompts', {
  title: 'Prompts',
  glyph: () => icon('code'),
  size: [680, 620],
  min: [320, 260],
  cardH: 560,
  create(ctx) {
    const pane = h('div', { class: 'pane pane-pad' });
    ctx.body.append(pane);
    track(() => [box.v], async () => {
      let r;
      try { r = await command('turn.recent', {}); } catch { r = { turns: [] }; }
      clear(pane);
      ctx.setSub(`${r.turns.length} turns`);
      if (!r.turns.length) { pane.append(h('p', { class: 'small muted', text: 'No model turns yet. Each turn shows here with its exact prompt and answer.' })); return; }
      for (const t of r.turns) {
        const body = h('div', { hidden: true });
        const show = async () => {
          body.hidden = !body.hidden;
          if (body.hidden || body.childElementCount) return;
          const full = await command('turn.prompt', { turnId: t.turnId }).catch((e) => ({ error: e.message }));
          if (full.error) { body.append(h('p', { class: 'small bad', text: full.error })); return; }
          for (const m of full.messages) body.append(h('h4', { text: m.role }), h('pre', { class: 'brief-text', text: m.content }));
          body.append(h('h4', { text: 'answer' }), h('pre', { class: 'brief-text', text: full.response ?? '(still running)' }),
            btn('Copy prompt', () => copyText(full.messages.map((m) => `## ${m.role}\n${m.content}`).join('\n\n')), 'btn btn-xs btn-quiet', 'copy'));
        };
        pane.append(h('article', { class: 'appr' },
          h('div', { class: 'row', style: 'padding:8px 12px' },
            h('span', { class: 'hchip', text: worker(t.workerId).name }), h('span', { class: 'mono small', text: t.turnId }),
            h('span', { class: 'tiny faint grow', text: t.brainId }), btn('Show prompt', show, 'btn btn-xs btn-quiet')),
          h('div', { class: 'tiny muted', style: 'padding:0 12px 8px', text: budgetLine(t.budget) }),
          h('div', { style: 'padding:0 12px 10px' }, body)));
      }
    });
  },
});
