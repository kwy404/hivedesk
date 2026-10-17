// A minimal WebSocket client (text frames, ping and close) for the local runtime connection.
// Node 18 has no WebSocket global, so this keeps the desktop shell free of dependencies.
import crypto from 'node:crypto';
import http from 'node:http';
import { EventEmitter } from 'node:events';

export function connectWs(url, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      host: u.hostname, port: u.port, path: u.pathname + u.search,
      headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': key, 'sec-websocket-version': '13' }
    });
    const timer = setTimeout(() => { req.destroy(new Error('websocket connect timeout')); }, timeoutMs);
    req.on('error', (err) => { clearTimeout(timer); reject(err); });
    req.on('response', (res) => { clearTimeout(timer); reject(new Error(`websocket refused: HTTP ${res.statusCode}`)); });
    req.on('upgrade', (res, socket, head) => {
      clearTimeout(timer);
      const expect = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      if (res.headers['sec-websocket-accept'] !== expect) { socket.destroy(); return reject(new Error('bad websocket accept')); }
      resolve(new WsConn(socket, head));
    });
    req.end();
  });
}

class WsConn extends EventEmitter {
  constructor(socket, head) {
    super();
    this.socket = socket;
    this.buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
    this.fragments = [];
    this.open = true;
    socket.setNoDelay(true);
    socket.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this.parse(); });
    socket.on('close', () => { if (this.open) { this.open = false; this.emit('close'); } });
    socket.on('error', (err) => this.emit('error', err));
    if (this.buf.length) setImmediate(() => this.parse());
  }

  parse() {
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      const masked = (b1 & 0x80) !== 0;
      const maskAt = off;
      if (masked) off += 4;
      if (this.buf.length < off + len) return;
      let payload = this.buf.subarray(off, off + len);
      if (masked) {
        const m = this.buf.subarray(maskAt, maskAt + 4);
        payload = Buffer.from(payload.map((v, i) => v ^ m[i % 4]));
      }
      this.buf = this.buf.subarray(off + len);
      const op = b0 & 0x0f;
      const fin = (b0 & 0x80) !== 0;
      if (op === 0x8) { this.close(); return; }
      if (op === 0x9) { this.frame(0xa, payload); continue; }
      if (op === 0xa) continue;
      if (op === 0x1 || op === 0x2 || op === 0x0) {
        this.fragments.push(Buffer.from(payload));
        if (fin) {
          const msg = Buffer.concat(this.fragments).toString('utf8');
          this.fragments = [];
          this.emit('message', msg);
        }
      }
    }
  }

  frame(op, payload) {
    if (!this.open) return;
    const len = payload.length;
    const head = len < 126 ? Buffer.alloc(2) : len < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
    head[0] = 0x80 | op;
    if (len < 126) head[1] = 0x80 | len;
    else if (len < 65536) { head[1] = 0x80 | 126; head.writeUInt16BE(len, 2); }
    else { head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(len), 2); }
    const mask = crypto.randomBytes(4);
    const body = Buffer.from(payload.map((v, i) => v ^ mask[i % 4]));
    this.socket.write(Buffer.concat([head, mask, body]));
  }

  send(text) { this.frame(0x1, Buffer.from(String(text), 'utf8')); }

  close() {
    if (!this.open) return;
    try { this.frame(0x8, Buffer.alloc(0)); } catch { /* socket gone */ }
    this.open = false;
    this.socket.end();
    this.emit('close');
  }
}
