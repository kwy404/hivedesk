import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { startBench, fakeClient } from './harness.js';
import { buildRegex, findInText, replaceInText } from '../../src/workbench/match.js';
import { globMatcher, parseGitignore } from '../../src/workbench/glob.js';
import { walkFiles } from '../../src/workbench/walk.js';
import { tmpDir } from '../helpers.js';

describe('globs and ignore rules', () => {
  it('matches names at any depth and anchored paths from the root', () => {
    const m = globMatcher(['*.log', 'dist/', 'src/**/*.test.js', '{a,b}.txt']);
    expect(m('x.log')).toBe(true);
    expect(m('deep/inside/x.log')).toBe(true);
    expect(m('dist/app.js')).toBe(true);
    expect(m('src/a/b/c.test.js')).toBe(true);
    expect(m('src/c.test.js')).toBe(true);
    expect(m('lib/c.test.js')).toBe(false);
    expect(m('b.txt')).toBe(true);
    expect(m('c.txt')).toBe(false);
    expect(globMatcher([])).toBe(null);
  });

  it('reads the basics of .gitignore, with negation and folder rules', () => {
    const ig = parseGitignore('# comment\n\nbuild/\n*.tmp\n!keep.tmp\n/root-only.txt\n');
    expect(ig('build', true)).toBe(true);
    expect(ig('build', false)).toBe(false);
    expect(ig('a/b.tmp', false)).toBe(true);
    expect(ig('keep.tmp', false)).toBe(false);
    expect(ig('root-only.txt', false)).toBe(true);
    expect(ig('sub/root-only.txt', false)).toBe(false);
  });

  it('walks without node_modules, .git, ignored files or symlinks', () => {
    const d = tmpDir('hivedesk-walk-');
    const put = (rel, text = 'x') => { fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true }); fs.writeFileSync(path.join(d, rel), text); };
    put('a.js'); put('node_modules/p/i.js'); put('.git/config'); put('out/x.js'); put('.gitignore', 'out/\n'); put('sub/.gitignore', '*.md\n'); put('sub/r.md'); put('sub/k.js');
    try { fs.symlinkSync(path.join(d, 'sub'), path.join(d, 'link'), 'junction'); } catch { /* no links here */ }
    const r = walkFiles(d);
    expect(r.files.map((f) => f.rel).sort()).toEqual(['.gitignore', 'a.js', 'sub/.gitignore', 'sub/k.js']);
  });
});

describe('matching', () => {
  it('finds literal, case, whole word and regex matches per line', () => {
    const text = 'const foo = 1;\nFoo(foo_bar);\r\nfoofoo\n';
    expect(findInText(text, buildRegex({ query: 'foo' })).map((h) => `${h.line}:${h.col}`)).toEqual(['1:7', '2:1', '2:5', '3:1', '3:4']);
    expect(findInText(text, buildRegex({ query: 'foo', caseSensitive: true })).length).toBe(4);
    expect(findInText(text, buildRegex({ query: 'foo', wholeWord: true })).map((h) => `${h.line}:${h.col}`)).toEqual(['1:7', '2:1']);
    expect(findInText(text, buildRegex({ query: 'f(o+)', regex: true })).length).toBe(5);
    expect(() => buildRegex({ query: '(', regex: true })).toThrow(/not valid/);
    expect(() => buildRegex({ query: '' })).toThrow(/empty/);
  });

  it('replaces with groups for a regex and literally otherwise, keeping line ends', () => {
    const text = 'a1 a2\r\nb a3\n';
    const r = replaceInText(text, buildRegex({ query: 'a(\\d)', regex: true }), 'x$1$$', { regex: true });
    expect(r.after).toBe('x1$ x2$\r\nb x3$\n');
    expect(r.count).toBe(3);
    expect(r.changes).toEqual([{ line: 1, before: 'a1 a2', after: 'x1$ x2$' }, { line: 2, before: 'b a3', after: 'b x3$' }]);
    expect(replaceInText('a.b', buildRegex({ query: 'a.b' }), '$1', {}).after).toBe('$1');
    expect(replaceInText('k=v', buildRegex({ query: '(?<k>\\w)=(?<v>\\w)', regex: true }), '$<v>=$<k>', { regex: true }).after).toBe('v=k');
  });
});

describe('search and replace across files', () => {
  let b;
  beforeAll(async () => {
    b = await startBench();
    b.write('src/one.js', 'export function hello() {\n  return "hello";\n}\n');
    b.write('src/two.js', 'import { hello } from "./one.js";\nhello();\n');
    b.write('docs/readme.md', 'Say hello.\n');
    b.write('node_modules/x/index.js', 'hello hello hello\n');
    b.write('.gitignore', 'dist/\n');
    b.write('dist/bundle.js', 'hello\n');
  });
  afterAll(async () => { await b.close(); });

  it('searches with the ignore rules and streams results to the window that asked', async () => {
    const r = await b.run('wb.search', { query: 'hello', wait: true });
    expect(r.results.map((x) => x.path).sort()).toEqual(['docs/readme.md', 'src/one.js', 'src/two.js']);
    expect(r.hits).toBe(5);
    const inc = await b.run('wb.search', { query: 'hello', include: 'src/**', exclude: ['two.js'], wait: true });
    expect(inc.results.map((x) => x.path)).toEqual(['src/one.js']);
    const c = fakeClient('s1');
    const { searchId } = await b.run('wb.search', { query: 'HELLO', caseSensitive: true }, c);
    const start = Date.now();
    while (!c.of('search.done').length && Date.now() - start < 10000) await new Promise((res) => setTimeout(res, 20));
    expect(c.of('search.done')[0]).toMatchObject({ searchId, hits: 0 });
    // The frames have their own kind, so Code together never relays them to guests.
    expect(c.frames.every((f) => f.kind === 'wb')).toBe(true);
  });

  it('caps the hits and stops a regular expression that runs too long', async () => {
    b.write('many.txt', 'x\n'.repeat(6000));
    const capped = await b.run('wb.search', { query: 'x', wait: true, maxHits: 50 });
    expect(capped).toMatchObject({ hits: 50, truncated: true });
    const full = await b.run('wb.search', { query: 'x', include: 'many.txt', wait: true });
    expect(full).toMatchObject({ hits: 5000, truncated: true });
    b.write('evil.txt', `${'a'.repeat(32)}!\n`);
    const started = Date.now();
    const slow = await b.wb.searcher.search(b.wb.getRoot('ws'), { query: '(a+)+$', regex: true, include: ['evil.txt'] }, { timeoutMs: 400 });
    expect(slow.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
    // The pool still works after a worker was terminated.
    expect((await b.run('wb.search', { query: 'Say', wait: true })).hits).toBe(1);
  });

  it('previews a replace, applies it through the tools and skips files changed since', async () => {
    const pv = await b.run('wb.replace.preview', { query: 'hello', replace: 'greet', include: 'src/**' });
    expect(pv.files.map((f) => `${f.path}:${f.count}`)).toEqual(['src/one.js:2', 'src/two.js:2']);
    expect(pv.files[0].changes[0]).toEqual({ line: 1, before: 'export function hello() {', after: 'export function greet() {' });
    expect(fs.readFileSync(path.join(b.ws, 'src/one.js'), 'utf8')).toContain('hello'); // nothing written yet
    b.write('src/two.js', 'hello(); // changed by hand\n');
    const before = b.app.bus.seq;
    const r = await b.run('wb.replace.apply', { previewId: pv.previewId });
    expect(r.files).toEqual([{ path: 'src/one.js', count: 2 }]);
    expect(r.skipped).toEqual([{ path: 'src/two.js', reason: 'changed since the preview' }]);
    expect(fs.readFileSync(path.join(b.ws, 'src/one.js'), 'utf8')).toBe('export function greet() {\n  return "greet";\n}\n');
    expect(b.app.bus.since(before).some((e) => e.type === 'file.changed' && e.data.path === 'src/one.js')).toBe(true);
    await expect(b.run('wb.replace.apply', { previewId: pv.previewId })).rejects.toMatchObject({ code: 'not_found' });
  });
});
