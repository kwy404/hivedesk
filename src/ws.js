// A tiny WebSocket (RFC 6455) for text frames: server upgrade, frame codec, and a small client for tests.
import crypto from 'node:crypto';
import http from 'node:http';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export const MAX_PAYLOAD = 16 * 1024 * 1024;

const UTF8 = new TextDecoder('utf-8', { fatal: true });

export const OP = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

export function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

/**
 * Encodes one frame.
 * @param {number} opcode
 * @param {Buffer | string} payload
 * @param {{ mask?: boolean, fin?: boolean }} [opts]
 */
export function encodeFrame(opcode, payload = Buffer.alloc(0), opts = {}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  const fin = opts.fin === false ? 0 : 0x80;
  const mask = opts.mask ? 0x80 : 0;
  let header;
  if (data.length < 126) {
    header = Buffer.from([fin | opcode, mask | data.length]);
  } else if (data.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = fin | opcode;
    header[1] = mask | 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = fin | opcode;
    header[1] = mask | 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  if (!opts.mask) return Buffer.concat([header, data]);
  const key = crypto.randomBytes(4);
  const masked = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ key[i & 3];
  return Buffer.concat([header, key, masked]);
}

/**
 * Incremental frame decoder. Call push(chunk); it emits complete frames through onFrame.
 */
export class FrameParser {
  /**
   * @param {(frame: { fin: boolean, opcode: number, payload: Buffer, masked: boolean }) => void} onFrame
   * @param {{ maxPayload?: number }} [opts]
   */
  constructor(onFrame, opts = {}) {
    this.buf = Buffer.alloc(0);
    this.onFrame = onFrame;
    this.maxPayload = opts.maxPayload || MAX_PAYLOAD;
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (true) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      if (b0 & 0x70) throw new WsError(1002, 'reserved bits set');
      const masked = !!(b1 & 0x80);
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        const big = this.buf.readBigUInt64BE(2);
        if (big > BigInt(this.maxPayload)) throw new WsError(1009, 'frame too large');
        len = Number(big);
        off = 10;
      }
      if (len > this.maxPayload) throw new WsError(1009, 'frame too large');
      const opcode = b0 & 0x0f;
      if (opcode >= 0x8 && (len > 125 || !(b0 & 0x80))) throw new WsError(1002, 'bad control frame');
      const need = off + (masked ? 4 : 0) + len;
      if (this.buf.length < need) return;
      let payload;
      if (masked) {
        const key = this.buf.subarray(off, off + 4);
        payload = Buffer.alloc(len);
        const src = this.buf.subarray(off + 4, need);
        for (let i = 0; i < len; i++) payload[i] = src[i] ^ key[i & 3];
      } else {
        payload = Buffer.from(this.buf.subarray(off, need));
      }
      this.buf = this.buf.subarray(need);
      this.onFrame({ fin: !!(b0 & 0x80), opcode, payload, masked });
    }
  }
}

export class WsError extends Error {
  constructor(code, message) {
    super(message);
    this.closeCode = code;
  }
}

/** One WebSocket connection (either side). Emits 'message' (string), 'close' (code, reason), 'error'. */
export class WsConnection extends EventEmitter {
  /**
   * @param {import('node:net').Socket} socket
   * @param {{ client?: boolean, maxPayload?: number }} [opts]
   */
  constructor(socket, opts = {}) {
    super();
    this.socket = socket;
    this.client = !!opts.client;
    this.open = true;
    this.fragments = null;
    this.fragOpcode = 0;
    this.fragSize = 0;
    this.maxPayload = opts.maxPayload || MAX_PAYLOAD;
    this.parser = new FrameParser((f) => this._frame(f), { maxPayload: this.maxPayload });
    socket.setNoDelay?.(true);
    socket.on('data', (chunk) => this.feed(chunk));
    socket.on('close', () => this._closed(1006, ''));
    socket.on('error', (err) => { this.emit('error', err); this._closed(1006, ''); });
    socket.on('end', () => this._closed(1006, ''));
  }

  /** Feeds raw bytes into the parser. */
  feed(chunk) {
    try {
      this.parser.push(chunk);
    } catch (err) {
      this._fail(err.closeCode || 1002, err.message);
    }
  }

  _frame(f) {
    if (!this.client && !f.masked) return this._fail(1002, 'client frames must be masked');
    if (this.client && f.masked) return this._fail(1002, 'server frames must not be masked');
    switch (f.opcode) {
      case OP.PING:
        this._write(OP.PONG, f.payload);
        this.emit('ping', f.payload);
        return;
      case OP.PONG:
        this.emit('pong', f.payload);
        return;
      case OP.CLOSE: {
        const code = f.payload.length >= 2 ? f.payload.readUInt16BE(0) : 1005;
        const reason = f.payload.length > 2 ? f.payload.subarray(2).toString('utf8') : '';
        if (this.open) {
          this._write(OP.CLOSE, f.payload.length >= 2 ? f.payload.subarray(0, 2) : Buffer.alloc(0));
          this.open = false;
        }
        this.socket.end();
        this._closed(code, reason);
        return;
      }
      case OP.TEXT:
      case OP.BINARY:
        if (this.fragments) return this._fail(1002, 'new message inside a fragmented one');
        if (f.fin) return this._deliver(f.opcode, f.payload);
        this.fragments = [f.payload];
        this.fragOpcode = f.opcode;
        this.fragSize = f.payload.length;
        return;
      case OP.CONT:
        if (!this.fragments) return this._fail(1002, 'continuation without a start');
        this.fragments.push(f.payload);
        this.fragSize += f.payload.length;
        if (this.fragSize > this.maxPayload) return this._fail(1009, 'message too large');
        if (f.fin) {
          const all = Buffer.concat(this.fragments);
          this.fragments = null;
          this._deliver(this.fragOpcode, all);
        }
        return;
      default:
        this._fail(1002, `unknown opcode ${f.opcode}`);
    }
  }

  _deliver(opcode, payload) {
    if (opcode === OP.TEXT) {
      let text;
      try { text = UTF8.decode(payload); } catch { return this._fail(1007, 'invalid UTF-8'); }
      this.emit('message', text);
    } else {
      this.emit('binary', payload);
    }
  }

  _write(opcode, payload) {
    if (this.socket.destroyed) return;
    try { this.socket.write(encodeFrame(opcode, payload, { mask: this.client })); } catch { /* closed */ }
  }

  send(text) {
    if (!this.open) return false;
    this._write(OP.TEXT, Buffer.from(String(text), 'utf8'));
    return true;
  }

  sendJson(obj) {
    return this.send(JSON.stringify(obj));
  }

  ping(data = '') {
    if (this.open) this._write(OP.PING, Buffer.from(data));
  }

  close(code = 1000, reason = '') {
    if (!this.open) return;
    this.open = false;
    const r = Buffer.from(String(reason).slice(0, 120), 'utf8');
    const p = Buffer.alloc(2 + r.length);
    p.writeUInt16BE(code, 0);
    r.copy(p, 2);
    this._write(OP.CLOSE, p);
    const t = setTimeout(() => this.socket.destroy(), 1000);
    t.unref?.();
  }

  _fail(code, reason) {
    this.close(code, reason);
    this._closed(code, reason);
  }

  _closed(code, reason) {
    if (this._didClose) return;
    this._didClose = true;
    this.open = false;
    this.emit('close', code, reason);
  }
}

/**
 * Completes a server side upgrade. Returns the connection, or null after answering 400.
 * @param {http.IncomingMessage} req
 * @param {import('node:net').Socket} socket
 * @param {Buffer} head
 */
export function acceptUpgrade(req, socket, head) {
  const key = req.headers['sec-websocket-key'];
  const version = req.headers['sec-websocket-version'];
  if (String(req.headers.upgrade || '').toLowerCase() !== 'websocket' || !key || version !== '13') {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return null;
  }
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey(key)}`,
    '', ''
  ].join('\r\n'));
  const conn = new WsConnection(socket);
  if (head && head.length) conn.feed(head);
  return conn;
}

/** Rejects an upgrade with an HTTP status. */
export function rejectUpgrade(socket, status, message) {
  const body = JSON.stringify({ error: { code: status === 401 ? 'unauthorized' : 'forbidden', message } });
  socket.end(`HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : 'Forbidden'}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
}

/**
 * Small client, used by tests and by tools that talk to a running hivedesk.
 * @param {string} url ws://host:port/path?query
 * @param {{ headers?: Record<string, string> }} [opts]
 * @returns {Promise<WsConnection>}
 */
export function connect(url, opts = {}) {
  const u = new URL(url);
  const key = crypto.randomBytes(16).toString('base64');
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET',
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13', ...(opts.headers || {}) }
    });
    req.on('upgrade', (res, socket, head) => {
      if (res.headers['sec-websocket-accept'] !== acceptKey(key)) {
        socket.destroy();
        return reject(new Error('bad accept key'));
      }
      const conn = new WsConnection(socket, { client: true });
      if (head && head.length) conn.feed(head);
      resolve(conn);
    });
    req.on('response', (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => reject(Object.assign(new Error(`upgrade refused: ${res.statusCode} ${body}`), { status: res.statusCode })));
    });
    req.on('error', reject);
    req.end();
  });
}
