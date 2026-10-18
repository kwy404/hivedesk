import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { startBench, fakeClient } from './harness.js';
import { tmpDir } from '../helpers.js';

describe('workbench file operations', () => {
  let b;
  beforeAll(async () => { b = await startBench(); });
  afterAll(async () => { await b.close(); });

  it('lists folders first, hides .git and reads text files up to 2 MB', async () => {
    b.write('src/a.js', 'export const a = 1;\n');
    b.write('README.md', '# hi\n');
    fs.mkdirSync(path.join(b.ws, '.git'), { recursive: true });
    fs.mkdirSync(path.join(b.ws, 'empty'));
    const top = await b.run('wb.fs.list', {});
    expect(top.entries.map((e) => `${e.type}:${e.name}`)).toEqual(['dir:empty', 'dir:src', 'file:README.md']);
    const src = await b.run('wb.fs.list', { dir: 'src' });
    expect(src.entries[0]).toMatchObject({ path: 'src/a.js', type: 'file', bytes: 20 });
    const r = await b.run('wb.fs.read', { path: 'src/a.js' });
    expect(r.content).toBe('export const a = 1;\n');
    expect(r.sha).toMatch(/^[0-9a-f]{40}$/);
    b.write('big.txt', 'x'.repeat(300 * 1024));
    const big = await b.run('wb.fs.read', { path: 'big.txt' });
    expect(big.content.length).toBe(300 * 1024); // the crew's read truncates at 256 KB; the editor must not
    fs.writeFileSync(path.join(b.ws, 'img.bin'), Buffer.from([1, 0, 2, 3]));
    expect(await b.run('wb.fs.read', { path: 'img.bin' })).toMatchObject({ binary: true, content: null });
  });

  it('refuses paths outside the root, .git and device names', async () => {
    await expect(b.run('wb.fs.read', { path: '../secret' })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(b.run('wb.fs.read', { path: '.git/config' })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(b.run('wb.fs.write', { path: 'C:/x.txt', content: 'x' })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(b.run('wb.fs.mkdir', { path: 'con' })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(b.run('wb.fs.rename', { from: 'README.md', to: '.git/README.md' })).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('writes through the tools so the log sees the change', async () => {
    const before = b.app.bus.seq;
    await b.run('wb.fs.write', { path: 'src/b.js', content: 'export const b = 2;\n' });
    const ev = b.app.bus.since(before).find((e) => e.type === 'file.changed');
    expect(ev.data).toMatchObject({ path: 'src/b.js', op: 'create', workerId: 'user' });
    expect(fs.readFileSync(path.join(b.ws, 'src/b.js'), 'utf8')).toBe('export const b = 2;\n');
  });

  it('creates folders, renames and moves files and folders', async () => {
    await b.run('wb.fs.mkdir', { path: 'lib/util' });
    await expect(b.run('wb.fs.mkdir', { path: 'lib/util' })).rejects.toMatchObject({ code: 'conflict' });
    const before = b.app.bus.seq;
    const r = await b.run('wb.fs.rename', { from: 'src/b.js', to: 'lib/util/b.js' });
    expect(r).toMatchObject({ from: 'src/b.js', to: 'lib/util/b.js', type: 'file' });
    const evs = b.app.bus.since(before).filter((e) => e.type === 'file.changed').map((e) => `${e.data.op}:${e.data.path}`);
    expect(evs).toEqual(['delete:src/b.js', 'create:lib/util/b.js']);
    await expect(b.run('wb.fs.rename', { from: 'src/a.js', to: 'lib/util/b.js' })).rejects.toMatchObject({ code: 'conflict' });
    await expect(b.run('wb.fs.rename', { from: 'lib', to: 'lib/util/inner' })).rejects.toMatchObject({ code: 'bad_request' });
    const moved = await b.run('wb.fs.rename', { from: 'lib', to: 'pkg/lib' });
    expect(moved.moved).toEqual([{ from: 'lib/util/b.js', to: 'pkg/lib/util/b.js' }]);
    expect(fs.existsSync(path.join(b.ws, 'pkg/lib/util/b.js'))).toBe(true);
  });

  it('deletes files and empty folders, and a full folder only with the confirmed count', async () => {
    await b.run('wb.fs.delete', { path: 'empty' });
    expect(fs.existsSync(path.join(b.ws, 'empty'))).toBe(false);
    b.write('trash/one.txt', '1');
    b.write('trash/two/three.txt', '3');
    const count = await b.run('wb.fs.count', { path: 'trash' });
    expect(count).toEqual({ files: 2, folders: 1 });
    await expect(b.run('wb.fs.delete', { path: 'trash' })).rejects.toMatchObject({ code: 'confirm_required' });
    await expect(b.run('wb.fs.delete', { path: 'trash', recursive: true, confirmFiles: 1 })).rejects.toMatchObject({ code: 'confirm_required' });
    const before = b.app.bus.seq;
    await b.run('wb.fs.delete', { path: 'trash', recursive: true, confirmFiles: 2 });
    expect(fs.existsSync(path.join(b.ws, 'trash'))).toBe(false);
    expect(b.app.bus.since(before).filter((e) => e.type === 'file.changed').map((e) => e.data.path).sort()).toEqual(['trash/one.txt', 'trash/two/three.txt']);
    await expect(b.run('wb.fs.delete', { path: '' })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(b.run('wb.fs.delete', { path: 'nothing-here' })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('opens other project roots only by full path, never the hivedesk home or a drive', async () => {
    const proj = tmpDir('hivedesk-wb-proj-');
    fs.writeFileSync(path.join(proj, 'main.py'), 'print(1)\n');
    await expect(b.run('wb.roots.add', { path: 'relative/folder' })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(b.run('wb.roots.add', { path: b.home })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(b.run('wb.roots.add', { path: path.parse(proj).root })).rejects.toMatchObject({ code: 'bad_request' });
    const { root } = await b.run('wb.roots.add', { path: proj });
    expect(root).toMatchObject({ name: path.basename(proj), workspace: false });
    await expect(b.run('wb.roots.add', { path: proj })).rejects.toMatchObject({ code: 'conflict' });
    const list = await b.run('wb.fs.list', { root: root.id });
    expect(list.entries.map((e) => e.name)).toEqual(['main.py']);
    const before = b.app.bus.seq;
    await b.run('wb.fs.write', { root: root.id, path: 'main.py', content: 'print(2)\n' });
    expect(fs.readFileSync(path.join(proj, 'main.py'), 'utf8')).toBe('print(2)\n');
    // Files outside the workspace never enter the project log (it is relayed to guests).
    expect(b.app.bus.since(before).some((e) => e.type === 'file.changed')).toBe(false);
    const saved = JSON.parse(fs.readFileSync(path.join(b.home, 'settings.json'), 'utf8'));
    expect(saved.workbench.roots[0].path).toBe(fs.realpathSync.native(proj));
    await b.run('wb.roots.remove', { id: root.id });
    await expect(b.run('wb.fs.list', { root: root.id })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('tells a watching window about changes made outside hivedesk', async () => {
    const proj = tmpDir('hivedesk-wb-watch-');
    const { root } = await b.run('wb.roots.add', { path: proj });
    const c = fakeClient('watcher');
    const r = await b.run('wb.fs.watch', { root: root.id }, c);
    if (!r.watching) return; // no recursive watch on this platform
    await new Promise((res) => setTimeout(res, 100));
    fs.writeFileSync(path.join(proj, 'new.txt'), 'hi');
    const start = Date.now();
    while (!c.of('fs.changed').length && Date.now() - start < 5000) await new Promise((res) => setTimeout(res, 50));
    expect(c.of('fs.changed')[0]).toMatchObject({ root: root.id });
    expect(c.of('fs.changed').flatMap((x) => x.paths)).toContain('new.txt');
    c.closeConn();
    await b.run('wb.roots.remove', { id: root.id });
  });
});
