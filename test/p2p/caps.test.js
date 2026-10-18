// Capabilities, grants, the peer store and the hash chained audit log.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CAPABILITY_NAMES, COMPUTE_RESOURCES, effectiveCompute, findGrant, isActive, joinDialogToggles, makeGrant, normalizeCapability, normalizeCapList, readWireGrant, GB } from '../../src/p2p/caps.js';
import { AuditLog, GENESIS } from '../../src/p2p/audit.js';
import { PeerStore } from '../../src/p2p/peers.js';
import { loadOrCreateIdentity, publicIdentity, readPeerIdentity } from '../../src/p2p/identity.js';
import { messageSpec, messageTypes } from '../../src/p2p/messages.js';
import { cleanHomes, clock, tempHome } from './helpers.js';

afterEach(cleanHomes);

const USER = { kind: 'user' };
const PEER = 'hd1' + 'a'.repeat(49);

describe('capabilities', () => {
  it('has GPU, CPU, RAM and storage as separate capabilities with their own limits', () => {
    for (const n of ['compute.gpu', 'compute.cpu', 'compute.ram', 'compute.storage', 'compute.inference']) expect(CAPABILITY_NAMES).toContain(n);
    expect(COMPUTE_RESOURCES).toEqual(['compute.gpu', 'compute.cpu', 'compute.ram', 'compute.storage']);
    expect(normalizeCapability({ name: 'compute.gpu', limits: { maxVramBytes: 8 * GB, gpus: ['0', 'x', '1'], evil: 1 } })).toEqual({ name: 'compute.gpu', limits: { maxVramBytes: 8 * GB, gpus: ['0', '1'], maxUtilPct: 100 } });
    expect(normalizeCapability({ name: 'compute.cpu', limits: { maxThreads: 9999, maxLoadPct: -5 } }).limits).toEqual({ maxThreads: 256, maxLoadPct: 1 });
    expect(normalizeCapability('compute.ram').limits).toEqual({ maxBytes: 2 * GB });
    expect(normalizeCapability({ name: 'compute.storage', limits: { maxBytes: 20 * GB, modelDownload: 'yes' } }).limits).toEqual({ maxBytes: 20 * GB, modelDownload: false });
    expect(() => normalizeCapability('shell.exec')).toThrow(/unknown capability/);
    expect(normalizeCapList(['chat', 'nope', 'chat', { name: 'compute.cpu' }]).map((c) => c.name)).toEqual(['chat', 'compute.cpu']);
  });

  it('compute needs inference plus a GPU or CPU grant; each resource keeps its own limit', () => {
    const now = Date.parse('2026-10-17T12:00:00Z');
    const g = (capability) => makeGrant({ peerId: PEER, capability, origin: USER, now });
    expect(effectiveCompute([g('compute.inference')], now).allowed).toBe(false);
    const grants = [g('compute.inference'), g({ name: 'compute.gpu', limits: { maxVramBytes: 3 * GB } }), g({ name: 'compute.ram', limits: { maxBytes: GB } })];
    const c = effectiveCompute(grants, now);
    expect(c.allowed).toBe(true);
    expect(c.gpu.maxVramBytes).toBe(3 * GB);
    expect(c.ram.maxBytes).toBe(GB);
    expect(c.cpu).toBeNull();
    expect(c.storage).toBeNull();
  });

  it('grants are made by a person, expire, and session grants stay in their session', () => {
    const now = Date.parse('2026-10-17T12:00:00Z');
    expect(() => makeGrant({ peerId: PEER, capability: 'chat', origin: { kind: 'peer' }, now })).toThrow(/only a person/);
    expect(() => makeGrant({ peerId: PEER, capability: 'remote.view', origin: USER, now })).toThrow(/open session/);
    expect(() => makeGrant({ peerId: PEER, capability: 'chat', origin: USER, trust: 'blocked', now })).toThrow(/blocked/);
    expect(() => makeGrant({ peerId: PEER, capability: 'chat', minutes: null, trust: 'unknown', origin: USER, now })).toThrow(/expiry/);
    const s = makeGrant({ peerId: PEER, capability: 'remote.control', sessionId: 'ss_1', origin: USER, now, minutes: 60 });
    expect(s.scope).toBe('session');
    expect(isActive(s, now, 'ss_1')).toBe(true);
    expect(isActive(s, now, 'ss_2')).toBe(false);
    expect(isActive(s, now + 60 * 60_000)).toBe(false);
    // control implies view
    expect(findGrant([s], 'remote.view', now, 'ss_1').id).toBe(s.id);
    const capped = makeGrant({ peerId: PEER, capability: 'compute.gpu', minutes: 10 ** 9, origin: USER, now });
    expect(Date.parse(capped.expiresAt) - now).toBe(30 * 24 * 60 * 60_000);
    expect(capped.id).toMatch(/^gr_[a-z2-7]{12}$/);
  });

  it('reads only well formed grants addressed to us', () => {
    const now = Date.now();
    const g = makeGrant({ peerId: PEER, capability: 'compute.cpu', origin: USER, now });
    expect(readWireGrant(g, PEER)).toMatchObject({ id: g.id, capability: { name: 'compute.cpu' } });
    expect(readWireGrant(g, 'hd1' + 'b'.repeat(49))).toBeNull();
    expect(readWireGrant({ ...g, id: 'x' }, PEER)).toBeNull();
    expect(readWireGrant({ ...g, capability: { name: 'root' } }, PEER)).toBeNull();
  });

  it('join dialog toggles: city.view on, every other requested or offered capability off', () => {
    const t = joinDialogToggles(['compute.gpu', 'remote.view'], ['compute.inference']);
    expect(t.map((x) => [x.capability.name, x.on])).toEqual([['compute.inference', false], ['compute.gpu', false], ['remote.view', false], ['city.view', true]]);
    expect(t.find((x) => x.capability.name === 'remote.view')).toMatchObject({ standing: false, choices: [5, 15, 60] });
  });

  it('every message type in the table names its stream, and job.offer needs compute.inference', () => {
    for (const t of messageTypes()) expect([1, 2, 3]).toContain(messageSpec(t).stream);
    expect(messageSpec('job.offer')).toMatchObject({ stream: 2, cap: 'compute.inference' });
    expect(messageSpec('job.cancel').stream).toBe(1);
    expect(messageSpec('presence').cap).toBe('city.view');
    expect(messageSpec('cap.request').rate).toEqual([5, 60_000]);
  });
});

describe('peer store', () => {
  it('keeps one file per peer with standing grants; session grants never reach the disk', () => {
    const home = tempHome();
    const dir = path.join(home, 'peers');
    const { identity } = loadOrCreateIdentity(tempHome(), { name: 'Ben' });
    const pid = readPeerIdentity(publicIdentity(identity));
    const store = new PeerStore({ dir });
    store.upsert(pid, { trust: 'known', relation: 'guest' });
    const now = Date.now();
    store.addGrant(makeGrant({ peerId: pid.peerId, capability: 'compute.cpu', origin: USER, now }));
    store.addGrant(makeGrant({ peerId: pid.peerId, capability: 'remote.view', sessionId: 'ss_x', minutes: 5, origin: USER, now }));
    const file = JSON.parse(fs.readFileSync(path.join(dir, `${pid.peerId}.json`), 'utf8'));
    expect(file).toMatchObject({ v: 1, peerId: pid.peerId, trust: 'known', relation: 'guest' });
    expect(file.grants.map((g) => g.capability.name)).toEqual(['compute.cpu']);
    const again = new PeerStore({ dir });
    expect(again.get(pid.peerId).trust).toBe('known');
    expect(again.activeGrants(pid.peerId)).toHaveLength(1);
    // A file whose key does not match its name is reported, not loaded.
    fs.writeFileSync(path.join(dir, `${PEER}.json`), JSON.stringify({ ...file, peerId: PEER }));
    const third = new PeerStore({ dir });
    expect(third.get(PEER)).toBeNull();
    expect(third.errors.map((e) => e.file)).toContain(`${PEER}.json`);
    // blocked stays blocked through an upsert
    third.setTrust(pid.peerId, 'blocked');
    third.upsert(pid, { trust: 'known' });
    expect(third.get(pid.peerId).trust).toBe('blocked');
  });
});

describe('audit log', () => {
  it('chains every entry to the previous one, across months, and finds any edit', () => {
    const now = clock(Date.parse('2026-10-31T23:59:00Z'));
    const dir = path.join(tempHome(), 'audit');
    const log = new AuditLog({ dir, now });
    const a = log.append({ type: 'grant', peerId: PEER, capability: 'compute.gpu' });
    expect(a.prevHash).toBe(GENESIS);
    now.advance(120_000);
    const b = log.append({ type: 'revoke', peerId: PEER, words: 'secret words', prompt: 'secret' });
    expect(b.prevHash).toBe(a.hash);
    expect(b.entry).toEqual({ type: 'revoke', peerId: PEER });
    expect(fs.readdirSync(dir).sort()).toEqual(['2026-10.jsonl', '2026-11.jsonl']);
    expect(log.verify()).toMatchObject({ ok: true, count: 2, lastHash: b.hash });

    // Reopening continues the chain.
    const log2 = new AuditLog({ dir, now });
    const c = log2.append({ type: 'block', peerId: PEER });
    expect(c.seq).toBe(3);
    expect(c.prevHash).toBe(b.hash);

    const file = path.join(dir, '2026-10.jsonl');
    const text = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, text.replace('compute.gpu', 'compute.cpu'));
    expect(log2.verify()).toMatchObject({ ok: false, reason: 'entry was changed' });
    fs.writeFileSync(file, text);
    expect(log2.verify().ok).toBe(true);
    // Deleting a line breaks the sequence.
    fs.writeFileSync(file, '');
    expect(log2.verify().ok).toBe(false);
  });

  it('drops a torn last line left by a crash and keeps the chain linear', () => {
    const dir = path.join(tempHome(), 'audit');
    const log = new AuditLog({ dir });
    log.append({ type: 'one' });
    const f = path.join(dir, fs.readdirSync(dir)[0]);
    fs.appendFileSync(f, '{"seq":2,"ts":"20');
    const log2 = new AuditLog({ dir });
    expect(log2.repaired.droppedBytes).toBeGreaterThan(0);
    log2.append({ type: 'two' });
    expect(log2.verify()).toMatchObject({ ok: true, count: 2 });
    expect(log2.tail(5).map((r) => r.entry.type)).toEqual(['one', 'two']);
  });
});
