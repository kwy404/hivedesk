// The ComputeLink of the compute plane (docs/1.0/protocol/compute.md, the typedef in
// src/compute/worker.js) over this engine's sessions and grants.
//   selfId                  this engine's peerId
//   send(peerId, type, b)   true when handed to an open, accepted session; the stream comes from
//                           the message table: job.cancel, job.revoke, resource.advert on 1, the
//                           other job.* on 2
//   onMessage(fn)           (peerId, type, body) for the compute types; peerId is the verified
//                           session peer, so a requester can stamp remoteOrigin with it. job.offer
//                           reaches fn only after the compute.inference grant check
//   hasGrant(peerId, cap)   an active grant this engine gave peerId
//   holdsGrant(peerId, cap) an active grant peerId gave this engine, as announced
//   peers()                 [{ peerId, name, online, blocked, rttMs }]
//   onPeer(fn)              online, resumed, offline (session closed, or no pong for 10 s),
//                           grant.revoked, grant.expired (both directions), blocked
//   audit(entry)            appends to the hash chained audit log

export const COMPUTE_TYPES = Object.freeze(['job.offer', 'job.accept', 'job.reject', 'job.heartbeat', 'job.token', 'job.result', 'job.error', 'job.cancel', 'job.revoke', 'resource.advert']);

/** @param {import('./node.js').P2PNode} node a started node */
export function createComputeLink(node) {
  const listeners = new Set();
  const peerListeners = new Set();
  const offs = [];

  const deliver = (peerId, type, body) => {
    for (const fn of [...listeners]) {
      try {
        fn(peerId, type, body);
      } catch { /* one listener never breaks another */ }
    }
  };
  for (const type of COMPUTE_TYPES) offs.push(node.handle(type, (msg, ctx) => deliver(ctx.peerId, type, msg.body)));

  const peerEvent = (ev) => {
    for (const fn of [...peerListeners]) {
      try {
        fn(ev);
      } catch { /* ignore */ }
    }
  };
  const on = (event, fn) => {
    node.on(event, fn);
    offs.push(() => node.off(event, fn));
  };
  on('peer.online', (e) => peerEvent({ type: e.resumed ? 'resumed' : 'online', peerId: e.peerId }));
  on('peer.offline', (e) => peerEvent({ type: 'offline', peerId: e.peerId, reason: String(e.reason || '') }));
  on('peer.blocked', (e) => peerEvent({ type: 'blocked', peerId: e.peerId }));
  // Grants this engine gave (worker side) and grants it holds (requester side).
  on('grant.revoked', ({ grant, reason }) => peerEvent({ type: reason === 'expired' ? 'grant.expired' : 'grant.revoked', peerId: grant.peerId, capability: grant.capability.name }));
  on('held.revoked', (e) => peerEvent({ type: e.reason === 'expired' ? 'grant.expired' : 'grant.revoked', peerId: e.peerId, capability: e.capability }));
  // The other side refused an offer before its worker saw it (a body over the bounds, a rate limit):
  // the requester gets a job.reject now instead of waiting for an answer that never comes.
  const offers = new Map(); // message id -> { peerId, jobId }
  on('peer.error', (e) => {
    const o = e?.re && offers.get(e.re);
    if (!o || o.peerId !== e.peerId) return;
    offers.delete(e.re);
    const code = e.code === 'rate_limited' ? 'rate_limited' : e.code === 'not_granted' ? 'not_granted' : 'bad_input';
    deliver(e.peerId, 'job.reject', { jobId: o.jobId, code, detail: String(e.message || e.code || '').slice(0, 300) });
  });

  return {
    get selfId() {
      return node.identity.peerId;
    },
    send(peerId, type, body) {
      try {
        const mid = node.send(peerId, type, body);
        if (type === 'job.offer' && typeof body?.job?.id === 'string') {
          offers.set(mid, { peerId, jobId: body.job.id });
          while (offers.size > 200) offers.delete(offers.keys().next().value);
        }
        return true;
      } catch {
        return false;
      }
    },
    onMessage(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    hasGrant: (peerId, cap) => !!node.can(peerId, cap),
    grantLimits: (peerId, cap) => node.can(peerId, cap)?.capability?.limits || null,
    holdsGrant: (peerId, cap) => node.peers.get(peerId)?.trust !== 'blocked' && node.held(peerId).some((g) => g.capability.name === cap),
    peers: () =>
      node.listPeers().map((p) => ({ peerId: p.identity.peerId, name: p.identity.name, online: p.online, blocked: p.trust === 'blocked', ...(Number.isFinite(p.rttMs) ? { rttMs: p.rttMs } : {}) })),
    onPeer(fn) {
      peerListeners.add(fn);
      return () => peerListeners.delete(fn);
    },
    audit(entry) {
      if (!entry || typeof entry !== 'object') return;
      node._audit({ ...entry, type: String(entry.type || entry.kind || 'compute') });
    },
    close() {
      for (const off of offs.splice(0)) off();
      listeners.clear();
      peerListeners.clear();
    },
  };
}
