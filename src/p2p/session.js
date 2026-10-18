// An encrypted session between two engines (PLAN 3.3 and 4). Every frame on the wire is
//   { s: stream, n: counter, ct: base64url }
// sealed with ChaCha20-Poly1305 under the key of its direction. The 96 bit nonce is the 32 bit
// stream id and the 64 bit counter; the counter is per direction, shared by all streams, and
// never repeats. Rekey: every 2^20 messages or 60 minutes, key(e+1) = HKDF(key(e), "rekey").
// The epoch is floor(n / 2^20), so both sides always agree; a time based rekey simply jumps the
// counter to the next epoch boundary. Old keys are wiped. Replays and frames older than the
// window are refused. Control frames (stream 1) leave before compute frames (stream 2), so a
// cancel or a revoke never waits behind a long generation.

import { EventEmitter } from 'node:events';
import { b64u, fromB64u } from './encoding.js';
import { hkdf, open, seal, wipe } from './primitives.js';
import { MessageError, messageSpec, readMessage, STREAM } from './messages.js';

export const REKEY_MESSAGES = 2 ** 20;
export const REKEY_MS = 60 * 60_000;
export const REPLAY_WINDOW = 128;
const MAX_FRAME_CHARS = 1_700_000; // a 1.1 MB job.result after base64
const MAX_BAD_FRAMES = 3;

const nonceOf = (s, n) => {
  const b = Buffer.alloc(12);
  b.writeUInt32BE(s, 0);
  b.writeBigUInt64BE(BigInt(n), 4);
  return b;
};
const aadOf = (sessionId, s, n) => `hivedesk v2 frame|${sessionId}|${s}|${n}`;
const nextKey = (k) => hkdf(k, Buffer.alloc(0), 'hivedesk v2 rekey', 32);

/** One direction's key schedule. */
class Direction {
  constructor(key, rekeyMessages) {
    this.epoch = 0;
    this.key = Buffer.from(key);
    this.prev = null; // the previous epoch's key, kept for one epoch on the receiving side
    this.rekeyMessages = rekeyMessages;
  }

  /** The key for an epoch, ratcheting forward. Returns null for an epoch that is gone. */
  keyFor(epoch) {
    if (epoch === this.epoch) return this.key;
    if (epoch === this.epoch - 1) return this.prev;
    if (epoch < this.epoch || epoch > this.epoch + 4) return null;
    while (this.epoch < epoch) {
      if (this.prev) wipe(this.prev);
      this.prev = this.key;
      this.key = nextKey(this.key);
      this.epoch++;
    }
    return this.key;
  }

  wipe() {
    wipe(this.key);
    if (this.prev) wipe(this.prev);
  }
}

/**
 * events: 'message' (msg, stream), 'refused' ({ code, detail }), 'close' (reason), 'rekey' ({ dir, epoch })
 */
export class SecureSession extends EventEmitter {
  /**
   * @param {{ id: string, peerId: string, role: 'host'|'guest', conn: any, sendKey: Buffer, recvKey: Buffer,
   *   now?: () => number, rekeyMessages?: number, rekeyMs?: number, confirmed?: boolean }} o
   */
  constructor(o) {
    super();
    this.id = o.id;
    this.peerId = o.peerId;
    this.role = o.role;
    this.conn = o.conn;
    this.connectionId = o.conn.id;
    this.now = o.now || (() => Date.now());
    this.rekeyMessages = o.rekeyMessages || REKEY_MESSAGES;
    this.rekeyMs = o.rekeyMs || REKEY_MS;
    this.out = new Direction(o.sendKey, this.rekeyMessages);
    this.in = new Direction(o.recvKey, this.rekeyMessages);
    wipe(o.sendKey, o.recvKey);
    this.sendN = 0;
    this.recvMax = -1;
    this.recvSeen = new Set();
    this.epochStartedAt = this.now();
    this.createdAt = new Date(this.now()).toISOString();
    this.lastActivity = this.createdAt;
    this.state = 'open';
    // confirmed: the other side proved it holds the keys (a frame from it decrypted). The
    // responder of a known peer reconnect is unconfirmed until the first frame arrives.
    this.confirmed = o.confirmed !== false;
    this.bad = 0;
    this.queue = { 1: [], 2: [], 3: [] };
    this.flushing = false;
    this.rates = new Map();
    this.msgSeq = 0;
    this._onMessage = (text) => this._receive(text);
    this._onClose = (reason) => this._closed(reason || 'transport closed');
    this.conn.on('message', this._onMessage);
    this.conn.on('close', this._onClose);
  }

  get rekeyAt() {
    return this.epochStartedAt + this.rekeyMs;
  }

  get rekeyCount() {
    return (this.out.epoch + 1) * this.rekeyMessages;
  }

  /** Sends one message. Returns its id. Throws MessageError for a closed session. */
  send(type, body = {}, { id, re } = {}) {
    if (this.state !== 'open') throw new MessageError('closed', 'the session is closed');
    const msgId = id || `m${++this.msgSeq}`;
    const msg = { t: type, id: msgId, ts: this.now(), body };
    if (re) msg.re = re;
    const stream = streamOf(type);
    this.queue[stream].push(msg);
    if (!this.flushing) {
      this.flushing = true;
      queueMicrotask(() => this._flush());
    }
    return msgId;
  }

  _flush() {
    this.flushing = false;
    // Control first, then media signaling, then compute.
    for (const s of [STREAM.CONTROL, STREAM.MEDIA, STREAM.COMPUTE]) {
      const q = this.queue[s];
      while (q.length && this.state === 'open') this._sendNow(s, q.shift());
    }
  }

  _sendNow(s, msg) {
    // Time based rekey: jump to the next epoch boundary.
    if (this.now() - this.epochStartedAt >= this.rekeyMs) {
      this.sendN = (Math.floor(this.sendN / this.rekeyMessages) + 1) * this.rekeyMessages;
    }
    const n = this.sendN++;
    const epoch = Math.floor(n / this.rekeyMessages);
    if (epoch !== this.out.epoch) {
      this.out.keyFor(epoch);
      if (this.out.prev) {
        wipe(this.out.prev);
        this.out.prev = null;
      }
      this.epochStartedAt = this.now();
      this.emit('rekey', { dir: 'out', epoch });
    }
    const ct = seal(this.out.key, nonceOf(s, n), JSON.stringify(msg), aadOf(this.id, s, n));
    const frame = JSON.stringify({ s, n, ct: b64u(ct) });
    this.conn.send(frame);
    this.lastActivity = new Date(this.now()).toISOString();
  }

  _refuse(code, detail) {
    this.emit('refused', { code, detail });
    if (code === 'bad_frame' && ++this.bad >= MAX_BAD_FRAMES) this.close('bad_frame');
  }

  _receive(text) {
    if (this.state !== 'open') return;
    if (typeof text !== 'string' || text.length > MAX_FRAME_CHARS) return this._refuse('bad_frame', 'frame too large');
    let f;
    try {
      f = JSON.parse(text);
    } catch {
      return this._refuse('bad_frame', 'not JSON');
    }
    if (f && f.t === 'hs.fail') {
      // The other side ended the handshake in plaintext (it could not open our hs.3).
      this.emit('hsfail', typeof f.code === 'string' ? f.code.slice(0, 30) : 'failed');
      return this._closed('handshake failed');
    }
    if (!f || ![1, 2, 3].includes(f.s) || !Number.isSafeInteger(f.n) || f.n < 0 || typeof f.ct !== 'string') return this._refuse('bad_frame', 'not a frame');
    if (this.recvSeen.has(f.n) || f.n <= this.recvMax - REPLAY_WINDOW) return this._refuse('replay', `counter ${f.n} was seen or is too old`);
    const epoch = Math.floor(f.n / this.rekeyMessages);
    const before = this.in.epoch;
    // Try the key without ratcheting first, so a forged frame cannot move the schedule.
    const probe = epoch > this.in.epoch ? null : this.in.keyFor(epoch);
    let plain;
    try {
      const ct = fromB64u(f.ct);
      if (probe) plain = open(probe, nonceOf(f.s, f.n), ct, aadOf(this.id, f.s, f.n));
      else {
        if (epoch > this.in.epoch + 4) throw new Error('epoch too far ahead');
        let k = Buffer.from(this.in.key);
        for (let e = this.in.epoch; e < epoch; e++) {
          const nk = nextKey(k);
          wipe(k);
          k = nk;
        }
        plain = open(k, nonceOf(f.s, f.n), ct, aadOf(this.id, f.s, f.n));
        wipe(k);
        this.in.keyFor(epoch);
      }
    } catch {
      return this._refuse('bad_frame', 'could not open the frame');
    }
    if (this.in.epoch !== before) this.emit('rekey', { dir: 'in', epoch: this.in.epoch });
    this.recvSeen.add(f.n);
    if (f.n > this.recvMax) this.recvMax = f.n;
    if (this.recvSeen.size > REPLAY_WINDOW * 2) for (const x of this.recvSeen) if (x <= this.recvMax - REPLAY_WINDOW) this.recvSeen.delete(x);
    this.bad = 0;
    this.lastActivity = new Date(this.now()).toISOString();
    if (!this.confirmed) {
      this.confirmed = true;
      this.emit('confirmed');
    }
    let msg;
    try {
      msg = readMessage(JSON.parse(plain.toString('utf8')), f.s, plain.length);
    } catch (err) {
      if (err instanceof MessageError && err.code === 'bad_input') {
        let id;
        try { id = JSON.parse(plain.toString('utf8')).id; } catch { id = undefined; }
        this.emit('refused', { code: 'bad_input', detail: err.message });
        if (typeof id === 'string') this.send('error', { code: 'bad_input', message: err.message.slice(0, 200) }, { re: id.slice(0, 64) });
        return;
      }
      this.emit('refused', { code: 'bad_message', detail: err.message });
      return this.close('bad_message');
    }
    if (!this._rateOk(msg.t)) {
      this.emit('refused', { code: 'rate_limited', detail: msg.t });
      if (msg.t !== 'error' && msg.id) this.send('error', { code: 'rate_limited', message: `too many ${msg.t}` }, { re: msg.id });
      return;
    }
    this.emit('message', msg, f.s);
  }

  _rateOk(type) {
    const spec = rateOf(type);
    if (!spec) return true;
    const [count, windowMs] = spec;
    const t = this.now();
    const hits = (this.rates.get(type) || []).filter((x) => x > t - windowMs);
    if (hits.length >= count) {
      this.rates.set(type, hits);
      return false;
    }
    hits.push(t);
    this.rates.set(type, hits);
    return true;
  }

  close(reason = 'closed') {
    if (this.state !== 'open') return;
    try {
      // A last best effort notice; the transport may already be gone.
      this._sendNow(STREAM.CONTROL, { t: 'session.close', id: `m${++this.msgSeq}`, ts: this.now(), body: { reason } });
    } catch { /* ignore */ }
    this._closed(reason);
    try {
      this.conn.close(reason);
    } catch { /* ignore */ }
  }

  _closed(reason) {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.conn.off?.('message', this._onMessage);
    this.conn.off?.('close', this._onClose);
    this.out.wipe();
    this.in.wipe();
    this.emit('close', reason);
  }

  info() {
    return { id: this.id, peerId: this.peerId, connectionId: this.connectionId, role: this.role, createdAt: this.createdAt, lastActivity: this.lastActivity, rekeyAt: this.rekeyAt, state: this.state === 'open' ? 'open' : 'closed' };
  }
}

function streamOf(type) {
  const spec = messageSpec(type);
  if (!spec) throw new MessageError('bad_message', `unknown message type ${type}`);
  return spec.stream;
}

function rateOf(type) {
  return messageSpec(type)?.rate || null;
}
