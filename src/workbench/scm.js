// The source control panel, server side: status, per file diff, stage, unstage, discard,
// commit of what is staged, branches, checkout and the stash list, on src/github/git.js.
// Only the person at this machine reaches it (origin user); peers and agents never do.
import fs from 'node:fs';
import { createGit, validBranch, GitError } from '../github/git.js';
import { WorkbenchError } from './origin.js';
import { relPath, MAX_EDIT_BYTES } from './fs.js';

const MAX_FILES = 500;

function gitError(err) {
  if (err instanceof WorkbenchError) return err;
  if (err instanceof GitError) {
    const code = err.code === 'git_missing' ? 'git_missing' : ['nothing_staged', 'bad_message', 'bad_branch', 'no_branch'].includes(err.code) ? 'bad_request' : 'conflict';
    return new WorkbenchError(code, err.message, err.hint ? { hint: err.hint } : undefined);
  }
  return err;
}

export class Scm {
  /** @param {{ gitBin?: string, identity?: () => Promise<{ name?: string, email?: string } | null> }} [o] */
  constructor(o = {}) {
    this.o = o;
    this.gits = new Map();
  }

  git(root) {
    let g = this.gits.get(root.id);
    if (!g || g.cwd !== root.path) {
      g = createGit({ cwd: root.path, bin: this.o.gitBin, timeoutMs: 60_000 });
      this.gits.set(root.id, g);
    }
    return g;
  }

  async _repo(root) {
    const g = this.git(root);
    try {
      if (!(await g.isRepo())) throw new WorkbenchError('not_a_repo', 'This folder is not a git repository yet.');
    } catch (err) { throw gitError(err); }
    return g;
  }

  /** Paths from the browser, checked against the root rules first (no .git, no escape). */
  _paths(root, list) {
    if (!Array.isArray(list) || !list.length) throw new WorkbenchError('bad_request', 'paths are required');
    if (list.length > MAX_FILES) throw new WorkbenchError('bad_request', `at most ${MAX_FILES} paths at once`);
    return list.map((p) => {
      const r = relPath(p);
      if (!r) throw new WorkbenchError('bad_request', 'a path is empty');
      root.resolve(r);
      return r;
    });
  }

  async status(root) {
    const g = this.git(root);
    try {
      const isRepo = await g.isRepo();
      if (!isRepo) return { isRepo: false, branch: null, files: [] };
      const [files, branch, hasCommits, head] = await Promise.all([g.statusFull(), g.branch(), g.hasCommits(), g.head()]);
      return { isRepo: true, branch, detached: !branch && hasCommits, hasCommits, head: head ? head.slice(0, 12) : null, files: files.slice(0, 5000), truncated: files.length > 5000 };
    } catch (err) { throw gitError(err); }
  }

  /**
   * Before and after text of one file for the diff editor, plus git's own unified diff.
   * staged: HEAD against the index; otherwise the index against the work tree.
   */
  async diff(root, file, { staged = false } = {}) {
    const g = await this._repo(root);
    const [p] = this._paths(root, [file]);
    try {
      let before;
      let after;
      if (staged) {
        before = (await g.showFile('HEAD', p)) ?? '';
        after = (await g.showFile(':', p)) ?? '';
      } else {
        before = (await g.showFile(':', p)) ?? (await g.showFile('HEAD', p)) ?? '';
        const st = root.stat(p);
        if (st.type === 'file' && st.bytes <= MAX_EDIT_BYTES) after = fs.readFileSync(st.abs, 'utf8');
        else after = st.type ? null : '';
      }
      const patch = await g.diff(p, { staged });
      return { path: p, staged, before, after, patch: patch.slice(0, 512 * 1024) };
    } catch (err) { throw gitError(err); }
  }

  async stage(root, paths) {
    const g = await this._repo(root);
    try { await g.add(this._paths(root, paths)); } catch (err) { throw gitError(err); }
    return this.status(root);
  }

  async unstage(root, paths) {
    const g = await this._repo(root);
    try { await g.unstage(this._paths(root, paths)); } catch (err) { throw gitError(err); }
    return this.status(root);
  }

  /** Drops work tree changes of tracked files. Untracked files are deleted through the explorer instead. */
  async discard(root, paths) {
    const g = await this._repo(root);
    const list = this._paths(root, paths);
    const st = await g.statusFull();
    const byPath = new Map(st.map((f) => [f.path, f]));
    const tracked = list.filter((p) => byPath.get(p) && !byPath.get(p).untracked);
    if (!tracked.length) throw new WorkbenchError('bad_request', 'only changes to tracked files can be discarded');
    try { await g.discard(tracked); } catch (err) { throw gitError(err); }
    return { discarded: tracked, status: await this.status(root) };
  }

  async commit(root, { message, amend = false } = {}) {
    const g = await this._repo(root);
    try {
      const identity = (await this.o.identity?.()) || null;
      const id = await g.identity();
      if (!id.email && !identity?.email) throw new WorkbenchError('no_identity', 'git does not know your name and email yet.', { hint: 'Set them once: git config --global user.name "Your Name" and git config --global user.email "you@example.com".' });
      const r = await g.commitStaged(message, id.email ? null : identity, { amend: !!amend });
      return { sha: r.sha, files: r.files, branch: await g.branch() };
    } catch (err) { throw gitError(err); }
  }

  async branches(root) {
    const g = await this._repo(root);
    try { return { branches: await g.branches(), current: await g.branch() }; } catch (err) { throw gitError(err); }
  }

  async checkout(root, { branch, create = false } = {}) {
    const g = await this._repo(root);
    const name = String(branch || '').trim();
    if (!validBranch(name)) throw new WorkbenchError('bad_request', `"${name}" is not a valid branch name.`);
    try {
      if (create) await g.createBranch(name);
      else await g.checkout(name);
      return { branch: await g.branch() };
    } catch (err) { throw gitError(err); }
  }

  async stashes(root) {
    const g = await this._repo(root);
    try { return { stashes: await g.stashes() }; } catch (err) { throw gitError(err); }
  }

  async log(root, n = 20) {
    const g = await this._repo(root);
    try { return { commits: await g.log(Math.min(Math.max(1, Number(n) || 20), 200)) }; } catch (err) { throw gitError(err); }
  }

  async init(root) {
    const g = this.git(root);
    try {
      if (await g.isRepo()) throw new WorkbenchError('conflict', 'This folder is already a git repository.');
      await g.init('main');
    } catch (err) { throw gitError(err); }
    return this.status(root);
  }
}
