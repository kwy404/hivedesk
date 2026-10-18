// browser-pipe: the default path across NATs in 1.0 (PLAN 3.4). The hivedesk window keeps its
// WebRTC data channel (ui/lend/core/rtc.js) and only moves bytes: what arrives from the remote
// window goes to this engine with the command p2p.pipe.in, and what this engine sends comes back
// to that same window as a live frame { kind: 'live', type: 'p2p.pipe.out', data: { pipeId, data } }.
// The window never sees plaintext: the handshake and the session run here, the window carries
// public handshake values and ciphertext. A pipe belongs to the socket that opened it and closes
// with it.

import crypto from 'node:crypto';
import { Connection, MAX_TEXT } from './base.js';

const MAX_PIPES_PER_CLIENT = 4;

class BrowserPipeConnection extends Connection {
  constructor(hub, client, pipeId) {
    super('browser-pipe', { address: `window:${client.id}` });
    this.hub = hub;
    this.client = client;
    this.pipeId = pipeId;
  }

  _write(text) {
    return this.client.conn.sendJson({ kind: 'live', type: 'p2p.pipe.out', data: { pipeId: this.pipeId, data: text } });
  }

  _end(reason) {
    this.hub.pipes.delete(this.pipeId);
    try {
      this.client.conn.sendJson({ kind: 'live', type: 'p2p.pipe.closed', data: { pipeId: this.pipeId, reason: String(reason).slice(0, 120) } });
    } catch { /* the window is gone */ }
  }
}

export class BrowserPipeHub {
  constructor() {
    this.pipes = new Map(); // pipeId -> connection
  }

  /** Opens a pipe for the window behind client. Returns the connection. */
  open(client) {
    if (!client?.conn) throw Object.assign(new Error('a pipe needs the WebSocket of a window'), { code: 'bad_request' });
    const mine = [...this.pipes.values()].filter((p) => p.client === client && p.state !== 'closed');
    if (mine.length >= MAX_PIPES_PER_CLIENT) throw Object.assign(new Error('too many pipes for this window'), { code: 'busy' });
    const pipeId = 'pp_' + crypto.randomBytes(8).toString('hex');
    const conn = new BrowserPipeConnection(this, client, pipeId);
    this.pipes.set(pipeId, conn);
    if (!client.pipeWatch) {
      client.pipeWatch = true;
      client.conn.on?.('close', () => this.clientGone(client));
    }
    conn.on('close', () => this.pipes.delete(pipeId));
    return conn;
  }

  _mine(client, pipeId) {
    const p = this.pipes.get(String(pipeId || ''));
    // Another window cannot feed or close someone else's pipe.
    if (!p || p.client !== client) throw Object.assign(new Error('no such pipe on this connection'), { code: 'not_found' });
    return p;
  }

  /** Bytes from the remote window. */
  input(client, pipeId, data) {
    const p = this._mine(client, pipeId);
    if (typeof data !== 'string' || data.length > MAX_TEXT) {
      p.close('frame too large');
      throw Object.assign(new Error('frame too large'), { code: 'bad_request' });
    }
    p._deliver(data);
  }

  /** The window's data channel closed. */
  remoteClosed(client, pipeId, reason = 'the data channel closed') {
    const p = this._mine(client, pipeId);
    this.pipes.delete(p.pipeId);
    p._closed(String(reason).slice(0, 120));
  }

  clientGone(client) {
    for (const p of [...this.pipes.values()]) if (p.client === client) {
      this.pipes.delete(p.pipeId);
      p._closed('the window closed');
    }
  }
}
