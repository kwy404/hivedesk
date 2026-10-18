import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Library, getLibrary, playbookSection, roleOf, estimateTokens, BUILTIN_DIR } from '../../src/crew/library/index.js';
import { selectPlaybooks, terms, rerank, searchLibrary, BUDGET } from '../../src/crew/library/select.js';
import { attachLibrary, pickForTask, swapPlaybook, withPlaybookChecks, playbooksOf, resetLibraryState, cityTestChecks } from '../../src/crew/library/hook.js';
import { assembleTaskPrompt } from '../../src/crew/prompts/index.js';
import { BUILTIN } from '../../src/crew/workers.js';

const crew = Object.fromEntries(BUILTIN.map((w) => [w.id, w]));
const ids = (r) => r.picks.map((p) => p.id);

/**
 * Thirty requests in Portuguese and English: `want` are entry ids (or patterns) that must be among the
 * picks, `not` must not be. Role is the worker that does the task.
 */
export const SAMPLES = [
  { q: 'crie um site para minha padaria', want: ['bakery-site', 'landing-page'], cat: 'web-pages' },
  { q: 'corrige esse erro TypeError', role: 'dev', want: ['bug-fix-from-error'], cat: 'practices' },
  { q: 'make a landing page for my dog walking service', role: 'dev', want: ['landing-page'], cat: 'web-pages' },
  { q: 'site para meu restaurante com cardápio e reservas', role: 'dev', want: ['restaurant-site'], cat: 'web-pages' },
  { q: 'página de preços com três planos', role: 'designer', want: ['pricing-page'], cat: 'web-pages' },
  { q: 'lista de espera para o lançamento do meu app', role: 'dev', want: ['waitlist-page'], cat: 'web-pages' },
  { q: 'make a 404 page', role: 'dev', want: ['not-found-404'], cat: 'web-pages' },
  { q: 'meu portfólio de desenvolvedor', role: 'dev', want: ['portfolio-developer'], cat: 'web-pages' },
  { q: 'loja online de camisetas com carrinho', role: 'dev', want: ['store-catalog'], cat: 'web-pages' },
  { q: 'jogo da cobrinha', role: 'dev', want: [/snake/], cat: 'app-types' },
  { q: 'build a tic tac toe game', role: 'dev', want: [/tic-tac-toe|tictactoe/], cat: 'app-types' },
  { q: 'jogo da memória com cartas', role: 'dev', want: [/memory/], cat: 'app-types' },
  { q: 'a todo list app that saves tasks', role: 'dev', want: [/todo/], cat: 'app-types' },
  { q: 'quadro kanban para minha equipe', role: 'dev', want: [/kanban/], cat: 'app-types' },
  { q: 'calculadora simples', role: 'dev', want: [/calculator/], cat: 'app-types' },
  { q: 'app de orçamento para controlar gastos', role: 'dev', want: [/budget/], cat: 'app-types' },
  { q: 'navbar responsiva com menu hamburguer', role: 'dev', want: [/nav/], cat: 'ui-components' },
  { q: 'a modal dialog for the newsletter signup', role: 'dev', want: [/modal|dialog/], cat: 'ui-components' },
  { q: 'adicione testes unitários para as funções de cálculo', role: 'dev', want: ['add-unit-tests'], cat: 'practices' },
  { q: 'add JSDoc types to utils.js', role: 'dev', want: ['add-jsdoc-types'], cat: 'practices' },
  { q: 'auditoria de acessibilidade da página', role: 'qa', want: ['accessibility-audit'], cat: 'practices' },
  { q: 'adicione modo escuro ao site', role: 'designer', want: ['dark-mode'], cat: 'practices' },
  { q: 'revisão de segurança contra XSS no formulário', role: 'reviewer', want: ['security-review-xss'], cat: 'practices' },
  { q: 'escreva o README do projeto', role: 'writer', want: ['readme-project'], cat: 'git-docs' },
  { q: 'write a commit message for these changes', role: 'writer', want: ['commit-message'], cat: 'git-docs' },
  { q: 'paleta de cores com bom contraste', role: 'designer', want: ['color-palette-aa'], cat: 'design' },
  { q: 'parse a CSV file and show the totals', role: 'dev', want: [/csv/], cat: 'data' },
  { q: 'gráfico de barras em SVG com as vendas do mês', role: 'dev', want: [/bar-chart|svg-bar/], cat: 'data' },
  { q: 'a JSON API with node:http for notes', role: 'dev', want: [/api|http/], cat: 'stacks' },
  { q: 'divida esse pedido em tarefas menores', role: 'mel', want: ['split-into-tasks'], cat: 'planning' }
];

const present = (cat) => fs.existsSync(path.join(BUILTIN_DIR, cat));
const match = (picked, w) => (w instanceof RegExp ? picked.some((id) => w.test(id)) : picked.includes(w));

describe('selection: thirty sample requests in Portuguese and English', () => {
  for (const s of SAMPLES) {
    it.runIf(present(s.cat))(`"${s.q}"${s.role ? ` (${s.role})` : ''}`, () => {
      const r = selectPlaybooks({ request: s.q, role: s.role, family: 'local' });
      const picked = ids(r);
      for (const w of s.want) expect(match(picked, w), `${w} in ${picked.join(', ')} (candidates ${r.candidates.map((c) => `${c.id} ${c.score}`).join(', ')})`).toBe(true);
      for (const n of s.not || []) expect(match(picked, n), `${n} should not be picked`).toBe(false);
      for (const p of r.picks) {
        expect(p.terms.length).toBeGreaterThan(0);
        expect(p.score).toBeGreaterThan(0);
      }
    });
  }

  it('picks nothing for text that matches no entry', () => {
    expect(selectPlaybooks({ request: 'xyzzy plugh qwfp', family: 'small' }).picks).toEqual([]);
  });
});

describe('tokens and terms', () => {
  it('maps Portuguese words and phrases to the library terms', () => {
    expect(terms('padaria')).toContain('padaria');
    const q = selectPlaybooks({ request: 'jogo da velha', family: 'local' }).query;
    expect(q).toContain('tictactoe');
    expect(selectPlaybooks({ request: 'corrige o erro', family: 'local' }).query).toEqual(expect.arrayContaining(['fix', 'error']));
    expect(selectPlaybooks({ request: 'TypeError in app.js', family: 'local' }).query).toEqual(expect.arrayContaining(['typeerror', 'error', 'javascript']));
  });

  it('roles of builtin and hired workers', () => {
    expect(roleOf(crew.qa)).toBe('qa');
    expect(roleOf({ id: 'w_1', role: 'Code reviewer' })).toBe('reviewer');
    expect(roleOf({ id: 'w_2', role: 'SEO writer' })).toBe('writer');
    expect(roleOf({ id: 'w_3', role: 'DevOps engineer' })).toBe('ops');
    expect(roleOf({ id: 'w_4', role: 'Software architect' })).toBe('architect');
    expect(roleOf({ id: 'w_5', role: 'Backend' })).toBe('backend');
    expect(roleOf({ id: 'w_6', role: 'Frontend developer' })).toBe('dev');
  });

  it.runIf(present('design'))('the role changes the ranking: the same words rank design entries higher for a designer', () => {
    const q = 'colors and contrast for the bakery page';
    const score = (role) => selectPlaybooks({ request: q, role, family: 'cloud' }).candidates.find((c) => c.id === 'color-palette-aa')?.score || 0;
    expect(score('designer')).toBeGreaterThan(score('writer'));
    expect(selectPlaybooks({ request: q, role: 'designer', family: 'cloud' }).picks.some((p) => p.category === 'design')).toBe(true);
  });
});

describe('the token budget', () => {
  const requests = SAMPLES.map((s) => s.q);
  for (const family of ['small', 'local', 'cloud']) {
    it(`${family}: the picks fit ${BUDGET[family]} tokens and are 1 to 3`, () => {
      for (const q of requests) {
        const r = selectPlaybooks({ request: q, family });
        expect(r.picks.length).toBeLessThanOrEqual(3);
        expect(r.used).toBeLessThanOrEqual(BUDGET[family]);
        const section = playbookSection(r.picks);
        if (section) expect(estimateTokens(section.text)).toBeLessThanOrEqual(BUDGET[family] + 40);
      }
    });
  }

  it('an explicit budget is respected and a tiny one picks nothing', () => {
    const r = selectPlaybooks({ request: 'crie um site para minha padaria', budget: 400 });
    expect(r.used).toBeLessThanOrEqual(400);
    expect(selectPlaybooks({ request: 'crie um site para minha padaria', budget: 50 }).picks).toEqual([]);
  });

  it('the prompt assembly puts the playbooks in a <playbook> section and stays within the limit', () => {
    const task = { id: 'tb1', title: 'Build index.html for the bakery', detail: 'Menu, hours and contact.', kind: 'build' };
    const job = { request: 'crie um site para minha padaria' };
    const playbooks = selectPlaybooks({ task: task.title, request: job.request, role: 'dev', family: 'small' }).picks;
    const out = assembleTaskPrompt({ worker: crew.dev, task, job, family: 'small', files: [], playbooks });
    expect(out.user).toMatch(/<\/objective>\n\n<playbook>\n[\s\S]*Playbook "Bakery website" \(bakery-site\)[\s\S]*<\/playbook>\n\n<context>/);
    expect(out.budget.playbooks).toContain('bakery-site');
    expect(out.budget.used).toBeLessThanOrEqual(out.budget.limit);
    // A very small context keeps at most about a third of the budget for playbooks.
    const tight = assembleTaskPrompt({ worker: crew.dev, task, job, family: 'small', files: [], playbooks, contextTokens: 2000, replyTokens: 600 });
    expect(tight.budget.sections.playbook || 0).toBeLessThanOrEqual(Math.floor(tight.budget.limit * 0.37));
  });

  it('no playbooks, no section (the golden prompts do not change)', () => {
    const out = assembleTaskPrompt({ worker: crew.dev, task: { id: 'none', title: 'x', kind: 'build' }, job: { request: 'x' }, files: [] });
    expect(out.user).not.toContain('<playbook>');
    expect(out.budget.playbooks).toBeUndefined();
  });
});

describe('re-ranking with the model', () => {
  it('reorders the candidates by the model answer and keeps only known ids', async () => {
    const sel = selectPlaybooks({ request: 'crie um site para minha padaria', family: 'cloud' });
    const second = sel.candidates[1].id;
    const r = await rerank('bakery site', sel, async () => ({ order: [second, 'made-up-id'] }));
    expect(r.reranked).toBe(true);
    expect(r.picks[0].id).toBe(second);
    expect(r.picks.every((p) => getLibrary().get(p.id))).toBe(true);
  });

  it('keeps the keyword order when the model fails', async () => {
    const sel = selectPlaybooks({ request: 'crie um site para minha padaria', family: 'cloud' });
    const r = await rerank('bakery site', sel, async () => { throw new Error('offline'); });
    expect(ids(r)).toEqual(ids(sel));
  });
});

describe('the crew hook', () => {
  function rig() {
    const listeners = new Set();
    const state = { jobs: [{ id: 'j_1', request: 'crie um site para minha padaria', status: 'running' }], tasks: {}, brain: { backend: 'local', model: 'qwen2.5-coder-7b' } };
    const events = [];
    const bus = {
      state, events,
      on: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
      emit(type, data, opts = {}) {
        const e = { type, data, jobId: opts.jobId };
        events.push(e);
        if (type === 'job.planned') for (const t of data.tasks) state.tasks[t.id] = { ...t };
        for (const fn of listeners) fn(e);
        return e;
      }
    };
    const files = new Map([['index.html', '<!doctype html><html><head><title>x</title></head><body><p>hi</p></body></html>']]);
    const ws = { list: () => [...files.keys()].map((p) => ({ path: p })), read: (p) => files.get(p), exists: (p) => files.has(p) };
    const hive = { toolbox: { ws }, crewById: () => new Map(BUILTIN.map((w) => [w.id, w])) };
    const commands = new Map();
    const server = { command: (type, fn) => commands.set(type, fn) };
    resetLibraryState();
    const { off } = attachLibrary({ bus, hive, server, dir: null });
    return { bus, hive, commands, off, files };
  }

  it('picks playbooks for every planned task and logs the scores and matched terms', () => {
    const { bus, off } = rig();
    bus.emit('job.planned', { tasks: [{ id: 't_1', title: 'Build index.html', detail: 'Bakery menu and hours', assignee: 'dev', kind: 'build', status: 'pending' }, { id: 't_2', title: 'Check the work', assignee: 'qa', kind: 'qa', status: 'pending' }] }, { jobId: 'j_1' });
    const sel = bus.events.find((e) => e.type === 'library.selected');
    expect(sel.jobId).toBe('j_1');
    const first = sel.data.tasks.find((t) => t.taskId === 't_1');
    expect(first.picks[0].id).toBe('bakery-site');
    expect(first.picks[0].terms).toContain('bakery');
    expect(first.picks[0].score).toBeGreaterThan(0);
    expect(first.used).toBeLessThanOrEqual(first.budget);
    expect(playbooksOf({ id: 't_1' })[0].id).toBe('bakery-site');
    off();
  });

  it('lets the user swap a playbook while the task is pending, not after it started', () => {
    const { bus, commands, off } = rig();
    bus.emit('job.planned', { tasks: [{ id: 't_9', title: 'Build index.html', detail: 'Bakery', assignee: 'dev', kind: 'build', status: 'pending' }] }, { jobId: 'j_1' });
    const r = commands.get('library.swap')({ jobId: 'j_1', taskId: 't_9', from: 'bakery-site', to: 'cafe-site' });
    expect(r.playbooks.map((p) => p.id)).toContain('cafe-site');
    expect(r.playbooks.map((p) => p.id)).not.toContain('bakery-site');
    expect(playbooksOf({ id: 't_9' }).some((p) => p.id === 'cafe-site' && p.swapped)).toBe(true);
    bus.state.tasks.t_9.status = 'running';
    expect(() => commands.get('library.swap')({ jobId: 'j_1', taskId: 't_9', from: 'cafe-site', to: 'bakery-site' })).toThrow(/started/);
    expect(() => commands.get('library.swap')({ jobId: 'j_1', taskId: 't_9', to: 'no-such-entry' })).toThrow();
    off();
  });

  it('a swap on the brief (before the plan) pins and blocks entries for the whole job', () => {
    const { bus, commands, off } = rig();
    bus.emit('brief.proposed', { original: 'crie um site para minha padaria', brief: { text: 'Goal: a bakery site' } }, { jobId: 'j_1' });
    const preview = bus.events.find((e) => e.type === 'library.preview');
    expect(preview.data.picks.map((p) => p.id)).toContain('bakery-site');
    commands.get('library.swap')({ jobId: 'j_1', from: 'landing-page', to: 'one-page-scroll-site' });
    bus.emit('job.planned', { tasks: [{ id: 't_5', title: 'Build index.html', detail: 'Bakery', assignee: 'dev', kind: 'build', status: 'pending' }] }, { jobId: 'j_1' });
    const picks = playbooksOf({ id: 't_5' }).map((p) => p.id);
    expect(picks).toContain('one-page-scroll-site');
    expect(picks).not.toContain('landing-page');
    off();
  });

  it('turns the checks of the picked playbooks into QA issues', () => {
    const { bus, hive, off } = rig();
    bus.emit('job.planned', { tasks: [{ id: 't_7', title: 'Build index.html', detail: 'Bakery', assignee: 'dev', kind: 'build', status: 'pending' }] }, { jobId: 'j_1' });
    const merged = hive.playbookChecks({ passed: true, checked: ['index.html'], issues: [] }, [{ id: 't_7', jobId: 'j_1' }]);
    expect(merged.passed).toBe(false);
    expect(merged.issues.some((i) => i.startsWith('[html.viewport]'))).toBe(true);
    expect(merged.issues.some((i) => i.startsWith('[html.lang]'))).toBe(true);
    expect(bus.events.some((e) => e.type === 'library.checks')).toBe(true);
    // A later QA round (after a fix round) only gets them as notes.
    const again = hive.playbookChecks({ passed: true, checked: ['index.html'], issues: [] }, [{ id: 't_7', jobId: 'j_1' }, { id: 't_q', kind: 'qa', status: 'done', jobId: 'j_1' }]);
    expect(again.passed).toBe(true);
    expect(again.notes.some((n) => n.startsWith('[html.viewport]'))).toBe(true);
    const none = withPlaybookChecks({ passed: true, issues: [] }, hive.toolbox.ws, [{ id: 'unknown' }]);
    expect(none).toEqual({ passed: true, issues: [] });
    off();
  });

  it('the Test room runs the checks that fit the city task: testing playbooks fail the hop, the others advise', () => {
    const { hive, off } = rig();
    const audit = cityTestChecks(hive.toolbox.ws, { title: 'Accessibility audit of index.html', files: ['index.html'] });
    expect(audit.passed).toBe(false);
    expect(audit.issues.some((i) => i.startsWith('[html.lang]'))).toBe(true);
    const bakery = cityTestChecks(hive.toolbox.ws, { title: 'Bakery landing page', detail: 'index.html', files: ['index.html'] });
    expect(bakery.passed).toBe(true);
    expect(bakery.notes.some((i) => i.startsWith('[html.viewport]'))).toBe(true);
    expect(cityTestChecks(hive.toolbox.ws, { title: 'Accessibility audit of index.html', files: ['index.html'], loops: 1 }).passed).toBe(true);
    off();
  });

  it('weak picks only advise in QA, and content checks look only at the files the job wrote', () => {
    const { bus, hive, files, off } = rig();
    bus.state.jobs.push({ id: 'j_2', request: 'a page', status: 'running' });
    bus.emit('job.planned', { tasks: [{ id: 't_w', title: 'Write index.html', detail: 'a page', assignee: 'dev', kind: 'build', status: 'pending' }] }, { jobId: 'j_2' });
    const weak = hive.playbookChecks({ passed: true, checked: ['index.html'], issues: [] }, [{ id: 't_w', jobId: 'j_2' }]);
    expect(weak.passed).toBe(true);
    bus.emit('job.planned', { tasks: [{ id: 't_b', title: 'Build the bakery site', detail: 'Bakery menu and hours', assignee: 'dev', kind: 'build', status: 'pending' }] }, { jobId: 'j_1' });
    files.set('about.html', '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>About</title></head><body><main><h1>About</h1></main></body></html>');
    bus.emit('file.changed', { path: 'about.html', op: 'create' }, { jobId: 'j_1' });
    const only = hive.playbookChecks({ passed: true, checked: [], issues: [] }, [{ id: 't_b', jobId: 'j_1' }]);
    expect(only.issues.some((i) => i.includes('index.html'))).toBe(false);
    expect(only.issues.some((i) => i.includes('about.html'))).toBe(true);
    off();
  });

  it('pickForTask uses the worker role', () => {
    const r = pickForTask({ task: { id: 'x', title: 'Pick the colors and type scale', kind: 'build', assignee: 'designer' }, job: { request: 'a bakery site' }, family: 'cloud' });
    expect(r.picks.length).toBeGreaterThan(0);
    expect(r.picks.some((p) => getLibrary().get(p.id).roles.includes('designer'))).toBe(true);
  });

  it('swapPlaybook without a task keeps job overrides', () => {
    const r = swapPlaybook({ jobId: 'j_z', from: 'a', to: 'landing-page' });
    expect(r).toEqual({ pinned: ['landing-page'], blocked: ['a'] });
  });
});

describe('the Library window commands and your own entries', () => {
  it('search, read, favorite, add and remove your own entries in ~/.hivedesk/library', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-lib-'));
    const commands = new Map();
    const bus = { state: { jobs: [], tasks: {}, brain: {} }, on: () => () => {}, emit: () => {} };
    attachLibrary({ bus, hive: null, server: { command: (t, fn) => commands.set(t, fn) }, dir });
    const list = commands.get('library.list')({ q: 'padaria' });
    expect(list.entries[0].id).toBe('bakery-site');
    expect(list.total).toBeGreaterThanOrEqual(50);
    expect(commands.get('library.get')({ id: 'bakery-site' }).entry.prompt).toMatch(/^Goal:/);
    expect(commands.get('library.favorite')({ id: 'bakery-site' }).favorites).toEqual(['bakery-site']);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'favorites.json'), 'utf8'))).toEqual(['bakery-site']);
    expect(commands.get('library.list')({ favorites: true }).entries.map((e) => e.id)).toEqual(['bakery-site']);
    const prompt = `Goal: A gluten free menu section.\nSteps:\n1. ${'List each item with its allergens and price. '.repeat(10)}\nQuality bar:\n- Clear labels.\nPitfalls:\n- Hidden allergens.\nVerify:\n- [ ] Every item has allergens.\nOutput: menu.html`;
    const added = commands.get('library.add')({ entry: { title: 'Gluten free menu', tags: 'gluten free, menu, allergens', when: 'The bakery wants a gluten free menu section.', prompt, roles: ['dev'], checks: ['html.h1'] } });
    expect(added.entry.id).toBe('my-gluten-free-menu');
    expect(added.entry.source).toBe('user');
    expect(fs.existsSync(path.join(dir, 'my-gluten-free-menu.json'))).toBe(true);
    // A fresh library loads it from the folder, and selection can pick it.
    const again = new Library({ userDir: dir });
    expect(again.get('my-gluten-free-menu').source).toBe('user');
    expect(selectPlaybooks({ request: 'gluten free menu', library: again, family: 'cloud' }).picks.map((p) => p.id)).toContain('my-gluten-free-menu');
    expect(() => commands.get('library.add')({ entry: { title: 'x', prompt: 'too short' } })).toThrow(/not valid/);
    expect(() => commands.get('library.remove')({ id: 'bakery-site' })).toThrow(/builtin/);
    expect(commands.get('library.remove')({ id: 'my-gluten-free-menu' })).toEqual({});
    expect(fs.existsSync(path.join(dir, 'my-gluten-free-menu.json'))).toBe(false);
    expect(searchLibrary('', { category: 'web-pages', limit: 5 })).toHaveLength(5);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
