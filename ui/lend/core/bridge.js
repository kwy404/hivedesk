// The two bridges between a local hivedesk (over its WebSocket, PROTOCOL.md section 6) and a
// LendPeer (the WebRTC data channel to the other person).
//
//   HostBridge    on the host: attaches the friend as a remote brain (brain.attach), carries every
//                 brain.request to the friend as a req frame and answers with brain.respond.
//   LenderBridge  on the friend: checks, rate limits and logs every req frame, runs it on the
//                 friend's own brain (lend.chat, which the friend's server checks again, or the
//                 engine's brain.chat) and sends the answer back. stop() ends it.
//
// hive is { command(type, data) => Promise<result>, notify(type, data), on(kind, fn) => off }.
// Both bridges are plain objects with no DOM, so they are tested with fakes.

import { Emitter } from './emitter.js';
import { FrameError, LEND_PROTOCOL, LIMITS, promptChars, readResult } from './frames.js';
import { RateLimiter, DEFAULT_RATE } from './ratelimit.js';

export class HostBridge extends Emitter {
  /** guestId: the Code together guest who lends (its building in the city may then use this brain). */
  constructor({ hive, peer, label = 'host', guestId = null }) {
    super();
    this.hive = hive;
    this.peer = peer;
    this.label = label;
    this.guestId = guestId;
    this.brainId = null;
    this.pending = new Map(); // requestId -> { at, chars }
    this.offs = [];
    this.closed = false;
    peer.on('frame', (f) => this._frame(f));
    peer.on('ready', () => this._attach());
    peer.on('close', (reason) => this._detach(reason));
    peer.on('rejected', (err) => this.emit('log', { kind: 'rejected', code: err.code, message: err.message }));
    peer.send({ t: 'hello', v: LEND_PROTOCOL, role: 'host', label });
    if (peer.ready) this._attach();
  }

  get friend() {
    return this.peer.remoteHello;
  }

  async _attach() {
    if (this.brainId || this.closed || this.attaching) return;
    this.attaching = true;
    const hello = this.peer.remoteHello || {};
    try {
      const res = await this.hive.command('brain.attach', { label: `${hello.label || 'friend'} (lent PC)`, model: hello.model, ctx: hello.ctx, ...(this.guestId ? { guest: this.guestId } : {}) });
      this.brainId = res.brainId;
      this.offs.push(this.hive.on('brain.request', (m) => m.brainId === this.brainId && this._request(m)));
      this.offs.push(this.hive.on('brain.cancel', (m) => m.brainId === this.brainId && this._cancel(m.requestId)));
      this.emit('attached', this.brainId);
    } catch (err) {
      this.emit('error', err);
    } finally {
      this.attaching = false;
    }
  }

  _request({ requestId, messages, options }) {
    try {
      this.peer.send({ t: 'req', id: requestId, messages, options });
      const chars = promptChars(messages);
      this.pending.set(requestId, { at: Date.now(), chars });
      this.emit('log', { kind: 'sent', id: requestId, chars, messages: messages.length });
    } catch (err) {
      const message = err instanceof FrameError ? err.message : 'Could not send the request to the friend';
      this.hive.command('brain.respond', { requestId, ok: false, error: message }).catch(() => {});
      this.emit('log', { kind: 'refused', id: requestId, message });
    }
  }

  _cancel(requestId) {
    if (!this.pending.delete(requestId)) return;
    try {
      this.peer.send({ t: 'cancel', id: requestId });
    } catch {
      // closed already
    }
  }

  _frame(f) {
    if (f.t === 'tok' && this.pending.has(f.id)) {
      this.hive.notify('brain.token', { requestId: f.id, text: f.text });
    } else if (f.t === 'res' && this.pending.has(f.id)) {
      this.pending.delete(f.id);
      const body = f.ok ? { requestId: f.id, ok: true, result: f.result } : { requestId: f.id, ok: false, error: `${f.error.code}: ${f.error.message}` };
      this.hive.command('brain.respond', body).catch(() => {});
      this.emit('log', f.ok ? { kind: 'answered', id: f.id, tokens: f.result.completionTokens, ms: f.result.ms } : { kind: 'failed', id: f.id, message: f.error.message });
    }
  }

  async _detach(reason) {
    if (this.closed) return;
    this.closed = true;
    for (const off of this.offs) off();
    for (const requestId of this.pending.keys()) this.hive.command('brain.respond', { requestId, ok: false, error: 'The friend stopped lending' }).catch(() => {});
    this.pending.clear();
    if (this.brainId) await this.hive.command('brain.detach', { brainId: this.brainId }).catch(() => {});
    this.emit('detached', reason);
  }

  /** The host stops borrowing. */
  stop(reason = 'The host stopped borrowing') {
    this.peer.stop(reason);
  }
}

export class LenderBridge extends Emitter {
  /**
   * info: { label, model?, ctx? } shown to the host. rate: { perMinute, charsPerMinute }.
   *   events: 'log' (entry), 'stopped' (reason)
   */
  constructor({ hive, peer, info = {}, rate = DEFAULT_RATE, limits = LIMITS, now = () => Date.now(), chatCommand = 'lend.chat' }) {
    super();
    this.hive = hive;
    this.chatCommand = chatCommand; // lend.chat (guarded by src/lend) or the engine's brain.chat
    this.peer = peer;
    this.limits = limits;
    this.now = now;
    this.limiter = new RateLimiter({ ...rate, now });
    this.lending = true;
    this.busy = null;
    this.served = 0;
    this.log = [];
    peer.on('frame', (f) => this._frame(f));
    peer.on('close', (reason) => this._stopped(reason));
    peer.on('rejected', (err) => this._entry({ id: '-', status: 'refused', reason: err.code, message: err.message }));
    peer.send({
      t: 'hello',
      v: LEND_PROTOCOL,
      role: 'lender',
      label: info.label || 'friend',
      model: info.model,
      ctx: info.ctx,
      limits: { perMinute: this.limiter.perMinute, promptChars: limits.promptChars, maxTokens: limits.maxTokens },
    });
  }

  _entry(e) {
    const entry = { at: this.now(), ...e };
    this.log.push(entry);
    if (this.log.length > 500) this.log.shift();
    this.emit('log', entry);
    this.hive.command('lend.log', entry).catch(() => {});
    return entry;
  }

  _refuse(id, code, message, extra = {}) {
    this._entry({ id, status: 'refused', reason: code, message, ...extra });
    try {
      this.peer.send({ t: 'res', id, ok: false, error: { code, message } });
    } catch {
      // closed
    }
  }

  async _frame(f) {
    if (f.t === 'cancel') {
      if (this.busy?.id === f.id) {
        this.busy.cancelled = true;
        this._abort(f.id);
      }
      return;
    }
    if (f.t !== 'req') return;
    const chars = promptChars(f.messages);
    const base = { messages: f.messages.length, chars, maxTokens: f.options.maxTokens ?? null, schema: !!f.options.schema };
    if (!this.lending) return this._refuse(f.id, 'stopped', 'Lending is stopped', base);
    if (this.busy) return this._refuse(f.id, 'busy', 'One request at a time', base);
    const gate = this.limiter.take(chars);
    if (!gate.ok) return this._refuse(f.id, 'rate_limited', `Too many ${gate.reason === 'chars' ? 'characters' : 'requests'} this minute, retry in ${Math.ceil(gate.retryInMs / 1000)} s`, base);

    const job = { id: f.id, cancelled: false };
    this.busy = job;
    const entry = this._entry({ id: f.id, status: 'running', ...base, preview: f.messages[f.messages.length - 1].content.slice(0, 160) });
    const started = this.now();
    try {
      const raw = await this.hive.command(this.chatCommand, { messages: f.messages, options: f.options, requestId: f.id });
      const result = readResult(raw, this.limits);
      if (job.cancelled || !this.lending) {
        this._entry({ id: f.id, status: 'cancelled', ...base });
        return;
      }
      this.peer.send({ t: 'res', id: f.id, ok: true, result });
      this.served++;
      this._entry({ id: f.id, status: 'done', ...base, completionTokens: result.completionTokens, ms: result.ms || this.now() - started, ref: entry.at });
    } catch (err) {
      const code = err?.code || 'failed';
      const message = String(err?.message || err).slice(0, 300);
      this._entry({ id: f.id, status: 'failed', ...base, reason: code, message });
      try {
        this.peer.send({ t: 'res', id: f.id, ok: false, error: { code, message } });
      } catch {
        // closed
      }
    } finally {
      if (this.busy === job) this.busy = null;
    }
  }

  /** Stops the model on this PC for a cancelled request (the engine aborts the running turn). */
  _abort(id) {
    this.hive.command('lend.cancel', { requestId: id }).catch(() => {});
  }

  /** The friend stops lending: refuses anything new, tells the host and closes the link. */
  stop(reason = 'The friend stopped lending') {
    if (!this.lending) return;
    if (this.busy) {
      this.busy.cancelled = true;
      this._abort(this.busy.id);
    }
    this.peer.stop(reason);
    this._stopped(reason);
  }

  _stopped(reason) {
    if (!this.lending) return;
    this.lending = false;
    this._entry({ id: '-', status: 'stopped', message: reason });
    this.emit('stopped', reason);
  }
}
