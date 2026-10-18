// Real handshakes between two engines in one process (inproc), and once over localhost sockets
// (ws-lan): invite, SAS, accept, wrong words, a man in the middle caught by the SAS words,
// tampering, revoke, expiry and known peer reconnect.
import { afterEach, describe, expect, it } from 'vitest';
import { inprocPair } from '../../src/p2p/transport/inproc.js';
import { listenLan, connectLan } from '../../src/p2p/transport/ws-lan.js';
import { registerMessage } from '../../src/p2p/messages.js';
import { cleanHomes, clock, makeNode, tick, until, waitFor } from './helpers.js';

afterEach(cleanHomes);

const COMPUTE = [
  { name: 'compute.inference', limits: { maxConcurrentJobs: 1, maxJobSeconds: 60 } },
  { name: 'compute.gpu', limits: { maxVramBytes: 6 * 1024 ** 3 } },
  { name: 'compute.cpu', limits: { maxThreads: 4 } },
];

/** Host invites, guest joins over a fresh inproc pair. Returns the join handle and the request. */
async function joinPair(host, guest, { words, tap, requestedCaps = COMPUTE, inviteCaps = COMPUTE } = {}) {
  const invite = await host.createInvite({ caps: inviteCaps });
  const [hc, gc] = inprocPair({ tap });
  host.accept(hc);
  const requested = waitFor(host, 'join.request');
  const joined = await guest.join(words || invite.words, gc, { requestedCaps });
  const request = await requested;
  return { invite, joined, request, hc, gc };
}

/** Accepts with every requested toggle on. */
async function acceptAll(host, request, extra = {}) {
  const caps = request.toggles.map((t) => ({ capability: t.capability, minutes: t.minutes }));
  return host.answerJoin(request.requestId, { accept: true, sasMatches: true, caps, ...extra });
}

describe('invite handshake', () => {
  it('joins with the six words: same SAS words on both sides, explicit accept, grants on both sides', async () => {
    const host = makeNode('rita');
    const guest = makeNode('ben');
    const { joined, request } = await joinPair(host, guest);

    expect(request.sas).toHaveLength(6);
    expect(joined.sas).toEqual(request.sas);
    expect(request.peer.peerId).toBe(guest.identity.peerId);
    expect(request.peer.fingerprint.words).toEqual(guest.identity.fingerprint.words);
    expect(joined.host.fingerprint.words).toEqual(host.identity.fingerprint.words);
    expect(request.question).toMatch(/match/);
    // The dialog defaults: city.view on, everything else off.
    expect(request.toggles.find((t) => t.capability.name === 'city.view').on).toBe(true);
    expect(request.toggles.filter((t) => t.on).map((t) => t.capability.name)).toEqual(['city.view']);

    // Accept is not one button: the person must say the words match.
    expect(() => host.answerJoin(request.requestId, { accept: true })).toThrow(/compare the six words/);

    const answered = await acceptAll(host, request);
    expect(answered.accepted).toBe(true);
    const decision = await joined.decision;
    expect(decision.accepted).toBe(true);
    expect(decision.grants.map((g) => g.capability.name).sort()).toEqual(['city.view', 'compute.cpu', 'compute.gpu', 'compute.inference']);

    expect(host.peers.get(guest.identity.peerId).trust).toBe('known');
    expect(guest.peers.get(host.identity.peerId).trust).toBe('known');
    expect(host.can(guest.identity.peerId, 'compute.gpu').capability.limits.maxVramBytes).toBe(6 * 1024 ** 3);
    expect(host.can(guest.identity.peerId, 'remote.view')).toBeNull();
    // Nothing is granted the other way round.
    expect(guest.can(host.identity.peerId, 'compute.inference')).toBeNull();
    await until(() => guest.held(host.identity.peerId).length === 4);

    const hostAudit = host.audit.tail(20).map((r) => r.entry.type);
    expect(hostAudit).toEqual(expect.arrayContaining(['identity.created', 'invite.created', 'join.requested', 'join.accepted', 'session.open']));
    expect(host.audit.verify().ok).toBe(true);
    expect(JSON.stringify(host.audit.tail(50))).not.toContain(request.sas.join(' '));
    await host.close();
    await guest.close();
  });

  it('wrong words fail on both sides and burn the invite: the right words then fail too', async () => {
    const host = makeNode('rita');
    const guest = makeNode('ben');
    const invite = await host.createInvite({});
    const [hc, gc] = inprocPair();
    host.accept(hc);
    const burned = waitFor(host, 'invite.burned');
    // The relays see the topic in clear, so an attacker can address the invite without the
    // words. The tap plays that attacker: right topic, wrong words.
    const wrong = ['abandon', 'ability', 'able', 'about', 'above', 'absent'];
    const tapTopic = (text) => text.replace(/"inv":"[^"]+"/, `"inv":"${invite.rendezvous.topic}"`);
    gc.tap = tapTopic;
    await expect(guest.join(wrong, gc)).rejects.toMatchObject({ code: 'words' });
    expect((await burned).reason).toBe('words');
    expect(host.invites.get(invite.inviteId).state).toBe('burned');
    expect(host.invites.get(invite.inviteId).psk.every((b) => b === 0)).toBe(true);

    const [hc2, gc2] = inprocPair();
    host.accept(hc2);
    await expect(guest.join(invite.words, gc2)).rejects.toMatchObject({ code: 'words' });
    expect(host.listJoinRequests()).toEqual([]);
    expect(host.peers.list()).toEqual([]);
    await host.close();
    await guest.close();
  });

  it('a man in the middle who has the words is caught by the SAS words', async () => {
    const host = makeNode('rita');
    const guest = makeNode('ben');
    const mallory = makeNode('mallory');
    const invite = await host.createInvite({ caps: COMPUTE });

    // Mallory read the words over a shoulder. She joins the host as a guest, and she plays the
    // host for the real guest with an invite made from the same words.
    await mallory.invites.create({ words: invite.words, offeredCaps: COMPUTE });
    const [hostSide, malloryAsGuest] = inprocPair();
    const [malloryAsHost, guestSide] = inprocPair();
    host.accept(hostSide);
    mallory.accept(malloryAsHost);
    const hostRequest = waitFor(host, 'join.request');
    const malloryRequest = waitFor(mallory, 'join.request');
    const [toHost, toGuest] = await Promise.all([mallory.join(invite.words, malloryAsGuest, { name: 'ben' }), guest.join(invite.words, guestSide)]);
    const atHost = await hostRequest;
    await malloryRequest;

    // Both handshakes worked, and Mallory even used Ben's name, but the words differ.
    expect(atHost.peer.name).toBe('ben');
    expect(atHost.sas).toEqual(toHost.sas);
    expect(toGuest.sas).not.toEqual(atHost.sas);
    // And the fingerprints do not match the real people either.
    expect(atHost.peer.fingerprint.words).not.toEqual(guest.identity.fingerprint.words);
    expect(toGuest.host.fingerprint.words).not.toEqual(host.identity.fingerprint.words);

    // Rita reads her words to Ben on the phone; they differ, she says so.
    const result = host.answerJoin(atHost.requestId, { accept: false, sasMatches: false });
    expect(result.accepted).toBe(false);
    expect((await toHost.decision).accepted).toBe(false);
    expect(host.peers.get(mallory.identity.peerId)).toBeNull();
    expect(host.audit.tail(10).map((r) => r.entry)).toContainEqual(expect.objectContaining({ type: 'join.refused', reason: 'sas_mismatch' }));
    await Promise.all([host.close(), guest.close(), mallory.close()]);
  });

  it('a relay that only forwards changes nothing; one that edits a byte breaks the handshake and burns the invite', async () => {
    const host = makeNode('rita');
    const guest = makeNode('ben');
    const seen = [];
    const { joined, request } = await joinPair(host, guest, { tap: (t) => (seen.push(t), t) });
    expect(joined.sas).toEqual(request.sas);
    expect(seen.length).toBeGreaterThanOrEqual(3);
    // The relay saw no words and no names in clear.
    expect(seen.join('\n')).not.toContain('rita');
    expect(seen.join('\n')).not.toContain(request.sas[0] + '"');

    const guest2 = makeNode('carol');
    const invite = await host.createInvite({});
    const flip = (t) => {
      if (!t.includes('"hs.2"')) return t;
      const m = JSON.parse(t);
      const b = Buffer.from(m.box, 'base64url');
      b[5] ^= 1;
      return JSON.stringify({ ...m, box: b.toString('base64url') });
    };
    const [hc, gc] = inprocPair({ tap: flip });
    host.accept(hc);
    const burned = waitFor(host, 'invite.burned');
    await expect(guest2.join(invite.words, gc)).rejects.toMatchObject({ code: 'words' });
    await burned;
    expect(host.invites.get(invite.inviteId).state).toBe('burned');
    await Promise.all([host.close(), guest.close(), guest2.close()]);
  });

  it('an invite expires after its minutes and a late join fails', async () => {
    const now = clock();
    const host = makeNode('rita', { now });
    const guest = makeNode('ben');
    const invite = await host.createInvite({ minutes: 10 });
    now.advance(10 * 60_000 + 1);
    host.sweep();
    expect(host.invites.get(invite.inviteId).state).toBe('expired');
    const [hc, gc] = inprocPair();
    host.accept(hc);
    await expect(guest.join(invite.words, gc)).rejects.toMatchObject({ code: 'words' });
    await host.close();
    await guest.close();
  });

  it('refuses a blocked guest even with the right words', async () => {
    const host = makeNode('rita');
    const guest = makeNode('ben');
    const first = await joinPair(host, guest);
    await acceptAll(host, first.request);
    await first.joined.decision;
    host.block(guest.identity.peerId);
    await until(() => !host.sessionOf(guest.identity.peerId));
    const invite = await host.createInvite({});
    const [hc, gc] = inprocPair();
    host.accept(hc);
    await expect(guest.join(invite.words, gc)).rejects.toMatchObject({ code: 'refused' });
    expect(host.invites.get(invite.inviteId).state).toBe('burned');
    await host.close();
    await guest.close();
  });

  it('works with the real PBKDF2 cost (100,000 iterations)', async () => {
    const host = makeNode('rita', { iterations: undefined });
    const guest = makeNode('ben', { iterations: undefined });
    expect(host.iterations).toBe(100_000);
    const { joined, request } = await joinPair(host, guest);
    expect(joined.sas).toEqual(request.sas);
    await host.close();
    await guest.close();
  });
});

// A job.offer handler stands in for the compute worker of src/compute/ (Stream 3).
registerMessage('job.offer', { normalize: (b) => ({ job: { id: String(b?.job?.id || '').slice(0, 40) } }) });

describe('grants, revoke and expiry', () => {
  it('a message runs only while its grant is active; revoke stops it at once and tells the peer', async () => {
    const host = makeNode('rita');
    const guest = makeNode('ben');
    const { joined, request } = await joinPair(host, guest);
    await acceptAll(host, request);
    await joined.decision;
    const ran = [];
    host.handle('job.offer', (msg, ctx) => {
      ran.push({ job: msg.body.job.id, grant: ctx.grant.capability.name });
      ctx.reply('job.reject', { jobId: msg.body.job.id, code: 'busy' });
    });
    const replies = [];
    guest.handle('job.reject', (msg) => replies.push(msg.body));
    const hostId = host.identity.peerId;
    const guestId = guest.identity.peerId;
    guest.send(hostId, 'job.offer', { job: { id: 'jb_1' } });
    await until(() => replies.length === 1);
    expect(ran).toEqual([{ job: 'jb_1', grant: 'compute.inference' }]);

    const grant = host.can(guestId, 'compute.inference');
    const revokedThere = waitFor(guest, 'held.revoked');
    const revokedHere = waitFor(host, 'grant.revoked');
    host.revoke(grant.id, 'owner stop');
    expect((await revokedHere).reason).toBe('owner stop');
    expect((await revokedThere).grantId).toBe(grant.id);
    expect(guest.held(hostId).map((g) => g.capability.name)).not.toContain('compute.inference');

    const errors = [];
    guest.on('peer.error', (e) => errors.push(e));
    guest.send(hostId, 'job.offer', { job: { id: 'jb_2' } });
    await until(() => errors.length === 1);
    expect(errors[0].code).toBe('not_granted');
    expect(ran).toHaveLength(1);
    expect(host.audit.tail(10).map((r) => r.entry.type)).toEqual(expect.arrayContaining(['revoke', 'message.refused']));
    await host.close();
    await guest.close();
  });

  it('grants expire on time and the peer is told', async () => {
    const now = clock();
    const host = makeNode('rita', { now });
    const guest = makeNode('ben', { now });
    const { joined, request } = await joinPair(host, guest, { requestedCaps: [] });
    host.answerJoin(request.requestId, { accept: true, sasMatches: true, caps: [{ capability: 'city.view', minutes: 60 }] });
    await joined.decision;
    const g = host.grant(guest.identity.peerId, { name: 'compute.inference' }, { minutes: 1 });
    expect(Date.parse(g.expiresAt) - now()).toBe(60_000);
    await until(() => guest.held(host.identity.peerId).some((x) => x.id === g.id));
    const ended = waitFor(host, 'grant.revoked');
    now.advance(60_001);
    host.sweep();
    expect((await ended).reason).toBe('expired');
    expect(host.can(guest.identity.peerId, 'compute.inference')).toBeNull();
    await until(() => !guest.held(host.identity.peerId).some((x) => x.id === g.id));
    expect(host.audit.tail(5).map((r) => r.entry.type)).toContain('grant.expired');
    await host.close();
    await guest.close();
  });

  it('only a person grants: a non user origin is refused, and session only capabilities never stand', async () => {
    const host = makeNode('rita');
    const guest = makeNode('ben');
    const { joined, request } = await joinPair(host, guest);
    await acceptAll(host, request);
    await joined.decision;
    const id = guest.identity.peerId;
    expect(() => host.grant(id, 'compute.gpu', {}, { kind: 'peer', peerId: id })).toThrow(/only a person/);
    expect(() => host.grant(id, 'remote.control', { scope: 'standing' })).toThrow(/one session/);
    expect(() => host.grant(id, 'remote.view', { minutes: 30 })).toThrow(/5, 15, 60/);
    const rv = host.grant(id, 'remote.view', { minutes: 5 });
    expect(rv.scope).toBe('session');
    expect(() => host.grant(id, 'compute.gpu', { minutes: null })).toThrow(/needs an expiry/);
    const open = host.grant(id, 'chat', { minutes: null });
    expect(open.expiresAt).toBeNull();
    await host.close();
    await guest.close();
  });
});

describe('known peer reconnect', () => {
  it('reconnects without words; standing grants apply, session grants do not survive', async () => {
    const host = makeNode('rita');
    const guest = makeNode('ben');
    const { joined, request } = await joinPair(host, guest);
    await acceptAll(host, request);
    await joined.decision;
    const guestId = guest.identity.peerId;
    host.grant(guestId, 'remote.view', { minutes: 15 });
    expect(host.can(guestId, 'remote.view')).not.toBeNull();
    const firstSession = host.sessionOf(guestId).session.id;

    const offline = waitFor(host, 'peer.offline');
    guest.sessionOf(host.identity.peerId).session.close('bye');
    await offline;
    expect(host.can(guestId, 'remote.view')).toBeNull();
    expect(host.can(guestId, 'compute.inference')).not.toBeNull();

    const [hc, gc] = inprocPair();
    const online = waitFor(host, 'peer.online');
    host.accept(hc);
    const session = await guest.connect(host.identity.peerId, gc);
    expect((await online).peerId).toBe(guestId);
    expect(session.id).not.toBe(firstSession);
    expect(host.can(guestId, 'compute.inference')).not.toBeNull();
    expect(host.can(guestId, 'remote.view')).toBeNull();
    await until(() => guest.held(host.identity.peerId).length === 4);
    // The guest can also be the one that is called back.
    const [hc2, gc2] = inprocPair();
    guest.accept(gc2);
    const s2 = await host.connect(guestId, hc2);
    expect(s2.state).toBe('open');
    await until(() => guest.sessionOf(host.identity.peerId)?.session.id === s2.id);
    await host.close();
    await guest.close();
  });

  it('refuses a stranger, a blocked peer and a forged hello', async () => {
    const host = makeNode('rita');
    const guest = makeNode('ben');
    const stranger = makeNode('eve');
    const { joined, request } = await joinPair(host, guest);
    await acceptAll(host, request);
    await joined.decision;
    guest.sessionOf(host.identity.peerId).session.close('bye');
    await until(() => !host.sessionOf(guest.identity.peerId));

    // A stranger who copies Rita's record still has no key Rita knows.
    stranger.peers.upsert(guest.peers.get(host.identity.peerId).identity, { trust: 'known', relation: 'host' });
    const [hc, sc] = inprocPair();
    host.accept(hc);
    await expect(stranger.connect(host.identity.peerId, sc)).rejects.toMatchObject({ code: 'unknown_peer' });

    // A hello that claims to be Ben but carries another ephemeral key fails the signature.
    const forge = (t) => {
      if (!t.includes('"hs.k1"')) return t;
      const m = JSON.parse(t);
      const e = Buffer.from(m.e, 'base64url');
      e[0] ^= 1;
      return JSON.stringify({ ...m, e: e.toString('base64url') });
    };
    const [hc2, gc2] = inprocPair({ tap: forge });
    host.accept(hc2);
    await expect(guest.connect(host.identity.peerId, gc2)).rejects.toMatchObject({ code: 'bad_signature' });

    host.block(guest.identity.peerId);
    const [hc3, gc3] = inprocPair();
    host.accept(hc3);
    await expect(guest.connect(host.identity.peerId, gc3)).rejects.toMatchObject({ code: 'blocked' });
    expect(host.audit.verify().ok).toBe(true);
    await Promise.all([host.close(), guest.close(), stranger.close()]);
  });
});

describe('ws-lan over real localhost sockets', () => {
  it('invites, accepts and reconnects over TCP', async () => {
    const host = makeNode('rita');
    const guest = makeNode('ben');
    const lan = await listenLan({ host: '127.0.0.1', port: 0, onConnection: (c) => host.accept(c) });
    try {
      const invite = await host.createInvite({ caps: COMPUTE });
      const requested = waitFor(host, 'join.request');
      const conn = await connectLan(`127.0.0.1:${lan.port}`);
      const joined = await guest.join(invite.words, conn, { requestedCaps: COMPUTE });
      const request = await requested;
      expect(joined.sas).toEqual(request.sas);
      await acceptAll(host, request);
      expect((await joined.decision).accepted).toBe(true);
      expect(host.sessionOf(guest.identity.peerId).session.conn.transport).toBe('ws-lan');

      guest.sessionOf(host.identity.peerId).session.close('bye');
      await until(() => !host.sessionOf(guest.identity.peerId));
      const again = await connectLan(`127.0.0.1:${lan.port}`);
      const s = await guest.connect(host.identity.peerId, again);
      await until(() => host.sessionOf(guest.identity.peerId)?.online);
      expect(s.state).toBe('open');
      // The listener answers nothing but the handshake path.
      const res = await fetch(`http://127.0.0.1:${lan.port}/`);
      expect(res.status).toBe(404);
    } finally {
      await lan.close();
      await host.close();
      await guest.close();
    }
  });
});

await tick(0);
