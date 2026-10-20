// Remote desktop on the phone (loaded only when asked for). It asks the computer for remote.view or
// remote.control; the person at the computer answers in the Stream 6 dialog. The screen arrives as a
// WebRTC video track whose DTLS fingerprint must match the one in the signed session (media.js).
// The phone only sends events: the computer checks the grant, the expiry, the lock state and the key
// allowlist for every one, and its native helper does the input (docs/1.0/protocol/remote.md).
//   touch mode:    tap clicks where you touch, long press is a right click, drag holds the button
//   touchpad mode: one finger moves the pointer, tap clicks, two finger tap is a right click,
//                  two finger drag scrolls
//   both:          pinch to zoom, two fingers pan when zoomed, double tap resets the zoom

import { h, icon } from './dom.js';
import { MediaLink } from './vendor/remote/media.js';
import { normalizePoint, InputBatcher, HeldInput } from './vendor/remote/pointer.js';

const LONG_MS = 550;
const TAP_MS = 260;
const TAP_PX = 10;
const PAD_SPEED = 1.7;

// The soft keyboard types characters; the computer takes physical key codes (a US layout map).
const SHIFTED = { '!': 'Digit1', '@': 'Digit2', '#': 'Digit3', $: 'Digit4', '%': 'Digit5', '^': 'Digit6', '&': 'Digit7', '*': 'Digit8', '(': 'Digit9', ')': 'Digit0', _: 'Minus', '+': 'Equal', '{': 'BracketLeft', '}': 'BracketRight', '|': 'Backslash', ':': 'Semicolon', '"': 'Quote', '~': 'Backquote', '<': 'Comma', '>': 'Period', '?': 'Slash' };
const PLAIN = { ' ': 'Space', '-': 'Minus', '=': 'Equal', '[': 'BracketLeft', ']': 'BracketRight', '\\': 'Backslash', ';': 'Semicolon', "'": 'Quote', '`': 'Backquote', ',': 'Comma', '.': 'Period', '/': 'Slash', '\n': 'Enter', '\t': 'Tab' };

/** The key presses that type one character, or null for one the US layout cannot type. */
export function keysForChar(ch) {
  if (/^[a-z]$/.test(ch)) return [{ code: `Key${ch.toUpperCase()}` }];
  if (/^[A-Z]$/.test(ch)) return [{ code: `Key${ch}`, shift: true }];
  if (/^[0-9]$/.test(ch)) return [{ code: `Digit${ch}` }];
  if (PLAIN[ch]) return [{ code: PLAIN[ch] }];
  if (SHIFTED[ch]) return [{ code: SHIFTED[ch], shift: true }];
  return null;
}

export function openViewer({ client, control, t, toast, onClose }) {
  let link = null;
  let mode = 'touchpad';
  let granted = null;
  let stateInfo = { control: false, locked: false, paused: false, reason: 'waiting' };
  let zoom = { s: 1, x: 0, y: 0 };
  let cursor = { x: 0.5, y: 0.5 };
  const mods = new Set();
  const held = new HeldInput();
  const batch = new InputBatcher((events) => client.send('remote.input', { events }), { intervalMs: 16, max: 200 });
  const push = (e) => {
    if (!stateInfo.control) return;
    if (e.k === 'key') held.key(e.code, e.down);
    if (e.k === 'btn') held.button(e.b, e.down);
    batch.push(e);
  };

  // ---------- the overlay ----------
  if (!document.querySelector('link[data-rv]')) document.head.append(h('link', { rel: 'stylesheet', href: 'viewer.css', 'data-rv': '1' }));
  const video = h('video', { autoplay: true, muted: true, playsInline: true, 'aria-label': t('rd.screen') });
  const cur = h('div', { class: 'rv-cursor', 'aria-hidden': 'true' });
  const plate = h('div', { class: 'rv-plate' }, video, cur);
  const stage = h('div', { class: 'rv-stage', role: 'application', 'aria-label': t('rd.stageLabel') }, plate);
  const wait = h('div', { class: 'rv-wait', role: 'status', 'aria-live': 'polite' });
  const status = h('div', { class: 'rv-status', role: 'status', 'aria-live': 'polite' });
  const kb = h('textarea', { class: 'rv-kb', autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false', 'aria-label': t('rd.keyboard'), enterkeyhint: 'enter' });
  const tb = (ic, label, fn, extra = {}) => h('button', { class: 'rv-b', type: 'button', 'aria-label': label, title: label, on: { click: fn }, ...extra }, icon(ic));
  const modeBtn = tb('touchpad', t('rd.mode.touchpad'), () => setMode(mode === 'touch' ? 'touchpad' : 'touch'), { 'aria-pressed': 'true' });
  const kbBtn = tb('keyboard', t('rd.keyboard'), () => toggleKeys(), { 'aria-pressed': 'false' });
  const askBtn = h('button', { class: 'rv-ask', type: 'button', text: t('rd.askControl'), on: { click: () => ask(true) } });
  const quality = h('select', { class: 'rv-sel', 'aria-label': t('rd.quality') }, ...['auto', 'balanced', 'quality', 'speed'].map((q) => h('option', { value: q, text: t(`rd.q.${q}`) })));
  quality.addEventListener('change', () => client.send('remote.quality', { preset: quality.value }));
  const top = h('div', { class: 'rv-top' },
    tb('back', t('rd.end'), () => end('viewer')),
    h('div', { class: 'grow' }, status),
    askBtn);
  const bar = h('div', { class: 'rv-bar', role: 'toolbar', 'aria-label': t('rd.title') },
    modeBtn, kbBtn, tb('zoom', t('rd.zoomReset'), () => setZoom({ s: 1, x: 0, y: 0 })), h('span', { class: 'grow' }), quality,
    h('button', { class: 'rv-end', type: 'button', on: { click: () => end('viewer') } }, icon('stop'), h('span', { text: t('rd.end') })));
  const keyRow = h('div', { class: 'rv-keys', role: 'toolbar', 'aria-label': t('rd.keys') },
    ...[['Escape', 'Esc'], ['Tab', 'Tab'], ['ControlLeft', 'Ctrl', true], ['AltLeft', 'Alt', true], ['MetaLeft', 'Win', true], ['ShiftLeft', 'Shift', true], ['ArrowLeft', '←'], ['ArrowUp', '↑'], ['ArrowDown', '↓'], ['ArrowRight', '→'], ['Backspace', '⌫'], ['Delete', 'Del'], ['Enter', '⏎']].map(([code, label, sticky]) => {
      const b = h('button', { type: 'button', class: 'rv-k', text: label, 'aria-label': code, 'aria-pressed': sticky ? 'false' : undefined });
      b.addEventListener('click', () => {
        if (sticky) { if (mods.has(code)) mods.delete(code); else mods.add(code); b.setAttribute('aria-pressed', String(mods.has(code))); return; }
        tap(code);
      });
      return b;
    }));
  const root = h('div', { class: 'rv', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('rd.title') }, stage, top, wait, h('div', { class: 'rv-foot' }, keyRow, bar), kb);
  document.body.append(root);
  document.documentElement.classList.add('rv-open');

  function show() {
    const s = stateInfo;
    status.replaceChildren(...[
      h('b', { class: 'rv-state', text: !granted ? t('rd.asking') : s.locked ? t('rd.locked') : s.paused ? t('rd.paused') : s.control ? t('rd.controlOn') : t('rd.viewOnly') }),
      granted ? h('span', { class: 'rv-left', text: `${t('rd.until', { time: new Date(granted.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })}` }) : null].filter(Boolean));
    askBtn.hidden = !granted || granted.mode === 'control';
    root.classList.toggle('rv-ctl', !!s.control);
    cur.hidden = mode !== 'touchpad' || !s.control;
    kbBtn.disabled = !s.control;
    modeBtn.disabled = !s.control;
    if (!granted) wait.replaceChildren(h('div', { class: 'rv-spin', 'aria-hidden': 'true' }), h('b', { text: t('rd.waitTitle') }), h('span', { text: t('rd.waitBody') }));
    else if (!video.srcObject) wait.replaceChildren(h('div', { class: 'rv-spin', 'aria-hidden': 'true' }), h('b', { text: t('rd.starting') }));
    else wait.replaceChildren();
    wait.hidden = !!(granted && video.srcObject) && !s.locked;
    if (granted && s.locked) wait.replaceChildren(icon('lock'), h('b', { text: t('rd.locked') }), h('span', { text: t('rd.lockedBody') }));
  }

  function setMode(m) {
    mode = m;
    modeBtn.replaceChildren(icon(m === 'touch' ? 'touch' : 'touchpad'));
    modeBtn.setAttribute('aria-label', t(`rd.mode.${m}`));
    modeBtn.title = t(`rd.mode.${m}`);
    toast(t(`rd.mode.${m}Help`), '', 2500);
    show();
  }

  function setZoom(z) {
    const r = stage.getBoundingClientRect();
    const s = Math.min(5, Math.max(1, z.s));
    const maxX = ((s - 1) * r.width) / 2;
    const maxY = ((s - 1) * r.height) / 2;
    zoom = { s, x: Math.min(maxX, Math.max(-maxX, z.x)), y: Math.min(maxY, Math.max(-maxY, z.y)) };
    plate.style.transform = `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.s})`;
  }

  // ---------- the session ----------
  function ask(wantControl) {
    if (!client.send('cap.request', { capability: { name: wantControl ? 'remote.control' : 'remote.view' }, reason: t('rd.reason') })) {
      toast(t('conn.offline'), 'bad');
      end('offline');
    }
  }

  const signal = async (sig) => {
    if (sig.kind === 'ice') client.send('remote.ice', { kind: 'ice', candidate: sig.candidate });
    else client.send('remote.sdp', { kind: sig.kind, sdp: sig.sdp });
  };

  function onMessage(m) {
    const b = m.body || {};
    switch (m.t) {
      case 'remote.ready':
        granted = { mode: b.mode === 'control' ? 'control' : 'view', expiresAt: Number(b.expiresAt) || Date.now() + 15 * 60_000 };
        stateInfo = { ...stateInfo, control: granted.mode === 'control' && b.control === true, reason: b.reason || null };
        if (!link) {
          link = new MediaLink({
            role: 'viewer', signal,
            onTracks: (streams) => { video.srcObject = streams[0] || null; video.play?.().catch(() => {}); show(); },
            onState: (st) => { if (st === 'rejected') { toast(t('rd.badMedia'), 'bad'); end('fingerprint'); } }
          });
        }
        toast(t(granted.mode === 'control' ? 'rd.grantedControl' : 'rd.grantedView'), 'ok');
        break;
      case 'remote.state':
        stateInfo = { control: granted?.mode === 'control' && b.control === true, locked: b.locked === true, paused: b.paused === true, reason: b.reason || null };
        if (Number.isFinite(b.expiresAt) && granted) granted.expiresAt = b.expiresAt;
        if (!stateInfo.control) release();
        break;
      case 'remote.sdp':
      case 'remote.ice':
        link?.handle(m.t === 'remote.ice' ? { kind: 'ice', candidate: b.candidate } : b).catch(() => {});
        return;
      case 'remote.refused':
        toast(t(`rd.refused.${b.reason}`) !== `rd.refused.${b.reason}` ? t(`rd.refused.${b.reason}`) : t('rd.refused.declined'), 'bad', 5000);
        return end('refused', false);
      case 'remote.stop':
        toast(t('rd.ended'), '', 3500);
        return end(b.reason || 'host', false);
      case 'error':
        if (b.code === 'not_granted') { toast(t('locked.remote'), 'bad'); return end('not_granted', false); }
        return;
      default:
        return;
    }
    show();
  }

  function release() {
    for (const e of held.releaseEvents()) batch.push(e);
    batch.flush();
  }

  let ended = false;
  function end(reason, tell = true) {
    if (ended) return;
    ended = true;
    if (stateInfo.control) release();
    if (tell) client.send('remote.stop', { reason: 'viewer' });
    link?.close(reason);
    root.remove();
    document.documentElement.classList.remove('rv-open');
    onClose?.();
  }

  // ---------- keys ----------
  function key(code, down) { push({ k: 'key', code, down }); }
  function tap(code, shift = false) {
    const m = [...mods];
    if (shift && !mods.has('ShiftLeft')) m.push('ShiftLeft');
    for (const c of m) key(c, true);
    key(code, true);
    key(code, false);
    for (const c of m.reverse()) key(c, false);
    if (mods.size) { mods.clear(); for (const b of keyRow.querySelectorAll('[aria-pressed]')) b.setAttribute('aria-pressed', 'false'); }
  }
  function toggleKeys() {
    const on = !root.classList.contains('rv-typing');
    root.classList.toggle('rv-typing', on);
    kbBtn.setAttribute('aria-pressed', String(on));
    if (on) kb.focus();
    else kb.blur();
  }
  kb.addEventListener('beforeinput', (e) => {
    e.preventDefault();
    if (e.inputType === 'deleteContentBackward') return tap('Backspace');
    if (e.inputType === 'deleteContentForward') return tap('Delete');
    if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') return tap('Enter');
    for (const ch of e.data || '') {
      const k = keysForChar(ch);
      if (k) tap(k[0].code, !!k[0].shift);
    }
  });
  kb.addEventListener('input', () => { kb.value = ''; });
  kb.addEventListener('keydown', (e) => {
    // A hardware keyboard on the phone sends physical codes directly.
    if (e.isComposing || e.key === 'Unidentified' || e.key === 'Process') return;
    if (['Backspace', 'Enter', 'Tab', 'Escape', 'Delete'].includes(e.code) || e.code.startsWith('Arrow')) { e.preventDefault(); tap(e.code); }
  });

  // ---------- pointer ----------
  const pts = new Map();
  let g = null;
  const rect = () => video.getBoundingClientRect();
  const at = (x, y) => normalizePoint(x, y, rect(), video.videoWidth, video.videoHeight);
  const moveTo = (p) => { if (p) { cursor = { x: p.x, y: p.y }; drawCursor(); push({ k: 'move', x: p.x, y: p.y }); } };
  const click = (b) => { push({ k: 'btn', b, down: true }); push({ k: 'btn', b, down: false }); };
  function drawCursor() {
    const r = video.getBoundingClientRect();
    const pr = plate.getBoundingClientRect();
    const vw = video.videoWidth || 16;
    const vh = video.videoHeight || 9;
    const sc = Math.min(r.width / vw, r.height / vh);
    const w = vw * sc;
    const hh = vh * sc;
    const left = r.left + (r.width - w) / 2 + cursor.x * w - pr.left;
    const topY = r.top + (r.height - hh) / 2 + cursor.y * hh - pr.top;
    cur.style.transform = `translate(${left / zoom.s}px, ${topY / zoom.s}px)`;
  }
  let lastTap = 0;

  stage.addEventListener('pointerdown', (e) => {
    stage.setPointerCapture?.(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: performance.now() });
    if (pts.size === 1) {
      const p = [...pts.values()][0];
      g = { kind: 'one', p, moved: false, drag: false, long: null };
      if (mode === 'touch' && stateInfo.control) {
        g.long = setTimeout(() => { if (g?.kind === 'one' && !g.moved) { moveTo(at(p.x, p.y)); click(2); g.used = true; navigator.vibrate?.(15); } }, LONG_MS);
      }
    } else if (pts.size === 2) {
      clearTimeout(g?.long);
      const [a, b] = [...pts.values()];
      if (g?.drag) { push({ k: 'btn', b: 0, down: false }); }
      g = { kind: 'two', d0: Math.hypot(a.x - b.x, a.y - b.y), c0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, z0: { ...zoom }, t0: performance.now(), moved: false, pinch: false, wheel: 0 };
    }
  });

  stage.addEventListener('pointermove', (e) => {
    const p = pts.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (!g) return;
    if (g.kind === 'one') {
      if (Math.hypot(p.x - p.x0, p.y - p.y0) > TAP_PX) { g.moved = true; clearTimeout(g.long); }
      if (!stateInfo.control) {
        if (zoom.s > 1) setZoom({ ...zoom, x: zoom.x + dx, y: zoom.y + dy });
        return;
      }
      if (mode === 'touchpad') {
        const r = rect();
        const vw = video.videoWidth || r.width;
        const vh = video.videoHeight || r.height;
        const sc = Math.min(r.width / vw, r.height / vh);
        cursor = { x: Math.min(1, Math.max(0, cursor.x + (dx * PAD_SPEED) / (vw * sc))), y: Math.min(1, Math.max(0, cursor.y + (dy * PAD_SPEED) / (vh * sc))) };
        drawCursor();
        push({ k: 'move', x: cursor.x, y: cursor.y });
      } else if (g.moved) {
        if (!g.drag) { g.drag = true; moveTo(at(p.x0, p.y0)); push({ k: 'btn', b: 0, down: true }); }
        moveTo(at(p.x, p.y));
      }
    } else if (g.kind === 'two' && pts.size === 2) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const ratio = d / (g.d0 || 1);
      g.moved = g.moved || Math.abs(ratio - 1) > 0.04 || Math.hypot(c.x - g.c0.x, c.y - g.c0.y) > TAP_PX;
      if (!g.pinch && Math.abs(ratio - 1) > 0.08) g.pinch = true;
      if (g.pinch || !stateInfo.control || mode === 'touch' || zoom.s > 1.01 && !g.scrolling) {
        setZoom({ s: g.z0.s * ratio, x: g.z0.x + (c.x - g.c0.x), y: g.z0.y + (c.y - g.c0.y) });
      } else if (mode === 'touchpad') {
        g.scrolling = true;
        g.wheel += dy;
        if (Math.abs(g.wheel) >= 12) {
          push({ k: 'wheel', dx: 0, dy: Math.round(-g.wheel * 4) });
          g.wheel = 0;
        }
      }
    }
  });

  const up = (e) => {
    const p = pts.get(e.pointerId);
    if (!p) return;
    pts.delete(e.pointerId);
    if (!g) return;
    const now = performance.now();
    if (g.kind === 'one' && pts.size === 0) {
      clearTimeout(g.long);
      const quick = now - p.t0 < TAP_MS && !g.moved;
      if (g.drag) push({ k: 'btn', b: 0, down: false });
      else if (quick && !g.used) {
        if (now - lastTap < 300 && !stateInfo.control) setZoom({ s: zoom.s > 1 ? 1 : 2, x: 0, y: 0 });
        else if (stateInfo.control) {
          if (mode === 'touch') moveTo(at(p.x, p.y));
          click(0);
        }
        lastTap = now;
      }
      g = null;
    } else if (g.kind === 'two') {
      if (pts.size === 0) {
        if (!g.moved && now - g.t0 < TAP_MS + 80 && stateInfo.control) click(2);
        g = null;
      }
    }
  };
  stage.addEventListener('pointerup', up);
  stage.addEventListener('pointercancel', up);
  stage.addEventListener('contextmenu', (e) => e.preventDefault());
  addEventListener('resize', () => { setZoom(zoom); drawCursor(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && stateInfo.control) release(); });
  video.addEventListener('loadedmetadata', () => { drawCursor(); show(); });

  show();
  ask(control);
  return { onMessage, end };
}
