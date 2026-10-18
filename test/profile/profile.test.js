// The local profile (docs/1.0/PROFILE.md): sanitizing, the installer contract, real counters from
// events, achievements with their dates, and { name, avatar } in the p2p profile hello.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanName, cleanAvatar, cleanBio, publicProfile, shortPeer, NAME_MAX } from '../../src/profile/sanitize.js';
import { ProfileStore, readProfile, PROFILE_FILE, STATS_FILE } from '../../src/profile/index.js';
import { AVATARS, AVATAR_IDS, avatarSvg, monogramSvg, initials } from '../../ui/profile/avatars.js';
import { blankStats, applyEvent, summary, streak, bestStreak, normalizeStats, domainOf } from '../../ui/profile/stats.js';
import { ACHIEVEMENTS, unlock, badgeSvg } from '../../ui/profile/achievements.js';
import { messageSpec } from '../../src/p2p/messages.js';
import { inprocPair } from '../../src/p2p/transport/inproc.js';
import { cleanHomes, makeNode, tempHome, until, waitFor } from '../p2p/helpers.js';

afterEach(cleanHomes);

const PEER = `hd1${'a'.repeat(49)}`;

describe('profile sanitizing', () => {
  it('keeps a name of at most 32 characters with no control, bidi or zero width characters', () => {
    expect(cleanName('  Rita   Lopes \n')).toBe('Rita Lopes');
    expect(cleanName('a‮evil\u0000​')).toBe('aevil');
    expect([...cleanName('x'.repeat(80))]).toHaveLength(NAME_MAX);
    expect([...cleanName('\u{1F41D}'.repeat(40))]).toHaveLength(NAME_MAX); // code points, never half a pair
    expect(cleanName(42)).toBe('');
    expect(cleanBio('line\none'.repeat(60)).length).toBeLessThanOrEqual(160);
  });

  it('takes an avatar id from the allowlist only, never an image or a path', () => {
    expect(AVATARS.length).toBeGreaterThanOrEqual(24);
    expect(AVATARS.length).toBeLessThanOrEqual(32);
    for (const id of AVATAR_IDS) expect(cleanAvatar(id)).toBe(id);
    for (const bad of ['data:image/png;base64,AAAA', '../../etc/passwd', 'https://x.example/a.png', '<svg/>', '', null, 7]) expect(cleanAvatar(bad)).toBe(null);
  });

  it('falls back to the PeerId short form when a peer sends no usable name', () => {
    expect(shortPeer(PEER)).toBe('hd1aaaaaaaa');
    expect(publicProfile({ name: '\u0000‮', avatar: 'nope' }, PEER)).toEqual({ name: 'hd1aaaaaaaa', avatar: null });
    expect(publicProfile({ name: 'Rita', avatar: 'comb-amber', extra: 'x', bio: 'never shared' }, PEER)).toEqual({ name: 'Rita', avatar: 'comb-amber' });
  });

  it('draws every avatar, the monogram fallback and the badges as plain SVG', () => {
    for (const a of AVATARS) expect(avatarSvg(a.id)).toMatch(/^<svg [^>]*viewBox="0 0 64 64"/);
    expect(initials('Rita Lopes')).toBe('RL');
    expect(initials('')).toBe('?');
    expect(monogramSvg('<b>x</b>')).not.toMatch(/<b>/);
    expect(avatarSvg('unknown', { name: 'Ben' })).toMatch(/>BE</);
    for (const a of ACHIEVEMENTS) { expect(badgeSvg(a.id, true)).toMatch(/^<svg/); expect(badgeSvg(a.id, false)).toMatch(/#656C76/); }
  });

  it('bounds profile.hello on the wire before any handler sees it', () => {
    const spec = messageSpec('profile.hello');
    expect(spec.pre).toBe(true);
    expect(spec.max).toBeLessThanOrEqual(1024);
    const out = spec.normalize({ name: 'x'.repeat(500), avatar: 'y'.repeat(500), bio: 'secret', achievements: 5e9, stats: { jobs: 9 } });
    expect(out.name.length).toBe(64);
    expect(out.avatar.length).toBe(40);
    expect(out.achievements).toBe(1000);
    expect(out).not.toHaveProperty('bio');
    expect(out).not.toHaveProperty('stats');
  });
});

describe('profile store', () => {
  it('imports the installer file { name, avatar } once, sanitized, and adds the creation date', () => {
    const home = tempHome('profile');
    fs.writeFileSync(path.join(home, PROFILE_FILE), JSON.stringify({ name: '  Ana‮ ', avatar: 'bee-amber', token: 'not kept' }));
    const s = new ProfileStore({ home, now: () => Date.parse('2026-10-17T12:00:00Z') });
    expect(s.profile).toMatchObject({ name: 'Ana', avatar: 'bee-amber', bio: '', shareAchievements: false, createdAt: '2026-10-17T12:00:00.000Z' });
    const saved = JSON.parse(fs.readFileSync(path.join(home, PROFILE_FILE), 'utf8'));
    expect(saved).not.toHaveProperty('token');
    expect(saved.createdAt).toBe('2026-10-17T12:00:00.000Z');
    expect(readProfile(home).createdAt).toBe('2026-10-17T12:00:00.000Z');
    expect(() => s.set({ avatar: 'https://evil.example/me.png' })).toThrow(/unknown avatar/);
    expect(s.set({ name: 'Ana Lima', bio: 'Builds small sites.' }).profile.name).toBe('Ana Lima');
  });

  it('counts real events once per project, survives a restart, and unlocks achievements with their date', () => {
    const home = tempHome('profile');
    const at = Date.parse('2026-10-17T12:00:00Z');
    const s = new ProfileStore({ home, project: '/work/a', now: () => at });
    const ev = (seq, type, data) => ({ seq, type, ts: '2026-10-17T12:00:00Z', data });
    s.count(ev(1, 'job.done', { summary: 'ok' }));
    s.count(ev(2, 'file.changed', { path: 'a.js', op: 'create' }));
    s.count(ev(3, 'file.changed', { path: 'a.js', op: 'delete' }));
    s.count(ev(4, 'turn.ended', { ms: 3_600_000, completionTokens: 1200 }));
    s.count(ev(5, 'job.served', { outcome: 'completed', ms: 1_800_000, device: 'cuda:0' }));
    s.count(ev(6, 'p2p.peer', { peerId: PEER, online: true }));
    s.count(ev(6, 'job.done', {})); // the same sequence again: never counted twice
    s.count(ev(7, 'p2p.grant', { capability: 'remote.view', peerId: PEER }));
    const v = s.view();
    expect(v.stats).toMatchObject({ jobs: 1, projects: 1, files: 1, crewHours: 1, tokens: 1200, lentGpuHours: 0.5, lentJobs: 1, friends: 1, remoteSessions: 1 });
    const got = Object.fromEntries(v.achievements.map((a) => [a.id, a.unlockedAt]));
    expect(got.first_project).toBe('2026-10-17T12:00:00.000Z');
    expect(got.first_friend).toBe('2026-10-17T12:00:00.000Z');
    expect(got.first_lend).toBe('2026-10-17T12:00:00.000Z');
    expect(got.first_remote).toBe('2026-10-17T12:00:00.000Z');
    expect(got.files_100).toBe(null);
    s.flush();
    const again = new ProfileStore({ home, project: '/work/a', now: () => at + 86_400_000 });
    again.count(ev(7, 'job.done', {}));
    expect(again.view().stats.jobs).toBe(1);
    again.count(ev(8, 'job.done', {}));
    expect(again.view().stats.jobs).toBe(2);
    expect(again.view().achievements.find((a) => a.id === 'first_project').unlockedAt).toBe('2026-10-17T12:00:00.000Z');
    expect(JSON.parse(fs.readFileSync(path.join(home, STATS_FILE), 'utf8')).unlocked.first_project).toBe('2026-10-17T12:00:00.000Z');
  });

  it('keeps the stats local: peers get only the name and the avatar, the count only behind the switch', () => {
    const s = new ProfileStore({ home: tempHome('profile') });
    s.set({ name: 'Ben', avatar: 'orbit-violet', bio: 'private' });
    s.count({ seq: 1, type: 'job.done', ts: new Date().toISOString(), data: {} });
    expect(s.wire(PEER)).toEqual({ name: 'Ben', avatar: 'orbit-violet' });
    s.set({ shareAchievements: true });
    expect(s.wire(PEER)).toEqual({ name: 'Ben', avatar: 'orbit-violet', achievements: 1 });
  });

  it('computes streaks from the active days, never from a guess', () => {
    const now = Date.parse('2026-10-17T15:00:00');
    expect(streak(['2026-10-15', '2026-10-16', '2026-10-17'], now)).toBe(3);
    expect(streak(['2026-10-15', '2026-10-16'], now)).toBe(2);
    expect(streak(['2026-10-10'], now)).toBe(0);
    expect(bestStreak(['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-09'])).toBe(3);
    expect(domainOf('Developer')).toBe('code');
    expect(domainOf('Checks and tests')).toBe('test');
    const s = blankStats();
    expect(applyEvent(s, { type: 'brain.status', data: { state: 'ready', model: 'demo script' } })).toBe(false);
    expect(normalizeStats({ jobs: -5, files: 'x', friends: [1, 'a'] })).toMatchObject({ jobs: 0, files: 0, friends: ['a'] });
    expect(summary(blankStats()).streak).toBe(0);
    expect(unlock(blankStats(), {})).toEqual([]);
  });
});

describe('profile hello over a p2p session', () => {
  it('sends { name, avatar } after the join, sanitized on arrival, and lists it with the peer', async () => {
    const host = makeNode('rita');
    const guest = makeNode('ben');
    host.setProfile({ name: 'Rita', avatar: 'tower-amber', bio: 'never sent' });
    guest.setProfile({ name: 'Ben‮\u0000', avatar: 'data:image/png;base64,AAAA' });
    const invite = await host.createInvite({ caps: [] });
    const [hc, gc] = inprocPair();
    host.accept(hc);
    const requested = waitFor(host, 'join.request');
    const joined = await guest.join(invite.words, gc, { requestedCaps: [] });
    const request = await requested;
    host.answerJoin(request.requestId, { accept: true, sasMatches: true, caps: request.toggles.map((t) => ({ capability: t.capability, minutes: t.minutes })) });
    await joined.decision;
    await until(() => host.profileOf(guest.identity.peerId) && guest.profileOf(host.identity.peerId));
    expect(host.profileOf(guest.identity.peerId)).toEqual({ name: 'Ben', avatar: null });
    expect(guest.profileOf(host.identity.peerId)).toEqual({ name: 'Rita', avatar: 'tower-amber' });
    expect(host.listPeers().find((p) => p.identity.peerId === guest.identity.peerId).profile).toEqual({ name: 'Ben', avatar: null });
    // a change reaches the open session
    const changed = waitFor(guest, 'peer.profile');
    host.setProfile({ name: 'Rita L.', avatar: 'comb-green' });
    expect((await changed).profile).toEqual({ name: 'Rita L.', avatar: 'comb-green' });
    // and it is kept with the peer for the next run
    const stored = JSON.parse(fs.readFileSync(path.join(guest.home, 'peers', `${host.identity.peerId}.json`), 'utf8'));
    expect(stored.profile).toEqual({ name: 'Rita L.', avatar: 'comb-green' });
  });
});
