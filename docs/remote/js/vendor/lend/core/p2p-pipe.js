// Copied from ui/lend/core/p2p-pipe.js by scripts/phone-page.mjs. Edit the source, then run the script.
// The window's half of the browser-pipe transport (1.0, src/p2p/transport/browser-pipe.js).
// The engine holds the identity, runs the handshake and the session; the window only:
//   1. meets the other window on the public relays with the topic and seal key the engine gave it
//      (derived from the invite words; the engine keeps the pre shared key to itself),
//   2. opens the WebRTC data channel (rtc.js),
//   3. moves text both ways: data channel -> p2p.pipe.in, live p2p.pipe.out -> data channel.
// It sees public handshake values and ciphertext, nothing else. Frames above one data channel
// message are split in parts here and joined again in the other window.

import { Emitter } from './emitter.js';
import { CodeCreator, CodeJoiner } from './pairing.js';
import { RtcLink } from './rtc.js';
import { fromBase64Url, randomId } from './bytes.js';

export const PART_CHARS = 60000;
const MAX_PARTS = 32;
const MAX_FRAME = 1_700_000;

/** The relay meeting point from the engine's { topic, seal } (base64url). */
export async function importRendezvous({ topic, seal }) {
  if (typeof topic !== 'string' || typeof seal !== 'string') throw new Error('The engine gave no meeting point');
  const key = await globalThis.crypto.subtle.importKey('raw', fromBase64Url(seal), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  return { topic: `hivedesk/v2/${topic}`, key };
}

/** Splits one frame into data channel messages: the frame itself, or "~id:i/n:" parts. */
export function splitFrame(text, size = PART_CHARS) {
  if (text.length <= size) return [text];
  const n = Math.ceil(text.length / size);
  if (n > MAX_PARTS) throw new Error('frame too large');
  const id = randomId(6);
  return Array.from({ length: n }, (_, i) => `~${id}:${i}/${n}:${text.slice(i * size, (i + 1) * size)}`);
}

/** Joins parts again. push(message) returns a whole frame, or null while parts are missing. */
export class Reassembler {
  constructor() {
    this.parts = new Map();
  }

  push(msg) {
    if (typeof msg !== 'string') return null;
    if (!msg.startsWith('~')) return msg.length <= MAX_FRAME ? msg : null;
    const m = /^~([A-Za-z0-9_-]{1,16}):(\d{1,3})\/(\d{1,3}):/.exec(msg);
    if (!m) return null;
    const [head, id, iText, nText] = m;
    const i = Number(iText);
    const n = Number(nText);
    if (n < 2 || n > MAX_PARTS || i >= n) return null;
    let e = this.parts.get(id);
    if (!e) {
      if (this.parts.size >= 4) this.parts.delete(this.parts.keys().next().value);
      e = { n, got: new Array(n), count: 0 };
      this.parts.set(id, e);
    }
    if (e.n !== n || e.got[i] !== undefined) return null;
    e.got[i] = msg.slice(head.length);
    if (++e.count < n) return null;
    this.parts.delete(id);
    return e.got.join('');
  }
}

/**
 * Bridges an open link (send, onmessage, onclose, close) to an engine pipe. openData is what
 * p2p.pipe.open takes: {} for the host, { joinId } for a guest, { peerId } for a known peer.
 * Frames the engine sends before the reply with the pipe id are kept and sent after it.
 */
export async function bridgeLink(hive, link, openData = {}) {
  let pipeId = null;
  let closed = false;
  const early = [];
  const fromLink = [];
  const joiner = new Reassembler();
  const toLink = (text) => {
    for (const part of splitFrame(text)) link.send(part);
  };
  const offOut = hive.on('live:p2p.pipe.out', (d) => {
    if (!d || typeof d.data !== 'string') return;
    if (pipeId === null) early.push(d);
    else if (d.pipeId === pipeId) toLink(d.data);
  });
  const offClosed = hive.on('live:p2p.pipe.closed', (d) => d?.pipeId === pipeId && end('engine'));
  const toEngine = (text) => hive.command('p2p.pipe.in', { pipeId, data: text }).catch(() => end('engine'));
  link.onmessage = (msg) => {
    const whole = joiner.push(msg);
    if (whole === null) return;
    if (pipeId === null) fromLink.push(whole);
    else toEngine(whole);
  };
  const end = (by) => {
    if (closed) return;
    closed = true;
    offOut();
    offClosed();
    if (by !== 'engine' && pipeId) hive.command('p2p.pipe.close', { pipeId, reason: 'the data channel closed' }).catch(() => {});
    if (by !== 'link') {
      try {
        link.close();
      } catch { /* already closed */ }
    }
  };
  link.onclose = () => end('link');
  const reply = await hive.command('p2p.pipe.open', openData);
  pipeId = reply.pipeId;
  for (const d of early.splice(0)) if (d.pipeId === pipeId) toLink(d.data);
  for (const t of fromLink.splice(0)) toEngine(t);
  return { pipeId, close: () => end('window') };
}

const linkOptions = (o) => Object.fromEntries(Object.entries({ iceServers: o.iceServers, RTCPeerConnection: o.RTCPeerConnection, gatherTimeout: o.gatherTimeout }).filter(([, v]) => v !== undefined));
const relayOptions = (o) => Object.fromEntries(Object.entries({ brokers: o.brokers, WebSocket: o.WebSocket, lifetime: o.lifetime, joinTimeout: o.joinTimeout }).filter(([, v]) => v !== undefined));

/**
 * The inviting window: waits on the relays for the first knock, sends the WebRTC offer, and once
 * the data channel opens hands it to the engine.
 *   events: 'status' (relays), 'piped' (pipeId), 'failed' (reason), 'expired', 'closed'
 */
export class PipeOffer extends Emitter {
  constructor({ hive, rendezvous, options = {} }) {
    super();
    this.hive = hive;
    this.rendezvous = rendezvous;
    this.options = options;
    this.link = options.link || new RtcLink(linkOptions(options));
    this.creator = new CodeCreator(this.link.offer().then((s) => ({ s })), relayOptions(options));
    this.creator.on('status', (s) => this.emit('status', s));
    this.creator.on('expired', () => this.emit('expired'));
    this.creator.on('answer', (msg) => typeof msg.s === 'string' && this.link.complete(msg.s).catch((err) => this.emit('failed', `answer: ${err.message}`)));
    this.link.onopen = () => this._open();
    this.link.onfail = (reason) => this.emit('failed', reason === 'timeout' && this.link.diagnose ? this.link.diagnose(globalThis.navigator?.onLine ?? true) : reason);
  }

  async start() {
    await this.creator.start(await importRendezvous(this.rendezvous));
  }

  async _open() {
    this.creator.stop();
    try {
      this.bridge = await bridgeLink(this.hive, this.link, {});
      const prev = this.link.onclose;
      this.link.onclose = (r) => {
        prev?.(r);
        this.emit('closed', r);
      };
      this.emit('piped', this.bridge.pipeId);
    } catch (err) {
      this.emit('failed', err.message);
    }
  }

  stop() {
    this.creator.stop();
    this.bridge?.close();
    if (!this.link.open) this.link.close();
  }
}

/**
 * The joining window: knocks on the relays, answers the offer, and hands the data channel to
 * the engine for the join it started with p2p.join (joinId).
 *   events: 'status', 'piped' (pipeId), 'failed' (reason), 'timeout', 'closed'
 */
export class PipeJoin extends Emitter {
  constructor({ hive, rendezvous, joinId, openData, options = {} }) {
    super();
    this.hive = hive;
    this.rendezvous = rendezvous;
    this.joinId = joinId;
    // What p2p.pipe.open gets: { joinId } for a join by words, { dialId } for a dial by address.
    this.openData = openData || { joinId };
    this.link = options.link || new RtcLink(linkOptions(options));
    this.joiner = new CodeJoiner(relayOptions(options));
    this.joiner.on('status', (s) => this.emit('status', s));
    this.joiner.on('timeout', () => this.emit('timeout'));
    this.joiner.on('offer', async (msg) => {
      if (typeof msg.s !== 'string') return;
      try {
        this.joiner.sendAnswer({ s: await this.link.answer(msg.s) });
      } catch (err) {
        this.emit('failed', `offer: ${err.message}`);
      }
    });
    this.link.onopen = () => this._open();
    this.link.onfail = (reason) => this.emit('failed', reason === 'timeout' && this.link.diagnose ? this.link.diagnose(globalThis.navigator?.onLine ?? true) : reason);
  }

  async start() {
    await this.joiner.start(await importRendezvous(this.rendezvous));
  }

  async _open() {
    this.joiner.stop();
    try {
      this.bridge = await bridgeLink(this.hive, this.link, this.openData);
      const prev = this.link.onclose;
      this.link.onclose = (r) => {
        prev?.(r);
        this.emit('closed', r);
      };
      this.emit('piped', this.bridge.pipeId);
    } catch (err) {
      this.emit('failed', err.message);
    }
  }

  stop() {
    this.joiner.stop();
    this.bridge?.close();
    if (!this.link.open) this.link.close();
  }
}
