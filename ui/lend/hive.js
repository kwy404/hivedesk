// A small client for the local hivedesk WebSocket (PROTOCOL.md sections 1 and 2), used by the
// lend bridges. It opens its own socket on purpose: a remote brain belongs to the socket that
// attached it, so closing this socket (or the tab) detaches the friend's brain cleanly.

import { Emitter } from './core/emitter.js';

export function socketUrl(loc = globalThis.location) {
  const token = new URLSearchParams(loc.search).get('t');
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/ws${token ? `?t=${encodeURIComponent(token)}` : ''}`;
}

export class HiveSocket extends Emitter {
  constructor(url = socketUrl(), { WebSocket: WS = globalThis.WebSocket, timeout = 200000 } = {}) {
    super();
    this.url = url;
    this.WS = WS;
    this.timeout = timeout;
    this.next = 1;
    this.waiting = new Map();
    this.hello = null;
  }

  /** Opens the socket and resolves with the hello frame. */
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new this.WS(this.url);
      this.ws = ws;
      let greeted = false;
      ws.onmessage = (e) => {
        let m;
        try {
          m = JSON.parse(e.data);
        } catch {
          return;
        }
        if (m.kind === 'hello' && !greeted) {
          greeted = true;
          this.hello = m;
          resolve(m);
        }
        if (m.kind === 'reply') {
          const w = this.waiting.get(m.id);
          if (!w) return;
          this.waiting.delete(m.id);
          clearTimeout(w.timer);
          if (m.ok) w.resolve(m.result ?? {});
          else w.reject(Object.assign(new Error(m.error?.message || 'command failed'), { code: m.error?.code || 'internal' }));
          return;
        }
        this.emit(m.kind, m);
        if (m.kind === 'event') this.emit(`event:${m.event?.type}`, m.event);
        if (m.kind === 'live') this.emit(`live:${m.type}`, m.data);
      };
      ws.onerror = () => !greeted && reject(new Error('Could not reach the local hivedesk'));
      ws.onclose = () => {
        for (const w of this.waiting.values()) {
          clearTimeout(w.timer);
          w.reject(Object.assign(new Error('The local hivedesk closed the connection'), { code: 'closed' }));
        }
        this.waiting.clear();
        this.emit('close');
        if (!greeted) reject(new Error('The local hivedesk closed the connection'));
      };
    });
  }

  command(type, data = {}) {
    const id = `l${this.next++}`;
    return new Promise((resolve, reject) => {
      if (this.ws?.readyState !== 1) return reject(Object.assign(new Error('Not connected to the local hivedesk'), { code: 'closed' }));
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(Object.assign(new Error(`${type} timed out`), { code: 'timeout' }));
      }, this.timeout);
      this.waiting.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ kind: 'command', id, type, data }));
    });
  }

  /** A command that gets no reply (brain.token). */
  notify(type, data = {}) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ kind: 'command', id: `n${this.next++}`, type, data }));
  }

  close() {
    this.ws?.close();
  }
}
