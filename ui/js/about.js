// About hivedesk: logo and Mel, the version, the author, the project, the license and credits.

import { h, icon } from './dom.js';
import { ui } from './store.js';
import { openDialog } from './dialog.js';
import { LOGO } from './topbar.js';

const GITHUB = 'https://github.com/kwy404';
const LINKEDIN = 'https://www.linkedin.com/in/alexandre-silva-173687256/';
const REPO = 'https://github.com/kwy404/hivedesk';
const MONSOON = 'https://kwy404.github.io/monsoon/';
const VOODOO = 'https://kwy404.github.io/Voodoo.js/';

const ext = (href, props, ...kids) => h('a', { href, target: '_blank', rel: 'noopener', ...props }, ...kids);

export function openAbout() {
  const body = h('div', { class: 'about' },
    h('div', { class: 'about-art' },
      h('span', { class: 'about-logo', html: LOGO }),
      h('img', { class: 'about-mel', src: '/assets/mascot-dark.svg', alt: '', width: 96, height: 96 })),
    h('div', { class: 'about-name' }, h('strong', { text: 'hivedesk' }), h('span', { class: 'hchip hchip-mono', tx: 'about.version', txArgs: { version: ui.version || '0.1.0' } })),
    h('p', { class: 'about-lead', tx: 'about.lead' }),
    h('div', { class: 'about-by' },
      h('span', { tx: 'about.madeBy' }),
      h('span', { class: 'about-links' },
        h('a', { class: 'ibtn about-ibtn', href: GITHUB, target: '_blank', rel: 'me noopener', ta: 'about.github', tip: 'tip.about.github' }, icon('github')),
        h('a', { class: 'ibtn about-ibtn', href: LINKEDIN, target: '_blank', rel: 'me noopener', ta: 'about.linkedin', tip: 'tip.about.linkedin' }, icon('linkedin')))),
    h('div', { class: 'about-repo' },
      ext(REPO, { class: 'btn btn-sm btn-quiet', tip: 'tip.about.repo' }, icon('github', 'ico-sm'), h('span', { tx: 'about.repo' })),
      ext(REPO, { class: 'btn btn-sm btn-primary', tip: 'tip.about.star', 'data-autofocus': '' }, icon('star', 'ico-sm'), h('span', { tx: 'about.star' }))),
    h('dl', { class: 'about-kv' },
      h('dt', { tx: 'about.license' }), h('dd', {}, ext(`${REPO}/blob/main/LICENSE`, { tip: 'tip.about.license' }, h('span', { tx: 'about.mit' }))),
      h('dt', { tx: 'about.credits' }), h('dd', {},
        h('div', {}, ext(MONSOON, { tx: 'about.monsoon', tip: 'tip.about.monsoon' })),
        h('div', {}, ext(VOODOO, { tx: 'about.voodoo', tip: 'tip.about.voodoo' })))),
    h('p', { class: 'about-note tiny muted', tx: 'about.local' }));
  return openDialog({ titleKey: 'about.title', body, cls: 'about-dlg' });
}
