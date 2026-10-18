// The Activity stream (ui/city/activity.js) and the peers adapter (ui/city/peers.js).
import { describe, it, expect } from 'vitest';
import { entryOf, activityFrom, filterActivity, exportActivity, KINDS } from '../../ui/city/activity.js';
import { blankPeers, applyPeerEvent, activeGrants, peerView, isPeerType } from '../../ui/city/peers.js';

let seq = 0;
const ev = (type, data, ts) => ({ seq: ++seq, ts: ts || new Date(1_800_000_000_000 + seq * 1000).toISOString(), type, data });

describe('the Activity stream', () => {
  const ctx = { agentName: (id) => ({ dev: 'Dev', qa: 'QA' })[id] || id, taskTitle: () => 'Hello page', roomName: (r) => r[0].toUpperCase() + r.slice(1), peerName: () => 'Rita', workerName: (id) => id };

  it('has a line for every task transition, job decision, grant, revoke, peer, approval, file and git action', () => {
    const events = [
      ev('city.task.created', { task: { id: 'ct_1', title: 'Hello page', createdBy: { kind: 'user' } } }),
      ev('city.task.claimed', { taskId: 'ct_1', agentId: 'dev', room: 'code' }),
      ev('city.task.hop', { hop: { taskId: 'ct_1', from: 'code', to: 'test' }, task: { id: 'ct_1', loops: 0 } }),
      ev('city.task.verdict', { taskId: 'ct_1', room: 'review', agentId: 'qa', passed: false, issues: ['Add a footer'] }),
      ev('city.task.hop', { hop: { taskId: 'ct_1', from: 'review', to: 'code', reason: 'changes requested: Add a footer' }, task: { id: 'ct_1', loops: 1 } }),
      ev('city.task.done', { taskId: 'ct_1' }),
      ev('job.scheduled', { jobId: 'jb_1', decision: { reason: 'Your GPU: about 4 s.' } }),
      ev('job.failed', { jobId: 'jb_1', error: { code: 'timeout', message: 'no token for 30 s' } }),
      ev('cap.granted', { grant: { id: 'gr_1', peerId: 'hd1rita', capability: { name: 'city.member' } } }),
      ev('cap.revoked', { grantId: 'gr_1', peerId: 'hd1rita' }),
      ev('city.member.joined', { member: { peerId: 'hd1rita', machineId: 'm_1' } }),
      ev('approval.requested', { approval: { summary: 'Run: npm test', workerId: 'qa' } }),
      ev('approval.resolved', { approved: true, by: 'user' }),
      ev('file.changed', { path: 'hello.html', op: 'create', workerId: 'dev', taskId: 't_1' }),
      ev('github.committed', { sha: 'abcdef1234', subject: 'Add the page' }),
      ev('worker.status', { workerId: 'dev', status: 'thinking' }),
      ev('city.task.hop', { hop: { taskId: 'ct_1', from: 'code', to: 'code' }, task: { id: 'ct_1' } })
    ];
    const list = activityFrom(events, ctx);
    expect(list.map((e) => e.key.replace('city.act.', ''))).toEqual(['created', 'claimed', 'hop', 'failed', 'loop', 'done', 'scheduled', 'jobFailed', 'granted', 'revokedGrant', 'memberJoined', 'asked', 'approved', 'fileCreated', 'committed']);
    const kinds = new Set(list.map((e) => e.kind));
    for (const k of ['task', 'job', 'grant', 'peer', 'approval', 'file', 'git']) expect(kinds.has(k)).toBe(true);
    for (const k of kinds) expect(KINDS).toContain(k);
    const loop = list.find((e) => e.key === 'city.act.loop');
    expect(loop).toMatchObject({ loop: true, p: { from: 'Review', to: 'Code', n: 1 } });
    expect(list.find((e) => e.key === 'city.act.jobFailed')).toMatchObject({ jobId: 'jb_1', tone: 'bad', p: { code: 'timeout' } });
  });

  it('filters by kind, task, peer and text, and exports CSV without formulas, JSON and Markdown', () => {
    const list = activityFrom([
      ev('city.task.created', { task: { id: 'ct_2', title: '=HYPERLINK("x")' } }),
      ev('cap.granted', { grant: { id: 'gr_2', peerId: 'hd1rita', capability: 'chat' } }),
      ev('file.changed', { path: 'a|b.md', op: 'modify', workerId: 'dev' })
    ], ctx);
    const text = (e) => `${e.key} ${JSON.stringify(e.p)}`;
    expect(filterActivity(list, { kind: 'grant' }).map((e) => e.peerId)).toEqual(['hd1rita']);
    expect(filterActivity(list, { taskId: 'ct_2' })).toHaveLength(1);
    expect(filterActivity(list, { q: 'a|b' }, text)).toHaveLength(1);
    const csv = exportActivity(list, 'csv', (e) => e.p.title || e.p.path || e.key);
    expect(csv.ext).toBe('csv');
    expect(csv.body).toContain(`"'=HYPERLINK(""x"")"`);
    const md = exportActivity(list, 'md', (e) => e.p.path || e.key);
    expect(md.body).toContain('a\\|b.md');
    const js = JSON.parse(exportActivity(list, 'json', () => 'line').body);
    expect(js.entries).toHaveLength(3);
    expect(js.entries[0].text).toBe('line');
  });
});

describe('the peers adapter', () => {
  it('knows identity, sessions and grants from the p2p events, and session grants end with the session', () => {
    const p = blankPeers();
    applyPeerEvent(p, ev('peer.known', { peer: { identity: { peerId: 'hd1rita', name: 'Rita', fingerprint: { words: ['apple', 'river', 'stone', 'cloud', 'tiger', 'lemon'], short: 'hd1abcd-efgh' } }, trust: 'known' } }));
    applyPeerEvent(p, ev('session.opened', { peerId: 'hd1rita', sessionId: 'ss_1' }));
    applyPeerEvent(p, ev('cap.granted', { grant: { id: 'gr_1', peerId: 'hd1rita', capability: { name: 'city.member' }, scope: 'session', expiresAt: null } }));
    applyPeerEvent(p, ev('cap.granted', { grant: { id: 'gr_2', peerId: 'hd1rita', capability: { name: 'city.view' }, scope: 'standing', expiresAt: null } }));
    applyPeerEvent(p, ev('cap.granted', { grant: { id: 'gr_3', peerId: 'hd1rita', capability: { name: 'remote.view' }, scope: 'session', expiresAt: new Date(Date.now() - 1000).toISOString() } }));
    expect(p.peers.hd1rita).toMatchObject({ name: 'Rita', online: true, trust: 'known' });
    expect(activeGrants(p.peers.hd1rita).map((g) => g.capability).sort()).toEqual(['city.member', 'city.view']);
    const city = { members: { hd1rita: { peerId: 'hd1rita', machineId: 'm_1', joinedAt: 'x', via: 'invite' } }, machines: { m_1: { id: 'm_1', name: "Rita's PC", online: true } }, agents: { 'm_1:pip': { id: 'm_1:pip', home: 'm_1' } } };
    const v = peerView(p, 'hd1rita', city);
    expect(v).toMatchObject({ name: 'Rita', online: true, machineId: 'm_1', agents: ['m_1:pip'], member: { via: 'invite', leftAt: null }, fingerprint: { short: 'hd1abcd-efgh' } });
    expect(v.fingerprint.words).toHaveLength(6);
    applyPeerEvent(p, ev('session.closed', { peerId: 'hd1rita', reason: 'closed' }));
    expect(p.peers.hd1rita.online).toBe(false);
    expect(activeGrants(p.peers.hd1rita).map((g) => g.capability)).toEqual(['city.view']);
    applyPeerEvent(p, ev('cap.revoked', { grantId: 'gr_2' }));
    expect(activeGrants(p.peers.hd1rita)).toEqual([]);
    applyPeerEvent(p, ev('peer.blocked', { peerId: 'hd1rita' }));
    expect(p.peers.hd1rita.trust).toBe('blocked');
    expect(isPeerType('cap.granted')).toBe(true);
    expect(isPeerType('city.task.done')).toBe(false);
  });

  it('shows a 0.2 friend building without an identity, and nothing for a stranger', () => {
    const p = blankPeers();
    const city = { members: {}, machines: { m_x: { id: 'm_x', name: 'Old friend', peerId: 'hd1old', online: false } }, agents: {} };
    expect(peerView(p, 'hd1old', city)).toMatchObject({ known: false, fingerprint: null, machineId: 'm_x', grants: [] });
    expect(peerView(p, 'hd1nobody', city)).toBe(null);
  });
});
