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
import { track, btn } from './util.js';

const V = window.V;
const local = V.reactive({ probe: null, probing: false, probeError: '', choice: null, url: '', key: '', model: '', doctor: null, doctoring: false });

function sourceText(d) {
  if (d.source) return d.source;
  try { const u = new URL(d.url); return `${u.host}${u.pathname.split('/').slice(0, 3).join('/')}`; } catch { return 'huggingface.co'; }
}

function downloadCard() {
  const s = S();
  const d = extra.download;
  const b = s.brain;
  if (!d && b.state !== 'needs_download' && b.state !== 'downloading') return null;
  const dd = d || {};
  const total = dd.total || dd.bytes || 0;
  const got = dd.received || 0;
  const pct = total ? Math.min(100, (got / total) * 100) : 0;
  const card = h('div', { class: 'dl', role: 'region', 'aria-label': 'Model download' });
  const phase = dd.phase || (b.state === 'downloading' ? 'downloading' : 'required');
  const title = { required: 'This model needs a download', downloading: 'Downloading the model', done: 'Model downloaded', failed: 'The download stopped' }[phase];
  card.append(h('div', { class: 'row' }, icon(phase === 'failed' ? 'x' : phase === 'done' ? 'check' : 'download', 'ico-lg'), h('div', { class: 'dl-t grow', text: title })));
  card.append(h('dl', { class: 'kv' },
    h('dt', { text: 'Model' }), h('dd', { text: shortModel(dd.model) || dd.model || 'Unknown' }),
    h('dt', { text: 'Size' }), h('dd', { text: total ? fmtBytes(total) : 'Unknown until the server answers' }),
    h('dt', { text: 'Source' }), h('dd', { class: 'mono', text: sourceText(dd) }),
    dd.file ? h('dt', { text: 'File' }) : null, dd.file ? h('dd', { class: 'mono', text: dd.file }) : null,
    dd.path ? h('dt', { text: 'Saved to' }) : null, dd.path ? h('dd', { class: 'mono', text: dd.path }) : null));
  if (phase === 'downloading') {
    const eta = dd.bps && total ? (total - got) / dd.bps : null;
    card.append(h('div', { class: 'bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(pct)), 'aria-label': 'Download progress' }, h('i', { style: `width:${pct}%` })),
      h('div', { class: 'row tiny muted', style: 'margin-top:6px' },
        h('span', { class: 'grow', text: `${fmtBytes(got)} of ${fmtBytes(total)} · ${Math.floor(pct)}%` }),
        dd.bps ? h('span', { text: `${fmtBytes(dd.bps)}/s` }) : null,
        eta != null && isFinite(eta) ? h('span', { text: `about ${fmtDuration(eta * 1000)} left` }) : null),
      h('div', { class: 'help', text: 'A cut download resumes where it stopped. The file is checked against its published checksum before use.' }));
  } else if (phase === 'required') {
    const auto = b.state !== 'needs_download';
    card.append(h('div', { class: 'help', style: 'margin:0 0 10px', text: auto
      ? 'The download starts by itself. It goes to the hivedesk cache on this computer and is reused by every project.'
      : `Nothing is downloaded until you press the button. It is ${total ? fmtBytes(total) : 'a large file'}, saved in the hivedesk cache on this computer.` }));
    if (!auto) card.append(h('div', { class: 'row' }, btn(`Download ${total ? fmtBytes(total) : 'the model'}`, () => act.startDownload(dd.model), 'btn btn-sm btn-primary', 'download'), h('span', { class: 'tiny muted', text: 'or choose Ollama, LM Studio or an endpoint below' })));
  } else if (phase === 'failed') {
    card.append(h('div', { class: 'honest bad', style: 'margin:0 0 10px' }, icon('x'), h('div', {}, h('b', { text: dd.message || 'The download failed.' }), dd.hint ? h('div', { class: 'small', style: 'margin-top:3px', text: dd.hint }) : null)),
      h('div', { class: 'row' }, btn('Retry', () => act.startDownload(dd.model), 'btn btn-sm btn-primary', 'download')));
  }
  return card;
}

function brainStatusCard() {
  const bi = brainInfo();
  const s = S();
  const box = h('div', { class: 'col' });
  box.append(h('div', { class: 'set-row' },
    h('span', { class: `sdot sdot-${bi.dot}`, style: 'width:10px;height:10px' }),
    h('div', { class: 'grow' }, h('b', { text: bi.label }), h('span', { text: bi.detail || (s.brain.backend ? `Backend: ${backendLabel(s.brain.backend)}` : '') })),
    bi.key === 'ready' && extra.stats.tps ? h('span', { class: 'hchip hchip-mono', text: `${extra.stats.tps.toFixed(1)} tok/s` }) : null,
    bi.indeterminate ? h('span', { class: 'spin' }) : null));
  if (extra.runtime?.state === 'installing' && extra.runtime.line) box.append(h('pre', { class: 'mono tiny muted', style: 'margin:0;padding:8px 10px;border-radius:8px;background:var(--bg-2);border:1px solid var(--line);white-space:pre-wrap', text: extra.runtime.line }));
  if (extra.runtime?.state === 'failed') box.append(h('div', { class: 'honest bad', style: 'margin:0' }, icon('x'), h('div', {}, h('b', { text: extra.runtime.message || 'The runtime install failed.' }), extra.runtime.hint ? h('div', { class: 'small', text: extra.runtime.hint }) : null)));
  if (extra.fallback) box.append(h('div', { class: 'honest warn', style: 'margin:0' }, icon('gpu'), h('div', { text: `Switched from ${backendLabel(extra.fallback.from?.backend)} ${shortModel(extra.fallback.from?.model)} to ${backendLabel(extra.fallback.to?.backend)} ${shortModel(extra.fallback.to?.model)}: ${extra.fallback.reason}` })));
  if (s.brains?.length > 1) box.append(h('div', { class: 'small muted', text: `${s.brains.length} brains attached: ${s.brains.map((b) => b.label).join(', ')}. Each one takes a turn at a time.` }));
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

function brainChoices() {
  const box = h('div');
  if (local.probing && !local.probe) { box.append(h('div', { class: 'row small muted' }, h('span', { class: 'spin' }), 'Looking for models on this computer...')); return box; }
  if (local.probeError) box.append(h('div', { class: 'honest bad', style: 'margin:0 0 8px' }, icon('x'), h('div', { text: `Could not list the options: ${local.probeError}` })));
  const opts = local.probe?.options || [];
  const rec = local.probe?.recommended;
  const fallbacks = [
    { backend: 'local', label: 'Local model (node-llama-cpp)', available: true },
    { backend: 'ollama', label: 'Ollama on this computer', available: false, reason: 'Not detected yet' },
    { backend: 'lmstudio', label: 'LM Studio on this computer', available: false, reason: 'Not detected yet' },
    { backend: 'openai', label: 'OpenAI compatible endpoint', available: true },
  ];
  const list = opts.length ? opts : fallbacks;
  if (!list.some((o) => o.backend === 'openai')) list.push({ backend: 'openai', label: 'OpenAI compatible endpoint', available: true });
  for (const o of list) {
    const key = `${o.backend}|${o.model || ''}`;
    const checked = local.choice === key || local.choice === o.backend;
    const isRec = rec && rec.backend === o.backend && (rec.model || '') === (o.model || '');
    const radio = h('input', { type: 'radio', name: 'brain-choice', checked, disabled: !o.available, on: { change: () => { local.choice = key; local.model = o.model || ''; } } });
    box.append(h('label', { class: 'opt', 'aria-disabled': o.available ? null : 'true' }, radio,
      h('div', { class: 'grow' }, h('div', { class: 'row', style: 'gap:6px' }, h('b', { text: o.label || backendLabel(o.backend) }), isRec ? h('span', { class: 'hchip hchip-honey', text: 'Recommended' }) : null),
        h('div', { class: 'muted', text: o.available ? [o.model ? shortModel(o.model) : null, o.url || null, o.size ? fmtBytes(o.size) : null].filter(Boolean).join(' · ') || backendHelp(o.backend) : (o.reason || 'Not available') }))));
  }
  const sel = list.find((o) => local.choice === `${o.backend}|${o.model || ''}` || local.choice === o.backend);
  if (sel?.backend === 'openai') {
    const url = h('input', { class: 'field-in', placeholder: 'https://your-endpoint/v1', value: local.url, 'aria-label': 'Endpoint URL', on: { input: (e) => { local.url = e.target.value; } } });
    const key = h('input', { class: 'field-in', type: 'password', placeholder: 'API key (optional)', value: local.key, autocomplete: 'off', 'aria-label': 'API key', on: { input: (e) => { local.key = e.target.value; } } });
    const model = h('input', { class: 'field-in', placeholder: 'Model name', value: local.model, 'aria-label': 'Model name', on: { input: (e) => { local.model = e.target.value; } } });
    box.append(h('div', { class: 'col', style: 'margin:4px 0 8px' }, url, h('div', { class: 'hire-grid' }, model, key),
      h('div', { class: 'help', text: 'The key stays in memory only: it is never written to the log or to disk. Prompts go to that endpoint.' })));
  }
  box.append(h('div', { class: 'row', style: 'margin-top:4px' },
    btn('Use this brain', async () => {
      if (!sel) return;
      const choice = { backend: sel.backend };
      if (sel.model || local.model) choice.model = sel.backend === 'openai' ? local.model : sel.model;
      if (sel.backend === 'openai') { if (!local.url) return; choice.url = local.url; if (local.key) choice.key = local.key; }
      else if (sel.url) choice.url = sel.url;
      await act.selectBrain(choice);
    }, 'btn btn-sm btn-primary', 'model'),
    btn(local.probing ? 'Checking...' : 'Check again', () => probe(), 'btn btn-sm btn-quiet')));
  return box;
}

function backendHelp(b) {
  return { local: 'Runs on this computer. First use downloads a model from the official Qwen repositories.', ollama: 'Uses a model you already pulled.', lmstudio: 'Uses the model loaded in LM Studio.', openai: 'Your own endpoint and key. Prompts leave this computer.' }[b] || '';
}

function hardwareGrid() {
  const hw = extra.hardware || local.probe?.hardware;
  if (!hw) return h('div', { class: 'small muted', text: 'Not detected yet.' });
  const gb = (n) => (n ? `${(n / 1e9).toFixed(n > 1e10 ? 0 : 1)} GB` : 'unknown');
  return h('div', { class: 'hw' },
    h('div', {}, h('small', { text: 'GPU' }), h('b', { text: hw.gpu?.name ? `${hw.gpu.name}` : 'None found' }), hw.gpu?.vramBytes ? h('small', { text: `${gb(hw.gpu.vramBytes)} VRAM` }) : null),
    h('div', {}, h('small', { text: 'Memory' }), h('b', { text: gb(hw.ramBytes) }), hw.freeRamBytes ? h('small', { text: `${gb(hw.freeRamBytes)} free` }) : null),
    h('div', {}, h('small', { text: 'CPU' }), h('b', { text: `${hw.cpus || '?'} cores` }), h('small', { text: `${hw.os || ''} ${hw.arch || ''}` })),
    h('div', {}, h('small', { text: 'Free disk' }), h('b', { text: gb(hw.diskFreeBytes) })));
}

function doctorView() {
  const box = h('div');
  box.append(btn(local.doctoring ? 'Checking...' : 'Run checks', async () => {
    local.doctoring = true;
    try { local.doctor = V.markRaw(await command('doctor', {}, { timeout: 60000 })); } catch (err) { local.doctor = V.markRaw({ ok: false, checks: [{ id: 'x', label: 'Doctor', ok: false, detail: err.message }] }); }
    local.doctoring = false;
  }, 'btn btn-sm btn-quiet', 'qa'));
  if (local.doctor) {
    for (const c of local.doctor.checks || []) {
      box.append(h('div', { class: 'check' }, icon(c.ok ? 'check' : 'x', 'ico-sm'),
        h('div', {}, h('b', { text: c.label, style: 'font-weight:600' }), h('div', { class: 'small muted', text: c.detail || '' }), c.hint && !c.ok ? h('div', { class: 'small', style: 'color:var(--warn)', text: c.hint }) : null)));
      box.lastChild.querySelector('.ico').style.color = c.ok ? 'var(--ok)' : 'var(--bad)';
    }
  }
  return box;
}

function toggleRow(title, desc, checked, onChange, extraEl) {
  const id = `t${Math.random().toString(36).slice(2, 7)}`;
  return h('div', { class: 'set-row' },
    h('label', { class: 'grow', for: id }, h('b', { text: title }), h('span', { text: desc })), extraEl || null,
    h('input', { type: 'checkbox', class: 'toggle toggle-primary', id, checked, on: { change: (e) => onChange(e.target.checked) } }));
}

const SHORTCUTS = [
  [['Ctrl', 'K'], 'Command palette'], [['/'], 'Focus the request box'], [['Ctrl', '`'], 'Next window, with Shift the previous one'],
  [['Ctrl', 'Alt', 'Left'], 'Snap left (Right snaps right)'], [['Ctrl', 'Alt', 'Up'], 'Maximize'], [['Ctrl', 'Alt', 'Down'], 'Restore or minimize'],
  [['Ctrl', 'Alt', '1'], 'Snap to a quarter (1 to 4)'], [['Ctrl', 'Alt', 'W'], 'Close the window'], [['Arrows'], 'Move a focused title bar, with Shift resize'],
  [['Shift', 'F10'], 'Context menu (also the Menu key)'],
];

register('settings', {
  title: 'Settings',
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
    pane.append(secBrain, secChoice, secCrew, secHw, secMore);

    track(() => [rev.brain, rev.settings, ui.connection, ui.hello], () => {
      clear(secBrain).append(h('h3', { id: 'set-brain', text: 'Model' }), brainStatusCard());
      const dl = downloadCard();
      if (dl) secBrain.append(h('div', { style: 'margin-top:10px' }, dl));
      ctx.setSub(brainInfo().label);
    });
    track(() => [local.probe, local.probing, local.probeError, local.choice, rev.settings], () => {
      const ae = document.activeElement;
      if (secChoice.contains(ae) && ae.tagName === 'INPUT' && ae.type !== 'radio') return; // do not steal focus while typing
      clear(secChoice).append(h('h3', { id: 'set-choice', text: 'Choose the brain' }),
        h('p', { class: 'small muted', style: 'margin:0 0 10px', text: 'One model serves the whole crew. Workers take turns on it, so a bigger model is smarter but every turn is slower.' }), brainChoices());
    });
    track(() => [rev.settings, ui.replay, ui.wallpaper], () => {
      const s = S().settings;
      clear(secCrew).append(h('h3', { text: 'Crew and desktop' }),
        toggleRow('Approval mode', 'Destructive actions wait for your answer. On by default.', !!s.approvalMode, (v) => act.setSettings({ approvalMode: v })),
        toggleRow('Sounds', 'A soft chime when a task or a job is done.', s.sound !== false && !isMuted(), (v) => { setMuted(!v); act.setSettings({ sound: v }); if (v) previewSound('task'); }, btn('Test', () => previewSound('job'), 'btn btn-xs btn-quiet')),
        toggleRow('Desktop notifications', 'Only while this tab is in the background.', systemEnabled(), async (v) => { const ok = await enableSystem(v); if (v && !ok) notify({ title: 'Notifications are blocked', body: 'Allow them for this page in the browser settings.', tone: 'warn' }); }),
        toggleRow('Reduce motion', 'Follows the system setting. Turn on to stop window animations here.', document.documentElement.dataset.motion === 'reduce', (v) => { document.documentElement.dataset.motion = v ? 'reduce' : ''; try { localStorage.setItem('hivedesk.motion', v ? 'reduce' : ''); } catch {} }),
        h('div', { class: 'set-row' }, h('div', { class: 'grow' }, h('b', { text: 'Layout' }), h('span', { text: 'Window positions are saved in this browser.' })), btn('Reset layout', () => import('../main.js').then((m) => m.resetLayout()), 'btn btn-xs btn-quiet')));
    });
    track(() => [rev.brain, local.probe], () => {
      clear(secHw).append(h('h3', { text: 'This computer' }), hardwareGrid(), h('div', { style: 'margin-top:12px' }, doctorView()));
    });
    track(() => [local.doctor, local.doctoring], () => {
      const old = secHw.lastChild;
      if (old) old.replaceWith(h('div', { style: 'margin-top:12px' }, doctorView()));
    });
    clear(secMore).append(h('h3', { text: 'Keyboard' }),
      h('div', { class: 'kv', style: 'grid-template-columns:auto 1fr;align-items:center' }, SHORTCUTS.flatMap(([keys, d]) => [h('dt', { class: 'row', style: 'gap:3px' }, keys.map((k) => h('kbd', { class: 'kbd', text: k }))), h('dd', { class: 'small', text: d })])),
      h('div', { class: 'hr' }),
      h('div', { class: 'small muted', text: `hivedesk ${ui.version || ''} · protocol 1. Your files, prompts and the event log stay on this computer.` }));
    if (!local.probe && !local.probing) probe();
    void wm;
  },
});
