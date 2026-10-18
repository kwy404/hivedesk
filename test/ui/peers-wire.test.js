// The City peers view and Activity read the events and frames that src/p2p/ really sends.
import { describe, it, expect } from 'vitest';
import { blankPeers, applyPeerEvent, isPeerType, peerView, PEER_COMMANDS } from '../../ui/city/peers.js';
import { entryOf } from '../../ui/city/activity.js';

const RITA = 'hd1' + 'r'.repeat(49);
const ev = (seq, type, data) => ({ seq, ts: new Date(1_800_000_000_000 + seq * 1000).toISOString(), type, data });

describe('the City peers view on the real p2p events', () => {
  it('takes the peer list frame, then grants, revokes and presence from the logged events', () => {
    const p = blankPeers();
    for (const t of ['p2p.peers', 'p2p.peer', 'p2p.grant', 'p2p.revoke', 'p2p.join', 'p2p.join.request']) expect(isPeerType(t)).toBe(true);
    applyPeerEvent(p, { type: 'p2p.peers', data: { peers: [{ identity: { peerId: RITA, name: "Rita's PC", fingerprint: { words: ['a', 'b', 'c', 'd', 'e', 'f'], short: 'hd1rrrr-rrrr' } }, trust: 'known', online: true, sessionId: 'ss_1', grants: [{ id: 'gr_1', peerId: RITA, capability: { name: 'city.member' }, scope: 'session', expiresAt: null }] }] } });
    let v = peerView(p, RITA, {}, Date.now());
    expect(v).toMatchObject({ name: "Rita's PC", trust: 'known', online: true });
    expect(v.grants.map((g) => g.capability)).toEqual(['city.member']);
    applyPeerEvent(p, ev(2, 'p2p.grant', { grantId: 'gr_2', peerId: RITA, capability: 'compute.inference', expiresAt: null, scope: 'standing' }));
    applyPeerEvent(p, ev(3, 'p2p.revoke', { grantId: 'gr_1', peerId: RITA, capability: 'city.member', reason: 'revoked' }));
    applyPeerEvent(p, ev(4, 'p2p.peer', { peerId: RITA, online: false, reason: 'no answer' }));
    v = peerView(p, RITA, {}, Date.now());
    expect(v.grants.map((g) => g.capability)).toEqual(['compute.inference']);
    expect(v).toMatchObject({ online: false, closedReason: 'no answer' });
    expect(PEER_COMMANDS).toEqual({ revoke: 'p2p.revoke', block: 'p2p.block' });
  });

  it('shows a join request until the host decides', () => {
    const p = blankPeers();
    applyPeerEvent(p, { type: 'p2p.join.request', data: { requestId: 'jr_1', peer: { peerId: RITA, name: 'Rita' }, sas: ['one', 'two', 'three', 'four', 'five', 'six'], requestedCaps: [{ name: 'city.view' }] } });
    expect(p.requests[RITA]).toMatchObject({ name: 'Rita', requestedCaps: ['city.view'] });
    applyPeerEvent(p, ev(5, 'p2p.join', { peerId: RITA, accepted: true }));
    expect(p.requests[RITA]).toBeUndefined();
  });

  it('writes Activity lines for p2p and the final compute record', () => {
    expect(entryOf(ev(1, 'p2p.grant', { grantId: 'gr_1', peerId: RITA, capability: 'compute.inference' }))).toMatchObject({ kind: 'grant' });
    expect(entryOf(ev(2, 'p2p.peer', { peerId: RITA, online: true }))).toMatchObject({ kind: 'peer' });
    expect(entryOf(ev(3, 'job.ended', { role: 'requester', jobId: 'jb_1', state: 'failed', error: 'disconnected' }))).toMatchObject({ kind: 'job' });
    expect(entryOf(ev(4, 'job.ended', { role: 'worker', jobId: 'jb_1', state: 'completed' }))).toBe(null);
  });
});
