// Adapted from howlden (MIT, Alexandre Kohler), app/core/relay.js. The same code also runs in filefinch.
// Several public MQTT brokers used in parallel as a meeting point. Every connected broker gets
// each message; whichever delivers first wins and duplicates are dropped by the replay guard.
// The brokers are not ours. They only see a random topic and ciphertext, only during pairing,
// and the hub disconnects as soon as the devices are connected.

import { Emitter } from './emitter.js';
import { MqttClient } from './mqtt.js';

/** Public brokers that answered from a browser in testing, in fallback order. */
export const DEFAULT_BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://test.mosquitto.org:8081/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://broker-cn.emqx.io:8084/mqtt',
];

export class RelayHub extends Emitter {
  constructor(topic, { brokers = DEFAULT_BROKERS, WebSocket, timeout = 9000, minimum = 1 } = {}) {
    super();
    this.topic = topic;
    this.brokers = brokers;
    this.WebSocket = WebSocket;
    this.timeout = timeout;
    this.minimum = minimum;
    this.clients = [];
    this.failed = [];
    this.closed = false;
  }

  /** Connects to every broker. Resolves once `minimum` are subscribed, rejects if none can be. */
  start() {
    return new Promise((resolve, reject) => {
      let ready = 0;
      let finished = 0;
      let settled = false;
      const check = () => {
        if (settled) return;
        if (ready >= this.minimum) {
          settled = true;
          resolve(this);
        } else if (finished === this.brokers.length) {
          settled = true;
          reject(new Error(`No public relay answered (${this.failed.map((f) => f.error).join('; ')})`));
        }
      };
      for (const url of this.brokers) {
        const client = new MqttClient(url, { WebSocket: this.WebSocket, timeout: this.timeout });
        client
          .connect()
          .then(() => (this.closed ? Promise.reject(new Error('closed')) : client.subscribe(this.topic)))
          .then(() => {
            if (this.closed) return client.close();
            client.on('message', (m) => m.topic === this.topic && this.emit('message', { payload: m.payload, broker: url }));
            client.on('close', () => {
              this.clients = this.clients.filter((c) => c !== client);
              this.emit('status', this.status());
            });
            this.clients.push(client);
            ready++;
            this.emit('status', this.status());
          })
          .catch((err) => {
            client.close();
            this.failed.push({ url, error: err.message });
          })
          .finally(() => {
            finished++;
            check();
          });
      }
    });
  }

  status() {
    return { connected: this.clients.map((c) => c.url), total: this.brokers.length };
  }

  publish(payload) {
    for (const c of this.clients) c.publish(this.topic, payload);
    return this.clients.length;
  }

  close() {
    this.closed = true;
    for (const c of this.clients) c.close();
    this.clients = [];
  }
}
