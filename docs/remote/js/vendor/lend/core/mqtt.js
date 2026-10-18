// Copied from ui/lend/core/mqtt.js by scripts/phone-page.mjs. Edit the source, then run the script.
// Adapted from howlden (MIT, Alexandre Kohler), app/core/mqtt.js. The same code also runs in filefinch.
// A minimal MQTT 3.1.1 client over WebSocket, enough to meet on public brokers:
// CONNECT, SUBSCRIBE, PUBLISH at QoS 0, PINGREQ and DISCONNECT. No dependencies.
// The brokers only ever carry random looking topic names and ciphertext (see rendezvous.js).

import { Emitter } from './emitter.js';
import { concatBytes, fromUtf8, randomId, utf8 } from './bytes.js';

export const TYPES = { CONNECT: 1, CONNACK: 2, PUBLISH: 3, SUBSCRIBE: 8, SUBACK: 9, PINGREQ: 12, PINGRESP: 13, DISCONNECT: 14 };

export function encodeLength(n) {
  if (!Number.isInteger(n) || n < 0 || n > 268435455) throw new RangeError('MQTT remaining length out of range');
  const out = [];
  do {
    let byte = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) byte |= 0x80;
    out.push(byte);
  } while (n > 0);
  return Uint8Array.from(out);
}

/** Reads a remaining length at offset. Returns { value, size } or null when more bytes are needed. */
export function decodeLength(bytes, offset) {
  let value = 0;
  let mult = 1;
  for (let i = 0; i < 4; i++) {
    if (offset + i >= bytes.length) return null;
    const b = bytes[offset + i];
    value += (b & 0x7f) * mult;
    if ((b & 0x80) === 0) return { value, size: i + 1 };
    mult *= 128;
  }
  throw new Error('Malformed MQTT remaining length');
}

export function encodeString(s) {
  const b = utf8(s);
  if (b.length > 65535) throw new RangeError('MQTT string too long');
  return concatBytes([Uint8Array.of(b.length >> 8, b.length & 0xff), b]);
}

function packet(first, body) {
  return concatBytes([Uint8Array.of(first), encodeLength(body.length), body]);
}

export function connectPacket({ clientId, keepAlive = 30, clean = true }) {
  const header = concatBytes([encodeString('MQTT'), Uint8Array.of(4, clean ? 0x02 : 0x00, keepAlive >> 8, keepAlive & 0xff)]);
  return packet(0x10, concatBytes([header, encodeString(clientId)]));
}

export function subscribePacket(id, topics) {
  const parts = [Uint8Array.of(id >> 8, id & 0xff)];
  for (const t of topics) parts.push(encodeString(t), Uint8Array.of(0));
  return packet(0x82, concatBytes(parts));
}

export function publishPacket(topic, payload, { retain = false } = {}) {
  const data = typeof payload === 'string' ? utf8(payload) : payload;
  return packet(0x30 | (retain ? 1 : 0), concatBytes([encodeString(topic), data]));
}

export const pingPacket = () => Uint8Array.of(0xc0, 0);
export const disconnectPacket = () => Uint8Array.of(0xe0, 0);

/** Splits a byte stream into packets: { type, flags, body }. Handles partial and joined frames. */
export class PacketReader {
  constructor() {
    this.buf = new Uint8Array(0);
  }
  push(bytes) {
    this.buf = this.buf.length ? concatBytes([this.buf, bytes]) : bytes;
    const out = [];
    for (;;) {
      if (this.buf.length < 2) break;
      const len = decodeLength(this.buf, 1);
      if (!len) break;
      const start = 1 + len.size;
      const end = start + len.value;
      if (this.buf.length < end) break;
      out.push({ type: this.buf[0] >> 4, flags: this.buf[0] & 0x0f, body: this.buf.slice(start, end) });
      this.buf = this.buf.subarray(end);
    }
    return out;
  }
}

export function parsePublish(p) {
  const n = (p.body[0] << 8) | p.body[1];
  const topic = fromUtf8(p.body.subarray(2, 2 + n));
  const qos = (p.flags >> 1) & 3;
  let o = 2 + n;
  let id = null;
  if (qos > 0) {
    id = (p.body[o] << 8) | p.body[o + 1];
    o += 2;
  }
  return { topic, qos, id, retain: (p.flags & 1) === 1, payload: p.body.subarray(o) };
}

export const parseConnack = (p) => ({ sessionPresent: (p.body[0] & 1) === 1, code: p.body[1] });
export const parseSuback = (p) => ({ id: (p.body[0] << 8) | p.body[1], codes: Array.from(p.body.subarray(2)) });

const CONNACK_ERRORS = ['', 'unacceptable protocol version', 'identifier rejected', 'server unavailable', 'bad user name or password', 'not authorized'];

export class MqttClient extends Emitter {
  constructor(url, options = {}) {
    super();
    this.url = url;
    this.WebSocket = options.WebSocket ?? globalThis.WebSocket;
    this.clientId = options.clientId ?? `hd${randomId(9).replace(/[-_]/g, 'x')}`;
    this.keepAlive = options.keepAlive ?? 30;
    this.timeout = options.timeout ?? 8000;
    this.reader = new PacketReader();
    this.nextId = 1;
    this.pending = new Map();
    this.ws = null;
    this.connected = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) {
          this.close();
          reject(err);
        } else resolve(this);
      };
      const timer = setTimeout(() => done(new Error(`${this.url}: no answer`)), this.timeout);
      let ws;
      try {
        ws = new this.WebSocket(this.url, ['mqtt']);
      } catch (err) {
        done(err);
        return;
      }
      this.ws = ws;
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => ws.send(connectPacket({ clientId: this.clientId, keepAlive: this.keepAlive }));
      ws.onerror = () => done(new Error(`${this.url}: connection error`));
      ws.onclose = () => {
        done(new Error(`${this.url}: closed`));
        this.onClosed();
      };
      ws.onmessage = (e) => {
        for (const p of this.reader.push(new Uint8Array(e.data))) {
          if (p.type === TYPES.CONNACK) {
            const { code } = parseConnack(p);
            if (code === 0) {
              this.connected = true;
              this.ping = setInterval(() => this.send(pingPacket()), Math.max(5, this.keepAlive - 5) * 1000);
              done();
            } else done(new Error(`${this.url}: ${CONNACK_ERRORS[code] ?? `refused (${code})`}`));
          } else this.onPacket(p);
        }
      };
    });
  }

  onPacket(p) {
    if (p.type === TYPES.PUBLISH) {
      const msg = parsePublish(p);
      this.emit('message', msg);
    } else if (p.type === TYPES.SUBACK) {
      const { id, codes } = parseSuback(p);
      const waiter = this.pending.get(id);
      this.pending.delete(id);
      if (waiter) codes.some((c) => c === 0x80) ? waiter.reject(new Error(`${this.url}: subscription refused`)) : waiter.resolve();
    }
  }

  send(bytes) {
    if (this.ws?.readyState === 1) this.ws.send(bytes);
  }

  subscribe(topic) {
    const id = this.nextId++ & 0xffff || 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.url}: no subscription answer`));
      }, this.timeout);
      this.pending.set(id, {
        resolve: () => (clearTimeout(timer), resolve()),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.send(subscribePacket(id, [topic]));
    });
  }

  publish(topic, payload) {
    this.send(publishPacket(topic, payload));
  }

  onClosed() {
    clearInterval(this.ping);
    const was = this.connected;
    this.connected = false;
    for (const w of this.pending.values()) w.reject(new Error(`${this.url}: closed`));
    this.pending.clear();
    if (was) this.emit('close');
  }

  close() {
    if (!this.ws) return;
    try {
      this.send(disconnectPacket());
      this.ws.close();
    } catch {
      // already closed
    }
    this.onClosed();
    this.ws = null;
  }
}
