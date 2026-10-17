// Code together in the browser: one session per desktop, shared by the Code together window, the
// Code editor and the presence avatars in the top bar.
//   solo   no session; documents load from and save to this PC's engine
//   host   this desktop shares its session; guests join with six words
//   guest  this desktop shows a host's session (ui/js/net.js useRemote)
// Pairing is the Lend your PC pairing (six words, QR code or link, confirmation words from both
// DTLS fingerprints) with the collab frames.

import { Emitter } from '../core/emitter.js';
import { LendJoin, LendOffer } from '../core/session.js';
import { COLLAB_CODEC, COLLAB_LIMITS } from './frames.js';
import { CollabGuest, CollabHost, HOST_ID } from './session.js';
import { DocHub } from './docs.js';
import { HostBridge, LenderBridge } from '../core/bridge.js';
import { normalizeFrame } from '../core/frames.js';

const PAIR = () => ({ ...(globalThis.hivedeskLendOptions || {}), codec: COLLAB_CODEC, limits: COLLAB_LIMITS });
const LONG = 15 * 60 * 1000;

export const COLORS = ['#f2a93b', '#7fc98f', '#6cb6ff', '#e98ad8', '#ef7d6b', '#b39cff', '#5fd4c8', '#e6d36a'];

function desktop() {
  const d = globalThis.hivedesk;
  if (!d) throw new Error('The desktop is not ready');
  return d;
}

function loadProfile() {
  try {
    const p = JSON.parse(localStorage.getItem('hivedesk.collab.me') || 'null');
    if (p && typeof p.name === 'string') return { name: p.name.slice(0, 40), color: COLORS.includes(p.color) ? p.color : COLORS[0] };
  } catch {
    // storage blocked: use the defaults
  }
  return { name: '', color: COLORS[Math.floor(Math.random() * COLORS.length)] };
}

/** The engine hello for a guest, built from this desktop's engine (REST, same token cookie). */
async function engineHello() {
  const get = async (path) => {
    const r = await fetch(path, { cache: 'no-store', credentials: 'same-origin' });
    if (!r.ok) throw new Error(`${path}: ${r.status}`);
    return r.json();
  };
  const [health, state] = await Promise.all([get('/api/health'), get('/api/state')]);
  return { kind: 'hello', protocol: health.protocol, version: health.version, demo: !!health.demo, lend: false, lastSeq: state.lastSeq || 0, state };
}

/** Sub-peer: a lend connection (frames.js of Lend your PC) carried inside the collab channel. */
class LendOverCollab extends Emitter {
  constructor(sendLend) {
    super();
    this.sendLend = sendLend;
    this.remoteHello = null;
    this.ready = true;
    this.closed = false;
  }
  receive(raw) {
    let f;
    try {
      f = normalizeFrame(raw);
    } catch (err) {
      this.emit('rejected', err);
      return;
    }
    if (f.t === 'hello') this.remoteHello = f;
    this.emit('frame', f);
    if (f.t === 'stop') this.close(f.reason);
  }
  send(f) {
    if (this.closed) throw new Error('closed');
    this.sendLend(normalizeFrame(f));
  }
  confirmLocal() {}
  stop(reason = 'stopped') {
    if (this.closed) return;
    try {
      this.send({ t: 'stop', reason });
    } catch {
      // gone
    }
    this.close(reason);
  }
  close(reason) {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', reason);
  }
}

class Collab extends Emitter {
  constructor() {
    super();
    this.mode = 'solo';
    this.host = null;
    this.guest = null;
    this.pending = []; // host: guests waiting for the confirmation words
    this.profile = loadProfile();
    this.solo = null;
    this.lends = new Map(); // guest id -> { peer, bridge } on the host
    this.lender = null; // guest: { peer, bridge } when lending its brain to the host
  }

  setProfile({ name, color }) {
    this.profile = { name: String(name || '').trim().slice(0, 40) || 'Guest', color: COLORS.includes(color) ? color : this.profile.color };
    try {
      localStorage.setItem('hivedesk.collab.me', JSON.stringify(this.profile));
    } catch {
      // not remembered, that is fine
    }
  }

  /** The documents the editor binds to in the current mode. */
  docs() {
    if (this.mode === 'host') return this.host.docs;
    if (this.mode === 'guest' && this.guest?.docs) return this.guest.docs;
    this.solo ??= new DocHub({
      client: 'solo',
      transport: {
        load: async (path) => {
          try {
            const r = await desktop().command('files.read', { path });
            return { text: r.content || '' };
          } catch (err) {
            if (err.code === 'not_found' || /not found|no such/i.test(err.message)) return { text: '' };
            throw err;
          }
        },
        send: () => {},
        save: (path, content) => desktop().command('files.write', { path, content }, { timeout: LONG }),
      },
    });
    return this.solo;
  }

  /** My id in the session ('h' for the host, 'solo' alone). */
  myId() {
    if (this.mode === 'host') return HOST_ID;
    if (this.mode === 'guest') return this.guest?.me?.id || 'guest';
    return 'solo';
  }

  role() {
    if (this.mode === 'guest') return this.guest?.role || 'viewer';
    return 'host';
  }

  canEdit() {
    return this.mode !== 'guest' || !!this.guest?.canEdit;
  }

  /** Everyone in the session, me included: [{ id, name, color, role, file }]. */
  people() {
    if (this.mode === 'host') return this.host.people();
    if (this.mode === 'guest') return this.guest?.peers || [];
    return [];
  }

  /** Other people's cursors: Map id -> { file, sel }. */
  presence() {
    if (this.mode === 'host') {
      const m = new Map();
      for (const g of this.host.guests.values()) if (g.welcomed && g.file) m.set(g.id, { file: g.file, sel: g.sel });
      return m;
    }
    if (this.mode === 'guest') return this.guest?.presence || new Map();
    return new Map();
  }

  setPresence(p) {
    if (this.mode === 'host') this.host.setPresence(p);
    else if (this.mode === 'guest') this.guest?.setPresence(p);
  }

  _changed() {
    this.emit('change', this.mode);
  }

  /* ---------- host ---------- */

  startHosting() {
    if (this.mode === 'guest') throw new Error('Leave the session you joined first');
    if (this.host) return this.host;
    const d = desktop();
    const host = new CollabHost({
      hive: { command: (t, data, o) => d.command(t, data, o), on: (k, fn) => d.on(k, fn), hello: engineHello },
      name: this.profile.name || 'Host',
      color: this.profile.color,
    });
    this.host = host;
    this.mode = 'host';
    host.on('peers', () => this.emit('people'));
    host.on('presence', (p) => this.emit('presence', p));
    host.on('joined', (g) => this.emit('joined', g));
    host.on('left', (g, reason) => {
      this.lends.get(g.id)?.peer.close('the guest left');
      this.lends.delete(g.id);
      this.emit('left', g, reason);
    });
    host.on('lend', (g, raw) => this._hostLend(g, raw));
    this._changed();
    return host;
  }

  /** Makes new six words for one more guest. Resolves with { words, offer }. */
  async invite() {
    const host = this.startHosting();
    const offer = new LendOffer(PAIR());
    const entry = { offer, words: null, confirm: null, peer: null, record: null, state: 'waiting' };
    this.pending.push(entry);
    offer.on('connected', (peer, words) => {
      entry.peer = peer;
      entry.confirm = words;
      entry.state = 'confirm';
      entry.record = host.addGuest(peer);
      peer.on('close', () => {
        entry.state = 'closed';
        this.emit('invites');
      });
      peer.on('ready', () => {
        entry.state = 'joined';
        this.emit('invites');
      });
      this.emit('invites');
    });
    offer.on('failed', (reason) => {
      entry.state = 'failed';
      entry.reason = reason;
      this.emit('invites');
    });
    offer.on('expired', () => {
      entry.state = 'expired';
      this.emit('invites');
    });
    entry.words = await offer.start();
    this.emit('invites');
    return entry;
  }

  /** The host checked the confirmation words of a waiting guest. */
  confirmGuest(entry, ok) {
    if (!entry.peer) return;
    if (ok) entry.peer.confirmLocal();
    else {
      entry.peer.stop('The confirmation words did not match');
      entry.state = 'mismatch';
    }
    this.emit('invites');
  }

  stopHosting(reason) {
    if (!this.host) return;
    for (const e of this.pending) e.offer.stop();
    this.pending = [];
    for (const l of this.lends.values()) l.bridge.stop('The session ended');
    this.lends.clear();
    this.host.stop(reason);
    this.host = null;
    this.mode = 'solo';
    this._changed();
  }

  _hostLend(g, raw) {
    let l = this.lends.get(g.id);
    if (!l) {
      const peer = new LendOverCollab((f) => g.peer.send({ t: 'lend', f }));
      const d = desktop();
      const hive = {
        command: (t, data, o) => d.command(t, data, o),
        notify: (type, data) => d.send({ kind: 'command', id: `n${Date.now().toString(36)}`, type, data }),
        on: (k, fn) => d.on(k, fn),
      };
      peer.receive(raw);
      if (peer.remoteHello?.role !== 'lender') return;
      const bridge = new HostBridge({ hive, peer, label: this.profile.name || 'host' });
      l = { peer, bridge };
      this.lends.set(g.id, l);
      bridge.on('attached', () => this.emit('people'));
      bridge.on('detached', () => {
        this.lends.delete(g.id);
        this.emit('people');
      });
      return;
    }
    l.peer.receive(raw);
  }

  /** Brains guests lend to this host: Map guest id -> brain id. */
  lentBrains() {
    const m = new Map();
    for (const [id, l] of this.lends) if (l.bridge.brainId) m.set(id, l.bridge.brainId);
    return m;
  }

  /* ---------- guest ---------- */

  /** Knocks with six words. Resolves once the WebRTC link is open with { guest, confirm }. */
  join(words) {
    if (this.mode === 'host') throw new Error('Stop sharing your session first');
    this.leave();
    return new Promise((resolve, reject) => {
      const join = new LendJoin(PAIR());
      this.joining = join;
      join.on('timeout', () => reject(Object.assign(new Error('The host did not answer. Check the words and that the host still shows them.'), { code: 'timeout' })));
      join.on('failed', (reason) => reject(Object.assign(new Error(String(reason)), { code: 'failed' })));
      join.on('connected', (peer, confirm) => {
        const guest = new CollabGuest({ peer, name: this.profile.name || 'Guest', color: this.profile.color });
        this.guest = guest;
        guest.on('welcome', () => this._welcomed());
        guest.on('role', () => this.emit('role'));
        guest.on('peers', () => this.emit('people'));
        guest.on('presence', (p) => this.emit('presence', p));
        guest.on('lend', (raw) => this.lender?.peer.receive(raw));
        guest.on('closed', (reason) => this._guestClosed(reason));
        resolve({ guest, confirm, peer });
      });
      join.start(words).catch(reject);
    });
  }

  confirmHost(peer, ok) {
    if (ok) peer.confirmLocal();
    else peer.stop('The confirmation words did not match');
  }

  async _welcomed() {
    const guest = this.guest;
    const transport = {
      onFrame: null,
      send: (frame) => {
        if (frame?.kind !== 'command') return;
        const timeout = frame.type === 'files.write' ? LONG : 120000;
        guest.command(frame.type, frame.data || {}, { timeout }).then(
          (result) => transport.onFrame?.({ kind: 'reply', id: frame.id, ok: true, result }),
          (err) => transport.onFrame?.({ kind: 'reply', id: frame.id, ok: false, error: { code: err.code || 'internal', message: err.message } }),
        );
      },
    };
    guest.on('engine', (f) => transport.onFrame?.(f));
    this.transport = transport;
    this.mode = 'guest';
    const net = await import('/js/net.js');
    net.useRemote(transport);
    transport.onFrame?.({ ...guest.hostHello, kind: 'hello' });
    this._changed();
    this.emit('people');
  }

  /** The guest lends its own brain to the host (Lend your PC inside the session). */
  async lendMyBrain() {
    if (this.mode !== 'guest' || this.lender) return this.lender;
    const { lendSocket } = await import('../index.js');
    const local = await lendSocket();
    await local.command('lend.enable');
    const peer = new LendOverCollab((f) => this.guest._send({ t: 'lend', f }));
    const model = local.hello?.state?.brain?.model;
    const bridge = new LenderBridge({ hive: local, peer, info: { label: this.profile.name || 'guest', model }, chatCommand: 'lend.chat' });
    this.lender = { peer, bridge };
    bridge.on('stopped', () => {
      this.lender = null;
      local.command('lend.stop', { reason: 'stopped' }).catch(() => {});
      this.emit('lending', false);
    });
    this.emit('lending', true);
    return this.lender;
  }

  stopLendingMyBrain() {
    this.lender?.bridge.stop('The guest stopped lending');
  }

  leave(reason = 'The guest left') {
    this.joining?.stop();
    this.joining = null;
    if (this.guest) this.guest.leave(reason);
  }

  async _guestClosed(reason) {
    this.lender?.bridge.stop('The session ended');
    this.lender = null;
    this.guest = null;
    this.transport = null;
    if (this.mode === 'guest') {
      this.mode = 'solo';
      const net = await import('/js/net.js');
      net.useRemote(null);
    }
    this._changed();
    this.emit('ended', reason);
  }
}

export const collab = new Collab();
globalThis.hivedeskCollab = collab;
