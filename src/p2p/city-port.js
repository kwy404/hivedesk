// The p2p facade of the City membership adapter (src/city/membership.js, docs/1.0/NOTES-p2p.md of
// Stream 4) over this engine's P2PNode:
//   peerId                         this engine's PeerId
//   on(name, fn) -> off            'session.open' { peerId, sessionId, via: 'invite' | 'known' },
//                                  'session.closed' { peerId, reason }, 'grants.changed' { peerId }
//   onMessage(type, fn) -> off     fn(peerId, body) for city.cmd, city.event and city.reply; the peerId is
//                                  the verified session peer, and city.cmd arrives only after the grant check
//   send(peerId, type, body)       one control plane message
//   hasGrant(peerId, capability)   an active grant this engine gave that peer
//   grantsOf(peerId)               the active grants this engine gave that peer
//   peer(peerId)                   { identity: { peerId, name, fingerprint }, trust } or null

const EVENTS = {
  'session.open': [['peer.online', (e) => ({ peerId: e.peerId, sessionId: e.sessionId, via: e.via === 'known' ? 'known' : 'invite' })]],
  'session.closed': [['peer.offline', (e) => ({ peerId: e.peerId, reason: /blocked|revok/.test(String(e.reason)) ? 'revoked' : String(e.reason || 'closed').slice(0, 80) })]],
  'grants.changed': [
    ['grant.created', (g) => ({ peerId: g.peerId })],
    ['grant.revoked', (e) => ({ peerId: e.grant?.peerId })],
  ],
};

/**
 * @param {import('./node.js').P2PNode} node a started node
 * @param {{ viewCommands?: Iterable<string> }} [opts] city commands a peer may send with city.view only
 */
export function createCityPort(node, opts = {}) {
  for (const c of opts.viewCommands || []) node.viewCommands.add(c);
  const offs = [];
  const handlers = new Map(); // type -> fn, for refusals turned into a city.reply
  const pending = new Map(); // message id of a city.cmd -> { peerId, id: its body id }
  // A city.cmd the peer refused before any handler (not_granted, rate_limited) comes back as an
  // error message; the membership waits for a city.reply, so it gets one at once instead of a timeout.
  const onError = (e) => {
    const p = e?.re && pending.get(e.re);
    if (!p || p.peerId !== e.peerId) return;
    pending.delete(e.re);
    handlers.get('city.reply')?.(e.peerId, { re: p.id, ok: false, error: { code: String(e.code || 'error').slice(0, 40), message: String(e.message || '').slice(0, 300) } });
  };
  node.on('peer.error', onError);
  offs.push(() => node.off('peer.error', onError));
  return {
    get peerId() {
      return node.identity.peerId;
    },
    on(name, fn) {
      const list = EVENTS[name];
      if (!list) throw new TypeError(`no city port event ${name}`);
      const subs = list.map(([ev, map]) => {
        const h = (e) => {
          const out = map(e || {});
          if (out.peerId) fn(out);
        };
        node.on(ev, h);
        return () => node.off(ev, h);
      });
      const off = () => subs.forEach((s) => s());
      offs.push(off);
      return off;
    },
    onMessage(type, fn) {
      handlers.set(type, fn);
      const unhandle = node.handle(type, (msg, ctx) => fn(ctx.peerId, msg.body));
      const off = () => {
        unhandle();
        if (handlers.get(type) === fn) handlers.delete(type);
      };
      offs.push(off);
      return off;
    },
    send(peerId, type, body) {
      const mid = node.send(peerId, type, body);
      if (type === 'city.cmd' && typeof body?.id === 'string' && mid) {
        pending.set(mid, { peerId, id: body.id });
        while (pending.size > 500) pending.delete(pending.keys().next().value);
      }
      return mid;
    },
    hasGrant: (peerId, capability) => !!node.can(peerId, capability),
    grantsOf: (peerId) => node.grantsOf(peerId).map((g) => ({ id: g.id, peerId: g.peerId, capability: g.capability, scope: g.scope, expiresAt: g.expiresAt, ...(g.revokedAt ? { revokedAt: g.revokedAt } : {}) })),
    peer(peerId) {
      const p = node.peers.get(peerId);
      if (!p) return null;
      const profile = node.profileOf?.(peerId) || null;
      return { identity: { peerId: p.identity.peerId, name: p.identity.name, fingerprint: p.identity.fingerprint }, trust: p.trust, ...(profile ? { profile } : {}) };
    },
    close() {
      for (const off of offs.splice(0)) {
        try { off(); } catch { /* closing */ }
      }
    },
  };
}
