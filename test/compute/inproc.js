// Test only: an in process stand in for the p2p ComputeLink (src/compute/worker.js typedef) until Stream 2's
// sessions and grants are merged. Messages go through JSON like a real wire, asynchronously, and the
// network can drop, hold, disconnect, resume, grant and revoke, for the failure matrix tests.

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
export function peerId(seed) {
  let s = 'hd1';
  for (let i = 0; i < 49; i++) s += B32[(seed.charCodeAt(i % seed.length) + i * 7) % 32];
  return s;
}

export class Net {
  constructor() {
    /** @type {Map<string, Node>} */
    this.nodes = new Map();
    this.down = new Set();        // "a|b" pairs with no session
    this.drop = new Set();        // message types dropped in flight
    this.hold = null;             // (from, to, type, body) => boolean: true holds the message forever
    this.log = [];
  }

  node(name) {
    const n = new Node(this, peerId(name), name);
    this.nodes.set(n.selfId, n);
    return n;
  }

  _pair(a, b) { return [a, b].sort().join('|'); }
  connected(a, b) { return !this.down.has(this._pair(a, b)); }

  /** Owner `from` grants compute.inference to `to`. */
  grant(owner, to, cap = 'compute.inference', limits = null) {
    owner.issued.add(`${to.selfId}|${cap}`);
    if (limits) owner.limits.set(`${to.selfId}|${cap}`, limits);
    to.held.add(`${owner.selfId}|${cap}`);
  }

  revoke(owner, to, cap = 'compute.inference', type = 'grant.revoked') {
    owner.issued.delete(`${to.selfId}|${cap}`);
    to.held.delete(`${owner.selfId}|${cap}`);
    owner._peerEvent({ type, peerId: to.selfId, capability: cap });
    to._peerEvent({ type, peerId: owner.selfId, capability: cap });
  }

  disconnect(a, b) {
    this.down.add(this._pair(a.selfId, b.selfId));
    a._peerEvent({ type: 'offline', peerId: b.selfId });
    b._peerEvent({ type: 'offline', peerId: a.selfId });
  }

  resume(a, b) {
    this.down.delete(this._pair(a.selfId, b.selfId));
    a._peerEvent({ type: 'resumed', peerId: b.selfId });
    b._peerEvent({ type: 'resumed', peerId: a.selfId });
  }

  _deliver(from, to, type, body) {
    if (!this.connected(from, to)) return false;
    const target = this.nodes.get(to);
    if (!target) return false;
    this.log.push({ from, to, type });
    if (this.drop.has(type)) return true;
    if (this.hold?.(from, to, type, body)) return true;
    const wire = JSON.parse(JSON.stringify(body));
    setTimeout(() => {
      if (!this.connected(from, to)) return;
      for (const fn of [...target.handlers]) fn(from, type, wire);
    }, 0);
    return true;
  }
}

class Node {
  constructor(net, selfId, name) {
    this.net = net;
    this.selfId = selfId;
    this.name = name;
    this.handlers = new Set();
    this.peerHandlers = new Set();
    this.issued = new Set();
    this.limits = new Map();
    this.held = new Set();
    this.audits = [];
    this.blocked = new Set();
  }

  send(peerId, type, body) { return this.net._deliver(this.selfId, peerId, type, body); }
  onMessage(fn) { this.handlers.add(fn); return () => this.handlers.delete(fn); }
  onPeer(fn) { this.peerHandlers.add(fn); return () => this.peerHandlers.delete(fn); }
  hasGrant(peerId, cap) { return !this.blocked.has(peerId) && this.issued.has(`${peerId}|${cap}`); }
  grantLimits(peerId, cap) { return this.limits.get(`${peerId}|${cap}`) || null; }
  holdsGrant(peerId, cap) { return this.held.has(`${peerId}|${cap}`); }
  peers() {
    return [...this.net.nodes.values()].filter((n) => n !== this).map((n) => ({
      peerId: n.selfId, name: `${n.name}'s PC`, online: this.net.connected(this.selfId, n.selfId), blocked: this.blocked.has(n.selfId), rttMs: 20
    }));
  }
  audit(entry) { this.audits.push(entry); }
  _peerEvent(ev) { for (const fn of [...this.peerHandlers]) fn(ev); }
}
