// The transport contract (PLAN 3.4): a Connection carries opaque text frames between two
// engines. It never sees plaintext after the handshake; the handshake messages themselves are
// public values and ciphertext. Every transport implements the same small surface:
//   id, transport, remote: { address? }, state, bytesIn, bytesOut
//   send(text) -> boolean, close(reason), events 'message' (text) and 'close' (reason)
// remote.address never leaves the engine (Connection.info() leaves it out).

import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';

export const MAX_TEXT = 1_700_000;

export class Connection extends EventEmitter {
  constructor(transport, remote = {}) {
    super();
    this.id = 'cn_' + crypto.randomBytes(6).toString('hex');
    this.transport = transport;
    this.remote = { ...remote };
    this.state = 'open';
    this.bytesIn = 0;
    this.bytesOut = 0;
    this.openedAt = Date.now();
  }

  /** Subclasses call this for every text that arrives. */
  _deliver(text) {
    if (this.state === 'closed') return;
    if (typeof text !== 'string' || text.length > MAX_TEXT) {
      this.close('frame too large');
      return;
    }
    this.bytesIn += Buffer.byteLength(text);
    this.emit('message', text);
  }

  /** Subclasses implement _write(text) and _end(reason). */
  send(text) {
    if (this.state === 'closed' || this.state === 'closing') return false;
    const s = String(text);
    this.bytesOut += Buffer.byteLength(s);
    return this._write(s) !== false;
  }

  close(reason = 'closed') {
    if (this.state === 'closed' || this.state === 'closing') return;
    this.state = 'closing';
    try {
      this._end(reason);
    } finally {
      this._closed(reason);
    }
  }

  _closed(reason) {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.emit('close', reason);
  }

  _write() {
    throw new Error('not implemented');
  }

  _end() {}

  /** Connection of PLAN section 2, without the address. */
  info() {
    return { id: this.id, transport: this.transport, remote: { peerId: this.remote.peerId }, state: this.state, rttMs: this.rttMs, bytesIn: this.bytesIn, bytesOut: this.bytesOut };
  }
}
