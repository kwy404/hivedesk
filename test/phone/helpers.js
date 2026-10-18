// Helpers for the phone tests: an in-process link between the phone client and the engine's hub
// (the role the WebRTC data channel and the window's pipe play for real), and a phone identity.

import { Connection } from '../../src/p2p/transport/base.js';
import { newIdentityKey, deviceIdOf } from '../../ui/phone/core/crypto.js';
import { identityOf } from '../../ui/phone/core/handshake.js';

class Side extends Connection {
  constructor(peerFn) {
    super('inproc');
    this.peerFn = peerFn;
  }
  _write(text) {
    const other = this.peerFn();
    setImmediate(() => other._deliver(text));
    return true;
  }
  _end(reason) {
    const other = this.peerFn();
    setImmediate(() => other.close(reason));
  }
}

/** { conn } for the hub and { link } for the phone client, wired together. */
export function linkPair() {
  let a;
  let b;
  a = new Side(() => b);
  b = new Side(() => a);
  const link = {
    send: (t) => b.send(t),
    close: (r) => b.close(r),
    onmessage: null,
    onclose: null,
    sent: []
  };
  b.on('message', (t) => link.onmessage?.(t));
  b.on('close', (r) => link.onclose?.(r));
  return { conn: a, link, phoneSide: b };
}

export async function phoneIdentity(prefer = 'ed25519') {
  const k = await newIdentityKey({ prefer });
  return { alg: k.alg, identity: identityOf(k.alg, k.privateKey, k.publicRaw), deviceId: await deviceIdOf(k.alg, k.publicRaw) };
}

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** Waits until fn() is truthy, polling every 10 ms. */
export async function until(fn, ms = 4000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await tick(10);
  }
}
