// File transfer inside a remote desktop session (docs/1.0/PLAN.md section 12.4).
// The repo had no transfer code to reuse (docs/1.0/AUDIT.md section 17), so this is new:
//   file.offer   stream 1  sender -> receiver  { id, name, size, sha256, chunks, clipId?, rel? }
//   file.answer  stream 1  receiver -> sender  { id, accept, from }       from = first chunk index wanted (resume)
//   file.chunk   stream 2  sender -> receiver  { id, i, data }            64 KB of base64, in order
//   file.ack     stream 1  receiver -> sender  { id, next }               flow control, 8 chunks in flight
//   file.pause   stream 1  either             { id, on }                 the sender holds back chunks while paused
//   file.done    stream 1  receiver -> sender  { id, ok, code? }          after the SHA-256 check
//   file.cancel  stream 1  either             { id }
// A file someone sends needs a live file.send permission and the receiver's Accept click. Files that
// the receiver asked for itself by pasting (clipboard sync, src/remote/clipsync.js) pass the clipboard
// gate instead and need no second click. Files land as <name>.part and are renamed only after the hash
// matched; nothing received is ever opened. An interrupted transfer resumes from the last written chunk
// when the same file is offered again by the same peer within an hour (memory only).

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { RemoteError } from './desk.js';
import { CAP_FILE, grantLive } from './policy.js';

export const CHUNK = 64 * 1024;
export const MAX_FILE = 2 * 1024 ** 3;
const WINDOW = 8;
const RESUME_MS = 60 * 60_000;
const MAX_INCOMING = 4;
const MAX_INCOMING_CLIP = 64;

const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/** A file name from a peer, made safe for every OS: no folders, no reserved names, no control characters. */
export function safeName(name) {
  let n = String(name || '').replace(/\\/g, '/').split('/').pop() || '';
  n = n.replace(/[\x00-\x1f\x7f<>:"|?*]/g, '_').replace(/^[.\s]+/, '').replace(/[.\s]+$/, '').slice(0, 120);
  if (!n || WIN_RESERVED.test(n)) n = `file${n ? `_${n}` : ''}`;
  return n;
}

/** A relative path from a peer ("folder/sub/file.txt"), each part made safe; never absolute, never "..". */
export function safeRel(rel) {
  const parts = String(rel || '').replace(/\\/g, '/').split('/').filter((p) => p && p !== '.' && p !== '..');
  if (!parts.length || parts.length > 32) return null;
  return parts.map(safeName).join('/');
}

/** The folder name for a peer: its display name made safe, with a short id so two "Rita"s do not mix. */
export function peerFolder(name, peerId) {
  const base = safeName(name || 'peer').slice(0, 40) || 'peer';
  return `${base}-${String(peerId || '').replace(/[^a-z0-9]/gi, '').slice(-6) || 'x'}`;
}

/** A path in dir that does not exist yet: name, name (1), name (2), ... */
export function freePath(dir, name) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 0; i < 1000; i++) {
    const p = path.join(dir, i ? `${stem} (${i})${ext}` : name);
    if (!fs.existsSync(p)) return p;
  }
  throw new RemoteError('conflict', 'too many files with that name');
}

export async function sha256File(file) {
  const h = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', resolve).on('error', reject);
  });
  return h.digest('hex');
}

const tid = () => `ft_${crypto.randomBytes(8).toString('hex')}`;

export class FileTransfers extends EventEmitter {
  /**
   * @param {{ p2p: import('./port.js').P2PPort, desk: import('./desk.js').RemoteDesk, downloadsDir?: string, now?: () => number }} o
   */
  constructor({ p2p, desk, downloadsDir, now }) {
    super();
    this.p2p = p2p;
    this.desk = desk;
    this.root = downloadsDir || path.join(os.homedir(), 'Downloads', 'hivedesk');
    this.now = now || (() => Date.now());
    this.out = new Map();
    this.in = new Map();
    this.paused = new Map();
    /** Set by clipsync: { canSend(sessionId), receiveDir(session, offer) -> folder or null }. */
    this.clipGate = null;
    // One message at a time, in arrival order: a chunk is written before the next one is looked at.
    this.chain = Promise.resolve();
    this.off = p2p.onMessage('file.', (s, m) => {
      this.chain = this.chain.then(() => this._on(s, m)).catch((err) => this.emit('error', err));
    });
    this.offSession = p2p.onSession((ev, s) => { if (ev === 'close') this._sessionClosed(s); });
  }

  /** Whether files may go to or come from the peer of this session right now (the file.send permission). */
  _allowed(sessionId, peerId) {
    const now = this.now();
    const share = this.desk.shares.get(sessionId);
    if (share && !share.agentId) {
      if (!share.files || now >= share.expiresAt || share.paused) return false;
      return peerId === undefined || (share.peerId === peerId && grantLive(this.p2p.caps.find(peerId, CAP_FILE), now));
    }
    const view = this.desk.views.get(sessionId);
    return !!view && view.state === 'granted' && view.files && !view.paused && now < view.expiresAt && (peerId === undefined || view.peerId === peerId);
  }

  _peerOf(sessionId) {
    return this.desk.shares.get(sessionId) || this.desk.views.get(sessionId) || null;
  }

  // ---------- sending ----------

  /** Offers a local file (picked by the person, or pasted by the peer through clipboard sync). */
  async offer(sessionId, file, { temp = false, clipId = null, rel = null } = {}) {
    const clip = clipId != null;
    if (clip ? !this.clipGate?.canSend(sessionId) : !this._allowed(sessionId)) throw new RemoteError('forbidden', 'file transfer was not allowed for this session');
    const abs = path.resolve(String(file || ''));
    let st;
    try { st = await fsp.stat(abs); } catch { throw new RemoteError('not_found', 'no such file'); }
    if (!st.isFile()) throw new RemoteError('bad_request', 'only files can be sent');
    if (st.size > MAX_FILE) throw new RemoteError('bad_request', 'files are limited to 2 GB');
    const sha256 = await sha256File(abs);
    const t = {
      id: tid(), sessionId, peerId: this._peerOf(sessionId)?.peerId, file: abs, name: safeName(path.basename(abs)), size: st.size, sha256,
      chunks: Math.ceil(st.size / CHUNK), next: 0, acked: 0, state: 'offered', fh: null, temp, clipId, rel: clip ? safeRel(rel) : null, paused: false
    };
    this.out.set(t.id, t);
    const body = { id: t.id, name: t.name, size: t.size, sha256, chunks: t.chunks };
    if (clip) Object.assign(body, { clipId: String(clipId), rel: t.rel });
    if (!this.p2p.send(sessionId, 1, 'file.offer', body)) {
      this.out.delete(t.id);
      throw new RemoteError('not_found', 'the session closed');
    }
    this.desk.audit('file.offer', { peerId: t.peerId, name: t.name, size: t.size, sha256, clip });
    this.emit('changed');
    return { id: t.id, name: t.name, size: t.size, sha256 };
  }

  _sendAllowed(t) { return t.clipId != null ? !!this.clipGate?.canSend(t.sessionId) : this._allowed(t.sessionId); }

  async _pump(t) {
    if (t.pumping) return;
    t.pumping = true;
    try {
      if (!t.fh) t.fh = await fsp.open(t.file, 'r');
      while (t.state === 'sending' && !t.paused && t.next < t.chunks && t.next - t.acked < WINDOW) {
        if (!this._sendAllowed(t)) { await this._cancelOut(t, 'not_allowed'); return; }
        const len = Math.min(CHUNK, t.size - t.next * CHUNK);
        const buf = Buffer.alloc(len);
        const { bytesRead } = await t.fh.read(buf, 0, len, t.next * CHUNK);
        if (bytesRead !== len) { await this._cancelOut(t, 'file_changed'); return; }
        if (!this.p2p.send(t.sessionId, 2, 'file.chunk', { id: t.id, i: t.next, data: buf.toString('base64') })) { await this._closeOut(t, 'disconnected'); return; }
        t.next++;
      }
    } finally { t.pumping = false; }
  }

  async _closeOut(t, state) {
    t.state = state;
    this.out.delete(t.id);
    try { await t.fh?.close(); } catch { /* closed */ }
    t.fh = null;
    // A browser upload sits in its own new folder under the outbox and goes away with its transfer.
    if (t.temp) await fsp.rm(path.dirname(t.file), { recursive: true, force: true }).catch(() => {});
    this.emit('changed');
  }

  async _cancelOut(t, reason) {
    this.p2p.send(t.sessionId, 1, 'file.cancel', { id: t.id, reason });
    this.desk.audit('file.cancel', { peerId: t.peerId, name: t.name, reason });
    await this._closeOut(t, 'cancelled');
  }

  // ---------- receiving ----------

  /** The receiver's click on the offer. */
  async answer(id, accept) {
    const t = this.in.get(String(id));
    if (!t || t.state !== 'offered') throw new RemoteError('not_found', 'that file offer is no longer waiting');
    if (!accept) {
      this.in.delete(t.id);
      this.p2p.send(t.sessionId, 1, 'file.answer', { id: t.id, accept: false });
      this.desk.audit('file.refuse', { peerId: t.peerId, name: t.name, size: t.size });
      this.emit('changed');
      return { accepted: false };
    }
    if (!this._allowed(t.sessionId, t.peerId)) throw new RemoteError('forbidden', 'file transfer is no longer allowed for this session');
    const dir = path.join(this.root, peerFolder(t.peerName, t.peerId));
    await this._start(t, dir, t.name);
    this.desk.audit('file.accept', { peerId: t.peerId, name: t.name, size: t.size, sha256: t.sha256 });
    if (t.chunks === 0) await this._finish(t);
    return { accepted: true, part: t.part };
  }

  async _start(t, dir, relName) {
    const target = path.join(dir, ...relName.split('/'));
    await fsp.mkdir(path.dirname(target), { recursive: true });
    t.dir = path.dirname(target);
    t.finalName = path.basename(target);
    t.part = freePath(t.dir, `${t.finalName}.part`);
    t.fh = await fsp.open(t.part, 'w');
    t.state = 'receiving';
    t.next = 0;
    this.p2p.send(t.sessionId, 1, 'file.answer', { id: t.id, accept: true, from: 0 });
    this.emit('changed');
  }

  async _incomingOffer(session, b) {
    const ok = typeof b.id === 'string' && /^ft_[0-9a-f]{16}$/.test(b.id) && Number.isSafeInteger(b.size) && b.size >= 0 && b.size <= MAX_FILE &&
      typeof b.sha256 === 'string' && /^[0-9a-f]{64}$/.test(b.sha256) && b.chunks === Math.ceil(b.size / CHUNK) && !this.in.has(b.id);
    if (!ok) return;
    const peer = this._peerOf(session.id);
    const t = { id: b.id, sessionId: session.id, peerId: session.peerId, peerName: peer?.name || 'peer', name: safeName(b.name), size: b.size, sha256: b.sha256, chunks: b.chunks, state: 'offered', next: 0, at: this.now(), paused: false, clipId: null };
    // A file this side asked for by pasting: the clipboard gate decides, and no second click is needed.
    if (typeof b.clipId === 'string') {
      const rel = safeRel(b.rel);
      const dir = rel ? this.clipGate?.receiveDir(session, b) : null;
      if (!dir || [...this.in.values()].filter((x) => x.peerId === session.peerId).length >= MAX_INCOMING_CLIP) {
        this.p2p.send(session.id, 1, 'file.answer', { id: b.id, accept: false, code: 'not_granted' });
        this.desk.audit('file.refused', { peerId: session.peerId, size: b.size, reason: 'not_granted', clip: true });
        return;
      }
      t.clipId = b.clipId;
      t.rel = rel;
      this.in.set(t.id, t);
      await this._start(t, dir, rel);
      this.desk.audit('file.accept', { peerId: t.peerId, name: t.name, size: t.size, sha256: t.sha256, clip: true });
      if (t.chunks === 0) await this._finish(t);
      return;
    }
    if (!this._allowed(session.id, session.peerId)) {
      this.p2p.send(session.id, 1, 'file.answer', { id: b.id, accept: false, code: 'not_granted' });
      this.desk.audit('file.refused', { peerId: session.peerId, size: b.size, reason: 'not_granted' });
      return;
    }
    if ([...this.in.values()].filter((x) => x.peerId === session.peerId && !x.clipId).length >= MAX_INCOMING) {
      this.p2p.send(session.id, 1, 'file.answer', { id: b.id, accept: false, code: 'busy' });
      return;
    }
    // Resume: the same file from the same peer, accepted before and interrupted.
    const key = `${t.peerId}|${t.sha256}|${t.size}`;
    const old = this.paused.get(key);
    if (old && this.now() - old.at < RESUME_MS && fs.existsSync(old.part)) {
      this.paused.delete(key);
      Object.assign(t, { dir: old.dir, part: old.part, finalName: old.finalName, next: old.next, state: 'receiving' });
      try { await fsp.truncate(t.part, t.next * CHUNK); } catch { t.next = 0; }
      t.fh = await fsp.open(t.part, t.next ? 'r+' : 'w');
      this.in.set(t.id, t);
      this.p2p.send(session.id, 1, 'file.answer', { id: t.id, accept: true, from: t.next });
      this.desk.audit('file.resume', { peerId: t.peerId, name: t.name, size: t.size, from: t.next });
      this.emit('changed');
      return;
    }
    this.in.set(t.id, t);
    this.desk.audit('file.offered', { peerId: t.peerId, name: t.name, size: t.size, sha256: t.sha256 });
    this.emit('incoming', { id: t.id, sessionId: t.sessionId, from: t.peerName, name: t.name, size: t.size });
    this.emit('changed');
  }

  _recvAllowed(t) { return t.clipId ? !!this.clipGate?.receiveDir(this.p2p.session(t.sessionId) || { id: t.sessionId, peerId: t.peerId }, t) : this._allowed(t.sessionId, t.peerId); }

  async _chunk(session, b) {
    const t = this.in.get(b.id);
    if (!t || t.sessionId !== session.id || t.state !== 'receiving') return;
    if (!this._recvAllowed(t)) { await this._cancelIn(t, 'not_allowed'); return; }
    if (b.i !== t.next) { this.p2p.send(t.sessionId, 1, 'file.ack', { id: t.id, next: t.next }); return; }
    if (typeof b.data !== 'string' || b.data.length > Math.ceil(CHUNK / 3) * 4) { await this._cancelIn(t, 'bad_chunk'); return; }
    const buf = Buffer.from(b.data, 'base64');
    const expect = Math.min(CHUNK, t.size - t.next * CHUNK);
    if (buf.length !== expect) { await this._cancelIn(t, 'bad_chunk'); return; }
    await t.fh.write(buf, 0, buf.length, t.next * CHUNK);
    t.next++;
    this.p2p.send(t.sessionId, 1, 'file.ack', { id: t.id, next: t.next });
    if (t.next === t.chunks) await this._finish(t);
    else if (t.next % 16 === 0) this.emit('changed');
  }

  async _finish(t) {
    await t.fh.close();
    t.fh = null;
    const got = await sha256File(t.part);
    this.in.delete(t.id);
    if (got !== t.sha256) {
      await fsp.rm(t.part, { force: true });
      this.p2p.send(t.sessionId, 1, 'file.done', { id: t.id, ok: false, code: 'hash_mismatch' });
      this.desk.audit('file.failed', { peerId: t.peerId, name: t.name, size: t.size, reason: 'hash_mismatch' });
      this.emit('failed', { id: t.id, clipId: t.clipId });
      this.emit('changed');
      return;
    }
    const final = freePath(t.dir, t.finalName);
    await fsp.rename(t.part, final);
    this.p2p.send(t.sessionId, 1, 'file.done', { id: t.id, ok: true });
    this.desk.audit('file.receive', { peerId: t.peerId, name: path.basename(final), size: t.size, sha256: t.sha256, clip: !!t.clipId });
    this.emit('received', { id: t.id, from: t.peerName, path: final, size: t.size, clipId: t.clipId, rel: t.rel });
    this.emit('changed');
  }

  async _cancelIn(t, reason, { notify = true } = {}) {
    this.in.delete(t.id);
    try { await t.fh?.close(); } catch { /* closed */ }
    if (t.part) await fsp.rm(t.part, { force: true }).catch(() => {});
    if (notify) this.p2p.send(t.sessionId, 1, 'file.cancel', { id: t.id, reason });
    this.desk.audit('file.cancel', { peerId: t.peerId, name: t.name, reason });
    this.emit('failed', { id: t.id, clipId: t.clipId });
    this.emit('changed');
  }

  /** Cancels a transfer in either direction (the person's click). */
  async cancel(id) {
    const o = this.out.get(String(id));
    if (o) { await this._cancelOut(o, 'cancelled'); return {}; }
    const i = this.in.get(String(id));
    if (i) { await this._cancelIn(i, 'cancelled'); return {}; }
    throw new RemoteError('not_found', 'no such transfer');
  }

  /** Pauses or resumes a transfer from either side. */
  async pause(id, on) {
    const t = this.out.get(String(id)) || this.in.get(String(id));
    if (!t) throw new RemoteError('not_found', 'no such transfer');
    t.paused = on === true;
    this.p2p.send(t.sessionId, 1, 'file.pause', { id: t.id, on: t.paused });
    this.desk.audit(t.paused ? 'file.pause' : 'file.resume.click', { peerId: t.peerId, name: t.name });
    this.emit('changed');
    if (!t.paused && this.out.has(t.id)) await this._pump(t);
    return { paused: t.paused };
  }

  async _on(session, msg) {
    const b = msg?.body || {};
    switch (msg?.t) {
      case 'file.offer': return this._incomingOffer(session, b);
      case 'file.chunk': return this._chunk(session, b);
      case 'file.answer': {
        const t = this.out.get(b.id);
        if (!t || t.sessionId !== session.id || t.state !== 'offered') return;
        if (b.accept !== true) { this.desk.audit('file.refused', { peerId: t.peerId, name: t.name }); return this._closeOut(t, 'refused'); }
        const from = Number.isInteger(b.from) && b.from >= 0 && b.from <= t.chunks ? b.from : 0;
        Object.assign(t, { state: 'sending', next: from, acked: from });
        this.emit('changed');
        return this._pump(t);
      }
      case 'file.ack': {
        const t = this.out.get(b.id);
        if (!t || t.sessionId !== session.id || t.state !== 'sending') return;
        // The session is ordered and reliable, so acks only move forward.
        if (Number.isInteger(b.next) && b.next >= t.acked && b.next <= t.next) t.acked = b.next;
        return this._pump(t);
      }
      case 'file.pause': {
        const t = this.out.get(b.id) || this.in.get(b.id);
        if (!t || t.sessionId !== session.id) return;
        t.paused = b.on === true;
        this.emit('changed');
        if (!t.paused && this.out.has(t.id)) return this._pump(t);
        return undefined;
      }
      case 'file.done': {
        const t = this.out.get(b.id);
        if (!t || t.sessionId !== session.id) return;
        this.desk.audit(b.ok === true ? 'file.sent' : 'file.failed', { peerId: t.peerId, name: t.name, size: t.size, sha256: t.sha256, ...(b.ok === true ? {} : { reason: String(b.code || 'failed').slice(0, 30) }) });
        return this._closeOut(t, b.ok === true ? 'done' : 'failed');
      }
      case 'file.cancel': {
        const o = this.out.get(b.id);
        if (o && o.sessionId === session.id) { this.desk.audit('file.cancel', { peerId: o.peerId, name: o.name, reason: 'peer' }); return this._closeOut(o, 'cancelled'); }
        const i = this.in.get(b.id);
        if (i && i.sessionId === session.id) return this._cancelIn(i, 'peer', { notify: false });
        return undefined;
      }
      default: return undefined;
    }
  }

  _sessionClosed(session) {
    for (const t of [...this.out.values()]) if (t.sessionId === session.id) this._closeOut(t, 'disconnected');
    for (const t of [...this.in.values()]) {
      if (t.sessionId !== session.id) continue;
      this.in.delete(t.id);
      if (t.state === 'receiving' && t.part && !t.clipId) {
        t.fh?.close().catch(() => {});
        this.paused.set(`${t.peerId}|${t.sha256}|${t.size}`, { dir: t.dir, part: t.part, finalName: t.finalName, next: t.next, at: this.now() });
        this.desk.audit('file.paused', { peerId: t.peerId, name: t.name, at: t.next });
      } else if (t.part) {
        t.fh?.close().catch(() => {});
        fsp.rm(t.part, { force: true }).catch(() => {});
      }
      this.emit('failed', { id: t.id, clipId: t.clipId });
    }
    this.emit('changed');
  }

  list() {
    const pick = (t, dir) => ({
      id: t.id, dir, sessionId: t.sessionId, name: t.name, size: t.size, state: t.state, paused: !!t.paused, clip: t.clipId != null,
      done: Math.min(t.size, (dir === 'out' ? t.acked : t.next) * CHUNK)
    });
    return [...[...this.out.values()].map((t) => pick(t, 'out')), ...[...this.in.values()].map((t) => pick(t, 'in'))];
  }

  close() {
    this.off?.();
    this.offSession?.();
    for (const t of this.out.values()) t.fh?.close().catch(() => {});
    for (const t of this.in.values()) t.fh?.close().catch(() => {});
  }
}
