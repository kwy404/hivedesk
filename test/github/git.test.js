import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createGit, authEnv, redact, cleanUrl, validBranch, GitError } from '../../src/github/git.js';
import { tmpDir } from '../helpers.js';
import { bareRepo } from './stub.js';

const gitIn = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
const ID = { name: 'Test Bee', email: 'bee@example.invalid' };

describe('git in the workspace (local bare remote, no network)', () => {
  it('inits, branches, commits and pushes to a bare remote, then clones it back', async () => {
    const base = tmpDir('hivedesk-git-');
    const remote = bareRepo(path.join(base, 'remote.git'));
    const wsDir = path.join(base, 'ws');
    fs.mkdirSync(wsDir);
    const git = createGit({ cwd: wsDir });
    expect(await git.isRepo()).toBe(false);
    await git.init('main');
    expect(await git.isRepo()).toBe(true);
    expect(await git.branch()).toBe('main');
    expect(await git.hasCommits()).toBe(false);

    fs.writeFileSync(path.join(wsDir, 'index.html'), '<p>hi</p>\n');
    fs.mkdirSync(path.join(wsDir, 'css'));
    fs.writeFileSync(path.join(wsDir, 'css', 'style.css'), 'p{color:red}\n');
    const st = await git.status();
    expect(st.map((f) => f.path).sort()).toEqual(['css/style.css', 'index.html']);
    expect(st.every((f) => f.status === 'new')).toBe(true);

    const c1 = await git.commitAll('Add the landing page\n\nTwo files from the crew.', ID);
    expect(c1.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(c1.files.sort()).toEqual(['css/style.css', 'index.html']);
    expect(gitIn(wsDir, 'log', '-1', '--format=%s|%an|%ae')).toBe('Add the landing page|Test Bee|bee@example.invalid');

    await git.setRemote('origin', remote);
    await git.push('origin', 'main');
    expect(gitIn(remote, 'rev-parse', 'refs/heads/main')).toBe(c1.sha);
    expect(await git.ahead('origin', 'main')).toBe(0);

    await git.createBranch('hivedesk/j-1-landing');
    expect(await git.branch()).toBe('hivedesk/j-1-landing');
    fs.writeFileSync(path.join(wsDir, 'index.html'), '<p>hello</p>\n');
    expect((await git.status())[0]).toEqual({ path: 'index.html', status: 'modified' });
    const c2 = await git.commitAll('Say hello', ID);
    await git.push('origin', 'hivedesk/j-1-landing');
    expect(gitIn(remote, 'rev-parse', 'refs/heads/hivedesk/j-1-landing')).toBe(c2.sha);

    await expect(git.commitAll('nothing', ID)).rejects.toMatchObject({ code: 'nothing_to_commit' });

    const cloneDir = path.join(base, 'clone');
    const g2 = createGit({ cwd: cloneDir });
    await g2.clone(remote);
    // The user's own core.autocrlf setting applies to the checkout.
    expect(fs.readFileSync(path.join(cloneDir, 'index.html'), 'utf8').replace(/\r\n/g, '\n')).toBe('<p>hi</p>\n');
    expect(await g2.isRepo()).toBe(true);
  });

  it('never treats a parent folder repository as the workspace', async () => {
    const base = tmpDir('hivedesk-git-parent-');
    gitIn(base, 'init', '-q');
    const wsDir = path.join(base, '.hivedesk', 'workspace');
    fs.mkdirSync(wsDir, { recursive: true });
    const git = createGit({ cwd: wsDir });
    expect(await git.isRepo()).toBe(false);
  });

  it('never runs a hook the crew wrote into .git', async () => {
    const wsDir = tmpDir('hivedesk-git-hook-');
    const git = createGit({ cwd: wsDir });
    await git.init('main');
    const marker = path.join(wsDir, 'hook-ran.txt');
    const hook = path.join(wsDir, '.git', 'hooks', 'pre-commit');
    fs.writeFileSync(hook, `#!/bin/sh\necho ran > "${marker.replace(/\\/g, '/')}"\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(wsDir, 'a.txt'), 'a\n');
    await git.commitAll('Add a', ID);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('explains how to install git when it is missing', async () => {
    const git = createGit({ cwd: tmpDir(), bin: 'hivedesk-no-such-git-binary' });
    const err = await git.version().catch((e) => e);
    expect(err).toBeInstanceOf(GitError);
    expect(err.code).toBe('git_missing');
    expect(err.hint).toMatch(/git-scm\.com|apt|xcode/);
  });

  it('passes a token through the environment only, never in the arguments', async () => {
    const calls = [];
    const exec = (bin, args, opts, cb) => { calls.push({ args, env: opts.env }); cb(null, '', ''); };
    const git = createGit({ cwd: tmpDir(), exec });
    const token = 'github_pat_SECRET_1234567890abcdef';
    await git.push('origin', 'main', { token, webBase: 'https://github.com' });
    expect(calls[0].args.join(' ')).not.toContain(token);
    expect(calls[0].args.join(' ')).not.toContain(Buffer.from(`x-access-token:${token}`).toString('base64'));
    expect(calls[0].env.GIT_CONFIG_KEY_0).toBe('http.https://github.com/.extraheader');
    expect(calls[0].env.GIT_CONFIG_VALUE_0).toMatch(/^Authorization: Basic /);
    expect(calls[0].env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(calls[0].args).toContain('credential.helper=');
    for (const c of ['gpg.program=', 'core.sshCommand=', 'core.fsmonitor=false', 'commit.gpgSign=false']) expect(calls[0].args).toContain(c);
    expect(calls[0].args.some((a) => a.startsWith('core.hooksPath='))).toBe(true);
  });

  it('removes secrets from git output and URLs', async () => {
    const token = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    const exec = (bin, args, opts, cb) => cb(Object.assign(new Error('x'), { code: 128 }), '', `fatal: could not push with ${token}`);
    const git = createGit({ cwd: tmpDir(), exec });
    const err = await git.push('origin', 'main', { token }).catch((e) => e);
    expect(err.message).not.toContain(token);
    expect(err.message).toContain('[redacted]');
    expect(redact(`a ${token} b`, [token])).toBe('a [redacted] b');
    expect(cleanUrl(`https://user:${token}@github.com/a/b.git`)).toBe('https://github.com/a/b.git');
    expect(authEnv('', 'https://github.com')).toEqual({});
  });

  it('accepts only safe branch names', () => {
    expect(validBranch('hivedesk/j-3-landing')).toBe(true);
    expect(validBranch('fix-header')).toBe(true);
    for (const bad of ['', '-x', 'a..b', 'a/', 'a b', 'x.lock', '../etc', 'a//b']) expect(validBranch(bad)).toBe(false);
  });
});
