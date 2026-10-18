// City membership over p2p (PLAN sections 2 and 4): the adapter between the city and the p2p
// control plane of Stream 2. Node is the authority: a peer's identity comes from its verified
// session, never from the browser, and every city command it sends is checked against the
// capabilities this engine granted it before it reaches the city.
//
// Host side:  `city.cmd` frames from a peer run as that peer (who = the verified PeerId); the
//             host's city events go back as `city.event` frames to every peer holding city.view
//             or city.member; a peer with city.member brings a building and its agents
//             (CityMembership, logged as city.member.joined / left).
// Guest side: `visit(hostPeerId)` joins a friend's city with this machine and its agents, keeps
//             a replica of that CityState from the `city.event` frames, and offers it to this
//             engine's own window (live frame `city.remote`, commands city.remote.*).
//
// The p2p facade this adapter needs (Stream 2 provides it, see docs/1.0/NOTES-p2p.md):
//   p2p.peerId                        this engine's PeerId
//   p2p.on(name, fn) -> off           'session.open' ({ peerId, sessionId, via }), 'session.closed' ({ peerId, reason }),
//                                     'grants.changed' ({ peerId })
//   p2p.onMessage(type, fn) -> off    fn(peerId, body) for 'city.cmd', 'city.event', 'city.reply'
//   p2p.send(peerId, type, body)      sends one control plane message (stream 1)
//   p2p.hasGrant(peerId, capability)  a valid grant this engine issued to that peer, now
//   p2p.grantsOf(peerId)              Grant[] this engine issued to that peer
//   p2p.peer(peerId)                  Peer | null (identity.name, identity.fingerprint)
// and, optionally, from the compute plane (Stream 3):
//   compute.peerBrainId(peerId)       the id of a requester brain in the scheduler whose turns
//                                     run as compute.inference jobs on that peer, or null

import { createHash } from 'node:crypto';
import { initialCity, reduceCity, isCityEvent } from './state.js';

/** Commands a peer may send with city.view only: look, sync, move its cursor. */
export const VIEW_COMMANDS = new Set(['city.state', 'city.sync', 'city.presence']);
/** Commands that need city.member: bring a building, its agents, tasks it owns, borrows. */
export const MEMBER_COMMANDS = new Set([
  'city.machine.join', 'city.machine.update', 'city.machine.leave',
  'city.task.create', 'city.task.assign', 'city.task.move', 'city.task.approve', 'city.task.reject', 'city.task.retry', 'city.task.cancel',
  'city.agent.update', 'city.agent.move', 'city.agent.retire', 'city.agent.wake',
  'city.borrow.request', 'city.borrow.answer', 'city.borrow.stop'
]);
/** Never for a peer, whatever it holds: the host's own agents, rooms, pipeline and onboarding. */
export const HOST_ONLY = new Set([
  'city.agent.hire', 'city.agent.grant', 'city.agents.local', 'city.agents.save', 'city.room.add', 'city.room.update', 'city.room.remove',
  'city.pipeline.set', 'city.name.set', 'city.onboard.done', 'city.agent.memory.list', 'city.agent.memory.add', 'city.agent.memory.update', 'city.agent.memory.delete'
]);

/** The capability a peer needs for a city command, or null when no capability allows it. */
export function capabilityFor(type) {
  if (HOST_ONLY.has(type)) return null;
  if (VIEW_COMMANDS.has(type)) return 'city.view';
  if (MEMBER_COMMANDS.has(type)) return 'city.member';
  return null;
}

/** A peer's building id: "m_" + 8 hex of the PeerId's hash, so no peer can take another's building. */
export function machineIdFor(peerId) {
  return `m_${createHash('sha256').update(String(peerId)).digest('hex').slice(0, 8)}`;
}

/** Event types that never leave the host engine: they carry nothing the city view needs. */
const PRIVATE = new Set(['city.agent.memory']);

/** A copy of a host event safe for a peer: crew events lose free text details. */
export function eventForPeer(e) {
  if (!isCityEvent(e) || PRIVATE.has(e.type)) return null;
  const out = { seq: e.seq, ts: e.ts, type: e.type, data: e.data };
  if (e.demo) out.demo = true;
  if (e.type === 'worker.status') out.data = { workerId: e.data?.workerId, status: e.data?.status };
  if (e.type === 'turn.started') out.data = { workerId: e.data?.workerId, brainId: e.data?.brainId };
  return out;
}

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export class CityMembership {
  /**
   * @param {{ city: import('./index.js').City, p2p: any, compute?: any, cityId?: string, now?: () => number,
   *   onRemote?: (hostPeerId: string, event: any) => void }} opts
   */
  constructor(opts) {
    this.city = opts.city;
    this.p2p = opts.p2p;
    this.compute = opts.compute || null;
    this.now = opts.now || Date.now;
    this.cityId = opts.cityId || `${opts.p2p.peerId}:${opts.city.machineId}`;
    /** peerId -> { sessionId, via } peers with an open session */
    this.sessions = new Map();
    /** hostPeerId -> { city: CityState, name, machineId, pending: Map(id -> { resolve, reject, timer }) } friends' cities this engine visits */
    this.visits = new Map();
    this.n = 0;
    this.offs = [];
    this.onRemote = opts.onRemote || null;
    /** The engine's command router (src/core/router.js): the second check, with the verified peer origin. */
    this.router = opts.router || null;
  }

  start() {
    const p = this.p2p;
    this.offs.push(
      p.on('session.open', (s) => this._open(s)),
      p.on('session.closed', (s) => this._closed(s)),
      p.on('grants.changed', (s) => this._grants(s?.peerId)),
      p.onMessage('city.cmd', (peerId, body) => this._command(peerId, body)),
      p.onMessage('city.event', (peerId, body) => this._remoteEvent(peerId, body)),
      p.onMessage('city.reply', (peerId, body) => this._reply(peerId, body)),
      this.city.bus.on((e) => this._forward(e))
    );
    return this;
  }

  close() {
    for (const off of this.offs.splice(0)) { try { off?.(); } catch { /* ignore */ } }
    for (const v of this.visits.values()) for (const x of v.pending.values()) { clearTimeout(x.timer); x.reject(Object.assign(new Error('closed'), { code: 'closed' })); }
  }

  // ---------------------------------------------------------------- host side
  /** Who a peer is, from its verified session: never from fields it sends. */
  who(peerId) {
    const peer = this.p2p.peer?.(peerId);
    const name = str(peer?.identity?.name || '', 40) || 'Friend';
    return { guest: true, id: peerId, name, owner: `peer:${peerId}`, peerId };
  }

  allowed(peerId, type) {
    const cap = capabilityFor(type);
    if (!cap) return false;
    if (this.p2p.hasGrant(peerId, cap)) return true;
    // city.member includes everything city.view allows
    return cap === 'city.view' && this.p2p.hasGrant(peerId, 'city.member');
  }

  async _command(peerId, body) {
    const id = str(body?.id, 40) || null;
    const type = str(body?.type, 60);
    const answer = (msg) => { try { this.p2p.send(peerId, 'city.reply', { re: id, ...msg }); } catch { /* the session is gone */ } };
    try {
      if (!type.startsWith('city.')) throw Object.assign(new Error('not a city command'), { code: 'bad_request' });
      if (!this.allowed(peerId, type)) throw Object.assign(new Error(`${type} needs ${capabilityFor(type) || 'the host'}`), { code: 'forbidden' });
      const fn = this.city.handler(type);
      if (!fn) throw Object.assign(new Error(`unknown command ${type}`), { code: 'unknown_command' });
      const data = body?.data && typeof body.data === 'object' ? { ...body.data } : {};
      delete data.as;
      const who = this.who(peerId);
      const origin = { kind: 'peer', peerId };
      let result;
      if (type === 'city.machine.join') {
        // The router checks the grant again; the join itself needs the membership's own building rules.
        const ok = this.router ? this.router.authz(origin, type, data) : { ok: true };
        if (!ok.ok) throw Object.assign(new Error(ok.message), { code: ok.code });
        this.city._rate(who);
        result = this._join(peerId, data, who);
      } else if (this.router?.has(type)) {
        // The Node router runs it as the verified peer: capability, local only families, rate limit, and data.as from the session.
        result = await this.router.dispatch(type, data, { origin, peerName: who.name });
      } else result = await fn(data, who, null);
      answer({ ok: true, result: result ?? {} });
    } catch (err) {
      answer({ ok: false, error: { code: err.code || 'internal', message: String(err.message || err).slice(0, 300) } });
    }
  }

  /** A peer with city.member brings its building: the id comes from its PeerId and no host brain is ever linked. */
  _join(peerId, data, who) {
    const machineId = machineIdFor(peerId);
    const m = data.machine && typeof data.machine === 'object' ? data.machine : {};
    const brainId = this.compute?.peerBrainId?.(peerId) || null;
    if (brainId) this.city.noteBrainOwner(brainId, who.owner);
    const via = this.sessions.get(peerId)?.via === 'known' ? 'known' : 'invite';
    const res = this.city.joinMachine({
      machine: { id: machineId, name: m.name || who.name, color: m.color, gpu: m.gpu, ramBytes: m.ramBytes, cpus: m.cpus, model: m.model },
      agents: data.agents, brainId, via
    }, who.owner, { peerId });
    const grants = (this.p2p.grantsOf?.(peerId) || []).filter((g) => !g.revokedAt).map((g) => g.id).filter(Boolean);
    // the name and avatar the peer showed over its session (src/p2p/, sanitized there), never what the frame says
    const prof = this.p2p.peer?.(peerId)?.profile;
    const member = { cityId: this.cityId, peerId, machineId, joinedAt: new Date(this.now()).toISOString(), via, grants, agents: res.agents, ...(prof ? { profile: { name: prof.name, avatar: prof.avatar } } : {}) };
    this.city.emit('city.member.joined', { member });
    return { ...res, cityId: this.cityId };
  }

  _open(s) {
    if (!s?.peerId) return;
    this.sessions.set(s.peerId, { sessionId: s.sessionId || null, via: s.via || 'invite' });
  }

  _closed(s) {
    const peerId = s?.peerId;
    if (!peerId) return;
    this.sessions.delete(peerId);
    this._leave(peerId, s.reason === 'revoked' ? 'revoked' : 'peer_lost');
    const v = this.visits.get(peerId);
    if (v) this._endVisit(peerId, 'peer_lost');
  }

  _grants(peerId) {
    if (!peerId) return;
    if (!this.p2p.hasGrant(peerId, 'city.member')) this._leave(peerId, 'revoked');
    else {
      const mem = this.city.state.members?.[peerId];
      if (mem && !mem.leftAt) {
        const grants = (this.p2p.grantsOf?.(peerId) || []).filter((g) => !g.revokedAt).map((g) => g.id).filter(Boolean);
        this.city.emit('city.member.updated', { member: { peerId, grants } });
      }
    }
  }

  _leave(peerId, reason) {
    const mem = this.city.state.members?.[peerId];
    if (!mem || mem.leftAt) return;
    const m = this.city.state.machines[mem.machineId];
    if (m && m.online) this.city.leaveMachine(mem.machineId, reason);
    this.city.emit('city.member.left', { peerId, reason });
  }

  /** Host events go to every peer that may see the city. */
  _forward(e) {
    if (!this.sessions.size) return;
    const out = eventForPeer(e);
    if (!out) return;
    for (const peerId of this.sessions.keys()) {
      if (!this.p2p.hasGrant(peerId, 'city.view') && !this.p2p.hasGrant(peerId, 'city.member')) continue;
      try { this.p2p.send(peerId, 'city.event', { event: out }); } catch { /* the session is gone */ }
    }
  }

  // ---------------------------------------------------------------- guest side
  /** Sends a city command to a friend's engine and waits for its answer (10 s deadline). */
  remoteCommand(hostPeerId, type, data = {}, timeoutMs = 10_000) {
    const v = this.visits.get(hostPeerId) || this._visit(hostPeerId);
    const id = `rc_${++this.n}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        v.pending.delete(id);
        reject(Object.assign(new Error(`${type}: no answer from the friend's engine within ${Math.round(timeoutMs / 1000)} s`), { code: 'timeout' }));
      }, timeoutMs);
      timer.unref?.();
      v.pending.set(id, { resolve, reject, timer });
      try { this.p2p.send(hostPeerId, 'city.cmd', { id, type, data }); } catch (err) { clearTimeout(timer); v.pending.delete(id); reject(err); }
    });
  }

  _visit(hostPeerId) {
    const v = { city: initialCity(), name: str(this.p2p.peer?.(hostPeerId)?.identity?.name || '', 40) || 'Friend', machineId: null, pending: new Map(), joined: false };
    this.visits.set(hostPeerId, v);
    return v;
  }

  /** Visit a friend's city: bring this machine and its agents, then load the city. */
  async visit(hostPeerId) {
    const v = this.visits.get(hostPeerId) || this._visit(hostPeerId);
    const local = this.city.localAgents();
    const joined = await this.remoteCommand(hostPeerId, 'city.machine.join', { machine: local.machine, agents: local.agents.slice(0, 16) });
    v.machineId = joined.machineId;
    v.localIds = new Map((local.agents || []).map((a) => [`${joined.machineId}:${a.id}`, a.id]));
    const sync = await this.remoteCommand(hostPeerId, 'city.sync', {});
    v.city = sync.snapshot ? JSON.parse(JSON.stringify(sync.snapshot)) : initialCity();
    for (const e of sync.tail || []) if (e.seq > (v.city.lastSeq || 0)) reduceCity(v.city, e);
    v.joined = true;
    this.city.emit('city.visit.started', { hostPeerId, name: v.name, machineId: v.machineId });
    this.onRemote?.(hostPeerId, { type: 'snapshot' });
    return { hostPeerId, machineId: v.machineId, city: v.city };
  }

  async leaveVisit(hostPeerId) {
    const v = this.visits.get(hostPeerId);
    if (!v) return {};
    if (v.machineId) await this.remoteCommand(hostPeerId, 'city.machine.leave', { machineId: v.machineId, reason: 'left' }).catch(() => {});
    this._endVisit(hostPeerId, 'left');
    return {};
  }

  _endVisit(hostPeerId, reason) {
    const v = this.visits.get(hostPeerId);
    if (!v) return;
    this.visits.delete(hostPeerId);
    for (const x of v.pending.values()) { clearTimeout(x.timer); x.reject(Object.assign(new Error(`the visit ended: ${reason}`), { code: 'peer_lost' })); }
    if (v.joined) this.city.emit('city.visit.ended', { hostPeerId, reason });
    this.onRemote?.(hostPeerId, { type: 'ended', reason });
  }

  _reply(peerId, body) {
    const v = this.visits.get(peerId);
    const x = v?.pending.get(body?.re);
    if (!x) return;
    v.pending.delete(body.re);
    clearTimeout(x.timer);
    if (body.ok) x.resolve(body.result);
    else x.reject(Object.assign(new Error(body.error?.message || 'refused'), { code: body.error?.code || 'internal' }));
  }

  _remoteEvent(peerId, body) {
    const v = this.visits.get(peerId);
    const e = body?.event;
    if (!v || !e || typeof e.seq !== 'number' || typeof e.type !== 'string') return;
    if (e.seq <= (v.city.lastSeq || 0)) return;
    reduceCity(v.city, e);
    // A level one of this machine's agents earned there is kept here.
    if (e.type === 'city.agent.leveled' && v.localIds?.has(e.data?.agentId)) {
      try { this.city.saveLocalAgents({ agents: [{ id: v.localIds.get(e.data.agentId), xp: e.data.xp }] }, { guest: false }); } catch { /* not ours */ }
    }
    this.onRemote?.(peerId, e);
  }

  /** The cities this engine visits, for its own window. */
  list() {
    return [...this.visits.entries()].filter(([, v]) => v.joined).map(([hostPeerId, v]) => ({ hostPeerId, name: v.name, machineId: v.machineId, lastSeq: v.city.lastSeq }));
  }

  remoteState(hostPeerId) {
    const v = this.visits.get(hostPeerId);
    return v?.joined ? v.city : null;
  }

  /** Registers the city.remote.* commands for this engine's own window (never for guests). */
  register(server) {
    const local = (fn) => (data) => {
      if (data && data.as) throw Object.assign(new Error('only this machine can do this'), { code: 'forbidden' });
      return fn(data && typeof data === 'object' ? data : {});
    };
    server.command('city.remote.list', local(() => ({ visits: this.list() })));
    server.command('city.remote.visit', local((d) => this.visit(str(d.hostPeerId, 64))));
    server.command('city.remote.leave', local((d) => this.leaveVisit(str(d.hostPeerId, 64))));
    server.command('city.remote.state', local((d) => {
      const c = this.remoteState(str(d.hostPeerId, 64));
      if (!c) throw Object.assign(new Error('not in that city'), { code: 'not_found' });
      return { city: c, lastSeq: c.lastSeq };
    }));
    server.command('city.remote.cmd', local((d) => {
      const type = str(d.type, 60);
      if (!capabilityFor(type)) throw Object.assign(new Error(`${type} cannot be sent to a friend's city`), { code: 'bad_request' });
      return this.remoteCommand(str(d.hostPeerId, 64), type, d.data && typeof d.data === 'object' ? d.data : {});
    }));
  }
}

/**
 * Wires city membership on an engine that has the p2p control plane. Returns null without one.
 * @returns {CityMembership | null}
 */
export function startMembership({ city, p2p, compute, server, bus, router }) {
  if (!city || !p2p) return null;
  const m = new CityMembership({
    city, p2p, compute, router,
    onRemote: (hostPeerId, event) => { try { (bus || city.bus).live('city.remote', { hostPeerId, event }); } catch { /* ignore */ } }
  }).start();
  if (server) m.register(server);
  city.membership = m;
  return m;
}
