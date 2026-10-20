// Models: the first launch analysis with consent, the consent card before any download, and the
// Models window (the whole catalog with filters, badges, installed models, delete and switch, and the
// pooled giant models with their meter). Importing this module registers everything.
//
// Nothing downloads from here without a click on a button that sits next to the size, the source and
// the license of that exact file; the engine refuses models.consent without yes: true.

import { h, icon, clear, fmtBytes, fmtDuration } from '/js/dom.js';
import * as wm from '/js/wm.js';
import * as net from '/js/net.js';
import { S, rev, ui, extra, onEvent } from '/js/store.js';
import { openDialog } from '/js/dialog.js';
import { notify } from '/js/notify.js';
import { fmtNumber, L, dlError } from '/js/i18n.js';
import { track } from '/js/widgets/util.js';
import { T, strings, ready } from './t.js';

const V = window.V;
const LONG = { timeout: 60_000 };
export const mx = V.reactive({ v: 0, analysis: null, catalog: null, loading: false, error: null, filter: 'all', q: '', ctx: 4096, task: 'coding', open: {}, pool: {}, busy: null });

function linkCss(href) {
  if (document.querySelector(`link[href="${href}"]`)) return;
  document.head.append(h('link', { rel: 'stylesheet', href }));
}
linkCss('/models/models.css');

/** append() that skips null and false, like h() does. */
export const put = (el, ...kids) => { el.append(...kids.flat().filter((k) => k != null && k !== false)); return el; };
export const gb = (n) => (n == null ? '?' : fmtNumber(n / 1e9, { style: 'unit', unit: 'gigabyte', unitDisplay: 'short', maximumFractionDigits: n >= 10e9 ? 0 : 1 }));
export const errText = (err) => String(err?.message || err || '');

export async function analyze(ctx = mx.ctx, task = mx.task) {
  mx.loading = true;
  try {
    mx.analysis = V.markRaw(await net.command('models.analyze', { ctx, task }, LONG));
    mx.error = null;
  } catch (err) { mx.error = err.code === 'conflict' ? T('models.err.demo') : T('models.err.load', { error: errText(err) }); }
  mx.loading = false;
  mx.v++;
  return mx.analysis;
}

export async function loadCatalog() {
  if (mx.catalog) return mx.catalog;
  try { mx.catalog = V.markRaw(await net.command('models.catalog', {}, LONG)); } catch (err) { mx.error = T('models.err.load', { error: errText(err) }); }
  mx.v++;
  return mx.catalog;
}

export const optionOf = (id) => mx.analysis?.options?.find((o) => o.id === id) || null;
export const shortName = (o) => `${(/(\d+(?:\.\d+)?b)(?:-a\d+b)?$/i.exec(o.modelId)?.[1] || o.modelId).toUpperCase()} ${o.quant}`;
export const modelOf = (id) => mx.catalog?.models?.find((m) => m.id === id) || null;

// ---------------------------------------------------------------- pieces

export function hardwarePanel(hw) {
  if (!hw) return null;
  const g = hw.gpu;
  const cpuBits = [hw.cpu?.cores ? T('models.hw.cores', { cores: hw.cpu.cores }) : null, hw.cpu?.avx512 ? 'AVX-512' : hw.cpu?.avx2 ? 'AVX2' : hw.cpu?.avx2 === false ? 'no AVX2' : null].filter(Boolean).join(', ');
  const backend = g ? (g.backend === 'metal' ? 'Metal' : g.backend === 'vulkan' ? 'Vulkan' : `CUDA${g.cuda ? ' ' + g.cuda : ''}`) : '';
  return h('div', { class: 'mx-hw', role: 'group', 'aria-label': T('models.hw.title') },
    h('div', { class: 'mx-hw-i' }, icon('gpu'), h('div', {}, h('small', { text: T('models.hw.gpu') }), h('b', { text: g ? g.name : T('models.hw.noGpu') }),
      g ? h('span', { text: `${g.unified ? T('models.hw.unified', { size: gb(g.vramBytes) }) : T('models.hw.vram', { size: gb(g.vramBytes) })}, ${backend}` }) : null)),
    h('div', { class: 'mx-hw-i' }, icon('cpu'), h('div', {}, h('small', { text: T('models.hw.cpu') }), h('b', { text: hw.cpu?.model ? hw.cpu.model.replace(/\(R\)|\(TM\)|CPU|@.*$/g, '').replace(/\s+/g, ' ').trim() : '?' }), h('span', { text: cpuBits }))),
    h('div', { class: 'mx-hw-i' }, icon('model'), h('div', {}, h('small', { text: T('models.hw.ram') }), h('b', { text: gb(hw.ramBytes) }))),
    h('div', { class: 'mx-hw-i' }, icon('folder'), h('div', {}, h('small', { text: T('models.hw.disk') }), h('b', { text: gb(hw.diskFreeBytes) }))));
}

export function whyText(o) {
  const name = shortName(o);
  const parts = (o.why || []).map((w) => {
    switch (w.k) {
      case 'fitsGpu': return T('models.why.fitsGpu', { model: name, vram: gb(w.vram), ctx: fmtNumber(w.ctx) });
      case 'unified': return T('models.why.unified', { model: name, ctx: fmtNumber(w.ctx) });
      case 'partial': return T('models.why.partial', { model: name, share: w.share });
      case 'cpu': return T('models.why.cpu', { model: name, cores: w.cores, ram: gb(w.ram) });
      case 'smarter': return T('models.why.smarter', { than: w.than });
      case 'faster': return T('models.why.faster', { than: w.than, x: fmtNumber(w.x) });
      case 'installed': return T('models.why.installed');
      case 'measured': return T('models.why.measured');
      case 'estimated': return T('models.why.estimated');
      default: return '';
    }
  }).filter(Boolean);
  const text = parts.join('; ');
  return text ? text[0].toUpperCase() + text.slice(1) + '.' : '';
}

export function whereText(o) {
  if (o.where === 'partial') return T('models.where.partial', { share: Math.round(o.gpuShare * 100) });
  return T(`models.where.${o.where}`);
}

export function speedText(o) {
  if (!o.tps) return T('models.speed.unknown');
  return `${T(`models.speed.${o.speed}`)}, ${T(o.measured ? 'models.tps.measured' : 'models.tps.estimated', { tps: fmtNumber(o.tps) })}`;
}

export function qualityBars(m, quant, task) {
  const q = m?.quality || {};
  return h('div', { class: 'mx-q' }, ['coding', 'reasoning', 'chat'].map((k) =>
    h('div', { class: `mx-q-i${k === (task === 'general' ? 'chat' : task) ? ' on' : ''}` }, h('span', { text: T(`models.q.${k}`) }),
      h('div', { class: 'mx-q-bar', role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(q[k] || 0), 'aria-label': T(`models.q.${k}`) }, h('i', { style: `width:${q[k] || 0}%` })))));
}

export function licenseLine(lic) {
  if (!lic) return null;
  return h('div', { class: 'mx-lic' },
    h('span', { class: `hchip ${lic.commercial === false ? 'hchip-warn' : ''}`, text: lic.name }),
    lic.commercial === false ? h('span', { class: 'small', style: 'color:var(--warn)', text: T('models.license.noncommercial') }) : null,
    lic.notes ? h('div', { class: 'small muted', text: lic.notes }) : null,
    lic.url ? h('a', { class: 'small', href: lic.url, target: '_blank', rel: 'noopener noreferrer', text: T('models.license.read') }) : null);
}

/** A card for one option: what, how big, where from, the license, how fast, how good, why. */
export function optionCard(o, { kind, big = false } = {}) {
  if (!o) return null;
  const m = modelOf(o.modelId);
  const v = m?.variants?.find((x) => x.quant === o.quant);
  return h('article', { class: `mx-card${big ? ' mx-card-big' : ''}`, 'aria-label': `${T(`models.pick.${kind}`)}: ${o.name}` },
    h('div', { class: 'mx-card-h' }, h('span', { class: `hchip ${kind === 'recommended' ? 'hchip-honey' : 'hchip-info'}`, text: T(`models.pick.${kind}`) }),
      o.installed ? h('span', { class: 'hchip hchip-ok', text: T('models.badge.installed') }) : null),
    h('h3', { class: 'mx-card-t', text: m?.name || o.name }, h('span', { class: 'mx-quant', text: o.quant })),
    big ? h('p', { class: 'mx-why', text: whyText(o) }) : null,
    h('dl', { class: 'kv mx-kv' },
      h('dt', { text: T('models.card.size') }), h('dd', { text: fmtBytes(o.bytes) }),
      h('dt', { text: T('models.card.runs') }), h('dd', { text: whereText(o) }),
      h('dt', { text: T('models.card.speed') }), h('dd', { text: speedText(o) }),
      big ? h('dt', { text: T('models.card.source') }) : null, big ? h('dd', { class: 'mono', text: `huggingface.co/${v?.repo || ''}` }) : null,
      h('dt', { text: T('models.card.license') }), h('dd', {}, big ? licenseLine(m?.license) : h('span', { class: `hchip ${m?.license?.commercial === false ? 'hchip-warn' : ''}`, text: m?.license?.name || o.license }))),
    big ? qualityBars(m, o.quant, mx.task) : null,
    !big ? h('p', { class: 'mx-why small', text: whyText(o) }) : null);
}

// ---------------------------------------------------------------- consent and download

let dlg = null;
let opening = false;

function closeDialog() { dlg?.close(); dlg = null; }

async function consent(id, { via, answer }) {
  mx.busy = id;
  try {
    await net.command('models.consent', { id, yes: true, via, answer }, LONG);
  } catch (err) {
    mx.busy = null;
    notify({ title: T('models.dl.failed'), body: errText(err), tone: 'bad', icon: 'download', sticky: true });
    return false;
  }
  mx.busy = null;
  return true;
}

/** The download, verification and loading, live from the engine. */
function progressView(onClose) {
  const box = h('div', { class: 'mx-dl', role: 'status', 'aria-live': 'polite' });
  track(() => [rev.brain, strings.v], () => {
    const d = extra.download || {};
    const b = S().brain || {};
    clear(box);
    const total = d.total || d.bytes || 0;
    const got = d.received || 0;
    const pct = total ? Math.min(100, (got / total) * 100) : 0;
    if (b.state === 'ready') {
      put(box, h('div', { class: 'honest' }, icon('check'), h('div', {}, h('b', { text: T('models.dl.ready', { model: b.model || d.model || '' }) }), d.phase === 'done' ? h('div', { class: 'small', text: T('models.dl.verified') }) : null)),
        h('div', { class: 'row', style: 'justify-content:flex-end' }, h('button', { type: 'button', class: 'btn btn-sm btn-primary', text: T('models.btn.close'), on: { click: onClose } })));
      return;
    }
    if (d.phase === 'failed' || b.state === 'error') {
      const failure = dlError(d.phase === 'failed' ? d : { ...b, message: b.detail });
      put(box, h('div', { class: 'honest bad' }, icon('x'), h('div', {}, h('b', { text: failure.text || T('models.dl.failed') }), failure.detail ? h('div', { class: 'small', text: failure.detail }) : null)),
        h('div', { class: 'row', style: 'justify-content:flex-end' },
          d.id ? h('button', { type: 'button', class: 'btn btn-sm btn-primary', text: T('models.btn.retry'), on: { click: () => consent(d.id, { via: 'card' }) } }) : null,
          h('button', { type: 'button', class: 'btn btn-sm btn-quiet', text: T('models.btn.close'), on: { click: onClose } })));
      return;
    }
    const loading = d.phase === 'done' || b.state === 'loading';
    box.append(h('div', { class: 'mx-dl-t', text: loading ? T('models.dl.loading') : T('models.dl.title', { model: d.model || b.model || '' }) }));
    box.append(h('div', { class: `bar${loading || !total ? ' indet' : ''}`, role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(pct)), 'aria-label': T('models.dl.title', { model: d.model || '' }) }, h('i', { style: loading || !total ? '' : `width:${pct}%` })));
    if (!loading) {
      const eta = d.bps && total ? (total - got) / d.bps : null;
      box.append(h('div', { class: 'row tiny muted mx-dl-n' },
        h('span', { class: 'grow', text: `${T('models.dl.progress', { got: fmtBytes(got), total: fmtBytes(total) })} (${fmtNumber(Math.floor(pct) / 100, { style: 'percent' })})` }),
        d.parts ? h('span', { text: T('models.dl.part', { part: d.part || 1, parts: d.parts }) }) : null,
        d.bps ? h('span', { text: T('models.dl.speed', { speed: fmtBytes(d.bps) }) }) : null,
        eta != null && isFinite(eta) ? h('span', { text: T('models.dl.eta', { time: fmtDuration(eta * 1000) }) }) : null));
    } else if (d.phase === 'done') {
      box.append(h('div', { class: 'small', style: 'color:var(--ok);margin-top:6px' }, icon('check', 'ico-sm'), ' ', T('models.dl.verified')));
    }
    put(box, h('p', { class: 'help', text: T('models.dl.resume') }), h('p', { class: 'help', text: T('models.dl.verify') }),
      h('div', { class: 'row', style: 'justify-content:flex-end' },
        !loading ? h('button', { type: 'button', class: 'btn btn-sm btn-quiet', text: T('models.btn.cancel'), on: { click: () => net.command('models.cancel', {}).catch(() => {}) } }) : null,
        h('button', { type: 'button', class: 'btn btn-sm btn-quiet', text: T('models.btn.close'), on: { click: onClose } })));
  });
  return box;
}

/** The first launch dialog: hardware, the recommendation with its reason and license, and five choices. */
export async function openFirstLaunch({ auto = false } = {}) {
  if (dlg || opening) return;
  opening = true;
  await ready;
  opening = false;
  if (dlg) return;
  const body = h('div', { class: 'mx-first' });
  dlg = openDialog({ title: T('models.first.title'), body, wide: true, cls: 'mx-dlg', onClose: () => { dlg = null; } });
  body.append(h('p', { class: 'muted', text: T('models.first.loading') }));
  await Promise.all([loadCatalog(), analyze()]);
  const a = mx.analysis;
  clear(body);
  if (!a) { body.append(h('div', { class: 'honest bad' }, icon('x'), h('div', { text: mx.error || '' }))); return; }
  const choose = async (o, answer) => {
    if (!o) return;
    clear(body).append(progressView(closeDialog));
    if (!(await consent(o.id, { via: 'dialog', answer }))) closeDialog();
  };
  const rec = a.recommended;
  put(body, h('p', { class: 'mx-lead', text: T('models.first.lead') }),
    h('h4', { class: 'mx-sub', text: T('models.hw.title') }), hardwarePanel(a.hardware),
    !a.hardware?.gpu ? h('p', { class: 'small muted', text: T('models.hw.cpuOnly') }) : null,
    rec ? optionCard(rec, { kind: 'recommended', big: true }) : h('div', { class: 'honest warn' }, icon('x'), h('div', { text: mx.error || T('models.badge.noFit') })),
    a.faster || a.smarter ? h('div', { class: 'mx-alt' }, optionCard(a.faster, { kind: 'faster' }), optionCard(a.smarter, { kind: 'smarter' })) : null,
    rec ? h('p', { class: 'small muted', text: `${T('models.license.accept')} ${T('models.q.note')}` }) : null,
    h('div', { class: 'mx-actions' },
      rec ? h('button', { type: 'button', class: 'btn btn-primary', 'data-autofocus': '', on: { click: () => choose(rec, 'recommended') } }, icon('download', 'ico-sm'), T('models.btn.recommended')) : null,
      a.faster ? h('button', { type: 'button', class: 'btn btn-quiet', on: { click: () => choose(a.faster, 'faster') } }, icon('sparkle', 'ico-sm'), T('models.btn.faster')) : null,
      a.smarter ? h('button', { type: 'button', class: 'btn btn-quiet', on: { click: () => choose(a.smarter, 'smarter') } }, icon('star', 'ico-sm'), T('models.btn.smarter')) : null,
      h('button', { type: 'button', class: 'btn btn-quiet', on: { click: () => { net.command('models.later', {}).catch(() => {}); closeDialog(); wm.open('models'); } } }, icon('search', 'ico-sm'), T('models.btn.other')),
      h('button', { type: 'button', class: 'btn btn-quiet', on: { click: () => { net.command('models.later', {}).catch(() => {}); closeDialog(); notify({ title: T('models.btn.later'), body: T('models.later.note'), tone: 'info', icon: 'model' }); } } }, T('models.btn.later'))));
  void auto;
}

/** The consent card for one file (from Settings, the Models window or a step down). */
export async function openConsent(id) {
  if (opening) return;
  opening = true;
  await ready;
  await Promise.all([loadCatalog(), analyze()]);
  opening = false;
  closeDialog();
  const o = optionOf(id);
  const body = h('div', { class: 'mx-first' });
  dlg = openDialog({ title: T('models.consent.title'), body, wide: true, cls: 'mx-dlg', onClose: () => { dlg = null; } });
  if (!o) { body.append(h('p', { class: 'muted', text: id })); return; }
  put(body, h('p', { class: 'mx-lead', text: T('models.consent.lead') }), optionCard(o, { kind: o.id === mx.analysis?.recommended?.id ? 'recommended' : o.quality > (mx.analysis?.recommended?.quality || 0) ? 'smarter' : 'faster', big: true }),
    h('p', { class: 'small muted', text: T('models.license.accept') }),
    h('div', { class: 'mx-actions' },
      h('button', { type: 'button', class: 'btn btn-primary', 'data-autofocus': '', on: { click: async () => { clear(body).append(progressView(closeDialog)); if (!(await consent(o.id, { via: 'card' }))) closeDialog(); } } }, icon('download', 'ico-sm'), T('models.btn.download')),
      h('button', { type: 'button', class: 'btn btn-quiet', on: { click: closeDialog } }, T('models.btn.later'))));
}

// ---------------------------------------------------------------- wiring

// The Models window: the catalog, rotation and sharing tabs (window.js).
import './window.js';

(globalThis.hivedeskPalette ||= []).push((q = '') => {
  const all = [
    { group: T('models.title'), label: T('models.pal.open'), icon: 'model', run: () => wm.open('models') },
    { group: T('models.title'), label: T('models.pal.analyze'), icon: 'gpu', run: () => openFirstLaunch() }
  ];
  const s = String(q).toLowerCase();
  return s ? all.filter((c) => c.label.toLowerCase().includes(s)) : all;
});

/** Settings, Models: a section that opens the analysis and the window. */
(globalThis.hivedeskSettingsSections ||= []).push(() => {
  const sec = h('section', { class: 'set-sec' });
  const render = () => {
    clear(sec).append(h('h3', { text: T('models.settings.title') }),
      h('div', { class: 'set-row' }, h('div', { class: 'grow' }, h('b', { text: T('models.settings.title') }), h('span', { text: T('models.settings.desc') })),
        h('button', { type: 'button', class: 'btn btn-sm btn-quiet', on: { click: () => openFirstLaunch() } }, icon('gpu', 'ico-sm'), T('models.btn.analyze')),
        h('button', { type: 'button', class: 'btn btn-sm btn-primary', on: { click: () => wm.open('models') } }, icon('model', 'ico-sm'), T('models.btn.open'))));
  };
  render();
  V.effect(() => { void strings.v; void L.v; render(); });
  return sec;
});

// First launch: once connected, if no model is ready, none is downloaded and the dialog was never answered.
let checked = false;
net.on('hello', async (f) => {
  if (checked || f.state?.demo) return;
  checked = true;
  await ready;
  const a = await analyze();
  if (!a) return;
  const state = a.brain?.state;
  if (!a.firstLaunch && !a.installed.length && state !== 'ready' && state !== 'loading' && state !== 'downloading') openFirstLaunch({ auto: true });
});

// A download that waits for a yes (Settings, a step down after an error): show the consent card.
// After "Not now" an automatic start does not open anything by itself again.
onEvent((ev) => {
  if (ev.type !== 'models.consent.required' || ev.data?.reason !== 'needs_consent' || dlg || opening) return;
  if (ev.data.trigger === 'auto') {
    if (!mx.analysis?.firstLaunch && !mx.analysis?.installed?.length) openFirstLaunch({ auto: true });
    return;
  }
  openConsent(ev.data.id);
});

window.hivedeskModels = { openFirstLaunch, openConsent, analyze };
