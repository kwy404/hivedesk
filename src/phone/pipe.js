// The browser pipe for phones, the same idea as src/p2p/transport/browser-pipe.js: the hivedesk
// window keeps the WebRTC data channel to the phone and only moves text. What the phone sends goes
// to this engine with phone.pipe.in, what this engine sends returns to that window as the live frame
// phone.pipe.out { pipeId, data }. The window sees handshake values and ciphertext, nothing else.
// A pipe belongs to the socket that opened it; another window cannot feed or close it.

import crypto from 'node:crypto';
import { Connection, MAX_TEXT } from '../p2p/transport/base.js';

const MAX_PIPES_PER_CLIENT = 6;

class PhonePipe extends Connection {
  constructor(hub, client, pipeId) {
    super('browser-pipe', { address: `window:${client.id}` });
    this.hub = hub;
    this.client = client;
    this.pipeId = pipeId;
  }

  _write(text) {
    return this.client.conn.sendJson({ kind: 'live', type: 'phone.pipe.out', data: { pipeId: this.pipeId, data: text } });
  }

  _end(reason) {
    this.hub.pipes.delete(this.pipeId);
    try {
      this.client.conn.sendJson({ kind: 'live', type: 'phone.pipe.closed', data: { pipeId: this.pipeId, reason: String(reason).slice(0, 120) } });
    } catch { /* the window is gone */ }
  }
}

export class PhonePipeHub {
  constructor() {
    this.pipes = new Map();
  }

  open(client) {
    if (!client?.conn) throw Object.assign(new Error('a pipe needs the WebSocket of a window'), { code: 'bad_request' });
    const mine = [...this.pipes.values()].filter((p) => p.client === client && p.state !== 'closed');
    if (mine.length >= MAX_PIPES_PER_CLIENT) throw Object.assign(new Error('too many phone pipes for this window'), { code: 'busy' });
    const pipeId = 'pq_' + crypto.randomBytes(8).toString('hex');
    const conn = new PhonePipe(this, client, pipeId);
    this.pipes.set(pipeId, conn);
    if (!client.phonePipeWatch) {
      client.phonePipeWatch = true;
      client.conn.on?.('close', () => this.clientGone(client));
    }
    conn.on('close', () => this.pipes.delete(pipeId));
    return conn;
  }

  _mine(client, pipeId) {
    const p = this.pipes.get(String(pipeId || ''));
    if (!p || p.client !== client) throw Object.assign(new Error('no such phone pipe on this connection'), { code: 'not_found' });
    return p;
  }

  input(client, pipeId, data) {
    const p = this._mine(client, pipeId);
    if (typeof data !== 'string' || data.length > MAX_TEXT) {
      p.close('frame too large');
      throw Object.assign(new Error('frame too large'), { code: 'bad_request' });
    }
    p._deliver(data);
  }

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
