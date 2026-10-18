import test from 'node:test';
import assert from 'node:assert/strict';
import { newGame, step, bestScore, W } from '../src/game.js';

test('the paddle moves with the keys and stays on screen', () => {
  const s = newGame(7);
  for (let i = 0; i < 200; i++) step(s, 1 / 60, { right: true });
  assert.equal(s.player.x, W - s.player.w / 2);
  for (let i = 0; i < 400; i++) step(s, 1 / 60, { left: true });
  assert.equal(s.player.x, s.player.w / 2);
});

test('a missed star costs a life and the game ends at zero lives', () => {
  const s = newGame(3);
  s.player.x = 0;
  for (let i = 0; i < 60 * 120 && !s.over; i++) step(s, 1 / 60, { left: true });
  assert.equal(s.over, true);
  assert.equal(s.lives, 0);
  const frozen = s.time;
  step(s, 1, {});
  assert.equal(s.time, frozen);
});

test('a caught star scores, and the same seed replays the same game', () => {
  const a = newGame(42);
  const b = newGame(42);
  for (let i = 0; i < 600; i++) {
    const target = a.stars[0]?.x ?? W / 2;
    step(a, 1 / 60, { pointerX: target });
    step(b, 1 / 60, { pointerX: b.stars[0]?.x ?? W / 2 });
  }
  assert.ok(a.score > 0);
  assert.equal(a.score, b.score);
});

test('a long frame is capped and the best score survives a blocked storage', () => {
  const s = newGame(1);
  step(s, 10, {});
  assert.ok(s.time <= 0.05);
  const m = new Map();
  const storage = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) };
  assert.equal(bestScore(storage, 5), 5);
  assert.equal(bestScore(storage, 3), 5);
  assert.equal(bestScore({ getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } }, 9), 9);
});
