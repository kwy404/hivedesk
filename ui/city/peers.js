// Peers as the City sees them: who is known, who is online, what each may do here (PLAN sections
// 2 and 3). Pure module, no DOM. An adapter over the events of Stream 2 (src/p2p/); until they
// exist the list stays empty. Accepted events (aliases so a rename is a one line change):
//   peer.added | peer.known | peer.updated   { peer: Peer }  or the Peer fields
//   peer.blocked | peer.unblocked            { peerId }
//   session.opened | session.open            { peerId, sessionId, via? }
//   session.closed                           { peerId, reason }
//   cap.granted | grant.created              { grant: Grant }
//   cap.revoked | grant.revoked              { grantId, peerId?, reason? }
//   join.request                             { peerId, name, fingerprint, sas, requestedCaps }
//   join.accepted | join.refused             { peerId }
// The City members (city.member.joined / left) come from the CityState itself.
// What Stream 2 really sends (docs/1.0/protocol/p2p.md), read here since the 1.0 merge:
//   live   p2p.peers         { peers: Peer[] }                          the whole list after any change
//   event  p2p.peer          { peerId, online, reason? }
//   event  p2p.grant         { grantId, peerId, capability, expiresAt, scope }
//   event  p2p.revoke        { grantId, peerId, capability, reason }
//   event  p2p.join          { peerId, accepted, reason? }
//   live   p2p.join.request  the Accept dialog data { requestId, peer: { peerId, name, fingerprint }, sas, requestedCaps }
// Commands go back as p2p.revoke { grantId, reason } and p2p.block { peerId } (PEER_COMMANDS).

export const blankPeers = () => ({ peers: {}, requests: {} });

/** The engine commands of the peer panel (src/p2p/engine.js). */
export const PEER_COMMANDS = Object.freeze({ revoke: 'p2p.revoke', block: 'p2p.block' });

const str = (v, n = 80) => (typeof v === 'string' ? v.slice(0, n) : '');

function ensure(p, peerId) {
  if (!p.peers[peerId]) p.peers[peerId] = { peerId, name: '', fingerprint: null, trust: 'unknown', online: false, sessionId: null, grants: {}, firstSeen: null, lastSeen: null, closedReason: null };
  return p.peers[peerId];
}

function fingerprintOf(f) {
  if (!f || typeof f !== 'object') return null;
  return { words: Array.isArray(f.words) ? f.words.slice(0, 6).map((w) => str(w, 16)) : [], short: str(f.short, 24), hex: str(f.hex, 64) };
}

export function applyPeerEvent(p, ev) {
  const d = ev?.data || {};
  switch (ev?.type) {
    case 'peer.added': case 'peer.known': case 'peer.updated': {
      const src = d.peer || d;
      const id = src.identity?.peerId || src.peerId;
      if (!id) return false;
      const x = ensure(p, id);
      if (src.identity?.name || src.name) x.name = str(src.identity?.name || src.name, 40);
      const fp = fingerprintOf(src.identity?.fingerprint || src.fingerprint);
      if (fp) x.fingerprint = fp;
      if (['unknown', 'known', 'blocked'].includes(src.trust)) x.trust = src.trust;
      // the name and avatar the peer showed over its session (src/p2p/ sanitized them); never an image
      if (src.profile && typeof src.profile === 'object') x.profile = { name: str(src.profile.name, 32), avatar: str(src.profile.avatar, 40) || null };
      if (src.firstSeen) x.firstSeen = src.firstSeen;
      if (src.lastSeen) x.lastSeen = src.lastSeen;
      if (typeof src.online === 'boolean') x.online = src.online;
      if (Array.isArray(src.grants)) for (const g of src.grants) if (g?.id) x.grants[g.id] = cleanGrant(g);
      return true;
    }
    case 'peer.blocked': case 'peer.unblocked': {
      if (!d.peerId) return false;
      ensure(p, d.peerId).trust = ev.type === 'peer.blocked' ? 'blocked' : 'known';
      return true;
    }
    case 'session.opened': case 'session.open': {
      if (!d.peerId) return false;
      const x = ensure(p, d.peerId);
      x.online = true; x.sessionId = d.sessionId || null; x.lastSeen = ev.ts || x.lastSeen; x.closedReason = null;
      if (x.trust === 'unknown') x.trust = 'known';
      return true;
    }
    case 'session.closed': {
      if (!d.peerId || !p.peers[d.peerId]) return false;
      const x = p.peers[d.peerId];
      x.online = false; x.sessionId = null; x.lastSeen = ev.ts || x.lastSeen; x.closedReason = str(d.reason, 60) || null;
      for (const g of Object.values(x.grants)) if (g.scope === 'session' && !g.revokedAt) g.revokedAt = ev.ts || 'session';
      return true;
    }
    case 'cap.granted': case 'grant.created': {
      const g = d.grant || d;
      if (!g?.id || !g.peerId) return false;
      ensure(p, g.peerId).grants[g.id] = cleanGrant(g);
      return true;
    }
    case 'cap.revoked': case 'grant.revoked': {
      for (const x of Object.values(p.peers)) {
        const g = x.grants[d.grantId];
        if (g) { g.revokedAt = ev.ts || 'now'; g.reason = str(d.reason, 120); return true; }
      }
      return false;
    }
    case 'join.request': {
      if (!d.peerId) return false;
      p.requests[d.peerId] = { peerId: d.peerId, name: str(d.name, 40), fingerprint: fingerprintOf(d.fingerprint), sas: Array.isArray(d.sas) ? d.sas.slice(0, 6) : [], requestedCaps: Array.isArray(d.requestedCaps) ? d.requestedCaps.map((c) => str(c?.name || c, 30)) : [], at: ev.ts };
      return true;
    }
    case 'join.accepted': case 'join.refused':
      if (!p.requests[d.peerId]) return false;
      delete p.requests[d.peerId];
      return true;
    case 'p2p.peers': {
      if (!Array.isArray(d.peers)) return false;
      for (const peer of d.peers.slice(0, 200)) {
        const id = peer?.identity?.peerId;
        if (!id) continue;
        const x = ensure(p, id);
        // The list is the whole truth for grants and presence.
        x.grants = {};
        applyPeerEvent(p, { type: 'peer.known', ts: ev.ts, data: { peer } });
        x.online = !!peer.online;
        x.sessionId = peer.sessionId || null;
      }
      return true;
    }
    case 'p2p.peer':
      if (!d.peerId) return false;
      return applyPeerEvent(p, { type: d.online ? 'session.opened' : 'session.closed', ts: ev.ts, data: { peerId: d.peerId, reason: d.reason } }) || true;
    case 'p2p.grant':
      return applyPeerEvent(p, { type: 'cap.granted', ts: ev.ts, data: { grant: { id: d.grantId, peerId: d.peerId, capability: { name: d.capability }, expiresAt: d.expiresAt ?? null, scope: d.scope, grantedAt: ev.ts || null } } });
    case 'p2p.revoke':
      return applyPeerEvent(p, { type: 'cap.revoked', ts: ev.ts, data: { grantId: d.grantId, peerId: d.peerId, reason: d.reason } });
    case 'p2p.join':
      return applyPeerEvent(p, { type: d.accepted ? 'join.accepted' : 'join.refused', ts: ev.ts, data: { peerId: d.peerId } });
    case 'p2p.join.request': {
      const peer = d.peer || {};
      if (!peer.peerId) return false;
      return applyPeerEvent(p, { type: 'join.request', ts: ev.ts, data: { peerId: peer.peerId, name: peer.name, fingerprint: peer.fingerprint, sas: d.sas, requestedCaps: d.requestedCaps, requestId: d.requestId } });
    }
    default: return false;
  }
}

function cleanGrant(g) {
  return {
    id: str(g.id, 40), peerId: str(g.peerId, 64), capability: str(g.capability?.name || g.capability, 30), limits: g.capability?.limits || null,
    grantedAt: g.grantedAt || null, expiresAt: g.expiresAt || null, scope: g.scope === 'standing' ? 'standing' : 'session', revokedAt: g.revokedAt || null
  };
}

export const isPeerType = (type) => /^(peer\.(added|known|updated|blocked|unblocked)|session\.(opened|open|closed)|cap\.(granted|revoked)|grant\.(created|revoked)|join\.(request|accepted|refused)|p2p\.(peers|peer|grant|revoke|join|join\.request))$/.test(String(type || ''));

/** Active grants of a peer, now: not revoked and not expired. */
export function activeGrants(peer, now = Date.now()) {
  return Object.values(peer?.grants || {}).filter((g) => !g.revokedAt && (!g.expiresAt || Date.parse(g.expiresAt) > now));
}

/**
 * The peer view for the peer panel: its identity, its grants here, its building and agents in
 * the city (from the CityState members), and what the user can do.
 */
export function peerView(p, peerId, city, now = Date.now()) {
  const x = p.peers[peerId] || null;
  const member = city?.members?.[peerId] || null;
  const machine = member ? city.machines?.[member.machineId] : Object.values(city?.machines || {}).find((m) => m.peerId === peerId) || null;
  if (!x && !member && !machine) return null;
  const grants = x ? activeGrants(x, now) : [];
  const agents = Object.values(city?.agents || {}).filter((a) => machine && a.home === machine.id && !a.retired).map((a) => a.id);
  return {
    peerId, name: x?.name || machine?.name || peerId.slice(0, 12), fingerprint: x?.fingerprint || null, trust: x?.trust || 'unknown',
    online: x ? x.online : !!machine?.online, sessionId: x?.online ? x.sessionId || null : null, lastSeen: x?.lastSeen || null, closedReason: x?.closedReason || null,
    grants: grants.map((g) => ({ ...g, expiresIn: g.expiresAt ? Math.max(0, Math.round((Date.parse(g.expiresAt) - now) / 1000)) : null })),
    member: member ? { machineId: member.machineId, joinedAt: member.joinedAt, leftAt: member.leftAt || null, via: member.via, reason: member.reason || null } : null,
    machineId: machine?.id || null, agents, known: !!x
  };
}
