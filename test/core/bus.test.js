import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { EventBus, SchemaError } from '../../src/core/bus.js';
import { SegmentLog, parseEvents, segmentName } from '../../src/core/log.js';
import { Store } from '../../src/core/store.js';
import { runWithOrigin, currentContext, normalizeOrigin, originOf, originLabel } from '../../src/core/origin.js';
import { replay } from '../../src/replay/reduce.js';
import { tmpDir } from '../helpers.js';

const root = () => {
  const r = path.join(tmpDir(), '.hivedesk');
  fs.mkdirSync(r, { recursive: true });
  return r;
};

describe('origin', () => {
  it('normalizes origins and labels them; events before 1.0 count as system', () => {
    expect(normalizeOrigin({ kind: 'peer', peerId: 'hd1abc', extra: 1 })).toEqual({ kind: 'peer', peerId: 'hd1abc' });
    expect(normalizeOrigin({ kind: 'peer' })).toEqual({ kind: 'system' });
    expect(normalizeOrigin({ kind: 'root' })).toEqual({ kind: 'system' });
    expect(normalizeOrigin({ kind: 'crew', agentId: 'dev' })).toEqual({ kind: 'crew', agentId: 'dev' });
    expect(originOf({ seq: 1, type: 'x' })).toEqual({ kind: 'system' });
    expect(originLabel({ kind: 'peer', peerId: 'hd1x', agentId: 'pip' })).toBe('peer:hd1x/pip');
    expect(originLabel({ kind: 'crew', agentId: 'qa' })).toBe('crew:qa');
  });

  it('gives every event the origin and cause of the work that emitted it, through awaits', async () => {
    const bus = new EventBus();
    expect(bus.emit('x').origin).toEqual({ kind: 'system' });
    const e = await runWithOrigin({ kind: 'user' }, async () => {
      await new Promise((r) => setTimeout(r, 5));
      expect(currentContext().cause).toBe('cm_1');
      return bus.emit('y');
    }, 'cm_1');
    expect(e).toMatchObject({ origin: { kind: 'user' }, cause: 'cm_1' });
    const own = runWithOrigin({ kind: 'user' }, () => bus.emit('z', {}, { origin: { kind: 'crew', agentId: 'dev' }, cause: 7 }));
    expect(own).toMatchObject({ origin: { kind: 'crew', agentId: 'dev' }, cause: 7 });
    expect(currentContext()).toBeUndefined();
  });
});

describe('schema checks on emit', () => {
  it('strict refuses unregistered and bad events and keeps the seq; check refuses only bad registered ones; warn counts', () => {
    const strict = new EventBus({ strict: true });
    expect(() => strict.emit('nobody.knows', {})).toThrow(SchemaError);
    expect(() => strict.emit('task.status', { status: 'done' })).toThrow(/taskId is required/);
    expect(strict.emit('task.status', { taskId: 't_1_1', status: 'done' }).seq).toBe(1);
    const check = new EventBus({ strict: 'check' });
    expect(check.emit('nobody.knows').seq).toBe(1);
    expect(() => check.emit('tasks.transition', { taskId: 'tk_1', from: 'queued', to: 'flying' })).toThrow(/must be one of/);
    const warn = new EventBus({ strict: false });
    warn.emit('tasks.transition', { taskId: 'tk_1', from: 'queued', to: 'flying' });
    expect(warn.warnings[0]).toMatchObject({ type: 'tasks.transition' });
    expect(warn.seq).toBe(1);
  });
});

describe('log segments', () => {
  it('reads the 0.x events.jsonl as segment 0 and writes new events to segments that roll over by size', () => {
    const r = root();
    fs.writeFileSync(path.join(r, 'events.jsonl'), [1, 2, 3].map((seq) => JSON.stringify({ seq, ts: 't', type: 'chat.message', data: { text: `old ${seq}` } })).join('\n') + '\n');
    const bus = new EventBus({ dir: r, segmentBytes: 600 });
    expect(bus.seq).toBe(3);
    expect(bus.state.chat.general.map((m) => m.text)).toEqual(['old 1', 'old 2', 'old 3']);
    for (let i = 0; i < 12; i++) bus.emit('chat.message', { channel: 'general', from: 'user', text: `new ${i} ${'x'.repeat(40)}` });
    bus.close();
    const log = new SegmentLog({ dir: path.join(r, 'events'), legacyFile: path.join(r, 'events.jsonl') });
    const segs = log.segments();
    expect(segs[0]).toMatchObject({ legacy: true, firstSeq: 0 });
    expect(segs.length).toBeGreaterThan(3);
    expect(path.basename(segs[1].file)).toBe(segmentName(4));
    for (const s of segs.slice(1, -1)) expect(fs.statSync(s.file).size).toBeLessThanOrEqual(600);
    expect(log.readAll().map((e) => e.seq)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
    expect(log.readFrom(10).map((e) => e.seq)).toEqual([11, 12, 13, 14, 15]);
    expect(fs.readFileSync(path.join(r, 'events.jsonl'), 'utf8').split('\n').filter(Boolean)).toHaveLength(3);
  });

  it('closes a torn last line before appending, so no event is glued to it', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'events.jsonl');
    fs.writeFileSync(file, JSON.stringify({ seq: 1, ts: 'x', type: 'a', data: {} }) + '\n{"seq":2,"ty');
    const bus = new EventBus({ file });
    bus.emit('b');
    bus.emit('c');
    expect(parseEvents(fs.readFileSync(file, 'utf8')).map((e) => [e.seq, e.type])).toEqual([[1, 'a'], [2, 'b'], [3, 'c']]);
  });

  it('opens read only for tools like "hivedesk city"', () => {
    const r = root();
    new EventBus({ dir: r }).emit('settings.changed', { sound: false });
    const ro = new EventBus({ dir: r, readOnly: true });
    expect(ro.state.settings.sound).toBe(false);
    expect(() => ro.emit('x')).toThrow(/read only/);
  });
});

describe('snapshots and restore', () => {
  const fill = (bus, n) => { for (let i = 0; i < n; i++) bus.emit('chat.message', { channel: 'general', from: 'user', text: `m${i}` }); };

  it('writes a snapshot every N events and on close, and a start replays only the tail', () => {
    const r = root();
    const a = new EventBus({ dir: r, snapshotEvery: 10 });
    fill(a, 25);
    expect(a.info().snapshots).toEqual([20, 10]);
    a.close();
    expect(a.info().snapshots[0]).toBe(25);
    fill(new EventBus({ dir: r, snapshotEvery: 1000 }), 0);
    const b = new EventBus({ dir: r, snapshotEvery: 1000 });
    expect(b.restore).toMatchObject({ snapshotSeq: 25, replayed: 0 });
    fill(b, 3);
    const c = new EventBus({ dir: r, snapshotEvery: 1000 });
    expect(c.restore).toMatchObject({ snapshotSeq: 25, replayed: 3 });
    expect(c.state.chat.general.map((m) => m.text).slice(-4)).toEqual(['m24', 'm0', 'm1', 'm2']);
    // The same state as a replay from the first event.
    const full = new Store().replay(c.events);
    expect(JSON.parse(JSON.stringify(c.state))).toEqual(JSON.parse(JSON.stringify({ ...full, demo: false, lend: false })));
  });

  it('loads the history before the snapshot only when asked, and stateAt works on both sides of it', () => {
    const r = root();
    const a = new EventBus({ dir: r, snapshotEvery: 10 });
    fill(a, 15);
    a.close();
    const b = new EventBus({ dir: r });
    expect(b._all).toBe(null);
    expect(b.since(15)).toEqual([]);
    expect(b._all).toBe(null);
    expect(b.since(14).map((e) => e.seq)).toEqual([15]);
    expect(b.since(0, 3).map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(b.events).toHaveLength(15);
    b.emit('chat.message', { channel: 'general', from: 'user', text: 'late' });
    expect(b.events).toHaveLength(16);
    expect(b.stateAt(5).chat.general).toHaveLength(5);
    expect(b.stateAt(15).chat.general).toHaveLength(15);
    expect(b.stateAt(Infinity).chat.general.at(-1).text).toBe('late');
  });

  it('ignores a snapshot from other reducers, a broken one and one ahead of the log', () => {
    const r = root();
    const a = new EventBus({ dir: r, snapshotEvery: 5 });
    fill(a, 12);
    a.close();
    const snaps = path.join(r, 'snapshots');
    const newest = JSON.parse(fs.readFileSync(path.join(snaps, '12.json'), 'utf8'));
    fs.writeFileSync(path.join(snaps, '12.json'), JSON.stringify({ ...newest, store: { ...newest.store, v: 999 } }));
    fs.writeFileSync(path.join(snaps, '10.json'), '{"broken');
    fs.writeFileSync(path.join(snaps, '99.json'), JSON.stringify({ ...newest, seq: 99 }));
    const b = new EventBus({ dir: r });
    expect(b.restore.snapshotSeq).toBe(5);
    expect(b.restore.replayed).toBe(7);
    expect(b.state.chat.general).toHaveLength(12);
  });

  it('keeps only the newest three snapshots', () => {
    const r = root();
    const a = new EventBus({ dir: r, snapshotEvery: 2 });
    fill(a, 11);
    expect(a.info().snapshots).toEqual([10, 8, 6]);
  });
});

describe('the 0.x API stays', () => {
  it('replays state the way 0.2 did for crew events', () => {
    const bus = new EventBus();
    bus.emit('crew.hired', { worker: { id: 'dev', name: 'Dev', tools: [] } });
    bus.emit('settings.changed', { approvalMode: false });
    const old = replay(bus.events);
    expect(bus.state.crew).toEqual(old.crew);
    expect(bus.state.settings).toEqual(old.settings);
    expect(bus.state.board.order).toEqual([]);
    expect(bus.state.city.v).toBe(1);
  });
});
