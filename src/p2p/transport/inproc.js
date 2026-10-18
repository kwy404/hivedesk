// inproc: two engines in one process (tests, PLAN 3.4). Delivery is asynchronous and ordered,
// like a socket. A tap(text, from) hook can watch, drop or replace frames in flight, which is how
// the tests play an attacker on the wire.

import { Connection } from './base.js';

class InprocConnection extends Connection {
  constructor(address) {
    super('inproc', { address });
    this.other = null;
    this.tap = null;
  }

  _write(text) {
    const other = this.other;
    if (!other || other.state === 'closed') return false;
    const out = this.tap ? this.tap(text, this) : text;
    if (out === null || out === undefined) return true; // dropped on the wire
    setImmediate(() => other._deliver(out));
    return true;
  }

  _end(reason) {
    const other = this.other;
    if (other && other.state !== 'closed') setImmediate(() => other._closed(reason));
  }
}

/** Two connected ends. tap applies to both directions. */
export function inprocPair({ tap, a = 'inproc:a', b = 'inproc:b' } = {}) {
  const x = new InprocConnection(b);
  const y = new InprocConnection(a);
  x.other = y;
  y.other = x;
  if (tap) x.tap = y.tap = tap;
  return [x, y];
}

/** A tiny address book: listen(address, onConnection) and connect(address) inside one process. */
export class InprocNetwork {
  constructor() {
    this.listeners = new Map();
  }

  listen(address, onConnection) {
    this.listeners.set(address, onConnection);
    return { close: () => this.listeners.delete(address) };
  }

  connect(address, { tap } = {}) {
    const on = this.listeners.get(address);
    if (!on) throw Object.assign(new Error(`nobody listens on ${address}`), { code: 'unreachable' });
    const [mine, theirs] = inprocPair({ tap, a: `inproc:${Math.random().toString(36).slice(2, 8)}`, b: address });
    setImmediate(() => on(theirs));
    return mine;
  }
}
