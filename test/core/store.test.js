import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Store, registerDomain, unregisterDomain, domains, STORE_VERSION } from '../../src/core/store.js';
import { EventBus } from '../../src/core/bus.js';
import { validate, obj, str, int, arr } from '../../src/core/schema.js';
import { registerEvent, checkEvent, registerEventPrefix, eventSpec } from '../../src/core/events.js';
import { registerMigration, migrateJson, readVersioned, writeVersioned, declareVersion, currentVersion } from '../../src/core/migrate.js';
import { createDeadline, withDeadline, msUntil, isoIn } from '../../src/core/deadline.js';
import { tmpDir } from '../helpers.js';

const counter = { name: 'counter', version: 1, initial: () => ({ n: 0 }), reduce: (s, e) => { if (e.type === 'chat.message') s.n += 1; return s; } };

describe('store by domain', () => {
  afterEach(() => { try { unregisterDomain('counter'); } catch { /* not there */ } });

  it('mounts crew at the root, city, board and registered domains, and dumps and loads them', () => {
    registerDomain(counter);
    expect(domains().map((d) => d.name)).toEqual(['crew', 'city', 'tasks', 'counter']);
    const s = new Store();
    s.apply({ seq: 1, ts: 't', type: 'chat.message', data: { text: 'hi' } });
    expect(s.state.counter.n).toBe(1);
    expect(s.get('crew')).toBe(s.state);
    expect(s.get('tasks')).toBe(s.state.board);
    const dump = s.dump();
    expect(dump.v).toBe(STORE_VERSION);
    expect(Object.keys(dump.state.crew)).not.toContain('board');
    const t = new Store();
    expect(t.load(dump)).toBe(true);
    expect(t.state.counter.n).toBe(1);
    expect(t.state.chat.general[0].text).toBe('hi');
    // A different set of domains does not take the dump.
    unregisterDomain('counter');
    expect(new Store().load(dump)).toBe(false);
  });

  it('refuses reserved mounts and keeps a throwing reducer from breaking the log', () => {
    expect(() => registerDomain({ ...counter, name: 'jobs' })).toThrow(/cannot mount/);
    expect(() => registerDomain({ name: 'X', initial() {}, reduce() {} })).toThrow(/lower case/);
    const bad = { name: 'boom', version: 1, initial: () => ({}), reduce: () => { throw new Error('nope'); } };
    const s = new Store({ domains: [...domains(), bad] });
    s.apply({ seq: 1, ts: 't', type: 'x', data: {} });
    expect(s.errors[0]).toMatchObject({ domain: 'boom', seq: 1, message: 'nope' });
  });

  it('a bus given extra domains replays them from its log', () => {
    const dir = path.join(tmpDir(), '.hivedesk');
    const list = [...domains(), counter];
    const a = new EventBus({ dir, domains: list });
    a.emit('chat.message', { text: 'a' });
    a.emit('chat.message', { text: 'b' });
    a.close();
    expect(new EventBus({ dir, domains: list }).state.counter.n).toBe(2);
  });
});

describe('schema', () => {
  it('checks types, required fields, enums, lengths, patterns, items and unknown fields', () => {
    const s = obj({ name: str(5, { pattern: '^[a-z]+$' }), n: int(1, 3), tags: arr(str(3), 2), kind: { enum: ['a', 'b'] } }, ['name'], { additionalProperties: false });
    expect(validate(s, { name: 'abc', n: 2, tags: ['x'], kind: 'a' })).toEqual([]);
    const errs = validate(s, { name: 'ABCDEFG', n: 9, tags: ['long', 'x', 'y'], kind: 'c', extra: 1 });
    expect(errs.join('\n')).toMatch(/longer than 5/);
    expect(errs.join('\n')).toMatch(/does not match/);
    expect(errs.join('\n')).toMatch(/above 3/);
    expect(errs.join('\n')).toMatch(/more than 2 items/);
    expect(errs.join('\n')).toMatch(/must be one of a, b/);
    expect(errs.join('\n')).toMatch(/unknown field extra/);
    expect(validate(s, {})).toEqual(['$: name is required']);
    expect(validate({ anyOf: [{ type: 'string' }, { type: 'integer' }] }, true)[0]).toMatch(/none of/);
    let sch = { type: 'object' };
    let val = {};
    const s0 = sch;
    const v0 = val;
    for (let i = 0; i < 40; i++) { sch.properties = { a: { type: 'object' } }; sch = sch.properties.a; val.a = {}; val = val.a; }
    expect(validate(s0, v0).join()).toMatch(/nested too deep/);
  });

  it('keeps a registry of event types, with families for streams that have not listed theirs yet', () => {
    registerEvent('test.thing', obj({ id: str(10) }, ['id']));
    expect(checkEvent('test.thing', { id: 'x' })).toEqual({ known: true, errors: [] });
    expect(checkEvent('test.thing', {}).errors[0]).toMatch(/id is required/);
    expect(checkEvent('nobody.else', {}).known).toBe(false);
    registerEventPrefix('fam.');
    expect(eventSpec('fam.anything').domain).toBe('fam');
    expect(checkEvent('remote.view.started', {}).known).toBe(true);
    expect(checkEvent('tasks.created', { task: { id: 'x' } }).errors.length).toBeGreaterThan(0);
    // The compute plane's events (docs/1.0/protocol/compute.md); job.created is shared with the crew jobs.
    expect(checkEvent('job.state', { jobId: 'jb_1', state: 'running' }).errors).toEqual([]);
    expect(checkEvent('job.state', { jobId: 'jb_1', state: 'flying' }).errors[0]).toMatch(/must be one of/);
    expect(checkEvent('job.ended', { jobId: 'jb_1', state: 'failed', worker: null, reason: undefined }).errors).toEqual([]);
    expect(checkEvent('job.created', { job: { id: 'j_1' } }).errors).toEqual([]);
    expect(checkEvent('job.created', { jobId: 'jb_1', model: '3b', priority: 'normal' }).errors).toEqual([]);
    expect(checkEvent('share.changed', {}).errors[0]).toMatch(/share is required/);
  });
});

describe('migrations', () => {
  it('upgrades step by step, refuses files from a newer hivedesk, and writes with tmp plus rename', () => {
    registerMigration('test.file', 0, (d) => ({ ...d, name: d.title || 'none' }));
    registerMigration('test.file', 1, (d) => ({ ...d, tags: [] }));
    expect(currentVersion('test.file')).toBe(2);
    expect(migrateJson('test.file', { title: 'Old' })).toEqual({ title: 'Old', name: 'Old', tags: [], v: 2 });
    expect(migrateJson('test.file', { v: 1, name: 'n' })).toEqual({ v: 2, name: 'n', tags: [] });
    expect(() => migrateJson('test.file', { v: 3 })).toThrow(/newer hivedesk/);
    expect(() => migrateJson('unknown.kind', {})).toThrow(/no migrations/);
    const file = path.join(tmpDir(), 'x', 'f.json');
    writeVersioned(file, 'test.file', { name: 'n', tags: ['a'] });
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).v).toBe(2);
    expect(readVersioned(file, 'test.file')).toMatchObject({ name: 'n', tags: ['a'] });
    expect(readVersioned(path.join(tmpDir(), 'none.json'), 'test.file', 'fallback')).toBe('fallback');
    fs.writeFileSync(file, JSON.stringify({ v: 9 }));
    expect(() => readVersioned(file, 'test.file')).toThrow(/newer/);
    declareVersion('test.plain', 1);
    expect(migrateJson('test.plain', {})).toEqual({ v: 1 });
  });
});

describe('deadlines', () => {
  it('measures what is left and rejects work that runs past its deadline, aborting its signal', async () => {
    let now = 1000;
    const d = createDeadline(500, { now: () => now });
    expect(d.remaining()).toBe(500);
    now = 1600;
    expect(d.expired()).toBe(true);
    expect(msUntil(null)).toBe(Infinity);
    expect(msUntil(isoIn(10_000))).toBeGreaterThan(9000);
    expect(await withDeadline(async () => 'ok', 1000)).toBe('ok');
    let aborted = false;
    await expect(withDeadline((signal) => new Promise(() => { signal.addEventListener('abort', () => { aborted = true; }); }), 20)).rejects.toMatchObject({ code: 'timeout' });
    expect(aborted).toBe(true);
    const ctrl = new AbortController();
    const p = withDeadline(() => new Promise(() => {}), 5000, { signal: ctrl.signal });
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ code: 'cancelled' });
  });
});
