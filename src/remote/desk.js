// Remote desktop between peers (docs/1.0/PLAN.md section 12), the engine side of both roles:
//   host    the person whose screen is seen; grants by click, enforces every rule, holds the kill switch
//   viewer  the person who asks and watches; forwards its window's input, never trusted by the host
// The media (WebRTC video tracks, one per shared screen) runs between the two windows; this module only
// carries its signaling inside the encrypted session (stream 3) and decides whether it may flow.
// Everything goes into the audit log of the p2p port: requests, answers, grants, start, stop, pause,
// expiry, revoke, lock changes, control bursts (counts, never keys), chat (sizes), screen requests.
// Clipboard sync is src/remote/clipsync.js, files are src/remote/transfer.js.

import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { assertPort } from './port.js';
import { KEYS, KeyFilter } from './keys.js';
import {
  CAP_VIEW, CAP_CONTROL, CAP_CLIP, CAP_FILE, DEFAULT_MINUTES, MAX_EVENTS_PER_MESSAGE, MAX_EVENTS_PER_SECOND,
  LOCK_FRESH_MS, BURST_MS, HOTKEY, REQUEST_MS, QUALITY, CLIP_DIRS, decideAnswer, grantLive, normalizeEvent, Bucket, pickDisplay, toPixels
} from './policy.js';

const MAX_PENDING = 4;
/** Dialogs a caller may open on the host: per peer and in all, per window (a published address must not spam the host). */
export const ASK_LIMITS = Object.freeze({ perPeer: 3, perPeerMs: 120_000, all: 10, allMs: 60_000, afterDeclineMs: 30_000 });
const MAX_SDP = 32 * 1024;
const MAX_ICE = 1024;
const MAX_ICE_PER_SHARE = 256;
const MAX_TRACKS = 4;
const MAX_CHAT = 2000;
const KEEP_CHAT = 200;
const SURFACES = new Set(['monitor', 'window', 'browser']);

export class RemoteError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const rid = (p) => `${p}_${crypto.randomBytes(6).toString('hex')}`;

/**
 * @param {{
 *   p2p: import('./port.js').P2PPort,
 *   support: ReturnType<import('./helper.js').helperSupport>,
 *   startHelper?: (support: object) => any,
 *   unattended?: import('./unattended.js').Unattended,
 *   addressOf?: (peerId: string) => string | null,      the 10 digit address of a peer, for the dialog
 *   now?: () => number, setTimeout?: Function, clearTimeout?: Function,
 *   lockFreshMs?: number, burstMs?: number, requestMs?: number
 * }} o
 */
export class RemoteDesk extends EventEmitter {
  constructor(o) {
    super();
    this.p2p = assertPort(o.p2p);
    this.support = o.support;
    this.startHelperFn = o.startHelper || (() => null);
    this.unattended = o.unattended || null;
    this.addressOf = o.addressOf || (() => null);
    this.now = o.now || (() => Date.now());
    this.setTimeout = o.setTimeout || setTimeout;
    this.clearTimeout = o.clearTimeout || clearTimeout;
    this.lockFreshMs = o.lockFreshMs ?? LOCK_FRESH_MS;
    this.burstMs = o.burstMs ?? BURST_MS;
    this.requestMs = o.requestMs ?? REQUEST_MS;
    /** @type {Map<string, any>} */
    this.requests = new Map();
    /** @type {Map<string, any>} host side, by session id (or "agent:<id>") */
    this.shares = new Map();
    /** @type {Map<string, any>} viewer side, by session id */
    this.views = new Map();
    this.chats = new Map();
    this.helper = null;
    this.helperInfo = null;
    this.helperUsers = new Set();
    this.lock = { locked: null, at: 0, source: 'none' };
    this.timers = new Map();
    this.offs = [
      this.p2p.caps.onRequest((s, r) => this._onCapRequest(s, r)),
      this.p2p.caps.onChange((c) => this._onCapChange(c)),
      this.p2p.onSession((ev, s) => { if (ev === 'close') this._onSessionClosed(s); }),
      this.p2p.onMessage('remote.', (s, m) => this._onMessage(s, m))
    ];
  }

  // ---------- shared ----------

  audit(kind, data = {}) {
    try { return this.p2p.audit.append({ at: new Date(this.now()).toISOString(), ...data, kind }); } catch { return null; }
  }

  _changed() { this.emit('state', this.snapshot()); }

  _timer(key, ms, fn) {
    this._untimer(key);
    const t = this.setTimeout(() => { this.timers.delete(key); fn(); }, Math.max(0, ms));
    t?.unref?.();
    this.timers.set(key, t);
  }

  _untimer(key) {
    if (this.timers.has(key)) { this.clearTimeout(this.timers.get(key)); this.timers.delete(key); }
  }

  /** True when the local screen is known to be unlocked right now (fresh helper report). */
  unlocked() { return this.lock.locked === false && this.now() - this.lock.at <= this.lockFreshMs; }

  /** What the windows show: requests to answer, active shares, viewer sessions, support and lock. */
  snapshot() {
    const now = this.now();
    return {
      support: { ...this.support, hotkey: this.support.hotkey && (this.helperInfo ? this.helperInfo.hotkey : true), hotkeyKeys: HOTKEY },
      helper: this.helper ? (this.helperInfo ? 'ready' : 'starting') : 'off',
      lock: { locked: this.lock.locked, fresh: now - this.lock.at <= this.lockFreshMs, source: this.lock.source },
      displays: this.helperInfo?.displays || [],
      requests: [...this.requests.values()].map((r) => ({ ...r, timer: undefined, msLeft: Math.max(0, r.at + this.requestMs - now) })),
      shares: [...this.shares.values()].map((s) => {
        const ready = this._controlReady(s, now);
        return {
          sessionId: s.sessionId, peerId: s.peerId, name: s.name, address: s.address, agentId: s.agentId || null, mode: s.mode,
          expiresAt: s.expiresAt, startedAt: s.startedAt, sharing: s.tracks.length > 0, paused: s.paused, via: s.via,
          tracks: s.tracks.map((t) => ({ surface: t.surface, display: t.display })), clipboard: s.clipboard, files: s.files,
          quality: s.quality, screenAsk: s.screenAsk, controlReady: ready.ok, controlReason: ready.reason
        };
      }),
      views: [...this.views.values()].map((v) => ({ ...v, bucket: undefined }))
    };
  }

  _session(sessionId) {
    const s = this.p2p.session(sessionId);
    if (!s || s.state === 'closed') throw new RemoteError('not_found', 'no open session with that peer');
    return s;
  }

  _peerView(peerId) {
    const p = this.p2p.peer(peerId) || {};
    return { name: String(p.name || 'Unknown peer').slice(0, 40), words: Array.isArray(p.words) ? p.words.slice(0, 6).map(String) : [], trust: p.trust || 'unknown' };
  }

  // ---------- host: requests and answers ----------

  _onCapRequest(session, req) {
    const name = req?.capability?.name;
    if (name !== CAP_VIEW && name !== CAP_CONTROL) return;
    const lim = req.capability.limits || {};
    const wants = name === CAP_CONTROL ? 'control' : 'view';
    const asks = { view: true, control: wants === 'control', clipboard: lim.clipboard === true, files: lim.files === true };
    for (const [id, r] of this.requests) if (r.sessionId === session.id) this._dropRequest(id);
    const limited = this._askLimited(session.peerId);
    if (limited) {
      this.audit('remote.request.dropped', { peerId: session.peerId, wants, reason: limited });
      this.p2p.send(session.id, 1, 'remote.refused', { reason: 'busy' });
      return;
    }
    if (this.requests.size >= MAX_PENDING) {
      this.audit('remote.request.dropped', { peerId: session.peerId, wants, reason: 'too_many_pending' });
      this.p2p.send(session.id, 1, 'remote.refused', { reason: 'busy' });
      return;
    }
    const { name: peerName, words } = this._peerView(session.peerId);
    const r = {
      id: rid('rq'), sessionId: session.id, peerId: session.peerId, name: peerName, words, address: this.addressOf(session.peerId),
      wants, asks, reason: String(req.reason || '').slice(0, 200), at: this.now()
    };
    this.requests.set(r.id, r);
    // No answer in time counts as Decline.
    this._timer(`rq:${r.id}`, this.requestMs, () => {
      if (!this.requests.has(r.id)) return;
      this.requests.delete(r.id);
      this.audit('remote.request.expired', { peerId: r.peerId, requestId: r.id });
      this.p2p.send(r.sessionId, 1, 'remote.refused', { reason: 'timeout' });
      this._changed();
    });
    this.audit('remote.request', { peerId: r.peerId, wants, asks, requestId: r.id });
    this._changed();
  }

  /** Why a new dialog for this peer is refused now, or null (ASK_LIMITS). Counts the asks it lets through. */
  _askLimited(peerId) {
    const now = this.now();
    this.asks ??= new Map();
    this.asksAll = (this.asksAll || []).filter((t) => now - t < ASK_LIMITS.allMs);
    const mine = (this.asks.get(peerId) || []).filter((t) => now - t < ASK_LIMITS.perPeerMs);
    const declined = this.declinedAt?.get(peerId);
    let why = null;
    if (declined && now - declined < ASK_LIMITS.afterDeclineMs) why = 'declined_recently';
    else if (mine.length >= ASK_LIMITS.perPeer) why = 'too_many_from_peer';
    else if (this.asksAll.length >= ASK_LIMITS.all) why = 'too_many';
    if (!why) { mine.push(now); this.asksAll.push(now); }
    this.asks.set(peerId, mine);
    return why;
  }

  _dropRequest(id) {
    this.requests.delete(id);
    this._untimer(`rq:${id}`);
  }

  /** A local agent asks to see the screen (PLAN 12.1: view only, explicit host permission). Control is refused outright. */
  agentRequest(agentId, { wants = 'view', name = agentId, reason = '' } = {}) {
    const id = String(agentId || '').slice(0, 64);
    if (!id) throw new RemoteError('bad_request', 'agentId is required');
    if (wants !== 'view') {
      this.audit('remote.refuse', { agentId: id, wants, reason: 'agents_view_only' });
      throw new RemoteError('forbidden', 'agents may only view the screen, never control it');
    }
    const sessionId = `agent:${id}`;
    for (const [rq, r] of this.requests) if (r.sessionId === sessionId) this._dropRequest(rq);
    const r = { id: rid('rq'), sessionId, peerId: this.p2p.localPeerId, agentId: id, name: String(name).slice(0, 40), words: [], address: null, wants: 'view', asks: { view: true }, reason: String(reason).slice(0, 200), at: this.now() };
    this.requests.set(r.id, r);
    this._timer(`rq:${r.id}`, this.requestMs, () => { if (this.requests.delete(r.id)) { this.audit('remote.request.expired', { agentId: id }); this._changed(); } });
    this.audit('remote.request', { agentId: id, wants: 'view', requestId: r.id });
    this._changed();
    return { requestId: r.id };
  }

  /** The host's click in the dialog. Only the local person reaches this (the command is refused for peers). */
  answer(requestId, answer = {}) {
    const r = this.requests.get(String(requestId));
    if (!r) throw new RemoteError('not_found', 'that request is no longer waiting');
    this._dropRequest(r.id);
    const d = decideAnswer(r, answer);
    // An accepted ask is not spam: the counter of that peer starts again.
    if (d.allow) this.asks?.delete(r.peerId);
    if (!d.allow) {
      this.audit('remote.refuse', { peerId: r.agentId ? undefined : r.peerId, agentId: r.agentId, wants: r.wants, requestId: r.id });
      if (!r.agentId) {
        this.p2p.send(r.sessionId, 1, 'remote.refused', { reason: 'declined' });
        (this.declinedAt ??= new Map()).set(r.peerId, this.now());
      }
      this._changed();
      return { allowed: false };
    }
    return this._grant(r, d, 'accept');
  }

  _grant(r, d, via) {
    const now = this.now();
    const expiresAt = now + d.minutes * 60_000;
    const iso = new Date(expiresAt).toISOString();
    const grantIds = [];
    if (!r.agentId) {
      this._session(r.sessionId);
      const mk = (name, limits = {}) => {
        const g = this.p2p.caps.grant(r.peerId, { name, limits: { minutes: d.minutes, ...limits } }, { expiresAt: iso, scope: 'session', sessionId: r.sessionId });
        if (!g?.id) throw new RemoteError('internal', 'the grant was not recorded');
        grantIds.push(g.id);
      };
      mk(d.mode === 'control' ? CAP_CONTROL : CAP_VIEW);
      if (d.clipboard !== 'off') mk(CAP_CLIP, { dir: d.clipboard });
      if (d.files) mk(CAP_FILE);
    }
    const old = this.shares.get(r.sessionId);
    if (old) this._endShare(old, 'replaced', { notify: false });
    const share = {
      sessionId: r.sessionId, peerId: r.peerId, name: r.name, address: r.address || null, agentId: r.agentId, grantIds, mode: d.mode, via,
      expiresAt, startedAt: now, tracks: [], paused: false, clipboard: d.clipboard, files: d.files, quality: 'auto', screenAsk: null,
      ice: 0, cur: 0, keys: new KeyFilter(), bucket: new Bucket(MAX_EVENTS_PER_SECOND, this.now), burst: null
    };
    this.shares.set(r.sessionId, share);
    this._timer(`exp:${share.sessionId}`, expiresAt - now, () => { if (this.shares.get(share.sessionId) === share) this._endShare(share, 'expired'); });
    this.audit('remote.grant', {
      peerId: r.agentId ? undefined : r.peerId, agentId: r.agentId, via, mode: d.mode, minutes: d.minutes,
      expiresAt: iso, clipboard: d.clipboard, files: d.files, grantIds
    });
    this.useHelper(`share:${share.sessionId}`);
    if (!r.agentId) {
      const ready = this._controlReady(share, now);
      this.p2p.send(r.sessionId, 1, 'remote.ready', {
        mode: d.mode, expiresAt, clipboard: d.clipboard, files: d.files, control: ready.ok, reason: ready.reason, via,
        displays: this._displayList()
      });
    }
    this._changed();
    return { allowed: true, mode: d.mode, expiresAt, grantIds, clipboard: d.clipboard, files: d.files };
  }

  _displayList() { return (this.helperInfo?.displays || []).map((x) => ({ w: x.w, h: x.h, primary: x.primary })); }

  /** True while a local agent may receive still frames of the screen. No frame pipeline exists yet: no shipped model reads images. */
  agentMayView(agentId) {
    const s = this.shares.get(`agent:${agentId}`);
    return !!s && this.now() < s.expiresAt;
  }

  // ---------- host: capture, screens, pause, signaling ----------

  /** The host window captures a screen as track `index`. Control needs a whole screen (a window cannot be mapped to input). */
  shareStarted(sessionId, { surface, width, height, index = 0 } = {}) {
    const s = this._liveShare(sessionId);
    const i = Number.isInteger(index) && index >= 0 && index < MAX_TRACKS ? index : 0;
    const t = { surface: SURFACES.has(surface) ? surface : 'unknown', width: Number(width) || 0, height: Number(height) || 0, display: null };
    if (t.surface === 'monitor') t.display = pickDisplay(this.helperInfo?.displays, t.width, t.height);
    s.tracks[i] = t;
    s.tracks = s.tracks.filter(Boolean);
    s.screenAsk = null;
    this.audit('remote.start', { peerId: s.agentId ? undefined : s.peerId, agentId: s.agentId, surface: t.surface, track: i, mode: s.mode });
    this._tellState(s);
    this._changed();
    return { display: t.display };
  }

  /** The host stopped one shared screen. */
  shareRemoved(sessionId, index) {
    const s = this._liveShare(sessionId);
    if (!s.tracks[index]) throw new RemoteError('not_found', 'no such shared screen');
    s.tracks.splice(index, 1);
    this.audit('remote.screen.removed', { peerId: s.peerId, track: index });
    this._tellState(s);
    this._changed();
    return {};
  }

  /** The host picks which screen a shared track is, when the sizes do not tell. */
  setDisplay(sessionId, index, track = 0) {
    const s = this._liveShare(sessionId);
    const displays = this.helperInfo?.displays || [];
    if (!Number.isInteger(index) || index < 0 || index >= displays.length) throw new RemoteError('bad_request', 'no such display');
    const t = s.tracks[track];
    if (!t) throw new RemoteError('not_found', 'no such shared screen');
    if (t.surface !== 'monitor') throw new RemoteError('conflict', 'control needs a whole screen to be shared, not a window');
    t.display = index;
    this.audit('remote.display', { peerId: s.peerId, display: index, track });
    this._tellState(s);
    this._changed();
    return {};
  }

  /** Pauses a share: no input, no clipboard, and the host window stops the video, until resumed. */
  pause(sessionId, on) {
    const s = this._liveShare(sessionId);
    s.paused = on === true;
    if (s.paused) { s.keys.release(); this.helper?.release(); }
    this.audit(s.paused ? 'remote.pause' : 'remote.resume', { peerId: s.peerId });
    this._tellState(s);
    this._changed();
    return { paused: s.paused };
  }

  /** Signaling from the local window to the remote one: { kind: 'offer' | 'answer' | 'ice', sdp?, candidate? }. */
  signal(sessionId, sig = {}) {
    const share = this.shares.get(sessionId);
    const view = this.views.get(sessionId);
    if (share) this._liveShare(sessionId);
    else if (!view || view.state !== 'granted') throw new RemoteError('forbidden', 'no remote desktop session with that peer');
    if (share?.agentId) throw new RemoteError('bad_request', 'an agent has no window to signal');
    const body = cleanSignal(sig);
    if (!body) throw new RemoteError('bad_request', 'bad signaling message');
    if (body.kind === 'ice' && share && ++share.ice > MAX_ICE_PER_SHARE) throw new RemoteError('rate_limited', 'too many ICE candidates');
    if (!this.p2p.send(sessionId, 3, body.kind === 'ice' ? 'remote.ice' : 'remote.sdp', body)) throw new RemoteError('not_found', 'the session closed');
    return {};
  }

  // ---------- host: input ----------

  _track(s, i) {
    const t = s.tracks[i];
    if (!t) return { ok: false, reason: s.tracks.length ? 'no_track' : 'not_sharing' };
    if (t.surface !== 'monitor') return { ok: false, reason: 'window_shared' };
    if (t.display == null) return { ok: false, reason: 'pick_display' };
    return { ok: true, t };
  }

  _controlReady(s, now = this.now()) {
    if (s.agentId) return { ok: false, reason: 'agent' };
    if (s.mode !== 'control') return { ok: false, reason: 'view_only' };
    if (!this.support.control) return { ok: false, reason: this.support.reason || 'no_helper' };
    if (now >= s.expiresAt) return { ok: false, reason: 'expired' };
    if (s.paused) return { ok: false, reason: 'paused' };
    if (!this.helper || !this.helperInfo) return { ok: false, reason: 'helper_starting' };
    if (this.lock.locked !== false || now - this.lock.at > this.lockFreshMs) return { ok: false, reason: this.lock.locked === true ? 'locked' : 'lock_unknown' };
    const t = this._track(s, 0);
    if (!t.ok) return { ok: false, reason: t.reason };
    return { ok: true, reason: null };
  }

  /**
   * remote.input from a viewer. Every check runs here, in the host engine, for every message:
   * share and peer match, live control grant, expiry, pause, helper, lock, surface, rate, key allowlist.
   * @returns {{ applied: number, dropped: number, reason: string | null }}
   */
  handleInput(session, body) {
    const now = this.now();
    const events = Array.isArray(body?.events) ? body.events.slice(0, MAX_EVENTS_PER_MESSAGE) : [];
    const total = Array.isArray(body?.events) ? body.events.length : 0;
    const s = this.shares.get(session.id);
    const refuse = (reason) => {
      if (s) this._count(s, { dropped: total, reason });
      else this._strayInput(session, total, reason);
      return { applied: 0, dropped: total, reason };
    };
    if (!s || s.agentId) return refuse('no_share');
    if (s.peerId !== session.peerId) return refuse('wrong_peer');
    const grant = this.p2p.caps.find(session.peerId, CAP_CONTROL);
    if (!grantLive(grant, now) || !s.grantIds.includes(grant.id)) return refuse('not_granted');
    if (now >= s.expiresAt) { this._endShare(s, 'expired'); return refuse('expired'); }
    const ready = this._controlReady(s, now);
    if (!ready.ok) return refuse(ready.reason);
    let applied = 0;
    let dropped = total - events.length;
    let pointer = 0;
    let keys = 0;
    for (const raw of events) {
      const e = normalizeEvent(raw);
      if (!e) { dropped++; continue; }
      if (!s.bucket.take()) { dropped++; continue; }
      if (e.k === 'key') {
        if (s.keys.check(e.code, e.down) !== 'ok') { dropped++; continue; }
        this.helper.key(KEYS[e.code], e.down);
        keys++;
        applied++;
        continue;
      }
      if (e.k === 'move') s.cur = e.d || 0;
      const tr = this._track(s, s.cur);
      const d = tr.ok ? this.helperInfo.displays[tr.t.display] : null;
      if (!d) { dropped++; continue; }
      if (e.k === 'move') {
        const { px, py } = toPixels(d, e.x, e.y);
        this.helper.move(px, py);
      } else if (e.k === 'btn') this.helper.button(e.b, e.down);
      else this.helper.wheel(e.dx, e.dy);
      pointer++;
      applied++;
    }
    this._count(s, { applied, dropped, pointer, keys, reason: dropped ? 'filtered' : null });
    return { applied, dropped, reason: dropped ? 'filtered' : null };
  }

  _strayInput(session, n, reason) {
    const key = `stray:${session.peerId}`;
    if (this.timers.has(key)) return;
    this.audit('remote.input.refused', { peerId: session.peerId, events: n, reason });
    this._timer(key, this.burstMs, () => {});
  }

  /** Control bursts go into the audit log as counts, one line per burst window. */
  _count(s, { applied = 0, dropped = 0, pointer = 0, keys = 0, reason = null }) {
    if (!s.burst) {
      s.burst = { since: this.now(), applied: 0, dropped: 0, pointer: 0, keys: 0, reasons: {} };
      this._timer(`burst:${s.sessionId}`, this.burstMs, () => this._flushBurst(s));
    }
    const b = s.burst;
    b.applied += applied; b.dropped += dropped; b.pointer += pointer; b.keys += keys;
    if (reason && dropped) b.reasons[reason] = (b.reasons[reason] || 0) + dropped;
  }

  _flushBurst(s) {
    const b = s.burst;
    if (!b) return;
    s.burst = null;
    this._untimer(`burst:${s.sessionId}`);
    if (!b.applied && !b.dropped) return;
    this.audit('remote.control.burst', { peerId: s.peerId, events: b.applied, pointer: b.pointer, keys: b.keys, dropped: b.dropped, reasons: b.reasons, ms: this.now() - b.since });
  }

  // ---------- the native helper, lock, kill switch ----------

  /** Starts the helper for a reason (a share, clipboard sync); it stops when no reason is left. */
  useHelper(reason) {
    this.helperUsers.add(reason);
    if (this.helper || !this.support.kind) return this.helper;
    let h;
    try { h = this.startHelperFn(this.support); } catch (err) {
      this.audit('remote.helper.failed', { reason: String(err.code || err.message).slice(0, 80) });
      return null;
    }
    if (!h) return null;
    this.helper = h;
    this.helperInfo = null;
    h.on('ready', (m) => {
      this.helperInfo = { displays: cleanDisplays(m.displays), hotkey: m.hotkey === true };
      for (const s of this.shares.values()) for (const t of s.tracks) if (t.surface === 'monitor' && t.display == null) t.display = pickDisplay(this.helperInfo.displays, t.width, t.height);
      this._indicator();
      this._tellAll();
      this._changed();
      this.emit('helper', h);
    });
    h.on('lock', (m) => this._onLock(m));
    h.on('hotkey', () => this.stopAll('hotkey'));
    h.on('stop', () => this.stopAll('indicator'));
    h.on('clip', (m) => this.emit('nativeClip', m));
    h.on('exit', () => {
      if (this.helper !== h) return;
      this.helper = null;
      this.helperInfo = null;
      this.lock = { locked: null, at: 0, source: 'none' };
      if (this.shares.size || this.helperUsers.size) this.audit('remote.helper.exit', {});
      this._tellAll();
      this._changed();
    });
    return h;
  }

  /** Lets go of one reason to keep the helper. */
  dropHelper(reason) {
    this.helperUsers.delete(reason);
    if (!this.helperUsers.size) this._stopHelper();
    else this._indicator();
  }

  _onLock(m) {
    const locked = m.locked === true ? true : m.locked === false ? false : null;
    const was = this.lock.locked;
    this.lock = { locked, at: this.now(), source: String(m.source || 'helper').slice(0, 20) };
    if (locked === was) return;
    if (locked !== false) {
      for (const s of this.shares.values()) s.keys.release();
      this.helper?.release();
    }
    if (this.shares.size || this.helperUsers.size) this.audit(locked === true ? 'remote.locked' : locked === false ? 'remote.unlocked' : 'remote.lock.unknown', { source: this.lock.source });
    this.emit('lock', this.lock);
    this._tellAll();
    this._changed();
  }

  _indicator() {
    if (!this.helper) return;
    const list = [...this.shares.values()];
    const clipPeers = [...this.helperUsers].filter((u) => u.startsWith('clip:')).map((u) => this.views.get(u.slice(5))?.name || this.shares.get(u.slice(5))?.name).filter(Boolean);
    if (!list.length && !clipPeers.length) { this.helper.indicator('off'); return; }
    const hot = this.helperInfo?.hotkey ? `  ${HOTKEY} stops` : '';
    if (!list.length) { this.helper.indicator('view', `Clipboard synced with ${[...new Set(clipPeers)].join(', ')}${hot}`.slice(0, 120)); return; }
    const control = list.some((s) => s.mode === 'control');
    const names = [...new Set(list.map((s) => s.name))].join(', ');
    this.helper.indicator(control ? 'control' : 'view', `${control ? 'Remote control' : 'Screen seen'} by ${names}${hot}`.slice(0, 120));
  }

  _tellState(s) {
    if (s.agentId) return;
    const r = this._controlReady(s);
    this.p2p.send(s.sessionId, 1, 'remote.state', {
      locked: this.lock.locked === true, paused: s.paused, control: r.ok, reason: r.reason, expiresAt: s.expiresAt,
      tracks: s.tracks.length, displays: this._displayList()
    });
  }

  _tellAll() { for (const s of this.shares.values()) this._tellState(s); }

  _liveShare(sessionId) {
    const s = this.shares.get(String(sessionId));
    if (!s) throw new RemoteError('not_found', 'no remote desktop session with that id');
    if (this.now() >= s.expiresAt) { this._endShare(s, 'expired'); throw new RemoteError('forbidden', 'the permission expired'); }
    return s;
  }

  /** Ends one host share: revokes its grants, releases held input, tells the viewer, audits. */
  _endShare(s, reason, { notify = true } = {}) {
    if (this.shares.get(s.sessionId) !== s) return;
    this.shares.delete(s.sessionId);
    this._untimer(`exp:${s.sessionId}`);
    this._flushBurst(s);
    s.keys.release();
    this.helper?.release();
    for (const id of s.grantIds) { try { this.p2p.caps.revoke(id, reason); } catch { /* already gone */ } }
    if (notify && !s.agentId) this.p2p.send(s.sessionId, 1, 'remote.stop', { reason });
    const kind = reason === 'expired' ? 'remote.expired' : reason === 'revoked' ? 'remote.revoked' : 'remote.stop';
    this.audit(kind, { peerId: s.agentId ? undefined : s.peerId, agentId: s.agentId, reason, seconds: Math.round((this.now() - s.startedAt) / 1000) });
    this.emit('ended', { sessionId: s.sessionId, reason });
    this.dropHelper(`share:${s.sessionId}`);
    this._changed();
  }

  _stopHelper() {
    if (!this.helper) return;
    const h = this.helper;
    this.helper = null;
    this.helperInfo = null;
    this.lock = { locked: null, at: 0, source: 'none' };
    try { h.indicator('off'); h.close(); } catch { /* gone */ }
  }

  /** Stops one share (host) or leaves one view (viewer). */
  stop(sessionId, reason = 'host') {
    const s = this.shares.get(String(sessionId));
    if (s) { this._endShare(s, reason); return { stopped: 1 }; }
    const v = this.views.get(String(sessionId));
    if (v) {
      this._endView(v, 'viewer', { notify: true });
      return { stopped: 1 };
    }
    throw new RemoteError('not_found', 'no remote desktop session with that id');
  }

  _endView(v, reason, { notify = false } = {}) {
    if (this.views.get(v.sessionId) !== v) return;
    this.views.delete(v.sessionId);
    if (notify) this.p2p.send(v.sessionId, 1, 'remote.stop', { reason: 'viewer' });
    this.audit(notify ? 'remote.leave' : 'remote.ended', { peerId: v.peerId, reason });
    this.emit('ended', { sessionId: v.sessionId, reason });
    this._changed();
  }

  /** The kill switch: the window Stop, the tray, the hotkey and the indicator all land here. Ends every share, view and request. */
  stopAll(reason = 'kill') {
    const n = this.shares.size;
    for (const s of [...this.shares.values()]) this._endShare(s, reason);
    for (const v of [...this.views.values()]) this._endView(v, reason, { notify: true });
    const pending = this.requests.size;
    for (const id of [...this.requests.keys()]) {
      const r = this.requests.get(id);
      this._dropRequest(id);
      if (!r.agentId) this.p2p.send(r.sessionId, 1, 'remote.refused', { reason: 'stopped' });
    }
    this.audit('remote.kill', { reason, shares: n, requests: pending });
    this.emit('killed', { reason });
    this.helperUsers.clear();
    this._stopHelper();
    this._changed();
    return { stopped: n };
  }

  // ---------- viewer ----------

  /** Asks the host for view or control, and whether clipboard and files are wanted. The host's dialog decides. */
  ask(sessionId, { control = false, clipboard = false, files = false, reason = '' } = {}) {
    const s = this._session(String(sessionId));
    const name = control ? CAP_CONTROL : CAP_VIEW;
    this.p2p.caps.request(s.id, { name, limits: { clipboard: clipboard === true, files: files === true } }, String(reason).slice(0, 200));
    const { name: peerName } = this._peerView(s.peerId);
    this.views.set(s.id, {
      sessionId: s.id, peerId: s.peerId, name: peerName, address: this.addressOf(s.peerId), state: 'asking', wants: control ? 'control' : 'view',
      mode: null, expiresAt: null, locked: false, paused: false, control: false, reason: null, clipboard: 'off', files: false,
      askedClipboard: clipboard === true, askedFiles: files === true, displays: [], tracks: 0, at: this.now()
    });
    this.audit('remote.ask', { peerId: s.peerId, wants: control ? 'control' : 'view', clipboard: !!clipboard, files: !!files });
    this._changed();
    return {};
  }

  /** Asks with the unattended password instead of waiting for a click. The host checks it and its own limits. */
  askUnattended(sessionId, { password, control = false, clipboard = false, files = false } = {}) {
    const s = this._session(String(sessionId));
    if (typeof password !== 'string' || !password) throw new RemoteError('bad_request', 'the password is required');
    const { name: peerName } = this._peerView(s.peerId);
    this.views.set(s.id, {
      sessionId: s.id, peerId: s.peerId, name: peerName, address: this.addressOf(s.peerId), state: 'asking', wants: control ? 'control' : 'view',
      mode: null, expiresAt: null, locked: false, paused: false, control: false, reason: null, clipboard: 'off', files: false,
      askedClipboard: clipboard === true, askedFiles: files === true, displays: [], tracks: 0, at: this.now()
    });
    this.p2p.send(s.id, 1, 'remote.unattended', { password: password.slice(0, 256), control: control === true });
    this.audit('remote.ask', { peerId: s.peerId, wants: control ? 'control' : 'view', via: 'unattended' });
    this._changed();
    return {};
  }

  _onUnattended(session, body) {
    if (!this.unattended) { this.p2p.send(session.id, 1, 'remote.refused', { reason: 'unattended_off' }); return; }
    const { trust } = this._peerView(session.peerId);
    const res = this.unattended.check(body.password, { trust });
    if (!res.ok) {
      this.audit('remote.unattended.refused', { peerId: session.peerId, reason: res.code });
      this.p2p.send(session.id, 1, 'remote.refused', { reason: res.code === 'wrong' ? 'wrong_password' : `unattended_${res.code}` });
      return;
    }
    const { name, words } = this._peerView(session.peerId);
    const r = { id: rid('rq'), sessionId: session.id, peerId: session.peerId, name, words, address: this.addressOf(session.peerId), wants: body.control === true ? 'control' : 'view', asks: { view: true, control: true, clipboard: true, files: true }, at: this.now() };
    const d = decideAnswer(r, { allow: true, view: true, minutes: res.minutes, control: res.allow.control, clipboard: res.allow.clipboard ? 'both' : 'off', files: res.allow.files });
    this.audit('remote.unattended.accepted', { peerId: session.peerId, mode: d.mode });
    this._grant(r, d, 'unattended');
  }

  /** The viewer window's input, forwarded to the host. The host checks everything again. */
  sendInput(sessionId, events) {
    const v = this.views.get(String(sessionId));
    if (!v || v.state !== 'granted') throw new RemoteError('forbidden', 'no remote desktop session with that peer');
    if (v.mode !== 'control') throw new RemoteError('forbidden', 'this session is view only');
    if (this.now() >= v.expiresAt) throw new RemoteError('forbidden', 'the permission expired');
    if (!v.control) return { sent: 0, reason: v.reason || 'not_ready' };
    const list = (Array.isArray(events) ? events : []).slice(0, MAX_EVENTS_PER_MESSAGE).map(normalizeEvent).filter(Boolean);
    if (!v.bucket) v.bucket = new Bucket(MAX_EVENTS_PER_SECOND, this.now);
    const ok = list.filter(() => v.bucket.take());
    if (!ok.length) return { sent: 0, reason: 'rate_limited' };
    this.p2p.send(v.sessionId, 1, 'remote.input', { events: ok });
    return { sent: ok.length };
  }

  /** Viewer: asks the host to switch the shared screen, add one, or set the quality. The host's window acts on a click. */
  askScreen(sessionId, { op = 'switch', display = null } = {}) {
    const v = this._liveView(sessionId);
    const o = ['switch', 'add'].includes(op) ? op : 'switch';
    const disp = Number.isInteger(display) && display >= 0 && display < 16 ? display : null;
    this.p2p.send(v.sessionId, 1, 'remote.screen', { op: o, display: disp });
    this.audit('remote.screen.ask', { peerId: v.peerId, op: o, display: disp });
    return {};
  }

  setQuality(sessionId, preset) {
    const v = this._liveView(sessionId);
    if (!QUALITY.includes(preset)) throw new RemoteError('bad_request', 'unknown quality');
    v.quality = preset;
    this.p2p.send(v.sessionId, 1, 'remote.quality', { preset });
    this._changed();
    return {};
  }

  _liveView(sessionId) {
    const v = this.views.get(String(sessionId));
    if (!v || v.state !== 'granted' || this.now() >= v.expiresAt) throw new RemoteError('forbidden', 'no remote desktop session with that peer');
    return v;
  }

  // ---------- chat ----------

  /** A chat line inside a live session, either side. */
  chat(sessionId, text) {
    const id = String(sessionId);
    const s = this.shares.get(id);
    if (s) this._liveShare(id); else this._liveView(id);
    if (s?.agentId) throw new RemoteError('bad_request', 'an agent has no chat here');
    const msg = String(text || '').slice(0, MAX_CHAT).trim();
    if (!msg) throw new RemoteError('bad_request', 'the message is empty');
    if (!this.p2p.send(id, 1, 'remote.chat', { text: msg })) throw new RemoteError('not_found', 'the session closed');
    this._keepChat(id, { mine: true, text: msg, at: this.now() });
    this.audit('remote.chat', { peerId: (s || this.views.get(id)).peerId, chars: msg.length, dir: 'out' });
    return {};
  }

  _keepChat(sessionId, line) {
    const list = this.chats.get(sessionId) || [];
    list.push(line);
    if (list.length > KEEP_CHAT) list.splice(0, list.length - KEEP_CHAT);
    this.chats.set(sessionId, list);
    this.emit('chat', { sessionId, mine: line.mine });
  }

  chatLog(sessionId) { return (this.chats.get(String(sessionId)) || []).slice(); }

  // ---------- incoming messages ----------

  _onMessage(session, msg) {
    const t = msg?.t;
    const body = msg?.body || {};
    switch (t) {
      case 'remote.input': this.handleInput(session, body); return;
      case 'remote.unattended': this._onUnattended(session, body); return;
      case 'remote.ready': {
        const v = this.views.get(session.id);
        if (!v || v.state !== 'asking') return;
        const mode = body.mode === 'control' && v.wants === 'control' ? 'control' : 'view';
        const exp = Number(body.expiresAt);
        Object.assign(v, {
          state: 'granted', mode, expiresAt: Number.isFinite(exp) ? Math.min(exp, this.now() + 60 * 60_000) : this.now() + DEFAULT_MINUTES * 60_000,
          control: mode === 'control' && body.control === true, reason: typeof body.reason === 'string' ? body.reason.slice(0, 40) : null,
          // What the host grants, but never more than this viewer asked for.
          clipboard: v.askedClipboard === true && CLIP_DIRS.includes(body.clipboard) ? body.clipboard : 'off', files: v.askedFiles === true && body.files === true, quality: 'auto',
          displays: cleanDisplayList(body.displays), via: body.via === 'unattended' ? 'unattended' : 'accept'
        });
        this.audit('remote.granted', { peerId: session.peerId, mode, clipboard: v.clipboard, files: v.files, expiresAt: new Date(v.expiresAt).toISOString() });
        this._changed();
        return;
      }
      case 'remote.refused': {
        const v = this.views.get(session.id);
        if (!v) return;
        this.views.delete(session.id);
        const reason = String(body.reason || 'declined').slice(0, 30);
        this.audit('remote.refused', { peerId: session.peerId, reason });
        this.emit('refused', { sessionId: session.id, name: v.name, reason });
        this._changed();
        return;
      }
      case 'remote.state': {
        const v = this.views.get(session.id);
        if (!v || v.state !== 'granted') return;
        v.locked = body.locked === true;
        v.paused = body.paused === true;
        v.control = v.mode === 'control' && body.control === true;
        v.reason = typeof body.reason === 'string' ? body.reason.slice(0, 40) : null;
        v.tracks = Number.isInteger(body.tracks) ? Math.min(MAX_TRACKS, Math.max(0, body.tracks)) : v.tracks;
        if (Array.isArray(body.displays)) v.displays = cleanDisplayList(body.displays);
        this._changed();
        return;
      }
      case 'remote.screen': {
        const s = this.shares.get(session.id);
        if (!s || s.agentId || s.peerId !== session.peerId || this.now() >= s.expiresAt) return;
        s.screenAsk = { op: body.op === 'add' ? 'add' : 'switch', display: Number.isInteger(body.display) ? body.display : null, at: this.now() };
        this.audit('remote.screen.request', { peerId: s.peerId, op: s.screenAsk.op });
        this._changed();
        return;
      }
      case 'remote.quality': {
        const s = this.shares.get(session.id);
        if (!s || s.agentId || s.peerId !== session.peerId || !QUALITY.includes(body.preset)) return;
        s.quality = body.preset;
        this.emit('quality', { sessionId: s.sessionId, preset: s.quality });
        this._changed();
        return;
      }
      case 'remote.chat': {
        const id = session.id;
        const s = this.shares.get(id);
        const v = this.views.get(id);
        const live = (s && !s.agentId && s.peerId === session.peerId && this.now() < s.expiresAt) || (v && v.state === 'granted' && this.now() < v.expiresAt);
        const text = typeof body.text === 'string' ? body.text.slice(0, MAX_CHAT) : '';
        if (!live || !text) return;
        this._keepChat(id, { mine: false, text, at: this.now() });
        this.audit('remote.chat', { peerId: session.peerId, chars: text.length, dir: 'in' });
        return;
      }
      case 'remote.sdp':
      case 'remote.ice': {
        const share = this.shares.get(session.id);
        const v = this.views.get(session.id);
        if (share) { if (share.agentId || this.now() >= share.expiresAt || share.peerId !== session.peerId) return; }
        else if (!v || v.state !== 'granted') return;
        const sig = cleanSignal({ ...body, kind: t === 'remote.ice' ? 'ice' : body.kind });
        if (sig) this.emit('signal', { sessionId: session.id, ...sig });
        return;
      }
      case 'remote.stop': {
        const s = this.shares.get(session.id);
        if (s && s.peerId === session.peerId) { this._endShare(s, 'viewer', { notify: false }); return; }
        const v = this.views.get(session.id);
        if (v) this._endView(v, String(body.reason || 'host').slice(0, 20));
        return;
      }
      default:
    }
  }

  _onCapChange(c) {
    if (c?.kind !== 'revoked' || !c.grant) return;
    for (const s of this.shares.values()) if (s.grantIds.includes(c.grant.id)) { this._endShare(s, 'revoked'); return; }
  }

  _onSessionClosed(session) {
    for (const [id, r] of this.requests) if (r.sessionId === session.id) this._dropRequest(id);
    const s = this.shares.get(session.id);
    if (s) this._endShare(s, 'disconnected', { notify: false });
    const v = this.views.get(session.id);
    if (v) this._endView(v, 'disconnected');
    this.chats.delete(session.id);
    this._changed();
  }

  close() {
    this.stopAll('engine_closed');
    for (const off of this.offs) { try { off(); } catch { /* gone */ } }
    for (const t of this.timers.values()) this.clearTimeout(t);
    this.timers.clear();
  }
}

function cleanDisplays(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 16).filter((d) => d && [d.x, d.y, d.w, d.h].every(Number.isFinite) && d.w > 0 && d.h > 0)
    .map((d) => ({ x: d.x | 0, y: d.y | 0, w: d.w | 0, h: d.h | 0, primary: d.primary === true }));
}

function cleanDisplayList(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 16).filter((d) => d && Number.isFinite(d.w) && Number.isFinite(d.h)).map((d) => ({ w: d.w | 0, h: d.h | 0, primary: d.primary === true }));
}

/** Signaling bodies, cleaned: SDP up to 32 KB, one ICE candidate up to 1 KB. */
export function cleanSignal(sig) {
  if (!sig || typeof sig !== 'object') return null;
  if (sig.kind === 'offer' || sig.kind === 'answer') {
    if (typeof sig.sdp !== 'string' || !sig.sdp.startsWith('v=0') || sig.sdp.length > MAX_SDP) return null;
    return { kind: sig.kind, sdp: sig.sdp };
  }
  if (sig.kind === 'ice') {
    const c = sig.candidate;
    if (c === null) return { kind: 'ice', candidate: null };
    if (!c || typeof c.candidate !== 'string' || c.candidate.length > MAX_ICE) return null;
    return {
      kind: 'ice',
      candidate: {
        candidate: c.candidate,
        sdpMid: typeof c.sdpMid === 'string' ? c.sdpMid.slice(0, 32) : null,
        sdpMLineIndex: Number.isInteger(c.sdpMLineIndex) && c.sdpMLineIndex >= 0 && c.sdpMLineIndex < 16 ? c.sdpMLineIndex : null
      }
    };
  }
  return null;
}
