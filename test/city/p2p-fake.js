// A test double of the p2p facade the city membership adapter needs (src/city/membership.js).
// Test only: two or more engines in one process, messages delivered on the next microtask, grants
// kept per issuer. The real control plane (identity, handshake, sessions, grants) is Stream 2's.

export function p2pHub() {
  const nodes = new Map();
  const node = (peerId, name) => {
    const handlers = new Map();
    const listeners = new Map();
    const grants = new Map(); // peerId -> Map(cap -> grant)
    const sent = [];
    let n = 0;
    const api = {
      peerId,
      name,
      sent,
      on(ev, fn) { if (!listeners.has(ev)) listeners.set(ev, new Set()); listeners.get(ev).add(fn); return () => listeners.get(ev).delete(fn); },
      onMessage(type, fn) { if (!handlers.has(type)) handlers.set(type, new Set()); handlers.get(type).add(fn); return () => handlers.get(type).delete(fn); },
      send(to, type, body) {
        const target = nodes.get(to);
        if (!target || !target.linked.has(peerId)) throw Object.assign(new Error('no session'), { code: 'disconnected' });
        sent.push({ to, type, body });
        const copy = JSON.parse(JSON.stringify(body));
        queueMicrotask(() => target.deliver(peerId, type, copy));
      },
      hasGrant(p, cap) { const g = grants.get(p)?.get(cap); return !!g && !g.revokedAt; },
      grantsOf(p) { return [...(grants.get(p)?.values() || [])]; },
      peer(p) { const x = nodes.get(p); return x ? { identity: { peerId: p, name: x.name } } : null; },
      // test controls
      grant(p, cap) {
        if (!grants.has(p)) grants.set(p, new Map());
        grants.get(p).set(cap, { id: `gr_${peerId.slice(-3)}${++n}`, peerId: p, capability: { name: cap }, grantedBy: 'user', grantedAt: new Date().toISOString(), expiresAt: null, scope: 'session' });
        emit('grants.changed', { peerId: p });
      },
      revoke(p, cap) {
        const g = grants.get(p)?.get(cap);
        if (g) g.revokedAt = new Date().toISOString();
        emit('grants.changed', { peerId: p });
      },
      linked: new Set(),
      deliver(from, type, body) { for (const fn of handlers.get(type) || []) fn(from, body); },
      emit: (ev, data) => emit(ev, data)
    };
    function emit(ev, data) { for (const fn of listeners.get(ev) || []) fn(data); }
    nodes.set(peerId, api);
    return api;
  };
  const link = (a, b, via = 'invite') => {
    a.linked.add(b.peerId); b.linked.add(a.peerId);
    a.emit('session.open', { peerId: b.peerId, sessionId: `ss_${a.peerId}${b.peerId}`, via });
    b.emit('session.open', { peerId: a.peerId, sessionId: `ss_${b.peerId}${a.peerId}`, via });
  };
  const unlink = (a, b, reason = 'closed') => {
    a.linked.delete(b.peerId); b.linked.delete(a.peerId);
    a.emit('session.closed', { peerId: b.peerId, reason });
    b.emit('session.closed', { peerId: a.peerId, reason });
  };
  return { node, link, unlink };
}

export const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
