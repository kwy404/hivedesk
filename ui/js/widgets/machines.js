// The Machines window: the same view as the City's Machines panel (ui/city/panels.js), on the
// desktop. Every number is a probe measurement with its source, or "not measured".

import { h, icon } from '../dom.js';
import { register } from '../wm.js';
import { hub, onHub } from '/city/hub.js';
import { tr } from '/city/strings.js';

register('machines', {
  title: () => tr('city.machine.title'),
  glyph: () => icon('gpu'),
  size: [460, 640],
  min: [320, 360],
  cardH: 640,
  create(ctx) {
    const box = h('div', { class: 'pane ct-win ct-hud' });
    ctx.body.append(box);
    const paint = () => {
      const panels = hub.panels;
      if (!panels) { box.replaceChildren(h('div', { class: 'state' }, h('p', { text: tr('city.win.noCity') }))); return; }
      // keep the scroll position across repaints
      const top = box.scrollTop;
      box.replaceChildren(panels.machines(null));
      box.scrollTop = top;
    };
    paint();
    const off = onHub(paint);
    const tick = setInterval(paint, 2000); // sample ages and lease countdowns
    ctx.onDispose(() => { off(); clearInterval(tick); });
  },
});
