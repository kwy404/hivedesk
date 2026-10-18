// A minimal MQTT 3.1.1 broker for the browser tests: Playwright's routeWebSocket answers the pages'
// connections to the public brokers here, so the e2e runs the real relay, WebRTC and handshake code
// without the internet. QoS 0 only: CONNECT, SUBSCRIBE, PUBLISH, PINGREQ, DISCONNECT.
import { PacketReader, parsePublish, publishPacket, TYPES } from '../../ui/lend/core/mqtt.js';

export function createBroker() {
  const subs = new Map(); // `${url}|${topic}` -> Set(route)
  const stats = { connects: 0, publishes: 0 };
  function attach(route) {
    const url = route.url();
    const reader = new PacketReader();
    const mine = new Set();
    const send = (bytes) => { try { route.send(Buffer.from(bytes)); } catch { /* closed */ } };
    route.onMessage((m) => {
      const bytes = typeof m === 'string' ? new TextEncoder().encode(m) : new Uint8Array(m);
      for (const p of reader.push(bytes)) {
        if (p.type === TYPES.CONNECT) { stats.connects++; send(Uint8Array.of(0x20, 2, 0, 0)); }
        else if (p.type === TYPES.SUBSCRIBE) {
          const id = [p.body[0], p.body[1]];
          let o = 2;
          const codes = [];
          while (o < p.body.length) {
            const n = (p.body[o] << 8) | p.body[o + 1];
            const topic = new TextDecoder().decode(p.body.subarray(o + 2, o + 2 + n));
            o += 3 + n;
            const key = `${url}|${topic}`;
            if (!subs.has(key)) subs.set(key, new Set());
            subs.get(key).add(route);
            mine.add(key);
            codes.push(0);
          }
          send(Uint8Array.of(0x90, 2 + codes.length, ...id, ...codes));
        } else if (p.type === TYPES.PUBLISH) {
          stats.publishes++;
          const { topic, payload } = parsePublish(p);
          const pkt = publishPacket(topic, payload);
          for (const r of subs.get(`${url}|${topic}`) || []) if (r !== route) { try { r.send(Buffer.from(pkt)); } catch { /* gone */ } }
        } else if (p.type === TYPES.PINGREQ) send(Uint8Array.of(0xd0, 0));
        else if (p.type === TYPES.DISCONNECT) route.close();
      }
    });
    route.onClose(() => { for (const k of mine) subs.get(k)?.delete(route); });
  }
  return { attach, stats };
}
