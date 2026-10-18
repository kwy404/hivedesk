// The City side panels for 1.0: Machines (real probes or "not measured"), a task (pipeline,
// loops, history), a model job (decision, lease, countdown, the failure choices), a peer
// (fingerprint, grants, revoke) and the Activity stream. DOM only; every value comes from the
// City view (model.js), the compute view (compute.js), the peers view (peers.js) or activity.js.

import { h, clear, ago } from '/js/dom.js';
import { fmtNumber } from '/js/i18n.js';
import { beeAvatar } from '/js/bees.js';
import { tr } from './strings.js';
import { hub } from './hub.js';
import { machinesView, gb } from './machines.js';
import { jobView, jobCommand, STOP_SHARING } from './compute.js';
import { peerView, PEER_COMMANDS } from './peers.js';
import { activityFrom, filterActivity, KINDS } from './activity.js';
import { ROOM_COLOR } from './model.js';
import { avatarEl, myAvatarEl } from '/profile/ui.js';

const ROLE_OF_ROOM = { design: 'architect', code: 'developer', test: 'qa', review: 'reviewer', lobby: 'planner', library: 'writer', ops: 'ops' };
const avatarOf = (a) => ({ id: a.workerId || a.id, name: a.name, role: a.role, color: a.color });
const svg = (path, cls = 'ico ico-sm') => `<svg viewBox="0 0 24 24" class="${cls}">${path}</svg>`;

/* Sparklines of the samples this window received (per machine and field). Never invented: the line
   starts empty and grows one point per new probe sample (its sampledAt), up to the last 40. */
const HIST = new Map();
function record(c, f) {
  if (!f || f.value == null || c.sampledAt == null || !(f.state === 'measured' || f.state === 'reported')) return null;
  let v = null;
  if (f.key === 'gpuUtil' || f.key === 'cpu') v = f.value / 100;
  else if ((f.key === 'vram' || f.key === 'ram') && f.value.usedBytes != null && f.value.totalBytes) v = f.value.usedBytes / f.value.totalBytes;
  if (v == null || !Number.isFinite(v)) return null;
  const key = `${c.id}:${f.key}`;
  const list = HIST.get(key) || [];
  if (!list.length || list[list.length - 1].at !== c.sampledAt) {
    list.push({ at: c.sampledAt, v: Math.max(0, Math.min(1, v)) });
    if (list.length > 40) list.shift();
    HIST.set(key, list);
  }
  return list;
}
function spark(list) {
  if (!list || list.length < 2) return null;
  const n = list.length;
  const pts = list.map((p, i) => `${((i / (n - 1)) * 40).toFixed(1)},${(13 - p.v * 12).toFixed(1)}`).join(' ');
  const last = list[n - 1];
  return h('span', { class: 'ct-sparkw', 'aria-hidden': 'true', html: `<svg class="ct-spark" viewBox="0 0 40 14" preserveAspectRatio="none"><polyline points="${pts}"/><circle cx="40" cy="${(13 - last.v * 12).toFixed(1)}" r="1.6"/></svg>` });
}

/**
 * @param {{ view: () => any, cmd: (type: string, data?: object) => Promise<any>, open: (side: object) => void, close: () => void,
 *   roomName: (id: string) => string, agentName: (id: string) => string, machineName: (id: string) => string,
 *   peerName: (id: string) => string, mine: () => boolean, demo: () => boolean, invite: () => void, openWindow: (type: string) => void }} ctx
 */
export function makePanels(ctx) {
  const btn = (key, on, cls = 'btn btn-xs', params) => h('button', { type: 'button', class: cls, text: tr(key, params), on: { click: on } });
  const run = (type, data) => () => ctx.cmd(type, data).catch(() => {});
  const faint = (text, cls = 'ct-faint small') => h('div', { class: cls, text });
  const head = (title, sub, extra) => h('div', { class: 'ct-panel-h' }, h('strong', { text: title }), extra || null, sub ? h('span', { class: 'ct-faint small ct-sub', text: sub }) : null);

  /* ---------- Machines ---------- */
  function sourceText(f, card) {
    if (!f || f.state === 'unknown') return tr('city.src.unknown');
    if (f.state === 'none') return tr('city.src.none');
    const s = String(f.source || '');
    if (f.state === 'reported') return tr('city.src.reported', { name: card.name });
    if (f.state === 'joined') return tr('city.src.joined', { name: card.name });
    if (f.state === 'estimate') return tr('city.src.estimate');
    if (f.state === 'stale') return tr('city.src.stale');
    if (s === 'startup') return tr('city.src.startup');
    if (s === 'turn.ended') return tr('city.src.turns');
    if (s === 'scheduler') return tr('city.src.scheduler');
    if (s === 'brain') return tr('city.src.brain');
    return tr('city.src.probe', { source: s || 'probe' });
  }

  function valueOf(f, card) {
    const nm = h('span', { class: 'ct-unknown', text: tr('city.m.notMeasured') });
    if (!f || f.value == null) return f?.state === 'none' ? h('span', { text: tr('city.machine.noGpu') }) : nm;
    const line = card ? spark(record(card, f)) : null;
    switch (f.key) {
      case 'vram': case 'ram': {
        const { usedBytes, totalBytes } = f.value;
        if (usedBytes == null) return h('span', {}, h('span', { class: 'ct-num', text: tr('city.m.total', { gb: fmtNumber(gb(totalBytes)) }) }), h('span', { class: 'ct-unknown', text: `, ${tr('city.m.usedUnknown')}` }));
        const pct = totalBytes ? Math.round((usedBytes / totalBytes) * 100) : 0;
        return h('span', { class: 'ct-meter' }, h('span', { class: 'ct-bar', style: `--v:${pct}%` }, h('i')), h('span', { class: 'ct-num', text: tr('city.m.usedOf', { used: fmtNumber(gb(usedBytes)), total: fmtNumber(gb(totalBytes)) }) }), line);
      }
      case 'gpuUtil': case 'cpu': {
        const pct = Math.round(f.value);
        return h('span', { class: 'ct-meter' }, h('span', { class: 'ct-bar', style: `--v:${pct}%` }, h('i')), h('span', { class: 'ct-num', text: `${fmtNumber(pct)}%${f.cores ? ` · ${tr('city.m.cores', { n: f.cores })}` : ''}` }), line);
      }
      case 'tps': return h('span', { class: 'ct-num', text: tr('city.m.tps', { n: fmtNumber(f.value) }) });
      case 'slots': return h('span', { class: 'ct-num', text: tr('city.m.slots', { busy: f.value.busy, total: f.value.total }) });
      case 'model': return h('span', {}, h('span', { class: 'ct-mono', text: f.value }), f.loaded ? h('span', { class: 'ct-tag ct-ok', text: tr('city.m.loaded') }) : null);
      case 'gpu': return h('span', { text: `${f.value}${f.count > 1 ? ` +${f.count - 1}` : ''}` });
      default: return h('span', { text: String(f.value) });
    }
  }

  function stateLine(card) {
    const key = { measured: 'city.m.state.measured', reported: 'city.m.state.reported', stale: 'city.m.state.stale', static: 'city.m.state.static', joined: 'city.m.state.joined' }[card.state] || 'city.m.state.unknown';
    const secs = card.sampledAt ? Math.max(0, Math.round((Date.now() - card.sampledAt) / 1000)) : null;
    return faint(tr(key, { name: card.name, s: secs ?? 0 }), `ct-faint small ct-mstate ct-mstate-${card.state}`);
  }

  function machines(focusId) {
    const v = ctx.view();
    const cards = machinesView(v, hub.compute, { selfPeerId: hub.selfPeerId, demo: ctx.demo() });
    const box = h('div', { class: 'ct-machines' }, head(tr('city.machine.title'), tr('city.m.sub')));
    for (const c of cards) {
      const card = h('section', { class: 'ct-mcard', dataset: { focus: String(c.id === focusId), id: c.id }, style: `--c:${c.color}` });
      // the owner: your own avatar, or the name and avatar the friend showed over its session
      const owner = c.self ? null : (c.peerId ? hub.peers.peers[c.peerId]?.profile : null);
      card.append(h('div', { class: 'ct-mhead' }, c.self ? myAvatarEl(22) : owner ? avatarEl(owner, 22) : h('i', { class: 'ct-hexdot' }), h('strong', { text: c.name }), owner ? h('span', { class: 'ct-faint small', text: owner.name }) : null,
        h('span', { class: 'ct-tag', style: `--c:${c.self ? 'var(--honey)' : c.color}`, text: tr(c.self ? 'city.machine.host' : 'city.machine.friend') }),
        c.demo ? h('span', { class: 'ct-tag ct-info', text: tr('city.demo') }) : null,
        h('span', { class: `ct-online ${c.online ? 'on' : ''}`, text: tr(c.online ? 'city.machine.online' : 'city.machine.offline') })));
      card.append(stateLine(c));
      const grid = h('dl', { class: 'ct-grid' });
      for (const f of c.fields) {
        grid.append(h('dt', { text: tr(`city.m.f.${f.key}`) }), h('dd', { title: sourceText(f, c), dataset: { state: f.state, k: f.key } }, valueOf(f, c)));
      }
      card.append(grid);
      // jobs that run here, with their leases; a job for a peer can be stopped by the owner
      if (c.jobs.length) {
        const ul = h('div', { class: 'ct-jobs' }, h('div', { class: 'of-k', text: tr('city.m.jobs') }));
        for (const j of c.jobs) {
          const cd = j.countdown;
          ul.append(h('div', { class: 'ct-job', dataset: { s: j.state } },
            h('button', { type: 'button', class: 'ct-linkbtn', text: `${tr(`city.job.state.${j.state}`)} · ${j.model || tr('city.job.anyModel')}`, on: { click: () => ctx.open({ kind: 'job', id: j.id }) } }),
            h('span', { class: 'ct-faint small', text: tr('city.job.tokens', { n: fmtNumber(j.tokens) }) }),
            cd?.lease != null ? h('span', { class: 'ct-faint small', text: tr('city.job.leaseLeft', { s: cd.lease }) }) : null,
            j.forPeer ? btn('city.job.stop', run(...jobCommand('stop', j.id)), 'btn btn-xs btn-danger') : null));
        }
        card.append(ul);
      }
      // the owner's share settings, as set; a friend's are what its advert says
      const sh = c.share;
      const shareBox = h('div', { class: 'ct-share' }, h('div', { class: 'of-k', text: tr('city.m.share') }));
      if (!sh) shareBox.append(faint(tr(c.self ? 'city.m.shareUnknownSelf' : 'city.m.shareUnknown', { name: c.name })));
      else {
        shareBox.append(faint(sh.enabled && sh.remoteInference ? tr('city.m.shareOn') : tr('city.m.shareOff'), `ct-small ${sh.enabled ? 'ct-on' : ''}`));
        if (sh.enabled) {
          shareBox.append(faint(tr('city.m.shareLimits', {
            jobs: sh.maxConcurrentJobs ?? '?', seconds: sh.maxJobSeconds ?? '?', tokens: sh.maxTokensPerJob ?? '?',
            vram: sh.maxVramBytes == null ? tr('city.m.vramAuto') : `${fmtNumber(gb(sh.maxVramBytes))} GB`
          })));
          if (sh.modelAllowlist.length) shareBox.append(faint(tr('city.m.models', { list: sh.modelAllowlist.join(', ') })));
          if (sh.hours) shareBox.append(faint(tr('city.m.hours', { from: sh.hours.from, to: sh.hours.to })));
          if (c.self) shareBox.append(btn('city.m.stopSharing', run(...STOP_SHARING), 'btn btn-xs btn-danger'));
        }
        if (!c.self) shareBox.append(faint(tr('city.m.advisory'), 'ct-faint tiny'));
      }
      card.append(shareBox);
      // 0.2 GPU borrows across the bridge
      for (const b of c.borrows) {
        card.append(h('div', { class: 'ct-borrow' }, h('span', { class: 'ct-gl ct-cable', html: svg('<path d="M4 12h5l2-4 3 8 2-4h4"/>') }),
          h('span', { text: tr('city.borrow.active', { agent: ctx.agentName(b.agentId), machine: ctx.machineName(b.to) }) }),
          h('span', { class: 'ct-faint small', text: tr('city.borrow.turns', { used: b.used, limit: b.limit ?? '?' }) }),
          btn('city.borrow.stop', run('city.borrow.stop', { borrowId: b.id }), 'btn btn-xs btn-danger')));
      }
      for (const b of c.pending) {
        card.append(h('div', { class: 'ct-borrow ct-ask' }, h('span', { text: tr('city.borrow.request', { agent: ctx.agentName(b.agentId), machine: c.name }) }),
          c.self ? btn('city.borrow.accept', run('city.borrow.answer', { borrowId: b.id, accept: true }), 'btn btn-xs btn-primary') : null,
          c.self ? btn('city.borrow.refuse', run('city.borrow.answer', { borrowId: b.id, accept: false }), 'btn btn-xs btn-quiet') : null));
      }
      const row = h('div', { class: 'ct-avs' });
      for (const id of c.agents) {
        const a = v.agents[id];
        if (a) row.append(h('button', { type: 'button', class: 'ct-avbtn', title: a.name, 'aria-label': a.name, on: { click: () => ctx.open({ kind: 'agent', id }) } }, beeAvatar(avatarOf(a), 28, { ring: true })));
      }
      card.append(h('div', { class: 'ct-faint small', text: tr('city.machine.agents') }), row);
      if (c.peerId) card.append(btn('city.peer.open', () => ctx.open({ kind: 'peer', id: c.peerId }), 'btn btn-xs btn-quiet'));
      box.append(card);
    }
    box.append(h('div', { class: 'ct-acts' }, btn('city.invite', () => ctx.invite()), btn('city.m.window', () => ctx.openWindow('machines'), 'btn btn-xs btn-quiet')));
    requestAnimationFrame(() => box.querySelector('[data-focus="true"]')?.scrollIntoView({ block: 'nearest' }));
    return box;
  }

  /* ---------- a task: pipeline, loops, history ---------- */
  function pipelineStrip(t, v) {
    const stages = t.pipeline.length ? t.pipeline : [t.room];
    const wrap = h('div', { class: 'ct-pipe', role: 'list', 'aria-label': tr('city.tp.pipeline') });
    stages.forEach((r, i) => {
      const done = t.status === 'done' || i < t.stage;
      const cur = i === t.stage && t.status !== 'done';
      const role = v.rooms[r]?.role || ROLE_OF_ROOM[r];
      wrap.append(h('div', { class: 'ct-stage', role: 'listitem', dataset: { done: String(done), cur: String(cur) }, style: `--c:${ROOM_COLOR[r] || v.rooms[r]?.color || '#FFB531'}` },
        h('b', { text: ctx.roomName(r) }), role ? h('span', { text: tr(`city.role.${role}`) }) : null));
      if (i < stages.length - 1) wrap.append(h('span', { class: 'ct-arrow-r', 'aria-hidden': 'true', html: svg('<path d="M5 12h12M13 7l5 5-5 5"/>') }));
    });
    // loops: an arc back for every time a check sent the task back
    const backs = (t.verdicts || []).filter((x) => !x.passed && x.by !== 'user').length;
    if (t.loops) {
      wrap.append(h('div', { class: 'ct-loopnote', dataset: { n: String(t.loops) } },
        h('span', { class: 'ct-gl', html: svg('<path d="M20 12a8 8 0 1 1-3-6.2M20 4v5h-5"/>') }),
        h('span', { text: tr('city.tp.loops', { n: t.loops, max: t.maxLoops, checks: backs }) })));
    }
    return wrap;
  }

  function task(id) {
    const v = ctx.view();
    const t = v.tasks[id];
    if (!t) return null;
    const a = t.assignee && v.agents[t.assignee];
    const box = h('div', { class: 'ct-taskpanel', style: `--c:${ROOM_COLOR[t.room] || '#FFB531'}` });
    box.append(head(t.title, null, h('span', { class: 'ct-tag ct-state', dataset: { s: t.state || t.status }, text: tr(`city.state.${t.state || 'queued'}`) })));
    const grid = h('dl', { class: 'ct-grid' });
    grid.append(
      h('dt', { text: tr('city.card.room') }), h('dd', { text: ctx.roomName(t.room) }),
      h('dt', { text: tr('city.tp.who') }), h('dd', {}, a ? h('button', { type: 'button', class: 'ct-linkbtn ct-who', on: { click: () => ctx.open({ kind: 'agent', id: a.id }) } }, beeAvatar(avatarOf(a), 16, { ring: false }), h('span', { text: a.name })) : h('span', { class: 'ct-faint', text: tr('city.card.none') })),
      h('dt', { text: tr('city.tp.by') }), h('dd', { text: t.createdBy?.kind === 'guest' ? tr('city.tp.byGuest', { name: t.createdBy.name || '' }) : t.createdBy?.kind === 'planner' ? tr('city.tp.byPlanner') : tr('city.tp.byYou') }));
    box.append(grid, pipelineStrip(t, v));
    if (t.detail) box.append(h('p', { class: 'ct-about', text: t.detail.slice(0, 600) }));
    // why it waits, and what can be done
    const w = t.waitingFor;
    if (w) {
      const wb = h('div', { class: 'ct-wait', dataset: { k: w.kind } }, h('strong', { text: tr(`city.tp.wait.${w.kind}`, { room: ctx.roomName(w.ref || ''), ref: w.ref || '' }) }));
      const acts = h('div', { class: 'ct-acts' });
      if (w.kind === 'approval') acts.append(btn('city.task.approve', run('city.task.approve', { taskId: id }), 'btn btn-xs btn-primary'), btn('city.task.reject', run('city.task.reject', { taskId: id, note: tr('city.task.rejectNote') })));
      if (w.kind === 'resource' || w.kind === 'peer') acts.append(btn('city.tp.openMachines', () => ctx.open({ kind: 'machine' })));
      acts.append(btn('city.task.cancel', run('city.task.cancel', { taskId: id }), 'btn btn-xs btn-quiet'));
      wb.append(acts);
      box.append(wb);
    }
    // the model jobs of this task (compute plane)
    const jobs = hub.compute.order.map((jid) => hub.compute.jobs[jid]).filter((j) => j && j.taskId === id).slice(-3).reverse();
    if (jobs.length) {
      const sec = h('section', { class: 'ct-sec' }, h('span', { class: 'of-k', text: tr('city.tp.jobs') }));
      for (const j of jobs) sec.append(jobRow(j));
      box.append(sec);
    }
    // verdicts
    if (t.verdicts.length) {
      const sec = h('section', { class: 'ct-sec' }, h('span', { class: 'of-k', text: tr('city.tp.verdicts') }));
      for (const x of t.verdicts.slice(-6).reverse()) {
        sec.append(h('div', { class: 'ct-verdict', dataset: { ok: String(!!x.passed) } },
          h('b', { text: `${ctx.roomName(x.room)}: ${tr(x.passed ? 'city.tp.passed' : 'city.tp.failed')}` }),
          h('span', { class: 'ct-faint small', text: tr(`city.tp.verdictBy.${x.by}`, { agent: x.agentId ? ctx.agentName(x.agentId) : '' }) }),
          x.issues?.length ? h('div', { class: 'ct-issues', text: x.issues.slice(0, 3).join(' · ') }) : null));
      }
      box.append(sec);
    }
    if (t.files.length) box.append(h('section', { class: 'ct-sec' }, h('span', { class: 'of-k', text: tr('city.tp.files') }), h('div', { class: 'ct-files', text: t.files.slice(0, 12).join(', ') })));
    // history: every state change, with who and why
    if (t.history.length) {
      const ol = h('ol', { class: 'ct-hist' });
      for (const x of t.history.slice(-12).reverse()) {
        ol.append(h('li', {}, h('span', { class: 'ct-tag ct-state', dataset: { s: x.to }, text: tr(`city.state.${x.to}`) }),
          h('span', { class: 'ct-faint small', text: `${ago(x.ts)}${x.reason ? ` · ${x.reason}` : ''}` })));
      }
      box.append(h('section', { class: 'ct-sec' }, h('span', { class: 'of-k', text: tr('city.tp.history') }), ol));
    }
    const acts = h('div', { class: 'ct-acts' });
    if (t.awaiting && !w) acts.append(btn('city.task.approve', run('city.task.approve', { taskId: id }), 'btn btn-xs btn-primary'));
    if (t.status === 'blocked') acts.append(btn('city.task.retry', run('city.task.retry', { taskId: id })));
    if (!['done', 'blocked'].includes(t.status)) {
      const sel = h('select', { class: 'ct-select', 'aria-label': tr('city.menu.handTo'), on: { change: (e) => { if (e.target.value) ctx.cmd('city.task.assign', { taskId: id, agentId: e.target.value }).catch(() => {}); } } },
        h('option', { value: '', text: tr('city.menu.handTo') }), ...Object.values(v.agents).map((x) => h('option', { value: x.id, text: `${x.name} (${x.role})` })));
      acts.append(sel);
      if (!w) acts.append(btn('city.task.cancel', run('city.task.cancel', { taskId: id }), 'btn btn-xs btn-quiet'));
    }
    acts.append(btn('city.tp.activity', () => ctx.open({ kind: 'activity', taskId: id }), 'btn btn-xs btn-quiet'));
    box.append(acts);
    return box;
  }

  /* ---------- a model job ---------- */
  const jobOpts = () => ({ selfPeerId: hub.selfPeerId, peerName: ctx.peerName });

  function failureButtons(jv) {
    const acts = h('div', { class: 'ct-acts ct-failacts' });
    for (const k of jv.actions) {
      if (k === 'retryLocal') acts.append(btn('city.fail.retryLocal', run(...jobCommand(k, jv.id)), 'btn btn-xs btn-primary'));
      else if (k === 'retryPeer') acts.append(btn('city.fail.retryPeer', run(...jobCommand(k, jv.id))));
      else if (k === 'usePartial') acts.append(btn('city.fail.usePartial', run(...jobCommand(k, jv.id))));
      else if (k === 'cancel') acts.append(btn('city.fail.cancel', run(...jobCommand(k, jv.id)), 'btn btn-xs btn-quiet'));
      else if (k === 'stop') acts.append(btn('city.job.stop', run(...jobCommand(k, jv.id)), 'btn btn-xs btn-danger'));
      else if (k === 'openMachines') acts.append(btn('city.m.window', () => ctx.openWindow('machines'), 'btn btn-xs'));
    }
    return acts;
  }

  function jobRow(j) {
    const jv = jobView(j, jobOpts());
    return h('div', { class: 'ct-job', dataset: { s: jv.state } },
      h('button', { type: 'button', class: 'ct-linkbtn', text: `${tr(`city.job.state.${jv.state}`)} · ${jv.where ? tr(`city.job.where.${jv.where.kind}`, { name: jv.where.name || '' }) : tr('city.job.notScheduled')}`, on: { click: () => ctx.open({ kind: 'job', id: jv.id }) } }),
      jv.error ? h('span', { class: 'ct-faint small ct-bad', text: tr(`city.job.err.${jv.error.code}`) }) : null,
      jv.actions.length && !['cancel', 'stop'].includes(jv.actions[0]) ? failureButtons(jv) : null);
  }

  function job(id) {
    const j = hub.compute.jobs[id];
    if (!j) return h('div', { class: 'ct-jobpanel' }, head(tr('city.job.title')), faint(tr('city.job.gone')));
    const jv = jobView(j, jobOpts());
    const box = h('div', { class: 'ct-jobpanel' }, head(tr('city.job.title'), null, h('span', { class: 'ct-tag ct-state', dataset: { s: jv.state }, text: tr(`city.job.state.${jv.state}`) })));
    const grid = h('dl', { class: 'ct-grid' });
    grid.append(
      h('dt', { text: tr('city.job.where') }), h('dd', { text: jv.where ? tr(`city.job.where.${jv.where.kind}`, { name: jv.where.name || '' }) : tr('city.job.notScheduled') }),
      h('dt', { text: tr('city.machine.model') }), h('dd', { text: jv.model || tr('city.job.anyModel') }),
      h('dt', { text: tr('city.job.tokensK') }), h('dd', {}, h('span', { text: fmtNumber(jv.tokens) }), jv.live ? h('span', { class: 'ct-live', text: tr('city.job.streaming') }) : null));
    if (jv.agentId) grid.append(h('dt', { text: tr('city.tp.who') }), h('dd', { text: ctx.agentName(jv.agentId) }));
    if (jv.estimateMs != null) grid.append(h('dt', { text: tr('city.job.estimate') }), h('dd', { text: tr('city.job.seconds', { s: Math.round(jv.estimateMs / 1000) }) }));
    box.append(grid);
    if (jv.reason) box.append(h('p', { class: 'ct-about ct-reason', text: jv.reason }));
    if (jv.rejected.length) {
      const ul = h('ul', { class: 'ct-cands' });
      for (const x of jv.rejected) ul.append(h('li', {}, h('b', { text: String(x.target || '') }), h('span', { class: 'ct-faint small', text: ` ${tr(`city.job.reject.${x.code || 'other'}`)}${x.detail ? `: ${x.detail}` : ''}` })));
      box.append(h('section', { class: 'ct-sec' }, h('span', { class: 'of-k', text: tr('city.job.rejected') }), ul));
    }
    if (jv.lease) {
      const cd = jv.countdown;
      box.append(h('section', { class: 'ct-sec ct-lease' }, h('span', { class: 'of-k', text: tr('city.job.lease') }),
        faint(tr(`city.job.leaseState.${jv.lease.state}`)),
        cd ? h('div', { class: 'ct-countdown', role: 'timer' },
          cd.lease != null ? h('span', { text: tr('city.job.leaseLeft', { s: cd.lease }) }) : null,
          cd.deadline != null ? h('span', { text: tr('city.job.deadlineLeft', { s: cd.deadline }) }) : null) : null,
        jv.lease.maxTokens != null ? faint(tr('city.job.leaseLimits', { tokens: fmtNumber(jv.lease.maxTokens), vram: jv.lease.vramBytes != null ? fmtNumber(gb(jv.lease.vramBytes)) : '?' })) : null));
    }
    if (jv.error) box.append(h('div', { class: 'ct-wait ct-failbox', dataset: { k: 'failed' } }, h('strong', { text: tr(`city.job.err.${jv.error.code}`) }), jv.error.message ? faint(jv.error.message) : null));
    if (jv.partial) box.append(faint(tr('city.job.partial', { n: fmtNumber(jv.partial.chars) })));
    if (jv.result) box.append(faint(tr('city.job.result', { tokens: fmtNumber(jv.result.tokens ?? 0), s: Math.round((jv.result.ms || 0) / 1000) })));
    if (jv.actions.length) box.append(failureButtons(jv));
    return box;
  }

  /* ---------- a peer ---------- */
  function peer(id) {
    const v = ctx.view();
    const pv = peerView(hub.peers, id, { members: v.members, machines: Object.fromEntries(Object.values(v.machines).map((m) => [m.id, m])), agents: v.agents });
    if (!pv) return null;
    const prof = hub.peers.peers[id]?.profile;
    const box = h('div', { class: 'ct-peerpanel' }, head(prof?.name || pv.name, null, h('span', { class: `ct-online ${pv.online ? 'on' : ''}`, text: tr(pv.online ? 'city.machine.online' : 'city.machine.offline') })));
    box.prepend(avatarEl(prof || { name: pv.name }, 48, 'ct-peer-av'));
    if (pv.fingerprint?.words?.length) {
      box.append(h('div', { class: 'ct-fp' }, h('span', { class: 'of-k', text: tr('city.peer.fingerprint') }),
        h('div', { class: 'ct-words' }, ...pv.fingerprint.words.map((w) => h('span', { text: w }))),
        pv.fingerprint.short ? faint(pv.fingerprint.short, 'ct-faint tiny ct-mono') : null));
    } else box.append(faint(tr(pv.known ? 'city.peer.noFingerprint' : 'city.peer.legacy')));
    box.append(h('div', { class: 'ct-rules' }, h('span', { class: 'ct-tag', dataset: { trust: pv.trust }, text: tr(`city.peer.trust.${pv.trust}`) }),
      pv.member && !pv.member.leftAt ? h('span', { class: 'ct-tag ct-info', text: tr('city.peer.member') }) : null));
    if (pv.member) box.append(faint(pv.member.leftAt ? tr('city.peer.left', { when: ago(pv.member.leftAt), reason: tr(`city.peer.reason.${pv.member.reason || 'left'}`) }) : tr('city.peer.joined', { when: ago(pv.member.joinedAt), via: tr(`city.peer.via.${pv.member.via || 'invite'}`) })));
    // grants: what this peer may do here
    const gs = h('section', { class: 'ct-sec' }, h('span', { class: 'of-k', text: tr('city.peer.grants') }));
    if (!pv.grants.length) gs.append(faint(tr('city.peer.noGrants')));
    for (const g of pv.grants) {
      gs.append(h('div', { class: 'ct-grant' }, h('b', { text: tr(`city.cap.${g.capability}`) }),
        h('span', { class: 'ct-faint small', text: g.expiresIn != null ? tr('city.peer.expires', { s: g.expiresIn }) : tr(`city.peer.scope.${g.scope}`) }),
        ctx.mine() ? btn('city.peer.revoke', run(PEER_COMMANDS.revoke, { grantId: g.id, reason: 'revoked by the owner' }), 'btn btn-xs btn-danger') : null));
    }
    box.append(gs);
    if (pv.agents.length) {
      const row = h('div', { class: 'ct-avs' });
      for (const aid of pv.agents) { const a = v.agents[aid]; if (a) row.append(h('button', { type: 'button', class: 'ct-avbtn', title: a.name, 'aria-label': a.name, on: { click: () => ctx.open({ kind: 'agent', id: aid }) } }, beeAvatar(avatarOf(a), 26, { ring: true }))); }
      box.append(h('section', { class: 'ct-sec' }, h('span', { class: 'of-k', text: tr('city.peer.agents') }), row));
    }
    const acts = h('div', { class: 'ct-acts' });
    if (pv.machineId) acts.append(btn('city.peer.building', () => ctx.open({ kind: 'machine', id: pv.machineId })));
    if (ctx.mine() && pv.machineId && v.machines[pv.machineId]?.online) acts.append(btn('city.peer.takeOut', run('city.machine.leave', { machineId: pv.machineId, reason: 'removed by the host' }), 'btn btn-xs btn-quiet'));
    // Remote screen (src/remote/): ask to see this peer's screen over its open session; its owner decides.
    if (ctx.mine() && pv.online && pv.sessionId && globalThis.hivedeskRemote?.askRemote) acts.append(btn('remote.title', () => globalThis.hivedeskRemote.askRemote(pv.sessionId, { control: false, clipboard: false, files: false }), 'btn btn-xs'));
    if (ctx.mine() && pv.known && pv.trust !== 'blocked') acts.append(btn('city.peer.block', run(PEER_COMMANDS.block, { peerId: id }), 'btn btn-xs btn-danger'));
    acts.append(btn('city.tp.activity', () => ctx.open({ kind: 'activity', peerId: id }), 'btn btn-xs btn-quiet'));
    box.append(acts);
    return box;
  }

  /* ---------- the Activity stream (side panel) ---------- */
  let filter = { kind: '', q: '' };
  function activity(side = {}) {
    const lineText = (e) => tr(e.key, e.p);
    const entries = filterActivity(activityFrom(hub.recent, ctx.names()), { ...filter, taskId: side.taskId, peerId: side.peerId }, lineText).reverse().slice(0, 200);
    const box = h('div', { class: 'ct-activity' }, head(tr('city.act.title'), side.taskId ? ctx.view().tasks[side.taskId]?.title : side.peerId ? ctx.peerName(side.peerId) : tr('city.act.sub')));
    const kind = h('select', { class: 'ct-select', 'aria-label': tr('city.act.kind'), on: { change: (e) => { filter.kind = e.target.value; ctx.repaint(); } } },
      h('option', { value: '', text: tr('city.act.all') }), ...KINDS.map((k) => h('option', { value: k, text: tr(`city.act.kind.${k}`), selected: filter.kind === k })));
    const q = h('input', { class: 'ct-input', type: 'search', value: filter.q, placeholder: tr('city.act.search'), 'aria-label': tr('city.act.search'), on: { change: (e) => { filter.q = e.target.value; ctx.repaint(); } } });
    box.append(h('div', { class: 'ct-add' }, kind, q));
    const ol = h('ol', { class: 'ct-actlist' });
    for (const e of entries) {
      const target = e.jobId ? { kind: 'job', id: e.jobId } : e.taskId ? { kind: 'task', id: e.taskId } : e.peerId ? { kind: 'peer', id: e.peerId } : e.agentId ? { kind: 'agent', id: e.agentId } : null;
      const li = h('li', { dataset: { tone: e.tone || '', k: e.kind } }, h('span', { class: 'of-dot' }),
        target ? h('button', { type: 'button', class: 'ct-linkbtn', text: lineText(e), on: { click: () => ctx.open(target) } }) : h('span', { text: lineText(e) }),
        h('time', { class: 'ct-faint tiny', datetime: e.ts, text: ago(e.ts) }));
      ol.append(li);
    }
    if (!entries.length) ol.append(h('li', { class: 'ct-faint', text: tr('city.act.empty') }));
    box.append(ol, h('div', { class: 'ct-acts' }, btn('city.act.window', () => ctx.openWindow('activity'), 'btn btn-xs')));
    return box;
  }

  return { machines, task, job, peer, activity, clearFilter: () => { filter = { kind: '', q: '' }; } };
}

export { clear };
