// Remote desktop from a phone: the P2P port of src/remote/port.js, implemented over phone sessions,
// so the remote module (Stream 6) treats a paired phone like any viewer. Its host side then applies
// every rule of PLAN section 12 unchanged: the accept dialog, view only by default, session grants
// with expiry, the indicator and the kill switch, lock detection, the input checks and the helper.
// A phone may only ask (cap.request) when it holds phone.remote; remote.view and remote.control are
// granted per session by a click on the desktop. The phone grants nothing here (held is always null).
//
// combinePorts(p2p, phone) gives src/remote/ one port for both kinds of sessions.

import crypto from 'node:crypto';

const REMOTE_CAPS = new Set(['remote.view', 'remote.control']);

/**
 * @param {import('./hub.js').PhoneHub} hub
 * @param {{ localPeerId?: () => string, now?: () => number }} [o]
 */
export function createPhonePort(hub, o = {}) {
  const now = o.now || (() => Date.now());
  const handlers = new Set();
  const sessionFns = new Set();
  const requestFns = new Set();
  const changeFns = new Set();
  const grants = new Map();
  const views = new Map(); // sessionId -> the Session object handed out

  const viewOf = (rec) => {
    let v = views.get(rec.id);
    if (!v) {
      v = { id: rec.id, peerId: rec.deviceId, role: 'host', state: 'open', kind: 'phone' };
      views.set(rec.id, v);
    }
    return v;
  };
  const live = (sessionId) => {
    const rec = hub.sessions.get(sessionId);
    return rec && rec.accepted && rec.session.state === 'open' ? rec : null;
  };
  const changed = (kind, g) => {
    for (const fn of changeFns) { try { fn({ kind, grant: g, here: true }); } catch { /* a listener must not break the port */ } }
  };
  const endGrants = (match, reason) => {
    for (const g of grants.values()) if (!g.revokedAt && match(g)) {
      g.revokedAt = new Date(now()).toISOString();
      g.revokeReason = reason;
      hub._audit('phone.remote.revoke', { deviceId: g.peerId, grantId: g.id, capability: g.capability.name, reason });
      changed('revoked', g);
    }
  };

  hub.on('remote.message', (rec, msg) => {
    const s = viewOf(rec);
    if (msg.t === 'cap.request') {
      if (!REMOTE_CAPS.has(msg.body.capability.name)) {
        if (msg.id) rec.session.send('error', { code: 'not_granted', message: 'a phone may only ask for remote.view or remote.control' }, { re: msg.id });
        return;
      }
      hub._audit('phone.remote.request', { deviceId: rec.deviceId, capability: msg.body.capability.name });
      for (const fn of requestFns) fn(s, { capability: { name: msg.body.capability.name, limits: { clipboard: false, files: false } }, reason: msg.body.reason });
      return;
    }
    for (const h of handlers) if (msg.t.startsWith(h.prefix)) h.fn(s, { t: msg.t, ts: msg.ts, body: msg.body });
  });
  hub.on('session', (ev, rec) => {
    const s = viewOf(rec);
    if (ev === 'close') {
      s.state = 'closed';
      endGrants((g) => g.sessionId === rec.id, 'session_ended');
      views.delete(rec.id);
    }
    for (const fn of sessionFns) fn(ev, s);
  });
  hub.on('remote.off', (deviceId) => endGrants((g) => g.peerId === deviceId, 'phone_revoked'));

  return {
    kind: 'phone',
    get localPeerId() {
      try { return o.localPeerId?.() || 'local'; } catch { return 'local'; }
    },
    owns: (sessionId) => hub.sessions.has(sessionId),
    session(sessionId) {
      const rec = live(sessionId);
      return rec ? viewOf(rec) : null;
    },
    peer(deviceId) {
      const p = hub.store?.get(deviceId);
      return p ? { peerId: p.deviceId, name: p.name || 'Phone', words: p.words, publicKey: p.publicKey, trust: 'known', kind: 'phone' } : null;
    },
    send(sessionId, stream, type, body) {
      const rec = live(sessionId);
      if (!rec) return false;
      try {
        rec.session.send(type, body);
        return true;
      } catch {
        return false;
      }
    },
    onMessage(prefix, fn) {
      const h = { prefix, fn };
      handlers.add(h);
      return () => handlers.delete(h);
    },
    onSession(fn) {
      sessionFns.add(fn);
      return () => sessionFns.delete(fn);
    },
    caps: {
      grant(peerId, capability, opts = {}) {
        const rec = live(opts.sessionId);
        if (!rec || rec.deviceId !== peerId) throw Object.assign(new Error('no open phone session'), { code: 'not_found' });
        if (!REMOTE_CAPS.has(capability?.name)) throw Object.assign(new Error('a phone can hold remote.view or remote.control only'), { code: 'forbidden' });
        if (!hub.store.get(peerId)?.grants['phone.remote']) throw Object.assign(new Error('remote desktop is not allowed for this phone'), { code: 'forbidden' });
        const g = {
          id: 'gr_' + crypto.randomBytes(6).toString('hex'), peerId, capability: { name: capability.name, limits: { ...(capability.limits || {}) } },
          grantedBy: 'user', grantedAt: new Date(now()).toISOString(), expiresAt: opts.expiresAt || null, scope: 'session', sessionId: opts.sessionId
        };
        if (!g.expiresAt) throw Object.assign(new Error('a remote grant needs an expiry'), { code: 'bad_request' });
        grants.set(g.id, g);
        hub._audit('phone.remote.grant', { deviceId: peerId, grantId: g.id, capability: g.capability.name, expiresAt: g.expiresAt });
        changed('granted', g);
        return g;
      },
      revoke(grantId, reason = 'revoked') {
        const g = grants.get(grantId);
        if (!g || g.revokedAt) return;
        endGrants((x) => x.id === grantId, String(reason).slice(0, 80));
      },
      find(peerId, name) {
        for (const g of grants.values()) {
          if (g.peerId !== peerId || g.capability.name !== name || g.revokedAt) continue;
          if (g.expiresAt && Date.parse(g.expiresAt) <= now()) continue;
          if (!live(g.sessionId)) continue;
          return g;
        }
        return null;
      },
      held: () => null,
      request() { /* a phone grants nothing to the desktop */ },
      onRequest(fn) {
        requestFns.add(fn);
        return () => requestFns.delete(fn);
      },
      onChange(fn) {
        changeFns.add(fn);
        return () => changeFns.delete(fn);
      }
    },
    audit: { append: (entry) => hub._audit(`phone.${String(entry?.kind || 'remote')}`.slice(0, 60), { ...entry }) || { hash: '' } }
  };
}

/**
 * One port for src/remote/ over two: the p2p one (peers) and the phone one. Calls that name a
 * session go to the port that owns it; listeners subscribe to both; the audit goes to the first.
 */
export function combinePorts(primary, phone) {
  if (!primary) return phone;
  const pick = (sessionId) => (phone.owns(sessionId) ? phone : primary);
  const both = (fn) => {
    const a = fn(primary);
    const b = fn(phone);
    return () => { a?.(); b?.(); };
  };
  const port = {
    get localPeerId() { return primary.localPeerId; },
    session: (id) => pick(id).session(id),
    peer: (id) => (/^ph1/.test(String(id)) ? phone.peer(id) : primary.peer(id)),
    send: (id, stream, type, body) => pick(id).send(id, stream, type, body),
    onMessage: (prefix, fn) => both((p) => p.onMessage(prefix, fn)),
    onSession: (fn) => both((p) => p.onSession(fn)),
    caps: {
      grant: (peerId, cap, o) => pick(o?.sessionId).caps.grant(peerId, cap, o),
      revoke: (id, reason) => { primary.caps.revoke(id, reason); phone.caps.revoke(id, reason); },
      find: (peerId, name) => (/^ph1/.test(String(peerId)) ? phone.caps.find(peerId, name) : primary.caps.find(peerId, name)),
      held: (sessionId, name) => pick(sessionId).caps.held(sessionId, name),
      request: (sessionId, cap, reason) => pick(sessionId).caps.request(sessionId, cap, reason),
      onRequest: (fn) => both((p) => p.caps.onRequest(fn)),
      onChange: (fn) => both((p) => p.caps.onChange(fn))
    },
    audit: primary.audit
  };
  for (const k of ['localPublicKey', 'knownPeers', 'listenAddress', 'dialAddress']) {
    if (k in primary) Object.defineProperty(port, k, { get: () => (typeof primary[k] === 'function' ? primary[k].bind(primary) : primary[k]), enumerable: true });
  }
  return port;
}
