// The window half of browser-pipe for remote desktop by address (src/p2p/remote-port.js).
//   Listening: while "Let partners reach this computer by its address" is on, this window waits on the
//   public relays at the address meeting point (p2p.address) and hands each data channel to the engine,
//   which runs the identity handshake. Nothing is granted by it: the host's dialog decides.
//   Dialing: remote.connect without a LAN address asks the window to meet the other machine
//   (live p2p.dial.pipe); the data channel goes to the engine for that dial.
// The window sees the public meeting values and ciphertext only.

import * as net from '../js/net.js';
import { PipeOffer, PipeJoin } from '../lend/core/p2p-pipe.js';

/** The engine socket as p2p-pipe.js expects it: command(type, data) and on('live:<type>', fn). */
const hive = {
  command: (type, data) => net.command(type, data),
  on: (ev, fn) => {
    const type = String(ev).replace(/^live:/, '');
    return net.on('live', (f) => { if (f.type === type) fn(f.data || {}); });
  },
};

let offer = null;
let wanted = false;
let retry = null;

async function listenLoop() {
  clearTimeout(retry);
  if (!wanted || offer) return;
  let info;
  try { info = await net.command('p2p.address', {}); } catch { info = null; }
  if (!wanted || !info?.rendezvous) return;
  const po = new PipeOffer({ hive, rendezvous: info.rendezvous });
  offer = po;
  const again = (ms) => {
    if (offer === po) offer = null;
    if (ms === null) return;
    retry = setTimeout(listenLoop, ms);
  };
  // A caller arrived: wait on the relays again for the next one.
  po.on('piped', () => again(500));
  po.on('failed', () => { po.stop(); again(3000); });
  po.on('expired', () => { po.stop(); again(500); });
  try { await po.start(); } catch { po.stop(); again(5000); }
}

/** Follows remote.state.listening. */
export function syncListening(listening) {
  if (listening === wanted) return;
  wanted = !!listening;
  if (wanted) listenLoop();
  else {
    clearTimeout(retry);
    offer?.stop();
    offer = null;
  }
}

/** Meets the machine of a dial on the relays (live p2p.dial.pipe { dialId, rendezvous }). */
export function onDialPipe(d) {
  if (!d?.dialId || !d.rendezvous) return;
  const pj = new PipeJoin({ hive, rendezvous: d.rendezvous, openData: { dialId: d.dialId } });
  pj.on('failed', () => pj.stop());
  pj.on('timeout', () => pj.stop());
  pj.start().catch(() => pj.stop());
}
