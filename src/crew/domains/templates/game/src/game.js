// The rules of the game as pure functions over a state object: no canvas, no timers, so node:test can
// play it. The player moves a paddle and catches falling stars; a missed star costs a life.

export const W = 360;
export const H = 640;

/** A small seeded random number generator, so a test can replay the same game. */
export function rng(seed = 1) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 1_000_000) / 1_000_000; };
}

export function newGame(seed = Date.now()) {
  return { player: { x: W / 2, y: H - 40, w: 72, h: 14, speed: 360 }, stars: [], score: 0, lives: 3, spawnIn: 0.6, time: 0, over: false, random: rng(seed) };
}

const overlaps = (a, b) => Math.abs(a.x - b.x) * 2 < a.w + b.w && Math.abs(a.y - b.y) * 2 < a.h + b.h;

/**
 * Advances the game by dt seconds. input: { left, right, pointerX } (pointerX for touch, or null).
 * Returns the same state object, changed.
 */
export function step(state, dt, input = {}) {
  if (state.over) return state;
  const t = Math.min(dt, 0.05); // a long pause (a hidden tab) never teleports things
  state.time += t;
  const p = state.player;
  if (typeof input.pointerX === 'number') p.x += Math.sign(input.pointerX - p.x) * Math.min(Math.abs(input.pointerX - p.x), p.speed * t);
  else p.x += ((input.right ? 1 : 0) - (input.left ? 1 : 0)) * p.speed * t;
  p.x = Math.max(p.w / 2, Math.min(W - p.w / 2, p.x));
  state.spawnIn -= t;
  if (state.spawnIn <= 0) {
    const speed = 140 + Math.min(260, state.time * 6);
    state.stars.push({ x: 16 + state.random() * (W - 32), y: -10, w: 16, h: 16, vy: speed });
    state.spawnIn = Math.max(0.35, 1 - state.time / 90);
  }
  for (const s of state.stars) s.y += s.vy * t;
  const kept = [];
  for (const s of state.stars) {
    if (overlaps(s, p)) state.score += 1;
    else if (s.y - s.h / 2 > H) state.lives -= 1;
    else kept.push(s);
  }
  state.stars = kept;
  if (state.lives <= 0) { state.lives = 0; state.over = true; }
  return state;
}

/** Reads and saves the best score; a blocked storage gives 0 and saves nothing. */
export function bestScore(storage, score) {
  let best = 0;
  try { best = Number(storage.getItem('star-catcher.best')) || 0; } catch { best = 0; }
  if (typeof score === 'number' && score > best) {
    best = score;
    try { storage.setItem('star-catcher.best', String(best)); } catch { /* storage blocked or full */ }
  }
  return best;
}
