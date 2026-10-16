// Adapted from howlden (MIT, Alexandre Kohler), app/core/mesh.js: the small Emitter every
// pairing module extends. The mesh protocol itself is not needed here: lending is always
// exactly two peers, the friend who lends and the host who borrows.

export class Emitter {
  constructor() {
    this._handlers = new Map();
  }

  on(type, fn) {
    if (!this._handlers.has(type)) this._handlers.set(type, new Set());
    this._handlers.get(type).add(fn);
    return () => this._handlers.get(type)?.delete(fn);
  }

  emit(type, ...args) {
    for (const fn of this._handlers.get(type) || []) {
      try {
        fn(...args);
      } catch (err) {
        if (type !== 'error') this.emit('error', err);
      }
    }
  }
}
