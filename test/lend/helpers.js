// Test helpers for Lend your PC: an in-memory link pair and a fake local hivedesk socket.
import { Emitter } from '../../ui/lend/core/emitter.js';

/** Two connected fake data channels. send() on one delivers to the other's onmessage. */
export function linkPair() {
  const make = () => ({ onmessage: null, onclose: null, closed: false, sent: [] });
  const a = make();
  const b = make();
  const wire = (from, to) => {
    from.send = (text) => {
      if (from.closed) throw new Error('link is not open');
      from.sent.push(text);
      queueMicrotask(() => !to.closed && to.onmessage?.(text));
    };
    from.close = () => {
      if (from.closed) return;
      from.closed = true;
      to.closed = true;
      queueMicrotask(() => {
        from.onclose?.('closed');
        to.onclose?.('closed');
      });
    };
  };
  wire(a, b);
  wire(b, a);
  return [a, b];
}

/** A fake hivedesk WebSocket client: command handlers by type, emits server frames. */
export class FakeHive extends Emitter {
  constructor(handlers = {}) {
    super();
    this.handlers = handlers;
    this.calls = [];
    this.notes = [];
  }

  async command(type, data) {
    this.calls.push({ type, data });
    const h = this.handlers[type];
    if (!h) throw Object.assign(new Error(`unknown command ${type}`), { code: 'bad_request' });
    return h(data);
  }

  notify(type, data) {
    this.notes.push({ type, data });
  }

  callsOf(type) {
    return this.calls.filter((c) => c.type === type).map((c) => c.data);
  }
}

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

export async function until(fn, ms = 2000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await tick(5);
  }
}
