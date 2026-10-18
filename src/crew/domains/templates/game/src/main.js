import { W, H, newGame, step, bestScore } from './game.js';

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const status = document.getElementById('status');
const input = { left: false, right: false, pointerX: null };
let state = newGame();
let paused = false;
let last = 0;

function fit() {
  // Sharp on high DPI screens: draw in game units, scale to the device pixels.
  const ratio = window.devicePixelRatio || 1;
  canvas.width = W * ratio;
  canvas.height = H * ratio;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
}

function draw() {
  ctx.fillStyle = '#10131c';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#ffd34d';
  for (const s of state.stars) { ctx.beginPath(); ctx.arc(s.x, s.y, s.w / 2, 0, Math.PI * 2); ctx.fill(); }
  const p = state.player;
  ctx.fillStyle = '#6fd3ff';
  ctx.fillRect(p.x - p.w / 2, p.y - p.h / 2, p.w, p.h);
  ctx.fillStyle = '#f4f1ea';
  ctx.font = '16px system-ui, sans-serif';
  ctx.fillText(`Score ${state.score}   Lives ${state.lives}`, 12, 24);
  if (state.over || paused) {
    ctx.fillStyle = 'rgba(0,0,0,.55)';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#f4f1ea';
    ctx.font = '24px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(state.over ? 'Game over' : 'Paused', W / 2, H / 2 - 12);
    ctx.font = '16px system-ui, sans-serif';
    ctx.fillText(state.over ? 'Press Enter or tap to play again' : 'Press P or tap to go on', W / 2, H / 2 + 18);
    ctx.textAlign = 'start';
  }
}

function frame(now) {
  const dt = last ? (now - last) / 1000 : 0;
  last = now;
  if (!paused) {
    const wasOver = state.over;
    step(state, dt, input);
    if (state.over && !wasOver) status.textContent = `Game over. Score ${state.score}, best ${bestScore(localStorage, state.score)}.`;
  }
  draw();
  requestAnimationFrame(frame);
}

function restart() { state = newGame(); status.textContent = ''; }

window.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft' || e.key === 'a') input.left = true;
  if (e.key === 'ArrowRight' || e.key === 'd') input.right = true;
  if (e.key === 'p' || e.key === 'Escape') paused = !paused;
  if (e.key === 'Enter' && state.over) restart();
});
window.addEventListener('keyup', (e) => {
  if (e.key === 'ArrowLeft' || e.key === 'a') input.left = false;
  if (e.key === 'ArrowRight' || e.key === 'd') input.right = false;
});
const toGame = (e) => { const r = canvas.getBoundingClientRect(); return ((e.clientX - r.left) / r.width) * W; };
canvas.addEventListener('pointerdown', (e) => { if (state.over) restart(); else if (paused) paused = false; input.pointerX = toGame(e); });
canvas.addEventListener('pointermove', (e) => { if (e.buttons || e.pointerType === 'touch') input.pointerX = toGame(e); });
canvas.addEventListener('pointerup', () => { input.pointerX = null; });
// Pause when the tab is hidden, so a player never loses lives while away.
document.addEventListener('visibilitychange', () => { if (document.hidden) paused = true; last = 0; });

fit();
status.textContent = `Best score ${bestScore(localStorage)}. Arrow keys or drag to move, P to pause.`;
requestAnimationFrame(frame);
