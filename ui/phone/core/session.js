// The encrypted session between a phone and its desktop (docs/1.0/protocol/phone.md section 4).
// Same frame shape as the p2p sessions (PLAN section 4): { s: stream, n: counter, ct: base64url },
// sealed with AES-256-GCM under the key of its direction; the 96 bit nonce is the stream id and
// the counter, the additional data names the session, the stream and the counter. The data channel
// is ordered and reliable, so a counter must grow strictly: a replayed or reordered frame is refused.
// WebCrypto is asynchronous, so sending and receiving each run through one queue to keep the order.
// A session ends after 2^24 messages in one direction (the phone reconnects with fresh keys).

import { Emitter } from '../../lend/core/emitter.js';
import { aesKey, seal, open, nonceOf, b64u, fromB64u } from './crypto.js';
import { readMessage, messageSpec, PhoneMessageError } from './messages.js';

export const MAX_MESSAGES = 2 ** 24;
export const MAX_FRAME_CHARS = 1_500_000;
const MAX_BAD = 3;

const aadOf = (id, s, n) => `hivedesk phone v1 frame|${id}|${s}|${n}`;

/**
 * events: 'message' (msg), 'refused' ({ code, detail }), 'confirmed', 'close' (reason)
 */
export class FrameSession extends Emitter {
  /**
   * @param {{ id: string, side: 'phone' | 'desktop', sendKey: Uint8Array, recvKey: Uint8Array, write: (text: string) => void,
   *   now?: () => number, confirmed?: boolean, maxMessages?: number }} o
   */
  constructor(o) {
    super();
    this.id = o.id;
    this.side = o.side;
    this.write = o.write;
    this.now = o.now || (() => Date.now());
    this.maxMessages = o.maxMessages || MAX_MESSAGES;
    this.confirmed = o.confirmed !== false;
    this.state = 'open';
    this.sendN = 0;
    this.recvMax = -1;
    this.bad = 0;
    this.msgSeq = 0;
    this.rates = new Map();
    this.lastIn = this.now();
    this.lastOut = this.now();
    this._keys = Promise.all([aesKey(o.sendKey), aesKey(o.recvKey)]).then(([s, r]) => {
      this.sendKey = s;
      this.recvKey = r;
    });
    o.sendKey.fill?.(0);
    o.recvKey.fill?.(0);
    this._out = this._keys;
    this._in = this._keys;
  }

  /** Queues one message. Returns its id; throws for a closed session or an unknown type. */
  send(type, body = {}, { re, id } = {}) {
    if (this.state !== 'open') throw new PhoneMessageError('closed', 'the session is closed');
    const spec = messageSpec(type);
    if (!spec) throw new PhoneMessageError('bad_message', `unknown message type ${type}`);
    const msgId = id || `m${++this.msgSeq}`;
    const msg = { t: type, id: msgId, ts: this.now(), body };
    if (re) msg.re = re;
    const n = this.sendN++;
    if (n >= this.maxMessages) {
      queueMicrotask(() => this.close('renew'));
      throw new PhoneMessageError('closed', 'the session used its keys up');
    }
    this._out = this._out.then(async () => {
      if (this.state === 'closed') return;
      const ct = await seal(this.sendKey, nonceOf(spec.s, n), JSON.stringify(msg), aadOf(this.id, spec.s, n));
      this.lastOut = this.now();
      this.write(JSON.stringify({ s: spec.s, n, ct: b64u(ct) }));
    }).catch((err) => this.emit('refused', { code: 'send_failed', detail: String(err?.message || err) }));
    return msgId;
  }

  /** Feeds one frame from the transport. Resolves when it was handled. */
  receive(text) {
    this._in = this._in.then(() => this._receive(text)).catch((err) => this.emit('refused', { code: 'internal', detail: String(err?.message || err) }));
    return this._in;
  }

  _refuse(code, detail) {
    this.emit('refused', { code, detail });
    if (code === 'bad_frame' && ++this.bad >= MAX_BAD) this.close('bad_frame');
  }

  async _receive(text) {
    if (this.state !== 'open') return;
    if (typeof text !== 'string' || text.length > MAX_FRAME_CHARS) return this._refuse('bad_frame', 'frame too large');
    let f;
    try {
      f = JSON.parse(text);
    } catch {
      return this._refuse('bad_frame', 'not JSON');
    }
    if (f && f.t === 'ph.fail') {
      this.emit('hsfail', typeof f.code === 'string' ? f.code.slice(0, 30) : 'failed');
      return this._closed('handshake failed');
    }
    if (!f || ![1, 2, 3].includes(f.s) || !Number.isSafeInteger(f.n) || f.n < 0 || typeof f.ct !== 'string') return this._refuse('bad_frame', 'not a frame');
    if (f.n <= this.recvMax) return this._refuse('replay', `counter ${f.n} was seen`);
    let plain;
    try {
      plain = await open(this.recvKey, nonceOf(f.s, f.n), fromB64u(f.ct), aadOf(this.id, f.s, f.n));
    } catch {
      return this._refuse('bad_frame', 'could not open the frame');
    }
    if (this.state !== 'open') return;
    this.recvMax = f.n;
    this.bad = 0;
    this.lastIn = this.now();
    if (!this.confirmed) {
      this.confirmed = true;
      this.emit('confirmed');
    }
    let msg;
    try {
      msg = readMessage(JSON.parse(new TextDecoder().decode(plain)), f.s, plain.length, this.side);
    } catch (err) {
      this.emit('refused', { code: 'bad_message', detail: String(err?.message || err) });
      return this.close('bad_message');
    }
    if (!this._rateOk(msg.t)) {
      this.emit('refused', { code: 'rate_limited', detail: msg.t });
      if (msg.t !== 'error' && msg.id) this.send('error', { code: 'rate_limited', message: `too many ${msg.t}` }, { re: msg.id });
      return;
    }
    if (msg.t === 'session.close') return this._closed(`closed by the other side: ${msg.body.reason}`);
    this.emit('message', msg);
  }

  _rateOk(type) {
    const spec = messageSpec(type)?.rate;
    if (!spec) return true;
    const [count, windowMs] = spec;
    const t = this.now();
    const hits = (this.rates.get(type) || []).filter((x) => x > t - windowMs);
    const ok = hits.length < count;
    if (ok) hits.push(t);
    this.rates.set(type, hits);
    return ok;
  }

  /** Ends the session, telling the other side when the transport is still there. */
  close(reason = 'closed') {
    if (this.state !== 'open') return;
    try {
      this.send('session.close', { reason: String(reason).slice(0, 120) });
    } catch { /* keys used up or already closing */ }
    this.state = 'closing';
    this._out.finally(() => this._closed(reason));
  }

  _closed(reason) {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.sendKey = null;
    this.recvKey = null;
    this.emit('close', reason);
  }
}
