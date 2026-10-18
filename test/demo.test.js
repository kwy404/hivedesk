// Strict demo separation (PLAN.md section 1.5).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startHive } from '../src/index.js';
import { createFakeBrain } from '../src/brain/fake.js';
import { EventBus } from '../src/core/bus.js';
import { prepareDemoDir, isDemoFolder, DemoRefused } from '../src/core/demo.js';
import { migrateProject } from '../src/core/migrate.js';
import { readEventsFile } from '../src/bus.js';
import { DEMO_FRIEND } from '../src/city/demo.js';
import { tmpDir, waitFor } from './helpers.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'src', 'cli.js');
const FIXTURE = path.join(HERE, 'tasks', 'fixtures', 'demo-in-real-0.2.jsonl');

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

describe('--demo stays in its own folder', () => {
  it('runs in a fresh marked folder with its own home, never writes to the home it was given, and cleans its home', async () => {
    const home = tmpDir();
    const app = await startHive({ demo: true, demoDelayMs: 0, demoApproveMs: 10, autoStartDemo: true, home });
    expect(isDemoFolder(app.dir)).toBe(true);
    expect(app.home.startsWith(app.dir)).toBe(true);
    await waitFor(() => app.bus.state.jobs[0]?.status === 'done', { timeout: 30000 });
    expect(app.bus.state.demo).toBe(true);
    expect(app.bus.events.every((e) => e.demo === true)).toBe(true);
    await app.close();
    expect(walk(home)).toEqual([]);
    expect(fs.existsSync(app.home)).toBe(false);
    for (const f of walk(app.dir)) expect(f.startsWith(app.dir)).toBe(true);
  });

  it('refuses a real project folder and any folder with files, and takes an empty or a demo folder', async () => {
    const real = tmpDir();
    const app = await startHive({ dir: real, home: tmpDir(), brain: createFakeBrain({ respond: () => 'x' }) });
    await app.close();
    await expect(startHive({ dir: real, demo: true })).rejects.toBeInstanceOf(DemoRefused);
    const withFiles = tmpDir();
    fs.writeFileSync(path.join(withFiles, 'notes.txt'), 'mine');
    expect(() => prepareDemoDir(withFiles)).toThrow(/real project folder/);
    expect(fs.readdirSync(withFiles)).toEqual(['notes.txt']);
    const empty = tmpDir();
    expect(prepareDemoDir(empty)).toBe(path.resolve(empty));
    expect(prepareDemoDir(empty)).toBe(path.resolve(empty));
    expect(prepareDemoDir(path.join(empty, 'not-yet'))).toBe(path.join(path.resolve(empty), 'not-yet'));
  });

  it('the command line says why and exits with 2', () => {
    const real = tmpDir();
    fs.mkdirSync(path.join(real, '.hivedesk'));
    fs.writeFileSync(path.join(real, '.hivedesk', 'events.jsonl'), '');
    const r = spawnSync(process.execPath, [CLI, '--demo', '--dir', real, '--no-open'], { encoding: 'utf8', env: { ...process.env, HIVEDESK_HOME: tmpDir() } });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--demo runs only in an empty folder or a demo folder/);
  });
});

describe('a real run is never labeled demo', () => {
  it('state.demo is not sticky: a demo session earlier in the log does not label the next real one', () => {
    const dir = path.join(tmpDir(), '.hivedesk');
    fs.mkdirSync(dir, { recursive: true });
    const demo = new EventBus({ dir, demo: true });
    demo.emit('session.started', { version: 't', demo: true });
    demo.emit('chat.message', { text: 'demo' });
    demo.close();
    const realBus = new EventBus({ dir });
    expect(realBus.state.demo).toBe(false);
    realBus.emit('session.started', { version: 't', demo: false });
    expect(realBus.state.demo).toBe(false);
    expect(realBus.stateAt(2).demo).toBe(false);
  });

  it('a 0.2 project whose log holds demo events moves them out once, with the demo machine and caches', async () => {
    const dir = tmpDir();
    const root = path.join(dir, '.hivedesk');
    fs.mkdirSync(path.join(root, 'city'), { recursive: true });
    fs.copyFileSync(FIXTURE, path.join(root, 'events.jsonl'));
    fs.writeFileSync(path.join(root, 'state.json'), JSON.stringify({ demo: true }));
    fs.writeFileSync(path.join(root, 'city', 'snapshot.json'), JSON.stringify({ seq: 1, city: { machines: { [DEMO_FRIEND.machine.id]: {} } } }));
    const before = readEventsFile(FIXTURE);
    const demoCount = before.filter((e) => e.demo).length;
    expect(demoCount).toBeGreaterThan(100);
    const app = await startHive({ dir, home: tmpDir(), brain: createFakeBrain({ respond: () => 'x' }) });
    expect(app.bus.state.demo).toBe(false);
    expect(app.bus.events.some((e) => e.demo)).toBe(false);
    expect(app.bus.state.city.machines[DEMO_FRIEND.machine.id]).toBeUndefined();
    expect(Object.values(app.bus.state.board.tasks).some((t) => /weekly specials/.test(t.title))).toBe(false);
    const moved = readEventsFile(path.join(root, 'events', 'demo-0.2.jsonl'));
    expect(moved).toHaveLength(demoCount);
    expect(moved.every((e) => e.demo === true)).toBe(true);
    const migrated = app.bus.events.find((e) => e.type === 'store.migrated' && e.data.migration === 'demo-0.2');
    expect(migrated.data.detail).toMatchObject({ moved: demoCount, kept: before.length - demoCount, machines: [DEMO_FRIEND.machine.id] });
    // The real tasks of that project are still there.
    expect(Object.keys(app.bus.state.tasks)).toContain('t_1_1');
    await app.close();
    const again = migrateProject(root);
    expect(again.applied).toEqual([]);
    const meta = JSON.parse(fs.readFileSync(path.join(root, 'meta.json'), 'utf8'));
    expect(meta.migrations.map((m) => m.id)).toEqual(['demo-0.2', 'layout-1.0']);
  });

  it('finishes a move that a crash interrupted', () => {
    const root = path.join(tmpDir(), '.hivedesk');
    fs.mkdirSync(path.join(root, 'events'), { recursive: true });
    const lines = [
      { seq: 1, ts: 't', type: 'session.started', data: { demo: false } },
      { seq: 2, ts: 't', type: 'chat.message', demo: true, data: { text: 'demo a' } },
      { seq: 3, ts: 't', type: 'chat.message', demo: true, data: { text: 'demo b' } }
    ];
    fs.writeFileSync(path.join(root, 'events.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    // As if the copy was written and the rewrite never happened.
    fs.writeFileSync(path.join(root, 'events', 'demo-0.2.jsonl'), JSON.stringify(lines[1]) + '\n');
    migrateProject(root);
    expect(readEventsFile(path.join(root, 'events', 'demo-0.2.jsonl')).map((e) => e.seq)).toEqual([2, 3]);
    expect(readEventsFile(path.join(root, 'events.jsonl')).map((e) => e.seq)).toEqual([1]);
  });
});
