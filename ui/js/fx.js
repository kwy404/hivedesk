// Small visual effects: confetti when a job is done, skeleton placeholders and a typing indicator.
// Everything respects prefers-reduced-motion (and the Motion setting) and only animates
// transform and opacity, or draws on one canvas, so it stays at 60 fps.

import { h, reducedMotion } from './dom.js';
import { t } from './i18n.js';

const HONEY = ['#F5B544', '#FFD072', '#F29A1F', '#F2E9DA', '#8BD3A8', '#E9C46A'];

/**
 * Confetti from the top of the screen, once. The Office mode can provide its own celebration
 * (window.hivedeskOffice.celebrate); when it is present it is used instead.
 */
export function celebrate({ origin } = {}) {
  if (reducedMotion()) return;
  const office = window.hivedeskOffice;
  if (office && typeof office.celebrate === 'function') {
    try { office.celebrate(); return; } catch (err) { console.warn('[hivedesk] office celebration failed', err.message); }
  }
  confetti(origin);
}

let running = false;
function confetti(origin) {
  if (running) return;
  running = true;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = innerWidth;
  const H = innerHeight;
  const canvas = h('canvas', { class: 'fx-confetti', 'aria-hidden': 'true', width: W * dpr, height: H * dpr });
  document.body.append(canvas);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const n = W < 600 ? 70 : 140;
  const ox = origin?.x ?? W / 2;
  const oy = origin?.y ?? H * 0.28;
  const parts = Array.from({ length: n }, () => {
    const a = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 0.9;
    const v = 7 + Math.random() * 9;
    return {
      x: ox + (Math.random() - 0.5) * 80, y: oy, vx: Math.cos(a) * v, vy: Math.sin(a) * v,
      w: 5 + Math.random() * 6, h: 8 + Math.random() * 8, r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.35,
      c: HONEY[(Math.random() * HONEY.length) | 0], hex: Math.random() < 0.35,
    };
  });
  const start = performance.now();
  const LIFE = 2200;
  const frame = (now) => {
    const el = now - start;
    ctx.clearRect(0, 0, W, H);
    const fade = el > LIFE - 500 ? Math.max(0, (LIFE - el) / 500) : 1;
    ctx.globalAlpha = fade;
    for (const p of parts) {
      p.vy += 0.32; p.vx *= 0.99; p.vy *= 0.99;
      p.x += p.vx; p.y += p.vy; p.r += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.r);
      ctx.fillStyle = p.c;
      if (p.hex) {
        ctx.beginPath();
        for (let i = 0; i < 6; i++) { const a = (Math.PI / 3) * i; ctx.lineTo(Math.cos(a) * p.w * 0.7, Math.sin(a) * p.w * 0.7); }
        ctx.closePath();
        ctx.fill();
      } else ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.r * 1.7)));
      ctx.restore();
    }
    if (el < LIFE) requestAnimationFrame(frame);
    else { canvas.remove(); running = false; }
  };
  requestAnimationFrame(frame);
}

/** Skeleton lines while something loads. `lines` widths in percent. */
export function skeleton(lines = [92, 76, 84, 60], { label } = {}) {
  return h('div', { class: 'skel', role: 'status', 'aria-label': label || t('fx.loading'), 'aria-busy': 'true' },
    lines.map((w) => h('span', { class: 'skel-line', style: `width:${w}%` })));
}

/** Skeleton rows with an avatar circle, for lists such as chat or files. */
export function skeletonRows(n = 4, { label } = {}) {
  return h('div', { class: 'skel', role: 'status', 'aria-label': label || t('fx.loading'), 'aria-busy': 'true' },
    Array.from({ length: n }, (_, i) => h('div', { class: 'skel-row' }, h('span', { class: 'skel-dot' }), h('span', { class: 'skel-line', style: `width:${60 + ((i * 17) % 35)}%` }))));
}

/** "Mel is typing" with three bouncing dots. */
export function typingIndicator(name) {
  return h('div', { class: 'typing', role: 'status', 'aria-live': 'polite' },
    h('span', { class: 'typing-dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')),
    h('span', { class: 'typing-t', text: t('fx.typing', { name }) }));
}
