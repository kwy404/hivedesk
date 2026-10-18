// The Models window: three tabs.
//   Catalog   browse every model (search, task, size, fit, license, sort), a detail sheet per model,
//             the install queue, disk use, delete and switch, and the pooled meter of giant models.
//   Rotation  automatic model rotation per role and task: on or off, pins, models kept loaded, and the
//             log of which model answered each turn and why.
//   Sharing   lend this PC's GPU and CPU to friends for pooled models (separate shares, off by default,
//             with limits), the allowlist, active leases, and the experimental flag with the llama.cpp build.
// Nothing at module level reads index.js bindings: index.js imports this file.

import { h, icon, clear, fmtBytes, fmtDuration } from '/js/dom.js';
import * as wm from '/js/wm.js';
import * as net from '/js/net.js';
import { rev } from '/js/store.js';
import { openDialog } from '/js/dialog.js';
import { notify } from '/js/notify.js';
import { fmtNumber, L } from '/js/i18n.js';
import { track } from '/js/widgets/util.js';
import { T, strings } from './t.js';
import { mx, analyze, loadCatalog, optionOf, shortName, modelOf, hardwarePanel, whyText, whereText, speedText, qualityBars, licenseLine, put, gb, errText, openConsent } from './index.js';

const V = window.V;
const LONG = { timeout: 60_000 };
export const ux = V.reactive({ v: 0, tab: 'catalog', task: 'all', size: 'any', fit: 'any', license: 'any', sort: 'score', router: null, routes: [], share: null, build: null, progress: {}, friendsFit: {} });

const TASKS = ['all', 'coding', 'general', 'reasoning', 'vision'];
const SIZES = ['any', 'small', 'medium', 'large', 'giant'];
const FITS = ['any', 'pc', 'gpu', 'friends', 'installed'];
const LICENSES = ['any', 'open', 'commercial', 'noncommercial'];
const SORTS = ['score', 'quality', 'speed', 'size', 'name'];
const CTXS = [2048, 4096, 8192, 16384, 32768];
const OPEN = new Set(['apache-2.0', 'mit']);

const toast = (err) => notify({ title: T('models.title'), body: errText(err), tone: 'bad', icon: 'model' });

// ---------------------------------------------------------------- live data

net.on('event', (frame) => {
  const e = frame.event;
  if (!e) return;
  if (e.type === 'model.routed' || e.type === 'model.rotated') {
    ux.routes = V.markRaw([{ type: e.type, ts: e.ts, ...e.data }, ...ux.routes].slice(0, 40));
    ux.v++;
  } else if (/^models\.install\.(finished|failed|cancelled|queued|started)$/.test(e.type) || e.type === 'models.deleted' || e.type === 'brain.download.finished') {
    if (/finished|deleted/.test(e.type)) analyze();
    else refreshDisk();
    if (e.type === 'models.install.failed') notify({ title: T('models.dl.failed'), body: e.data.message, tone: 'bad', icon: 'download' });
  } else if (/^pool\.(lend|share|flag|build)/.test(e.type)) {
    loadShare();
  } else if (e.type === 'models.router.changed') {
    loadRouter();
  }
});
net.on('live', (frame) => {
  if (frame.type === 'models.install.progress') {
    ux.progress = V.markRaw({ ...ux.progress, [frame.data.id]: frame.data });
    ux.v++;
  }
});

async function refreshDisk() {
  try { const d = await net.command('models.disk', {}, LONG); if (mx.analysis) mx.analysis = V.markRaw({ ...mx.analysis, disk: d, queue: d.queue }); mx.v++; } catch { /* demo */ }
}
async function loadRouter() {
  try { ux.router = V.markRaw(await net.command('models.router.get', {}, LONG)); } catch (err) { ux.router = V.markRaw({ error: errText(err) }); }
  ux.v++;
}
async function loadShare() {
  try {
    ux.share = V.markRaw(await net.command('pool.share.get', {}, LONG));
    ux.build = V.markRaw(await net.command('pool.build.status', { kind: 'gpu' }, LONG));
  } catch (err) { ux.share = V.markRaw({ error: errText(err) }); }
  ux.v++;
}

// ---------------------------------------------------------------- catalog: filters and sorting

const optionsOf = (m) => (mx.analysis?.options || []).filter((o) => o.modelId === m.id);
function bestOf(m) {
  const opts = optionsOf(m);
  return opts.filter((o) => o.runnable).sort((a, b) => b.score - a.score)[0] || [...opts].sort((a, b) => a.bytes - b.bytes)[0] || null;
}
const sizeOf = (m) => (m.giant || m.params > 20 ? 'giant' : m.params > 10 ? 'large' : m.params > 4 ? 'medium' : 'small');

function matches(m) {
  const q = (mx.q || '').trim().toLowerCase();
  if (q && !`${m.name} ${m.id} ${m.family} ${m.license?.name} ${m.tasks.join(' ')}`.toLowerCase().includes(q)) return false;
  if (ux.task !== 'all' && !m.tasks.includes(ux.task)) return false;
  if (ux.size !== 'any' && sizeOf(m) !== ux.size) return false;
  const opts = optionsOf(m);
  if (ux.fit === 'pc' && !opts.some((o) => o.runnable)) return false;
  if (ux.fit === 'gpu' && !opts.some((o) => o.runnable && o.where === 'gpu')) return false;
  if (ux.fit === 'installed' && !opts.some((o) => o.installed)) return false;
  if (ux.fit === 'friends' && !(opts.some((o) => o.runnable) || ux.friendsFit[m.id])) return false;
  const lic = m.license || {};
  if (ux.license === 'open' && !OPEN.has(lic.id)) return false;
  if (ux.license === 'commercial' && lic.commercial === false) return false;
  if (ux.license === 'noncommercial' && lic.commercial !== false) return false;
  return true;
}

function sortKey(m) {
  const b = bestOf(m);
  switch (ux.sort) {
    case 'quality': return -(Math.max(0, ...optionsOf(m).map((o) => o.quality)));
    case 'speed': return -(b?.runnable ? b.tps : 0);
    case 'size': return Math.min(...m.variants.map((v) => v.bytes));
    case 'name': return m.name.toLowerCase();
    default: return -(b?.score || 0);
  }
}

/** "Fits with friends": the pooled meter of the models this PC cannot run alone. */
async function checkFriends() {
  const list = (mx.catalog?.models || []).filter((m) => !optionsOf(m).some((o) => o.runnable) && !(m.id in ux.friendsFit));
  for (const m of list) {
    const v = m.variants.find((x) => x.quant === 'Q4_K_M') || m.variants[0];
    try { const p = await net.command('models.pool', { id: `${m.id}:${v.quant}`, ctx: mx.ctx }, LONG); ux.friendsFit[m.id] = p.unlocked; mx.pool[m.id] = V.markRaw(p); } catch { ux.friendsFit[m.id] = false; }
  }
  ux.v++;
}

function badges(m) {
  const a = mx.analysis;
  const opts = optionsOf(m);
  const out = [];
  if (a?.recommended?.modelId === m.id) out.push(['honey', 'recommended']);
  if (a?.current?.modelId === m.id) out.push(['ok', 'inUse']);
  if (opts.some((o) => o.installed)) out.push(['ok', 'installed']);
  if (opts.some((o) => o.where === 'gpu' && o.runnable)) out.push(['info', 'fitsGpu']);
  else if (opts.some((o) => o.where === 'partial' && o.runnable)) out.push(['warn', 'partial']);
  else if (opts.some((o) => o.where === 'cpu' && o.runnable)) out.push(['', 'cpu']);
  else out.push(['bad', 'noFit']);
  if (m.giant) out.push(['warn', 'giant']);
  if (m.tasks.includes('vision')) out.push(['', 'vision']);
  return out.map(([tone, k]) => h('span', { class: `hchip ${tone ? 'hchip-' + tone : ''}`, text: T(`models.badge.${k}`) }));
}

// ---------------------------------------------------------------- the detail sheet

async function loadPool(m) {
  const v = m.variants.find((x) => x.quant === 'Q4_K_M') || m.variants[0];
  try { mx.pool[m.id] = V.markRaw(await net.command('models.pool', { id: `${m.id}:${v.quant}`, ctx: mx.ctx }, LONG)); } catch (err) { mx.pool[m.id] = V.markRaw({ error: errText(err) }); }
  mx.v++;
}

/** The locked giant model meter: VRAM and shared RAM, per machine, with the honest notes. */
export function meter(m) {
  const p = mx.pool[m.id];
  if (!p) { loadPool(m); return h('p', { class: 'small muted', text: T('models.first.loading') }); }
  if (p.error) return h('p', { class: 'small', style: 'color:var(--bad)', text: p.error });
  const scale = Math.max(p.need, p.total) || 1;
  const seg = (bytes, cls, label) => (bytes > 0 ? h('i', { class: cls, style: `width:${(bytes / scale) * 100}%`, title: `${label}: ${gb(bytes)}` }) : null);
  const friends = p.peers.filter((x) => x.vram || x.ram);
  return h('div', { class: 'mx-meter' },
    h('div', { class: 'mx-meter-h' }, icon('lock', 'ico-sm'), h('b', { text: T('models.giant.locked') }), h('span', { class: 'grow' }), h('small', { class: 'muted', text: T('models.giant.label') })),
    h('p', { class: 'small', text: p.missing > 0 ? T('models.giant.meter', { need: gb(p.need), have: gb(p.total), missing: gb(p.missing), lo: Math.max(1, p.friendsHint[0]), hi: Math.max(1, p.friendsHint[1]) }) : T('models.giant.meterFits', { need: gb(p.need), have: gb(p.total) }) }),
    h('div', { class: 'mx-meter-bar', role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': String(Math.round(p.need / 1e9)), 'aria-valuenow': String(Math.round(Math.min(p.total, p.need) / 1e9)), 'aria-label': T('models.giant.label') },
      seg(p.mine.vram, 'v me', `${T('models.giant.you')} ${T('models.giant.vram')}`),
      ...friends.map((f) => seg(f.vram, 'v peer', `${f.name} ${T('models.giant.vram')}`)),
      seg(p.mine.ram, 'r me', `${T('models.giant.you')} ${T('models.giant.ram')}`),
      ...friends.map((f) => seg(f.ram, 'r peer', `${f.name} ${T('models.giant.ram')}`)),
      h('b', { class: 'mx-meter-need', style: `left:${Math.min(100, (p.need / scale) * 100)}%`, title: gb(p.need) })),
    h('ul', { class: 'mx-meter-list' },
      h('li', {}, h('span', { class: 'dot v' }), h('b', { text: T('models.giant.you') }), h('span', { text: `${T('models.giant.vram')} ${gb(p.mine.vram)}, ${T('models.giant.ram')} ${gb(p.mine.ram)}` })),
      ...friends.map((f) => h('li', {}, h('span', { class: 'dot peer' }), h('b', { text: f.name }), h('span', { text: `${T('models.giant.vram')} ${gb(f.vram)}, ${T('models.giant.ram')} ${gb(f.ram)}${f.threads ? `, ${f.threads} threads` : ''}` })))),
    !friends.length ? h('p', { class: 'small muted', text: T('models.giant.nobody') }) : null,
    p.unlocked ? h('p', { class: 'small', style: 'color:var(--ok)', text: `${T('models.giant.unlocked')} ${T('models.giant.speed', { tps: fmtNumber(p.tps) })}` })
      : p.missing <= 0 && p.tps < 1 ? h('p', { class: 'small', style: 'color:var(--warn)', text: T('models.giant.tooSlow') }) : null,
    h('p', { class: 'small muted', text: [p.network !== 'internet' ? T('models.giant.lan') : null, p.network !== 'lan' ? T('models.giant.internet') : null, T('models.giant.ramNote')].filter(Boolean).join(' ') }),
    p.runnable
      ? h('div', { class: 'row', style: 'gap:8px;flex-wrap:wrap' },
        h('button', { type: 'button', class: 'btn btn-sm btn-primary', on: { click: () => runPooled(m, p) } }, icon('hive', 'ico-sm'), T('models.giant.run')),
        h('span', { class: 'small muted', text: T('models.giant.runNote') }))
      : p.execution === 'experimental' && p.needs?.length ? h('p', { class: 'small', style: 'color:var(--warn)', text: T('models.giant.needs', { what: p.needs.map((n) => T(`models.giant.need.${n}`)).join(', ') }) }) : null,
    h('div', { class: 'honest warn' }, icon('lock'), h('div', { class: 'small', text: T(p.execution === 'experimental' ? 'models.giant.experimentalOn' : 'models.giant.experimental') })));
}

/** Starts the pooled model with the friends of the meter's plan (they granted compute.pool). */
async function runPooled(m, p) {
  notify({ title: T('models.giant.run'), body: T('models.giant.loading'), tone: 'info', icon: 'hive' });
  try {
    await net.command('pool.p2p.start', { id: p.id, ctx: p.ctx || mx.ctx }, { timeout: 35 * 60_000 });
    notify({ title: T('models.giant.run'), body: T('models.giant.running', { model: m.name }), tone: 'ok', icon: 'hive' });
  } catch (err) { toast(err); }
  loadPool(m);
}

function variantAction(m, v) {
  const id = `${m.id}:${v.quant}`;
  const o = optionOf(id);
  const a = mx.analysis;
  const q = a?.queue || {};
  const pr = ux.progress[id];
  if (a?.current?.id === id) return h('span', { class: 'hchip hchip-ok', text: T('models.badge.inUse') });
  if (q.current?.id === id) {
    const got = pr?.received ?? q.current.received ?? 0;
    const total = pr?.total ?? q.current.total ?? v.bytes;
    return h('div', { class: 'mx-qp' }, h('div', { class: 'bar' }, h('i', { style: `width:${total ? Math.min(100, (got / total) * 100) : 0}%` })),
      h('button', { type: 'button', class: 'btn btn-xs btn-quiet', text: T('models.btn.cancel'), on: { click: () => net.command('models.cancel', { id }).catch(toast) } }));
  }
  if ((q.waiting || []).includes(id)) return h('span', { class: 'hchip', text: T('models.queue.waiting') });
  if (o?.installed) {
    return h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn btn-xs btn-primary', text: T('models.btn.use'), on: { click: () => net.command('models.switch', { id }).then(() => analyze()).catch(toast) } }),
      h('button', { type: 'button', class: 'btn btn-xs btn-quiet', text: T('models.btn.delete'), on: { click: () => net.command('models.delete', { id }).then(() => analyze()).catch(toast) } }));
  }
  if (o?.runnable) {
    return h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn btn-xs btn-quiet', title: T('models.license.accept'), on: { click: () => net.command('models.install', { id, yes: true }, LONG).then(() => refreshDisk()).catch(toast) } }, icon('download', 'ico-sm'), T('models.btn.install', { size: fmtBytes(v.bytes) })),
      h('button', { type: 'button', class: 'btn btn-xs btn-quiet', text: T('models.btn.useNow'), on: { click: () => openConsent(id) } }));
  }
  return h('span', { class: 'tiny muted', text: m.giant ? T('models.giant.locked') : T('models.where.none') });
}

function variantTable(m) {
  const a = mx.analysis;
  return h('table', { class: 'mx-table' },
    h('thead', {}, h('tr', {}, ['quant', 'file', 'need', 'runs', 'speed', 'quality'].map((k) => h('th', { scope: 'col', text: T(`models.col.${k}`) })), h('th', {}))),
    h('tbody', {}, m.variants.map((v) => {
      const id = `${m.id}:${v.quant}`;
      const o = optionOf(id);
      return h('tr', { class: `${a?.recommended?.id === id ? 'rec' : ''}${o && !o.runnable ? ' off' : ''}` },
        h('td', {}, h('b', { class: 'mono', text: v.quant }), v.parts > 1 ? h('small', { class: 'muted', text: ` ${v.parts}x` }) : null),
        h('td', { class: 'mono', text: fmtBytes(v.bytes) }),
        h('td', { class: 'mono', text: o ? gb(o.need) : '' }),
        h('td', { text: o ? whereText(o) : '' }),
        h('td', { text: o && o.tps ? `${fmtNumber(o.tps)}${o.measured ? '' : '~'}` : '' }),
        h('td', { text: o ? String(o.quality) : '' }),
        h('td', { class: 'mx-act' }, variantAction(m, v)));
    })));
}

let sheet = null;
export function openSheet(m) {
  sheet?.close();
  const body = h('div', { class: 'mx-sheet' });
  sheet = openDialog({ title: m.name, body, wide: true, cls: 'mx-dlg', onClose: () => { sheet = null; } });
  // A fresh scope so the sheet follows downloads and language switches until it closes.
  const scope = V.effectScope ? V.effectScope() : null;
  const render = () => {
    clear(body);
    const best = bestOf(m);
    put(body,
      h('div', { class: 'mx-sheet-tags' }, ...badges(m), ...m.tasks.map((k) => h('span', { class: 'hchip', text: T(`models.filter.${k}`) }))),
      h('dl', { class: 'kv' },
        h('dt', { text: T('models.sheet.params') }), h('dd', { text: `${T('models.list.params', { n: fmtNumber(m.params) })}${m.activeParams ? `, ${T('models.list.active', { n: fmtNumber(m.activeParams) })}` : ''}` }),
        h('dt', { text: T('models.sheet.context') }), h('dd', { text: T('models.sheet.tokens', { n: fmtNumber(m.contextLength) }) }),
        h('dt', { text: T('models.sheet.family') }), h('dd', { class: 'mono', text: m.family }),
        h('dt', { text: T('models.card.source') }), h('dd', {}, h('a', { href: m.base, target: '_blank', rel: 'noopener noreferrer', text: m.base.replace('https://', '') })),
        best ? h('dt', { text: T('models.sheet.best') }) : null, best ? h('dd', { text: `${shortName(best)}: ${whereText(best)}${best.tps ? `, ${speedText(best)}` : ''}` }) : null),
      m.notes ? h('p', { class: 'small muted', text: m.notes }) : null,
      licenseLine(m.license),
      qualityBars(m, null, mx.task),
      h('p', { class: 'small muted', text: T('models.q.note') }),
      m.giant && !optionsOf(m).some((o) => o.runnable) ? meter(m) : null,
      variantTable(m),
      h('p', { class: 'small muted', text: T('models.license.accept') }));
  };
  const run = () => V.effect(() => { void mx.v; void ux.v; void strings.v; void L.v; void rev.brain; requestAnimationFrame(render); });
  if (scope) scope.run(run); else run();
  const close = sheet.close;
  sheet.close = () => { scope?.stop?.(); close(); };
}

function catalogTab(top, list) {
  const a = mx.analysis;
  const c = mx.catalog;
  const disk = a?.disk;
  const q = a?.queue;
  const sel = (key, values, label, onChange) => h('label', { class: 'mx-ctx' }, h('span', { class: 'small muted', text: label }),
    h('select', { class: 'input', 'aria-label': label, on: { change: (e) => onChange(e.target.value) } }, values.map((v) => h('option', { value: String(v), text: typeof v === 'number' ? fmtNumber(v) : T(`models.${key}.${v}`), selected: String(v) === String(key === 'ctx' ? mx.ctx : key === 'qtask' ? mx.task : ux[key]) }))));
  put(clear(top),
    a ? hardwarePanel(a.hardware) : null,
    a?.recommended ? h('div', { class: 'mx-recline' }, icon('sparkle', 'ico-sm'), h('span', {}, h('b', { text: `${T('models.badge.recommended')}: ` }), whyText(a.recommended)),
      !a.recommended.installed ? h('button', { type: 'button', class: 'btn btn-xs btn-primary', on: { click: () => openConsent(a.recommended.id) } }, icon('download', 'ico-sm'), fmtBytes(a.recommended.bytes)) : null) : null,
    disk ? h('div', { class: 'mx-disk small' }, icon('folder', 'ico-sm'),
      h('span', { text: T('models.disk.line', { used: gb(disk.total), files: disk.files.filter((f) => !f.partial).length, free: gb(disk.free) }) }),
      q?.current ? h('span', { class: 'hchip hchip-honey', text: T('models.queue.now', { model: shortName({ modelId: q.current.id.split(':')[0], quant: q.current.id.split(':')[1] }), count: (q.waiting || []).length }) }) : null) : null,
    h('div', { class: 'mx-tools' },
      h('input', { class: 'field-in mx-search', type: 'search', placeholder: T('models.list.search'), 'aria-label': T('models.list.search'), value: mx.q, on: { input: (e) => { mx.q = e.target.value; renderList(list); } } }),
      sel('task', TASKS, T('models.list.task'), (v) => { ux.task = v; ux.v++; }),
      sel('size', SIZES, T('models.list.size'), (v) => { ux.size = v; ux.v++; }),
      sel('fit', FITS, T('models.list.fit'), (v) => { ux.fit = v; if (v === 'friends') checkFriends(); ux.v++; }),
      sel('license', LICENSES, T('models.card.license'), (v) => { ux.license = v; ux.v++; }),
      sel('sort', SORTS, T('models.list.sort'), (v) => { ux.sort = v; ux.v++; }),
      sel('ctx', CTXS, T('models.list.ctx'), (v) => { mx.ctx = Number(v); mx.pool = {}; ux.friendsFit = {}; analyze(); }),
      sel('qtask', ['coding', 'reasoning', 'chat'], T('models.list.rankFor'), (v) => { mx.task = v; analyze(); })),
    mx.error ? h('div', { class: 'honest bad' }, icon('x'), h('div', { text: mx.error })) : null);
  renderList(list);
  void c;
}

function renderList(list) {
  const c = mx.catalog;
  clear(list);
  if (!c) { list.append(h('li', { class: 'muted small', text: T('models.first.loading') })); return; }
  const shown = c.models.filter(matches).sort((x, y) => { const a = sortKey(x); const b = sortKey(y); return a < b ? -1 : a > b ? 1 : 0; });
  if (!shown.length) list.append(h('li', { class: 'muted small', text: T('models.list.empty') }));
  for (const m of shown) {
    const best = bestOf(m);
    list.append(h('li', { class: `mx-row${m.giant ? ' giant' : ''}` },
      h('button', { type: 'button', class: 'mx-row-h', 'aria-haspopup': 'dialog', on: { click: () => openSheet(m) } },
        h('div', { class: 'grow' },
          h('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap' }, h('b', { text: m.name }), ...badges(m)),
          h('div', { class: 'small muted', text: [
            T('models.list.params', { n: fmtNumber(m.params) }), m.activeParams ? T('models.list.active', { n: fmtNumber(m.activeParams) }) : null,
            m.license?.name, T('models.sheet.tokens', { n: fmtNumber(m.contextLength) }), T('models.list.sizes', { count: m.variants.length }),
            best ? `${shortName(best)}: ${whereText(best)}${best.tps ? `, ${speedText(best)}` : ''}` : null
          ].filter(Boolean).join(' · ') })),
        icon('arrow', 'ico-sm mx-chev'))));
  }
}

// ---------------------------------------------------------------- rotation

const ROLE_NAMES = { mel: 'Mel', dev: 'Dev', designer: 'Designer', qa: 'QA', writer: 'Writer', chat: 'Chat' };

function rotationTab(box) {
  const r = ux.router;
  clear(box);
  if (!r) { loadRouter(); box.append(h('p', { class: 'muted small', text: T('models.first.loading') })); return; }
  if (r.error) { box.append(h('div', { class: 'honest bad' }, icon('x'), h('div', { text: r.error }))); return; }
  const installed = mx.analysis?.installed || [];
  const set = (patch) => net.command('models.router.set', patch, LONG).then((x) => { ux.router = V.markRaw(x); ux.v++; }).catch(toast);
  const pinSelect = (role) => h('select', { class: 'input', 'aria-label': T('models.rot.pinFor', { role: ROLE_NAMES[role] || role }), on: { change: (e) => set({ pins: { [role]: e.target.value || null } }) } },
    h('option', { value: '', text: T('models.rot.auto'), selected: !r.pins[role] }),
    installed.map((id) => h('option', { value: id, text: shortName({ modelId: id.split(':')[0], quant: id.split(':')[1] }), selected: r.pins[role] === id })));
  put(box,
    h('div', { class: 'set-row' },
      h('label', { class: 'grow', for: 'mx-auto' }, h('b', { text: T('models.rot.auto') }), h('span', { text: T('models.rot.autoDesc') })),
      h('input', { id: 'mx-auto', type: 'checkbox', class: 'toggle toggle-primary', checked: r.auto, on: { change: (e) => set({ auto: e.target.checked }) } })),
    h('div', { class: 'set-row' },
      h('div', { class: 'grow' }, h('b', { text: T('models.rot.resident') }), h('span', { text: T('models.rot.residentDesc') })),
      h('select', { class: 'input', 'aria-label': T('models.rot.resident'), on: { change: (e) => set({ maxResident: Number(e.target.value) }) } }, [1, 2, 3, 4].map((n) => h('option', { value: String(n), text: String(n), selected: n === r.maxResident })))),
    h('h4', { class: 'mx-sub', text: T('models.rot.roles') }),
    h('table', { class: 'mx-table' },
      h('thead', {}, h('tr', {}, h('th', { text: T('models.rot.role') }), h('th', { text: T('models.rot.now') }), h('th', { text: T('models.rot.pin') }))),
      h('tbody', {}, (r.preview || []).map((p) => h('tr', {},
        h('td', {}, h('b', { text: ROLE_NAMES[p.workerId] || p.name })),
        h('td', {}, h('div', { text: p.model || T('models.where.none') }), h('div', { class: 'tiny muted', text: p.reason })),
        h('td', {}, p.workerId === 'chat' ? h('span', { class: 'tiny muted', text: T('models.rot.chatAuto') }) : pinSelect(p.workerId)))))),
    !(r.preview || []).length ? h('p', { class: 'small muted', text: T('models.rot.noBrain') }) : null,
    h('h4', { class: 'mx-sub', text: T('models.rot.loaded') }),
    (r.resident || []).length ? h('ul', { class: 'mx-meter-list' }, r.resident.map((x) => h('li', {}, h('span', { class: 'dot v' }), h('b', { text: x.model }), h('span', { text: `${gb(x.need)}, ${x.where}${x.busy ? `, ${T('models.rot.busy')}` : ''}` }))))
      : h('p', { class: 'small muted', text: T('models.rot.noneLoaded') }),
    h('h4', { class: 'mx-sub', text: T('models.rot.log') }),
    ux.routes.length ? h('ul', { class: 'mx-log' }, ux.routes.slice(0, 20).map((e) => h('li', { class: e.type === 'model.rotated' ? 'rot' : '' },
      h('span', { class: 'tiny muted', text: new Date(e.ts).toLocaleTimeString() }),
      h('span', { text: e.type === 'model.rotated' ? T('models.rot.rotated', { from: e.from, cause: T(`models.rot.cause.${e.cause}`) }) : e.reason }))))
      : h('p', { class: 'small muted', text: T('models.rot.noLog') }));
}

// ---------------------------------------------------------------- sharing (pooled models)

function sharingTab(box) {
  const s = ux.share;
  clear(box);
  if (!s) { loadShare(); box.append(h('p', { class: 'muted small', text: T('models.first.loading') })); return; }
  if (s.error) { box.append(h('div', { class: 'honest bad' }, icon('x'), h('div', { text: s.error }))); return; }
  const hw = mx.analysis?.hardware;
  const save = (share, peers) => net.command('pool.share.set', { share, peers }, LONG).then(() => loadShare()).catch(toast);
  const share = JSON.parse(JSON.stringify(s.share));
  const num = (obj, key, scale, max, label) => h('label', { class: 'mx-num' }, h('span', { class: 'small muted', text: label }),
    h('input', { class: 'field-in', type: 'number', min: '0', max: String(max), step: scale === 1e9 ? '0.5' : '1', value: String(Math.round((obj[key] / scale) * 10) / 10), on: { change: (e) => { obj[key] = Number(e.target.value) * scale; save(share); } } }));
  const toggleRow = (kind, title, desc) => h('div', { class: 'set-row' },
    h('label', { class: 'grow', for: `mx-share-${kind}` }, h('b', { text: title }), h('span', { text: desc })),
    h('input', { id: `mx-share-${kind}`, type: 'checkbox', class: 'toggle toggle-primary', checked: share[kind].enabled, on: { change: (e) => { share[kind].enabled = e.target.checked; save(share); } } }));
  const b = ux.build;
  put(box,
    h('p', { class: 'small', text: T('models.share.lead') }),
    toggleRow('gpu', T('models.share.gpu'), T('models.share.gpuDesc')),
    h('div', { class: 'mx-nums' },
      num(share.gpu, 'maxVramBytes', 1e9, Math.max(0, ((hw?.gpu?.vramBytes || 0) - 1e9) / 1e9), T('models.share.vram')),
      num(share.gpu, 'maxMinutes', 1, 480, T('models.share.minutes')), num(share.gpu, 'maxJobs', 1, 4, T('models.share.jobs'))),
    toggleRow('cpu', T('models.share.cpu'), T('models.share.cpuDesc')),
    h('div', { class: 'mx-nums' },
      num(share.cpu, 'maxThreads', 1, Math.max(0, (hw?.cpu?.cores || 2) - 1), T('models.share.threads')),
      num(share.cpu, 'maxRamBytes', 1e9, Math.max(0, ((hw?.ramBytes || 0) - 4e9) / 1e9), T('models.share.ram')),
      num(share.cpu, 'maxMinutes', 1, 480, T('models.share.minutes')), num(share.cpu, 'maxJobs', 1, 4, T('models.share.jobs'))),
    h('label', { class: 'mx-num' }, h('b', { text: T('models.share.peers') }), h('span', { class: 'small muted', text: T('models.share.peersDesc') }),
      h('input', { class: 'field-in', value: (s.peers || []).join(', '), placeholder: 'peer id, peer id', on: { change: (e) => save(undefined, e.target.value.split(/[\s,]+/).filter(Boolean)) } })),
    h('h4', { class: 'mx-sub', text: T('models.share.active') }),
    (s.active || []).length ? h('ul', { class: 'mx-meter-list' }, s.active.map((l) => h('li', {},
      h('span', { class: 'dot v' }), h('b', { text: `${l.peerId} (${l.kind.toUpperCase()})` }),
      h('span', { text: T('models.share.until', { time: new Date(l.expiresAt).toLocaleTimeString() }) }),
      h('button', { type: 'button', class: 'btn btn-xs btn-quiet', text: T('models.share.revoke'), on: { click: () => net.command('pool.lend.revoke', { leaseId: l.id }).then(loadShare).catch(toast) } }))))
      : h('p', { class: 'small muted', text: T('models.share.none') }),
    (s.active || []).length ? h('button', { type: 'button', class: 'btn btn-sm btn-quiet', text: T('models.share.stopAll'), on: { click: () => net.command('pool.lend.stop', {}).then(loadShare).catch(toast) } }) : null,
    h('h4', { class: 'mx-sub', text: T('models.share.pooled') }),
    h('div', { class: 'set-row' },
      h('label', { class: 'grow', for: 'mx-exp' }, h('b', { text: T('models.share.experimental') }), h('span', { text: T('models.share.experimentalDesc') })),
      h('input', { id: 'mx-exp', type: 'checkbox', class: 'toggle toggle-primary', checked: !!s.experimental, on: { change: (e) => net.command('pool.flag.set', { on: e.target.checked }).then(loadShare).catch(toast) } })),
    b ? h('div', { class: 'mx-card' },
      h('div', { class: 'row', style: 'gap:8px' }, h('b', { text: `llama.cpp ${b.tag}` }), h('span', { class: `hchip ${b.installed ? 'hchip-ok' : ''}`, text: b.installed ? T('models.badge.installed') : fmtBytes(b.bytes) }), h('span', { class: 'hchip', text: 'MIT' })),
      h('p', { class: 'small muted', text: T('models.share.buildDesc', { source: b.source }) }),
      !b.installed ? h('button', { type: 'button', class: 'btn btn-sm btn-quiet', on: { click: () => net.command('pool.build.install', { kind: 'gpu', yes: true }, { timeout: 30 * 60_000 }).then(loadShare).catch(toast) } }, icon('download', 'ico-sm'), T('models.btn.install', { size: fmtBytes(b.bytes) })) : null) : null,
    h('div', { class: 'honest warn' }, icon('lock'), h('div', { class: 'small', text: T('models.share.honest') })));
}

// ---------------------------------------------------------------- the window

const TABS = ['catalog', 'rotation', 'sharing'];

wm.register('models', {
  title: () => T('models.title'),
  glyph: () => icon('model'),
  size: [760, 680],
  min: [340, 320],
  cardH: 620,
  create(ctx) {
    const tabs = h('div', { class: 'gh-tabs mx-tabs', role: 'tablist', 'aria-label': T('models.title') });
    const top = h('div', { class: 'mx-top' });
    const list = h('ul', { class: 'mx-list', role: 'list' });
    const other = h('div', { class: 'mx-other' });
    const pane = h('div', { class: 'pane pane-pad mx-pane', role: 'tabpanel' }, top, list, other);
    ctx.body.append(tabs, pane);
    loadCatalog();
    analyze().then(refreshDisk);
    loadRouter();
    track(() => [mx.v, ux.v, strings.v, rev.brain, L.v, ux.tab], () => {
      tabs.replaceChildren(...TABS.map((k) => h('button', { type: 'button', role: 'tab', class: 'gh-tab', 'aria-selected': String(k === ux.tab), text: T(`models.tab.${k}`), on: { click: () => { ux.tab = k; if (k === 'rotation') loadRouter(); if (k === 'sharing') loadShare(); ux.v++; } } })));
      const ae = document.activeElement;
      if (pane.contains(ae) && (ae.tagName === 'INPUT' && ae.type !== 'checkbox')) return; // do not steal focus while typing
      if (ux.tab === 'catalog') { clear(other); catalogTab(top, list); }
      else { clear(top); clear(list); if (ux.tab === 'rotation') rotationTab(other); else sharingTab(other); }
      const c = mx.catalog;
      if (c) ctx.setSub(T('models.list.count', { models: c.models.length, files: c.models.reduce((n, m) => n + m.variants.length, 0) }));
    });
  }
});

void fmtDuration;
