// Ctrl+K command palette: every window, worker, file and action in one searchable list.

import { h, icon, esc } from './dom.js';
import { beeAvatar } from './bees.js';
import { S, ui } from './store.js';
import { brainInfo } from './brainstate.js';
import * as wm from './wm.js';
import * as act from './actions.js';
import { isMuted, setMuted } from './sound.js';

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
  const add = (group, label, run, opts = {}) => list.push({ group, label, run, ...opts });
  const bi = brainInfo();
  if (q && bi.canRequest && !ui.replay) add('Ask the crew', `Build: ${q}`, () => act.createJob(q), { icon: 'hive', keep: true, kb: ['Enter'] });
  add('Ask the crew', 'New request', () => document.querySelector('#ask')?.focus(), { icon: 'plan', kb: ['/'] });
  for (const [type, label, ic] of [['timeline', 'Timeline', 'plan'], ['chat', '#general', 'chat'], ['files', 'Files', 'folder'], ['preview', 'Live preview', 'preview'], ['runlog', 'Run log', 'terminal'], ['playbooks', 'Playbooks', 'playbook'], ['replay', 'Replay', 'replay'], ['approvals', 'Approvals', 'approval'], ['settings', 'Settings', 'model'], ['lend', 'Lend your PC', 'lend']]) {
    add('Open', label, () => wm.open(type), { icon: ic });
  }
  add('Open', 'Hire a worker', () => import('./widgets/hire.js').then((m) => m.openHire()), { icon: 'hire' });
  for (const w of s.crew) add('Crew', `Chat with ${w.name}`, () => wm.open('worker', w.id), { av: w, hint: w.role });
  for (const a of s.approvals || []) {
    add('Approvals', `Approve: ${a.summary || a.tool}`, () => act.resolveApproval(a.id, true), { icon: 'check' });
    add('Approvals', `Reject: ${a.summary || a.tool}`, () => act.resolveApproval(a.id, false), { icon: 'x' });
  }
  const fid = wm.focusedId();
  if (fid) {
    const t = wm.get(fid)?.titleEl.textContent || '';
    add('Window', `Snap ${t} left`, () => wm.snap(fid, 'left'), { icon: 'arrow', kb: ['Ctrl', 'Alt', 'Left'] });
    add('Window', `Snap ${t} right`, () => wm.snap(fid, 'right'), { icon: 'arrow', kb: ['Ctrl', 'Alt', 'Right'] });
    add('Window', `Maximize ${t}`, () => wm.toggleMax(fid), { icon: 'preview', kb: ['Ctrl', 'Alt', 'Up'] });
    add('Window', `Minimize ${t}`, () => wm.minimize(fid), { icon: 'stop', kb: ['Ctrl', 'Alt', 'Down'] });
    add('Window', `Close ${t}`, () => wm.close(fid), { icon: 'x', kb: ['Ctrl', 'Alt', 'W'] });
  }
  add('Window', 'Next window', () => wm.cycle(1), { icon: 'arrow', kb: ['Ctrl', '`'] });
  add('Window', 'Arrange windows', () => wm.arrange('grid'), { icon: 'hive' });
  add('Window', 'Cascade windows', () => wm.arrange('cascade'), { icon: 'hive' });
  add('Window', 'Minimize all', () => wm.minimizeAll(), { icon: 'stop' });
  add('Window', 'Reset layout', () => import('./main.js').then((m) => m.resetLayout()), { icon: 'replay' });
  add('Settings', isMuted() ? 'Turn sounds on' : 'Turn sounds off', () => { setMuted(!isMuted()); act.setSettings({ sound: !isMuted() }); }, { icon: 'chat' });
  add('Settings', s.settings.approvalMode ? 'Turn approval mode off' : 'Turn approval mode on', () => act.setSettings({ approvalMode: !s.settings.approvalMode }), { icon: 'lock' });
  if (!bi.canRequest && !ui.replay) add('Settings', bi.key === 'none' ? 'Choose a model' : `Model: ${bi.label}`, () => wm.open('settings'), { icon: 'model' });
  if (ui.replay) add('Replay', 'Back to live', () => import('./store.js').then((m) => m.exitReplay()), { icon: 'arrow' });
  for (const p of s.playbooks || []) add('Playbooks', `Use playbook: ${p.title}`, () => import('./widgets/playbooks.js').then((m) => m.usePlaybook(p)), { icon: 'playbook' });
  for (const path of Object.keys(s.files).sort().slice(0, 400)) add('Files', path, () => wm.open('code', path), { icon: 'code' });
  return list;
}

export function openPalette() {
  if (box) { box.querySelector('input').focus(); return; }
  returnTo = document.activeElement;
  scrim = h('div', { class: 'kpal-scrim', on: { pointerdown: () => closePalette() } });
  const input = h('input', { type: 'text', placeholder: 'Search windows, workers, files and actions', 'aria-label': 'Command', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'kpal-list', 'aria-autocomplete': 'list', autocomplete: 'off', spellcheck: false });
  const listEl = h('div', { class: 'kpal-list', id: 'kpal-list', role: 'listbox', 'aria-label': 'Results' });
  box = h('div', { class: 'kpal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Command palette' },
    h('div', { class: 'kpal-in' }, h('span', { html: '<svg class="ico" viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.2"/><path d="M15.2 15.2 20 20"/></svg>' }), input, h('kbd', { class: 'kbd', text: 'Esc' })),
    listEl,
    h('div', { class: 'kpal-foot' }, h('span', {}, h('kbd', { class: 'kbd', text: 'Up' }), ' ', h('kbd', { class: 'kbd', text: 'Down' }), ' to move'), h('span', {}, h('kbd', { class: 'kbd', text: 'Enter' }), ' to run'), h('span', { class: 'grow' }), h('span', { text: 'Workers take turns on one model' })));
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
    if (!results.length) { listEl.append(h('div', { class: 'kpal-empty', text: 'Nothing matches. Press Esc to close.' })); input.removeAttribute('aria-activedescendant'); return; }
    let group = null;
    results.forEach(({ c, m }, i) => {
      if (!q && c.group !== group) { group = c.group; listEl.append(h('div', { class: 'kpal-g', role: 'presentation', text: group })); }
      const it = h('div', { class: 'kpal-it', role: 'option', id: `kp-${i}`, 'aria-selected': String(i === sel) },
        c.av ? beeAvatar(c.av, 22, { ring: false }) : icon(c.icon || 'arrow'),
        h('span', { class: 'ellipsis', html: marked(c.label, m.marks) }),
        c.hint ? h('span', { class: 'tiny faint ellipsis', text: c.hint }) : null,
        c.kb ? h('span', { class: 'kb' }, c.kb.map((k) => h('kbd', { class: 'kbd', text: k }))) : (q ? h('span', { class: 'kb tiny faint', text: c.group }) : null));
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
