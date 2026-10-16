// Code together: the host's side and the guest's side of a shared hive session.
//
// The host keeps one LendPeer per guest (the six word pairing from Lend your PC, with the
// collab frames). Its own engine frames (events and live updates) are relayed to every guest,
// whose desktop renders them as if they came from its own engine. Guest commands come back as
// cmd frames: the host checks the guest's role (roles.js) and runs them on its engine, where the
// usual approval rules apply. Shared files are CRDT documents (docs.js) that live with the host
// and are saved on the host's disk.
//
// Both classes only need small interfaces, so tests drive them with fakes:
//   hive (host): { command(type, data, opts), on(kind, fn) => off, hello() => Promise<helloFrame> }
//   peer:        a LendPeer with the collab codec

import { Emitter } from '../core/emitter.js';
import { COLLAB_PROTOCOL } from './frames.js';
import { canEdit, checkCommand, GUEST_ROLES } from './roles.js';
import { DocHub } from './docs.js';

export const HOST_ID = 'h';
const LONG = 15 * 60 * 1000; // a guest's save may wait for the host's approval

/** A person in the session: { id, name, color, role, file, sel }. */
const pub = (p) => ({ id: p.id, name: p.name, color: p.color, role: p.role, file: p.file || null });

export class CollabHost extends Emitter {
  constructor({ hive, name = 'Host', color = '#f2a93b' }) {
    super();
    this.hive = hive;
    this.me = { id: HOST_ID, name, color, role: 'host', file: null, sel: [] };
    this.guests = new Map();
    this.nextGuest = 0;
    this.offs = [];
    this.closed = false;
    this.docs = new DocHub({
      client: HOST_ID,
      transport: {
        load: (path) => this._load(path),
        send: (path, ops, from) => this._relayOps(path, ops, from || HOST_ID),
        save: (path, content) => this.hive.command('files.write', { path, content }, { timeout: LONG }),
      },
    });
    this.offs.push(hive.on('event', (f) => this._engine(f)));
    this.offs.push(hive.on('live', (f) => this._engine(f)));
  }

  async _load(path) {
    try {
      const r = await this.hive.command('files.read', { path });
      return { text: typeof r.content === 'string' ? r.content : '' };
    } catch (err) {
      if (err.code === 'not_found' || /not found|no such|ENOENT/i.test(err.message)) return { text: '' };
      throw err;
    }
  }

  /** People in the session, the host first. */
  people() {
    return [pub(this.me), ...[...this.guests.values()].filter((g) => g.welcomed).map(pub)];
  }

  /** Adds a guest connected over a confirmed (or soon confirmed) peer. Returns the guest record. */
  addGuest(peer, { role = 'viewer' } = {}) {
    const g = { id: `g${++this.nextGuest}`, name: 'Guest', color: '#7fc98f', role, peer, file: null, sel: [], welcomed: false, queue: [], docs: new Set() };
    this.guests.set(g.id, g);
    peer.send({ t: 'hello', v: COLLAB_PROTOCOL, role: 'host', name: this.me.name, color: this.me.color });
    peer.on('frame', (f) => this._frame(g, f).catch((err) => this.emit('error', err)));
    peer.on('ready', () => this._welcome(g));
    peer.on('close', (reason) => this._left(g, reason));
    if (peer.ready) this._welcome(g);
    return g;
  }

  async _welcome(g) {
    if (g.welcomed || g.welcoming || this.closed) return;
    g.welcoming = true;
    const hello = peerHello(g.peer);
    if (hello) Object.assign(g, { name: hello.name, color: hello.color });
    try {
      const engineHello = await this.hive.hello();
      g.peer.send({ t: 'welcome', you: { id: g.id, role: g.role }, hello: engineHello });
      g.welcomed = true;
      for (const f of g.queue.splice(0)) if ((f.frame.event?.seq ?? Infinity) > (engineHello.lastSeq ?? 0) || f.frame.kind === 'live') this._sendTo(g, f);
      this._peers();
      this.emit('joined', pub(g));
    } catch (err) {
      g.peer.stop(`The host could not share the session: ${err.message}`);
    }
  }

  _sendTo(g, frame) {
    try {
      g.peer.send(frame);
    } catch {
      // the guest is gone; its close event cleans up
    }
  }

  _engine(f) {
    if (this.closed) return;
    // The crew (or anyone) changed a file on disk: an open shared document follows.
    const ev = f.kind === 'event' ? f.event : null;
    // Saves made from the editor (by the host or a guest) are already in the document.
    const fromEditor = ev?.data?.workerId === 'user' || String(ev?.data?.workerId || '').startsWith('guest');
    if (ev?.type === 'file.changed' && !fromEditor && typeof ev.data?.content === 'string') this.fileChanged(ev.data.path, ev.data.content);
    const frame = { t: 'engine', frame: f };
    for (const g of this.guests.values()) {
      if (g.welcomed) this._sendTo(g, frame);
      else if (g.welcoming && g.queue.length < 5000) g.queue.push(frame);
    }
  }

  _peers() {
    const peers = this.people();
    for (const g of this.guests.values()) if (g.welcomed) this._sendTo(g, { t: 'peers', peers });
    this.emit('peers', peers);
  }

  /** The host changes a guest's role. */
  setRole(id, role) {
    const g = this.guests.get(id);
    if (!g || !GUEST_ROLES.includes(role)) return false;
    g.role = role;
    this._sendTo(g, { t: 'role', role });
    this._peers();
    return true;
  }

  /** The host removes a guest. */
  remove(id, reason = 'The host removed you from the session') {
    const g = this.guests.get(id);
    if (!g) return;
    g.peer.stop(reason);
    this._left(g, reason);
  }

  _left(g, reason) {
    if (!this.guests.has(g.id)) return;
    this.guests.delete(g.id);
    this._relayPresence({ from: g.id, file: null, sel: [] });
    this._peers();
    this.emit('left', pub(g), reason);
  }

  async _frame(g, f) {
    if (!g.welcomed) return;
    switch (f.t) {
      case 'cmd':
        return this._command(g, f);
      case 'presence':
        g.file = f.file;
        g.sel = f.sel;
        this._relayPresence({ from: g.id, file: f.file, sel: f.sel, follow: f.follow });
        return this._peersSoon();
      case 'doc.open': {
        try {
          const h = await this.docs.open(f.path);
          g.docs.add(f.path);
          this._sendTo(g, { t: 'doc.state', path: f.path, snap: h.doc.snapshot() });
        } catch (err) {
          this._sendTo(g, { t: 'doc.state', path: f.path, snap: { runs: [], clock: 0 }, error: err.message });
        }
        return undefined;
      }
      case 'doc.op': {
        if (!canEdit(g.role)) {
          this._sendTo(g, { t: 'role', role: g.role }); // the guest's editor turns read only again
          return undefined;
        }
        if (!g.docs.has(f.path)) return undefined;
        const h = await this.docs.receive(f.path, f.ops, g.id);
        if (h) this._relayOps(f.path, f.ops, g.id);
        return undefined;
      }
      case 'lend':
        this.emit('lend', g, f.f);
        return undefined;
      default:
        return undefined;
    }
  }

  async _command(g, f) {
    let checked;
    try {
      checked = checkCommand(g, f.type, f.data);
    } catch (err) {
      this.emit('refused', pub(g), f.type);
      return this._sendTo(g, { t: 'reply', id: f.id, ok: false, error: { code: err.code || 'forbidden', message: err.message } });
    }
    try {
      const result = await this.hive.command(checked.type, checked.data, { timeout: LONG });
      this._sendTo(g, { t: 'reply', id: f.id, ok: true, result: result ?? {} });
    } catch (err) {
      this._sendTo(g, { t: 'reply', id: f.id, ok: false, error: { code: err.code || 'internal', message: err.message } });
    }
    return undefined;
  }

  _relayOps(path, ops, from) {
    for (const g of this.guests.values()) {
      if (g.id !== from && g.welcomed && g.docs.has(path)) this._sendTo(g, { t: 'doc.op', path, ops, from });
    }
  }

  _relayPresence(p) {
    for (const g of this.guests.values()) if (g.id !== p.from && g.welcomed) this._sendTo(g, { t: 'presence', ...p });
    this.emit('presence', p);
  }

  _peersSoon() {
    clearTimeout(this.peersTimer);
    this.peersTimer = setTimeout(() => this._peers(), 150);
  }

  /** The host's own cursor and file, for everyone else. */
  setPresence({ file = null, sel = [], follow } = {}) {
    const changed = file !== this.me.file;
    this.me.file = file;
    this.me.sel = sel;
    this._relayPresence({ from: HOST_ID, file, sel, follow });
    if (changed) this._peersSoon();
  }

  /** Crew or engine changed a file on disk: shared documents follow. */
  fileChanged(path, content) {
    if (typeof content !== 'string') return;
    this.docs.peek(path).then((h) => {
      if (!h || content === h.saving || content === h.savedText) return;
      h.setText(content, 'crew');
      h.savedText = content;
    });
  }

  stop(reason = 'The host ended the session') {
    if (this.closed) return;
    for (const g of [...this.guests.values()]) g.peer.stop(reason);
    this.guests.clear();
    this.closed = true;
    for (const off of this.offs) off?.();
    this.emit('stopped', reason);
  }
}

function peerHello(peer) {
  const h = peer.remoteHello;
  return h && h.role === 'guest' ? h : null;
}

/**
 * The guest's side. After welcome it exposes the host's engine hello, a command() that runs on
 * the host's engine, the shared documents and everyone's presence.
 *   events: 'welcome', 'engine' (frame), 'role', 'peers', 'presence', 'closed', 'lend'
 */
export class CollabGuest extends Emitter {
  constructor({ peer, name = 'Guest', color = '#7fc98f' }) {
    super();
    this.peer = peer;
    this.name = name;
    this.color = color;
    this.me = null;
    this.role = 'viewer';
    this.hostHello = null;
    this.peers = [];
    this.presence = new Map(); // id -> { file, sel }
    this.next = 0;
    this.waiting = new Map();
    this.docWaiters = new Map();
    this.closed = false;
    this.docs = null;
    peer.send({ t: 'hello', v: COLLAB_PROTOCOL, role: 'guest', name, color });
    peer.on('frame', (f) => this._frame(f));
    peer.on('close', (reason) => this._closed(reason));
  }

  get canEdit() {
    return canEdit(this.role);
  }

  _frame(f) {
    switch (f.t) {
      case 'welcome':
        this.me = { id: f.you.id, name: this.name, color: this.color };
        this.role = f.you.role;
        this.hostHello = f.hello;
        this.docs = new DocHub({
          client: f.you.id,
          transport: {
            load: (path) => this._load(path),
            send: (path, ops) => this._send({ t: 'doc.op', path, ops }),
            save: (path, content) => this.command('files.write', { path, content }, { timeout: LONG }),
          },
        });
        this.emit('welcome', f);
        break;
      case 'engine':
        this.emit('engine', f.frame);
        break;
      case 'reply': {
        const w = this.waiting.get(f.id);
        if (!w) break;
        this.waiting.delete(f.id);
        clearTimeout(w.timer);
        if (f.ok) w.resolve(f.result);
        else w.reject(Object.assign(new Error(f.error.message), { code: f.error.code }));
        break;
      }
      case 'role':
        this.role = f.role;
        this.emit('role', f.role);
        break;
      case 'peers':
        this.peers = f.peers;
        this.emit('peers', f.peers);
        break;
      case 'presence':
        if (!f.from) break;
        if (f.file) this.presence.set(f.from, { file: f.file, sel: f.sel });
        else this.presence.delete(f.from);
        this.emit('presence', f);
        break;
      case 'doc.state': {
        const w = this.docWaiters.get(f.path);
        if (!w) break;
        this.docWaiters.delete(f.path);
        if (f.error) w.reject(new Error(f.error));
        else w.resolve({ snap: f.snap });
        break;
      }
      case 'doc.op':
        this.docs?.receive(f.path, f.ops, f.from);
        break;
      case 'lend':
        this.emit('lend', f.f);
        break;
      default:
        break;
    }
  }

  _send(frame) {
    if (this.closed) return;
    try {
      this.peer.send(frame);
    } catch (err) {
      this.emit('error', err);
    }
  }

  _load(path) {
    return new Promise((resolve, reject) => {
      this.docWaiters.set(path, { resolve, reject });
      this._send({ t: 'doc.open', path });
      setTimeout(() => {
        if (this.docWaiters.get(path)?.resolve === resolve) {
          this.docWaiters.delete(path);
          reject(new Error('The host did not send the file'));
        }
      }, 30000);
    });
  }

  /** Runs a command on the host's engine (the host checks the role first). */
  command(type, data = {}, { timeout = 60000 } = {}) {
    const id = `q${++this.next}`;
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(Object.assign(new Error('The session ended'), { code: 'offline' }));
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(Object.assign(new Error('The host did not answer in time'), { code: 'timeout' }));
      }, timeout);
      this.waiting.set(id, { resolve, reject, timer });
      this._send({ t: 'cmd', id, type, data });
      return undefined;
    });
  }

  setPresence({ file = null, sel = [], follow } = {}) {
    this._send({ t: 'presence', file, sel, ...(follow !== undefined ? { follow } : {}) });
  }

  leave(reason = 'The guest left') {
    this.peer.stop(reason);
    this._closed(reason);
  }

  _closed(reason) {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.waiting.values()) {
      clearTimeout(w.timer);
      w.reject(Object.assign(new Error('The session ended'), { code: 'offline' }));
    }
    this.waiting.clear();
    this.emit('closed', reason);
  }
}
