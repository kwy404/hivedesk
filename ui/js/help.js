// Help: the top bar buttons for the language and for help (tour, shortcuts, About), and the
// keyboard shortcuts dialog.

import { h, icon } from './dom.js';
import * as menu from './menu.js';
import { t, LOCALES, locale, setLocale, fmtKeys, onLocale } from './i18n.js';
import { openDialog } from './dialog.js';

function openMenuAt(btn, items) {
  const r = btn.getBoundingClientRect();
  menu.open({ x: Math.max(8, r.right - 220), y: r.bottom + 6, items });
}

export function languageItems() {
  return [{ header: t('lang.title') }, ...LOCALES.map((l) => ({ label: l.name, checked: locale() === l.code, action: () => setLocale(l.code) }))];
}

/** Opens the language menu under the top bar button (also used by the command palette). */
export function openLanguageMenu() {
  const btn = document.querySelector('.lang-btn');
  if (btn) openMenuAt(btn, languageItems());
  else menu.open({ x: innerWidth / 2 - 110, y: 80, items: languageItems() });
}

export function helpItems() {
  return [
    { label: t('pal.tour'), icon: 'compass', action: () => import('./tour.js').then((m) => m.startTour()) },
    { label: t('pal.shortcuts'), icon: 'plan', kb: '?', action: () => openShortcuts() },
    { sep: true },
    { label: t('pal.about'), icon: 'hive', action: () => import('./about.js').then((m) => m.openAbout()) },
  ];
}

/** The language button for the top bar: a globe and the short code of the current language. */
export function languageButton() {
  const code = h('span', { class: 'lang-code' });
  const b = h('button', { type: 'button', class: 'ibtn lang-btn', ta: 'lang.button', tip: 'tip.top.lang', 'aria-haspopup': 'menu', dataset: { tipPos: 'bottom', tour: 'language' } }, icon('globe'), code);
  const paint = () => { code.textContent = locale().split('-')[0].toUpperCase(); };
  paint();
  onLocale(paint);
  b.addEventListener('click', () => openMenuAt(b, languageItems()));
  return b;
}

export function helpButton() {
  const b = h('button', { type: 'button', class: 'ibtn help-btn', ta: 'help.button', tip: 'tip.top.help', kb: '?', 'aria-haspopup': 'menu', dataset: { tipPos: 'bottom', tour: 'help' } },
    h('span', { html: '<svg class="ico" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.4a2.5 2.5 0 1 1 3.6 2.3c-.8.4-1.2.9-1.2 1.8v.4"/><path d="M12 16.9v.2"/></svg>' }));
  b.addEventListener('click', () => openMenuAt(b, helpItems()));
  return b;
}

const SHORTCUTS = [
  ['ask', '/'], ['palette', 'Ctrl K'], ['voice', 'Ctrl Space'], ['cycle', 'Ctrl `'], ['cycleBack', 'Ctrl Shift `'],
  ['snapLeft', 'Ctrl Alt Left'], ['snapRight', 'Ctrl Alt Right'], ['max', 'Ctrl Alt Up'], ['min', 'Ctrl Alt Down'],
  ['quarter', 'Ctrl Alt 1 2 3 4'], ['close', 'Ctrl Alt W'], ['menu', 'Shift F10'], ['move', 'Arrows'], ['resize', 'Shift Arrows'], ['help', '?'],
];

export function openShortcuts() {
  const rows = SHORTCUTS.map(([k, kb]) => h('div', { class: 'sc-row' },
    h('span', { class: 'grow', tx: `help.sc.${k}` }),
    h('span', { class: 'sc-keys' }, fmtKeys(kb).map((x) => h('kbd', { class: 'kbd', text: x === 'Arrows' ? t('help.arrows') : x })))));
  return openDialog({ titleKey: 'help.shortcuts', body: h('div', { class: 'sc-list' }, rows) });
}

document.addEventListener('keydown', (e) => {
  if (e.key !== '?' || e.ctrlKey || e.metaKey || e.altKey) return;
  const a = document.activeElement;
  if (a && (/INPUT|TEXTAREA|SELECT/.test(a.tagName) || a.isContentEditable)) return;
  if (document.querySelector('.hd-dlg, .tour-on, .kpal')) return;
  e.preventDefault();
  openShortcuts();
});
