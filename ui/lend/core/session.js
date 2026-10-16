// Pairing for Lend your PC, built from the howlden and filefinch pieces (MIT, Alexandre Kohler):
// the six word rendezvous on public MQTT brokers (pairing.js), one WebRTC link (rtc.js) and the
// confirmation words from both DTLS fingerprints (words.js confirmWords).
//
//   friend (lends):  LendOffer   shows the words, sends the WebRTC offer to the first device
//                                that knocks, applies its answer
//   host (borrows):  LendJoin    knocks with the words, answers the offer
//
// When the data channel opens both sides compute the same six confirmation words. A device that
// learned the words over someone's shoulder has its own certificate, so its words differ. Nothing
// but the hello frame travels until the person on each side confirms the words match.

import { Emitter } from './emitter.js';
import { CodeCreator, CodeJoiner } from './pairing.js';
import { RtcLink } from './rtc.js';
import { randomId } from './bytes.js';
import { confirmWords } from './words.js';
import { FrameError, decodeFrame, encodeFrame, LIMITS } from './frames.js';

/** The lend frames (frames.js). Code together passes its own codec with the same shape. */
export const LEND_CODEC = { decode: decodeFrame, encode: encodeFrame };

/** A data channel message above this many characters travels in parts (browsers cap one message near 256 KB). */
export const CHUNK_CHARS = 60000;
const MAX_PARTS = 200;

/**
 * One open connection after pairing: sends and receives checked frames, tracks the two
 * confirmations. Works over anything with send(text), onmessage, onclose and close(), so tests
 * run it over an in-memory pair. Long frames are split into parts and joined again.
 *   events: 'frame' (frame), 'ready' (both sides confirmed), 'rejected' (error), 'close' (reason)
 */
export class LendPeer extends Emitter {
  constructor(link, { confirm = [], limits = LIMITS, codec = LEND_CODEC } = {}) {
    super();
    this.link = link;
    this.limits = limits;
    this.codec = codec;
    this.parts = new Map(); // id -> { n, got: string[], count }
    this.nextPart = 0;
    this.confirm = confirm;
    this.localConfirmed = false;
    this.remoteConfirmed = false;
    this.remoteHello = null;
    this.closed = false;
    link.onmessage = (text) => this._receive(text);
    link.onclose = (reason) => this._closed(reason || 'closed');
  }

  get ready() {
    return this.localConfirmed && this.remoteConfirmed && !this.closed;
  }

  /** Joins a frame sent in parts. Returns the whole text, or null while parts are missing. */
  _part(text) {
    let p;
    try {
      p = JSON.parse(text);
    } catch {
      return null;
    }
    const n = p.n | 0;
    const i = p.i | 0;
    if (typeof p.id !== 'string' || n < 2 || n > MAX_PARTS || i < 0 || i >= n || typeof p.s !== 'string') return null;
    let entry = this.parts.get(p.id);
    if (!entry) {
      if (this.parts.size > 8) this.parts.delete(this.parts.keys().next().value);
      entry = { n, got: new Array(n), count: 0 };
      this.parts.set(p.id, entry);
    }
    if (entry.n !== n || entry.got[i] !== undefined) return null;
    entry.got[i] = p.s;
    entry.count++;
    if (entry.count < n) return null;
    this.parts.delete(p.id);
    return entry.got.join('');
  }

  _receive(text) {
    if (this.closed) return;
    if (typeof text === 'string' && text.startsWith('{"t":"~"')) {
      const whole = this._part(text);
      if (whole === null) return;
      text = whole;
    }
    let frame;
    try {
      frame = this.codec.decode(text, this.limits);
    } catch (err) {
      this.emit('rejected', err instanceof FrameError ? err : new FrameError('bad_frame', String(err?.message || err)));
      return;
    }
    if (frame.t === 'hello') this.remoteHello = frame;
    if (frame.t === 'confirm') {
      const was = this.ready;
      this.remoteConfirmed = true;
      if (!was && this.ready) this.emit('ready');
      return;
    }
    if (frame.t === 'stop') {
      this.emit('frame', frame);
      this._closed(`stopped by the other side: ${frame.reason}`);
      return;
    }
    // Requests and answers only flow once both people confirmed the words.
    if (frame.t !== 'hello' && !this.ready) {
      this.emit('rejected', new FrameError('not_confirmed', 'A frame arrived before the confirmation words were checked'));
      return;
    }
    this.emit('frame', frame);
  }

  /** Sends one frame. Throws a FrameError when it breaks a limit. */
  send(frame) {
    if (this.closed) throw new FrameError('closed', 'The connection is closed');
    const text = this.codec.encode(frame, this.limits);
    if (text.length <= CHUNK_CHARS) {
      this.link.send(text);
      return;
    }
    const n = Math.ceil(text.length / CHUNK_CHARS);
    if (n > MAX_PARTS) throw new FrameError('too_big', 'This frame is too large to send');
    const id = `p${++this.nextPart}`;
    for (let i = 0; i < n; i++) this.link.send(JSON.stringify({ t: '~', id, i, n, s: text.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS) }));
  }

  /** The person on this side checked the confirmation words. */
  confirmLocal() {
    if (this.localConfirmed || this.closed) return;
    const was = this.ready;
    this.localConfirmed = true;
    this.send({ t: 'confirm' });
    if (!was && this.ready) this.emit('ready');
  }

  /** Ends lending: tells the other side, then closes. */
  stop(reason = 'stopped') {
    if (this.closed) return;
    try {
      this.send({ t: 'stop', reason });
    } catch {
      // the link may already be gone
    }
    this._closed(reason);
    setTimeout(() => this.link.close?.(), 200);
  }

  _closed(reason) {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', reason);
  }
}

function linkOptions(o) {
  return { iceServers: o.iceServers, RTCPeerConnection: o.RTCPeerConnection, gatherTimeout: o.gatherTimeout };
}

const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/**
 * The friend's side. start() resolves with the six words to show.
 *   events: 'status' (relay status), 'connected' (LendPeer, confirmation words), 'failed' (reason), 'expired'
 */
export class LendOffer extends Emitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.nonce = randomId(12);
    this.link = new RtcLink(clean(linkOptions(options)));
    this.creator = new CodeCreator(
      this.link.offer().then((s) => ({ s, x: this.nonce })),
      clean({ brokers: options.brokers, WebSocket: options.WebSocket, iterations: options.iterations, lifetime: options.lifetime }),
    );
    this.creator.on('status', (s) => this.emit('status', s));
    this.creator.on('expired', () => this.emit('expired'));
    this.creator.on('answer', (msg) => this._answer(msg));
    this.link.onopen = () => this._open();
    this.link.onfail = (reason) => this.emit('failed', reason === 'timeout' ? this.link.diagnose(globalThis.navigator?.onLine ?? true) : reason);
  }

  async start(words) {
    this.words = await this.creator.start(words);
    return this.words;
  }

  async _answer(msg) {
    if (typeof msg.s !== 'string') return;
    try {
      await this.link.complete(msg.s);
    } catch (err) {
      this.emit('failed', `answer: ${err.message}`);
    }
  }

  _open() {
    this.creator.stop();
    const [a, b] = this.link.fingerprints();
    const words = confirmWords(a, b, this.nonce);
    const peer = new LendPeer(this.link, { confirm: words, limits: this.options.limits, codec: this.options.codec });
    this.emit('connected', peer, words);
  }

  stop() {
    this.creator.stop();
    if (!this.link.open) this.link.close();
  }
}

/**
 * The host's side. start(words) knocks until the friend's offer arrives.
 *   events: 'status', 'connected' (LendPeer, confirmation words), 'failed' (reason), 'timeout'
 */
export class LendJoin extends Emitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.link = new RtcLink(clean(linkOptions(options)));
    this.joiner = new CodeJoiner(clean({ brokers: options.brokers, WebSocket: options.WebSocket, iterations: options.iterations, joinTimeout: options.joinTimeout }));
    this.joiner.on('status', (s) => this.emit('status', s));
    this.joiner.on('timeout', () => this.emit('timeout'));
    this.joiner.on('offer', (msg) => this._offer(msg));
    this.link.onopen = () => this._open();
    this.link.onfail = (reason) => this.emit('failed', reason === 'timeout' ? this.link.diagnose(globalThis.navigator?.onLine ?? true) : reason);
  }

  async start(words) {
    await this.joiner.start(words);
  }

  async _offer(msg) {
    if (typeof msg.s !== 'string' || typeof msg.x !== 'string') return;
    this.nonce = msg.x;
    try {
      const s = await this.link.answer(msg.s);
      this.joiner.sendAnswer({ s });
    } catch (err) {
      this.emit('failed', `offer: ${err.message}`);
    }
  }

  _open() {
    this.joiner.stop();
    const [a, b] = this.link.fingerprints();
    const words = confirmWords(a, b, this.nonce);
    const peer = new LendPeer(this.link, { confirm: words, limits: this.options.limits, codec: this.options.codec });
    this.emit('connected', peer, words);
  }

  stop() {
    this.joiner.stop();
    if (!this.link.open) this.link.close();
  }
}
