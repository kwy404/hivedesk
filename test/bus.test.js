import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { EventBus, readEventsFile, initHome } from '../src/bus.js';
import { replay, initialState, reduce } from '../src/replay/reduce.js';
import { marks, filesAt, stateAtFile } from '../src/replay/index.js';
import { tmpDir } from './helpers.js';

describe('event log', () => {
  it('appends events with increasing seq and continues after a restart', () => {
    const dir = tmpDir();
    const p = initHome(dir);
    const a = new EventBus({ file: p.events });
    a.emit('chat.message', { id: 'm1', channel: 'general', from: 'user', text: 'hi' });
    a.emit('chat.message', { id: 'm2', channel: 'general', from: 'mel', text: 'hello' }, { jobId: 'j_1' });
    a.close();
    const b = new EventBus({ file: p.events });
    const e = b.emit('settings.changed', { approvalMode: false });
    expect(e.seq).toBe(3);
    const all = readEventsFile(p.events);
    expect(all.map((x) => x.seq)).toEqual([1, 2, 3]);
    expect(all[1].jobId).toBe('j_1');
    expect(b.state.chat.general.map((m) => m.text)).toEqual(['hi', 'hello']);
    expect(b.state.settings.approvalMode).toBe(false);
  });

  it('skips a torn last line', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'events.jsonl');
    fs.writeFileSync(file, JSON.stringify({ seq: 1, ts: 'x', type: 'a', data: {} }) + '\n{"seq":2,"ty');
    expect(readEventsFile(file)).toHaveLength(1);
    const bus = new EventBus({ file });
    expect(bus.emit('b').seq).toBe(2);
  });

  it('labels every event in demo mode', () => {
    const bus = new EventBus({ demo: true });
    expect(bus.emit('x').demo).toBe(true);
    expect(bus.state.demo).toBe(true);
    const normal = new EventBus();
    expect(normal.emit('x').demo).toBeUndefined();
  });

  it('writes a snapshot on close', () => {
    const dir = tmpDir();
    const p = initHome(dir);
    const bus = new EventBus({ file: p.events, snapshotFile: p.state });
    bus.emit('settings.changed', { sound: false });
    bus.close();
    const snap = JSON.parse(fs.readFileSync(p.state, 'utf8'));
    expect(snap.settings.sound).toBe(false);
    expect(snap.lastSeq).toBe(1);
  });

  it('a throwing listener does not break the log', () => {
    const bus = new EventBus();
    bus.on(() => { throw new Error('boom'); });
    const seen = [];
    bus.on((e) => seen.push(e.type));
    bus.emit('a');
    expect(seen).toEqual(['a']);
  });
});

describe('replay', () => {
  function sample() {
    const bus = new EventBus();
    bus.emit('crew.hired', { worker: { id: 'dev', name: 'Dev', tools: [] } });
    bus.emit('job.created', { job: { id: 'j_1', request: 'page', status: 'planning', taskIds: [] } }, { jobId: 'j_1' });
    bus.emit('job.planned', { tasks: [{ id: 't_1_1', jobId: 'j_1', title: 'Build', assignee: 'dev', dependsOn: [], status: 'pending', attempts: 0 }] }, { jobId: 'j_1' });
    bus.emit('task.status', { taskId: 't_1_1', status: 'running' }, { jobId: 'j_1' });
    bus.emit('file.changed', { path: 'index.html', op: 'create', bytes: 2, content: 'v1' }, { jobId: 'j_1' });
    bus.emit('approval.requested', { approval: { id: 'a1', jobId: 'j_1', tool: 'run' } }, { jobId: 'j_1' });
    bus.emit('approval.resolved', { approvalId: 'a1', approved: true, by: 'user' }, { jobId: 'j_1' });
    bus.emit('file.changed', { path: 'index.html', op: 'modify', bytes: 2, content: 'v2' }, { jobId: 'j_1' });
    bus.emit('task.status', { taskId: 't_1_1', status: 'done' }, { jobId: 'j_1' });
    bus.emit('job.done', { summary: 'ok', files: ['index.html'] }, { jobId: 'j_1' });
    return bus;
  }

  it('rebuilds any moment from the events', () => {
    const bus = sample();
    const mid = bus.stateAt(6);
    expect(mid.tasks.t_1_1.status).toBe('running');
    expect(mid.approvals).toHaveLength(1);
    expect(mid.files['index.html'].content).toBe('v1');
    const end = bus.stateAt(Infinity);
    expect(end.jobs[0].status).toBe('done');
    expect(end.approvals).toHaveLength(0);
    expect(end.files['index.html'].content).toBe('v2');
    expect(end).toEqual(JSON.parse(JSON.stringify(bus.state)));
  });

  it('gives scrubber marks and files at a point', () => {
    const bus = sample();
    const m = marks(bus.events);
    expect(m.map((x) => x.kind)).toEqual(['job', 'approval', 'done']);
    expect(filesAt(bus.events, 5)).toEqual({ 'index.html': 'v1' });
    expect(filesAt(bus.events)).toEqual({ 'index.html': 'v2' });
  });

  it('reads a log file', () => {
    const dir = tmpDir();
    const p = initHome(dir);
    const bus = new EventBus({ file: p.events });
    bus.emit('settings.changed', { approvalMode: false });
    expect(stateAtFile(p.events).settings.approvalMode).toBe(false);
    expect(stateAtFile(p.events, 0).settings.approvalMode).toBe(true);
  });

  it('ignores unknown event types and keeps chat bounded', () => {
    const s = initialState();
    reduce(s, { seq: 1, ts: 't', type: 'something.new', data: { x: 1 } });
    for (let i = 0; i < 250; i++) reduce(s, { seq: i + 2, ts: 't', type: 'chat.message', data: { channel: 'general', from: 'u', text: String(i) } });
    expect(s.chat.general).toHaveLength(200);
    expect(s.chat.general[199].text).toBe('249');
    expect(replay([], 0).lastSeq).toBe(0);
  });
});
