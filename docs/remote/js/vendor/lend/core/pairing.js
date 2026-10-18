// Copied from ui/lend/core/pairing.js by scripts/phone-page.mjs. Edit the source, then run the script.
// Adapted from howlden (MIT, Alexandre Kohler), app/core/pairing.js. The same code also runs in filefinch.
// The six word handshake. Both sides derive a topic and a key from the words,
// meet on public MQTT brokers (several at once) and swap the invite and the
// reply, sealed with that key.
//   creator: shows the words, waits for a "join", sends the invite to the first
//            device that knocks, then takes its reply
//   joiner:  knocks with "join" until the invite arrives, then sends its reply
// The code expires after 10 minutes, works once, and both sides leave the
// brokers as soon as the reply is through. The brokers are not ours and only
// ever see a random topic and ciphertext.

import { Emitter } from './emitter.js';
import { randomId } from './bytes.js';
import { generateWords } from './words.js';
import { RelayHub } from './relay.js';
import { ReplayGuard, RENDEZVOUS_ITERATIONS, deriveRendezvous, openMessage, sealMessage } from './rendezvous.js';

export const CODE_LIFETIME_MS = 10 * 60 * 1000;
export const KNOCK_EVERY_MS = 1500;
export const JOIN_TIMEOUT_MS = 45000;
const REPLY_REPEATS = 12;

class Side extends Emitter {
  constructor({ brokers, WebSocket, iterations = RENDEZVOUS_ITERATIONS, knockEvery = KNOCK_EVERY_MS, timeout = 9000 } = {}) {
    super();
    this.id = randomId(9);
    this.guard = new ReplayGuard();
    this.hubOptions = { ...(brokers ? { brokers } : {}), WebSocket, timeout };
    this.iterations = iterations;
    this.knockEvery = knockEvery;
    this.hub = null;
    this.timers = [];
    this.stopped = false;
  }

  /** words: the six words (0.2), or a prepared { topic, key } from the engine (1.0, p2p-pipe.js). */
  async open(words) {
    const prepared = words && !Array.isArray(words) && typeof words.topic === 'string' && words.key;
    this.words = prepared ? null : words;
    this.rv = prepared ? words : await deriveRendezvous(words, this.iterations);
    if (this.stopped) throw new Error('stopped');
    this.hub = new RelayHub(this.rv.topic, this.hubOptions);
    this.hub.on('status', (s) => this.emit('status', s));
    this.hub.on('message', ({ payload }) => this.receive(payload));
    await this.hub.start();
    if (this.stopped) throw new Error('stopped');
    this.emit('status', this.hub.status());
  }

  async receive(payload) {
    let msg;
    try {
      msg = await openMessage(this.rv, payload);
    } catch {
      return; // other words, or noise: nothing a stranger sends can be read as ours
    }
    if (this.stopped || msg.f === this.id || !this.guard.accept(msg)) return;
    this.handle(msg);
  }

  async publish(body) {
    if (this.stopped || !this.hub) return 0;
    return this.hub.publish(await sealMessage(this.rv, { ...body, f: this.id }));
  }

  every(ms, fn) {
    const t = setInterval(fn, ms);
    this.timers.push(() => clearInterval(t));
    fn();
  }

  after(ms, fn) {
    const t = setTimeout(fn, ms);
    this.timers.push(() => clearTimeout(t));
  }

  /** Leave every broker and stop all timers. */
  stop() {
    this.stopped = true;
    for (const off of this.timers) off();
    this.timers = [];
    this.hub?.close();
  }
}

/** The side that shows the words. offerReady resolves with the invite fields to send. */
export class CodeCreator extends Side {
  constructor(offerReady, options) {
    super(options);
    this.offerReady = offerReady;
    this.guest = null;
    this.answered = false;
    this.lifetime = options?.lifetime ?? CODE_LIFETIME_MS;
  }

  async start(words = generateWords()) {
    this.expires = Date.now() + this.lifetime;
    this.after(this.lifetime, () => {
      this.stop();
      this.emit('expired');
    });
    await this.open(words);
    return words;
  }

  async handle(msg) {
    if (msg.k === 'join') {
      // Single use: the first device that knocks gets the invite, later knocks are ignored.
      this.guest ??= msg.f;
      if (msg.f !== this.guest || this.answered) return;
      const offer = await this.offerReady;
      await this.publish({ k: 'offer', to: this.guest, ...offer });
    } else if (msg.k === 'answer' && msg.f === this.guest && msg.to === this.id && !this.answered) {
      this.answered = true;
      this.emit('answer', msg);
    }
  }
}

/** The side that typed or scanned the words. */
export class CodeJoiner extends Side {
  constructor(options) {
    super(options);
    this.joinTimeout = options?.joinTimeout ?? JOIN_TIMEOUT_MS;
  }

  async start(words) {
    await this.open(words);
    this.after(this.joinTimeout, () => {
      if (!this.host) this.emit('timeout');
    });
    this.every(this.knockEvery, () => !this.host && this.publish({ k: 'join' }));
  }

  handle(msg) {
    if (msg.k !== 'offer' || msg.to !== this.id || this.host) return;
    this.host = msg.f;
    this.emit('offer', msg);
  }

  /** Send the reply a few times: the relays deliver at most once and may drop it. */
  sendAnswer(answer) {
    let n = 0;
    this.every(this.knockEvery, () => n++ < REPLY_REPEATS && this.publish({ k: 'answer', to: this.host, ...answer }));
  }
}
