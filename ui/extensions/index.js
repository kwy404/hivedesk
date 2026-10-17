// Extensions on the desktop: the Extensions window (installed list, enable and disable,
// permissions, uninstall, install from a folder, a zip or a URL, create with the crew), the
// permission prompt, widget windows in sandboxed frames, and palette commands.

import { h, icon } from '../js/dom.js';
import * as wm from '../js/wm.js';
import * as net from '../js/net.js';
import { notify } from '../js/notify.js';
import * as act from '../js/actions.js';
import { buildSrcdoc, validateWidgetMessage, permissionFor, WIDGET_VARS } from './bridge.js';
import { tr, tx, onLang, permLabel } from './strings.js';
import { onPaint, applyTheme, themes as themeList, loadThemes } from '../themes/index.js';

const state = { list: [], devDir: '', isolated: true, loaded: false, dev: new Map(), listeners: new Set() };
const changed = () => { for (const fn of state.listeners) { try { fn(); } catch (err) { console.error(err); } } };
const onChange = (fn) => { state.listeners.add(fn); return () => state.listeners.delete(fn); };

async function call(type, data) {
  try { return await net.command(type, data, { timeout: 60000 }); } catch (err) {
    notify({ title: tr('extensions.notify.failed'), body: err.message, tone: 'bad', sound: 'error' });
    return null;
  }
}

export async function refresh() {
  try {
    const r = await net.command('extensions.list');
    state.list = r.extensions || [];
    state.devDir = r.devDir || '';
    state.isolated = r.isolated !== false;
    state.loaded = true;
    changed();
  } catch { /* the engine may not have the plug-in */ }
  return state.list;
}

const byId = (id) => state.list.find((e) => e.id === id);

/* ---------- permission prompt ---------- */

/** Shows the permissions an extension asks for. Resolves true when the user approved. */
export function review(ext, { risk } = {}) {
  return new Promise((resolve) => {
    const dlg = h('dialog', { class: 'dlg ext-dlg', 'aria-labelledby': 'ext-dlg-t' });
    const checks = [];
    const list = ext.permissions.length
      ? h('ul', { class: 'ext-perms' }, ext.permissions.map((p) => {
        const c = h('input', { type: 'checkbox', checked: true, value: p.permission });
        checks.push(c);
        return h('li', { class: `risk-${p.risk}` }, h('label', { class: 'row' }, c, h('span', { class: 'grow' }, h('span', { text: permLabel(p) }), h('code', { class: 'tiny faint', text: ` ${p.permission}` })),
          tx(h('span', { class: `hchip ${p.risk === 'high' ? 'hchip-bad' : p.risk === 'medium' ? 'hchip-warn' : 'hchip-ok'}` }), `extensions.risk.${p.risk}`)));
      }))
      : tx(h('p', { class: 'tiny faint' }), 'extensions.dialog.none');
    const trust = h('input', { type: 'checkbox' });
    const isUrl = risk === 'url' || ext.source === 'url';
    const ok = h('button', { class: 'btn btn-sm btn-primary', type: 'button', disabled: isUrl }, tx(h('span'), 'extensions.dialog.approve'));
    trust.addEventListener('change', () => { ok.disabled = !trust.checked; });
    const cancel = h('button', { class: 'btn btn-sm btn-quiet', type: 'button' }, tx(h('span'), 'extensions.dialog.cancel'));
    dlg.append(
      h('div', { class: 'dlg-h' }, icon('lock'), tx(h('h2', { id: 'ext-dlg-t' }), 'extensions.dialog.title', { name: ext.name })),
      h('div', { class: 'dlg-b' },
        tx(h('p'), 'extensions.dialog.lead', { name: ext.name, version: ext.version, author: ext.author || '?' }),
        h('p', { class: 'tiny faint', text: ext.description }),
        list,
        isUrl ? h('div', { class: 'honest bad' }, icon('lock'), h('div', {}, tx(h('p', { class: 'tiny' }), 'extensions.add.urlWarning'), h('label', { class: 'row tiny' }, trust, tx(h('span'), 'extensions.dialog.trust')))) : null,
        tx(h('p', { class: 'tiny faint' }), state.isolated ? 'extensions.sandbox.on' : 'extensions.sandbox.off')),
      h('div', { class: 'dlg-f' }, cancel, ok));
    document.body.append(dlg);
    const done = async (yes) => {
      if (yes) {
        const grant = checks.filter((c) => c.checked).map((c) => c.value);
        const r = await call('extensions.approve', { id: ext.id, grant, acceptRisk: isUrl ? trust.checked : undefined });
        if (!r) return;
        notify({ title: tr('extensions.notify.on', { name: ext.name }), tone: 'ok', timeout: 2600 });
        await refresh();
      }
      dlg.close();
      dlg.remove();
      resolve(!!yes);
    };
    ok.addEventListener('click', () => done(true));
    cancel.addEventListener('click', () => done(false));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); done(false); });
    dlg.showModal();
    (isUrl ? trust : ok).focus();
  });
}

/** After an install: show the prompt, then open what the extension adds. */
async function afterStage(r) {
  if (!r) return;
  await refresh();
  const ext = byId(r.extension.id) || r.extension;
  notify({ title: tr('extensions.add.staged', { name: ext.name }), tone: 'info', timeout: 2600 });
  if (await review(ext, { risk: r.risk })) openContributions(byId(ext.id) || ext);
}

function openContributions(ext) {
  const w = ext.contributes?.widgets?.[0];
  if (w) { wm.open('ext-widget', `${ext.id}/${w.id}`); return; }
  const role = ext.contributes?.roles?.find((x) => x.workerId);
  if (role) wm.open('worker', role.workerId);
}

/* ---------- the Extensions window ---------- */

function extCard(ext, rerender) {
  const srcChip = tx(h('span', { class: `hchip ${ext.source === 'url' ? 'hchip-warn' : ext.source === 'dev' ? 'hchip-info' : ''}` }), `extensions.source.${ext.source}`);
  const toggle = h('button', { class: `btn btn-xs ${ext.enabled ? 'btn-quiet' : 'btn-primary'}`, type: 'button' }, tx(h('span'), ext.pending ? 'extensions.review' : ext.enabled ? 'extensions.disable' : 'extensions.enable'));
  toggle.addEventListener('click', async () => {
    if (ext.pending) { if (await review(ext)) openContributions(byId(ext.id) || ext); return; }
    if (await call(ext.enabled ? 'extensions.disable' : 'extensions.enable', { id: ext.id })) await refresh();
  });
  const c = ext.contributes;
  const kinds = ['tools', 'roles', 'widgets', 'commands', 'themes'].filter((k) => c[k].length).map((k) => tr(`extensions.kind.${k}`, { count: c[k].length }));
  const perms = ext.permissions.length ? h('div', { class: 'ext-chips' }, ext.permissions.map((p) => {
    const on = ext.granted.includes(p.permission);
    const chip = h('button', { class: `hchip ${on ? 'hchip-ok' : ''} ext-perm`, type: 'button', title: `${permLabel(p)} (${tr(on ? 'extensions.granted' : 'extensions.notGranted')})`, text: p.permission, disabled: !on || !ext.enabled });
    chip.addEventListener('click', async () => {
      if (!confirm(tr('extensions.revokeConfirm', { label: permLabel(p), name: ext.name }))) return;
      if (await call('extensions.revoke', { id: ext.id, permission: p.permission })) await refresh();
    });
    return chip;
  })) : tx(h('p', { class: 'tiny faint' }), 'extensions.noPermissions');
  const actions = h('div', { class: 'row ext-actions' }, toggle);
  if (ext.enabled) {
    for (const w of c.widgets) actions.append(h('button', { class: 'btn btn-xs btn-quiet', type: 'button', on: { click: () => wm.open('ext-widget', `${ext.id}/${w.id}`) } }, icon(w.icon || 'hive', 'ico-sm'), h('span', { text: tr('extensions.openWidget', { title: w.title }) })));
    for (const r of c.roles) if (r.workerId) actions.append(h('button', { class: 'btn btn-xs btn-quiet', type: 'button', on: { click: () => wm.open('worker', r.workerId) } }, icon('chat', 'ico-sm'), h('span', { text: r.name })));
  }
  if (ext.dev) actions.append(h('button', { class: 'btn btn-xs btn-quiet', type: 'button', on: { click: async () => { if (await call('extensions.reload', { id: ext.id })) await refresh(); } } }, icon('replay', 'ico-sm'), tx(h('span'), 'extensions.reload')));
  actions.append(h('span', { class: 'grow' }));
  if (ext.source !== 'builtin') {
    actions.append(h('button', { class: 'btn btn-xs btn-bad', type: 'button', on: { click: async () => {
      if (!confirm(tr('extensions.uninstallConfirm', { name: ext.name }))) return;
      if (await call('extensions.uninstall', { id: ext.id })) { await refresh(); rerender(); }
    } } }, tx(h('span'), 'extensions.uninstall')));
  }
  return h('article', { class: `extc${ext.enabled ? ' on' : ''}${ext.pending ? ' pending' : ''}`, role: 'listitem' },
    h('div', { class: 'row' }, h('div', { class: 'extc-ic' }, icon(c.widgets[0]?.icon || (c.roles.length ? 'hire' : 'code'))),
      h('div', { class: 'grow' }, h('div', { class: 'row' }, h('b', { class: 'ellipsis', text: ext.name }), h('span', { class: 'tiny faint', text: ext.version }), srcChip),
        h('div', { class: 'tiny faint', text: ext.author ? tr('extensions.by', { author: ext.author }) : '' })),
      tx(h('span', { class: `hchip ${ext.pending ? 'hchip-warn' : ext.enabled ? 'hchip-ok' : ''}` }), ext.pending ? 'extensions.pending' : ext.enabled ? 'extensions.enabled' : 'extensions.disabled')),
    h('p', { class: 'extc-desc', text: ext.description }),
    kinds.length ? h('p', { class: 'tiny faint' }, `${tr('extensions.contributes')}: ${kinds.join(', ')}`) : null,
    h('div', { class: 'tiny ext-ph' }, tx(h('span', { class: 'faint' }), 'extensions.permissions')), perms,
    ext.errors?.length ? h('div', { class: 'honest bad tiny' }, icon('x'), h('div', {}, tx(h('b'), 'extensions.errors'), h('ul', {}, ext.errors.slice(0, 6).map((e) => h('li', { text: e }))))) : null,
    ext.path ? h('p', { class: 'tiny faint ext-path' }, h('code', { text: ext.path })) : null,
    actions);
}

function windowCreate(ctx) {
  ctx.setGlyph(icon('code'));
  const tabs = ['installed', 'add', 'create'];
  let tab = 'installed';
  const seg = h('div', { class: 'seg', role: 'tablist' });
  const panes = {};
  for (const k of tabs) {
    const b = tx(h('button', { type: 'button', role: 'tab', 'aria-selected': String(k === tab) }), `extensions.tab.${k}`);
    b.addEventListener('click', () => { tab = k; for (const x of seg.children) x.setAttribute('aria-selected', String(x === b)); paint(); });
    seg.append(b);
    panes[k] = h('div', { class: 'ext-pane', role: 'tabpanel', hidden: k !== tab });
  }
  const body = h('div', { class: 'extw' }, h('div', { class: 'extw-head' }, seg), ...Object.values(panes));
  ctx.body.append(body);

  // Installed
  const list = h('div', { class: 'ext-list', role: 'list' });
  const sandboxNote = h('p', { class: 'tiny faint ext-sb' });
  panes.installed.append(sandboxNote, list);

  // Add
  const pathIn = h('input', { class: 'field-in grow', type: 'text', spellcheck: false });
  const pathBtn = h('button', { class: 'btn btn-sm btn-primary', type: 'button' }, tx(h('span'), 'extensions.add.install'));
  pathBtn.addEventListener('click', async () => { if (!pathIn.value.trim()) return pathIn.focus(); pathBtn.disabled = true; await afterStage(await call('extensions.install', { path: pathIn.value.trim() })); pathBtn.disabled = false; });
  const zipBtn = h('button', { class: 'btn btn-sm btn-quiet', type: 'button' }, icon('folder', 'ico-sm'), tx(h('span'), 'extensions.add.zip'));
  zipBtn.addEventListener('click', async () => {
    const input = h('input', { type: 'file', accept: '.zip,application/zip', style: 'display:none' });
    input.addEventListener('change', async () => {
      const f = input.files?.[0];
      input.remove();
      if (!f) return;
      const buf = new Uint8Array(await f.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      await afterStage(await call('extensions.install', { zipBase64: btoa(bin) }));
    });
    document.body.append(input);
    input.click();
  });
  const urlIn = h('input', { class: 'field-in grow', type: 'url', spellcheck: false });
  const urlBtn = h('button', { class: 'btn btn-sm btn-bad', type: 'button' }, tx(h('span'), 'extensions.add.install'));
  urlBtn.addEventListener('click', async () => { if (!/^https:\/\//.test(urlIn.value.trim())) return urlIn.focus(); urlBtn.disabled = true; await afterStage(await call('extensions.install', { url: urlIn.value.trim() })); urlBtn.disabled = false; });
  panes.add.append(
    h('section', { class: 'ext-sec' }, tx(h('h3'), 'extensions.add.folder'), tx(h('p', { class: 'tiny faint' }), 'extensions.add.folderHint'), h('div', { class: 'row' }, pathIn, pathBtn), h('div', { class: 'row' }, zipBtn)),
    h('section', { class: 'ext-sec' }, tx(h('h3'), 'extensions.add.url'),
      h('div', { class: 'honest bad' }, icon('lock'), tx(h('p', { class: 'tiny' }), 'extensions.add.urlWarning')),
      h('div', { class: 'row' }, urlIn, urlBtn)));

  // Create with the crew
  const promptIn = h('textarea', { class: 'field-ta', rows: 3, maxLength: 300 });
  const createBtn = h('button', { class: 'btn btn-sm btn-primary', type: 'button' }, icon('sparkle', 'ico-sm'), tx(h('span'), 'extensions.create.go'));
  const hint = h('p', { class: 'tiny faint' });
  const devList = h('div', { class: 'ext-dev', role: 'list' });
  createBtn.addEventListener('click', async () => {
    const prompt = promptIn.value.trim() || tr('extensions.create.placeholder');
    createBtn.disabled = true;
    const r = await call('extensions.create', { prompt });
    createBtn.disabled = false;
    if (r) { promptIn.value = ''; notify({ title: tr('extensions.create.started', { name: r.name }), tone: 'info', timeout: 3000 }); wm.open('timeline', undefined, { focus: false }); }
  });
  panes.create.append(h('section', { class: 'ext-sec' }, h('label', { class: 'the-f' }, tx(h('span', { class: 'tiny' }), 'extensions.create.label'), promptIn), h('div', { class: 'row' }, createBtn), hint), devList);

  const paint = () => {
    for (const k of tabs) panes[k].hidden = k !== tab;
    ctx.setSub(tr('extensions.subtitle', { count: state.list.length }));
    tx(sandboxNote, state.isolated ? 'extensions.sandbox.on' : 'extensions.sandbox.off');
    pathIn.placeholder = tr('extensions.add.folderPlaceholder');
    urlIn.placeholder = tr('extensions.add.urlPlaceholder');
    promptIn.placeholder = tr('extensions.create.placeholder');
    tx(hint, 'extensions.create.hint', { path: state.devDir || '~/.hivedesk/extensions/dev' });
    list.replaceChildren(...(state.list.length ? state.list.map((e) => extCard(e, paint)) : [tx(h('p', { class: 'state' }), 'extensions.empty')]));
    devList.replaceChildren(...[...state.dev.values()].reverse().map((d) => {
      const ready = d.status === 'ready';
      const btn = ready && d.ok ? h('button', { class: 'btn btn-xs btn-primary', type: 'button', on: { click: () => installDev(d) } }, tx(h('span'), 'extensions.create.installTest')) : null;
      return h('div', { class: 'extc', role: 'listitem' }, h('div', { class: 'row' }, h('b', { class: 'grow', text: d.name }),
        tx(h('span', { class: `hchip ${ready ? (d.ok ? 'hchip-ok' : 'hchip-bad') : 'hchip-info'}` }), ready ? (d.ok ? 'extensions.create.ready' : 'extensions.create.problems') : 'extensions.create.running'), btn),
        h('p', { class: 'tiny faint' }, h('code', { text: d.path || '' })),
        d.errors?.length && ready && !d.ok ? h('ul', { class: 'tiny' }, d.errors.slice(0, 5).map((e) => h('li', { text: e }))) : null);
    }));
  };
  const off = onChange(paint);
  const offLang = onLang(paint);
  ctx.onDispose(() => { off(); offLang(); });
  paint();
  refresh();
}

async function installDev(d) {
  const r = await call('extensions.addDev', { name: d.id });
  if (!r) return;
  await refresh();
  const ext = byId(r.extension.id) || r.extension;
  if (await review(ext)) openContributions(byId(ext.id) || ext);
}

/* ---------- widget windows ---------- */

const frames = new Map(); // contentWindow -> { ext, granted, iframe }

function themeVarsForFrame() {
  const cs = getComputedStyle(document.documentElement);
  const pick = (name) => cs.getPropertyValue(name).trim();
  const map = {
    '--hd-bg': pick('--bg'), '--hd-panel': pick('--panel'), '--hd-panel-2': pick('--panel-2'), '--hd-line': pick('--line-2'), '--hd-text': pick('--text'),
    '--hd-muted': pick('--muted-t'), '--hd-accent': pick('--honey'), '--hd-accent-ink': pick('--honey-ink'), '--hd-ok': pick('--ok'), '--hd-bad': pick('--bad'),
    '--hd-font': pick('--font-sans'), '--hd-mono': pick('--font-mono'), '--hd-radius': pick('--r-ctl')
  };
  return Object.fromEntries(Object.entries(map).filter(([k, v]) => WIDGET_VARS.includes(k) && v));
}

onPaint(() => {
  // getComputedStyle sees the new values on the next frame.
  requestAnimationFrame(() => {
    const vars = themeVarsForFrame();
    for (const [win] of frames) { try { win.postMessage({ hd: 1, type: 'theme', data: vars }, '*'); } catch { /* closed */ } }
  });
});

addEventListener('message', async (e) => {
  const f = frames.get(e.source);
  if (!f || e.origin !== 'null') return;
  const v = validateWidgetMessage(e.data);
  const reply = (ok, payload) => { try { e.source.postMessage({ hd: 1, type: 'reply', id: v.msg?.id || v.id, ok, ...(ok ? { result: payload } : { error: payload }) }, '*'); } catch { /* closed */ } };
  if (!v.ok) { if (v.id) reply(false, `rejected: ${v.error}`); return; }
  const { type, data } = v.msg;
  const need = permissionFor(type);
  if (need && !f.granted.includes(need)) { reply(false, `permission denied: ${f.id} was not given "${need}"`); return; }
  try {
    switch (type) {
      case 'ready': e.source.postMessage({ hd: 1, type: 'theme', data: themeVarsForFrame() }, '*'); reply(true, { id: f.id, widget: f.widget }); break;
      case 'call': { const r = await net.command('extensions.call', { id: f.id, tool: data.tool, args: data.args }, { timeout: 60000 }); reply(true, parse(r.result)); break; }
      case 'storage.get': case 'storage.set': case 'notify': { const r = await net.command('extensions.cap', { id: f.id, cap: type, args: data }); reply(true, r.result); break; }
      case 'resize': f.iframe.style.minHeight = `${data.height}px`; reply(true, {}); break;
      default: reply(false, 'unknown');
    }
  } catch (err) { reply(false, err.message); }
});

function parse(s) { if (typeof s !== 'string') return s; try { return JSON.parse(s); } catch { return s; } }

function widgetCreate(ctx, arg) {
  const [id, widgetId] = String(arg || '').split('/');
  ctx.setGlyph(icon('hive'));
  const host = h('div', { class: 'extf' });
  ctx.body.append(host);
  ctx.body.classList.add('extf-host');
  let iframe = null;
  const unhook = () => { if (iframe?.contentWindow) frames.delete(iframe.contentWindow); for (const [w, f] of frames) if (f.iframe === iframe) frames.delete(w); };
  const load = async () => {
    unhook();
    host.replaceChildren(tx(h('p', { class: 'state' }), 'extensions.widget.loading'));
    let r;
    try { r = await net.command('extensions.widget', { id, widget: widgetId }); } catch (err) {
      host.replaceChildren(err.code === 'conflict' ? tx(h('p', { class: 'state' }), 'extensions.widget.off') : tx(h('p', { class: 'state' }), 'extensions.widget.failed', { message: err.message }));
      return;
    }
    ctx.setTitle(r.widget.title);
    ctx.setSub(r.name);
    iframe = h('iframe', { class: 'extf-frame', title: r.widget.title, sandbox: 'allow-scripts', referrerpolicy: 'no-referrer', loading: 'eager' });
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.srcdoc = buildSrcdoc({ html: r.html, files: r.files, vars: themeVarsForFrame(), title: r.widget.title });
    host.replaceChildren(iframe);
    const entry = { id, widget: widgetId, granted: r.granted || [], iframe };
    // contentWindow exists as soon as the frame is in the document.
    frames.set(iframe.contentWindow, entry);
  };
  const off = net.on('event', (f) => {
    const ev = f.event;
    if (!ev?.type?.startsWith('extension.') || ev.data?.id !== id) return;
    if (['extension.reloaded', 'extension.enabled', 'extension.revoked'].includes(ev.type)) load();
    if (ev.type === 'extension.disabled' || ev.type === 'extension.uninstalled') { unhook(); host.replaceChildren(tx(h('p', { class: 'state' }), 'extensions.widget.off')); }
  });
  ctx.onDispose(() => { unhook(); off?.(); });
  load();
}

/* ---------- engine events ---------- */

net.on('event', (f) => {
  const ev = f.event;
  if (!ev?.type) return;
  const d = ev.data || {};
  const fresh = Date.now() - new Date(ev.ts).getTime() < 120_000;
  switch (ev.type) {
    case 'extension.installed': case 'extension.enabled': case 'extension.disabled': case 'extension.uninstalled': case 'extension.revoked':
      refresh();
      break;
    case 'extension.reloaded': {
      refresh();
      const name = byId(d.id)?.name || d.id;
      if (d.needsApproval) notify({ title: tr('extensions.notify.needsApproval', { name }), tone: 'warn', actions: [{ label: tr('extensions.review'), primary: true, run: async () => { await refresh(); const x = byId(d.id); if (x) review(x); } }] });
      else if (d.ok) notify({ title: tr('extensions.notify.reloaded', { name }), tone: 'ok', quiet: false, timeout: 1800 });
      else notify({ title: tr('extensions.errors'), body: (d.errors || []).slice(0, 3).join('; '), tone: 'bad' });
      break;
    }
    case 'extension.denied':
      if (fresh) notify({ title: tr('extensions.notify.denied', { id: d.id, permission: d.permission }), tone: 'warn', timeout: 6000 });
      break;
    case 'extension.dev.started':
      state.dev.set(d.id, { ...d, status: 'running' });
      changed();
      break;
    case 'extension.dev.ready': {
      state.dev.set(d.id, { ...(state.dev.get(d.id) || {}), ...d, status: 'ready' });
      changed();
      if (fresh) {
        notify({
          title: tr('extensions.notify.ready', { name: d.name }), body: d.ok ? tr('extensions.notify.readyBody') : (d.errors || []).slice(0, 2).join('; '), tone: d.ok ? 'ok' : 'warn', sticky: true, key: `extdev-${d.id}`,
          actions: d.ok ? [{ label: tr('extensions.create.installTest'), primary: true, run: () => installDev(state.dev.get(d.id)) }, { label: tr('extensions.title'), run: () => wm.open('extensions') }] : [{ label: tr('extensions.title'), run: () => wm.open('extensions') }]
        });
      }
      break;
    }
    default: break;
  }
});

net.on('live', (f) => {
  if (f.type === 'extension.notify') notify({ title: f.data.title, body: f.data.body, tone: 'info', icon: 'hive' });
  else if (f.type === 'extension.log' && f.data.level === 'error') console.warn(`[extension ${f.data.id}]`, f.data.text);
});
net.on('hello', () => { refresh(); });

/* ---------- registration ---------- */

wm.register('extensions', { title: () => tr('extensions.title'), glyph: () => icon('code'), icon: 'code', size: [720, 600], min: [340, 320], cardH: 640, create: windowCreate });
wm.register('ext-widget', { title: () => tr('extensions.widget.loading'), glyph: () => icon('hive'), icon: 'hive', size: [380, 360], min: [240, 200], cardH: 420, multi: true, create: widgetCreate });

function runCommand(ext, cmd) {
  const a = cmd.action || {};
  if (a.type === 'widget') return wm.open('ext-widget', `${ext.id}/${a.widget}`);
  if (a.type === 'job') return act.createJob(a.request);
  if (a.type === 'theme') {
    const theme = themeList().find((t) => t.id === a.theme || t.id === `${ext.id}-${a.theme}`);
    if (theme) applyTheme(theme); else loadThemes();
    return null;
  }
  if (a.type === 'tool') {
    return net.command('extensions.call', { id: ext.id, tool: a.tool, args: a.args || {} }, { timeout: 60000 })
      .then((r) => notify({ title: tr('extensions.result', { tool: cmd.title }), body: String(r.result).slice(0, 400), tone: 'ok', timeout: 9000 }))
      .catch((err) => notify({ title: tr('extensions.notify.failed'), body: err.message, tone: 'bad' }));
  }
  return null;
}

(globalThis.hivedeskPalette = globalThis.hivedeskPalette || []).push((q) => {
  const g = tr('extensions.palette.group');
  const out = [{ group: g, label: tr('extensions.palette.open'), run: () => wm.open('extensions'), icon: 'code' }];
  for (const ext of state.list) {
    if (!ext.enabled) continue;
    for (const cmd of ext.contributes.commands) out.push({ group: g, label: cmd.title, run: () => runCommand(ext, cmd), icon: 'code', hint: ext.name });
    for (const w of ext.contributes.widgets) if (!ext.contributes.commands.some((c) => c.action?.type === 'widget' && c.action.widget === w.id)) out.push({ group: g, label: tr('extensions.openWidget', { title: w.title }), run: () => wm.open('ext-widget', `${ext.id}/${w.id}`), icon: w.icon || 'hive', hint: ext.name });
  }
  if (q && q.length > 3) out.push({ group: g, label: tr('extensions.palette.create', { prompt: q }), run: () => call('extensions.create', { prompt: q }), icon: 'sparkle' });
  return out;
});

/* ---------- dock ---------- */
function addDock() {
  if (!document.querySelector('.dock-shelf')) { setTimeout(addDock, 300); return; }
  import('../js/dock.js').then(({ addDockItem }) => {
    addDockItem?.({ id: 'extensions', label: tr('extensions.title'), sub: () => tr('extensions.subtitle', { count: state.list.length }), content: h('span', { class: 'dk-hex' }, icon('code')), onClick: () => wm.toggleFromDock('extensions') });
  }).catch(() => {});
}
addDock();
