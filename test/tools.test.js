import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Workspace, PathError } from '../src/tools/workspace.js';
import { ToolBox, actionSchema, TOOLS } from '../src/tools/index.js';
import { Approvals } from '../src/tools/approvals.js';
import { runCommand, planCommand, splitArgs } from '../src/tools/run.js';
import { unifiedDiff, diffStats } from '../src/tools/diff.js';
import { checkHtml, checkCss, checkWorkspace } from '../src/tools/check.js';
import { EventBus } from '../src/bus.js';
import { validate } from '../src/brain/schema.js';
import { tmpDir, waitFor } from './helpers.js';

describe('workspace sandbox', () => {
  const ws = new Workspace(path.join(tmpDir(), 'ws'));

  it.each([
    ['../outside.txt'],
    ['a/../../outside.txt'],
    ['/etc/passwd'],
    ['\\Windows\\win.ini'],
    ['C:/Windows/win.ini'],
    ['c:secret'],
    ['//server/share/x'],
    ['\\\\server\\share\\x'],
    ['~/x'],
    ['ok\0.txt'],
    ['nul'],
    ['con.txt'],
    ['a:b']
  ])('refuses %j', (p) => {
    expect(() => ws.resolve(p)).toThrow(PathError);
    expect(() => ws.write(p, 'x')).toThrow();
  });

  it('accepts normal relative paths', () => {
    expect(ws.resolve('index.html')).toBe(path.join(ws.root, 'index.html'));
    expect(ws.resolve('./css/site.css')).toBe(path.join(ws.root, 'css', 'site.css'));
    expect(ws.resolve('a\\b.txt')).toBe(path.join(ws.root, 'a', 'b.txt'));
  });

  it('refuses a symlink that points outside', () => {
    const outside = tmpDir('hivedesk-outside-');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
    const link = path.join(ws.root, 'link');
    try {
      fs.symlinkSync(outside, link, 'junction');
    } catch {
      return; // no permission to create links on this machine
    }
    expect(() => ws.read('link/secret.txt')).toThrow(/link/);
    expect(() => ws.write('link/new.txt', 'x')).toThrow(/link/);
    expect(ws.list().some((f) => f.path.startsWith('link'))).toBe(false);
  });

  it('writes, edits, lists, reads and deletes', () => {
    const w = new Workspace(path.join(tmpDir(), 'ws2'));
    expect(w.write('src/a.js', 'let a = 1;\n').before).toBeNull();
    expect(w.edit('src/a.js', '1', '2').after).toBe('let a = 2;\n');
    expect(() => w.edit('src/a.js', 'zzz', 'y')).toThrow('not found');
    w.write('b.txt', 'x x');
    expect(() => w.edit('b.txt', 'x', 'y')).toThrow('2 times');
    expect(w.list().map((f) => f.path)).toEqual(['b.txt', 'src/a.js']);
    expect(w.read('src/a.js')).toContain('2');
    w.remove('b.txt');
    expect(w.exists('b.txt')).toBe(false);
    expect(() => w.remove('.')).toThrow();
    expect(() => w.write('big.txt', 'x'.repeat(600 * 1024))).toThrow('too large');
  });
});

describe('run tool', () => {
  it('splits arguments with quotes', () => {
    expect(splitArgs('node "my file.js" --x \'a b\'')).toEqual(['node', 'my file.js', '--x', 'a b']);
    expect(() => splitArgs('node "open')).toThrow('unclosed');
  });

  it.each([
    ['rm -rf /'],
    ['curl http://example.com'],
    ['npm install left-pad'],
    ['npx something'],
    ['node a.js; rm x'],
    ['node a.js && echo hi'],
    ['node --allow-fs-read=* a.js'],
    ['node -r ./evil.js a.js'],
    ['powershell -c x'],
    ['']
  ])('refuses %j', (cmd) => {
    expect(() => planCommand(cmd, process.cwd())).toThrow();
  });

  it('runs node in the workspace with a timeout and an output cap', async () => {
    const ws = new Workspace(path.join(tmpDir(), 'run'));
    ws.write('hello.js', 'console.log("hi " + process.cwd().length); console.error("warn");');
    const r = await runCommand('node hello.js', { cwd: ws.root });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/^hi \d+/);
    expect(r.stderr).toContain('warn');
    ws.write('loop.js', 'setInterval(() => {}, 1000);');
    const t = await runCommand('node loop.js', { cwd: ws.root, timeout: 1000 });
    expect(t.timedOut).toBe(true);
    ws.write('spam.js', 'process.stdout.write("x".repeat(100000));');
    const s = await runCommand('node spam.js', { cwd: ws.root });
    expect(s.stdout.length).toBe(16 * 1024);
  });
});

describe('diff', () => {
  it('makes a unified diff with stats', () => {
    const d = unifiedDiff('a.txt', 'one\ntwo\nthree\n', 'one\n2\nthree\nfour\n');
    expect(d).toContain('--- a/a.txt');
    expect(d).toContain('-two');
    expect(d).toContain('+2');
    expect(d).toContain('+four');
    expect(diffStats(d)).toEqual({ added: 2, removed: 1 });
    expect(unifiedDiff('n.txt', null, 'x\n')).toContain('--- /dev/null');
    expect(unifiedDiff('same', 'a', 'a')).toBe('');
  });
});

describe('checks', () => {
  it('finds HTML problems and accepts a good page', () => {
    const bad = '<html><body><div><img src="x.png"></body></html>';
    const issues = checkHtml('index.html', bad, () => false);
    expect(issues.join('\n')).toMatch(/doctype/);
    expect(issues.join('\n')).toMatch(/title/);
    expect(issues.join('\n')).toMatch(/<div> is not closed/);
    expect(issues.join('\n')).toMatch(/x\.png/);
    expect(issues.join('\n')).toMatch(/alt/);
    const good = '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>Hi</title><style>p>a{}</style></head><body><p>x<script>if (a < b) {}</script></body></html>';
    expect(checkHtml('index.html', good, () => true)).toEqual([]);
    expect(checkCss('a.css', 'a { b: c; }')).toEqual([]);
    expect(checkCss('a.css', 'a { b: c;')).toHaveLength(1);
  });

  it('checks a workspace, JS syntax included', () => {
    const ws = new Workspace(path.join(tmpDir(), 'chk'));
    expect(checkWorkspace(ws).passed).toBe(false);
    ws.write('ok.js', 'export const a = 1;\n');
    ws.write('bad.js', 'const = ;\n');
    ws.write('data.json', '{"a":');
    const r = checkWorkspace(ws);
    expect(r.passed).toBe(false);
    expect(r.issues.some((i) => i.startsWith('bad.js: syntax error'))).toBe(true);
    expect(r.issues.some((i) => i.startsWith('data.json'))).toBe(true);
    expect(r.issues.some((i) => i.startsWith('ok.js'))).toBe(false);
  });
});

describe('toolbox and approval mode', () => {
  function setup(approval = true) {
    const bus = new EventBus();
    if (!approval) bus.emit('settings.changed', { approvalMode: false });
    const approvals = new Approvals(bus);
    const ws = new Workspace(path.join(tmpDir(), 'tb'));
    return { bus, approvals, ws, tb: new ToolBox({ workspace: ws, bus, approvals }) };
  }

  it('writes new files without approval and shows a diff event', async () => {
    const { bus, tb } = setup();
    const r = await tb.execute('write_file', { path: 'index.html', content: '<p>hi</p>\n' }, { jobId: 'j_1', workerId: 'dev', preexisting: new Set() });
    expect(r.ok).toBe(true);
    const ev = bus.events.find((e) => e.type === 'file.changed');
    expect(ev.data).toMatchObject({ path: 'index.html', op: 'create', content: '<p>hi</p>\n', added: 1, removed: 0, workerId: 'dev' });
    expect(bus.events.map((e) => e.type)).toEqual(['tool.called', 'file.changed', 'tool.result']);
  });

  it('asks before run, delete and changing a file that existed before the job', async () => {
    const { bus, approvals, tb, ws } = setup();
    ws.write('old.txt', 'keep');
    const pre = new Set(['old.txt']);
    const p = tb.execute('write_file', { path: 'old.txt', content: 'changed' }, { jobId: 'j_1', workerId: 'dev', preexisting: pre });
    const req = await waitFor(() => bus.state.approvals[0]);
    expect(req).toMatchObject({ tool: 'write_file', workerId: 'dev', summary: 'Replace old.txt' });
    expect(req.diff).toContain('+changed');
    expect(bus.state.workers.dev.status).toBe('waiting_approval');
    approvals.resolve(req.id, false, 'not this one');
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.error).toContain('rejected');
    expect(ws.read('old.txt')).toBe('keep');

    const p2 = tb.execute('delete_file', { path: 'old.txt' }, { jobId: 'j_1', workerId: 'dev', preexisting: pre });
    const req2 = await waitFor(() => bus.state.approvals[0]);
    approvals.resolve(req2.id, true);
    expect((await p2).ok).toBe(true);
    expect(ws.exists('old.txt')).toBe(false);
    expect(tb.needsApproval('run', { command: 'node a.js' })).toBe(true);
    expect(tb.needsApproval('read_file', { path: 'a' })).toBe(false);
    expect(tb.needsApproval('run', {}, { approval: false })).toBe(false);
  });

  it('skips approvals when approval mode is off', async () => {
    const { tb, ws } = setup(false);
    ws.write('old.txt', 'keep');
    const r = await tb.execute('delete_file', { path: 'old.txt' }, { preexisting: new Set(['old.txt']) });
    expect(r.ok).toBe(true);
  });

  it('enforces the worker tool list and reports path errors as tool errors', async () => {
    const { tb } = setup();
    const r = await tb.execute('write_file', { path: 'a.txt', content: 'x' }, { workerId: 'qa', allowed: ['read_file'] });
    expect(r).toMatchObject({ ok: false });
    expect(r.error).toContain('not allowed');
    const e = await tb.execute('read_file', { path: '../../etc/passwd' }, {});
    expect(e.ok).toBe(false);
    expect((await tb.execute('nope', {}, {})).error).toContain('unknown tool');
  });

  it('builds an action schema that accepts valid calls only', () => {
    const schema = actionSchema(['write_file', 'read_file']);
    expect(validate(schema, { tool: 'write_file', args: { path: 'a', content: 'b' } })).toEqual([]);
    expect(validate(schema, { tool: 'done', args: { summary: 'x' } })).toEqual([]);
    expect(validate(schema, { tool: 'run', args: { command: 'x' } }).length).toBeGreaterThan(0);
    expect(validate(schema, { tool: 'write_file', args: { path: 'a' } }).length).toBeGreaterThan(0);
    expect(Object.keys(TOOLS)).toContain('preview');
  });
});

describe('checks for empty files', () => {
  it('reports an empty file', () => {
    const ws = new Workspace(path.join(tmpDir(), 'empty'));
    ws.write('style.css', '  \n');
    expect(checkWorkspace(ws).issues).toEqual(['style.css: the file is empty']);
  });
});

describe('inline styles', () => {
  it('checks the braces of a style block', () => {
    const page = '<!doctype html><html lang="en"><head><meta name="viewport" content="x"><title>T</title><style>body { a: b; }\n c: d; }</style></head><body></body></html>';
    expect(checkHtml('a.html', page, () => true)).toEqual(['a.html <style>: unexpected }']);
  });
});
