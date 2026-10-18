import { describe, it, expect } from 'vitest';
import { selectPlaybooks } from '../../src/crew/library/select.js';
import { getLibrary } from '../../src/crew/library/index.js';
import { pickForTask, checkIdsOf, attachLibrary, setPlaybooks, resetLibraryState, jobDomain } from '../../src/crew/library/hook.js';
import { DOMAINS } from '../../src/crew/domains/index.js';
import { jobCrew } from '../../src/crew/domains/flow.js';
import { SPECIALISTS } from '../../src/crew/workers.js';
import { ROLES } from '../../src/crew/prompts/roles.js';
import { assembleTaskPrompt } from '../../src/crew/prompts/index.js';
import { EventBus } from '../../src/bus.js';
import { rig, eventsOf } from './rig.js';

const SAMPLES = [
  ['mobile', 'mobile', 'add offline support to the recipe app'],
  ['mobile', 'mobile', 'adicione notificacoes push no aplicativo'],
  ['desktop', 'desktop', 'save the window size and position'],
  ['desktop', 'desktop', 'abrir e salvar arquivos com dialogo'],
  ['backend', 'backend', 'add pagination to the orders endpoint'],
  ['backend', 'backend', 'validate the request body of POST /users'],
  ['security', 'security', 'check the project for leaked secrets'],
  ['devops', 'devops', 'write a Dockerfile for the service'],
  ['devops', 'devops', 'add a CI workflow that runs the tests'],
  ['cli', 'dev', 'add --verbose and --help flags'],
  ['extension', 'dev', 'the popup should save notes per site'],
  ['game', 'dev', 'add gravity and jumping to the player'],
  ['data', 'data', 'sum the sales per month from the csv']
];

describe('playbooks per domain', () => {
  it('the library has at least 25 playbooks in each new domain category, with checks', () => {
    const per = getLibrary().stats();
    for (const c of ['mobile', 'desktop', 'backend', 'security', 'devops', 'tools', 'games']) expect(per[c], c).toBeGreaterThanOrEqual(25);
    const added = getLibrary().all().filter((e) => ['mobile', 'desktop', 'backend', 'security', 'devops', 'tools', 'games'].includes(e.category));
    expect(added.length).toBeGreaterThanOrEqual(150);
    expect(added.every((e) => e.checks.length > 0)).toBe(true);
  });

  for (const [domain, role, task] of SAMPLES) {
    it(`${domain}: "${task}" picks a ${domain} playbook first`, () => {
      const sel = selectPlaybooks({ task, role, domain, family: 'local' });
      expect(sel.picks.length, JSON.stringify(sel.candidates)).toBeGreaterThan(0);
      expect(DOMAINS[domain].categories, sel.picks[0].id).toContain(sel.picks[0].category);
    });
  }

  it('a website job does not get the playbooks of other domains', () => {
    const sel = selectPlaybooks({ task: 'crie um site para minha padaria', role: 'dev', domain: 'web', family: 'local' });
    expect(sel.picks[0].id).toBe('bakery-site');
    expect(sel.picks.every((p) => !['mobile', 'desktop', 'backend', 'devops', 'tools', 'games', 'security'].includes(p.category))).toBe(true);
  });

  it('the hook keeps the domain of a job, picks by it and adds the domain checks to QA', () => {
    resetLibraryState();
    const bus = new EventBus();
    const { off } = attachLibrary({ bus, hive: null });
    bus.emit('job.created', { job: { id: 'j_1', request: 'make a phone app for recipes', status: 'planning', taskIds: [] } }, { jobId: 'j_1' });
    bus.emit('job.domain', { domain: 'mobile' }, { jobId: 'j_1' });
    expect(jobDomain('j_1')).toBe('mobile');
    const sel = pickForTask({ task: { id: 't_1', title: 'Make it work offline', detail: 'cache the app shell', kind: 'build' }, job: { id: 'j_1', request: 'recipes' }, worker: { id: 'mobile' } });
    expect(sel.picks[0].category).toBe('mobile');
    setPlaybooks('t_x', []);
    const ids = checkIdsOf([{ id: 't_x' }], undefined, 'mobile');
    expect(ids.enforce).toEqual(expect.arrayContaining(['pwa.manifest', 'pwa.service-worker', 'capacitor.config']));
    expect(checkIdsOf([{ id: 't_x' }], undefined, 'security').enforce).toEqual([]);
    off();
  });
});

describe('the specialists', () => {
  it('each has a role prompt for small models and grammar friendly tools', () => {
    for (const w of SPECIALISTS) {
      const r = ROLES[w.id];
      expect(r, w.id).toBeTruthy();
      expect(r.goals.length).toBeGreaterThanOrEqual(2);
      expect(r.never.length).toBeGreaterThanOrEqual(2);
      expect(JSON.stringify(r).length).toBeLessThan(1400);
      expect(w.specialist).toBe(true);
    }
    expect(SPECIALISTS.find((w) => w.id === 'security').tools).toEqual(['list_files', 'read_file', 'check']);
    const out = assembleTaskPrompt({ worker: SPECIALISTS[0], task: { id: 't', title: 'Add a screen', kind: 'build' }, job: { request: 'a phone app' }, family: 'small' });
    expect(out.system).toMatch(/You are Mobi, a senior mobile developer/);
    expect(out.budget.used).toBeLessThanOrEqual(out.budget.limit);
  });

  it('only the specialist a job needs joins it', () => {
    const state = { settings: {}, crew: [{ id: 'mel', builtin: true }, { id: 'dev', builtin: true }, ...SPECIALISTS] };
    expect(jobCrew(state, 'backend').map((w) => w.id)).toEqual(['mel', 'dev', 'backend']);
    expect(jobCrew(state, null).map((w) => w.id)).toEqual(['mel', 'dev']);
    expect(jobCrew({ ...state, settings: { crew: ['qa'] } }, 'mobile').map((w) => w.id)).toEqual(['mel', 'mobile']);
  });

  it('a backend job with the brief step off: the specialist leads, the skeleton is there, and a later website job has no specialist', async () => {
    const t = rig({ refine: false });
    await t.hive.createJob({ request: 'create a REST API for a todo list' }).done;
    const dom = eventsOf(t.bus, 'job.domain')[0];
    expect(dom.data).toMatchObject({ domain: 'backend', specialist: 'backend', source: 'keywords' });
    expect(eventsOf(t.bus, 'crew.question')).toEqual([]);
    expect(eventsOf(t.bus, 'job.planned')[0].data.tasks[0].assignee).toBe('backend');
    expect(t.ws.exists('src/server.js') && t.ws.exists('test/api.test.js')).toBe(true);
    const say = t.bus.events.filter((e) => e.type === 'chat.message').map((e) => e.data.text).join('\n');
    expect(say).toMatch(/Backend API: a Node HTTP API .* because the request mentions "rest api"/);
    expect(say).toMatch(/offline backend api skeleton \(\d+ files, tests included\)/i);
    await t.hive.createJob({ request: 'a landing page for my coffee shop' }).done;
    const second = eventsOf(t.bus, 'job.planned')[1].data.tasks;
    expect(second.some((x) => x.assignee === 'backend')).toBe(false);
    expect(eventsOf(t.bus, 'job.domain')[1].data.domain).toBe('web');
  }, 30000);
});
