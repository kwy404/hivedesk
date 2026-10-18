import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHECKS, runChecks, contrastRatio, parseColor, jsSyntax } from '../../src/crew/library/checks.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Broken scripts are kept as .txt so the project lint does not trip on them; the runner sees their real names.
const fixture = (dir) => fs.readdirSync(path.join(HERE, 'fixtures', dir)).map((f) => ({ path: f.replace(/\.txt$/, ''), text: fs.readFileSync(path.join(HERE, 'fixtures', dir, f), 'utf8') }));
const good = fixture('good');
const broken = fixture('broken');
const ALL = Object.keys(CHECKS);
const status = (r, id) => r.results.find((x) => x.id === id)?.status;

describe('the checks runner', () => {
  it('every check has a level, the file types it reads and a description', () => {
    for (const [id, c] of Object.entries(CHECKS)) {
      expect(id).toMatch(/^[a-z]+\.[a-z0-9-]+$/);
      expect(['error', 'warn']).toContain(c.level);
      expect(Array.isArray(c.types)).toBe(true);
      expect(c.describe.length).toBeGreaterThan(5);
    }
  });

  it('a good page, stylesheet, script, CLI, JSON and Python file pass the error checks', () => {
    const r = runChecks(ALL.filter((id) => !['file.readme', 'file.test', 'html.nav', 'html.dialog-a11y', 'html.tabs-a11y', 'md.changelog', 'html.og-tags', 'node.http-status', 'node.json-content-type', 'node.body-limit',
      // Domain checks need a project of that kind (test/domains/skeletons.test.js runs them on the skeletons).
      'pwa.manifest', 'pwa.service-worker', 'capacitor.config', 'neu.config', 'ext.manifest-v3', 'game.loop', 'node.test-runner', 'sec.csp'].includes(id)), { files: good });
    expect(r.issues).toEqual([]);
    expect(r.passed).toBe(true);
  });

  it('catches the broken HTML fixture', () => {
    const r = runChecks(['html.doctype', 'html.lang', 'html.title', 'html.viewport', 'html.h1', 'html.heading-order', 'html.main', 'html.img-alt', 'html.labels', 'html.no-inline-handlers', 'html.unique-ids', 'html.external-rel', 'html.link-text', 'html.table-headers', 'html.form-submit', 'html.balanced', 'text.no-placeholder', 'js.syntax'], { files: broken.filter((f) => f.path === 'index.html') });
    expect(r.passed).toBe(false);
    for (const id of ['html.lang', 'html.title', 'html.viewport', 'html.h1', 'html.main', 'html.img-alt', 'html.labels', 'html.no-inline-handlers', 'html.unique-ids', 'html.external-rel', 'html.link-text', 'html.table-headers', 'html.form-submit', 'html.balanced', 'text.no-placeholder', 'js.syntax']) {
      expect(status(r, id), id).toBe('fail');
    }
    expect(status(r, 'html.doctype')).toBe('pass');
    expect(status(r, 'html.heading-order')).toBe('fail');
    expect(r.notes.some((n) => n.startsWith('[html.heading-order]'))).toBe(true);
    expect(r.issues.some((i) => /\[html\.h1\] index\.html: 2 <h1>/.test(i))).toBe(true);
  });

  it('catches the broken JavaScript, module, JSON and Python fixtures', () => {
    const r = runChecks(['js.syntax', 'js.safe-dom', 'js.json-parse-guarded', 'js.storage-guarded', 'json.valid', 'py.no-bare-except', 'py.balanced'], { files: broken.filter((f) => f.path !== 'index.html') });
    const syntax = r.results.find((x) => x.id === 'js.syntax');
    expect(syntax.issues.some((i) => i.startsWith('app.js: syntax error'))).toBe(true);
    expect(syntax.issues.some((i) => i.startsWith('module.mjs: syntax error'))).toBe(true);
    for (const id of ['js.safe-dom', 'js.json-parse-guarded', 'js.storage-guarded', 'json.valid', 'py.no-bare-except', 'py.balanced']) expect(status(r, id), id).toBe('fail');
  });

  it('catches CSS problems: braces, contrast, missing focus, motion without reduced motion', () => {
    const css = broken.filter((f) => f.path === 'style.css');
    const r = runChecks(['css.braces', 'css.contrast', 'css.focus-visible', 'css.reduced-motion', 'css.media-query', 'css.no-fixed-width', 'css.min-font-size'], { files: css });
    for (const id of ['css.braces', 'css.focus-visible', 'css.reduced-motion', 'css.media-query']) expect(status(r, id), id).toBe('fail');
    expect(r.issues.find((i) => i.startsWith('[css.contrast]'))).toMatch(/2\.\d\d to 1/);
    expect(r.notes.some((n) => n.startsWith('[css.no-fixed-width]'))).toBe(true);
    expect(r.notes.some((n) => n.startsWith('[css.min-font-size]'))).toBe(true);
  });

  it('skips checks with no file of their type and reports unknown ids as skipped', () => {
    const r = runChecks(['py.no-bare-except', 'nope.check'], { files: good.filter((f) => f.path.endsWith('.html')) });
    expect(r.results.map((x) => x.status)).toEqual(['skip', 'skip']);
    expect(r.passed).toBe(true);
  });

  it('workspace level checks: README and tests', () => {
    expect(runChecks(['file.readme', 'file.test'], { files: good }).issues).toHaveLength(2);
    expect(runChecks(['file.readme', 'file.test'], { files: [{ path: 'README.md', text: '# x' }, { path: 'test.mjs', text: 'import assert from "node:assert";' }] }).passed).toBe(true);
  });

  it('contrast math matches WCAG reference values', () => {
    expect(contrastRatio(parseColor('#000'), parseColor('#fff'))).toBeCloseTo(21, 1);
    expect(contrastRatio(parseColor('#767676'), parseColor('white'))).toBeCloseTo(4.54, 1);
    expect(parseColor('rgb(10 20 30 / 50%)')).toEqual({ r: 10, g: 20, b: 30, a: 0.5 });
    expect(parseColor('nonsense')).toBe(null);
  });

  it('parses classic scripts without starting a process and modules with node --check', () => {
    expect(jsSyntax('a.js', 'const a = 1;')).toEqual([]);
    expect(jsSyntax('a.js', 'const a = ;')[0]).toMatch(/^a\.js: syntax error/);
    expect(jsSyntax('m.mjs', 'export const a = 1;')).toEqual([]);
    expect(jsSyntax('m.mjs', 'export const a = ;')[0]).toMatch(/^m\.mjs: syntax error/);
  });

  it('runs on a workspace object and limits to the listed files', () => {
    const files = new Map([...broken, ...good.map((f) => ({ ...f, path: `ok/${f.path}` }))].map((f) => [f.path, f.text]));
    const ws = { list: () => [...files.keys()].map((p) => ({ path: p })), read: (p) => files.get(p), exists: (p) => files.has(p) };
    expect(runChecks(['html.lang'], { ws }).passed).toBe(false);
    expect(runChecks(['html.lang'], { ws, only: ['ok/index.html'] }).passed).toBe(true);
  });
});
