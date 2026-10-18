// Settings: the brain (model) with the download prompt, approval mode, sound,
// notifications, desktop look and keyboard shortcuts.

import { h, icon, clear, fmtBytes, fmtDuration } from '../dom.js';
import { register } from '../wm.js';
import * as wm from '../wm.js';
import { S, rev, ui, extra } from '../store.js';
import { command } from '../net.js';
import * as act from '../actions.js';
import { brainInfo, backendLabel, shortModel } from '../brainstate.js';
import { setMuted, isMuted, preview as previewSound } from '../sound.js';
import { enableSystem, systemEnabled, notify } from '../notify.js';
import { t, tmap, fmtNumber, fmtKeys, fmtList, L, LOCALES, locale, setLocale } from '../i18n.js';
import { voiceSettings } from '../voice/index.js';
import { setTip } from '../tooltip.js';
import { track, btn } from './util.js';

const V = window.V;
const local = V.reactive({ probe: null, probing: false, probeError: '', choice: null, url: '', key: '', model: '', doctor: null, doctoring: false });

/** Puts a rich tooltip key on a node built by a helper (btn) and returns it. */
const tipped = (el, key, kb) => setTip(el, { key, kb });

function sourceText(d) {
  if (d.source) return d.source;
  try { const u = new URL(d.url); return `${u.host}${u.pathname.split('/').slice(0, 3).join('/')}`; } catch { return 'huggingface.co'; }
}

const DOWNLOAD_TITLE = tmap('settings.download.phase');

function downloadCard() {
  const s = S();
  const d = extra.download;
  const b = s.brain;
  if (!d && b.state !== 'needs_download' && b.state !== 'downloading') return null;
  const dd = d || {};
  const total = dd.total || dd.bytes || 0;
  const got = dd.received || 0;
  const pct = total ? Math.min(100, (got / total) * 100) : 0;
  const card = h('div', { class: 'dl', role: 'region', 'aria-label': t('settings.download.region') });
  const phase = dd.phase || (b.state === 'downloading' ? 'downloading' : 'required');
  const title = DOWNLOAD_TITLE[phase];
  card.append(h('div', { class: 'row' }, icon(phase === 'failed' ? 'x' : phase === 'done' ? 'check' : 'download', 'ico-lg'), h('div', { class: 'dl-t grow', text: title })));
  card.append(h('dl', { class: 'kv' },
    h('dt', { text: t('settings.download.model') }), h('dd', { text: shortModel(dd.model) || dd.model || t('settings.download.unknown') }),
    h('dt', { text: t('settings.download.size') }), h('dd', { text: total ? fmtBytes(total) : t('settings.download.sizeUnknown') }),
    h('dt', { text: t('settings.download.source') }), h('dd', { class: 'mono', text: sourceText(dd) }),
    dd.file ? h('dt', { text: t('settings.download.file') }) : null, dd.file ? h('dd', { class: 'mono', text: dd.file }) : null,
    dd.path ? h('dt', { text: t('settings.download.savedTo') }) : null, dd.path ? h('dd', { class: 'mono', text: dd.path }) : null));
  if (phase === 'downloading') {
    const eta = dd.bps && total ? (total - got) / dd.bps : null;
    card.append(h('div', { class: 'bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(pct)), 'aria-label': t('settings.download.progress') }, h('i', { style: `width:${pct}%` })),
      h('div', { class: 'row tiny muted', style: 'margin-top:6px' },
        h('span', { class: 'grow', text: t('settings.download.received', { got: fmtBytes(got), total: fmtBytes(total), pct: fmtNumber(Math.floor(pct) / 100, { style: 'percent' }) }) }),
        dd.bps ? h('span', { text: t('settings.download.speed', { speed: fmtBytes(dd.bps) }) }) : null,
        eta != null && isFinite(eta) ? h('span', { text: t('settings.download.eta', { time: fmtDuration(eta * 1000) }) }) : null),
      h('div', { class: 'help', text: t('settings.download.resumeHelp') }));
  } else if (phase === 'required') {
    const auto = b.state !== 'needs_download';
    card.append(h('div', { class: 'help', style: 'margin:0 0 10px', text: auto
      ? t('settings.download.auto')
      : total ? t('settings.download.manualSized', { size: fmtBytes(total) }) : t('settings.download.manual') }));
    if (!auto) {
      card.append(h('div', { class: 'row' },
        tipped(btn(total ? t('settings.download.startSized', { size: fmtBytes(total) }) : t('settings.download.start'), () => act.startDownload(dd.model), 'btn btn-sm btn-primary', 'download'), 'tip.settings.download'),
        h('span', { class: 'tiny muted', text: t('settings.download.orChoose') })));
    }
  } else if (phase === 'failed') {
    card.append(h('div', { class: 'honest bad', style: 'margin:0 0 10px' }, icon('x'), h('div', {}, h('b', { text: dd.message || t('settings.download.failed') }), dd.hint ? h('div', { class: 'small', style: 'margin-top:3px', text: dd.hint }) : null)),
      h('div', { class: 'row' }, tipped(btn(t('settings.download.retry'), () => act.startDownload(dd.model), 'btn btn-sm btn-primary', 'download'), 'tip.settings.retry')));
  }
  return card;
}

function brainStatusCard() {
  const bi = brainInfo();
  const s = S();
  const box = h('div', { class: 'col' });
  box.append(h('div', { class: 'set-row' },
    h('span', { class: `sdot sdot-${bi.dot}`, style: 'width:10px;height:10px' }),
    h('div', { class: 'grow' }, h('b', { text: bi.label }), h('span', { text: bi.detail || (s.brain.backend ? t('settings.brain.backend', { name: backendLabel(s.brain.backend) }) : '') })),
    bi.key === 'ready' && extra.stats.tps ? h('span', { class: 'hchip hchip-mono', text: t('settings.brain.tps', { tps: fmtNumber(extra.stats.tps, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) }) }) : null,
    bi.indeterminate ? h('span', { class: 'spin' }) : null));
  if (extra.runtime?.state === 'installing' && extra.runtime.line) box.append(h('pre', { class: 'mono tiny muted', style: 'margin:0;padding:8px 10px;border-radius:8px;background:var(--bg-2);border:1px solid var(--line);white-space:pre-wrap', text: extra.runtime.line }));
  if (extra.runtime?.state === 'failed') box.append(h('div', { class: 'honest bad', style: 'margin:0' }, icon('x'), h('div', {}, h('b', { text: extra.runtime.message || t('settings.brain.runtimeFailed') }), extra.runtime.hint ? h('div', { class: 'small', text: extra.runtime.hint }) : null)));
  if (extra.fallback) {
    const f = extra.fallback;
    box.append(h('div', { class: 'honest warn', style: 'margin:0' }, icon('gpu'), h('div', { text: t('settings.brain.fallback', {
      from: `${backendLabel(f.from?.backend)} ${shortModel(f.from?.model)}`.trim(),
      to: `${backendLabel(f.to?.backend)} ${shortModel(f.to?.model)}`.trim(),
      reason: f.reason || '',
    }) })));
  }
  if (s.brains?.length > 1) box.append(h('div', { class: 'small muted', text: t('settings.brain.attached', { count: s.brains.length, names: fmtList(s.brains.map((b) => b.label), 'unit') }) }));
  return box;
}

async function probe() {
  local.probing = true; local.probeError = '';
  try {
    const r = await command('brain.probe', {}, { timeout: 30000 });
    local.probe = V.markRaw(r);
    const cur = S().settings.brain;
    local.choice = local.choice || cur?.backend || r.recommended?.backend || null;
    if (cur?.url) local.url = cur.url;
  } catch (err) { local.probeError = err.message; }
  local.probing = false;
}

const BACKEND_TIPS = ['local', 'ollama', 'lmstudio', 'openai'];

function brainChoices() {
  const box = h('div');
  if (local.probing && !local.probe) { box.append(h('div', { class: 'row small muted' }, h('span', { class: 'spin' }), t('settings.choice.looking'))); return box; }
  if (local.probeError) box.append(h('div', { class: 'honest bad', style: 'margin:0 0 8px' }, icon('x'), h('div', { text: t('settings.choice.probeError', { error: local.probeError }) })));
  const opts = local.probe?.options || [];
  const rec = local.probe?.recommended;
  const fallbacks = [
    { backend: 'local', label: t('settings.choice.fallback.local'), available: true },
    { backend: 'ollama', label: t('settings.choice.fallback.ollama'), available: false, reason: t('settings.choice.notDetected') },
    { backend: 'lmstudio', label: t('settings.choice.fallback.lmstudio'), available: false, reason: t('settings.choice.notDetected') },
    { backend: 'openai', label: t('settings.choice.fallback.openai'), available: true },
  ];
  const list = opts.length ? opts : fallbacks;
  if (!list.some((o) => o.backend === 'openai')) list.push({ backend: 'openai', label: t('settings.choice.fallback.openai'), available: true });
  for (const o of list) {
    const key = `${o.backend}|${o.model || ''}`;
    const checked = local.choice === key || local.choice === o.backend;
    const isRec = rec && rec.backend === o.backend && (rec.model || '') === (o.model || '');
    const radio = h('input', { type: 'radio', name: 'brain-choice', checked, disabled: !o.available, tip: BACKEND_TIPS.includes(o.backend) ? `tip.settings.backend.${o.backend}` : 'tip.settings.backend.other', on: { change: () => { local.choice = key; local.model = o.model || ''; } } });
    box.append(h('label', { class: 'opt', 'aria-disabled': o.available ? null : 'true' }, radio,
      h('div', { class: 'grow' }, h('div', { class: 'row', style: 'gap:6px' }, h('b', { text: o.label || backendLabel(o.backend) }), isRec ? h('span', { class: 'hchip hchip-honey', text: t('settings.choice.recommended') }) : null),
        h('div', { class: 'muted', text: o.available ? [o.model ? shortModel(o.model) : null, o.url || null, o.size ? fmtBytes(o.size) : null].filter(Boolean).join(' · ') || backendHelp(o.backend) : (o.reason || t('settings.choice.notAvailable')) }))));
  }
  const sel = list.find((o) => local.choice === `${o.backend}|${o.model || ''}` || local.choice === o.backend);
  if (sel?.backend === 'openai') {
    const url = h('input', { class: 'field-in', tp: 'settings.endpoint.urlPlaceholder', value: local.url, ta: 'settings.endpoint.url', tip: 'tip.settings.endpointUrl', on: { input: (e) => { local.url = e.target.value; } } });
    const key = h('input', { class: 'field-in', type: 'password', tp: 'settings.endpoint.keyPlaceholder', value: local.key, autocomplete: 'off', ta: 'settings.endpoint.key', tip: 'tip.settings.endpointKey', on: { input: (e) => { local.key = e.target.value; } } });
    const model = h('input', { class: 'field-in', tp: 'settings.endpoint.model', value: local.model, ta: 'settings.endpoint.model', tip: 'tip.settings.endpointModel', on: { input: (e) => { local.model = e.target.value; } } });
    box.append(h('div', { class: 'col', style: 'margin:4px 0 8px' }, url, h('div', { class: 'hire-grid' }, model, key),
      h('div', { class: 'help', text: t('settings.endpoint.help') })));
  }
  box.append(h('div', { class: 'row', style: 'margin-top:4px' },
    tipped(btn(t('settings.choice.use'), async () => {
      if (!sel) return;
      const choice = { backend: sel.backend };
      if (sel.model || local.model) choice.model = sel.backend === 'openai' ? local.model : sel.model;
      if (sel.backend === 'openai') { if (!local.url) return; choice.url = local.url; if (local.key) choice.key = local.key; }
      else if (sel.url) choice.url = sel.url;
      await act.selectBrain(choice);
    }, 'btn btn-sm btn-primary', 'model'), 'tip.settings.useBrain'),
    tipped(btn(local.probing ? t('settings.checking') : t('settings.choice.checkAgain'), () => probe(), 'btn btn-sm btn-quiet'), 'tip.settings.checkAgain')));
  return box;
}

const BACKEND_HELP = tmap('settings.backendHelp');

function backendHelp(b) {
  return BACKEND_HELP[b] || '';
}

function hardwareGrid() {
  const hw = extra.hardware || local.probe?.hardware;
  if (!hw) return h('div', { class: 'small muted', text: t('settings.hw.notDetected') });
  const gb = (n) => (n ? fmtNumber(n / 1e9, { style: 'unit', unit: 'gigabyte', unitDisplay: 'short', maximumFractionDigits: n > 1e10 ? 0 : 1 }) : t('settings.hw.unknown'));
  return h('div', { class: 'hw' },
    h('div', {}, h('small', { text: t('settings.hw.gpu') }), h('b', { text: hw.gpu?.name ? `${hw.gpu.name}` : t('settings.hw.noGpu') }), hw.gpu?.vramBytes ? h('small', { text: t('settings.hw.vram', { size: gb(hw.gpu.vramBytes) }) }) : null),
    h('div', {}, h('small', { text: t('settings.hw.memory') }), h('b', { text: gb(hw.ramBytes) }), hw.freeRamBytes ? h('small', { text: t('settings.hw.free', { size: gb(hw.freeRamBytes) }) }) : null),
    h('div', {}, h('small', { text: t('settings.hw.cpu') }), h('b', { text: hw.cpus ? t('settings.hw.cores', { count: hw.cpus }) : t('settings.hw.coresUnknown') }), h('small', { text: `${hw.os || ''} ${hw.arch || ''}` })),
    h('div', {}, h('small', { text: t('settings.hw.disk') }), h('b', { text: gb(hw.diskFreeBytes) })));
}

function doctorView() {
  const box = h('div');
  box.append(tipped(btn(local.doctoring ? t('settings.checking') : t('settings.doctor.run'), async () => {
    local.doctoring = true;
    try { local.doctor = V.markRaw(await command('doctor', {}, { timeout: 60000 })); } catch (err) { local.doctor = V.markRaw({ ok: false, checks: [{ id: 'x', label: t('settings.doctor.label'), ok: false, detail: err.message }] }); }
    local.doctoring = false;
  }, 'btn btn-sm btn-quiet', 'qa'), 'tip.settings.doctor'));
  if (local.doctor) {
    for (const c of local.doctor.checks || []) {
      box.append(h('div', { class: 'check' }, icon(c.ok ? 'check' : 'x', 'ico-sm'),
        h('div', {}, h('b', { text: c.label, style: 'font-weight:600' }), h('div', { class: 'small muted', text: c.detail || '' }), c.hint && !c.ok ? h('div', { class: 'small', style: 'color:var(--warn)', text: c.hint }) : null)));
      box.lastChild.querySelector('.ico').style.color = c.ok ? 'var(--ok)' : 'var(--bad)';
    }
  }
  return box;
}

/** A setting with a switch. `tip` is the tooltip key of the switch (tip.settings.*). */
function toggleRow(title, desc, checked, onChange, extraEl, tip) {
  const id = `t${Math.random().toString(36).slice(2, 7)}`;
  return h('div', { class: 'set-row' },
    h('label', { class: 'grow', for: id }, h('b', { text: title }), h('span', { text: desc })), extraEl || null,
    h('input', { type: 'checkbox', class: 'toggle toggle-primary', id, checked, tip, on: { change: (e) => onChange(e.target.checked) } }));
}

// keys as typed (fmtKeys translates them at render time), then the description key under settings.keyboard
const SHORTCUTS = [
  [['Ctrl', 'K'], 'palette'], [['/'], 'focusAsk'], [['Ctrl', '`'], 'nextWindow'],
  [['Ctrl', 'Alt', 'Left'], 'snapLeft'], [['Ctrl', 'Alt', 'Up'], 'maximize'], [['Ctrl', 'Alt', 'Down'], 'restore'],
  [['Ctrl', 'Alt', '1'], 'quarter'], [['Ctrl', 'Alt', 'W'], 'close'], [['Arrows'], 'moveTitle'],
  [['Shift', 'F10'], 'contextMenu'],
];

const keyLabel = (k) => (k === 'Arrows' ? t('settings.keyboard.arrows') : fmtKeys(k)[0] || k);

register('settings', {
  title: () => t('settings.title'),
  glyph: () => icon('model'),
  size: [560, 640],
  min: [340, 320],
  cardH: 620,
  create(ctx) {
    const pane = h('div', { class: 'pane set' });
    ctx.body.append(pane);
    const secBrain = h('section', { class: 'set-sec', 'aria-labelledby': 'set-brain' });
    const secChoice = h('section', { class: 'set-sec', 'aria-labelledby': 'set-choice' });
    const secCrew = h('section', { class: 'set-sec' });
    const secHw = h('section', { class: 'set-sec' });
    const secMore = h('section', { class: 'set-sec' });
    const secLang = h('section', { class: 'set-sec set-lang', 'aria-labelledby': 'set-lang', dataset: { tour: 'settings-language' } });
    const voice = voiceSettings();
    ctx.onDispose(voice.dispose);
    const secHelp = h('section', { class: 'set-sec set-help', 'aria-labelledby': 'set-help' });
    // Profile: your name and avatar (docs/1.0/PROFILE.md); the page has the rest
    const secProfile = h('section', { class: 'set-sec set-profile' });
    import('/profile/ui.js').then((m) => {
      const paintProfile = () => {
        clear(secProfile).append(h('h3', { text: m.pt('profile.settings') }),
          h('div', { class: 'set-row' }, m.avatarEl(m.profileView()?.profile, 36), h('div', { class: 'grow' }, h('b', { text: m.myName() }), h('span', { text: m.pt('profile.settings.sub') })),
            h('button', { type: 'button', class: 'btn btn-sm btn-quiet', text: m.pt('profile.open'), on: { click: () => wm.open('profile') } })));
      };
      paintProfile();
      ctx.onDispose(m.onProfile(paintProfile));
    }).catch(() => {});
    pane.append(secProfile, secLang, secBrain, secChoice, secCrew, voice.el, secHw, secMore, secHelp);
    // Sections added by modules (ui/models/: Settings, Models), shown after the brain choice.
    for (const make of globalThis.hivedeskSettingsSections || []) { try { const el = make(ctx); if (el) secCrew.before(el); } catch (err) { console.error(err); } }

    // Language: a live switch, no reload
    track(() => [L.code], () => {
      const sel = h('select', { class: 'input', id: 'set-lang-sel', tip: 'tip.settings.lang', on: { change: (e) => setLocale(e.target.value) } },
        LOCALES.map((l) => h('option', { value: l.code, text: l.name, selected: l.code === locale(), lang: l.code })));
      clear(secLang).append(h('h3', { id: 'set-lang', text: t('settings.lang.title'), tip: 'tip.settings.lang' }),
        h('div', { class: 'set-row' }, h('label', { class: 'grow', for: 'set-lang-sel' }, h('b', { text: t('settings.lang.label') }), h('span', { text: t('settings.lang.note') })), sel));
    });
    // Help: the tour, the shortcuts and About
    track(() => [ui.version], () => {
      clear(secHelp).append(h('h3', { id: 'set-help', text: t('settings.help.title') }),
        h('div', { class: 'row set-help-btns' },
          tipped(btn(t('settings.help.tour'), () => import('../tour.js').then((m) => m.startTour()), 'btn btn-sm btn-quiet', 'compass'), 'tip.settings.tour'),
          tipped(btn(t('settings.help.shortcuts'), () => import('../help.js').then((m) => m.openShortcuts()), 'btn btn-sm btn-quiet', 'plan'), 'tip.settings.shortcuts'),
          tipped(btn(t('settings.help.about'), () => import('../about.js').then((m) => m.openAbout()), 'btn btn-sm btn-quiet', 'hive'), 'tip.settings.about')));
    });

    track(() => [rev.brain, rev.settings, ui.connection, ui.hello], () => {
      clear(secBrain).append(h('h3', { id: 'set-brain', text: t('settings.brain.title'), tip: 'tip.settings.brain' }), brainStatusCard());
      const dl = downloadCard();
      if (dl) secBrain.append(h('div', { style: 'margin-top:10px' }, dl));
      ctx.setSub(brainInfo().label);
    });
    track(() => [local.probe, local.probing, local.probeError, local.choice, rev.settings], () => {
      const ae = document.activeElement;
      if (secChoice.contains(ae) && ae.tagName === 'INPUT' && ae.type !== 'radio') return; // do not steal focus while typing
      clear(secChoice).append(h('h3', { id: 'set-choice', text: t('settings.choice.title'), tip: 'tip.settings.choice' }),
        h('p', { class: 'small muted', style: 'margin:0 0 10px', text: t('settings.choice.intro') }), brainChoices());
    });
    track(() => [rev.settings, ui.replay, ui.wallpaper], () => {
      const s = S().settings;
      clear(secCrew).append(h('h3', { text: t('settings.crew.title'), tip: 'tip.settings.crew' }),
        toggleRow(t('settings.crew.approval'), t('settings.crew.approvalDesc'), !!s.approvalMode, (v) => act.setSettings({ approvalMode: v }), null, 'tip.settings.approval'),
        toggleRow(t('settings.crew.sounds'), t('settings.crew.soundsDesc'), s.sound !== false && !isMuted(), (v) => { setMuted(!v); act.setSettings({ sound: v }); if (v) previewSound('task'); },
          tipped(btn(t('settings.crew.test'), () => previewSound('job'), 'btn btn-xs btn-quiet'), 'tip.settings.testSound'), 'tip.settings.sounds'),
        toggleRow(t('settings.crew.notifications'), t('settings.crew.notificationsDesc'), systemEnabled(), async (v) => { const ok = await enableSystem(v); if (v && !ok) notify({ title: t('settings.crew.blocked'), body: t('settings.crew.blockedBody'), tone: 'warn' }); }, null, 'tip.settings.notifications'),
        toggleRow(t('settings.crew.motion'), t('settings.crew.motionDesc'), document.documentElement.dataset.motion === 'reduce', (v) => { document.documentElement.dataset.motion = v ? 'reduce' : ''; try { localStorage.setItem('hivedesk.motion', v ? 'reduce' : ''); } catch {} }, null, 'tip.settings.motion'),
        h('div', { class: 'set-row' }, h('div', { class: 'grow' }, h('b', { text: t('settings.crew.layout') }), h('span', { text: t('settings.crew.layoutDesc') })),
          tipped(btn(t('settings.crew.resetLayout'), () => import('../main.js').then((m) => m.resetLayout()), 'btn btn-xs btn-quiet'), 'tip.settings.resetLayout')));
    });
    track(() => [rev.brain, local.probe], () => {
      clear(secHw).append(h('h3', { text: t('settings.hw.title'), tip: 'tip.settings.hardware' }), hardwareGrid(), h('div', { style: 'margin-top:12px' }, doctorView()));
    });
    track(() => [local.doctor, local.doctoring], () => {
      const old = secHw.lastChild;
      if (old) old.replaceWith(h('div', { style: 'margin-top:12px' }, doctorView()));
    });
    // rendered through track() so the shortcut list follows a language switch
    track(() => [ui.version], () => {
      clear(secMore).append(h('h3', { text: t('settings.keyboard.title'), tip: 'tip.settings.keyboard' }),
        h('div', { class: 'kv', style: 'grid-template-columns:auto 1fr;align-items:center' }, SHORTCUTS.flatMap(([keys, d]) => [h('dt', { class: 'row', style: 'gap:3px' }, keys.map((k) => h('kbd', { class: 'kbd', text: keyLabel(k) }))), h('dd', { class: 'small', text: t(`settings.keyboard.${d}`) })])),
        h('div', { class: 'hr' }),
        h('div', { class: 'small muted', text: t('settings.footer', { version: ui.version || '' }) }));
    });
    if (!local.probe && !local.probing) probe();
    void wm;
  },
});
