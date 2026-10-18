import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startBench, fakeClient, fakeP2p, PEER_A } from './harness.js';

const gitIn = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();

describe('source control panel against a temp repository', () => {
  let b;
  beforeAll(async () => {
    b = await startBench({ p2p: fakeP2p({ peers: [{ peerId: PEER_A, name: 'Rita' }] }) });
  });
  afterAll(async () => { await b.close(); });

  it('says when the folder is not a repository, and can init one', async () => {
    expect(await b.run('wb.scm.status', {})).toEqual({ isRepo: false, branch: null, files: [] });
    await expect(b.run('wb.scm.diff', { path: 'a.txt' })).rejects.toMatchObject({ code: 'not_a_repo' });
    const st = await b.run('wb.scm.init', {});
    expect(st).toMatchObject({ isRepo: true, branch: 'main', hasCommits: false });
    gitIn(b.ws, 'config', 'user.name', 'Test Bee');
    gitIn(b.ws, 'config', 'user.email', 'bee@example.invalid');
  });

  it('shows untracked, staged and unstaged files apart, and stages and unstages them', async () => {
    b.write('a.txt', 'one\n');
    b.write('dir/b.txt', 'two\n');
    let st = await b.run('wb.scm.status', {});
    expect(st.files.map((f) => `${f.path}:${f.untracked}`).sort()).toEqual(['a.txt:true', 'dir/b.txt:true']);
    st = await b.run('wb.scm.stage', { paths: ['a.txt'] });
    expect(st.files.find((f) => f.path === 'a.txt')).toMatchObject({ staged: true, unstaged: false, x: 'A' });
    st = await b.run('wb.scm.unstage', { paths: ['a.txt'] });
    expect(st.files.find((f) => f.path === 'a.txt')).toMatchObject({ untracked: true });
    await b.run('wb.scm.stage', { paths: ['a.txt', 'dir/b.txt'] });
    await expect(b.run('wb.scm.stage', { paths: ['../outside.txt'] })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(b.run('wb.scm.stage', { paths: ['.git/config'] })).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('commits only what is staged, with the message as typed, and logs the commit', async () => {
    b.write('c.txt', 'not staged\n');
    await expect(b.run('wb.scm.commit', { message: '   ' })).rejects.toMatchObject({ code: 'bad_request' });
    const before = b.app.bus.seq;
    const r = await b.run('wb.scm.commit', { message: 'Add a and b\n\nFrom the panel.' });
    expect(r.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(r.files.sort()).toEqual(['a.txt', 'dir/b.txt']);
    expect(gitIn(b.ws, 'log', '-1', '--format=%s|%b').trim()).toBe('Add a and b|From the panel.');
    expect(gitIn(b.ws, 'status', '--porcelain')).toBe('?? c.txt');
    expect(b.app.bus.since(before).find((e) => e.type === 'github.committed').data).toMatchObject({ sha: r.sha, branch: 'main', files: 2 });
    await expect(b.run('wb.scm.commit', { message: 'nothing' })).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('gives before and after text for the diff editor, staged and not', async () => {
    b.write('a.txt', 'one\nmore\n');
    const d = await b.run('wb.scm.diff', { path: 'a.txt' });
    expect(d).toMatchObject({ before: 'one\n', after: 'one\nmore\n', staged: false });
    expect(d.patch).toContain('+more');
    await b.run('wb.scm.stage', { paths: ['a.txt'] });
    b.write('a.txt', 'one\nmore\nagain\n');
    const s = await b.run('wb.scm.diff', { path: 'a.txt', staged: true });
    expect(s).toMatchObject({ before: 'one\n', after: 'one\nmore\n' });
    const u = await b.run('wb.scm.diff', { path: 'a.txt' });
    expect(u).toMatchObject({ before: 'one\nmore\n', after: 'one\nmore\nagain\n' });
    const n = await b.run('wb.scm.diff', { path: 'c.txt' });
    expect(n).toMatchObject({ before: '', after: 'not staged\n' });
  });

  it('discards work tree changes of tracked files only', async () => {
    const r = await b.run('wb.scm.discard', { paths: ['a.txt'] });
    expect(r.discarded).toEqual(['a.txt']);
    expect(fs.readFileSync(path.join(b.ws, 'a.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('one\nmore\n');
    await expect(b.run('wb.scm.discard', { paths: ['c.txt'] })).rejects.toMatchObject({ code: 'bad_request' });
    expect(fs.existsSync(path.join(b.ws, 'c.txt'))).toBe(true);
  });

  it('lists, creates and switches branches, and lists stashes', async () => {
    await b.run('wb.scm.unstage', { paths: ['a.txt'] });
    await b.run('wb.scm.discard', { paths: ['a.txt'] });
    let r = await b.run('wb.scm.checkout', { branch: 'feature/x', create: true });
    expect(r.branch).toBe('feature/x');
    const list = await b.run('wb.scm.branches', {});
    expect(list.branches.map((x) => `${x.name}${x.current ? '*' : ''}`).sort()).toEqual(['feature/x*', 'main']);
    r = await b.run('wb.scm.checkout', { branch: 'main' });
    expect(r.branch).toBe('main');
    await expect(b.run('wb.scm.checkout', { branch: '--evil' })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(b.run('wb.scm.checkout', { branch: 'nope' })).rejects.toMatchObject({ code: 'bad_request' });
    gitIn(b.ws, 'stash', 'push', '-u', '-m', 'wip on c');
    const st = await b.run('wb.scm.stashes', {});
    expect(st.stashes[0]).toMatchObject({ ref: 'stash@{0}' });
    expect(st.stashes[0].subject).toContain('wip on c');
    const log = await b.run('wb.scm.log', { n: 5 });
    expect(log.commits[0].subject).toBe('Add a and b');
  });

  it('is for the person at this machine only', async () => {
    const peer = fakeClient('p', { kind: 'peer', peerId: PEER_A });
    for (const type of ['wb.scm.status', 'wb.scm.stage', 'wb.scm.commit', 'wb.scm.checkout', 'wb.scm.diff']) {
      await expect(b.run(type, { paths: ['a.txt'], message: 'x', branch: 'main', path: 'a.txt' }, peer)).rejects.toMatchObject({ code: 'forbidden' });
    }
  });
});
