// First run of the City: Create your City, name it, your machine, a first agent, invite a friend.
// Every step writes to the engine (city.name.set, city.agent.hire, city.onboard.done), so the
// result is the same on every screen and after a restart. Skip ends it at any step.

import { h, clear, reducedMotion } from '/js/dom.js';
import { tr } from './strings.js';
import { machineCard } from './machines.js';
import { hub } from './hub.js';
import { ROLES } from './roles.js';
import * as net from '/js/net.js';
import { pt, profileView, avatarPicker, loadProfileStrings } from '/profile/ui.js';

export { ROLES };

/**
 * @param {{ layer: HTMLElement, view: () => any, cmd: (type: string, data?: object) => Promise<any>, invite: () => void, onDone?: () => void }} ctx
 */
export function createOnboarding(ctx) {
  let el = null;
  // step -1 is who you are (the local profile, docs/1.0/PROFILE.md), then the City steps 0 to 3
  let step = -1;
  const data = { name: '', machine: '', agent: '', role: 'developer', you: null, avatar: undefined };
  let busy = false;

  const close = () => { el?.remove(); el = null; ctx.onDone?.(); };
  const finish = async (skipped = false) => {
    busy = true;
    try { await ctx.cmd('city.onboard.done', { skipped }); } catch { /* the engine said why */ }
    busy = false;
    close();
  };

  function paint() {
    if (!el) return;
    const card = el.querySelector('.ct-ob-card');
    clear(card);
    const v = ctx.view();
    const self = v.machines[v.selfId];
    const dots = h('div', { class: 'ct-ob-dots', 'aria-hidden': 'true' }, ...[-1, 0, 1, 2, 3].map((i) => h('i', { dataset: { on: String(i === step), done: String(i < step) } })));
    const skip = h('button', { type: 'button', class: 'btn btn-xs btn-quiet', text: tr('city.ob.skip'), on: { click: () => finish(true) } });
    const next = (fn, key = 'city.ob.next') => h('button', { type: 'button', class: 'btn btn-sm btn-primary', text: tr(key), disabled: busy, on: { click: fn } });
    card.append(h('div', { class: 'ct-ob-top' }, dots, h('span', { class: 'ct-faint small', text: tr('city.ob.step', { n: step + 2, total: 5 }) })));
    if (step === -1) {
      const pv = profileView()?.profile || {};
      if (data.you == null) data.you = pv.name || '';
      if (data.avatar === undefined) data.avatar = pv.avatar || null;
      const input = h('input', { class: 'ct-input', type: 'text', maxLength: 32, value: data.you, placeholder: pt('profile.namePlaceholder'), 'aria-label': pt('profile.name'), on: { input: (e) => { data.you = e.target.value; } } });
      card.append(h('h2', { text: pt('profile.ob.title') }), h('p', { class: 'ct-about', text: pt('profile.ob.intro') }),
        h('label', { class: 'ct-ob-field' }, h('span', { text: pt('profile.name') }), input),
        h('div', { class: 'ct-ob-field' }, h('span', { text: pt('profile.avatar') }), avatarPicker(data.avatar, (id) => { data.avatar = id; }, { size: 32, name: data.you || pv.name })),
        h('div', { class: 'ct-ob-acts' }, skip, next(async () => {
          busy = true; paint();
          try { await net.command('profile.set', { name: data.you, avatar: data.avatar || null }); } catch { /* the engine said why */ }
          busy = false; step = 0; paint();
        })));
      requestAnimationFrame(() => input.focus());
    } else if (step === 0) {
      const input = h('input', { class: 'ct-input', type: 'text', maxLength: 40, value: data.name, placeholder: tr('city.ob.namePlaceholder'), 'aria-label': tr('city.ob.nameLabel'), on: { input: (e) => { data.name = e.target.value; } } });
      card.append(h('h2', { text: tr('city.ob.title') }), h('p', { class: 'ct-about', text: tr('city.ob.intro') }),
        h('label', { class: 'ct-ob-field' }, h('span', { text: tr('city.ob.nameLabel') }), input),
        h('div', { class: 'ct-ob-acts' }, skip, next(() => { data.name = data.name.trim() || tr('city.ob.defaultName'); step = 1; paint(); })));
      requestAnimationFrame(() => input.focus());
    } else if (step === 1) {
      if (!data.machine) data.machine = self?.name || '';
      const input = h('input', { class: 'ct-input', type: 'text', maxLength: 40, value: data.machine, 'aria-label': tr('city.ob.machineLabel'), on: { input: (e) => { data.machine = e.target.value; } } });
      const card0 = self ? machineCard(self, v, hub.compute, { selfPeerId: hub.selfPeerId }) : null;
      const facts = h('dl', { class: 'ct-grid' });
      for (const f of (card0?.fields || []).filter((x) => ['gpu', 'vram', 'cpu', 'ram', 'model'].includes(x.key))) {
        const val = f.value == null ? tr('city.m.notMeasured') : f.key === 'vram' || f.key === 'ram' ? tr('city.m.total', { gb: Math.round((f.value.totalBytes / 1024 ** 3) * 10) / 10 }) : f.key === 'cpu' ? `${Math.round(f.value)}%` : String(f.value);
        facts.append(h('dt', { text: tr(`city.m.f.${f.key}`) }), h('dd', { dataset: { state: f.value == null ? 'unknown' : f.state }, text: val }));
      }
      card.append(h('h2', { text: tr('city.ob.machineTitle') }), h('p', { class: 'ct-about', text: tr('city.ob.machineIntro') }),
        h('label', { class: 'ct-ob-field' }, h('span', { text: tr('city.ob.machineLabel') }), input), facts,
        h('p', { class: 'ct-faint small', text: tr('city.ob.machineHonest') }),
        h('div', { class: 'ct-ob-acts' }, skip, next(async () => {
          busy = true; paint();
          try { await ctx.cmd('city.name.set', { name: data.name, machineName: data.machine.trim() || undefined }); step = 2; } catch { /* shown */ }
          busy = false; paint();
        })));
    } else if (step === 2) {
      const crew = Object.values(v.agents).filter((a) => a.home === v.selfId);
      const name = h('input', { class: 'ct-input', type: 'text', maxLength: 40, value: data.agent, placeholder: tr('city.ob.agentPlaceholder'), 'aria-label': tr('city.ob.agentName'), on: { input: (e) => { data.agent = e.target.value; } } });
      const roles = h('div', { class: 'ct-ob-roles', role: 'radiogroup', 'aria-label': tr('city.ob.agentRole') });
      for (const k of Object.keys(ROLES)) {
        roles.append(h('button', { type: 'button', class: 'ct-ob-role', role: 'radio', 'aria-checked': String(data.role === k), on: { click: () => { data.role = k; paint(); } } },
          h('b', { text: tr(`city.role.${k}`) }), h('span', { class: 'ct-faint small', text: tr(`city.ob.roleAbout.${k}`) })));
      }
      card.append(h('h2', { text: tr('city.ob.agentTitle') }), h('p', { class: 'ct-about', text: tr('city.ob.agentIntro', { n: crew.length }) }),
        roles, h('label', { class: 'ct-ob-field' }, h('span', { text: tr('city.ob.agentName') }), name),
        h('div', { class: 'ct-ob-acts' },
          h('button', { type: 'button', class: 'btn btn-sm', text: tr('city.ob.keepCrew'), on: { click: () => { step = 3; paint(); } } }),
          next(async () => {
            const nm = data.agent.trim();
            if (!nm) { name.focus(); return; }
            busy = true; paint();
            try { await ctx.cmd('city.agent.hire', { name: nm, ...ROLES[data.role] }); step = 3; } catch { /* shown */ }
            busy = false; paint();
          }, 'city.ob.hire')));
    } else {
      card.append(h('h2', { text: tr('city.ob.inviteTitle') }), h('p', { class: 'ct-about', text: tr('city.ob.inviteIntro') }),
        h('ul', { class: 'ct-ob-list' }, h('li', { text: tr('city.ob.invite1') }), h('li', { text: tr('city.ob.invite2') }), h('li', { text: tr('city.ob.invite3') })),
        h('div', { class: 'ct-ob-acts' },
          h('button', { type: 'button', class: 'btn btn-sm', text: tr('city.ob.later'), on: { click: () => finish(false) } }),
          next(async () => { await finish(false); ctx.invite(); }, 'city.ob.invite')));
    }
  }

  return {
    get open() { return !!el; },
    show() {
      if (el) return;
      loadProfileStrings().then(() => paint());
      el = h('div', { class: 'ct-ob', role: 'dialog', 'aria-modal': 'true', 'aria-label': tr('city.ob.title') }, h('div', { class: 'of-card ct-ob-card' }));
      el.addEventListener('keydown', (e) => { if (e.key === 'Escape') finish(true); });
      ctx.layer.append(el);
      paint();
      if (!reducedMotion()) el.querySelector('.ct-ob-card').animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 200, easing: 'cubic-bezier(.2,0,0,1)' });
    },
    repaint: paint,
    close,
  };
}
