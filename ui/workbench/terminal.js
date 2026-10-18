// The terminal panel: real terminals on this machine (src/workbench/pty.js) drawn with xterm.js
// (vendored in ui/workbench/vendor/xterm). Without a PTY the engine runs a "basic terminal" over
// pipes; this panel then edits the line itself and labels the tab. Sharing a terminal with a
// peer names the peer, the mode and a time limit, shows a "shared" badge with a stop button,
// and needs the P2P plane; the engine checks the grant for every byte.

import { h, clear } from '/js/dom.js';
import { openDialog } from '/js/dialog.js';
import { wb, onFrame } from './net.js';
import { tw } from './strings.js';
import { lineEdit } from './util.js';

const BASE = '/workbench/vendor/xterm';
let loading = null;

/** Loads xterm.js without letting the editor's AMD loader claim it. */
function loadXterm() {
  loading ??= (async () => {
    if (!document.querySelector(`link[href="${BASE}/xterm.css"]`)) document.head.append(h('link', { rel: 'stylesheet', href: `${BASE}/xterm.css` }));
    const get = async (f) => {
      const r = await fetch(`${BASE}/${f}`, { cache: 'force-cache' });
      if (!r.ok) throw new Error(`${f}: ${r.status}`);
      return r.text();
    };
    const run = (src) => {
      const module = { exports: {} };
      new Function('module', 'exports', 'define', src)(module, module.exports, undefined);
      return module.exports;
    };
    const [x, fit] = await Promise.all([get('xterm.js'), get('addon-fit.js')]);
    return { Terminal: run(x).Terminal, FitAddon: run(fit).FitAddon };
  })();
  loading.catch(() => { loading = null; });
  return loading;
}

const ICON = {
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg>',
  share: '<svg viewBox="0 0 24 24"><circle cx="7" cy="12" r="2.5"/><circle cx="17" cy="6" r="2.5"/><circle cx="17" cy="18" r="2.5"/><path d="M9.2 10.8 14.8 7.2M9.2 13.2l5.6 3.6"/></svg>',
  clear: '<svg viewBox="0 0 24 24"><path d="M5 19h14M8 15l7-10 3 2-7 10H8z"/></svg>',
  stop: '<svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="1.5"/></svg>',
};

/**
 * @param {{ termTheme: () => object, settings: () => object, info: () => object, notify: (t, k?) => void, rootPath: (id) => string, onCount: (n) => void }} ctx
 */
export function createTerminals(ctx) {
  const tabsEl = h('div', { class: 'wb-term-tabs', role: 'tablist', attrs: { 'aria-label': tw('wb.term.title') } });
  const host = h('div', { class: 'wb-term-host' });
  const note = h('div', { class: 'wb-term-note', hidden: true });
  const shareBar = h('div', { class: 'wb-term-share', hidden: true, attrs: { role: 'status' } });
  const newBtn = h('button', { class: 'wb-ibtn', type: 'button', title: tw('wb.term.new'), attrs: { 'aria-label': tw('wb.term.new') }, html: ICON.plus, on: { click: () => open() } });
  const shareBtn = h('button', { class: 'wb-ibtn', type: 'button', title: tw('wb.term.share'), attrs: { 'aria-label': tw('wb.term.share') }, html: ICON.share, on: { click: () => shareDialog() } });
  const clearBtn = h('button', { class: 'wb-ibtn', type: 'button', title: tw('wb.term.clear'), attrs: { 'aria-label': tw('wb.term.clear') }, html: ICON.clear, on: { click: () => current()?.xt.clear() } });
  const killBtn = h('button', { class: 'wb-ibtn', type: 'button', title: tw('wb.term.kill'), attrs: { 'aria-label': tw('wb.term.kill') }, html: ICON.trash, on: { click: () => kill(active) } });
  const el = h('div', { class: 'wb-term' }, h('div', { class: 'wb-term-bar' }, tabsEl, h('span', { class: 'wb-sp' }), newBtn, shareBtn, clearBtn, killBtn), shareBar, note, host);

  /** termId -> { id, info, xt, fit, el, exited, line, shares } */
  const terms = new Map();
  let active = null;
  let lib = null;
  let visible = false;
  let started = false;

  const current = () => terms.get(active) || null;

  function xtermOptions() {
    const s = ctx.settings();
    return {
      fontFamily: '"Cascadia Mono", "Cascadia Code", "JetBrains Mono", Consolas, "Courier New", monospace',
      fontSize: s.terminal?.fontSize || 13,
      cursorBlink: s.terminal?.cursorBlink !== false,
      scrollback: s.terminal?.scrollback || 5000,
      allowProposedApi: false,
      theme: ctx.termTheme(),
      convertEol: false,
    };
  }

  function make(info) {
    const box = h('div', { class: 'wb-term-view', hidden: true });
    host.append(box);
    const xt = new lib.Terminal(xtermOptions());
    const fit = new lib.FitAddon();
    xt.loadAddon(fit);
    xt.open(box);
    const t = { id: info.termId, info, xt, fit, el: box, exited: !!info.exit, line: '', shares: info.shares || [], name: `${info.shell.replace(/\.exe$/i, '')} ${terms.size + 1}` };
    xt.onData((data) => {
      if (t.exited) return;
      if (t.info.kind === 'basic') {
        const r = lineEdit(t.line, data);
        t.line = r.line;
        if (r.echo) xt.write(r.echo);
        for (const l of r.lines) if (l !== null) send(t, `${l}\n`);
        return;
      }
      send(t, data);
    });
    xt.onResize(({ cols, rows }) => {
      clearTimeout(t.resizeTimer);
      t.resizeTimer = setTimeout(() => wb('wb.term.resize', { termId: t.id, cols, rows }).catch(() => {}), 80);
    });
    terms.set(t.id, t);
    return t;
  }

  function send(t, data) {
    wb('wb.term.input', { termId: t.id, data }).catch((err) => {
      if (err.code === 'conflict' || err.code === 'not_found') markExit(t, null);
    });
  }

  function markExit(t, exit) {
    if (t.exited) return;
    t.exited = true;
    t.xt.write(`\r\n\x1b[2m${tw('wb.term.exited', { code: exit?.code ?? '?' })}\x1b[0m\r\n`);
    paintTabs();
  }

  async function ensure() {
    if (lib) return lib;
    try {
      lib = await loadXterm();
    } catch (err) {
      note.hidden = false;
      note.textContent = tw('wb.term.loadFail', { error: err.message });
      throw err;
    }
    return lib;
  }

  /** Re-attaches the terminals that are still running in the engine (after a reload). */
  async function start() {
    if (started) return;
    started = true;
    await ensure();
    try {
      const { terminals } = await wb('wb.term.list', {});
      for (const info of terminals) {
        if (info.exit) continue;
        const att = await wb('wb.term.attach', { termId: info.termId });
        const t = make({ ...info, ...att });
        if (att.scrollback) t.xt.write(att.scrollback);
      }
    } catch { /* none to restore */ }
    if (!terms.size && visible) await open();
    else select([...terms.keys()].pop() || null);
  }

  async function open({ root = 'ws', cwd = '' } = {}) {
    await ensure();
    const size = { cols: 100, rows: 28 };
    let info;
    try {
      info = await wb('wb.term.open', { root, cwd, ...size });
    } catch (err) {
      ctx.notify(err.message, 'bad');
      return null;
    }
    const t = make(info);
    if (info.kind === 'basic') {
      t.xt.write(`\x1b[33m${tw('wb.term.basicBanner', { reason: info.reason || '' })}\x1b[0m\r\n`);
    }
    select(t.id);
    return t;
  }

  async function kill(id) {
    const t = terms.get(id);
    if (!t) return;
    if (!t.exited) await wb('wb.term.close', { termId: id }).catch(() => {});
    t.xt.dispose();
    t.el.remove();
    terms.delete(id);
    if (active === id) active = null;
    select([...terms.keys()].pop() || null);
  }

  function select(id) {
    active = id;
    for (const t of terms.values()) t.el.hidden = t.id !== id;
    paintTabs();
    const t = current();
    if (t && visible) requestAnimationFrame(() => { fitNow(t); t.xt.focus(); });
  }

  function fitNow(t = current()) {
    if (!t || !visible || !t.el.offsetWidth) return;
    try { t.fit.fit(); } catch { /* not laid out yet */ }
  }

  function paintTabs() {
    clear(tabsEl);
    for (const t of terms.values()) {
      const shared = t.shares.length > 0;
      tabsEl.append(h('div', { class: `wb-term-tab${t.id === active ? ' is-active' : ''}${t.exited ? ' is-exited' : ''}`, role: 'tab', tabindex: '0', attrs: { 'aria-selected': String(t.id === active) }, title: t.info.cwd, on: { click: () => select(t.id), keydown: (e) => { if (e.key === 'Enter') select(t.id); } } },
        h('span', { class: 'wb-term-dot' }),
        h('span', { text: t.name }),
        t.info.kind === 'basic' ? h('span', { class: 'wb-chip is-warn', text: tw('wb.term.basic'), title: tw('wb.term.basicTip', { reason: t.info.reason || '' }) }) : null,
        shared ? h('span', { class: 'wb-chip is-shared', text: tw('wb.term.shared'), title: t.shares.map((s) => `${s.name} (${s.mode})`).join(', ') }) : null));
    }
    killBtn.disabled = !current();
    shareBtn.disabled = !current() || current().exited || !ctx.info()?.share?.available;
    shareBtn.title = ctx.info()?.share?.available ? tw('wb.term.share') : tw('wb.term.shareOff');
    paintShareBar();
    ctx.onCount(terms.size);
  }

  function paintShareBar() {
    const t = current();
    clear(shareBar);
    shareBar.hidden = !t || !t.shares.length;
    if (shareBar.hidden) return;
    for (const s of t.shares) {
      const left = Math.max(0, Math.round((Date.parse(s.expiresAt) - Date.now()) / 60000));
      shareBar.append(h('span', { class: 'wb-share-pill' },
        h('b', { text: tw('wb.term.sharedWith', { name: s.name }) }),
        h('span', { text: s.mode === 'write' ? tw('wb.term.modeWrite') : tw('wb.term.modeRead') }),
        h('span', { class: 'wb-faint', text: tw('wb.term.minutesLeft', { n: left }) }),
        h('button', { class: 'wb-btn is-sm is-danger', type: 'button', html: `${ICON.stop}<span>${tw('wb.term.stopShare')}</span>`, on: { click: () => unshare(t, s.peerId) } })));
    }
  }

  async function refreshShares(t = current()) {
    if (!t) return;
    try {
      const { terminals } = await wb('wb.term.list', {});
      const me = terminals.find((x) => x.termId === t.id);
      t.shares = me?.shares || [];
    } catch { /* keep */ }
    paintTabs();
  }

  async function unshare(t, peerId) {
    try { await wb('wb.term.unshare', { termId: t.id, peerId }); } catch (err) { ctx.notify(err.message, 'bad'); }
    refreshShares(t);
  }

  async function shareDialog() {
    const t = current();
    if (!t) return;
    let peers;
    try { peers = await wb('wb.peers', {}); } catch (err) { ctx.notify(err.message, 'bad'); return; }
    if (!peers.available || !peers.peers.length) { ctx.notify(peers.available ? tw('wb.term.noPeers') : tw('wb.term.shareOff'), 'warn'); return; }
    const minutes = ctx.info()?.share?.minutes || [5, 15, 60];
    const peerSel = h('select', { class: 'wb-select', attrs: { 'aria-label': tw('wb.term.peer') } }, ...peers.peers.map((p) => h('option', { value: p.peerId, text: `${p.name}${p.online ? '' : ` (${tw('wb.term.offline')})`}` })));
    const minSel = h('select', { class: 'wb-select', attrs: { 'aria-label': tw('wb.term.duration') } }, ...minutes.map((m) => h('option', { value: String(m), text: tw('wb.term.minutes', { n: m }), selected: m === (ctx.info()?.share?.defaultMinutes || 15) })));
    const read = h('input', { type: 'radio', name: 'wb-share-mode', value: 'read', checked: true });
    const write = h('input', { type: 'radio', name: 'wb-share-mode', value: 'write' });
    const go = h('button', { type: 'button', class: 'wb-btn is-primary', text: tw('wb.term.shareGo') });
    const body = h('div', { class: 'wb-dlg wb-share-dlg' },
      h('p', { class: 'wb-dlg-text', text: tw('wb.term.shareText', { name: t.name }) }),
      h('label', { class: 'wb-field' }, h('span', { text: tw('wb.term.peer') }), peerSel),
      h('fieldset', { class: 'wb-field' }, h('legend', { text: tw('wb.term.mode') }),
        h('label', { class: 'wb-radio' }, read, h('span', {}, h('b', { text: tw('wb.term.modeRead') }), h('small', { text: tw('wb.term.modeReadTip') }))),
        h('label', { class: 'wb-radio' }, write, h('span', {}, h('b', { text: tw('wb.term.modeWrite') }), h('small', { class: 'wb-warn', text: tw('wb.term.modeWriteTip') })))),
      h('label', { class: 'wb-field' }, h('span', { text: tw('wb.term.duration') }), minSel),
      h('p', { class: 'wb-dlg-note', text: tw('wb.term.shareAudit') }),
      h('div', { class: 'wb-dlg-btns' }, h('button', { type: 'button', class: 'wb-btn', text: tw('wb.cancel'), on: { click: () => dlg.close() } }), go));
    const dlg = openDialog({ title: tw('wb.term.shareTitle'), body });
    go.addEventListener('click', async () => {
      go.disabled = true;
      try {
        await wb('wb.term.share', { termId: t.id, peerId: peerSel.value, mode: write.checked ? 'write' : 'read', minutes: Number(minSel.value) });
        dlg.close();
        refreshShares(t);
      } catch (err) {
        go.disabled = false;
        ctx.notify(err.message, 'bad');
      }
    });
  }

  const offFrames = onFrame((f) => {
    const t = terms.get(f.data?.termId);
    if (!t) return;
    if (f.type === 'term.data') t.xt.write(f.data.data);
    else if (f.type === 'term.exit') markExit(t, f.data);
  });
  const ro = new ResizeObserver(() => fitNow());
  ro.observe(host);
  const shareTick = setInterval(() => { if (current()?.shares.length) paintShareBar(); }, 30_000);

  return {
    el,
    open,
    async show() {
      visible = true;
      await start();
      if (!terms.size) await open();
      const t = current();
      if (t) requestAnimationFrame(() => { fitNow(t); t.xt.focus(); });
    },
    hide() { visible = false; },
    focus() { current()?.xt.focus(); },
    themeChanged() { for (const t of terms.values()) t.xt.options.theme = ctx.termTheme(); },
    settingsChanged() {
      const o = xtermOptions();
      for (const t of terms.values()) { t.xt.options.fontSize = o.fontSize; t.xt.options.cursorBlink = o.cursorBlink; t.xt.options.scrollback = o.scrollback; }
      fitNow();
    },
    get count() { return terms.size; },
    dispose() {
      // The terminals keep running for the next window; a share never outlives its visible badge.
      for (const t of terms.values()) if (t.shares.length) wb('wb.term.unshare', { termId: t.id }).catch(() => {});
      offFrames();
      ro.disconnect();
      clearInterval(shareTick);
      for (const t of terms.values()) t.xt.dispose();
      terms.clear();
    },
  };
}
