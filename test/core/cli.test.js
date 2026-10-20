// The subcommand shell (PLAN.md section 9).
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { splitCommand, parseArgs } from '../../src/cli.js';
import { parseFlags, registerSubcommand, unregisterSubcommand, loadSubcommand, isSubcommand, writeEngineFile, removeEngineFile, findEngine, engineFile } from '../../src/core/shell.js';
import { citySummary, formatCity } from '../../src/core/city-report.js';
import { coreChecks } from '../../src/core/doctor-checks.js';
import { startHive } from '../../src/index.js';
import { createFakeBrain } from '../../src/brain/fake.js';
import { loadToken } from '../../src/cli.js';
import { tmpDir } from '../helpers.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'cli.js');
const run = (args, home) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, HIVEDESK_HOME: home } });
// Not spawnSync while an engine runs in this process: the child talks to it.
const runAsync = (args, home) => new Promise((resolve) => {
  execFile(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, HIVEDESK_HOME: home } }, (err, stdout, stderr) => resolve({ status: err ? err.code : 0, stdout, stderr }));
});

describe('subcommands', () => {
  afterEach(() => unregisterSubcommand('extra'));

  it('splits the command line; no command is start, and --doctor still works', () => {
    expect(splitCommand([])).toEqual({ command: 'start', rest: [] });
    expect(splitCommand(['--port', '1'])).toEqual({ command: 'start', rest: ['--port', '1'] });
    expect(splitCommand(['city', '--json'])).toEqual({ command: 'city', rest: ['--json'] });
    expect(splitCommand(['--doctor', '--model', '3b'])).toEqual({ command: 'doctor', rest: ['--model', '3b'] });
    expect(splitCommand(['join', 'a b c d e f'])).toEqual({ command: 'join', rest: ['a b c d e f'] });
    expect(() => splitCommand(['nope'])).toThrow(/unknown command/);
    for (const c of ['start', 'city', 'invite', 'join', 'doctor', 'peers', 'share']) expect(isSubcommand(c)).toBe(true);
    expect(parseArgs(['--strict'])).toMatchObject({ strict: true });
  });

  it('parses flags for subcommands that register their own options', async () => {
    expect(parseFlags(['--max-vram', '6GB', '--on', 'x', '--no-download'], { 'max-vram': 'string', on: 'boolean', download: 'boolean' }))
      .toEqual({ flags: { 'max-vram': '6GB', on: true, download: false }, positionals: ['x'] });
    expect(() => parseFlags(['--wat'])).toThrow(/unknown option/);
    expect(() => parseFlags(['--dir'])).toThrow(/needs a value/);
    expect(() => parseFlags(['--json=1'])).toThrow(/takes no value/);
    expect((await loadSubcommand('invite', tmpDir())).missing).toMatch(/not in this build yet/);
    // src/p2p/cli.js style: P2P_SUBCOMMANDS of plain runners that parse their own arguments.
    const fake = tmpDir();
    fs.mkdirSync(path.join(fake, 'p2p'));
    fs.writeFileSync(path.join(fake, 'p2p', 'cli.js'), 'export const P2P_SUBCOMMANDS = { peers: (argv, o) => argv.length + (o.home ? 10 : 0) };');
    const peersCmd = await loadSubcommand('peers', fake);
    expect(peersCmd.def.raw).toBe(true);
    expect(await peersCmd.def.run(['--revoke', 'x'], { home: '/h' })).toBe(12);
    expect((await loadSubcommand('join', fake)).missing).toMatch(/no handler/);
    expect(isSubcommand('extra')).toBe(false);
    registerSubcommand('extra', { options: { on: 'boolean' }, run: () => 0 });
    expect(isSubcommand('extra')).toBe(true);
    expect((await loadSubcommand('extra')).def.options).toEqual({ on: 'boolean' });
    expect(() => registerSubcommand('extra', {})).toThrow(/run/);
  });

  it('prints the version and says when a subcommand is not in this build', () => {
    const home = tmpDir();
    expect(run(['--version'], home).stdout.trim()).toBe(JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version);
    expect(run(['help'], home).stdout).toMatch(/invite\s+invite a friend/);
    // invite, join and peers come from src/p2p/cli.js when the p2p module is in the build.
    if (!fs.existsSync(path.join(path.dirname(CLI), 'p2p', 'cli.js'))) {
      const join = run(['join', 'apple brave cat dog eel fox'], home);
      expect(join.status).toBe(3);
      expect(join.stderr).toMatch(/not in this build yet/);
      expect(join.stderr).toMatch(/--join <words>/);
      expect(run(['peers', '--wat'], home).status).toBe(3);
    } else {
      expect(run(['peers'], home).status).not.toBe(3);
    }
    // share runs runShare() of src/compute/share-cli.js when the compute module is in the build.
    const share = run(['share'], home);
    if (fs.existsSync(path.join(path.dirname(CLI), 'compute', 'share-cli.js'))) expect(share.status).toBe(0);
    else expect(share.stderr).toMatch(/not in this build yet/);
    expect(run(['bogus'], home).status).toBe(2);
  });

  it('hivedesk city reads the City of a project from its log, and from the running engine when there is one', async () => {
    const dir = tmpDir();
    const home = tmpDir();
    const app = await startHive({ dir, home, token: loadToken(home), brain: createFakeBrain({ respond: () => 'x' }) });
    await app.server.runCommand('tasks.create', { title: 'Paint the lobby', assignee: 'designer' });
    await app.server.runCommand('city.task.create', { title: 'Check the links', room: 'test' });
    // Live: the engine announces itself in <home>/engine.json.
    writeEngineFile(home, { port: app.server.port, dir });
    const live = await findEngine(home);
    expect(live.port).toBe(app.server.port);
    const out = await runAsync(['city', '--dir', dir, '--json'], home);
    expect(out.status).toBe(0);
    const s = JSON.parse(out.stdout);
    expect(s.source).toBe('engine');
    expect(s.tasks.counts.assigned).toBe(1);
    expect(s.tasks.open.map((t) => t.title)).toContain('Paint the lobby');
    expect(s.machines.find((m) => m.host).online).toBe(true);
    expect(s.agents.map((a) => a.id)).toContain('dev');
    removeEngineFile(home);
    expect(fs.existsSync(engineFile(home))).toBe(false);
    await app.close();
    // From the log, read only: nothing is written.
    const before = fs.readdirSync(path.join(dir, '.hivedesk', 'events')).map((f) => [f, fs.statSync(path.join(dir, '.hivedesk', 'events', f)).size]);
    const text = run(['city', '--dir', dir], home);
    expect(text.status).toBe(0);
    expect(text.stdout).toMatch(/read from the log/);
    expect(text.stdout).toMatch(/Tasks: queued \d+, assigned 1/);
    expect(text.stdout).toMatch(/\[assigned\] Paint the lobby \(designer\)/);
    expect(text.stdout).toMatch(/Peers online: none/);
    expect(fs.readdirSync(path.join(dir, '.hivedesk', 'events')).map((f) => [f, fs.statSync(path.join(dir, '.hivedesk', 'events', f)).size])).toEqual(before);
    expect(run(['city', '--dir', tmpDir()], home).status).toBe(1);
  });

  it('the city text names buildings, agents and peers', () => {
    const state = {
      city: { machines: { m1: { id: 'm1', name: 'My PC', host: true, online: true, agents: ['dev'] }, m2: { id: 'm2', name: "Rita's PC", online: true, agents: [] } }, agents: { dev: { id: 'dev', name: 'Dev', role: 'Developer', room: 'code', status: 'working', level: 2 } } },
      board: { order: ['tk_1'], tasks: { tk_1: { id: 'tk_1', title: 'X', state: 'waiting', waitingFor: { kind: 'approval' }, assignee: 'dev' } } }
    };
    const text = formatCity(citySummary(state, { dir: '/p', source: 'log' }));
    expect(text).toMatch(/\* My PC \(this machine\): online, 1 agents/);
    expect(text).toMatch(/Dev \(Developer\), level 2, working in code/);
    expect(text).toMatch(/\[waiting: approval\] X \(dev\)/);
    expect(text).toMatch(/Peers online: Rita's PC/);
  });

  it('doctor adds the home, project, log and port checks', async () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, '.hivedesk', 'events'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.hivedesk', 'events', '000001.jsonl'), '{"seq":1,"ts":"t","type":"x","data":{}}\n');
    const checks = await coreChecks({ home: tmpDir(), dir, port: 0 });
    expect(checks.map((c) => c.id)).toEqual(['home', 'project', 'log', 'port']);
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(checks.find((c) => c.id === 'log').detail).toMatch(/1 segment, no snapshot yet/);
  });
});
