// How a phone and its desktop window find each other (docs/1.0/protocol/phone.md section 3.1): on
// the public relays (the MQTT brokers of ui/lend/core/relay.js), with every relay message sealed under
// a key only the two sides hold, they swap one WebRTC offer and one answer; then the data channel
// carries the handshake and the session. The relays see a topic and ciphertext only.
//   pairing:  topic and seal key from the QR secret (invite.js); the window listens, the phone knocks.
//   known:    the desktop's public home topic; each paired phone knocks with its own seal key, and the
//             window tries the keys of its paired phones, so phones cannot read each other's offers.
// Used by the phone page and by the desktop window (ui/phone/desktop.js).

import { Emitter } from '../../lend/core/emitter.js';
import { CodeJoiner } from '../../lend/core/pairing.js';
import { RelayHub } from '../../lend/core/relay.js';
import { RtcLink } from '../../lend/core/rtc.js';
import { ReplayGuard, openMessage, sealMessage } from '../../lend/core/rendezvous.js';
import { splitFrame, Reassembler } from '../../lend/core/p2p-pipe.js';
import { randomId, fromBase64Url } from '../../lend/core/bytes.js';

export const DIAL_MS = 40_000;

/** { topic, key } for the relay helpers, from a topic and a raw 32 byte seal key (bytes or base64url). */
export async function rendezvousOf(topic, seal) {
  const raw = typeof seal === 'string' ? fromBase64Url(seal) : seal;
  const key = await globalThis.crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  return { topic, key };
}

/**
 * A link over an open RtcLink that splits large frames into data channel parts and joins them again:
 * { send(text), close(reason), onmessage, onclose, rtc }.
 */
export function framed(rtc) {
  const join = new Reassembler();
  const link = {
    rtc,
    onmessage: null,
    onclose: null,
    send(text) {
      for (const part of splitFrame(text)) rtc.send(part);
    },
    close() {
      rtc.close();
    }
  };
  rtc.onmessage = (m) => {
    const whole = join.push(m);
    if (whole !== null) link.onmessage?.(whole);
  };
  rtc.onclose = (r) => link.onclose?.(r || 'closed');
  return link;
}

const linkOpts = (o) => Object.fromEntries(Object.entries({ iceServers: o.iceServers, RTCPeerConnection: o.RTCPeerConnection, gatherTimeout: o.gatherTimeout }).filter(([, v]) => v !== undefined));
const relayOpts = (o) => Object.fromEntries(Object.entries({ brokers: o.brokers, WebSocket: o.WebSocket, joinTimeout: o.joinTimeout ?? DIAL_MS }).filter(([, v]) => v !== undefined));

/**
 * The phone: knocks on the relays, answers the window's offer and resolves with a framed link once
 * the data channel is open. onStatus gets 'relays' and 'connecting'. Rejects with code 'no_desktop'
 * when no window answers, 'relays' when no relay can be reached, 'rtc' when the channel fails.
 */
export function dial(rv, o = {}) {
  return new Promise((resolve, reject) => {
    const rtc = o.link || new RtcLink(linkOpts(o));
    const joiner = new CodeJoiner(relayOpts(o));
    let done = false;
    const fail = (code, detail) => {
      if (done) return;
      done = true;
      joiner.stop();
      rtc.close();
      reject(Object.assign(new Error(detail || code), { code, detail }));
    };
    joiner.on('timeout', () => fail('no_desktop'));
    joiner.on('offer', async (msg) => {
      if (typeof msg.s !== 'string') return;
      o.onStatus?.('connecting');
      try {
        joiner.sendAnswer({ s: await rtc.answer(msg.s) });
      } catch (err) {
        fail('rtc', err.message);
      }
    });
    rtc.onopen = () => {
      if (done) return;
      done = true;
      joiner.stop();
      resolve(framed(rtc));
    };
    rtc.onfail = (reason) => fail('rtc', reason === 'timeout' && rtc.diagnose ? rtc.diagnose(globalThis.navigator?.onLine ?? true) : reason);
    o.onStatus?.('relays');
    joiner.start(rv).catch((err) => fail('relays', err.message));
  });
}

/** One offer per knock: the window side of a single phone. Resolves the RtcLink once open. */
function offerTo(publish, rtc, guestId) {
  let answered = false;
  return {
    async start() {
      const s = await rtc.offer();
      await publish({ k: 'offer', to: guestId, s });
    },
    async answer(msg) {
      if (answered || typeof msg.s !== 'string') return;
      answered = true;
      await rtc.complete(msg.s);
    }
  };
}

/**
 * The desktop window waiting for phones. rvs: a list of { topic, key, label } on one topic (the home
 * topic with the key of each paired phone), or a single invite rendezvous. Every knock that opens
 * with one of the keys gets its own WebRTC link; 'link' fires with (framedLink, label) once open.
 *   events: 'status' (relays), 'link' (link, label), 'failed' (reason), 'stopped'
 */
export class PhoneListener extends Emitter {
  constructor({ topic, keys, once = false, options = {} }) {
    super();
    this.topic = topic;
    this.keys = keys; // [{ key: CryptoKey, label }]
    this.once = once;
    this.options = options;
    this.id = randomId(9);
    this.guard = new ReplayGuard();
    this.guests = new Map(); // guest id -> { rtc, offer, rv, label }
    this.stopped = false;
  }

  async start() {
    this.hub = new RelayHub(this.topic, { ...(this.options.brokers ? { brokers: this.options.brokers } : {}), WebSocket: this.options.WebSocket, timeout: 9000 });
    this.hub.on('status', (s) => this.emit('status', s));
    this.hub.on('message', ({ payload }) => this._receive(payload));
    await this.hub.start();
    this.emit('status', this.hub.status());
  }

  /** Replaces the keys (a phone was paired or removed). */
  setKeys(keys) {
    this.keys = keys;
  }

  async _receive(payload) {
    if (this.stopped) return;
    for (const k of this.keys) {
      const rv = { topic: this.topic, key: k.key };
      let msg;
      try {
        msg = await openMessage(rv, payload);
      } catch {
        continue;
      }
      if (msg.f === this.id || !this.guard.accept(msg)) return;
      return this._handle(msg, rv, k.label);
    }
  }

  async _handle(msg, rv, label) {
    if (msg.k === 'join') {
      if (this.guests.has(msg.f)) return;
      if (this.guests.size >= 3) return; // a few phones at once, never a flood of links
      const rtc = new RtcLink(linkOpts(this.options));
      const publish = async (body) => this.hub?.publish(await sealMessage(rv, { ...body, f: this.id }));
      const g = { rtc, offer: offerTo(publish, rtc, msg.f), label };
      this.guests.set(msg.f, g);
      const drop = () => this.guests.get(msg.f) === g && this.guests.delete(msg.f);
      rtc.onopen = () => {
        drop();
        this.emit('link', framed(rtc), label);
        if (this.once) this.stop();
      };
      rtc.onfail = (reason) => {
        drop();
        this.emit('failed', reason);
      };
      setTimeout(() => { if (!rtc.open) { drop(); rtc.close(); } }, DIAL_MS).unref?.();
      try {
        await g.offer.start();
      } catch (err) {
        drop();
        this.emit('failed', err.message);
      }
    } else if (msg.k === 'answer' && msg.to === this.id) {
      await this.guests.get(msg.f)?.offer.answer(msg).catch((err) => this.emit('failed', err.message));
    }
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.hub?.close();
    for (const g of this.guests.values()) if (!g.rtc.open) g.rtc.close();
    this.guests.clear();
    this.emit('stopped');
  }
}
