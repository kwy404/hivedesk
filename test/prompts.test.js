import { describe, it, expect } from 'vitest';
import { assembleTaskPrompt, modelFamily, rankFiles, projectMap, numbered, estimateTokens, PROMPT_VERSION } from '../src/crew/prompts/index.js';
import { BUILTIN } from '../src/crew/workers.js';

const crew = Object.fromEntries(BUILTIN.map((w) => [w.id, w]));
const page = '<!doctype html>\n<html lang="en">\n<head><title>Bean There</title></head>\n<body>\n<h1>Bean There</h1>\n</body>\n</html>';
const fileText = { 'index.html': page, 'style.css': 'body { margin: 0; }\n', 'app.js': 'export const add = (a, b) => a + b;\n', 'README.md': '# Bean There\n' };
const files = Object.entries(fileText).map(([path, t]) => ({ path, bytes: t.length }));
const readFile = (p) => fileText[p] || '';
const brief = 'Goal: A page for a coffee stand.\n\nBuild:\n- index.html: menu and hours\n\nAcceptance criteria:\n- [ ] index.html lists three drinks\n- [ ] the page works at 375 px';

/** Five representative jobs: build a page, style it, fix QA findings, review, docs by a hired worker. */
const JOBS = {
  'dev builds a page (small local model)': { worker: crew.dev, task: { id: 't1', title: 'Build index.html', detail: 'The menu and the hours.', kind: 'build' }, job: { request: 'coffee page', brief, acceptance: ['index.html lists three drinks', 'the page works at 375 px'] }, family: 'small', files: [] },
  'designer styles an existing page': { worker: crew.designer, task: { id: 't2', title: 'Style the page in style.css', detail: 'Warm colors.', kind: 'build' }, job: { request: 'coffee page', brief }, family: 'small', files, recent: ['index.html'] },
  'dev fixes QA findings (local 7B)': { worker: crew.dev, task: { id: 't3', title: 'Fix the QA issues (round 1)', detail: 'index.html: only two drinks. Fix: add a third.', kind: 'fix' }, job: { request: 'coffee page', brief }, family: 'local', files, recent: ['index.html', 'style.css'], memories: ['The user prefers dark colors.'] },
  'QA reviews against the criteria (cloud)': { worker: crew.qa, task: { id: 't4', title: 'Check the work', detail: '', kind: 'qa' }, job: { request: 'coffee page', brief, acceptance: ['index.html lists three drinks'] }, family: 'cloud', files, extra: 'Automatic checks: all passed (4 files)' },
  'a hired worker writes docs': { worker: { id: 'w_1', name: 'Ana', role: 'SEO writer', prompt: 'You are Ana, you write meta descriptions.', tools: ['list_files', 'read_file', 'edit_file'], builtin: false }, task: { id: 't5', title: 'Add a meta description to index.html', detail: '', kind: 'docs' }, job: { request: 'better SEO for the coffee page' }, family: 'small', files }
};

describe('prompt assembly', () => {
  for (const [name, input] of Object.entries(JOBS)) {
    it(`golden: ${name}`, () => {
      const out = assembleTaskPrompt({ readFile, ...input });
      expect(out.system).toMatch(/^<role>[\s\S]*<\/role>\n\n<tools>[\s\S]*<\/tools>\n\n<rules>[\s\S]*<\/rules>\n\n<process>[\s\S]*<\/process>\n\n<output>[\s\S]*<\/output>$/);
      expect(out.user).toMatch(/^<objective>[\s\S]*<\/objective>\n\n<context>[\s\S]*<\/context>/);
      expect(out.budget.used).toBeLessThanOrEqual(out.budget.limit);
      expect(`${out.system}\n${out.user}`).not.toMatch(/sk-|api[_ ]?key/i);
      expect({ version: PROMPT_VERSION, system: out.system, user: out.user, budget: out.budget }).toMatchSnapshot();
    });
  }

  it('lists only the tools of the role, with example calls', () => {
    const qa = assembleTaskPrompt({ readFile, ...JOBS['QA reviews against the criteria (cloud)'] });
    expect(qa.system).toContain('- report {passed, findings}');
    expect(qa.system).not.toContain('- write_file');
    expect(qa.system).toContain('Example calls:');
    const dev = assembleTaskPrompt({ readFile, ...JOBS['dev builds a page (small local model)'] });
    expect(dev.system).toContain('- write_file {path, content}');
    expect((dev.system.match(/"tool":/g) || []).length).toBe(3); // one example (small model) plus the two in <output>
  });

  it('shows the file being changed with line numbers', () => {
    const out = assembleTaskPrompt({ readFile, ...JOBS['dev fixes QA findings (local 7B)'] });
    expect(out.user).toContain('File index.html (being changed):\n  1| <!doctype html>');
    expect(out.user).toContain('What we know (memory):\n- The user prefers dark colors.');
  });

  it('trims by priority: the map goes first, the criteria never', () => {
    const big = { ...fileText, 'index.html': page + '\n<p>menu item</p>'.repeat(400) };
    const bigFiles = Object.entries(big).map(([path, t]) => ({ path, bytes: t.length }));
    const out = assembleTaskPrompt({
      ...JOBS['dev fixes QA findings (local 7B)'], files: bigFiles, readFile: (p) => big[p] || '',
      memories: Array.from({ length: 60 }, (_, i) => `memory number ${i} with some words to make it long enough to matter`),
      contextTokens: 2600, replyTokens: 600
    });
    expect(out.budget.used).toBeLessThanOrEqual(out.budget.limit);
    expect(out.budget.trimmed).toContain('map');
    expect(out.budget.trimmed).toContain('memories');
    expect(out.budget.trimmed.indexOf('editing')).toBe(-1);
    expect(out.user).toContain('the page works at 375 px');
  });

  it('ranks files by name, recency and keywords', () => {
    const r = rankFiles(files, { text: 'Style the page in style.css', recent: ['index.html'] });
    expect(r[0].path).toBe('style.css');
    expect(r.map((f) => f.path)).toContain('index.html');
  });

  it('knows the model families', () => {
    expect(modelFamily({ backend: 'local', model: 'Qwen2.5-Coder 3B Instruct (Q4_K_M)' })).toBe('small');
    expect(modelFamily({ backend: 'local', model: 'Qwen2.5-Coder 7B Instruct (Q4_K_M)' })).toBe('local');
    expect(modelFamily({ backend: 'ollama', model: 'qwen2.5-coder:1.5b' })).toBe('small');
    expect(modelFamily({ backend: 'gemini', model: 'any' })).toBe('cloud');
  });

  it('builds a project map and numbered excerpts', () => {
    expect(projectMap([{ path: 'css/a.css', bytes: 10 }, { path: 'index.html', bytes: 5 }])).toBe('css/ (1 files, 10 B)\ncss/a.css (10 B)\nindex.html (5 B)');
    expect(numbered('a\nb', 100)).toBe('  1| a\n  2| b');
    expect(numbered('x'.repeat(50) + '\n' + 'y'.repeat(50), 60)).toContain('more lines');
    expect(estimateTokens('abcdefg')).toBe(2);
  });
});

describe('prompt budget edge cases', () => {
  it('always ends, even when the fixed parts nearly fill the window', () => {
    for (const ctx of [700, 900, 1100, 1300, 1600, 2000]) {
      const out = assembleTaskPrompt({ readFile: () => 'x'.repeat(9000), ...JOBS['QA reviews against the criteria (cloud)'], family: 'small', contextTokens: ctx, replyTokens: 100, extra: 'y'.repeat(9000) });
      expect(out.user).toContain('<objective>');
    }
  });
});
