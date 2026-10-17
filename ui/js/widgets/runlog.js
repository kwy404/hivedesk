// Run log: every command the crew ran in the workspace, with live output.

import { h, icon, clear, fmtDuration, fmtTime } from '../dom.js';
import { register } from '../wm.js';
import { S, rev, ui, extra } from '../store.js';
import { provide } from '../menu.js';
import * as act from '../actions.js';
import { t } from '../i18n.js';
import { track, stateBox, stickyScroll } from './util.js';

const open = new Set();

function outPre(stdout, stderr) {
  const pre = h('pre');
  if (stdout) pre.append(stdout);
  if (stderr) pre.append(h('span', { class: 'err', text: stderr }));
  if (!stdout && !stderr) pre.append(h('span', { class: 'faint', text: t('runlog.noOutput') }));
  return pre;
}

register('runlog', {
  title: () => t('runlog.title'),
  glyph: () => icon('terminal'),
  size: [560, 380],
  min: [300, 200],
  cardH: 400,
  create(ctx) {
    const pane = h('div', { class: 'pane', role: 'log', ta: 'runlog.aria' });
    const foot = h('div', { class: 'foot tiny muted row' }, icon('lock', 'ico-sm'), h('span', { tx: 'runlog.foot' }));
    ctx.body.append(pane, foot);
    const sticky = stickyScroll(pane);
    provide(pane, (target) => {
      const run = target.closest?.('.run');
      if (!run?.__run) return null;
      const r = run.__run;
      return [
        { label: t('runlog.menu.copyCommand'), icon: 'copy', action: () => act.copy(r.command, t('runlog.commandCopied')) },
        { label: t('runlog.menu.copyOutput'), icon: 'copy', action: () => act.copy([r.stdout, r.stderr].filter(Boolean).join('\n'), t('runlog.outputCopied')) },
        { label: open.has(r.callId) ? t('runlog.menu.collapse') : t('runlog.menu.expand'), icon: 'terminal', action: () => { if (open.has(r.callId)) open.delete(r.callId); else open.add(r.callId); render(); } },
      ];
    });
    pane.addEventListener('click', (e) => {
      const hd = e.target.closest('.run-h');
      if (!hd) return;
      const id = hd.parentElement.__run.callId;
      if (open.has(id)) open.delete(id); else open.add(id);
      render();
    });
    let count = 0;
    function render() {
      const s = S();
      const pinned = sticky.before();
      clear(pane);
      const runs = s.runs || [];
      const liveRuns = ui.replay ? [] : Object.values(extra.runLive);
      ctx.setSub(liveRuns.length ? t('runlog.sub.running') : runs.length ? t('runlog.sub.runs', { count: runs.length }) : '');
      if (!runs.length && !liveRuns.length) {
        pane.append(stateBox({ icon: 'terminal', title: t('runlog.empty.title'), text: t('runlog.empty.text') }));
        return;
      }
      runs.forEach((r, i) => {
        const isOpen = i === runs.length - 1 ? !open.has(r.callId) : open.has(r.callId);
        const ok = r.exitCode === 0 && !r.timedOut;
        const el = h('div', { class: `run${isOpen ? '' : ' closed'}` },
          h('div', { class: 'run-h', role: 'button', tabindex: '0', 'aria-expanded': String(isOpen), tip: isOpen ? 'tip.runlog.hide' : 'tip.runlog.show' },
            icon(ok ? 'check' : 'x', 'ico-sm'),
            h('span', { class: 'mono grow', text: `$ ${r.command}` }),
            r.timedOut ? h('span', { class: 'hchip hchip-warn', text: t('runlog.timedOut') }) : h('span', { class: `hchip ${ok ? 'hchip-ok' : 'hchip-bad'}`, text: t('runlog.exit', { code: String(r.exitCode) }) }),
            h('span', { class: 'tiny faint', text: `${fmtDuration(r.ms)} · ${fmtTime(r.ts)}` })),
          outPre(r.stdout, r.stderr));
        el.__run = r;
        el.querySelector('.ico').style.color = ok ? 'var(--ok)' : 'var(--bad)';
        pane.append(el);
      });
      for (const lr of liveRuns) {
        const cmd = Object.values(extra.tools).flat().find((c) => c.callId === lr.callId)?.args?.command;
        const el = h('div', { class: 'run' }, h('div', { class: 'run-h' }, h('span', { class: 'spin' }), h('span', { class: 'mono grow', text: cmd ? `$ ${cmd}` : t('runlog.runningCommand') }), h('span', { class: 'hchip hchip-honey', text: t('runlog.running') })), h('pre', { text: lr.out || '' }));
        el.__run = { callId: lr.callId, command: '', stdout: lr.out };
        pane.append(el);
      }
      const n = runs.length + liveRuns.length;
      sticky.after(pinned || n !== count);
      count = n;
    }
    track(() => [rev.runs, ui.replay], render);
  },
});
