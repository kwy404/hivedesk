// Headless smoke test of the first launch dialog and the Models window against a live engine with an
// empty cache (so nothing is installed). Loads no model and must download nothing.
// Usage: node test/catalog/e2e-models.mjs [out dir for screenshots]   Env: HIVEDESK_BROWSER, LOCALE (default pt-BR)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { startHive } from '../../src/index.js';

const browserPath = [process.env.HIVEDESK_BROWSER, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', '/usr/bin/microsoft-edge', '/usr/bin/google-chrome']
  .filter(Boolean).find((p) => fs.existsSync(p));
if (!browserPath) { console.error('no Edge or Chrome found; set HIVEDESK_BROWSER'); process.exit(2); }
const out = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'hivedesk-models-shots-'));
fs.mkdirSync(out, { recursive: true });
const locale = process.env.LOCALE || 'pt-BR';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hivedesk-models-'));
const home = path.join(dir, 'cache');
const failures = [];
const check = (ok, label) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`); if (!ok) failures.push(label); };

const app = await startHive({ dir, home, flags: { brain: 'local' }, memoryHome: null, city: false, log: () => {} });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hivedesk-edge-'));
const context = await chromium.launchPersistentContext(profile, { executablePath: browserPath, headless: true, locale, viewport: { width: 1440, height: 960 }, args: ['--no-first-run', '--no-default-browser-check'] });
const page = context.pages()[0] || await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message || e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
try {
  await page.goto(`${app.url}${app.url.includes('?') ? '&' : '?'}view=desktop`, { waitUntil: 'load' });
  await page.waitForSelector('.mx-dlg .mx-card-big', { timeout: 60000 });
  await page.waitForTimeout(600);
  const text = await page.evaluate(() => document.querySelector('.mx-dlg').innerText);
  check(/GTX|GPU|CPU/.test(text), 'the dialog shows the detected hardware');
  check(/huggingface\.co\//.test(text), 'the recommended card shows the source');
  check(locale !== 'pt-BR' || /Usar o recomendado/.test(text) && /Agora não/.test(text) && /Escolher outro/.test(text), 'the five choices are there, translated');
  await page.screenshot({ path: path.join(out, `first-launch-${locale}.png`) });
  check(!app.bus.events.some((e) => e.type === 'brain.download.started'), 'nothing downloads before a yes');
  check(!/null|undefined|models\./.test(text), 'no raw keys or null in the dialog');
  await page.click('.mx-actions button:nth-last-child(2)');
  await page.waitForSelector('.mx-list .mx-row', { timeout: 20000 });
  await page.waitForTimeout(800);
  const rows = await page.$$eval('.mx-list .mx-row', (r) => r.length);
  check(rows >= 55, `the Models window lists the catalog (${rows} models)`);
  await page.screenshot({ path: path.join(out, `models-window-${locale}.png`) });
  // Filters: the giant size, then the detail sheet of the 70B with its pooled meter.
  await page.selectOption('.mx-tools select >> nth=1', 'giant');
  await page.waitForTimeout(400);
  const giants = await page.$$eval('.mx-list .mx-row', (r) => r.length);
  check(giants >= 8 && giants < rows, `the size filter shows the giants (${giants})`);
  await page.click('.mx-list .mx-row:has-text("Llama 3.3 70B") .mx-row-h');
  await page.waitForSelector('.mx-sheet .mx-meter-bar', { timeout: 20000 });
  await page.waitForTimeout(400);
  const meter = await page.evaluate(() => document.querySelector('.mx-meter').innerText);
  check(/VRAM/.test(meter) && /(experimental|experimentais|experimental)/i.test(meter), 'a giant model is locked with the meter and the experimental note');
  await page.$eval('.mx-sheet .mx-meter', (el) => el.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(out, `giant-meter-${locale}.png`) });
  await page.keyboard.press('Escape');
  // Rotation and Sharing tabs.
  await page.click('.mx-tabs .gh-tab:nth-child(2)');
  await page.waitForSelector('#mx-auto', { timeout: 20000 }).catch(() => null);
  const rot = await page.evaluate(() => document.querySelector('.mx-other')?.innerText || '');
  check(/Autom/.test(rot), 'the Rotation tab shows the automatic switch');
  await page.screenshot({ path: path.join(out, `rotation-${locale}.png`) });
  await page.click('.mx-tabs .gh-tab:nth-child(3)');
  await page.waitForSelector('#mx-share-gpu', { timeout: 20000 });
  const off = await page.evaluate(() => !document.querySelector('#mx-share-gpu').checked && !document.querySelector('#mx-share-cpu').checked && !document.querySelector('#mx-exp').checked);
  check(off, 'GPU sharing, CPU sharing and pooled models are off by default');
  await page.screenshot({ path: path.join(out, `sharing-${locale}.png`) });
  check(!app.bus.events.some((e) => e.type === 'brain.download.started' || e.type === 'models.install.started'), 'still nothing downloaded');
  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
} catch (err) {
  check(false, String(err.message || err));
  try { await page.screenshot({ path: path.join(out, 'failure.png') }); } catch { /* ignore */ }
} finally {
  await context.close();
  await app.close();
}
console.log(`screenshots in ${out}`);
process.exit(failures.length ? 1 : 0);
