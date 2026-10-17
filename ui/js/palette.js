// Ctrl+K command palette: every window, worker, file and action in one searchable list.

import { h, icon, esc } from './dom.js';
import { beeAvatar } from './bees.js';
import { S, ui } from './store.js';
import { brainInfo } from './brainstate.js';
import * as wm from './wm.js';
import * as act from './actions.js';
import { isMuted, setMuted } from './sound.js';
import { t, fmtKeys } from './i18n.js';
import { widgetLabel } from './dock.js';

let scrim = null;
let box = null;
let returnTo = null;

function score(text, q) {
  if (!q) return { s: 1, marks: [] };
  const t = text.toLowerCase();
  const idx = t.indexOf(q);
  if (idx >= 0) return { s: 100 - idx + (idx === 0 ? 50 : 0), marks: [...Array(q.length)].map((_, i) => idx + i) };
  let ti = 0; const marks = [];
  for (const ch of q) {
    const f = t.indexOf(ch, ti);
    if (f < 0) return null;
    marks.push(f); ti = f + 1;
  }
  const spread = marks[marks.length - 1] - marks[0];
  return { s: 40 - spread, marks };
}

function marked(text, marks) {
  if (!marks.length) return esc(text);
  const set = new Set(marks);
  let out = '';
  for (let i = 0; i < text.length; i++) out += set.has(i) ? `<mark>${esc(text[i])}</mark>` : esc(text[i]);
  return out;
}

function commands(q) {
  const s = S();
  const list = [];
  const add = (group, label, run, opts = {}) => list.push({ group: t(`pal.group.${group}`), label, run, ...opts });
  const bi = brainInfo();
  if (q && bi.canRequest && !ui.replay) add('ask', t('pal.build', { q }), () => act.createJob(q), { icon: 'hive', keep: true, kb: ['Enter'] });
  add('ask', t('pal.newRequest'), () => document.querySelector('#ask')?.focus(), { icon: 'plan', kb: ['/'] });
  if (window.hivedeskVoice?.supported) add('ask', t('pal.voice'), () => window.hivedeskVoice.start(), { icon: 'chat', kb: ['Ctrl', 'Space'] });
  for (const [type, ic] of [['timeline', 'plan'], ['chat', 'chat'], ['files', 'folder'], ['preview', 'preview'], ['runlog', 'terminal'], ['playbooks', 'playbook'], ['replay', 'replay'], ['approvals', 'approval']]) {
    add('open', widgetLabel(type), () => wm.open(type), { icon: ic });
  }
  add('open', t('dock.settings'), () => wm.open('settings'), { icon: 'model' });
  add('open', t('dock.lend'), () => wm.open('lend'), { icon: 'lend' });
  add('open', t('dock.hire'), () => import('./widgets/hire.js').then((m) => m.openHire()), { icon: 'hire' });
  for (const w of s.crew) add('crew', t('pal.chatWith', { name: w.name }), () => wm.open('worker', w.id), { av: w, hint: w.role });
  for (const a of s.approvals || []) {
    add('approvals', t('pal.approve', { what: a.summary || a.tool }), () => act.resolveApproval(a.id, true), { icon: 'check' });
    add('approvals', t('pal.reject', { what: a.summary || a.tool }), () => act.resolveApproval(a.id, false), { icon: 'x' });
  }
  const fid = wm.focusedId();
  if (fid) {
    const title = wm.get(fid)?.titleEl.textContent || '';
    add('window', t('pal.snapLeft', { title }), () => wm.snap(fid, 'left'), { icon: 'arrow', kb: ['Ctrl', 'Alt', 'Left'] });
    add('window', t('pal.snapRight', { title }), () => wm.snap(fid, 'right'), { icon: 'arrow', kb: ['Ctrl', 'Alt', 'Right'] });
    add('window', t('pal.maximize', { title }), () => wm.toggleMax(fid), { icon: 'preview', kb: ['Ctrl', 'Alt', 'Up'] });
    add('window', t('pal.minimize', { title }), () => wm.minimize(fid), { icon: 'stop', kb: ['Ctrl', 'Alt', 'Down'] });
    add('window', t('pal.close', { title }), () => wm.close(fid), { icon: 'x', kb: ['Ctrl', 'Alt', 'W'] });
  }
  add('window', t('pal.next'), () => wm.cycle(1), { icon: 'arrow', kb: ['Ctrl', '`'] });
  add('window', t('pal.arrange'), () => wm.arrange('grid'), { icon: 'hive' });
  add('window', t('pal.cascade'), () => wm.arrange('cascade'), { icon: 'hive' });
  add('window', t('pal.minimizeAll'), () => wm.minimizeAll(), { icon: 'stop' });
  add('window', t('pal.resetLayout'), () => import('./main.js').then((m) => m.resetLayout()), { icon: 'replay' });
  add('settings', isMuted() ? t('pal.soundOn') : t('pal.soundOff'), () => { setMuted(!isMuted()); act.setSettings({ sound: !isMuted() }); }, { icon: 'chat' });
  add('settings', s.settings.approvalMode ? t('pal.approvalOff') : t('pal.approvalOn'), () => act.setSettings({ approvalMode: !s.settings.approvalMode }), { icon: 'lock' });
  add('settings', t('pal.language'), () => import('./help.js').then((m) => m.openLanguageMenu()), { icon: 'globe' });
  if (!bi.canRequest && !ui.replay) add('settings', bi.key === 'none' ? t('pal.chooseModel') : t('pal.modelIs', { label: bi.label }), () => wm.open('settings'), { icon: 'model' });
  add('help', t('pal.tour'), () => import('./tour.js').then((m) => m.startTour()), { icon: 'compass' });
  add('help', t('pal.about'), () => import('./about.js').then((m) => m.openAbout()), { icon: 'hive' });
  add('help', t('pal.shortcuts'), () => import('./help.js').then((m) => m.openShortcuts()), { icon: 'plan' });
  if (ui.replay) add('replay', t('pal.backToLive'), () => import('./store.js').then((m) => m.exitReplay()), { icon: 'arrow' });
  for (const p of s.playbooks || []) add('playbooks', t('pal.usePlaybook', { title: p.title }), () => import('./widgets/playbooks.js').then((m) => m.usePlaybook(p)), { icon: 'playbook' });
  for (const path of Object.keys(s.files).sort().slice(0, 400)) add('files', path, () => wm.open('code', path), { icon: 'code' });
  // Entries from modules outside ui/js (the Code editor, Code together): fn(q) => [{ group, label, run, icon }].
  for (const fn of globalThis.hivedeskPalette || []) { try { list.push(...(fn(q) || [])); } catch (err) { console.error(err); } }
  return list;
}

export function openPalette() {
  if (box) { box.querySelector('input').focus(); return; }
  returnTo = document.activeElement;
  scrim = h('div', { class: 'kpal-scrim', on: { pointerdown: () => closePalette() } });
  const input = h('input', { type: 'text', placeholder: t('pal.placeholder'), 'aria-label': t('pal.command'), role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'kpal-list', 'aria-autocomplete': 'list', autocomplete: 'off', spellcheck: false });
  const listEl = h('div', { class: 'kpal-list', id: 'kpal-list', role: 'listbox', 'aria-label': t('pal.results') });
  box = h('div', { class: 'kpal', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('top.palette') },
    h('div', { class: 'kpal-in' }, h('span', { html: '<svg class="ico" viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.2"/><path d="M15.2 15.2 20 20"/></svg>' }), input, h('kbd', { class: 'kbd', text: fmtKeys('Esc')[0] })),
    listEl,
    h('div', { class: 'kpal-foot' }, h('span', {}, h('kbd', { class: 'kbd', text: t('key.up') }), ' ', h('kbd', { class: 'kbd', text: t('key.down') }), ' ', t('pal.toMove')), h('span', {}, h('kbd', { class: 'kbd', text: t('key.enter') }), ' ', t('pal.toRun')), h('span', { class: 'grow' }), h('span', { class: 'kpal-note', text: t('pal.turns') })));
  document.body.append(scrim, box);
  let results = [];
  let sel = 0;
  const render = () => {
    const q = input.value.trim().toLowerCase();
    const raw = input.value.trim();
    results = commands(raw).map((c) => ({ c, m: c.keep ? { s: -999, marks: [] } : score(c.label, q) })).filter((x) => x.m);
    if (q) results.sort((a, b) => b.m.s - a.m.s);
    results = results.slice(0, 60);
    sel = Math.min(sel, Math.max(0, results.length - 1));
    listEl.replaceChildren();
    if (!results.length) { listEl.append(h('div', { class: 'kpal-empty', text: t('pal.empty') })); input.removeAttribute('aria-activedescendant'); return; }
    let group = null;
    results.forEach(({ c, m }, i) => {
      if (!q && c.group !== group) { group = c.group; listEl.append(h('div', { class: 'kpal-g', role: 'presentation', text: group })); }
      const it = h('div', { class: 'kpal-it', role: 'option', id: `kp-${i}`, 'aria-selected': String(i === sel) },
        c.av ? beeAvatar(c.av, 22, { ring: false }) : icon(c.icon || 'arrow'),
        h('span', { class: 'ellipsis', html: marked(c.label, m.marks) }),
        c.hint ? h('span', { class: 'tiny faint ellipsis', text: c.hint }) : null,
        c.kb ? h('span', { class: 'kb' }, fmtKeys(c.kb.join(' ')).map((k) => h('kbd', { class: 'kbd', text: k }))) : (q ? h('span', { class: 'kb tiny faint', text: c.group }) : null));
      it.addEventListener('pointermove', () => { if (sel !== i) { sel = i; paintSel(); } });
      it.addEventListener('click', () => runAt(i));
      listEl.append(it);
    });
    paintSel();
  };
  const paintSel = () => {
    for (const el of listEl.querySelectorAll('.kpal-it')) el.setAttribute('aria-selected', String(el.id === `kp-${sel}`));
    const cur = listEl.querySelector(`#kp-${sel}`);
    if (cur) { input.setAttribute('aria-activedescendant', cur.id); cur.scrollIntoView({ block: 'nearest' }); }
  };
  const runAt = (i) => {
    const r = results[i];
    if (!r) return;
    closePalette(false);
    try { r.c.run(); } catch (err) { console.error(err); }
  };
  input.addEventListener('input', () => { sel = 0; render(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = (sel + 1) % Math.max(1, results.length); paintSel(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = (sel - 1 + results.length) % Math.max(1, results.length); paintSel(); }
    else if (e.key === 'Home' && e.ctrlKey) { sel = 0; paintSel(); }
    else if (e.key === 'Enter') { e.preventDefault(); runAt(sel); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePalette(); }
    else if (e.key === 'Tab') { e.preventDefault(); }
  });
  render();
  input.focus();
}

export function closePalette(restore = true) {
  scrim?.remove(); box?.remove();
  scrim = box = null;
  if (restore && returnTo && document.contains(returnTo)) returnTo.focus();
}

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'k' || e.key === 'K')) {
    e.preventDefault();
    if (box) closePalette(); else openPalette();
  }
});
