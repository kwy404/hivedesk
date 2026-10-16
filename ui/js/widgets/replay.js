// Replay scrubber: rebuild any moment from events.jsonl and show it on the whole desktop.

import { h, icon, clear, fmtTime } from '../dom.js';
import { register } from '../wm.js';
import { rev, ui, liveState, enterReplay, exitReplay, onEvent, worker } from '../store.js';
import { command } from '../net.js';
import { notify } from '../notify.js';
import { track, btn } from './util.js';

const KIND = { 'job.created': 'job', 'job.done': 'done', 'job.failed': 'fail', 'approval.requested': 'approval', 'file.changed': 'file' };

function describe(ev) {
  if (!ev) return '';
  const d = ev.data || {};
  const name = (id) => worker(id).name;
  switch (ev.type) {
    case 'job.created': return `New job: ${d.job?.request || ''}`;
    case 'job.planned': return `Mel planned ${(d.tasks || []).length} tasks`;
    case 'job.done': return 'Job done';
    case 'job.failed': return 'Job failed';
    case 'task.status': return `Task ${d.status}`;
    case 'file.changed': return `${name(d.workerId)} ${d.op === 'create' ? 'created' : d.op === 'delete' ? 'deleted' : 'edited'} ${d.path}`;
    case 'chat.message': return `${name(d.from)}: ${String(d.text || '').slice(0, 70)}`;
    case 'approval.requested': return `${name(d.approval?.workerId)} asked for approval`;
    case 'approval.resolved': return d.approved ? 'Approved' : 'Rejected';
    case 'run.finished': return `Ran ${d.command} (exit ${d.exitCode})`;
    case 'turn.started': return `${name(d.workerId)} took a turn on the model`;
    default: return ev.type;
  }
}

register('replay', {
  title: 'Replay',
  glyph: () => icon('replay'),
  size: [620, 250],
  min: [340, 220],
  cardH: 280,
  create(ctx) {
    const events = [];
    let loaded = false;
    const track_ = h('div', { class: 'scrub-track', role: 'presentation' });
    const fill = h('div', { class: 'scrub-fill' });
    const headEl = h('div', { class: 'scrub-head' });
    const range = h('input', { type: 'range', min: '1', max: '1', value: '1', step: '1', 'aria-label': 'Event number' });
    const info = h('div', { class: 'row small', style: 'margin-top:10px;min-height:22px' });
    const playBtn = btn('Play', () => togglePlay(), 'btn btn-sm btn-quiet', 'replay');
    const speed = h('div', { class: 'seg', role: 'group', 'aria-label': 'Speed' }, ...[1, 4, 16].map((x) => h('button', { type: 'button', 'aria-pressed': String(x === 4), dataset: { x }, text: `${x}x`, on: { click: (e) => { spd = x; for (const b of speed.children) b.setAttribute('aria-pressed', String(b === e.currentTarget)); } } })));
    const liveBtn = btn('Back to live', () => goLive(), 'btn btn-sm btn-primary', 'arrow');
    ctx.body.append(h('div', { class: 'scrub' }, track_, range, info, h('div', { class: 'row', style: 'margin-top:10px;flex-wrap:wrap' }, playBtn, speed, h('span', { class: 'grow' }), liveBtn)),
      h('div', { class: 'foot tiny muted', text: 'Replay rebuilds the desktop from the event log. Nothing is re-run and no model is used.' }));
    let spd = 4;
    let playing = null;
    let inflight = false;
    let wanted = null;

    async function load() {
      try {
        const r = await command('events.since', { seq: 0, limit: 20000 }, { timeout: 60000 });
        events.length = 0;
        for (const e of r.events || []) events.push({ seq: e.seq, ts: e.ts, type: e.type, data: e.type === 'file.changed' ? { path: e.data?.path, op: e.data?.op, workerId: e.data?.workerId } : e.data });
        loaded = true;
      } catch (err) {
        notify({ title: 'Could not load the event log', body: err.message, tone: 'bad' });
      }
      paint();
    }
    const off = onEvent((ev) => { events.push({ seq: ev.seq, ts: ev.ts, type: ev.type, data: ev.data }); if (!ui.replay) paint(); });
    ctx.onDispose(() => { off(); clearInterval(playing); if (ui.replay) exitReplay(); });

    function paintMarkers() {
      for (const m of track_.querySelectorAll('.mk')) m.remove();
      const last = liveState().lastSeq || 1;
      const frag = document.createDocumentFragment();
      let lastX = -1;
      for (const e of events) {
        const k = KIND[e.type];
        if (!k) continue;
        const x = (e.seq / last) * 100;
        if (k === 'file' && x - lastX < 0.4) continue;
        lastX = x;
        frag.append(h('div', { class: 'mk', dataset: { k }, style: `left:${x}%` }));
      }
      track_.append(frag);
    }

    function paint() {
      const last = liveState().lastSeq || 0;
      range.max = String(Math.max(1, last));
      const seq = ui.replay ? ui.replay.seq : last;
      range.value = String(seq);
      const p = last ? (seq / last) * 100 : 100;
      fill.style.width = `${p}%`;
      headEl.style.left = `calc(${p}% - 1px)`;
      if (!fill.isConnected) track_.append(fill, headEl);
      paintMarkers();
      clear(info);
      const ev = events.find((e) => e.seq === seq) || events[events.length - 1];
      if (!last) { info.append(h('span', { class: 'muted', text: 'The log is empty. Start a job and come back.' })); return; }
      info.append(
        ui.replay ? h('span', { class: 'hchip hchip-honey', text: 'Replaying' }) : h('span', { class: 'hchip hchip-ok', text: 'Live' }),
        h('span', { class: 'mono tiny muted', text: `#${seq} of ${last}` }),
        ev?.ts ? h('span', { class: 'tiny muted', text: fmtTime(ev.ts) }) : null,
        h('span', { class: 'grow ellipsis', text: loaded ? describe(ev) : 'Loading the event log...' }));
      liveBtn.disabled = !ui.replay;
      ctx.setSub(ui.replay ? `at #${seq}` : 'live');
    }

    async function goTo(seq) {
      const last = liveState().lastSeq;
      seq = Math.max(1, Math.min(last, Math.round(seq)));
      if (seq >= last) { goLive(); return; }
      wanted = seq;
      if (inflight) return;
      inflight = true;
      while (wanted != null) {
        const s = wanted;
        wanted = null;
        try {
          const r = await command('replay.at', { seq: s }, { timeout: 30000 });
          enterReplay(r.state || r, s);
        } catch (err) {
          notify({ title: 'Replay failed', body: err.message, tone: 'bad' });
          break;
        }
      }
      inflight = false;
    }

    function goLive() { stopPlay(); if (ui.replay) exitReplay(); paint(); }
    function stopPlay() { clearInterval(playing); playing = null; playBtn.lastChild.textContent = 'Play'; }
    function togglePlay() {
      if (playing) { stopPlay(); return; }
      if (!ui.replay) goTo(1);
      playBtn.lastChild.textContent = 'Pause';
      playing = setInterval(() => {
        if (inflight) return;
        const cur = ui.replay ? ui.replay.seq : 1;
        if (cur >= liveState().lastSeq) { goLive(); return; }
        goTo(cur + spd);
      }, 160);
    }

    range.addEventListener('input', () => { stopPlay(); goTo(+range.value); });
    const seekAt = (e) => { const r = track_.getBoundingClientRect(); goTo(((e.clientX - r.left) / r.width) * liveState().lastSeq); };
    track_.addEventListener('pointerdown', (e) => {
      stopPlay();
      track_.setPointerCapture(e.pointerId);
      seekAt(e);
      const mv = (ev) => seekAt(ev);
      const up = () => { track_.removeEventListener('pointermove', mv); track_.removeEventListener('pointerup', up); };
      track_.addEventListener('pointermove', mv);
      track_.addEventListener('pointerup', up);
    });

    track(() => [ui.replay, rev.all], paint);
    load();
  },
});
