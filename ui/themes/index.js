// Themes on the desktop: applies the chosen theme as CSS custom properties (live, with no
// reload), the Theme gallery window, the visual editor with a contrast report, import and
// export of .hivedesk-theme.json files, and the "create a theme with the crew" preview.

import { h, icon } from '../js/dom.js';
import * as wm from '../js/wm.js';
import * as net from '../js/net.js';
import { notify } from '../js/notify.js';
import { preview as previewChime } from '../js/sound.js';
import {
  validateTheme, themeVars, checkContrast, fixContrast, serializeTheme, COLOR_KEYS, PATTERNS, SHADOWS, SOUND_PACKS,
  FONT_PRESETS, MONO_PRESETS, FILE_SUFFIX, BASE, slug
} from './core.js';
import { PACKS, previewPack } from './sounds.js';
import { tr, tx, onLang } from '../extensions/strings.js';

const root = document.documentElement;
const KEY = 'hivedesk.theme';
const SYSTEM = 'system';

const store = {
  themes: [],
  /** { mode: 'theme', theme } or { mode: 'system', light, dark } */
  choice: null,
  active: null,
  listeners: new Set(),
  drafts: new Map(),
};

const changed = () => { for (const fn of store.listeners) { try { fn(); } catch (err) { console.error(err); } } };
export const onThemes = (fn) => { store.listeners.add(fn); return () => store.listeners.delete(fn); };
export const themes = () => store.themes;
export const activeTheme = () => store.active;

/* ---------- applying ---------- */

let motionSetByTheme = false;
let tryOn = null; // a theme shown on the desktop by the editor, not saved

function paint(theme) {
  const vars = themeVars(theme);
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  root.dataset.hdTheme = theme.id;
  root.dataset.hdScheme = theme.scheme;
  // Widgets and Lend read these too.
  root.style.setProperty('--hd-accent-ink', theme.colors.accentInk);
  root.style.setProperty('--hd-ok', theme.colors.ok);
  root.style.setProperty('--hd-bad', theme.colors.bad);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme.colors.bg);
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', theme.scheme);
  let userMotion = null;
  try { userMotion = localStorage.getItem('hivedesk.motion'); } catch {}
  if (!userMotion) {
    if (theme.motion === 0) { root.dataset.motion = 'reduce'; motionSetByTheme = true; }
    else if (motionSetByTheme) { delete root.dataset.motion; motionSetByTheme = false; }
  }
  globalThis.hivedeskSoundPack = PACKS[theme.sound] || null;
  for (const fn of frameListeners) { try { fn(theme); } catch (err) { console.error(err); } }
}

const frameListeners = new Set();
/** Extension widget frames follow the theme through this. */
export const onPaint = (fn) => { frameListeners.add(fn); return () => frameListeners.delete(fn); };

const darkMq = matchMedia('(prefers-color-scheme: dark)');

function resolveChoice(choice) {
  if (!choice) return BASE;
  if (choice.mode === SYSTEM) {
    const want = darkMq.matches ? choice.dark : choice.light;
    return store.themes.find((t) => t.id === want) || (darkMq.matches ? choice.darkTheme : choice.lightTheme) || BASE;
  }
  return store.themes.find((t) => t.id === choice.theme?.id && t.source !== 'user') || store.themes.find((t) => t.id === choice.theme?.id) || choice.theme || BASE;
}

function refreshActive() {
  if (tryOn) return paint(tryOn);
  const theme = validateTheme(resolveChoice(store.choice), { partial: true }).theme || BASE;
  store.active = theme;
  paint(theme);
  changed();
}

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(store.choice)); } catch {}
}

/** Applies a theme and remembers it (the full tokens are kept so the next start has no flash). */
export function applyTheme(theme) {
  const v = validateTheme(theme, { partial: true });
  if (!v.theme) return false;
  store.choice = { mode: 'theme', theme: v.theme };
  save();
  refreshActive();
  return true;
}

export function followSystem(lightId, darkId) {
  const find = (id) => store.themes.find((t) => t.id === id);
  store.choice = { mode: SYSTEM, light: lightId, dark: darkId, lightTheme: find(lightId), darkTheme: find(darkId) };
  save();
  refreshActive();
}

darkMq.addEventListener?.('change', () => { if (store.choice?.mode === SYSTEM) refreshActive(); });

// Boot: paint the saved theme right away, before the first frame from the engine.
try { store.choice = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { store.choice = null; }
if (store.choice) refreshActive();

export async function loadThemes() {
  try {
    const r = await fetch('/api/themes', { credentials: 'same-origin', cache: 'no-store' });
    if (!r.ok) throw new Error(String(r.status));
    store.themes = (await r.json()).themes || [];
  } catch {
    try { store.themes = (await net.command('themes.list')).themes || []; } catch { /* keep what we have */ }
  }
  if (store.choice) refreshActive();
  else { store.active = store.themes.find((t) => t.id === 'mel') || BASE; changed(); }
  return store.themes;
}

/* ---------- helpers ---------- */

function download(name, text) {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'application/json' })), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

export function exportTheme(theme) {
  download(`${theme.id || slug(theme.name)}${FILE_SUFFIX}`, serializeTheme(theme));
}

function pickFile(accept) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, style: 'display:none' });
    input.addEventListener('change', () => { resolve(input.files?.[0] || null); input.remove(); });
    document.body.append(input);
    input.click();
  });
}

export async function importTheme() {
  const f = await pickFile('.json,application/json');
  if (!f) return null;
  let data;
  try { data = JSON.parse(await f.text()); } catch { data = null; }
  const v = validateTheme(data);
  if (!v.ok) { notify({ title: tr('themes.importFailed'), body: v.errors.slice(0, 3).join('; '), tone: 'bad' }); return null; }
  try {
    const r = await net.command('themes.save', { theme: v.theme });
    await loadThemes();
    notify({ title: tr('themes.imported'), body: r.theme.name, tone: 'ok' });
    return r.theme;
  } catch (err) {
    notify({ title: tr('themes.importFailed'), body: err.message, tone: 'bad' });
    return null;
  }
}

/** A small desktop drawn with the theme's own variables (scoped to the element). */
export function previewCard(theme, { big = false } = {}) {
  const el = h('div', { class: `thp${big ? ' thp-big' : ''}`, 'aria-hidden': 'true' },
    h('div', { class: 'thp-desk' },
      h('div', { class: 'thp-bar' }, h('span', { class: 'thp-logo' }), h('span', { class: 'thp-ask' }), h('span', { class: 'thp-pill' })),
      h('div', { class: 'thp-win' },
        h('div', { class: 'thp-wbar' }, h('span', { class: 'thp-glyph' }), h('b', { text: theme.name }), h('i', { text: 'Timeline' })),
        h('div', { class: 'thp-wbody' },
          h('p', { class: 'thp-t', text: 'Dev wrote index.html' }),
          h('p', { class: 'thp-m', text: 'QA is checking the links' }),
          h('div', { class: 'thp-row' }, h('span', { class: 'thp-btn', text: 'Approve' }), h('span', { class: 'thp-chip ok', text: 'done' }), h('span', { class: 'thp-chip bad', text: '1 issue' })))),
      h('div', { class: 'thp-dock' }, h('span'), h('span'), h('span'), h('span'))));
  paintScoped(el, theme);
  return el;
}

function paintScoped(el, theme) {
  for (const [k, v] of Object.entries(themeVars(theme))) el.style.setProperty(k, v);
}

const labelOf = (theme) => (theme.source === 'extension' ? tr('themes.source.extension', { name: theme.extension }) : tr(`themes.source.${theme.source || 'user'}`));

/* ---------- gallery window ---------- */

function galleryCreate(ctx) {
  const body = h('div', { class: 'thg' });
  ctx.body.append(body);
  ctx.body.classList.add('thg-host');
  ctx.setGlyph(icon('design'));
  const createIn = h('input', { class: 'field-in grow', type: 'text', maxLength: 300, autocomplete: 'off' });
  const createBtn = h('button', { class: 'btn btn-sm btn-primary', type: 'button' }, icon('sparkle', 'ico-sm'), tx(h('span'), 'themes.create.go'));
  const status = h('p', { class: 'tiny faint thg-status', role: 'status', 'aria-live': 'polite' });
  const head = h('div', { class: 'thg-head' },
    h('label', { class: 'thg-create' }, tx(h('span', { class: 'tiny faint' }), 'themes.create.label'), h('div', { class: 'row' }, createIn, createBtn)),
    status,
    h('div', { class: 'row thg-tools' },
      h('button', { class: 'btn btn-xs btn-quiet', type: 'button', on: { click: () => importTheme() } }, icon('download', 'ico-sm'), tx(h('span'), 'themes.import')),
      h('button', { class: 'btn btn-xs btn-quiet', type: 'button', on: { click: () => openEditor({ ...BASE, id: 'my-theme', name: 'My theme', author: '', source: 'draft' }) } }, icon('design', 'ico-sm'), tx(h('span'), 'themes.new'))));
  const grid = h('div', { class: 'thg-grid', role: 'list' });
  body.append(head, grid);
  const setPh = () => { createIn.placeholder = tr('themes.create.placeholder'); createIn.setAttribute('aria-label', tr('themes.create.label')); };
  setPh();

  const ask = async () => {
    const prompt = createIn.value.trim() || tr('themes.create.placeholder');
    createBtn.disabled = true;
    tx(status, 'themes.create.working');
    try {
      await net.command('themes.generate', { prompt });
      createIn.value = '';
    } catch (err) {
      status.textContent = err.code === 'conflict' ? tr('themes.create.noModel') : `${tr('themes.create.failed')}: ${err.message}`;
      createBtn.disabled = false;
    }
  };
  createBtn.addEventListener('click', ask);
  createIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); ask(); } });
  const offGen = onGenerated(() => { createBtn.disabled = false; status.textContent = ''; });

  const render = () => {
    setPh();
    const list = store.themes;
    ctx.setSub(tr('themes.subtitle', { count: list.length }));
    grid.replaceChildren();
    const activeId = store.active?.id;
    const sys = store.choice?.mode === SYSTEM;
    for (const theme of list) {
      const isActive = !sys && activeId === theme.id;
      const card = h('div', { class: `thc${isActive ? ' on' : ''}`, role: 'listitem' },
        previewCard(theme),
        h('div', { class: 'thc-meta' },
          h('div', { class: 'row' }, h('b', { class: 'grow ellipsis', text: theme.name }),
            isActive ? tx(h('span', { class: 'hchip hchip-honey' }), 'themes.active') : null,
            tx(h('span', { class: 'hchip' }), theme.scheme === 'light' ? 'themes.light' : 'themes.dark')),
          h('p', { class: 'tiny faint thc-desc', text: theme.description || '' }),
          h('div', { class: 'row thc-actions' },
            h('button', { class: 'btn btn-xs btn-primary', type: 'button', disabled: isActive, on: { click: () => { applyTheme(theme); notify({ title: tr('themes.applied', { name: theme.name }), tone: 'ok', timeout: 2200 }); } } }, tx(h('span'), 'themes.apply')),
            h('button', { class: 'btn btn-xs btn-quiet', type: 'button', on: { click: () => openEditor(theme.source === 'user' ? theme : { ...theme, id: `${theme.id}-copy`, name: `${theme.name} 2`, source: 'draft' }) } }, tx(h('span'), theme.source === 'user' ? 'themes.edit' : 'themes.duplicate')),
            h('button', { class: 'btn btn-xs btn-quiet', type: 'button', on: { click: () => exportTheme(theme) } }, tx(h('span'), 'themes.export')),
            h('span', { class: 'grow' }),
            h('span', { class: 'tiny faint', text: labelOf(theme) }),
            theme.source === 'user' ? h('button', { class: 'ibtn ibtn-sm', type: 'button', 'aria-label': tr('themes.delete'), title: tr('themes.delete'), on: { click: () => removeTheme(theme) } }, icon('x', 'ico-sm')) : null)));
      grid.append(card);
    }
    grid.append(systemCard(list, sys));
  };
  const off = onThemes(render);
  const offLang = onLang(render);
  ctx.onDispose(() => { off(); offLang(); offGen(); });
  render();
  if (!store.themes.length) loadThemes();
}

function systemCard(list, on) {
  const lights = list.filter((t) => t.scheme === 'light');
  const darks = list.filter((t) => t.scheme === 'dark');
  const cur = store.choice?.mode === SYSTEM ? store.choice : { light: lights[0]?.id || 'colmeia-clara', dark: 'mel' };
  const sel = (items, value) => h('select', { class: 'field-sel' }, items.map((t) => h('option', { value: t.id, text: t.name, selected: t.id === value })));
  const lightSel = sel(lights, cur.light);
  const darkSel = sel(darks, cur.dark);
  const half = (t) => (t ? previewCard(t) : h('div', { class: 'thp' }));
  const prev = h('div', { class: 'thp-split' }, half(lights.find((t) => t.id === cur.light)), half(darks.find((t) => t.id === cur.dark)));
  const apply = () => { followSystem(lightSel.value, darkSel.value); notify({ title: tr('themes.applied', { name: tr('themes.system.name') }), tone: 'ok', timeout: 2200 }); };
  lightSel.addEventListener('change', () => { if (on) apply(); });
  darkSel.addEventListener('change', () => { if (on) apply(); });
  return h('div', { class: `thc thc-system${on ? ' on' : ''}`, role: 'listitem' }, prev,
    h('div', { class: 'thc-meta' },
      h('div', { class: 'row' }, tx(h('b', { class: 'grow' }), 'themes.system.name'), on ? tx(h('span', { class: 'hchip hchip-honey' }), 'themes.active') : null),
      tx(h('p', { class: 'tiny faint thc-desc' }), 'themes.system.desc'),
      h('div', { class: 'thc-sys' }, h('label', {}, tx(h('span', { class: 'tiny faint' }), 'themes.system.light'), lightSel), h('label', {}, tx(h('span', { class: 'tiny faint' }), 'themes.system.dark'), darkSel)),
      h('div', { class: 'row thc-actions' }, h('button', { class: 'btn btn-xs btn-primary', type: 'button', disabled: on, on: { click: apply } }, tx(h('span'), 'themes.apply')))));
}

async function removeTheme(theme) {
  try {
    await net.command('themes.delete', { id: theme.id });
    if (store.active?.id === theme.id) applyTheme(store.themes.find((t) => t.id === 'mel') || BASE);
    await loadThemes();
    notify({ title: tr('themes.deleted'), body: theme.name, tone: 'info', timeout: 2200 });
  } catch (err) {
    notify({ title: tr('extensions.notify.failed'), body: err.message, tone: 'bad' });
  }
}

/* ---------- editor window ---------- */

let draftSeq = 0;

/**
 * Opens the editor on a copy of `theme`. `ai` carries the "create with the crew" result
 * (prompt, fixes) and shows the approve banner.
 */
export function openEditor(theme, ai = null) {
  const key = `d${++draftSeq}`;
  const v = validateTheme(theme, { partial: true });
  store.drafts.set(key, { theme: v.theme, ai, original: theme.source === 'user' ? theme.id : null });
  return wm.open('theme-editor', key, { focus: true });
}

function slider(label, value, min, max, step, onInput, fmt = (x) => String(x)) {
  const out = h('output', { class: 'tiny faint', text: fmt(value) });
  const input = h('input', { type: 'range', min, max, step, value, class: 'the-range' });
  input.addEventListener('input', () => { out.textContent = fmt(Number(input.value)); onInput(Number(input.value)); });
  const lab = h('label', { class: 'the-f' }, h('span', { class: 'row' }, tx(h('span', { class: 'grow tiny' }), label), out), input);
  lab.set = (x) => { input.value = x; out.textContent = fmt(x); };
  return lab;
}

function select(label, value, options, onChange) {
  const s = h('select', { class: 'field-sel' }, options.map(([v, k]) => tx(h('option', { value: v, selected: v === value }), k)));
  s.addEventListener('change', () => onChange(s.value));
  const lab = h('label', { class: 'the-f' }, tx(h('span', { class: 'tiny' }), label), s);
  lab.set = (x) => { s.value = x; };
  return lab;
}

function editorCreate(ctx, key) {
  const d = store.drafts.get(key);
  if (!d) { ctx.body.append(h('p', { class: 'state', text: '...' })); setTimeout(() => ctx.close(), 0); return; }
  let theme = JSON.parse(JSON.stringify(d.theme));
  ctx.setGlyph(icon('design'));
  ctx.setTitle(tr('themes.editor.title'));
  ctx.setSub(theme.name);
  const wrap = h('div', { class: 'the' });
  ctx.body.append(wrap);
  const prevHost = h('div', { class: 'the-prev' });
  const contrastBox = h('div', { class: 'the-contrast', role: 'status', 'aria-live': 'polite' });
  const form = h('div', { class: 'the-form' });
  const tryBox = h('input', { type: 'checkbox' });
  const fields = [];

  const update = () => {
    const v = validateTheme(theme, { partial: true });
    theme = v.theme;
    prevHost.replaceChildren(previewCard(theme, { big: true }));
    ctx.setSub(theme.name);
    paintContrast();
    if (tryBox.checked) { tryOn = theme; paint(theme); }
  };

  const paintContrast = () => {
    const rows = checkContrast(theme);
    const bad = rows.filter((r) => !r.ok);
    const list = h('ul', { class: 'the-cl' }, rows.filter((r, i, a) => a.findIndex((x) => x.fg === r.fg) === i || !r.ok).slice(0, 14).map((r) => {
      const worst = rows.filter((x) => x.fg === r.fg).reduce((a, b) => (b.ratio < a.ratio ? b : a));
      return h('li', { class: worst.ok ? 'ok' : 'bad' }, h('span', { class: 'the-sw', style: `background:${theme.colors[worst.on]};color:${theme.colors[worst.fg]}`, text: 'Aa' }),
        h('span', { class: 'grow ellipsis', text: `${tr(`themes.color.${worst.fg}`)} / ${tr(`themes.color.${worst.on}`)}` }),
        h('span', { class: 'hchip-mono tiny', text: `${worst.ratio.toFixed(2)} : 1` }), h('span', { class: `hchip ${worst.ok ? 'hchip-ok' : 'hchip-bad'}`, text: `${worst.min}` }));
    }).filter((el, i, arr) => arr.findIndex((x) => x.textContent === el.textContent) === i));
    const fixBtn = h('button', { class: 'btn btn-xs btn-primary', type: 'button', disabled: !bad.length }, icon('wand', 'ico-sm'), tx(h('span'), 'themes.contrast.fix'));
    fixBtn.addEventListener('click', () => {
      const r = fixContrast(theme);
      theme = r.theme;
      for (const f of fields) f.sync?.();
      update();
      notify({ title: tr('themes.contrast.fixed', { count: r.fixes.length }), body: r.fixes.map((x) => `${tr(`themes.color.${x.key}`)} ${x.from} > ${x.to}`).join(', '), tone: 'ok', timeout: 4000 });
    });
    contrastBox.replaceChildren(
      h('div', { class: 'row' }, tx(h('b', { class: 'grow' }), 'themes.contrast.title'), fixBtn),
      bad.length ? tx(h('p', { class: 'tiny the-bad' }), 'themes.contrast.bad', { count: bad.length }) : tx(h('p', { class: 'tiny the-ok' }), 'themes.contrast.ok'),
      list);
  };

  const section = (k, ...kids) => h('section', { class: 'the-s' }, tx(h('h3'), k), ...kids);
  const nameIn = h('input', { class: 'field-in', type: 'text', value: theme.name, maxLength: 40 });
  nameIn.addEventListener('input', () => { theme.name = nameIn.value || 'Untitled'; theme.id = slug(nameIn.value || 'theme'); update(); });
  const descIn = h('input', { class: 'field-in', type: 'text', value: theme.description, maxLength: 160 });
  descIn.addEventListener('input', () => { theme.description = descIn.value; });
  const scheme = select('themes.editor.scheme', theme.scheme, [['dark', 'themes.dark'], ['light', 'themes.light']], (x) => { theme.scheme = x; update(); });
  fields.push(Object.assign(scheme, { sync: () => scheme.set(theme.scheme) }));

  const colorGrid = h('div', { class: 'the-colors' });
  for (const k of COLOR_KEYS) {
    const pick = h('input', { type: 'color', value: theme.colors[k].toLowerCase(), 'aria-label': tr(`themes.color.${k}`) });
    const hex = h('input', { class: 'field-in the-hex', type: 'text', value: theme.colors[k], maxLength: 7, spellcheck: false, 'aria-label': `${tr(`themes.color.${k}`)} hex` });
    pick.addEventListener('input', () => { theme.colors[k] = pick.value.toUpperCase(); hex.value = theme.colors[k]; update(); });
    hex.addEventListener('change', () => { if (/^#[0-9a-fA-F]{6}$/.test(hex.value.trim())) { theme.colors[k] = hex.value.trim().toUpperCase(); pick.value = theme.colors[k].toLowerCase(); update(); } else hex.value = theme.colors[k]; });
    fields.push({ sync: () => { pick.value = theme.colors[k].toLowerCase(); hex.value = theme.colors[k]; } });
    colorGrid.append(h('label', { class: 'the-c' }, pick, h('span', { class: 'grow' }, tx(h('span', { class: 'tiny' }), `themes.color.${k}`), hex)));
  }
  const px = (x) => `${x} px`;
  const pct = (x) => `${Math.round(x * 100)}%`;
  const add = (el, sync) => { fields.push(Object.assign(el, { sync })); return el; };
  const rW = add(slider('themes.editor.radiusWindow', theme.radius.window, 0, 28, 1, (x) => { theme.radius.window = x; update(); }, px), () => rW.set(theme.radius.window));
  const rC = add(slider('themes.editor.radiusControl', theme.radius.control, 0, 20, 1, (x) => { theme.radius.control = x; update(); }, px), () => rC.set(theme.radius.control));
  const rS = add(slider('themes.editor.radiusSmall', theme.radius.small, 0, 14, 1, (x) => { theme.radius.small = x; update(); }, px), () => rS.set(theme.radius.small));
  const ln = add(slider('themes.editor.lines', theme.lines, 0.5, 4, 0.1, (x) => { theme.lines = x; update(); }, (x) => `${x.toFixed(1)}x`), () => ln.set(theme.lines));
  const fontName = (k) => `themes.font.${k}`;
  const fS = add(select('themes.editor.fontSans', FONT_PRESETS[theme.fonts.sans] ? theme.fonts.sans : 'system', Object.keys(FONT_PRESETS).map((k) => [k, fontName(k)]), (x) => { theme.fonts.sans = x; update(); }), () => fS.set(theme.fonts.sans));
  const fM = add(select('themes.editor.fontMono', MONO_PRESETS[theme.fonts.mono] ? theme.fonts.mono : 'system', Object.keys(MONO_PRESETS).map((k) => [k, fontName(k)]), (x) => { theme.fonts.mono = x; update(); }), () => fM.set(theme.fonts.mono));
  const shS = add(select('themes.editor.shadowStyle', theme.shadow.style, SHADOWS.map((k) => [k, `themes.shadow.${k}`]), (x) => { theme.shadow.style = x; update(); }), () => shS.set(theme.shadow.style));
  const shK = add(slider('themes.editor.shadowStrength', theme.shadow.strength, 0, 2, 0.05, (x) => { theme.shadow.strength = x; update(); }, pct), () => shK.set(theme.shadow.strength));
  const pK = add(select('themes.editor.patternKind', theme.pattern.kind, PATTERNS.map((k) => [k, `themes.pattern.${k}`]), (x) => { theme.pattern.kind = x; update(); }), () => pK.set(theme.pattern.kind));
  const pColor = h('input', { type: 'color', value: theme.pattern.color.toLowerCase() });
  pColor.addEventListener('input', () => { theme.pattern.color = pColor.value.toUpperCase(); update(); });
  fields.push({ sync: () => { pColor.value = theme.pattern.color.toLowerCase(); } });
  const pO = add(slider('themes.editor.patternOpacity', theme.pattern.opacity, 0, 0.3, 0.005, (x) => { theme.pattern.opacity = x; update(); }, pct), () => pO.set(theme.pattern.opacity));
  const pS = add(slider('themes.editor.patternSize', theme.pattern.size, 16, 120, 2, (x) => { theme.pattern.size = x; update(); }, px), () => pS.set(theme.pattern.size));
  const mo = add(slider('themes.editor.motion', theme.motion, 0, 1.5, 0.05, (x) => { theme.motion = x; update(); }, pct), () => mo.set(theme.motion));
  const so = add(select('themes.editor.sound', theme.sound, SOUND_PACKS.map((k) => [k, `themes.sound.${k}`]), (x) => { theme.sound = x; previewSound(x); update(); }), () => so.set(theme.sound));
  const play = h('button', { class: 'btn btn-xs btn-quiet', type: 'button', on: { click: () => previewSound(theme.sound) } }, tx(h('span'), 'themes.editor.playSound'));

  form.append(
    section('themes.editor.preview', h('label', { class: 'the-f' }, tx(h('span', { class: 'tiny' }), 'themes.editor.name'), nameIn), h('label', { class: 'the-f' }, tx(h('span', { class: 'tiny' }), 'themes.editor.description'), descIn), scheme),
    section('themes.editor.colors', colorGrid),
    section('themes.editor.shape', rW, rC, rS, ln),
    section('themes.editor.type', fS, fM),
    section('themes.editor.depth', shS, shK),
    section('themes.editor.pattern', pK, h('label', { class: 'the-f the-inline' }, tx(h('span', { class: 'tiny grow' }), 'themes.editor.patternColor'), pColor), pO, pS),
    section('themes.editor.feel', mo, h('div', { class: 'row' }, so, play)));

  const banner = d.ai ? h('div', { class: 'honest the-ai' }, icon('sparkle'),
    h('div', { class: 'grow' },
      h('b', { text: tr('themes.ai.banner', { prompt: d.ai.prompt }) }),
      h('p', { class: 'tiny', text: d.ai.fallback ? tr('themes.ai.fallback') : d.ai.fixes?.length ? tr('themes.ai.fixes', { list: d.ai.fixes.map((f) => `${tr(`themes.color.${f.key}`)} ${f.from} > ${f.to}`).join(', ') }) : tr('themes.ai.noFixes') }))) : null;

  const doSave = async (alsoApply) => {
    try {
      const r = await net.command('themes.save', { theme: { ...theme, author: theme.author || '' } });
      if (d.original && d.original !== r.theme.id) await net.command('themes.delete', { id: d.original }).catch(() => {});
      d.original = r.theme.id;
      await loadThemes();
      if (alsoApply) applyTheme(r.theme);
      notify({ title: tr('themes.saved'), body: r.theme.name, tone: 'ok', timeout: 2400 });
      return r.theme;
    } catch (err) {
      notify({ title: tr('extensions.notify.failed'), body: err.message, tone: 'bad' });
      return null;
    }
  };
  tryBox.addEventListener('change', () => { if (tryBox.checked) { tryOn = theme; paint(theme); } else { tryOn = null; refreshActive(); } });
  const foot = h('div', { class: 'the-foot' },
    h('label', { class: 'row tiny' }, tryBox, tx(h('span'), 'themes.editor.tryOn')),
    h('span', { class: 'grow' }),
    h('button', { class: 'btn btn-xs btn-quiet', type: 'button', on: { click: () => exportTheme(theme) } }, tx(h('span'), 'themes.export')),
    h('button', { class: 'btn btn-xs btn-quiet', type: 'button', on: { click: () => doSave(false) } }, tx(h('span'), 'themes.editor.save')),
    h('button', { class: 'btn btn-xs btn-primary', type: 'button', on: { click: async () => { if (await doSave(true)) ctx.close(); } } }, tx(h('span'), d.ai ? 'themes.ai.approve' : 'themes.editor.saveApply')));
  wrap.append(h('div', { class: 'the-side' }, banner, prevHost, contrastBox), form, foot);
  ctx.onDispose(() => { if (tryOn) { tryOn = null; refreshActive(); } store.drafts.delete(key); });
  if (d.ai) { tryBox.checked = true; tryOn = theme; }
  update();
}

function previewSound(pack) {
  if (pack === 'chime') previewChime('job');
  else previewPack(pack, 'job');
}

/* ---------- engine events: the crew made a theme ---------- */

const genListeners = new Set();
const onGenerated = (fn) => { genListeners.add(fn); return () => genListeners.delete(fn); };

net.on('event', (f) => {
  const ev = f.event;
  if (ev?.type === 'theme.generated') {
    for (const fn of genListeners) fn(ev.data);
    if (Date.now() - new Date(ev.ts).getTime() < 120_000) openEditor(ev.data.theme, ev.data);
  } else if (ev?.type === 'theme.failed') {
    for (const fn of genListeners) fn(null);
    notify({ title: tr('themes.create.failed'), body: ev.data?.error || '', tone: 'bad' });
  } else if (ev?.type === 'extension.enabled' || ev?.type === 'extension.disabled' || ev?.type === 'extension.uninstalled') {
    loadThemes();
  }
});
net.on('hello', () => { loadThemes(); });

/* ---------- registration ---------- */

wm.register('themes', { title: () => tr('themes.title'), glyph: () => icon('design'), icon: 'design', size: [760, 600], min: [340, 320], cardH: 620, create: galleryCreate });
wm.register('theme-editor', { title: () => tr('themes.editor.title'), glyph: () => icon('design'), icon: 'design', size: [900, 640], min: [340, 360], cardH: 760, multi: true, create: editorCreate });

// Command palette entries (ui/js/palette.js reads globalThis.hivedeskPalette).
(globalThis.hivedeskPalette = globalThis.hivedeskPalette || []).push((q) => {
  const g = tr('themes.palette.group');
  const out = [{ group: g, label: tr('themes.palette.open'), run: () => wm.open('themes'), icon: 'design' }];
  for (const theme of store.themes) out.push({ group: g, label: tr('themes.palette.use', { name: theme.name }), run: () => applyTheme(theme), icon: 'design', hint: theme.description });
  if (q && q.length > 3) out.push({ group: g, label: tr('themes.palette.create', { prompt: q }), run: () => net.command('themes.generate', { prompt: q }).catch((err) => notify({ title: tr('themes.create.failed'), body: err.message, tone: 'bad' })), icon: 'sparkle' });
  return out;
});

const link = document.createElement('link');
link.rel = 'stylesheet';
link.href = '/themes/themes.css';
document.head.append(link);

/* ---------- dock ---------- */
function addDock() {
  if (!document.querySelector('.dock-shelf')) { setTimeout(addDock, 300); return; }
  import('../js/dock.js').then(({ addDockItem }) => {
    addDockItem?.({ id: 'themes', label: tr('themes.title'), sub: () => store.active?.name || '', content: h('span', { class: 'dk-hex' }, icon('design')), onClick: () => wm.toggleFromDock('themes') });
  }).catch(() => {});
}
addDock();
