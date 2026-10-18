// End to end test of the workbench in one headless Edge or Chrome (fresh profile), against a real
// engine with the workbench registered. Manual, like the other e2e scripts (not in vitest):
//   node test/workbench/e2e-workbench.mjs        Env: HIVEDESK_BROWSER, HIVEDESK_E2E_SHOTS (a folder for screenshots)
// Covers: explorer create, rename and delete; tabs, a split, quick open; search and replace;
// problems from the TypeScript worker across files; go to definition into another file; a real
// terminal; the source control panel (stage, commit); settings; responsive at 1024 px.

import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';
import { startHive } from '../../src/index.js';
import { createFakeBrain } from '../../src/brain/fake.js';
import registerWorkbench from '../../src/workbench/index.js';

const temps = [];
const temp = (n) => { const d = fs.mkdtempSync(path.join(tmpdir(), `hivedesk-wb-e2e-${n}-`)); temps.push(d); return d; };
let failed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
  if (!ok) failed++;
}
const exe = [process.env.HIVEDESK_BROWSER, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', '/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => p && fs.existsSync(p));
const shots = process.env.HIVEDESK_E2E_SHOTS || '';
const shot = async (p, name) => { if (shots) await p.screenshot({ path: path.join(shots, `${name}.png`) }); };

let app = null;
let wb = null;
let ctx = null;
let page = null;

async function main() {
  if (!exe) throw new Error('No Edge or Chrome found. Set HIVEDESK_BROWSER.');
  const home = temp('home');
  app = await startHive({ dir: temp('dir'), home, brain: createFakeBrain({ respond: () => 'x' }), city: false, memoryHome: null });
  wb = registerWorkbench({ bus: app.bus, toolbox: app.toolbox, approvals: app.approvals, server: { command: app.server.command, route: app.server.route }, config: { home } });
  const ws = app.paths.workspace;
  const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true }); fs.writeFileSync(path.join(ws, rel), text); };
  put('src/math.ts', 'export function add(a: number, b: number): number {\n  return a + b;\n}\n\nexport const PI = 3.14159;\n');
  put('src/main.ts', "import { add, PI } from './math';\n\nconst total: number = add(2, 3);\nconst wrong: string = add(1, 1);\nconsole.log(total, wrong, PI);\n");
  put('index.html', '<!doctype html>\n<title>Demo</title>\n<p>hello world</p>\n');
  put('README.md', '# Demo\n\nSay hello.\n');
  const git = (...a) => execFileSync('git', a, { cwd: ws, windowsHide: true, encoding: 'utf8' });
  git('init', '-q'); git('symbolic-ref', 'HEAD', 'refs/heads/main'); git('config', 'user.name', 'Test Bee'); git('config', 'user.email', 'bee@example.invalid');
  git('add', '-A'); git('commit', '-qm', 'Start');

  ctx = await chromium.launchPersistentContext(temp('profile'), { executablePath: exe, headless: true, args: ['--no-first-run', '--no-default-browser-check'], viewport: { width: 1440, height: 900 }, locale: 'en-US' });
  const p = ctx.pages()[0] || (await ctx.newPage());
  page = p;
  await p.addInitScript(() => { try { localStorage.setItem('hivedesk.tour.v1', 'done'); localStorage.setItem('hivedesk.lang', 'en'); localStorage.setItem('hivedesk.view.v2', 'desktop'); } catch { /* fine */ } });
  const errors = [];
  p.on('pageerror', (e) => { errors.push(e.message); console.log(`[page error] ${e.message}`); });
  p.on('console', (m) => { if (m.type() === 'error') console.log(`[console] ${m.text()}`); });
  const outside = [];
  p.on('request', (r) => !r.url().startsWith(app.url.split('/?')[0]) && !/^(blob|data):/.test(r.url()) && outside.push(r.url()));
  await p.goto(app.url, { waitUntil: 'commit', timeout: 60000 });
  await p.waitForFunction(() => window.hivedeskEditor && document.querySelector('.dock-shelf') && document.querySelector('.win'), null, { timeout: 60000 });
  await p.waitForTimeout(800);
  await p.evaluate(() => window.hivedeskEditor.open());
  await p.waitForSelector('.wb-root .wb-groups', { timeout: Number(process.env.WB_WAIT) || 120000 }).catch(async (err) => {
    console.log('[editor window]', await p.evaluate(async () => { const wm = await import('/js/wm.js'); const w = wm.get('editor'); return JSON.stringify({ connected: w?.el.isConnected, parent: w?.el.parentElement?.className, min: w?.min, body: w?.body.innerHTML.slice(0, 600) }); }));
    await shot(p, 'fail');
    throw err;
  });
  await p.evaluate(() => { const w = document.querySelector('.win[data-type="editor"]'); w?.querySelector('.win-ctl .mx')?.click(); });
  await p.waitForSelector('.wb-tree .wb-row', { timeout: 30000 });
  check('the workbench mounts with the explorer of the workspace', (await p.locator('.wb-tree .wb-row').count()) >= 3);

  // Open a file from the explorer, then the TypeScript problem across files.
  await p.locator('.wb-tree .wb-row', { hasText: 'src' }).first().click();
  await p.locator('.wb-tree .wb-row', { hasText: 'main.ts' }).first().dblclick();
  await p.waitForFunction(() => window.hivedeskEditor.api?.editor?.getModel()?.getValue().includes('wrong'), null, { timeout: 60000 });
  const problem = await p.waitForFunction(() => window.monaco.editor.getModelMarkers({}).find((m) => /not assignable to type 'string'/.test(m.message)), null, { timeout: 90000 }).then((h) => h.jsonValue(), () => null);
  check('the TypeScript worker reports a type error that needs the other file', !!problem, problem?.message || '');
  await p.keyboard.press('Control+Shift+M');
  await p.waitForSelector('.wb-pr-it.is-error', { timeout: 10000 });
  check('the problems panel lists it', (await p.locator('.wb-pr-it.is-error').count()) >= 1);
  await shot(p, 'workbench-problems');

  // Go to definition crosses into math.ts.
  await p.evaluate(() => { const ed = window.hivedeskEditor.api.editor; ed.focus(); ed.setPosition({ lineNumber: 3, column: 24 }); ed.trigger('e2e', 'editor.action.revealDefinition', null); });
  const def = await p.waitForFunction(() => window.hivedeskEditor.api.editor?.getModel()?.uri.path.endsWith('/src/math.ts'), null, { timeout: 20000 }).then(() => true, () => false);
  check('go to definition opens the other file', def);

  // Split and quick open.
  await p.keyboard.press('Control+\\');
  await p.waitForFunction(() => document.querySelectorAll('.wb-group').length === 2, null, { timeout: 5000 });
  await p.keyboard.press('Control+P');
  await p.keyboard.type('readme');
  await p.waitForSelector('.wb-quick-it', { timeout: 5000 });
  await p.keyboard.press('Enter');
  await p.waitForFunction(() => window.hivedeskEditor.api.editor?.getModel()?.uri.path.endsWith('/README.md'), null, { timeout: 15000 });
  check('a split shows two groups and quick open opens a file in the active one', (await p.locator('.wb-group').count()) === 2);
  await shot(p, 'workbench-split');

  // Explorer: new file, rename, delete.
  await p.evaluate(() => window.hivedeskEditor.api.run('wb.view.explorer'));
  await p.evaluate(() => window.hivedeskEditor.api.run('wb.newFile'));
  await p.waitForSelector('.hd-dlg .wb-input', { timeout: 5000 });
  await p.keyboard.type('notes/todo.txt');
  await p.keyboard.press('Enter');
  const created = await waitFor(() => fs.existsSync(path.join(ws, 'notes/todo.txt')));
  check('new file creates the file and its folder', created);
  await p.locator('.wb-tree .wb-row', { hasText: 'todo.txt' }).first().click({ button: 'right' });
  await p.locator('.wb-menu-it', { hasText: 'Rename' }).click();
  await p.waitForSelector('.hd-dlg .wb-input', { timeout: 5000 });
  await p.keyboard.press('Control+A');
  await p.keyboard.type('done.txt');
  await p.keyboard.press('Enter');
  check('rename moves the file', await waitFor(() => fs.existsSync(path.join(ws, 'notes/done.txt')) && !fs.existsSync(path.join(ws, 'notes/todo.txt'))));
  await p.locator('.wb-tree .wb-row', { hasText: 'notes' }).first().click({ button: 'right' });
  await p.locator('.wb-menu-it', { hasText: 'Delete' }).click();
  await p.waitForSelector('.hd-dlg .wb-dlg-warn', { timeout: 5000 });
  await p.locator('.hd-dlg .wb-btn.is-danger').click();
  check('delete of a folder asks with the count and removes it', await waitFor(() => !fs.existsSync(path.join(ws, 'notes'))));

  // Search and replace.
  if (process.env.WB_DEBUG) console.log('[before search]', await p.evaluate(() => document.activeElement.tagName + ' ' + document.activeElement.className));
  await p.keyboard.press('Control+Shift+F');
  if (process.env.WB_DEBUG) console.log('[after search]', await p.evaluate(() => document.querySelector('.wb-side-t').textContent + ' ' + document.activeElement.tagName + ' ' + document.activeElement.className));
  await p.keyboard.type('hello');
  await p.waitForSelector('.wb-se-hit', { timeout: 15000 });
  check('search finds hits in two files', (await p.locator('.wb-se-file').count()) === 2);
  await p.locator('.wb-se-r .wb-input').fill('howdy');
  await p.locator('.wb-se-r .wb-btn').click();
  await p.waitForSelector('.wb-se-change', { timeout: 15000 });
  await shot(p, 'workbench-replace');
  await p.locator('.wb-se-sum .wb-btn.is-primary').click();
  await p.locator('.hd-dlg .wb-btn.is-primary').click();
  const live = await p.waitForFunction(() => window.monaco.editor.getModels().some((m) => m.uri.path.endsWith('/README.md') && m.getValue().includes('howdy')), null, { timeout: 10000 }).then(() => true, () => false);
  check('the open README tab shows the replaced text', live);
  check('replace writes both files', await waitFor(() => fs.readFileSync(path.join(ws, 'README.md'), 'utf8').includes('howdy') && fs.readFileSync(path.join(ws, 'index.html'), 'utf8').includes('howdy')));

  // Source control: the two changed files, stage and commit.
  await p.keyboard.press('Control+Shift+G');
  await p.waitForSelector('.wb-scm-file', { timeout: 15000 });
  const listed = await p.waitForFunction(() => document.querySelectorAll('.wb-scm-file').length >= 2, null, { timeout: 10000 }).then(() => true, () => false);
  check('source control lists the changes', listed);
  await p.locator('.wb-scm-file', { hasText: 'README.md' }).first().click();
  await p.waitForSelector('.wb-diff .monaco-diff-editor', { timeout: 15000 });
  await shot(p, 'workbench-scm');
  await p.locator('.wb-scm-sec-h .wb-link', { hasText: 'Stage all' }).click();
  await p.waitForSelector('.wb-scm-sec-h:has-text("Staged")', { timeout: 10000 });
  await p.locator('.wb-commit-msg').fill('Say howdy');
  await p.keyboard.press('Control+Enter');
  check('commit from the panel', await waitFor(() => execFileSync('git', ['log', '-1', '--format=%s'], { cwd: ws, encoding: 'utf8' }).trim() === 'Say howdy'));

  // Terminal.
  await p.keyboard.press('Control+J');
  await p.evaluate(() => window.hivedeskEditor.api.run('wb.terminal'));
  await p.waitForSelector('.wb-term-view .xterm', { timeout: 30000 });
  await p.waitForTimeout(2500);
  await p.locator('.wb-term-view:not([hidden]) .xterm').click();
  await p.keyboard.type('echo wb-e2e-term');
  await p.keyboard.press('Enter');
  const termOk = await p.waitForFunction(() => [...document.querySelectorAll('.wb-term-view:not([hidden]) .xterm-rows > div')].some((r) => r.textContent.trim() === 'wb-e2e-term'), null, { timeout: 20000 }).then(() => true, () => false);
  check('the terminal runs a command', termOk);
  await shot(p, 'workbench-terminal');

  // Settings.
  await p.keyboard.press('Control+,');
  await p.waitForSelector('.wb-settings .wb-set-row', { timeout: 10000 });
  await shot(p, 'workbench-settings');
  check('settings open as a tab', (await p.locator('.wb-set-row').count()) > 10);

  // Responsive at 1024 px.
  await p.setViewportSize({ width: 1024, height: 700 });
  await p.waitForTimeout(600);
  const overflow = await p.evaluate(() => { const r = document.querySelector('.wb-root'); return r.scrollWidth - r.clientWidth; });
  check('no horizontal overflow at 1024 px', overflow <= 1, `${overflow}px`);
  await shot(p, 'workbench-1024');

  check('nothing loads from outside this hivedesk', outside.length === 0, outside.slice(0, 3).join(' '));
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
}

async function waitFor(fn, ms = 15000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try { if (fn()) return true; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

try {
  await main();
} catch (err) {
  failed++;
  console.log(`FAIL ${err.stack || err.message}`);
  if (page) await shot(page, 'fail').catch(() => {});
  if (page && process.env.WB_DEBUG) console.log(await page.evaluate(() => { const out = []; for (let el = document.querySelector('.wb-root'); el; el = el.parentElement) out.push(`${el.tagName}.${String(el.className).slice(0, 30)} ${el.scrollLeft},${el.scrollTop}`); const a = document.activeElement; return out.join(' | ') + ' | active: ' + a?.tagName + '.' + a?.className; }).catch((e) => e.message));
} finally {
  await ctx?.close().catch(() => {});
  await wb?.close().catch(() => {});
  await app?.close().catch(() => {});
  for (const d of temps) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* busy */ } }
}
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
