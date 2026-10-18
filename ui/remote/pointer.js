// The viewer's input, turned into the wire events of remote.input (docs/1.0/PLAN.md section 12.3).
// Pure parts are exported for tests; the batcher sends at most 60 messages a second.

/**
 * A point on the video element, normalized 0..1 on the remote screen. The video uses object-fit: contain,
 * so the picture may have bars on two sides; a point on a bar is outside.
 */
export function normalizePoint(clientX, clientY, rect, videoW, videoH) {
  if (!(rect?.width > 0 && rect?.height > 0 && videoW > 0 && videoH > 0)) return null;
  const scale = Math.min(rect.width / videoW, rect.height / videoH);
  const w = videoW * scale;
  const hgt = videoH * scale;
  const x = (clientX - rect.left - (rect.width - w) / 2) / w;
  const y = (clientY - rect.top - (rect.height - hgt) / 2) / hgt;
  const inside = x >= 0 && x <= 1 && y >= 0 && y <= 1;
  return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)), inside };
}

/** Browser wheel deltas to Windows wheel units (120 per notch). Lines and pages are scaled to pixels first. */
export function wheelUnits(e) {
  const k = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
  const conv = (d) => Math.round(Math.max(-1200, Math.min(1200, d * k * 1.2)));
  return { dx: conv(e.deltaX || 0), dy: conv(e.deltaY || 0) };
}

/** Mouse buttons the host understands: 0 left, 1 middle, 2 right. */
export const buttonOf = (b) => (b === 0 || b === 1 || b === 2 ? b : null);

/** Collects events and flushes them together. Consecutive moves collapse into the last one. */
export class InputBatcher {
  constructor(send, { intervalMs = 16, max = 120, setTimeout: st = (fn, ms) => setTimeout(fn, ms) } = {}) {
    this.send = send;
    this.intervalMs = intervalMs;
    this.max = max;
    this.setTimeout = st;
    this.queue = [];
    this.timer = null;
  }

  push(e) {
    const last = this.queue[this.queue.length - 1];
    if (e.k === 'move' && last?.k === 'move') this.queue[this.queue.length - 1] = e;
    else this.queue.push(e);
    if (this.queue.length > this.max) this.queue.splice(0, this.queue.length - this.max);
    if (!this.timer) this.timer = this.setTimeout(() => this.flush(), this.intervalMs);
  }

  flush() {
    this.timer = null;
    if (!this.queue.length) return;
    const events = this.queue.splice(0);
    this.send(events);
  }
}

/** Tracks held keys and buttons on the viewer, so a blur or a stop can let them all go. */
export class HeldInput {
  constructor() { this.keys = new Set(); this.buttons = new Set(); }
  key(code, down) { if (down) this.keys.add(code); else this.keys.delete(code); }
  button(b, down) { if (down) this.buttons.add(b); else this.buttons.delete(b); }
  releaseEvents() {
    const ev = [...[...this.keys].map((code) => ({ k: 'key', code, down: false })), ...[...this.buttons].map((b) => ({ k: 'btn', b, down: false }))];
    this.keys.clear();
    this.buttons.clear();
    return ev;
  }
}
