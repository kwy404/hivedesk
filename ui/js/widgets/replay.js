// Replay scrubber: rebuild any moment from events.jsonl and show it on the whole desktop.

import { h, icon, clear, fmtTime, append } from '../dom.js';
import { register } from '../wm.js';
import { rev, ui, liveState, enterReplay, exitReplay, onEvent, worker } from '../store.js';
import { command } from '../net.js';
import { notify } from '../notify.js';
import { t } from '../i18n.js';
import { track, STATUS_LABEL } from './util.js';

const KIND = { 'job.created': 'job', 'job.done': 'done', 'job.failed': 'fail', 'approval.requested': 'approval', 'file.changed': 'file' };

function describe(ev) {
  if (!ev) return '';
  const d = ev.data || {};
  const name = (id) => worker(id).name;
  switch (ev.type) {
    case 'job.created': return t('replay.ev.jobCreated', { request: d.job?.request || '' });
    case 'job.planned': return t('replay.ev.jobPlanned', { count: (d.tasks || []).length });
    case 'job.done': return t('replay.ev.jobDone');
    case 'job.failed': return t('replay.ev.jobFailed');
    case 'task.status': return t('replay.ev.taskStatus', { status: String(d.status || '') });
    case 'file.changed': return t('replay.ev.fileChanged', { name: name(d.workerId), op: String(d.op || ''), path: d.path });
    case 'chat.message': return t('replay.ev.chat', { name: name(d.from), text: String(d.text || '').slice(0, 70) });
    case 'approval.requested': return t('replay.ev.approvalRequested', { name: name(d.approval?.workerId) });
    case 'approval.resolved': return d.approved ? t('replay.ev.approved') : t('replay.ev.rejected');
    case 'run.finished': return t('replay.ev.runFinished', { command: d.command, code: String(d.exitCode) });
    case 'turn.started': return t('replay.ev.turnStarted', { name: name(d.workerId) });
    case 'turn.ended': return t('replay.ev.turnEnded', { name: name(d.workerId) });
    case 'queue.updated': return t('replay.ev.queue', { running: (d.running || []).length, waiting: (d.waiting || []).length });
    case 'worker.status': return t('replay.ev.workerStatus', { name: name(d.workerId), status: STATUS_LABEL[d.status] || String(d.status || '').replace('_', ' ') });
    case 'tool.called': return d.args?.path ? t('replay.ev.toolCalledOn', { name: name(d.workerId), tool: d.tool, path: d.args.path }) : t('replay.ev.toolCalled', { name: name(d.workerId), tool: d.tool });
    case 'tool.result': return d.ok ? t('replay.ev.toolFinished') : t('replay.ev.toolFailed');
    case 'qa.report': return d.passed ? t('replay.ev.qaPassed') : t('replay.ev.qaFound', { count: (d.issues || []).length });
    case 'playbook.saved': return t('replay.ev.playbookSaved');
    case 'brain.status': return t('replay.ev.brainStatus', { state: d.state });
    default: return ev.type;
  }
}

/** A button whose label is a translation key that can change later (Play / Pause). */
function keyBtn(key, onClick, cls, ic, tip) {
  return h('button', { type: 'button', class: cls, tip, on: { click: onClick } }, ic ? icon(ic, 'ico-sm') : null, h('span', { tx: key }));
}

function setKey(el, key) {
  el.dataset.tx = key;
  el.textContent = t(key);
}

register('replay', {
  title: () => t('replay.title'),
  glyph: () => icon('replay'),
  size: [620, 250],
  min: [340, 220],
  cardH: 280,
  create(ctx) {
    const events = [];
    let loaded = false;
    const track_ = h('div', { class: 'scrub-track', role: 'presentation', tip: 'tip.replay.track' });
    const fill = h('div', { class: 'scrub-fill' });
    const headEl = h('div', { class: 'scrub-head' });
    const range = h('input', { type: 'range', min: '1', max: '1', value: '1', step: '1', ta: 'replay.rangeAria', tip: 'tip.replay.range', kb: 'Left Right' });
    const info = h('div', { class: 'row small', style: 'margin-top:10px;min-height:22px' });
    const playBtn = keyBtn('replay.play', () => togglePlay(), 'btn btn-sm btn-quiet', 'replay', 'tip.replay.play');
    const speed = h('div', { class: 'seg', role: 'group', ta: 'replay.speedAria' }, ...[1, 4, 16].map((x) => h('button', { type: 'button', 'aria-pressed': String(x === 4), dataset: { x }, tx: 'replay.speedValue', txArgs: { x }, tip: 'tip.replay.speed', on: { click: (e) => { spd = x; for (const b of speed.children) b.setAttribute('aria-pressed', String(b === e.currentTarget)); } } })));
    const liveBtn = keyBtn('replay.backToLive', () => goLive(), 'btn btn-sm btn-primary', 'arrow', 'tip.replay.live');
    ctx.body.append(h('div', { class: 'scrub' }, track_, range, info, h('div', { class: 'row', style: 'margin-top:10px;flex-wrap:wrap' }, playBtn, speed, h('span', { class: 'grow' }), liveBtn)),
      h('div', { class: 'foot tiny muted', tx: 'replay.foot' }));
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
        notify({ title: t('replay.loadFailed'), body: err.message, tone: 'bad' });
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
      if (!last) { info.append(h('span', { class: 'muted', text: t('replay.empty') })); return; }
      append(info, [
        ui.replay ? h('span', { class: 'hchip hchip-honey', text: t('replay.replaying') }) : h('span', { class: 'hchip hchip-ok', text: t('replay.live') }),
        h('span', { class: 'mono tiny muted', text: t('replay.position', { seq, last }) }),
        ev?.ts ? h('span', { class: 'tiny muted', text: fmtTime(ev.ts) }) : null,
        h('span', { class: 'grow ellipsis', text: loaded ? describe(ev) : t('replay.loading') })]);
      liveBtn.disabled = !ui.replay;
      ctx.setSub(ui.replay ? t('replay.sub.at', { seq }) : t('replay.sub.live'));
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
          notify({ title: t('replay.failed'), body: err.message, tone: 'bad' });
          break;
        }
      }
      inflight = false;
    }

    function goLive() { stopPlay(); if (ui.replay) exitReplay(); paint(); }
    function stopPlay() { clearInterval(playing); playing = null; setKey(playBtn.lastChild, 'replay.play'); }
    function togglePlay() {
      if (playing) { stopPlay(); return; }
      if (!ui.replay) goTo(1);
      setKey(playBtn.lastChild, 'replay.pause');
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
