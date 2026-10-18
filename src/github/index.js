// GitHub plug-in: connect (gh login, a fine-grained token or the device flow), list and clone
// repositories, create one from the workspace, a branch per job, commit, push, pull requests
// and their CI status. All git work runs with the local git binary inside the workspace.
//
// Nothing that writes runs directly. Every action is first described as a plan (exactly what
// will happen: names, visibility, branch, files, message, remote URL), the UI shows it on a
// confirmation card, and only `github.confirm` with that plan id runs it.
//
// Also registers the changelog plug-in (src/changelog/), so one line in the engine loads both.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createGit, cleanUrl, validBranch, redact } from './git.js';
import { CredentialStore, readConfig } from './store.js';
import { createApi, TOKEN_PAGE, TOKEN_PERMISSIONS } from './api.js';
import { parseIntent, parseRules, looksLikeGitIntent, cleanRepoName, fold } from './intent.js';
import { jobReport, templateCommitMessage, commitPrompt, messageFromModel, COMMIT_SCHEMA, prBody, commitSubject } from '../changelog/report.js';
import { melAsk } from '../changelog/mel.js';
import registerChangelog from '../changelog/index.js';
import { say } from '../crew/say.js';

export { parseIntent, parseRules, looksLikeGitIntent };

const PLAN_TTL_MS = 15 * 60_000;
const fail = (code, message) => Object.assign(new Error(message), { code });

let current = null;

/**
 * Runs a plain language request ("crie um repositorio privado chamado loja", "commit and push").
 * `confirm(plan)` must resolve to true for anything to happen. For the voice and palette code
 * in the browser, use the same function from /github/index.js.
 * @param {string} text
 * @param {{ confirm: (plan: object) => Promise<boolean> | boolean, jobId?: string, useModel?: boolean }} opts
 */
export async function runIntent(text, opts) {
  if (!current) throw fail('not_ready', 'The GitHub plug-in is not loaded.');
  return current.runIntent(text, opts);
}

export default function register(ctx) {
  const changelog = registerChangelog(ctx);
  const github = createGitHub(ctx);
  current = github;
  return { ...github, changelog };
}

/** Finds an executable on the PATH without running it. */
export function findOnPath(name, env = process.env) {
  const exts = process.platform === 'win32' ? (env.PATHEXT || '.EXE;.CMD;.BAT').split(';').map((e) => e.toLowerCase()) : [''];
  for (const dir of String(env.PATH || env.Path || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ }
    }
  }
  return null;
}

/** "hivedesk/j-3-tiny-landing-page" from a job. */
export function jobBranch(jobId, request) {
  const slug = fold(request || '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return `hivedesk/${String(jobId || 'job').replace(/[^\w-]/g, '').replace(/_/g, '-')}${slug ? `-${slug}` : ''}`;
}

/** owner/name from a GitHub remote URL (https or ssh), or null. */
export function repoFromUrl(url, webBase = 'https://github.com') {
  const host = webBase.replace(/^https?:\/\//, '').replace(/\/+$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(?:https?://(?:[^@/]+@)?${host}/|git@${host}:)([\\w.-]+)/([\\w.-]+?)(?:\\.git)?/?$`, 'i').exec(String(url || ''));
  return m ? `${m[1]}/${m[2]}` : null;
}

export function createGitHub(ctx) {
  const { bus, server, hive, scheduler } = ctx;
  const o = { ...(ctx.config?.github || {}), ...(ctx.github || {}) };
  const ws = ctx.workspace || ctx.toolbox?.ws;
  const root = ws?.root || ctx.config?.workspace;
  const home = ctx.config?.home || (process.env.HIVEDESK_HOME ? path.resolve(process.env.HIVEDESK_HOME) : path.join(os.homedir(), '.hivedesk'));
  const webBase = (o.webBase || 'https://github.com').replace(/\/+$/, '');
  const store = new CredentialStore(home, o.restrict ? { restrict: o.restrict } : {});
  const git = createGit({ cwd: root, bin: o.gitBin });
  const ask = o.ask !== undefined ? o.ask : melAsk(scheduler);
  const plans = new Map();
  let planSeq = 0;
  let pendingGh = null;
  let device = null;
  let repoCache = null;

  const secretsNow = () => {
    const r = store.read();
    return [r?.token, pendingGh?.token, lastGhToken].filter(Boolean);
  };
  let lastGhToken = null;
  const clean = (s) => redact(s, secretsNow());

  // ---- tokens ----
  const ghBin = () => o.ghBin || findOnPath('gh');
  function ghToken() {
    if (typeof o.ghToken === 'function') return Promise.resolve(o.ghToken()).then((t) => { lastGhToken = t; return t; });
    const bin = ghBin();
    if (!bin) return Promise.reject(fail('gh_missing', 'The gh command line is not installed, so there is no login to reuse. Use a token instead.'));
    const host = webBase.replace(/^https?:\/\//, '');
    return new Promise((resolve, reject) => {
      execFile(bin, ['auth', 'token', '--hostname', host], { timeout: 15_000, windowsHide: true, env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } }, (err, stdout) => {
        const t = String(stdout || '').trim();
        if (err || !t) return reject(fail('gh_not_logged_in', `The gh command line has no login for ${host}. Run "gh auth login" in a terminal first, or use a token.`));
        lastGhToken = t;
        resolve(t);
      });
    });
  }
  async function token() {
    const rec = store.read();
    if (!rec) return null;
    if (rec.source === 'gh') return ghToken();
    return rec.token || null;
  }
  const api = (t) => createApi({ token: t !== undefined ? t : token, apiBase: o.apiBase, webBase, fetch: o.fetch });

  function account() {
    return store.publicView();
  }
  function needAccount() {
    const a = account();
    if (!a) throw fail('not_connected', 'GitHub is not connected yet. Open the GitHub window and connect first.');
    return a;
  }

  // One git or GitHub write at a time.
  let chain = Promise.resolve();
  const exclusive = (fn) => {
    const p = chain.then(fn, fn);
    chain = p.catch(() => {});
    return p;
  };

  // ---- workspace repository ----
  async function repoInfo() {
    if (!root) return { isRepo: false };
    const isRepo = await git.isRepo();
    if (!isRepo) return { isRepo: false, files: ws?.list?.().length ?? 0 };
    const [branch, remotes, changes, commits, ghRepo] = await Promise.all([git.branch(), git.remotes(), git.status(), git.hasCommits(), git.run(['config', '--get', 'hivedesk.githubrepo'], { allowFail: true })]);
    const origin = remotes.find((r) => r.name === 'origin');
    const fullName = ghRepo.code ? repoFromUrl(origin?.url, webBase) : ghRepo.stdout.trim();
    const ahead = origin && branch ? await git.ahead('origin', branch) : null;
    return { isRepo: true, branch, remotes, origin: origin?.url || null, fullName: fullName || null, changes, hasCommits: commits, ahead };
  }

  async function gitState() {
    try {
      const v = await git.version();
      const okEnv = v.major > 2 || (v.major === 2 && v.minor >= 31);
      return { ok: true, version: v.text, tokenPush: okEnv, hint: okEnv ? undefined : 'git 2.31 or newer is needed to push with a GitHub token. Update git from https://git-scm.com/downloads.' };
    } catch (err) {
      return { ok: false, code: err.code, message: err.message, hint: err.hint };
    }
  }

  async function status() {
    const g = await gitState();
    let repo = null;
    if (g.ok) { try { repo = await repoInfo(); } catch (err) { repo = { isRepo: false, error: clean(err.message) }; } }
    return {
      connected: !!account(),
      account: account(),
      git: g,
      repo,
      workspace: root,
      methods: {
        gh: { available: !!ghBin() },
        token: { page: TOKEN_PAGE, permissions: TOKEN_PERMISSIONS, file: path.join(home, 'github.json') },
        device: { available: !!clientId(), configFile: path.join(home, 'config.json') }
      },
      prs: prs()
    };
  }

  const clientId = () => o.clientId || readConfig(home)?.github?.clientId || null;

  function prs() {
    const out = [];
    for (const e of bus.events) if (e.type === 'github.pr.opened') out.push({ ...e.data, jobId: e.jobId || null, ts: e.ts });
    return out.reverse().slice(0, 30);
  }

  // ---- connect ----
  async function saveAccount(source, t, user) {
    const rec = { source, login: user.login, name: user.name, id: user.id, avatarUrl: user.avatarUrl };
    if (source !== 'gh') rec.token = t;
    store.save(rec);
    repoCache = null;
    bus.emit('github.connected', { login: user.login, source });
    return account();
  }

  async function connectToken(t) {
    const value = String(t || '').trim();
    if (!/^[\x21-\x7e]{20,255}$/.test(value)) throw fail('bad_request', 'That does not look like a GitHub token. Paste the whole token, it starts with github_pat_ or ghp_.');
    let user;
    try { user = await api(value).user(); } catch (err) { throw fail(err.code || 'github_error', redact(err.message, [value])); }
    return saveAccount('pat', value, user);
  }

  async function deviceStart() {
    const id = clientId();
    if (!id) throw fail('not_configured', `The device sign in is off: it needs the client id of your own OAuth app in ${path.join(home, 'config.json')} (see the README).`);
    deviceCancel();
    const a = createApi({ apiBase: o.apiBase, webBase: o.deviceBase || webBase, fetch: o.fetch });
    const start = await a.deviceStart(id, 'repo');
    const state = { ...start, cancelled: false, timer: null };
    device = state;
    let interval = Math.max(1, start.interval) * 1000;
    const deadline = Date.now() + (start.expiresIn || 900) * 1000;
    const tick = async () => {
      if (state.cancelled || device !== state) return;
      if (Date.now() > deadline) { bus.live('github.device', { state: 'failed', message: 'The code expired before it was entered. Start again.' }); device = null; return; }
      try {
        const r = await a.devicePoll(id, start.deviceCode);
        if (state.cancelled) return;
        if (r.token) {
          const user = await api(r.token).user();
          await saveAccount('device', r.token, user);
          bus.live('github.device', { state: 'connected', login: user.login });
          device = null;
          return;
        }
        if (r.slowDown) interval += 5000;
      } catch (err) {
        bus.live('github.device', { state: 'failed', message: clean(err.message) });
        device = null;
        return;
      }
      state.timer = setTimeout(tick, o.devicePollMs ?? interval);
      state.timer.unref?.();
    };
    state.timer = setTimeout(tick, o.devicePollMs ?? interval);
    state.timer.unref?.();
    bus.live('github.device', { state: 'waiting', userCode: start.userCode, verificationUri: start.verificationUri });
    return { userCode: start.userCode, verificationUri: start.verificationUri, expiresIn: start.expiresIn };
  }
  function deviceCancel() {
    if (device) { device.cancelled = true; clearTimeout(device.timer); device = null; }
  }

  function disconnect() {
    const a = account();
    store.clear();
    pendingGh = null;
    repoCache = null;
    if (a) bus.emit('github.disconnected', { login: a.login, source: a.source });
    return {};
  }

  async function repos(query) {
    needAccount();
    const now = Date.now();
    if (!repoCache || now - repoCache.at > 60_000) repoCache = { at: now, list: await api().repos({}) };
    const q = String(query || '').trim().toLowerCase();
    const list = q ? repoCache.list.filter((r) => r.fullName.toLowerCase().includes(q) || r.description.toLowerCase().includes(q)) : repoCache.list;
    return list.slice(0, 200);
  }

  // ---- plans ----
  const step = (key, text, params = {}, remote = false) => ({ key: `github.step.${key}`, text, params, remote });
  const fact = (key, label, value, extra = {}) => ({ key: `github.fact.${key}`, label, value, ...extra });

  async function commitMessage(report, given) {
    if (given) return { message: given, by: 'you' };
    if (!report) return { message: 'Update the workspace', by: 'rules' };
    const busy = (bus.state.jobs || []).some((j) => j.status === 'running' || j.status === 'planning');
    if (ask && scheduler?.hasBrain && !busy) {
      const json = await ask(commitPrompt(report), COMMIT_SCHEMA);
      const m = json && messageFromModel(json);
      if (m) return { message: m, by: 'mel' };
    }
    return { message: templateCommitMessage(report), by: 'rules' };
  }

  async function identityFor() {
    const id = await git.identity();
    if (id.name && id.email) return { identity: null, label: `${id.name} <${id.email}>` };
    const rec = store.read();
    if (rec?.login) {
      const email = rec.id ? `${rec.id}+${rec.login}@users.noreply.github.com` : `${rec.login}@users.noreply.github.com`;
      return { identity: { name: id.name || rec.name || rec.login, email: id.email || email }, label: `${id.name || rec.name || rec.login} <${id.email || email}>` };
    }
    throw fail('git_identity', 'git does not know who is committing. Set it once in a terminal: git config --global user.name "Your Name" and git config --global user.email "you@example.com", or connect GitHub to use your GitHub no-reply address.');
  }

  function workspaceFiles() {
    return (ws?.list?.() || []).map((f) => ({ path: f.path, status: 'new' }));
  }

  /**
   * Describes exactly what an intent will do. Throws an honest error when it cannot run.
   * @param {{ intent: string, name?: string, private?: boolean, repo?: string, branch?: string, message?: string, query?: string }} intent
   * @param {{ jobId?: string }} [opts]
   */
  async function buildPlan(intent, opts = {}) {
    const kind = intent.intent;
    const plan = { kind, title: '', facts: [], steps: [], warnings: [], edit: {}, remote: false, run: null };
    const g = await gitState();
    const needGit = () => { if (!g.ok) throw fail('git_missing', `${g.message} ${g.hint || ''}`.trim()); };
    const jobRunning = (bus.state.jobs || []).some((j) => j.status === 'running' || j.status === 'planning');

    switch (kind) {
      case 'connect': {
        const a = account();
        plan.title = a ? `GitHub is connected as @${a.login}` : 'Connect GitHub';
        plan.titleKey = a ? 'github.plan.connectedAs' : 'github.plan.connect';
        plan.titleParams = a ? { login: a.login } : {};
        plan.steps.push(step('openConnect', 'Open the GitHub window to choose how to connect: your gh login, a token, or the device sign in. Nothing is sent before you choose.'));
        plan.run = async () => ({ open: 'github', section: 'connect' });
        break;
      }
      case 'disconnect': {
        const a = needAccount();
        plan.title = `Disconnect @${a.login}`;
        plan.titleKey = 'github.plan.disconnect';
        plan.titleParams = { login: a.login };
        plan.steps.push(step('forget', `Delete the connection saved on this machine (${path.join(home, 'github.json')}). Nothing changes on GitHub; revoke the token on GitHub if you no longer need it.`, { file: path.join(home, 'github.json') }));
        plan.run = async () => disconnect();
        break;
      }
      case 'status':
      case 'list_repos': {
        plan.title = kind === 'status' ? 'Show the GitHub account and repository' : 'List your repositories';
        plan.titleKey = `github.plan.${kind}`;
        plan.steps.push(step('openWindow', 'Open the GitHub window. This only reads.'));
        plan.run = async () => ({ open: 'github', section: kind === 'status' ? 'account' : 'repos', query: intent.query || '' });
        break;
      }
      case 'pr_status': {
        const last = prs()[0];
        if (!last) throw fail('not_found', 'No pull request was opened from hivedesk yet.');
        plan.title = `Check pull request #${last.number}`;
        plan.titleKey = 'github.plan.prStatus';
        plan.titleParams = { number: last.number };
        plan.facts.push(fact('pr', 'Pull request', last.url));
        plan.steps.push(step('readPr', 'Read the pull request and its CI status from GitHub. This only reads.'));
        plan.run = async () => ({ open: 'github', section: 'prs', pr: await prStatus(last) });
        break;
      }
      case 'show_changelog':
      case 'show_activity': {
        plan.title = kind === 'show_changelog' ? 'Show the changelog' : 'Show the activity log';
        plan.titleKey = `github.plan.${kind}`;
        plan.steps.push(step('openChangelog', 'Open the Changelog window. This only reads.'));
        plan.run = async () => ({ open: 'changelog', tab: kind === 'show_changelog' ? 'changelog' : 'activity' });
        break;
      }
      case 'clone': {
        needGit();
        const a = needAccount();
        const spec = String(intent.repo || '').trim();
        if (!spec) throw fail('bad_request', 'Which repository? Say for example "clone owner/name", or pick one in the GitHub window.');
        const [owner, name] = spec.includes('/') ? spec.split('/') : [a.login, spec];
        const r = await api().repo(owner, name);
        const info = await repoInfo();
        const count = info.isRepo ? -1 : (ws?.list?.().length ?? 0);
        if (info.isRepo) throw fail('conflict', 'The workspace is already a git repository. Start hivedesk in a new folder (--dir) to clone another one.');
        if (count > 0) throw fail('conflict', `The workspace already has ${count} files. Cloning needs an empty workspace: start hivedesk in a new folder with --dir, then clone.`);
        plan.title = `Clone ${r.fullName}`;
        plan.titleKey = 'github.plan.clone';
        plan.titleParams = { repo: r.fullName };
        plan.facts.push(fact('repo', 'Repository', r.fullName), fact('visibility', 'Visibility', r.private ? 'private' : 'public', { valueKey: `github.vis.${r.private ? 'private' : 'public'}` }), fact('remote', 'Remote URL', r.cloneUrl), fact('into', 'Into', root));
        plan.steps.push(step('clone', `git clone ${r.cloneUrl} into the workspace`, { url: r.cloneUrl }));
        plan.run = async () => {
          await git.clone(r.cloneUrl, { token: await token(), webBase });
          await git.run(['config', 'hivedesk.githubrepo', r.fullName]);
          bus.emit('github.cloned', { repo: r.fullName, url: r.htmlUrl, private: r.private });
          return { repo: r.fullName, url: r.htmlUrl, files: ws?.list?.().length ?? 0 };
        };
        break;
      }
      case 'create_repo': {
        needGit();
        const a = needAccount();
        const name = cleanRepoName(intent.name) || '';
        const priv = intent.private !== false;
        const info = await repoInfo();
        const files = info.isRepo ? info.changes : workspaceFiles();
        plan.title = name ? `Create the repository ${a.login}/${name}` : 'Create a repository';
        plan.titleKey = 'github.plan.createRepo';
        plan.titleParams = { repo: `${a.login}/${name || '...'}` };
        plan.edit = { name, private: priv, message: 'Initial commit from hivedesk' };
        plan.facts.push(
          fact('account', 'Account', `@${a.login}`),
          fact('name', 'Name', name, { edit: 'name' }),
          fact('visibility', 'Visibility', priv ? 'private' : 'public', { edit: 'private' }),
          fact('remote', 'Remote URL', `${webBase}/${a.login}/${name || '<name>'}.git`, { template: `${webBase}/${a.login}/{name}.git` }),
          fact('branch', 'Branch', info.branch || 'main'),
          fact('files', 'Files to commit', files.length, { files: files.slice(0, 200) })
        );
        if (name) {
          try {
            await api().repo(a.login, name);
            plan.warnings.push({ key: 'github.warn.repoExists', text: `You already have a repository called ${name}. Pick another name.`, params: { name } });
          } catch (err) { if (err.code !== 'not_found') throw err; }
        }
        if (info.origin) plan.warnings.push({ key: 'github.warn.originReplaced', text: `The remote origin now points to ${info.origin}; it will point to the new repository.`, params: { url: info.origin } });
        if (jobRunning) plan.warnings.push({ key: 'github.warn.jobRunning', text: 'A job is still running, so files may still change.' });
        plan.steps.push(step('createRepo', 'Create the {visibility} repository {repo} on GitHub', { repo: `${a.login}/{name}`, visibility: '{visibility}' }, true));
        if (!info.isRepo) plan.steps.push(step('init', 'Turn the workspace into a git repository (branch main)'));
        if (files.length && !info.hasCommits) plan.steps.push(step('commitFiles', 'Commit the {count} files with the message "{message}"', { count: files.length, message: '{message}' }));
        plan.steps.push(step('setRemote', 'Set the remote origin to {url}', { url: `${webBase}/${a.login}/{name}.git` }));
        if (files.length || info.hasCommits) plan.steps.push(step('push', 'Push the branch {branch} to {url}', { branch: info.branch || 'main', url: `${webBase}/${a.login}/{name}.git` }, true));
        plan.remote = true;
        plan.run = async (e) => {
          const repoName = cleanRepoName(e.name);
          if (!repoName) throw fail('bad_request', 'Give the repository a name: letters, digits, dot, dash or underscore.');
          const created = await api().createRepo({ name: repoName, private: e.private !== false, description: 'Built with hivedesk' });
          bus.emit('github.repo.created', { fullName: created.fullName, private: created.private, url: created.htmlUrl });
          const out = { repo: created.fullName, url: created.htmlUrl, private: created.private };
          if (!(await git.isRepo())) await git.init('main');
          await git.run(['config', 'hivedesk.githubrepo', created.fullName]);
          const has = await git.hasCommits();
          if (!has && (await git.status()).length) {
            const { identity } = await identityFor();
            const c = await git.commitAll(e.message || 'Initial commit from hivedesk', identity);
            const b = await git.branch();
            bus.emit('github.committed', { sha: c.sha, branch: b, subject: (e.message || 'Initial commit from hivedesk').split('\n')[0], files: c.files.length });
          }
          await git.setRemote('origin', created.cloneUrl);
          if (await git.hasCommits()) {
            const b = (await git.branch()) || 'main';
            await git.push('origin', b, { token: await token(), webBase });
            bus.emit('github.pushed', { remote: 'origin', branch: b, url: cleanUrl(created.cloneUrl), repo: created.fullName });
            out.pushed = b;
          }
          return out;
        };
        break;
      }
      case 'branch': {
        needGit();
        const info = await repoInfo();
        const report = jobReport(bus.events, opts.jobId, bus.state);
        const name = intent.branch || (report ? jobBranch(report.jobId, report.request) : '');
        if (!validBranch(name)) throw fail('bad_request', name ? `"${name}" is not a valid branch name.` : 'Which branch? Say for example "create the branch fix-header".');
        plan.title = `Create the branch ${name}`;
        plan.titleKey = 'github.plan.branch';
        plan.titleParams = { branch: name };
        plan.facts.push(fact('branch', 'Branch', name), fact('from', 'From', info.branch || 'main'));
        if (!info.isRepo) plan.steps.push(step('init', 'Turn the workspace into a git repository (branch main)'));
        plan.steps.push(step('createBranch', 'Create the branch {branch} and switch to it (local only)', { branch: name }));
        plan.run = async () => {
          if (!(await git.isRepo())) await git.init('main');
          await git.createBranch(name);
          bus.emit('github.branch', { branch: name }, report ? { jobId: report.jobId } : {});
          return { branch: name };
        };
        break;
      }
      case 'commit':
      case 'commit_push':
      case 'push': {
        needGit();
        const info = await repoInfo();
        const report = jobReport(bus.events, opts.jobId, bus.state);
        const doCommit = kind !== 'push';
        const doPush = kind !== 'commit';
        let branch = info.branch || 'main';
        let newBranch = null;
        if (doCommit) {
          const files = info.isRepo ? info.changes : workspaceFiles();
          if (!files.length) throw fail('nothing_to_commit', 'There is nothing to commit: no file changed since the last commit.');
          // A branch per job: work on the default branch moves to the job's own branch.
          if (report && info.hasCommits && ['main', 'master'].includes(branch) && !intent.branch) newBranch = jobBranch(report.jobId, report.request);
          if (intent.branch && intent.branch !== branch) newBranch = intent.branch;
          if (newBranch && !validBranch(newBranch)) throw fail('bad_request', `"${newBranch}" is not a valid branch name.`);
          const msg = await commitMessage(report, intent.message);
          const who = await identityFor();
          plan.edit.message = msg.message;
          plan.messageBy = msg.by;
          plan.facts.push(fact('branch', 'Branch', newBranch || branch, newBranch ? { note: 'new' } : {}), fact('files', 'Files to commit', files.length, { files: files.slice(0, 200) }), fact('message', 'Commit message', msg.message, { edit: 'message', by: msg.by }), fact('author', 'Author', who.label));
          if (report) plan.facts.push(fact('job', 'Job', report.request));
          if (!info.isRepo) plan.steps.push(step('init', 'Turn the workspace into a git repository (branch main)'));
          if (newBranch) plan.steps.push(step('createBranch', 'Create the branch {branch} for this job and switch to it (local only)', { branch: newBranch }));
          plan.steps.push(step('commit', 'Stage the {count} files and commit them (local only)', { count: files.length }));
          if (newBranch) branch = newBranch;
        }
        let remoteUrl = null;
        if (doPush) {
          if (!info.isRepo && !doCommit) throw fail('conflict', 'The workspace is not a git repository yet. Create a repository first.');
          remoteUrl = info.origin;
          if (!remoteUrl) throw fail('no_remote', 'This repository has no remote yet. Create a GitHub repository from the workspace first (say "create a private repository called <name>").');
          if (!doCommit && info.ahead === 0) throw fail('nothing_to_push', `Nothing to push: ${branch} is already on ${remoteUrl}.`);
          if (!doCommit && !info.hasCommits) throw fail('nothing_to_push', 'Nothing to push: there are no commits yet.');
          const a = account();
          plan.facts.push(fact('remote', 'Remote URL', remoteUrl));
          if (!doCommit) plan.facts.push(fact('branch', 'Branch', branch), fact('commits', 'Commits to push', info.ahead == null ? 'all (first push of this branch)' : info.ahead, info.ahead == null ? { valueKey: 'github.fact.allCommits' } : {}));
          if (a) plan.facts.push(fact('account', 'As', `@${a.login}`));
          else if (/^https:\/\//.test(remoteUrl)) plan.warnings.push({ key: 'github.warn.notConnected', text: 'GitHub is not connected, so the push may be refused. Connect GitHub first.' });
          plan.steps.push(step('push', 'Push the branch {branch} to {url}', { branch, url: remoteUrl }, true));
          plan.remote = true;
        }
        if (jobRunning) plan.warnings.push({ key: 'github.warn.jobRunning', text: 'A job is still running, so files may still change.' });
        plan.title = kind === 'push' ? `Push ${branch}` : kind === 'commit' ? `Commit to ${branch}` : `Commit and push ${branch}`;
        plan.titleKey = `github.plan.${kind === 'commit_push' ? 'commitPush' : kind}`;
        plan.titleParams = { branch };
        const reportJob = report?.jobId;
        plan.run = async (e) => {
          const out = {};
          const ev = reportJob ? { jobId: reportJob } : {};
          if (doCommit) {
            const message = String(e.message || '').trim();
            if (!message) throw fail('bad_request', 'The commit message is empty.');
            if (!(await git.isRepo())) await git.init('main');
            if (newBranch) { await git.createBranch(newBranch); bus.emit('github.branch', { branch: newBranch }, ev); }
            const { identity } = await identityFor();
            const c = await git.commitAll(message, identity);
            Object.assign(out, { sha: c.sha, files: c.files.length, branch: await git.branch() });
            bus.emit('github.committed', { sha: c.sha, branch: out.branch, subject: message.split('\n')[0].slice(0, 200), files: c.files.length }, ev);
          }
          if (doPush) {
            const b = (await git.branch()) || branch;
            await git.push('origin', b, { token: await token(), webBase });
            out.pushed = b;
            out.remote = remoteUrl;
            bus.emit('github.pushed', { remote: 'origin', branch: b, url: remoteUrl, repo: info.fullName || null }, ev);
          }
          return out;
        };
        break;
      }
      case 'open_pr': {
        needGit();
        needAccount();
        const info = await repoInfo();
        if (!info.isRepo || !info.hasCommits) throw fail('conflict', 'There is nothing to open a pull request for yet: commit the job first.');
        if (!info.fullName) throw fail('no_remote', 'This workspace is not linked to a GitHub repository yet. Create one from the workspace first.');
        const [owner, name] = info.fullName.split('/');
        const r = await api().repo(owner, name);
        const head = info.branch;
        if (!head) throw fail('conflict', 'git is not on a branch right now (detached HEAD).');
        if (head === r.defaultBranch) throw fail('conflict', `You are on ${head}, the default branch. A pull request needs the job's own branch: commit the job (Mel makes a branch per job) or create a branch first.`);
        const report = jobReport(bus.events, opts.jobId, bus.state);
        const title = report ? commitSubject(report) : head;
        const body = prBody(report);
        plan.edit = { title, body };
        plan.facts.push(fact('repo', 'Repository', r.fullName), fact('from', 'From branch', head), fact('into', 'Into', r.defaultBranch), fact('title', 'Title', title, { edit: 'title' }), fact('body', 'Description', body, { edit: 'body', long: true }), fact('remote', 'Remote URL', info.origin || r.cloneUrl));
        if (info.changes.length) plan.warnings.push({ key: 'github.warn.uncommitted', text: `${info.changes.length} files are not committed and will not be in the pull request.`, params: { count: info.changes.length } });
        const needPush = info.ahead == null || info.ahead > 0;
        if (needPush) plan.steps.push(step('push', 'Push the branch {branch} to {url}', { branch: head, url: info.origin }, true));
        plan.steps.push(step('openPr', 'Open a pull request on GitHub from {head} into {base}', { head, base: r.defaultBranch }, true));
        plan.remote = true;
        plan.title = `Open a pull request from ${head}`;
        plan.titleKey = 'github.plan.openPr';
        plan.titleParams = { branch: head };
        const reportJob = report?.jobId;
        plan.run = async (e) => {
          const ev = reportJob ? { jobId: reportJob } : {};
          if (needPush) {
            await git.push('origin', head, { token: await token(), webBase });
            bus.emit('github.pushed', { remote: 'origin', branch: head, url: info.origin, repo: r.fullName }, ev);
          }
          const pr = await api().createPull(owner, name, { title: String(e.title || title).slice(0, 250), head, base: r.defaultBranch, body: String(e.body ?? body).slice(0, 60_000) });
          bus.emit('github.pr.opened', { number: pr.number, url: pr.url, title: pr.title, head, base: r.defaultBranch, repo: r.fullName, sha: pr.headSha || null }, ev);
          return { pr };
        };
        break;
      }
      default:
        throw fail('not_understood', 'Mel did not understand that as a GitHub or changelog request. Try "commit and push", "open a pull request" or "show the changelog".');
    }
    return savePlan(plan, intent, opts);
  }

  function savePlan(plan, intent, opts) {
    const id = `gp_${Date.now().toString(36)}_${++planSeq}`;
    const now = Date.now();
    for (const [k, p] of plans) if (p.expiresAt < now) plans.delete(k);
    const stored = { ...plan, id, intent, jobId: opts.jobId || null, createdAt: new Date(now).toISOString(), expiresAt: now + PLAN_TTL_MS };
    plans.set(id, stored);
    return publicPlan(stored);
  }

  function publicPlan(p) {
    const { run, expiresAt, ...rest } = p;
    return JSON.parse(clean(JSON.stringify({ ...rest, expiresAt: new Date(expiresAt).toISOString(), needsConfirm: true })));
  }

  /** Runs a confirmed plan once. */
  function confirm(planId, edits = {}) {
    const p = plans.get(planId);
    if (!p) throw fail('not_found', 'That confirmation expired or was already used. Ask again.');
    plans.delete(planId);
    if (p.expiresAt < Date.now()) throw fail('expired', 'That confirmation expired. Ask again.');
    const e = { ...p.edit };
    for (const k of ['name', 'private', 'message', 'title', 'body']) if (edits && edits[k] !== undefined && k in p.edit) e[k] = k === 'private' ? edits[k] !== false : String(edits[k]);
    return exclusive(async () => {
      try {
        const result = await p.run(e);
        return JSON.parse(clean(JSON.stringify({ ok: true, kind: p.kind, ...result })));
      } catch (err) {
        const message = clean(`${err.message}${err.hint ? ` ${err.hint}` : ''}`);
        bus.emit('github.failed', { action: p.kind, code: err.code || 'internal', message }, p.jobId ? { jobId: p.jobId } : {});
        throw fail(typeof err.code === 'string' ? err.code : 'internal', message);
      }
    });
  }

  async function prStatus(pr) {
    const [owner, name] = String(pr.repo || '').split('/');
    if (!owner || !name) throw fail('bad_request', 'Which pull request?');
    const a = api();
    const p = await a.pull(owner, name, pr.number);
    const ci = p.headSha ? await a.ci(owner, name, p.headSha) : { state: 'unknown', checks: [] };
    return { ...p, repo: `${owner}/${name}`, ci };
  }

  /** text -> structured intent -> plan (nothing runs). */
  async function intentPlan(text, opts = {}) {
    const busy = (bus.state.jobs || []).some((j) => j.status === 'running' || j.status === 'planning');
    const useModel = opts.useModel ?? (!!scheduler?.hasBrain && !busy);
    const parsed = await parseIntent(text, useModel && ask ? { ask } : {});
    if (parsed.intent === 'none') return { parsed, plan: null, message: 'Mel did not understand that as a GitHub or changelog request. Try "commit and push", "open a pull request" or "show the changelog".' };
    const plan = await buildPlan(parsed, { jobId: opts.jobId });
    return { parsed, plan };
  }

  async function runIntentFn(text, opts = {}) {
    if (typeof opts.confirm !== 'function') throw fail('bad_request', 'runIntent needs a confirm function: nothing runs without an explicit yes.');
    const { parsed, plan, message } = await intentPlan(text, opts);
    if (!plan) return { ok: false, ran: false, parsed, message };
    let yes = false;
    try { yes = (await opts.confirm(plan)) === true; } catch { yes = false; }
    if (!yes) { plans.delete(plan.id); return { ok: true, ran: false, parsed, plan }; }
    const result = await confirm(plan.id, typeof opts.edits === 'object' ? opts.edits : {});
    return { ok: true, ran: true, parsed, plan, result };
  }

  // ---- chat: Mel answers GitHub requests with a confirmation card ----
  // In the user's language (src/crew/say.js); a host without say() gets the English line.
  const speak = (key, params, channel) => (typeof hive?.say === 'function'
    ? hive.say('mel', key, params, { channel })
    : hive?.chat?.('mel', say('en', key, params), undefined, channel));
  const offChat = bus.on((e) => {
    if (e.type !== 'chat.message') return;
    const d = e.data || {};
    const from = String(d.from || '');
    if (from !== 'user' && !from.startsWith('guest:')) return;
    if (d.channel !== 'general' && d.channel !== 'dm:mel') return;
    if (!looksLikeGitIntent(d.text)) return;
    const rules = parseRules(d.text);
    if (rules.intent === 'none' || rules.confidence < 0.6) return;
    setTimeout(async () => {
      try {
        const plan = await buildPlan(rules, {});
        const lines = plan.steps.map((s, i) => `${i + 1}. ${stepText(s, plan)}`);
        speak('crew.say.gitPlan', { steps: lines.join('\n') }, d.channel);
        bus.live('github.plan', { plan, origin: 'chat', text: String(d.text).slice(0, 300), by: from });
      } catch (err) {
        speak('crew.say.gitFailed', { error: clean(err.message) }, d.channel);
      }
    }, 0);
  });

  // ---- commands ----
  const cmd = (type, fn) => server?.command?.(type, async (data, client) => {
    try { return await fn(data || {}, client); } catch (err) { throw fail(typeof err.code === 'string' ? err.code : 'internal', clean(`${err.message}${err.hint && !String(err.message).includes(err.hint) ? ` ${err.hint}` : ''}`)); }
  });
  cmd('github.status', () => status());
  cmd('github.gh.check', async () => {
    const t = await ghToken();
    const user = await api(t).user();
    pendingGh = { id: `gh_${Date.now().toString(36)}`, token: t, user, at: Date.now() };
    return { pendingId: pendingGh.id, account: { login: user.login, name: user.name, avatarUrl: user.avatarUrl, htmlUrl: user.htmlUrl } };
  });
  cmd('github.gh.confirm', async (d) => {
    if (!pendingGh || pendingGh.id !== d.pendingId || Date.now() - pendingGh.at > 5 * 60_000) throw fail('expired', 'Check the gh login again first.');
    const p = pendingGh;
    pendingGh = null;
    return { account: await saveAccount('gh', null, p.user) };
  });
  cmd('github.token.set', async (d) => ({ account: await connectToken(d.token) }));
  cmd('github.device.start', () => deviceStart());
  cmd('github.device.cancel', () => { deviceCancel(); return {}; });
  cmd('github.disconnect', () => disconnect());
  cmd('github.repos', async (d) => ({ repos: await repos(d.query) }));
  cmd('github.plan', async (d) => buildPlan({ ...d, intent: String(d.intent || d.action || '') }, { jobId: typeof d.jobId === 'string' ? d.jobId : undefined }));
  cmd('github.intent', async (d) => intentPlan(String(d.text || '').slice(0, 1000), { jobId: typeof d.jobId === 'string' ? d.jobId : undefined, useModel: typeof d.useModel === 'boolean' ? d.useModel : undefined }));
  cmd('github.confirm', (d) => confirm(String(d.planId || ''), d.edits || {}));
  cmd('github.cancel', (d) => { plans.delete(String(d.planId || '')); return {}; });
  cmd('github.prs', () => ({ prs: prs() }));
  cmd('github.pr.status', async (d) => {
    const pr = d.repo && d.number ? { repo: d.repo, number: d.number } : prs()[0];
    if (!pr) throw fail('not_found', 'No pull request was opened from hivedesk yet.');
    return { pr: await prStatus(pr) };
  });
  cmd('github.report', (d) => {
    const r = jobReport(bus.events, typeof d.jobId === 'string' ? d.jobId : undefined, bus.state);
    if (!r) throw fail('not_found', 'No finished job yet.');
    return { report: r, commitMessage: templateCommitMessage(r), prBody: prBody(r) };
  });

  return {
    status, buildPlan, confirm, intentPlan, runIntent: runIntentFn, prStatus, repos, connectToken, disconnect, deviceStart, deviceCancel, store, git, plans,
    close() { deviceCancel(); offChat(); }
  };
}

/** Fills {name} placeholders. */
export function fill(text, params = {}) {
  return String(text).replace(/\{(\w+)\}/g, (m, k) => (params[k] !== undefined && params[k] !== null && params[k] !== '' ? String(params[k]) : m));
}

/** A step in plain English with the plan values filled in. */
export function stepText(s, plan) {
  const base = planFill(plan);
  const params = Object.fromEntries(Object.entries(s.params || {}).map(([k, v]) => [k, fill(v, base)]));
  return fill(s.text, { ...base, ...params });
}

function planFill(plan) {
  return { name: plan.edit?.name || '<name>', visibility: plan.edit?.private === false ? 'public' : 'private', message: (plan.edit?.message || '').split('\n')[0] };
}
