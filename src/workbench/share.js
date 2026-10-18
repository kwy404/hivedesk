// Terminal sharing with a peer (PLAN 11.3). A terminal is never exposed to a peer unless the
// person at this machine shares it: a per session grant `terminal.share.read` or
// `terminal.share.write`, named for one peer and one terminal, with a time limit (default 15
// minutes). Grants are created, checked, revoked and audited through the P2P control plane
// (src/p2p, Stream 2); this module also checks every grant again itself before any output or
// input crosses, so a stale or foreign grant never works here.
//
// What the workbench needs from src/p2p (injected as `p2p`, see docs/1.0/protocol/workbench.md):
//   grant({ peerId, capability: { name, limits }, scope: 'session', expiresAt }) => Grant
//   revoke(grantId, reason)
//   grantsFor(peerId) => Grant[]          grants this engine issued to that peer
//   send(peerId, { t, body }) => boolean   a stream 1 control message on the open session
//   audit(entry)                           the hash chained audit log
//   peers?() => Array<{ peerId, name, online }>
import { WorkbenchError } from './origin.js';

export const SHARE_MINUTES = [5, 15, 60];
export const DEFAULT_MINUTES = 15;
const FLUSH_MS = 30;
const MAX_FRAME = 32 * 1024;
const BURST_IDLE_MS = 2000;

/** True when a grant is valid now for this peer, capability and terminal. Pure. */
export function grantAllows(grant, { peerId, names, termId, now = Date.now() }) {
  if (!grant || typeof grant !== 'object') return false;
  if (grant.peerId !== peerId) return false;
  if (grant.grantedBy !== 'user') return false;
  if (grant.revokedAt) return false;
  if (grant.scope !== 'session') return false;
  if (!grant.expiresAt || !(Date.parse(grant.expiresAt) > now)) return false;
  const cap = grant.capability || {};
  if (!names.includes(cap.name)) return false;
  if (cap.limits?.terminalId !== termId) return false;
  return true;
}

export class TerminalShares {
  /**
   * @param {{ terms: import('./pty.js').TerminalManager, p2p?: object | null, now?: () => number }} o
   */
  constructor(o) {
    this.terms = o.terms;
    this.p2p = o.p2p || null;
    this.now = o.now || (() => Date.now());
    /** termId -> Map(peerId -> share) */
    this.shares = new Map();
    this.timers = new Set();
  }

  available() {
    return !!(this.p2p && typeof this.p2p.grant === 'function' && typeof this.p2p.send === 'function' && typeof this.p2p.grantsFor === 'function');
  }

  _need() {
    if (!this.available()) throw new WorkbenchError('p2p_unavailable', 'Sharing a terminal needs the peer to peer plane, which is not running.');
    return this.p2p;
  }

  _audit(entry) {
    try { this.p2p?.audit?.({ area: 'workbench', ts: new Date(this.now()).toISOString(), ...entry }); } catch { /* the audit log reports its own errors */ }
  }

  /** The valid grant a peer holds for this terminal, checked here again. */
  _valid(peerId, termId, write) {
    const names = write ? ['terminal.share.write'] : ['terminal.share.read', 'terminal.share.write'];
    let list = [];
    try { list = this.p2p?.grantsFor?.(peerId) || []; } catch { list = []; }
    return list.find((g) => grantAllows(g, { peerId, names, termId, now: this.now() })) || null;
  }

  list(termId) {
    const m = this.shares.get(termId);
    return m ? [...m.values()].map((s) => ({ peerId: s.peerId, name: s.name, mode: s.mode, grantId: s.grantId, expiresAt: s.expiresAt, attached: s.attached })) : [];
  }

  all() {
    const out = [];
    for (const termId of this.shares.keys()) for (const s of this.list(termId)) out.push({ termId, ...s });
    return out;
  }

  /** The person at this machine shares a terminal with one peer. */
  async share({ termId, peerId, mode = 'read', minutes = DEFAULT_MINUTES }) {
    const p2p = this._need();
    const term = this.terms.get(termId);
    if (term.exit) throw new WorkbenchError('conflict', 'the terminal has exited');
    if (typeof peerId !== 'string' || !/^hd1[a-z2-7]{8,60}$/.test(peerId)) throw new WorkbenchError('bad_request', 'a valid peer id is required');
    if (!['read', 'write'].includes(mode)) throw new WorkbenchError('bad_request', 'mode is read or write');
    const mins = SHARE_MINUTES.includes(Number(minutes)) ? Number(minutes) : DEFAULT_MINUTES;
    const peer = (p2p.peers?.() || []).find((p) => p.peerId === peerId);
    if (p2p.peers && !peer) throw new WorkbenchError('not_found', 'that peer is not known here');
    const old = this.shares.get(termId)?.get(peerId);
    if (old) await this._stop(term, old, 'replaced');
    const expiresAt = new Date(this.now() + mins * 60_000).toISOString();
    const name = mode === 'write' ? 'terminal.share.write' : 'terminal.share.read';
    const grant = await p2p.grant({ peerId, capability: { name, limits: { terminalId: termId } }, scope: 'session', expiresAt, grantedBy: 'user' });
    if (!grant?.id) throw new WorkbenchError('internal', 'the grant was not created');
    const share = { termId, peerId, name: peer?.name || peerId.slice(0, 12), mode, grantId: grant.id, expiresAt: grant.expiresAt || expiresAt, attached: false, pending: '', flushTimer: null, off: null, inBytes: 0, burstTimer: null };
    if (!this.shares.has(termId)) this.shares.set(termId, new Map());
    this.shares.get(termId).set(peerId, share);
    const ms = Date.parse(share.expiresAt) - this.now();
    share.expiryTimer = setTimeout(() => this._stop(term, share, 'expired'), Math.max(0, ms));
    share.expiryTimer.unref?.();
    share.offExit = term.onExit(() => this._stop(term, share, 'exited'));
    this._audit({ kind: 'terminal.share.start', peerId, termId, mode, grantId: grant.id, expiresAt: share.expiresAt });
    try { p2p.send(peerId, { t: 'term.offer', body: { termId, mode, expiresAt: share.expiresAt, shell: term.info().shell, cols: term.cols, rows: term.rows } }); } catch { /* the peer may be offline; it can attach later */ }
    return { termId, peerId, mode, grantId: grant.id, expiresAt: share.expiresAt };
  }

  /** The person at this machine stops sharing (one peer, or everyone). */
  async unshare({ termId, peerId }) {
    const m = this.shares.get(termId);
    if (!m) return { stopped: 0 };
    let term = null;
    try { term = this.terms.get(termId); } catch { /* exited and gone */ }
    let n = 0;
    for (const s of [...m.values()]) {
      if (peerId && s.peerId !== peerId) continue;
      await this._stop(term, s, 'stopped by the host');
      n++;
    }
    return { stopped: n };
  }

  async _stop(term, share, reason) {
    const m = this.shares.get(share.termId);
    if (!m || m.get(share.peerId) !== share) return;
    m.delete(share.peerId);
    if (!m.size) this.shares.delete(share.termId);
    clearTimeout(share.expiryTimer);
    clearTimeout(share.flushTimer);
    this._endBurst(share);
    share.off?.();
    share.offExit?.();
    if (reason !== 'expired' && reason !== 'revoked') {
      try { await this.p2p?.revoke?.(share.grantId, reason); } catch { /* already gone */ }
    }
    try { this.p2p?.send?.(share.peerId, { t: 'term.closed', body: { termId: share.termId, reason } }); } catch { /* offline */ }
    this._audit({ kind: 'terminal.share.stop', peerId: share.peerId, termId: share.termId, reason, bytesOut: share.bytesOut || 0, bytesIn: share.totalIn || 0, exited: !!term?.exit });
  }

  /** Called by the P2P plane when a grant is revoked or expires there. */
  onGrantChange(ev) {
    for (const m of this.shares.values()) {
      for (const s of m.values()) {
        if (s.grantId === ev?.grantId) {
          let term = null;
          try { term = this.terms.get(s.termId); } catch { /* gone */ }
          this._stop(term, s, ev.revokedAt ? 'revoked' : 'expired');
        }
      }
    }
  }

  /**
   * A message from a peer, already decrypted and attributed by src/p2p (`term.*`, PLAN section 4).
   * Only term.attach, term.input and term.detach exist for peers; everything else is refused.
   */
  handlePeer(peerId, msg) {
    const t = msg?.t;
    const body = msg?.body && typeof msg.body === 'object' ? msg.body : {};
    const termId = typeof body.termId === 'string' ? body.termId : '';
    if (!['term.attach', 'term.input', 'term.detach'].includes(t)) throw new WorkbenchError('forbidden', 'peers cannot open, resize or close terminals here');
    const share = this.shares.get(termId)?.get(peerId);
    const grant = this._valid(peerId, termId, t === 'term.input');
    if (!share || !grant || grant.id !== share.grantId) throw new WorkbenchError('not_granted', 'this terminal is not shared with you');
    const term = this.terms.get(termId);
    if (t === 'term.attach') {
      if (!share.attached) {
        share.attached = true;
        share.bytesOut = 0;
        share.off = term.onData((d) => this._queue(term, share, d));
      }
      this._audit({ kind: 'terminal.share.attach', peerId, termId });
      return { termId, mode: share.mode, cols: term.cols, rows: term.rows, scrollback: term.buffer.slice(-64 * 1024), expiresAt: share.expiresAt };
    }
    if (t === 'term.detach') {
      share.off?.();
      share.off = null;
      share.attached = false;
      return { termId };
    }
    // term.input: only with a write grant; counted, never logged as content.
    if (share.mode !== 'write') throw new WorkbenchError('not_granted', 'this share is view only');
    const data = typeof body.data === 'string' ? body.data : '';
    if (!data) return { termId, bytes: 0 };
    const n = term.write(data);
    share.inBytes += n;
    share.totalIn = (share.totalIn || 0) + n;
    clearTimeout(share.burstTimer);
    share.burstTimer = setTimeout(() => this._endBurst(share), BURST_IDLE_MS);
    share.burstTimer.unref?.();
    return { termId, bytes: n };
  }

  _endBurst(share) {
    clearTimeout(share.burstTimer);
    share.burstTimer = null;
    if (share.inBytes) {
      this._audit({ kind: 'terminal.share.input', peerId: share.peerId, termId: share.termId, bytes: share.inBytes });
      share.inBytes = 0;
    }
  }

  _queue(term, share, data) {
    share.pending += data;
    if (share.flushTimer) return;
    share.flushTimer = setTimeout(() => {
      share.flushTimer = null;
      // Check the grant again before anything leaves this machine.
      const g = this._valid(share.peerId, share.termId, false);
      if (!g || g.id !== share.grantId) { this._stop(term, share, 'grant no longer valid'); return; }
      let out = share.pending;
      share.pending = '';
      while (out.length) {
        const part = out.slice(0, MAX_FRAME);
        out = out.slice(MAX_FRAME);
        share.bytesOut = (share.bytesOut || 0) + part.length;
        try { this.p2p.send(share.peerId, { t: 'term.data', body: { termId: share.termId, data: part } }); } catch { /* the session dropped; the grant check stops it next time */ }
      }
    }, FLUSH_MS);
    share.flushTimer.unref?.();
  }

  async closeAll() {
    for (const termId of [...this.shares.keys()]) await this.unshare({ termId });
  }
}
