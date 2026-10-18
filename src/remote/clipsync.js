// Clipboard sync during a remote session: copy on one PC, paste on the other, both directions.
//   clip.text        stream 2  { text, html? }                       plain text up to 1 MB, HTML up to 2 MB
//   clip.image       stream 2  { png }                               a PNG up to 8 MB, base64
//   clip.files       stream 1  { id, entries: [{ rel, size, dir }], total }   what was copied in the file manager
//   clip.files.get   stream 1  { id }                                the receiver pastes: send them
// Pasted files come through the chunked file transfer (src/remote/transfer.js) into a chosen folder,
// with progress; the paste completes when the last file passed its hash check, and then the native
// clipboard holds those local files. Nothing received is ever opened.
//
// Rules, all checked here on both engines:
//   * a separate "clipboard.text" grant, off unless the host ticked it, with a direction per grant
//     (host to viewer, viewer to host, or both);
//   * never while the session is paused, or while either screen is locked (automatic sync needs a
//     known unlocked state; a window that is not focused never reads or writes the clipboard);
//   * size caps per kind, de-duplicated so a pasted item is not sent back;
//   * one audit line per sync with kind, size and count, never the content.

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { RemoteError } from './desk.js';
import { CAP_CLIP, grantLive, clipAllows } from './policy.js';
import { MAX_FILE, peerFolder, safeRel } from './transfer.js';

export const CLIP_LIMITS = Object.freeze({ text: 1024 * 1024, html: 2 * 1024 * 1024, png: 8 * 1024 * 1024, entries: 2000, filesBytes: MAX_FILE });
/** Copied files up to this total are fetched at once when the receiver allows auto fetch; bigger sets wait for a click. */
export const AUTO_FETCH_BYTES = 25 * 1024 * 1024;
const OUT_KEEP_MS = 30 * 60_000;
const KEEP_RECEIVED = 8;

const sha = (...parts) => {
  const h = crypto.createHash('sha256');
  for (const p of parts) h.update(p == null ? '\0' : p);
  return h.digest('hex');
};

/** A content hash per item, for de-duplication. */
export function itemHash(item) {
  if (item.kind === 'text') return sha('t', item.text, item.html || '');
  if (item.kind === 'image') return sha('i', item.png);
  return sha('f', JSON.stringify(item.paths || item.entries || []));
}

/** Checks an item against the caps. Returns an error code or null. */
export function checkItem(item) {
  if (!item || typeof item !== 'object') return 'bad_item';
  if (item.kind === 'text') {
    if (typeof item.text !== 'string') return 'bad_item';
    if (Buffer.byteLength(item.text, 'utf8') > CLIP_LIMITS.text) return 'too_large';
    if (item.html != null && (typeof item.html !== 'string' || Buffer.byteLength(item.html, 'utf8') > CLIP_LIMITS.html)) return 'too_large';
    if (!item.text && !item.html) return 'empty';
    return null;
  }
  if (item.kind === 'image') {
    if (!Buffer.isBuffer(item.png)) return 'bad_item';
    if (item.png.length > CLIP_LIMITS.png) return 'too_large';
    if (item.png.length < 8 || item.png.readUInt32BE(0) !== 0x89504e47) return 'bad_item';
    return null;
  }
  if (item.kind === 'files') return Array.isArray(item.paths) && item.paths.length ? null : 'empty';
  return 'bad_item';
}

const bytesOf = (item) => (item.kind === 'text' ? Buffer.byteLength(item.text, 'utf8') + Buffer.byteLength(item.html || '', 'utf8') : item.kind === 'image' ? item.png.length : 0);

/** Lists copied files and folders as relative entries, without following links. */
export async function listEntries(paths) {
  const entries = [];
  const map = new Map();
  let total = 0;
  const tops = new Set();
  const walk = async (abs, rel) => {
    if (entries.length >= CLIP_LIMITS.entries) throw new RemoteError('bad_request', 'too many files on the clipboard');
    const st = await fsp.lstat(abs);
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      entries.push({ rel, size: 0, dir: true });
      for (const name of (await fsp.readdir(abs)).sort()) await walk(path.join(abs, name), `${rel}/${name}`);
    } else if (st.isFile()) {
      total += st.size;
      if (total > CLIP_LIMITS.filesBytes) throw new RemoteError('bad_request', 'the copied files are larger than 2 GB');
      entries.push({ rel, size: st.size, dir: false });
      map.set(rel, abs);
    }
  };
  for (const p of paths) {
    let top = path.basename(p);
    for (let i = 1; tops.has(top); i++) top = `${path.basename(p)} (${i})`;
    tops.add(top);
    await walk(path.resolve(p), top);
  }
  return { entries: entries.map((e) => ({ ...e, rel: safeRel(e.rel) })).filter((e) => e.rel), map: new Map([...map].map(([r, a]) => [safeRel(r), a])), total };
}

export class ClipSync extends EventEmitter {
  /**
   * @param {{ p2p: import('./port.js').P2PPort, desk: import('./desk.js').RemoteDesk, transfers: import('./transfer.js').FileTransfers,
   *   provider?: object | null, root?: string, now?: () => number, autoFetchBytes?: number }} o
   *   provider: a native clipboard (LinuxClipboard) when the input helper does not do it; on Windows the helper is used
   */
  constructor({ p2p, desk, transfers, provider = null, root, now, autoFetchBytes = AUTO_FETCH_BYTES }) {
    super();
    this.p2p = p2p;
    this.desk = desk;
    this.transfers = transfers;
    this.provider = provider;
    this.root = root || path.join(os.homedir(), 'Downloads', 'hivedesk');
    this.folder = null;
    this.now = now || (() => Date.now());
    this.autoFetchBytes = autoFetchBytes;
    this.last = new Map();      // sessionId -> { out, in } hashes
    this.outFiles = new Map();  // clip id -> { sessionId, map, at }
    this.inFiles = new Map();   // clip id -> { sessionId, peerId, entries, total, base, done, state }
    this.received = new Map();  // id -> item, for a window without native clipboard
    this.active = new Set();    // session ids with native watching on
    transfers.clipGate = { canSend: (sid) => this.canSend(sid), receiveDir: (s, offer) => this._receiveDir(s, offer) };
    this.offs = [
      p2p.onMessage('clip.', (s, m) => { this._on(s, m).catch((err) => this.emit('error', err)); }),
      () => desk.off('state', this._sync),
      () => desk.off('nativeClip', this._native),
      () => transfers.off('received', this._got),
      () => transfers.off('failed', this._failed)
    ];
    this._sync = () => this._syncWatch();
    this._native = (m) => { this.localCopy(decodeNative(m), { auto: true }).catch(() => {}); };
    this._got = (f) => this._fileArrived(f);
    this._failed = (f) => { if (f.clipId && this.inFiles.has(f.clipId)) this.inFiles.get(f.clipId).failed = true; };
    desk.on('state', this._sync);
    desk.on('nativeClip', this._native);
    desk.on('helper', () => this._syncWatch(true));
    transfers.on('received', this._got);
    transfers.on('failed', this._failed);
    provider?.on('clip', (raw) => this.localCopy(fromProvider(raw), { auto: true }).catch(() => {}));
  }

  // ---------- who may do what ----------

  _role(sessionId) {
    const s = this.desk.shares.get(sessionId);
    if (s && !s.agentId) return { role: 'host', dir: s.clipboard, peerId: s.peerId, name: s.name, live: this.now() < s.expiresAt, paused: s.paused, remoteLocked: false };
    const v = this.desk.views.get(sessionId);
    if (v && v.state === 'granted') return { role: 'viewer', dir: v.clipboard, peerId: v.peerId, name: v.name, live: this.now() < v.expiresAt, paused: v.paused, remoteLocked: v.locked };
    return null;
  }

  /** The local screen: automatic sync needs it known unlocked; a known lock blocks everything. */
  _localLock() {
    if (this.desk.helper) return this.desk.unlocked() ? 'unlocked' : this.desk.lock.locked === true ? 'locked' : 'unknown';
    if (this.provider) {
      const l = this.provider.lockState;
      if (l?.locked === false && this.now() - l.at <= 3000) return 'unlocked';
      return l?.locked === true ? 'locked' : 'unknown';
    }
    return 'unknown';
  }

  /** May this side send clipboard content to the peer of the session now? */
  canSend(sessionId, { auto = false } = {}) {
    const r = this._role(sessionId);
    if (!r || !r.live || r.paused || r.remoteLocked) return false;
    if (!clipAllows(r.dir, r.role)) return false;
    if (r.role === 'host' && !grantLive(this.p2p.caps.find(r.peerId, CAP_CLIP), this.now())) return false;
    const lock = this._localLock();
    if (lock === 'locked' || (auto && lock !== 'unlocked')) return false;
    return true;
  }

  /** May content from the peer of this session be taken in now? */
  _canReceive(session) {
    const r = this._role(session.id);
    if (!r || !r.live || r.paused || r.peerId !== session.peerId) return { ok: false, reason: 'no_session' };
    const from = r.role === 'host' ? 'viewer' : 'host';
    if (!clipAllows(r.dir, from)) return { ok: false, reason: 'direction' };
    if (r.role === 'host') {
      const g = this.p2p.caps.find(session.peerId, CAP_CLIP);
      if (!grantLive(g, this.now()) || !clipAllows(g.capability?.limits?.dir || 'off', 'viewer')) return { ok: false, reason: 'not_granted' };
    }
    if (this._localLock() === 'locked') return { ok: false, reason: 'locked' };
    return { ok: true, r };
  }

  _hashes(sessionId) {
    if (!this.last.has(sessionId)) this.last.set(sessionId, { out: null, in: null });
    return this.last.get(sessionId);
  }

  /** Turns native watching on for sessions that may send automatically, off otherwise. */
  _syncWatch(force = false) {
    const want = new Set();
    for (const id of [...this.desk.shares.keys(), ...this.desk.views.keys()]) {
      const r = this._role(id);
      if (r && r.live && r.dir !== 'off') want.add(id);
    }
    for (const id of want) if (!this.active.has(id)) { this.active.add(id); this.desk.useHelper(`clip:${id}`); }
    for (const id of [...this.active]) if (!want.has(id)) { this.active.delete(id); this.last.delete(id); this.desk.dropHelper(`clip:${id}`); }
    const on = this.active.size > 0;
    if (on !== this.watching || force) {
      this.watching = on;
      this.desk.helper?.clipWatch?.(on);
      this.provider?.watch(on);
    }
  }

  /** Who sees "Clipboard synced" right now. */
  status() {
    return [...this.active].map((id) => { const r = this._role(id); return r ? { sessionId: id, name: r.name, dir: r.dir, role: r.role, paused: r.paused } : null; }).filter(Boolean);
  }

  // ---------- sending ----------

  /**
   * Something was copied on this PC (the native watcher, auto: true) or the window sent its own clipboard
   * (a paste into the viewer window or a button, auto: false). Sends it to every session that may receive it.
   */
  async localCopy(item, { auto = false, sessionId = null } = {}) {
    if (!item) return { sent: 0 };
    const err = checkItem(item);
    if (err) {
      if (err === 'too_large') this.desk.audit('clip.dropped', { item: item.kind, reason: err, bytes: bytesOf(item) });
      return { sent: 0, reason: err };
    }
    const targets = sessionId ? [sessionId] : [...this.active];
    let sent = 0;
    const h = itemHash(item);
    for (const sid of targets) {
      if (!this.canSend(sid, { auto })) continue;
      const last = this._hashes(sid);
      if (h === last.in || h === last.out) continue;
      last.out = h;
      const r = this._role(sid);
      if (item.kind === 'text') this.p2p.send(sid, 2, 'clip.text', item.html ? { text: item.text, html: item.html } : { text: item.text });
      else if (item.kind === 'image') this.p2p.send(sid, 2, 'clip.image', { png: item.png.toString('base64') });
      else {
        const list = await listEntries(item.paths);
        if (!list.entries.length) continue;
        const id = `cf_${crypto.randomBytes(8).toString('hex')}`;
        this.outFiles.set(id, { sessionId: sid, map: list.map, at: this.now() });
        this.p2p.send(sid, 1, 'clip.files', { id, entries: list.entries, total: list.total });
        this.desk.audit('clip.sync', { peerId: r.peerId, dir: 'out', item: 'files', items: list.entries.length, bytes: list.total, auto });
        sent++;
        continue;
      }
      this.desk.audit('clip.sync', { peerId: r.peerId, dir: 'out', item: item.kind, bytes: bytesOf(item), auto });
      sent++;
    }
    return { sent };
  }

  // ---------- receiving ----------

  async _on(session, msg) {
    const b = msg?.body || {};
    const t = msg?.t;
    if (t === 'clip.files.get') return this._sendFiles(session, b);
    const gate = this._canReceive(session);
    if (!gate.ok) {
      this.desk.audit('clip.refused', { peerId: session.peerId, item: t, reason: gate.reason });
      return undefined;
    }
    let item = null;
    if (t === 'clip.text' && typeof b.text === 'string') item = { kind: 'text', text: b.text, html: typeof b.html === 'string' ? b.html : undefined };
    else if (t === 'clip.image' && typeof b.png === 'string' && b.png.length <= Math.ceil(CLIP_LIMITS.png / 3) * 4) item = { kind: 'image', png: Buffer.from(b.png, 'base64') };
    else if (t === 'clip.files') return this._incomingFiles(session, b, gate.r);
    const err = item ? checkItem(item) : 'bad_item';
    if (err) { this.desk.audit('clip.refused', { peerId: session.peerId, item: t, reason: err }); return undefined; }
    const last = this._hashes(session.id);
    last.in = itemHash(item);
    this.desk.audit('clip.sync', { peerId: session.peerId, dir: 'in', item: item.kind, bytes: bytesOf(item) });
    return this._apply(session.id, item, gate.r);
  }

  /** Puts an item on this PC's clipboard: natively when unlocked, else hands it to the window (which needs focus). */
  async _apply(sessionId, item, r) {
    const helper = this.desk.helper?.clipSet ? this.desk.helper : null;
    if ((helper || this.provider) && this._localLock() === 'unlocked') {
      const ok = helper ? helper.clipSet(item) : await this.provider.set(item);
      if (ok) { this.emit('applied', { sessionId, kind: item.kind, native: true }); return; }
    }
    if (item.kind === 'files') return;
    const id = `cl_${crypto.randomBytes(6).toString('hex')}`;
    this.received.set(id, { sessionId, item, name: r?.name || '', at: this.now() });
    while (this.received.size > KEEP_RECEIVED) this.received.delete(this.received.keys().next().value);
    this.emit('clip', { id, sessionId, kind: item.kind, bytes: bytesOf(item) });
  }

  /** The window takes an item it was told about (no native clipboard on this side). Once. */
  take(id) {
    const c = this.received.get(String(id));
    if (!c || this.now() - c.at > 10 * 60_000) throw new RemoteError('not_found', 'that clipboard item is gone');
    this.received.delete(String(id));
    const it = c.item;
    return { sessionId: c.sessionId, from: c.name, kind: it.kind, text: it.text, html: it.html, png: it.kind === 'image' ? it.png.toString('base64') : undefined };
  }

  /** The folder pasted files go to (chosen by the person). */
  setFolder(dir) {
    if (dir == null || dir === '') { this.folder = null; return { folder: null }; }
    const abs = path.resolve(String(dir));
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new RemoteError('bad_request', 'that folder does not exist');
    this.folder = abs;
    return { folder: abs };
  }

  _incomingFiles(session, b, r) {
    if (typeof b.id !== 'string' || !/^cf_[0-9a-f]{16}$/.test(b.id) || !Array.isArray(b.entries) || b.entries.length > CLIP_LIMITS.entries) return;
    const entries = [];
    let total = 0;
    for (const e of b.entries) {
      const rel = safeRel(e?.rel);
      if (!rel || !Number.isSafeInteger(e.size) || e.size < 0) return;
      total += e.dir ? 0 : e.size;
      entries.push({ rel, size: e.dir ? 0 : e.size, dir: e.dir === true });
    }
    if (total > CLIP_LIMITS.filesBytes) { this.desk.audit('clip.refused', { peerId: session.peerId, item: 'files', reason: 'too_large' }); return; }
    for (const [id, f] of this.inFiles) if (f.sessionId === session.id && f.state === 'offered') this.inFiles.delete(id);
    const f = { id: b.id, sessionId: session.id, peerId: session.peerId, name: r.name, entries, total, state: 'offered', done: 0, files: entries.filter((e) => !e.dir).length, at: this.now() };
    this.inFiles.set(f.id, f);
    this._hashes(session.id).in = itemHash({ kind: 'files', entries });
    this.desk.audit('clip.sync', { peerId: session.peerId, dir: 'in', item: 'files', items: entries.length, bytes: total });
    this.emit('files', { id: f.id, sessionId: f.sessionId, name: f.name, count: entries.length, total });
    if (total <= this.autoFetchBytes) this.fetch(f.id).catch(() => {});
  }

  /** The receiver pastes: asks the sender for the copied files. */
  async fetch(id) {
    const f = this.inFiles.get(String(id));
    if (!f || f.state !== 'offered') throw new RemoteError('not_found', 'those copied files are no longer offered');
    const gate = this._canReceive({ id: f.sessionId, peerId: f.peerId });
    if (!gate.ok) throw new RemoteError('forbidden', 'clipboard sync is not allowed right now');
    const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, '-').slice(0, 19);
    f.base = path.join(this.folder || path.join(this.root, peerFolder(f.name, f.peerId), 'clipboard'), stamp);
    await fsp.mkdir(f.base, { recursive: true });
    for (const e of f.entries) if (e.dir) await fsp.mkdir(path.join(f.base, ...e.rel.split('/')), { recursive: true });
    f.state = 'fetching';
    this.p2p.send(f.sessionId, 1, 'clip.files.get', { id: f.id });
    if (!f.files) await this._filesDone(f);
    return { folder: f.base };
  }

  _receiveDir(session, offer) {
    const f = this.inFiles.get(offer.clipId);
    if (!f || f.state !== 'fetching' || f.sessionId !== session.id || f.peerId !== session.peerId) return null;
    const rel = safeRel(offer.rel);
    if (!f.entries.some((e) => !e.dir && e.rel === rel && e.size === offer.size)) return null;
    if (!this._canReceive(session).ok) return null;
    return f.base;
  }

  _fileArrived(r) {
    if (!r.clipId) return;
    const f = this.inFiles.get(r.clipId);
    if (!f) return;
    f.done++;
    if (f.done >= f.files) this._filesDone(f).catch(() => {});
    else this.emit('changed');
  }

  async _filesDone(f) {
    f.state = 'done';
    const tops = [...new Set(f.entries.map((e) => e.rel.split('/')[0]))].map((n) => path.join(f.base, n)).filter((p) => fs.existsSync(p));
    let native = false;
    if (this._localLock() === 'unlocked') {
      if (this.desk.helper?.clipSet) native = this.desk.helper.clipSet({ kind: 'files', paths: tops });
      else if (this.provider) native = await this.provider.set({ kind: 'files', paths: tops });
    }
    this.desk.audit('clip.files.done', { peerId: f.peerId, items: f.entries.length, bytes: f.total, native });
    this.emit('filesDone', { id: f.id, sessionId: f.sessionId, folder: f.base, count: f.entries.length, native });
    this.inFiles.delete(f.id);
  }

  async _sendFiles(session, b) {
    const o = this.outFiles.get(b?.id);
    if (!o || o.sessionId !== session.id || this.now() - o.at > OUT_KEEP_MS) return;
    if (!this.canSend(session.id)) { this.desk.audit('clip.refused', { peerId: session.peerId, item: 'files.get', reason: 'not_allowed' }); return; }
    this.outFiles.delete(b.id);
    for (const [rel, abs] of o.map) {
      if (!this.canSend(session.id)) return;
      try { await this.transfers.offer(session.id, abs, { clipId: b.id, rel }); } catch { /* the file moved; the receiver counts it as failed */ }
    }
  }

  close() {
    for (const off of this.offs) { try { off(); } catch { /* gone */ } }
    this.provider?.close?.();
    for (const id of this.active) this.desk.dropHelper(`clip:${id}`);
    this.active.clear();
  }
}

/** A clipboard message of the Windows helper ({ text, html, png, files } in base64) as an item. */
export function decodeNative(m) {
  const b = (s) => (typeof s === 'string' ? Buffer.from(s, 'base64') : null);
  if (Array.isArray(m?.files) && m.files.length) return { kind: 'files', paths: m.files.map((f) => b(f)?.toString('utf8')).filter(Boolean) };
  if (typeof m?.png === 'string') return { kind: 'image', png: b(m.png) };
  if (typeof m?.text === 'string' || typeof m?.html === 'string') {
    const text = b(m.text)?.toString('utf8') || '';
    const html = m.html ? b(m.html).toString('utf8') : undefined;
    return { kind: 'text', text, html };
  }
  return null;
}

/** An item of the Linux clipboard provider. */
export function fromProvider(raw) {
  if (raw?.files) return { kind: 'files', paths: raw.files };
  if (raw?.png) return { kind: 'image', png: raw.png };
  if (raw && (raw.text || raw.html)) return { kind: 'text', text: raw.text || '', html: raw.html };
  return null;
}
