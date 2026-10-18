// The whole GitHub flow against a local stub of the GitHub API and local bare repositories:
// connect with a token, create a private repository from the workspace, run a job, write the
// changelog, commit and push on the job's branch, open a pull request and read its CI status.
// Nothing runs without github.confirm, and the token never shows up in events, frames or logs.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startHive } from '../../src/index.js';
import { connect } from '../../src/ws.js';
import { createFakeBrain } from '../../src/brain/fake.js';
import { tmpDir, waitFor } from '../helpers.js';
import { startStub } from './stub.js';

const TOKEN = 'github_pat_TESTONLY_0123456789abcdefghijklmnopqrstuvwxyz';
const BASIC = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
const gitIn = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();

const respond = (messages, options) => {
  if (options.schema?.properties?.tasks) return { summary: 'ok', tasks: [{ title: 'Add the landing page', detail: '', assignee: 'dev', dependsOn: [] }] };
  const content = messages.find((m) => m.role === 'user')?.content || '';
  if (content.includes('Your task: Add the landing page')) {
    return messages.filter((m) => m.role === 'assistant').length === 0
      ? { tool: 'write_file', args: { path: 'index.html', content: '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>Shop</title></head><body><h1>Shop</h1></body></html>' } }
      : { tool: 'done', args: { summary: 'wrote it' } };
  }
  return { tool: 'report', args: { passed: true, issues: [] } };
};

describe('GitHub flow (stub API, no network)', () => {
  let app; let stub; let home; let conn; const frames = []; const logs = [];
  let n = 0;
  const cmd = (type, data = {}) => new Promise((resolve, reject) => {
    const id = `t${++n}`;
    const onMsg = (text) => {
      const f = JSON.parse(text);
      if (f.kind === 'reply' && f.id === id) {
        conn.off('message', onMsg);
        if (f.ok) resolve(f.result); else reject(Object.assign(new Error(f.error.message), { code: f.error.code }));
      }
    };
    conn.on('message', onMsg);
    conn.sendJson({ kind: 'command', id, type, data });
  });

  beforeAll(async () => {
    const base = tmpDir('hivedesk-ghflow-');
    home = path.join(base, 'home');
    stub = await startStub({ token: TOKEN, reposDir: path.join(base, 'remotes') });
    app = await startHive({
      dir: path.join(base, 'project'), home, uiDir: base, brain: createFakeBrain({ id: 'fake', respond }), log: (l) => logs.push(l),
      github: { apiBase: stub.base, webBase: stub.base, ask: null }
    });
    // Commits need a name; a fresh CI machine may have none.
    process.env.GIT_AUTHOR_NAME = 'Test Bee'; process.env.GIT_AUTHOR_EMAIL = 'bee@example.invalid';
    process.env.GIT_COMMITTER_NAME = 'Test Bee'; process.env.GIT_COMMITTER_EMAIL = 'bee@example.invalid';
    conn = await connect(`ws://127.0.0.1:${app.server.port}/ws?t=${app.server.token}`);
    conn.on('message', (t) => frames.push(t));
  });
  afterAll(async () => { conn?.close(); await app?.close(); await stub?.close(); });

  it('reports git and the connection methods before connecting', async () => {
    const s = await cmd('github.status');
    expect(s.connected).toBe(false);
    expect(s.git.ok).toBe(true);
    expect(s.methods.token.page).toBe('https://github.com/settings/personal-access-tokens/new');
    expect(s.methods.token.permissions.map((p) => p.id)).toContain('contents');
    expect(s.methods.device.available).toBe(false);
    await expect(cmd('github.device.start')).rejects.toMatchObject({ code: 'not_configured' });
    await expect(cmd('github.repos')).rejects.toMatchObject({ code: 'not_connected' });
  });

  it('refuses a bad token honestly and keeps nothing', async () => {
    await expect(cmd('github.token.set', { token: 'github_pat_WRONG_0123456789abcdefghij' })).rejects.toMatchObject({ code: 'github_unauthorized' });
    expect(fs.existsSync(path.join(home, 'github.json'))).toBe(false);
  });

  it('connects with a pasted token and stores it only in the home folder', async () => {
    const r = await cmd('github.token.set', { token: TOKEN });
    expect(r.account).toMatchObject({ login: 'octo-tester', source: 'pat' });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    const file = path.join(home, 'github.json');
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).token).toBe(TOKEN);
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o077).toBe(0);
    else {
      const acl = execFileSync('icacls', [file], { encoding: 'utf8', windowsHide: true });
      expect(acl).not.toMatch(/Everyone|BUILTIN\\Users|Authenticated Users/i);
    }
    expect(app.bus.events.some((e) => e.type === 'github.connected' && e.data.login === 'octo-tester')).toBe(true);
    const repos = await cmd('github.repos', { query: 'exist' });
    expect(repos.repos.map((x) => x.fullName)).toEqual(['octo-tester/existing']);
  });

  it('creates a private repository from the workspace only after the confirmation', async () => {
    app.toolbox.ws.write('README.md', '# Shop\n');
    const { parsed, plan } = await cmd('github.intent', { text: 'crie um repositório privado chamado loja' });
    expect(parsed).toMatchObject({ intent: 'create_repo', name: 'loja', private: true });
    expect(plan.needsConfirm).toBe(true);
    expect(plan.remote).toBe(true);
    expect(plan.edit).toMatchObject({ name: 'loja', private: true });
    const facts = Object.fromEntries(plan.facts.map((f) => [f.key, f.value]));
    expect(facts['github.fact.remote']).toBe(`${stub.base}/octo-tester/loja.git`);
    expect(facts['github.fact.files']).toBe(1);
    expect(plan.steps.map((s) => s.key)).toEqual(['github.step.createRepo', 'github.step.init', 'github.step.commitFiles', 'github.step.setRemote', 'github.step.push']);
    // Nothing happened yet.
    expect(stub.repos.has('octo-tester/loja')).toBe(false);
    expect(fs.existsSync(path.join(app.paths.workspace, '.git'))).toBe(false);

    const done = await cmd('github.confirm', { planId: plan.id });
    expect(done).toMatchObject({ ok: true, repo: 'octo-tester/loja', private: true, pushed: 'main' });
    expect(stub.repos.get('octo-tester/loja').private).toBe(true);
    const remote = stub.repos.get('octo-tester/loja').clone_url;
    expect(gitIn(remote, 'log', '-1', '--format=%s', 'main')).toBe('Initial commit from hivedesk');
    await expect(cmd('github.confirm', { planId: plan.id })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('commits a job on its own branch with the changelog, pushes and opens a pull request', async () => {
    const { jobId } = await cmd('job.create', { request: 'a tiny landing page for the shop', approval: false, refine: false });
    await waitFor(() => app.bus.events.some((e) => e.type === 'job.done' && e.jobId === jobId), { timeout: 30000 });
    const proposed = await waitFor(() => app.bus.events.find((e) => e.type === 'changelog.proposed' && e.jobId === jobId), { timeout: 5000 });
    expect(proposed.data.entry.Added).toContain('Add the landing page');
    expect(['minor', 'patch', 'major']).toContain(proposed.data.suggestion.bump);
    expect(proposed.data.suggestion.reason.length).toBeGreaterThan(5);

    const w = await cmd('changelog.write', { proposalId: proposed.data.proposalId, markdown: '### Added\n\n- A landing page for the shop\n', release: true, version: '0.1.0' });
    expect(w.content).toContain('## [0.1.0] - ');
    expect(fs.readFileSync(path.join(app.paths.workspace, 'CHANGELOG.md'), 'utf8')).toContain('- A landing page for the shop');

    const { plan } = await cmd('github.intent', { text: 'faça commit e push' });
    expect(plan.kind).toBe('commit_push');
    const facts = Object.fromEntries(plan.facts.map((f) => [f.key, f]));
    expect(facts['github.fact.branch'].value).toMatch(/^hivedesk\/j-\d+-a-tiny-landing-page/);
    expect(facts['github.fact.files'].files.map((f) => f.path).sort()).toEqual(['CHANGELOG.md', 'index.html']);
    expect(plan.edit.message.split('\n')[0]).toBe('A tiny landing page for the shop');
    expect(facts['github.fact.remote'].value).toBe(stub.repos.get('octo-tester/loja').clone_url);
    const r = await cmd('github.confirm', { planId: plan.id, edits: { message: 'Add the shop landing page\n\nEdited by the user.' } });
    expect(r.pushed).toBe(facts['github.fact.branch'].value);
    const remote = stub.repos.get('octo-tester/loja').clone_url;
    expect(gitIn(remote, 'log', '-1', '--format=%s', r.pushed)).toBe('Add the shop landing page');

    const pr = await cmd('github.intent', { text: 'abra um pull request' });
    expect(pr.plan.kind).toBe('open_pr');
    expect(pr.plan.edit.body).toContain('## Request');
    expect(pr.plan.edit.body).toContain('A landing page for the shop');
    expect(stub.pulls.length).toBe(0);
    const opened = await cmd('github.confirm', { planId: pr.plan.id });
    expect(opened.pr.url).toMatch(/\/pull\/1$/);
    expect(stub.pulls[0]).toMatchObject({ head: { ref: r.pushed }, base: { ref: 'main' } });
    expect(stub.pulls[0].body).toContain('## Changelog');

    const st = await cmd('github.pr.status');
    expect(st.pr.ci.state).toBe('pending');
    expect(st.pr.ci.checks.map((c) => c.name)).toContain('lint');
  });

  it('logs who did what, including the GitHub steps', async () => {
    const a = await cmd('activity.list', { kind: 'git' });
    const actions = a.entries.map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['connected GitHub', 'created repository', 'committed', 'pushed', 'opened pull request']));
    const files = await cmd('activity.list', { kind: 'file' });
    const edit = files.entries.find((e) => e.path === 'index.html');
    expect(edit.who).toMatchObject({ id: 'dev', kind: 'worker' });
    const detail = await cmd('activity.detail', { seq: edit.seq });
    expect(detail.diff).toContain('+<!doctype html>');
  });

  it('answers a GitHub request in chat with a card, and runs nothing', async () => {
    const before = stub.requests.filter((x) => x.method === 'POST').length;
    await cmd('chat.send', { channel: 'general', text: 'create a public repository named another-shop' });
    const live = await waitFor(() => frames.map((t) => JSON.parse(t)).find((f) => f.kind === 'live' && f.type === 'github.plan'), { timeout: 5000 });
    expect(live.data.plan).toMatchObject({ kind: 'create_repo', needsConfirm: true, edit: { name: 'another-shop', private: false } });
    await waitFor(() => app.bus.events.some((e) => e.type === 'chat.message' && e.data.from === 'mel' && /exactly what will happen/.test(e.data.text)));
    expect(stub.requests.filter((x) => x.method === 'POST').length).toBe(before);
    expect(stub.repos.has('octo-tester/another-shop')).toBe(false);
  });

  it('never leaks the token to events, the log file, WebSocket frames or logs', async () => {
    expect(stub.seenAuth).toContain(`Bearer ${TOKEN}`);
    const all = [JSON.stringify(app.bus.events), fs.readdirSync(app.paths.segments).map((f) => fs.readFileSync(path.join(app.paths.segments, f), 'utf8')).join(''), frames.join('\n'), logs.join('\n'), JSON.stringify(await cmd('github.status'))];
    for (const text of all) {
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(BASIC);
    }
    const cfg = fs.readFileSync(path.join(app.paths.workspace, '.git', 'config'), 'utf8');
    expect(cfg).not.toContain(TOKEN);
    expect(cfg).not.toContain(BASIC);
  });

  it('disconnects and forgets the token file', async () => {
    await cmd('github.disconnect');
    expect(fs.existsSync(path.join(home, 'github.json'))).toBe(false);
    expect((await cmd('github.status')).connected).toBe(false);
  });
});
