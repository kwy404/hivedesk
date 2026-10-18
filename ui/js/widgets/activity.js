// The Activity window: every task transition, job decision, grant, revoke, peer join and leave,
// approval, file change and git action of this project, from the event log, with filters and the
// CSV, JSON and Markdown export. Lines come from ui/city/activity.js, so the City side panel and
// this window say the same thing.

import { h, icon, ago } from '../dom.js';
import { register } from '../wm.js';
import { hub, onHub, loadHistory } from '/city/hub.js';
import { tr } from '/city/strings.js';
import { activityFrom, filterActivity, exportActivity, entryOf, KINDS } from '/city/activity.js';

const LIMIT = 500;

register('activity', {
  title: () => tr('city.act.title'),
  glyph: () => icon('queue'),
  size: [620, 640],
  min: [340, 360],
  cardH: 640,
  create(ctx) {
    let events = [];
    let loaded = false;
    const f = { kind: '', q: '' };
    const names = () => (hub.names ? hub.names() : {});
    const text = (e) => tr(e.key, e.p);
    const kind = h('select', { class: 'ct-select', 'aria-label': tr('city.act.kind'), on: { change: (e) => { f.kind = e.target.value; paint(); } } },
      h('option', { value: '', text: tr('city.act.all') }), ...KINDS.map((k) => h('option', { value: k, text: tr(`city.act.kind.${k}`) })));
    const q = h('input', { class: 'ct-input', type: 'search', placeholder: tr('city.act.search'), 'aria-label': tr('city.act.search'), on: { input: (e) => { f.q = e.target.value; paint(); } } });
    const save = (fmt) => {
      const out = exportActivity(filterActivity(activityFrom(events, names()), f, text), fmt, text);
      const url = URL.createObjectURL(new Blob([out.body], { type: out.type }));
      const a = h('a', { href: url, download: `hivedesk-activity-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${out.ext}` });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    };
    const exp = h('div', { class: 'ct-acts' }, ...['csv', 'json', 'md'].map((fmt) => h('button', { type: 'button', class: 'btn btn-xs btn-quiet', text: tr(`city.act.export.${fmt}`), on: { click: () => save(fmt) } })));
    const count = h('span', { class: 'ct-faint small' });
    const list = h('ol', { class: 'ct-actlist ct-actwin' });
    ctx.body.append(h('div', { class: 'pane ct-win ct-hud' }, h('div', { class: 'ct-add' }, kind, q), h('div', { class: 'of-row' }, count, exp), list));

    function paint() {
      const all = filterActivity(activityFrom(events, names()), f, text);
      count.textContent = loaded ? tr('city.act.count', { n: all.length }) : tr('city.act.loading');
      const rows = all.slice(-LIMIT).reverse();
      list.replaceChildren(...rows.map((e) => h('li', { dataset: { tone: e.tone || '', k: e.kind } }, h('span', { class: 'of-dot' }),
        h('span', { text: text(e) }), h('time', { class: 'ct-faint tiny', datetime: e.ts, title: e.ts, text: ago(e.ts) }))));
      if (!rows.length) list.append(h('li', { class: 'ct-faint', text: loaded ? tr('city.act.empty') : tr('city.act.loading') }));
    }
    paint();
    loadHistory().then((past) => {
      const last = past.length ? past[past.length - 1].seq : 0;
      events = [...past.filter((e) => entryOf(e)), ...hub.recent.filter((e) => e.seq > last)];
      loaded = true;
      paint();
    }).catch(() => { events = [...hub.recent]; loaded = true; paint(); });
    const off = onHub(() => {
      if (!loaded) return;
      const last = events.length ? events[events.length - 1].seq : 0;
      const fresh = hub.recent.filter((e) => e.seq > last);
      if (!fresh.length) return;
      events.push(...fresh);
      paint();
    });
    ctx.onDispose(off);
  },
});
