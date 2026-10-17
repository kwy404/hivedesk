// Smoke test of the desktop UI against a live engine in --demo mode, in Edge or Chrome headless
// with a fresh --user-data-dir. Not part of the unit tests.
// Usage: node test/e2e-ui.mjs [screenshot.png]
// Env:   HIVEDESK_BROWSER (path to Edge or Chrome)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { startHive } from '../src/index.js';

const candidates = [
  process.env.HIVEDESK_BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/microsoft-edge',
  '/usr/bin/google-chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
].filter(Boolean);
const browserPath = candidates.find((p) => fs.existsSync(p));
if (!browserPath) {
  console.error('no Edge or Chrome found; set HIVEDESK_BROWSER');
  process.exit(2);
}
const shot = process.argv[2] || path.join(os.tmpdir(), 'hivedesk-ui-smoke.png');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hivedesk-ui-'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hivedesk-edge-'));
const failures = [];
const check = (ok, label) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`); if (!ok) failures.push(label); };

const app = await startHive({ dir, demo: true, demoDelayMs: 150, demoApproveMs: 1500, home: path.join(dir, 'cache') });
const context = await chromium.launchPersistentContext(profile, {
  executablePath: browserPath, headless: true, viewport: { width: 1600, height: 1000 }, args: ['--no-first-run', '--no-default-browser-check']
});
const page = context.pages()[0] || await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message || e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('response', (r) => { if (r.status() >= 400) errors.push(`${r.status()} ${new URL(r.url()).pathname}`); });
try {
  await page.goto(`${app.url}${app.url.includes('?') ? '&' : '?'}view=desktop`, { waitUntil: 'load' }); // the desktop windows, not the City home
  check(await page.title() !== '', `page has a title (${await page.title()})`);
  // The engine pushes hello over the WebSocket; the crew names should appear.
  await page.waitForFunction(() => /Mel/.test(document.body.innerText) && /QA/.test(document.body.innerText), null, { timeout: 15000 });
  check(true, 'the crew is on the desktop');
  check(/demo/i.test(await page.evaluate(() => document.body.innerText)), 'the page says it is a demo');
  // Wait for the scripted job to end in the engine, then for the UI to show it.
  const t0 = Date.now();
  while (app.bus.state.jobs[0]?.status !== 'done' && Date.now() - t0 < 90000) await new Promise((r) => setTimeout(r, 250));
  check(app.bus.state.jobs[0]?.status === 'done', `the demo job finished in the engine (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  await page.waitForTimeout(1500);
  const text = await page.evaluate(() => document.body.innerText);
  check(/index\.html/.test(text), 'the UI lists index.html');
  check(/QA passed|All checks passed|passed/i.test(text), 'the UI shows the QA result');
  await page.waitForFunction(() => /improved prompt/i.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {});
  const text2 = await page.evaluate(() => document.body.innerText);
  check(/improved brief|brief/i.test(text2), 'the brief is shown');
  check(/improved prompt/i.test(text2) && /next prompts/i.test(text2), 'the report shows the improved prompt and next prompts');
  // The preview of the workspace is served sandboxed.
  const preview = await page.evaluate(async () => (await fetch('/preview/')).status);
  check(preview === 200, `the live preview answers (${preview})`);
  // The engine windows added tonight open without errors.
  for (const w of ['memory', 'providers', 'prompts', 'brief']) {
    const ok = await page.evaluate(async (type) => { const wm = await import('/js/wm.js'); wm.open(type); await new Promise((r) => setTimeout(r, 600)); return !!document.querySelector('.win, [data-win], .window'); }, w).catch((e) => String(e));
    check(ok === true, `the ${w} window opens`);
  }
  const text3 = await page.evaluate(() => document.body.innerText);
  check(/memory/i.test(text3) && /providers/i.test(text3), 'the memory and providers windows show their content');
  // Locale files still being written by the language work (i18n/<locale>.json) are not engine errors.
  const pageErrors = errors.filter((e) => !(/i18n\/[a-zA-Z-]+\.json/.test(e) || /status of 404/.test(e)) || /\/api\//.test(e));
  // A task command from the UI side of the protocol (a deliberate 404).
  const reply = await page.evaluate(async () => {
    const r = await fetch('/api/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'task.cancel', data: { taskId: 'nope' } }) });
    return r.json();
  });
  check(reply.ok === false && reply.error.code === 'not_found', 'task commands answer over REST');
  await page.screenshot({ path: shot });
  console.log(`screenshot: ${shot}`);
  check(pageErrors.length === 0, `no page errors${pageErrors.length ? ': ' + pageErrors.slice(0, 3).join(' | ') : ''}`);
} catch (err) {
  failures.push(String(err.message || err));
  console.log('FAIL', err.message || err);
  try { await page.screenshot({ path: shot }); } catch { /* ignore */ }
} finally {
  await context.close();
  await app.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
console.log(failures.length ? `\n${failures.length} failures` : '\nUI smoke test passed');
process.exit(failures.length ? 1 : 0);
