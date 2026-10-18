// The phone's side of a connection to its desktop: the handshake, then the encrypted session with
// commands and live updates. It runs in the page (docs/remote/) and, unchanged, in the tests against
// an in-process engine. A link is anything with send(text), close(), and the callbacks onmessage(text)
// and onclose(reason): the WebRTC data channel in the page, a pipe in the tests.
//
// events: 'sas' ({ sas, host }), 'paired' ({ deviceId, grants, host }), 'refused' (reason), 'welcome' (body),
//         'state' (snapshot), 'feed' (items), 'notice' (body), 'grants' (list), 'remote' (msg), 'close' (reason)

import { Emitter } from '../../lend/core/emitter.js';
import { PairGuest, KnownGuest, PhoneHandshakeError, failMessage, parseHs } from './handshake.js';
import { FrameSession } from './session.js';

export const PING_MS = 10_000;
export const SILENCE_MS = 35_000;
export const CMD_TIMEOUT_MS = 20_000;
const HS_MS = 20_000;

/** Turns a link's callbacks into "wait for the next text". */
class Inbox {
  constructor(link) {
    this.link = link;
    this.queue = [];
    this.waiters = [];
    this.closed = null;
    this.sink = null;
    link.onmessage = (t) => {
      if (this.sink) return this.sink(t);
      const w = this.waiters.shift();
      if (w) w.resolve(t);
      else this.queue.push(t);
    };
    link.onclose = (r) => {
      this.closed = r || 'closed';
      for (const w of this.waiters.splice(0)) w.reject(new PhoneHandshakeError('closed', 'the connection closed'));
      this.onclose?.(this.closed);
    };
  }

  next(ms = HS_MS) {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    if (this.closed) return Promise.reject(new PhoneHandshakeError('closed', 'the connection closed'));
    return new Promise((resolve, reject) => {
      const w = { resolve: (t) => { clearTimeout(timer); resolve(t); }, reject: (e) => { clearTimeout(timer); reject(e); } };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w);
        reject(new PhoneHandshakeError('timeout', 'the computer did not answer'));
      }, ms);
      this.waiters.push(w);
    });
  }

  /** From now on every text goes to fn, starting with what is already queued. */
  drain(fn) {
    this.sink = fn;
    for (const t of this.queue.splice(0)) fn(t);
  }
}

export class PhoneClient extends Emitter {
  /** @param {{ identity: { alg, publicRaw, sign }, deviceId: string, name?: string, now?: () => number }} o */
  constructor(o) {
    super();
    this.identity = o.identity;
    this.deviceId = o.deviceId;
    this.name = o.name;
    this.now = o.now || (() => Date.now());
    this.session = null;
    this.pending = new Map();
    this.accepted = false;
    this.grants = [];
  }

  /**
   * Pairs over a fresh link with a scanned invite { topicId, psk, pin }. Resolves once the six words are
   * known; result.decision resolves with the desktop's answer. Keep result.reconnect and result.host.key
   * after an accept: they let the phone come back without a QR code.
   */
  async pair(link, invite) {
    const inbox = new Inbox(link);
    const g = new PairGuest({ identity: this.identity, invite, name: this.name });
    let r;
    try {
      link.send(await g.start());
      ({ m3: g.m3, result: r } = await g.onM2(await inbox.next()));
    } catch (err) {
      try { if (err.code !== 'closed') link.send(failMessage(err.code || 'failed')); } catch { /* gone */ }
      link.close?.('handshake failed');
      throw err;
    }
    link.send(g.m3);
    this._open(link, inbox, r);
    // Key confirmation: the desktop's first frame (a ping) has to open, or it refused our ph.3.
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => done(new PhoneHandshakeError('timeout', 'the computer did not answer')), HS_MS);
      const offC = this.session.on('confirmed', () => done());
      const offF = this.session.on('hsfail', (code) => done(new PhoneHandshakeError(code, 'the computer ended the handshake')));
      const offX = this.session.on('close', (why) => done(new PhoneHandshakeError('closed', String(why))));
      const done = (err) => { clearTimeout(t); offC(); offF(); offX(); if (err) reject(err); else resolve(); };
      if (this.session.confirmed) done();
    });
    const sas = { sas: r.sas, host: r.host };
    this.emit('sas', sas);
    const decision = new Promise((resolve) => { this._decide = resolve; });
    return { ...sas, reconnect: r.reconnect, sessionId: r.sessionId, decision };
  }

  /** Reconnects a paired phone: host { key, pin } and the reconnect secret it kept. Resolves on the welcome. */
  async reconnect(link, { host, reconnect }) {
    const inbox = new Inbox(link);
    const g = new KnownGuest({ identity: this.identity, deviceId: this.deviceId, host, reconnect });
    let r;
    try {
      link.send(await g.start());
      r = await g.onM2(await inbox.next());
    } catch (err) {
      try { if (err.code !== 'closed') link.send(failMessage(err.code || 'failed')); } catch { /* gone */ }
      link.close?.('handshake failed');
      throw err;
    }
    this._open(link, inbox, r, false);
    this.session.send('ping', {});
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => done(new PhoneHandshakeError('timeout', 'the computer did not answer')), HS_MS);
      const offW = this.on('welcome', (w) => done(null, w));
      const offX = this.session.on('close', (why) => done(new PhoneHandshakeError(/revoked/.test(why) ? 'unknown_phone' : 'closed', String(why))));
      const done = (err, w) => { clearTimeout(t); offW(); offX(); if (err) reject(err); else resolve(w); };
    });
  }

  _open(link, inbox, r, confirmed = false) {
    const s = new FrameSession({ id: r.sessionId, side: 'phone', sendKey: r.sendKey, recvKey: r.recvKey, write: (t) => link.send(t), now: this.now, confirmed });
    this.session = s;
    this.link = link;
    inbox.drain((t) => s.receive(t));
    inbox.onclose = (why) => s._closed(why || 'the connection closed');
    s.on('message', (m) => this._message(m));
    s.on('close', (why) => this._closed(why));
    this.pinger = setInterval(() => {
      if (s.state !== 'open') return;
      if (this.now() - s.lastIn > SILENCE_MS) return s.close('no answer');
      try { s.send('ping', {}); } catch { /* closing */ }
    }, PING_MS);
  }

  _message(m) {
    switch (m.t) {
      case 'ping': return this.session.send('pong', {}, { re: m.id });
      case 'pong': return undefined;
      case 'pair.accept':
        this.accepted = true;
        this.grants = Array.isArray(m.body.grants) ? m.body.grants.map(String) : [];
        this.deviceId = typeof m.body.deviceId === 'string' ? m.body.deviceId : this.deviceId;
        this._decide?.({ accepted: true, grants: this.grants, host: m.body.host });
        this.emit('paired', { deviceId: this.deviceId, grants: this.grants, host: m.body.host });
        return undefined;
      case 'pair.refuse':
        this._decide?.({ accepted: false, reason: m.body.reason });
        this.emit('refused', m.body.reason);
        return undefined;
      case 'welcome':
        this.accepted = true;
        this.grants = Array.isArray(m.body.grants) ? m.body.grants.map(String) : [];
        this.welcome = m.body;
        return this.emit('welcome', m.body);
      case 'grants':
        this.grants = Array.isArray(m.body.grants) ? m.body.grants.map(String) : [];
        return this.emit('grants', this.grants);
      case 'state': return this.emit('state', m.body);
      case 'feed': return this.emit('feed', Array.isArray(m.body.items) ? m.body.items : []);
      case 'notice': return this.emit('notice', m.body);
      case 'cmd.re': {
        const p = this.pending.get(m.re);
        if (!p) return undefined;
        this.pending.delete(m.re);
        clearTimeout(p.timer);
        if (m.body.ok) p.resolve(m.body.result);
        else p.reject(Object.assign(new Error(m.body.error?.message || 'refused'), { code: m.body.error?.code || 'failed', grant: m.body.error?.grant }));
        return undefined;
      }
      case 'error': {
        const p = m.re && this.pending.get(m.re);
        if (p) {
          this.pending.delete(m.re);
          clearTimeout(p.timer);
          p.reject(Object.assign(new Error(m.body.message || m.body.code), { code: m.body.code }));
        }
        return this.emit('remote', m);
      }
      default:
        return this.emit('remote', m);
    }
  }

  /** Runs a command on the desktop. Rejects with err.code (not_granted, rate_limited, bad_request, ...). */
  cmd(op, a = {}) {
    if (!this.session || this.session.state !== 'open') return Promise.reject(Object.assign(new Error('not connected'), { code: 'offline' }));
    const id = this.session.send('cmd', { op, a });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error('the computer did not answer'), { code: 'timeout' }));
      }, CMD_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  /** Sends a remote desktop message (cap.request, remote.*). Returns false when not connected. */
  send(type, body) {
    if (!this.session || this.session.state !== 'open') return false;
    try {
      this.session.send(type, body);
      return true;
    } catch {
      return false;
    }
  }

  get connected() {
    return !!this.session && this.session.state === 'open' && this.accepted;
  }

  _closed(why) {
    clearInterval(this.pinger);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(Object.assign(new Error('the connection closed'), { code: 'offline' }));
    }
    this.pending.clear();
    this._decide?.({ accepted: false, reason: String(why) });
    this._decide = null;
    try { this.link?.close?.(String(why)); } catch { /* gone */ }
    this.emit('close', String(why));
  }

  close(reason = 'closed') {
    this.session?.close(reason);
  }
}

export { parseHs, PhoneHandshakeError };
