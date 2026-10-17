import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseRules, parseIntent, looksLikeGitIntent, extractRepo } from '../../src/github/intent.js';
import { createGitHub, jobBranch, repoFromUrl, stepText } from '../../src/github/index.js';
import { EventBus } from '../../src/bus.js';
import { Workspace } from '../../src/tools/index.js';
import { tmpDir } from '../helpers.js';

describe('intent parsing (rules)', () => {
  const cases = [
    ['conecte meu GitHub', { intent: 'connect' }],
    ['connect my GitHub', { intent: 'connect' }],
    ['crie um repositório privado chamado loja', { intent: 'create_repo', name: 'loja', private: true }],
    ['create a private repository named shop', { intent: 'create_repo', name: 'shop', private: true }],
    ['crie um repositorio publico chamado blog-da-ana', { intent: 'create_repo', name: 'blog-da-ana', private: false }],
    ['new public repo called my.site', { intent: 'create_repo', name: 'my.site', private: false }],
    ['faça commit e push', { intent: 'commit_push' }],
    ['commit and push', { intent: 'commit_push' }],
    ['faça commit', { intent: 'commit' }],
    ['push the branch', { intent: 'push' }],
    ['abra um pull request', { intent: 'open_pr' }],
    ['open a pull request', { intent: 'open_pr' }],
    ['qual o status do PR?', { intent: 'pr_status' }],
    ['mostre o changelog', { intent: 'show_changelog' }],
    ['ver changelog', { intent: 'show_changelog' }],
    ['show the changelog', { intent: 'show_changelog' }],
    ['mostre o log de atividade', { intent: 'show_activity' }],
    ['clone kwy-test/loja', { intent: 'clone', repo: 'kwy-test/loja' }],
    ['clone https://github.com/someone/thing.git', { intent: 'clone', repo: 'someone/thing' }],
    ['liste meus repositórios', { intent: 'list_repos' }],
    ['crie a branch fix-header', { intent: 'branch', branch: 'fix-header' }],
    ['desconecte meu GitHub', { intent: 'disconnect' }]
  ];
  for (const [text, want] of cases) {
    it(`"${text}"`, () => {
      expect(parseRules(text)).toMatchObject(want);
    });
  }

  it('leaves visibility out when the request does not say it', () => {
    expect(parseRules('crie um repositório chamado loja')).not.toHaveProperty('private');
  });

  it('ignores ordinary requests', () => {
    expect(parseRules('a tiny landing page for a bakery').intent).toBe('none');
    expect(parseRules('faça a página mais bonita').intent).toBe('none');
    expect(looksLikeGitIntent('build a todo app')).toBe(false);
    expect(looksLikeGitIntent('faça commit e push')).toBe(true);
  });

  it('reads owner and name from URLs', () => {
    expect(extractRepo('clone git@github.com:a/b.git')).toBe('a/b');
    expect(repoFromUrl('https://github.com/kwy404/hivedesk.git')).toBe('kwy404/hivedesk');
    expect(repoFromUrl('git@github.com:kwy404/hivedesk.git')).toBe('kwy404/hivedesk');
    expect(repoFromUrl('C:/tmp/remote.git')).toBe(null);
  });

  it('names a job branch from the job', () => {
    expect(jobBranch('j_3', 'Uma página de preços, bem simples!')).toBe('hivedesk/j-3-uma-pagina-de-precos-bem-simples');
  });
});

describe('intent parsing with the model', () => {
  it('uses a valid model answer and keeps the rules as the fallback', async () => {
    const ask = async () => ({ intent: 'create_repo', name: 'loja', private: true });
    expect(await parseIntent('quero um repo novo, privado, loja', { ask })).toMatchObject({ intent: 'create_repo', name: 'loja', private: true, by: 'model' });
    expect(await parseIntent('faça commit e push', { ask: async () => ({ intent: 'bogus' }) })).toMatchObject({ intent: 'commit_push', by: 'rules' });
    expect(await parseIntent('abra um pull request', { ask: async () => { throw new Error('no model'); } })).toMatchObject({ intent: 'open_pr', by: 'rules' });
    expect(await parseIntent('mostre o changelog', { ask: async () => ({ intent: 'none' }) })).toMatchObject({ intent: 'show_changelog', by: 'rules' });
  });
});

describe('runIntent never runs without an explicit yes', () => {
  function setup() {
    const base = tmpDir('hivedesk-intent-');
    const bus = new EventBus();
    const ws = new Workspace(path.join(base, 'ws'));
    ws.write('index.html', '<p>hi</p>\n');
    const calls = [];
    const fetch = async (url, init) => { calls.push({ url, method: init.method }); return new Response(JSON.stringify({ login: 'octo', id: 1 }), { status: 200 }); };
    const gh = createGitHub({ bus, workspace: ws, config: { home: path.join(base, 'home') }, github: { apiBase: 'http://127.0.0.1:9', fetch, ask: null, restrict: () => true } });
    gh.store.save({ source: 'pat', token: 'github_pat_x_0123456789abcdefghij', login: 'octo', id: 1 });
    return { gh, bus, ws, calls };
  }

  it('asks first, and a No (or anything but true) runs nothing', async () => {
    const { gh, ws, calls } = setup();
    const seen = [];
    for (const answer of [false, undefined, 'yes', 1]) {
      const r = await gh.runIntent('faça commit', { confirm: (plan) => { seen.push(plan); return answer; } });
      expect(r.ran).toBe(false);
    }
    const r2 = await gh.runIntent('commit the work', { confirm: () => { throw new Error('closed'); } });
    expect(r2.ran).toBe(false);
    expect(seen[0]).toMatchObject({ kind: 'commit', needsConfirm: true });
    await expect(gh.runIntent('faça commit e push', { confirm: () => true })).rejects.toMatchObject({ code: 'no_remote' });
    expect(seen.every((p) => !gh.plans.has(p.id))).toBe(true);
    // Only reads happened: no git repository, no POST to GitHub.
    expect(fs.existsSync(path.join(ws.root, '.git'))).toBe(false);
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('refuses to run without a confirm function', async () => {
    const { gh } = setup();
    await expect(gh.runIntent('commit', {})).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('runs a local commit only after true, with the edited message', async () => {
    const { gh, ws } = setup();
    process.env.GIT_AUTHOR_NAME ||= 'Test Bee';
    const r = await gh.runIntent('faça commit', { confirm: async (plan) => plan.kind === 'commit', edits: { message: 'First commit, edited' } });
    expect(r.ran).toBe(true);
    expect(r.result.sha).toMatch(/^[0-9a-f]{40}$/);
    const log = await gh.git.log(1);
    expect(log[0].subject).toBe('First commit, edited');
    expect(fs.existsSync(path.join(ws.root, '.git'))).toBe(true);
  });

  it('describes each step in plain words for the chat', () => {
    const plan = { edit: { name: 'loja', private: true } };
    expect(stepText({ text: 'Create the {visibility} repository {repo} on GitHub', params: { repo: 'octo/{name}', visibility: '{visibility}' } }, plan)).toBe('Create the private repository octo/loja on GitHub');
  });

  it('says honestly when a request is not about GitHub', async () => {
    const { gh } = setup();
    const r = await gh.runIntent('make the header blue', { confirm: () => true });
    expect(r).toMatchObject({ ok: false, ran: false });
    expect(r.message).toMatch(/did not understand/);
  });
});
