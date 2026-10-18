// A byte tunnel for llama.cpp RPC over the authenticated peer channel: TCP streams on 127.0.0.1 at both
// ends, frames in between. Nothing here ever listens on, or connects to, anything but the loopback.
//
//   borrower  llama-server --rpc 127.0.0.1:<a>  ->  listen end (127.0.0.1:<a>)  ->  frames
//   lender    frames  ->  dial end  ->  rpc-server on 127.0.0.1:<b> (the port the lender chose)
//
// Frames (JSON, one lease each):
//   { k: 'open', lease, ch }              a new connection
//   { k: 'data', lease, ch, b64 }         up to CHUNK bytes
//   { k: 'ack', lease, ch, bytes }        flow control: bytes written on the other side
//   { k: 'end', lease, ch, why? }         the connection closed
// Flow control: a side stops reading its socket while more than WINDOW bytes are not acknowledged.
import net from 'node:net';

export const CHUNK = 256 * 1024;
export const WINDOW = 4 * 1024 * 1024;
export const MAX_CHANNELS = 16;
const LOOPBACK = '127.0.0.1';

function frameOk(f, lease) {
  return f && typeof f === 'object' && f.lease === lease && Number.isInteger(f.ch) && f.ch >= 0 && f.ch < 1e6 && ['open', 'data', 'ack', 'end'].includes(f.k);
}

class Channel {
  constructor(tunnel, ch, socket) {
    this.t = tunnel;
    this.ch = ch;
    this.socket = socket;
    this.unacked = 0;
    this.paused = false;
    this.closed = false;
    this.pending = [];
    socket.setNoDelay?.(true);
    socket.on('data', (buf) => {
      for (let i = 0; i < buf.length; i += CHUNK) {
        const part = buf.subarray(i, i + CHUNK);
        this.unacked += part.length;
        this.t.bytesOut += part.length;
        this.t.send({ k: 'data', lease: this.t.lease, ch: this.ch, b64: part.toString('base64') });
      }
      if (this.unacked > WINDOW && !this.paused) { this.paused = true; socket.pause(); }
    });
    socket.on('close', () => this.close('closed', true));
    socket.on('error', () => this.close('error', true));
  }

  write(b64) {
    const buf = Buffer.from(b64, 'base64');
    if (buf.length > CHUNK) { this.close('frame too big', true); return; }
    this.t.bytesIn += buf.length;
    this.socket.write(buf, () => this.t.send({ k: 'ack', lease: this.t.lease, ch: this.ch, bytes: buf.length }));
  }

  ack(bytes) {
    this.unacked = Math.max(0, this.unacked - (Number(bytes) || 0));
    if (this.paused && this.unacked <= WINDOW / 2) { this.paused = false; this.socket.resume(); }
  }

  close(why, tellPeer) {
    if (this.closed) return;
    this.closed = true;
    try { this.socket.destroy(); } catch { /* gone */ }
    this.t.channels.delete(this.ch);
    if (tellPeer) this.t.send({ k: 'end', lease: this.t.lease, ch: this.ch, why });
  }
}

class TunnelEnd {
  constructor({ lease, send }) {
    if (!lease || typeof lease !== 'string') throw new Error('a tunnel needs a lease id');
    this.lease = lease;
    this._send = send;
    this.channels = new Map();
    this.bytesIn = 0;
    this.bytesOut = 0;
    this.closed = false;
  }

  send(frame) {
    if (this.closed) return;
    try { this._send(frame); } catch { /* the transport went away; the session notices */ }
  }

  close() {
    if (this.closed) return;
    for (const c of [...this.channels.values()]) c.close('tunnel closed', true);
    this.closed = true;
    this.server?.close();
  }
}

/** Borrower side: llama-server connects here; each connection becomes a channel to the lender. */
export class ListenEnd extends TunnelEnd {
  constructor(opts) {
    super(opts);
    this.next = 0;
  }

  /** @returns {Promise<number>} the 127.0.0.1 port to give llama-server */
  listen() {
    this.server = net.createServer((socket) => {
      if (this.closed || this.channels.size >= MAX_CHANNELS) { socket.destroy(); return; }
      const ch = this.next++;
      this.channels.set(ch, new Channel(this, ch, socket));
      this.send({ k: 'open', lease: this.lease, ch });
    });
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, LOOPBACK, () => resolve(this.server.address().port));
    });
  }

  receive(f) {
    if (this.closed || !frameOk(f, this.lease)) return false;
    const c = this.channels.get(f.ch);
    if (!c) return false;
    if (f.k === 'data' && typeof f.b64 === 'string') c.write(f.b64);
    else if (f.k === 'ack') c.ack(f.bytes);
    else if (f.k === 'end') c.close(f.why || 'peer closed', false);
    return true;
  }
}

/** Lender side: opens a connection to the lender's own rpc-server for each channel. Never another address. */
export class DialEnd extends TunnelEnd {
  constructor({ port, ...opts }) {
    super(opts);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('a dial end needs the local rpc-server port');
    this.port = port;
  }

  receive(f) {
    if (this.closed || !frameOk(f, this.lease)) return false;
    if (f.k === 'open') {
      if (this.channels.has(f.ch) || this.channels.size >= MAX_CHANNELS) { this.send({ k: 'end', lease: this.lease, ch: f.ch, why: 'refused' }); return false; }
      const socket = net.connect({ host: LOOPBACK, port: this.port });
      const c = new Channel(this, f.ch, socket);
      this.channels.set(f.ch, c);
      return true;
    }
    const c = this.channels.get(f.ch);
    if (!c) return false;
    if (f.k === 'data' && typeof f.b64 === 'string') c.write(f.b64);
    else if (f.k === 'ack') c.ack(f.bytes);
    else if (f.k === 'end') c.close(f.why || 'peer closed', false);
    return true;
  }
}

/**
 * Two ends joined in this process (tests, and a pool on one machine): frames go through JSON as they
 * would over the peer channel.
 */
export function loopback(lease, port) {
  let listen = null;
  let dial = null;
  const pass = (to) => (f) => { const copy = JSON.parse(JSON.stringify(f)); setImmediate(() => to()?.receive(copy)); };
  dial = new DialEnd({ lease, port, send: pass(() => listen) });
  listen = new ListenEnd({ lease, send: pass(() => dial) });
  return { listen, dial };
}
