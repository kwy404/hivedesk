// The local git binary, always run inside the workspace. No shell, no network unless a
// command needs the remote, never an interactive prompt, never a hook from the workspace.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export class GitError extends Error {
  constructor(code, message, hint) {
    super(message);
    this.code = code;
    if (hint) this.hint = hint;
  }
}

/** How to get git, per platform. */
export function installHint(platform = process.platform) {
  if (platform === 'win32') return 'Install git from https://git-scm.com/download/win (keep the default options), then restart hivedesk.';
  if (platform === 'darwin') return 'Run "xcode-select --install" in a terminal, or install git from https://git-scm.com/download/mac, then restart hivedesk.';
  return 'Install git with your package manager, for example "sudo apt install git" or "sudo dnf install git", then restart hivedesk.';
}

/** Removes user and password parts from a URL so it can be shown or logged. */
export function cleanUrl(url) {
  const s = String(url || '');
  return s.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/\s]*@/i, '$1');
}

/**
 * Extra git config passed through the environment (git 2.31+), so a secret never shows in
 * the process arguments and is never written to .git/config.
 * @param {Record<string, string>} pairs
 */
export function configEnv(pairs) {
  const env = {};
  const entries = Object.entries(pairs);
  env.GIT_CONFIG_COUNT = String(entries.length);
  entries.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k;
    env[`GIT_CONFIG_VALUE_${i}`] = v;
  });
  return env;
}

/** The HTTP header git sends to GitHub for a token (only for that host). */
export function authEnv(token, webBase = 'https://github.com') {
  if (!token) return {};
  const base = webBase.replace(/\/+$/, '') + '/';
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return configEnv({ [`http.${base}.extraheader`]: `Authorization: Basic ${basic}` });
}

/** Replaces every copy of each secret (and its Basic form) in a text. */
export function redact(text, secrets = []) {
  let out = String(text ?? '');
  for (const s of secrets) {
    if (!s || s.length < 4) continue;
    out = out.split(s).join('[redacted]');
    const b = Buffer.from(`x-access-token:${s}`).toString('base64');
    out = out.split(b).join('[redacted]');
  }
  return out;
}

const NO_HOOKS = path.join(os.tmpdir(), 'hivedesk-no-git-hooks-' + process.pid);

/**
 * @param {{ cwd: string, bin?: string, env?: object, timeoutMs?: number, exec?: typeof execFile }} opts
 */
export function createGit(opts) {
  const cwd = opts.cwd;
  const bin = opts.bin || process.env.HIVEDESK_GIT || 'git';
  const exec = opts.exec || execFile;
  const baseTimeout = opts.timeoutMs ?? 120_000;

  /**
   * Runs git. Rejects with GitError; `secrets` are removed from any message.
   * @param {string[]} args
   * @param {{ env?: object, secrets?: string[], timeoutMs?: number, allowFail?: boolean, cwd?: string }} [o]
   */
  function run(args, o = {}) {
    // Safety first: the crew can write files in the workspace, so never run its hooks or
    // a file system monitor it configured, never ask for a password and never open a window.
    const safe = ['-c', `core.hooksPath=${NO_HOOKS}`, '-c', 'core.fsmonitor=false', '-c', 'credential.helper=', '-c', 'protocol.ext.allow=never', '-c', 'core.quotePath=false'];
    const env = {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '',
      SSH_ASKPASS: '',
      GCM_INTERACTIVE: 'never',
      GIT_CEILING_DIRECTORIES: path.dirname(path.resolve(o.cwd || cwd)),
      LANG: 'C',
      LC_ALL: 'C',
      ...(opts.env || {}),
      ...(o.env || {})
    };
    const secrets = o.secrets || [];
    return new Promise((resolve, reject) => {
      exec(bin, [...safe, ...args], { cwd: o.cwd || cwd, env, timeout: o.timeoutMs ?? baseTimeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
        const out = redact(String(stdout ?? ''), secrets);
        const errText = redact(String(stderr ?? ''), secrets);
        if (!err) return resolve({ stdout: out, stderr: errText, code: 0 });
        if (err.code === 'ENOENT') return reject(new GitError('git_missing', 'git is not installed or not on the PATH.', installHint()));
        if (err.killed) return reject(new GitError('git_timeout', `git ${args[0]} took too long and was stopped.`));
        if (o.allowFail) return resolve({ stdout: out, stderr: errText, code: typeof err.code === 'number' ? err.code : 1 });
        reject(new GitError('git_failed', explain(args[0], errText || out || String(err.message)), hintFor(errText)));
      });
    });
  }

  const git = {
    cwd,
    run,
    async version() {
      const r = await run(['--version']);
      const m = /git version (\d+)\.(\d+)/.exec(r.stdout);
      return { text: r.stdout.trim(), major: m ? +m[1] : 0, minor: m ? +m[2] : 0 };
    },
    /** True when the workspace itself is the top of a repository (never a parent folder's repo). */
    async isRepo() {
      if (!fs.existsSync(path.join(cwd, '.git'))) return false;
      const r = await run(['rev-parse', '--show-toplevel'], { allowFail: true });
      if (r.code) return false;
      return samePath(r.stdout.trim(), cwd);
    },
    async init(branch = 'main') {
      await run(['init', '-q']);
      await run(['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
    },
    async branch() {
      const r = await run(['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFail: true });
      return r.code ? null : r.stdout.trim();
    },
    async hasCommits() {
      const r = await run(['rev-parse', '--verify', '--quiet', 'HEAD'], { allowFail: true });
      return r.code === 0;
    },
    async head() {
      const r = await run(['rev-parse', 'HEAD'], { allowFail: true });
      return r.code ? null : r.stdout.trim();
    },
    async branchExists(name) {
      const r = await run(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], { allowFail: true });
      return r.code === 0;
    },
    /** @returns {Promise<Array<{ path: string, status: string }>>} every changed or new file */
    async status() {
      const r = await run(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
      const out = [];
      const parts = r.stdout.split('\0');
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        if (!p) continue;
        const code = p.slice(0, 2);
        const file = p.slice(3);
        if (code[0] === 'R' || code[0] === 'C') i++; // the old name follows
        out.push({ path: file, status: describeStatus(code) });
      }
      return out;
    },
    async createBranch(name) {
      if (!validBranch(name)) throw new GitError('bad_branch', `"${name}" is not a valid branch name.`);
      if (await git.branchExists(name)) await run(['checkout', '-q', name]);
      else await run(['checkout', '-q', '-b', name]);
    },
    async identity() {
      const n = await run(['config', 'user.name'], { allowFail: true });
      const e = await run(['config', 'user.email'], { allowFail: true });
      return { name: n.code ? '' : n.stdout.trim(), email: e.code ? '' : e.stdout.trim() };
    },
    async remotes() {
      const r = await run(['remote', '-v'], { allowFail: true });
      const map = new Map();
      for (const line of r.stdout.split('\n')) {
        const m = /^(\S+)\s+(\S+)\s+\((fetch|push)\)/.exec(line);
        if (m && !map.has(m[1])) map.set(m[1], cleanUrl(m[2]));
      }
      return [...map].map(([name, url]) => ({ name, url }));
    },
    async remoteUrl(name = 'origin') {
      const r = await run(['remote', 'get-url', name], { allowFail: true });
      return r.code ? null : r.stdout.trim();
    },
    async setRemote(name, url) {
      const cur = await git.remoteUrl(name);
      if (cur) await run(['remote', 'set-url', name, url]);
      else await run(['remote', 'add', name, url]);
    },
    /** Commits ahead of the remote branch (null when the remote branch is unknown). */
    async ahead(remote, branch) {
      const r = await run(['rev-list', '--count', `${remote}/${branch}..HEAD`], { allowFail: true });
      return r.code ? null : Number(r.stdout.trim()) || 0;
    },
    async push(remote, branch, { token, webBase } = {}) {
      return run(['push', '--porcelain', '-u', remote, `HEAD:refs/heads/${branch}`], { env: authEnv(token, webBase), secrets: [token], timeoutMs: 180_000 });
    },
    async clone(url, { token, webBase } = {}) {
      fs.mkdirSync(cwd, { recursive: true });
      return run(['clone', '-q', '--', url, '.'], { env: authEnv(token, webBase), secrets: [token], timeoutMs: 600_000 });
    },
    async log(n = 1) {
      const r = await run(['log', `-${n}`, '--format=%H%x00%s%x00%an%x00%aI'], { allowFail: true });
      if (r.code) return [];
      return r.stdout.split('\n').filter(Boolean).map((l) => { const [sha, subject, author, date] = l.split('\0'); return { sha, subject, author, date }; });
    }
  };

  /** Stages everything and commits with the message from a temp file. Returns { sha, files }. */
  git.commitAll = async (message, identity) => {
    await run(['add', '-A']);
    const staged = await run(['diff', '--cached', '--name-only', '-z']);
    const files = staged.stdout.split('\0').filter(Boolean);
    if (!files.length) throw new GitError('nothing_to_commit', 'There is nothing to commit: the workspace has no changes since the last commit.');
    const id = [];
    if (identity?.name) id.push('-c', `user.name=${identity.name}`);
    if (identity?.email) id.push('-c', `user.email=${identity.email}`);
    const msgFile = path.join(os.tmpdir(), `hivedesk-commit-${process.pid}-${Date.now().toString(36)}.txt`);
    fs.writeFileSync(msgFile, String(message).replace(/\r\n/g, '\n'));
    try {
      await run([...id, 'commit', '-q', '-F', msgFile]);
    } finally {
      try { fs.unlinkSync(msgFile); } catch { /* ignore */ }
    }
    return { sha: await git.head(), files };
  };

  return git;
}

function samePath(a, b) {
  const norm = (p) => {
    let r = path.resolve(p);
    try { r = fs.realpathSync.native(r); } catch { /* keep */ }
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

function describeStatus(code) {
  if (code === '??') return 'new';
  if (code.includes('D')) return 'deleted';
  if (code.includes('R')) return 'renamed';
  if (code.includes('A')) return 'new';
  return 'modified';
}

/** A conservative subset of git's branch name rules. */
export function validBranch(name) {
  return typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(name) && !name.includes('..') && !name.endsWith('/') && !name.endsWith('.lock') && !name.includes('//');
}

function explain(cmd, text) {
  const t = String(text).trim().split('\n').filter((l) => l.trim()).slice(-4).join(' ');
  return `git ${cmd} failed: ${t || 'no details'}`;
}

function hintFor(text) {
  const t = String(text).toLowerCase();
  if (t.includes('could not resolve host') || t.includes('unable to access')) return 'Check the internet connection, then try again.';
  if (t.includes('authentication failed') || t.includes('could not read username') || t.includes('403')) return 'GitHub refused the credentials. Connect GitHub again, and check that the token can write to this repository (Contents: Read and write).';
  if (t.includes('non-fast-forward') || t.includes('fetch first') || t.includes('rejected')) return 'The remote has commits that are not here. Pull them with git in a terminal first, or push to a new branch.';
  if (t.includes('please tell me who you are') || t.includes('user.email')) return 'Set your name and email for commits: git config --global user.name "Your Name" and git config --global user.email "you@example.com".';
  if (t.includes('not empty')) return 'Clone needs an empty workspace.';
  return undefined;
}
