// Headless check of the desktop polish against a live engine in --demo mode: the guided tour from
// start to finish, rich tooltips, every language at 1440 and 375 px without overflow or raw keys,
// voice mode asking before it acts, and no console errors. Saves screenshots to ui/screenshots/.
// One headless Edge (or Chrome) with a fresh --user-data-dir; the engine runs with --no-open.
// Usage: node test/e2e-polish.mjs        Env: HIVEDESK_BROWSER (path to Edge or Chrome)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { CODES } from '../i18n/index.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.join(ROOT, 'ui', 'screenshots');
const browserPath = [
  process.env.HIVEDESK_BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/microsoft-edge',
  '/usr/bin/google-chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
].filter(Boolean).find((p) => fs.existsSync(p));
if (!browserPath) { console.error('no Edge or Chrome found; set HIVEDESK_BROWSER'); process.exit(2); }

const failures = [];
const check = (ok, label) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`); if (!ok) failures.push(label); };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hivedesk-polish-'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hivedesk-edge-'));
const engine = spawn(process.execPath, ['src/cli.js', '--demo', '--yes', '--no-open', '--port', '0', '--dir', dir], {
  cwd: ROOT, env: { ...process.env, HIVEDESK_HOME: path.join(dir, 'cache') }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
});
let context = null;
const stop = async (code) => {
  try { await Promise.race([context?.close(), new Promise((r) => setTimeout(r, 8000))]); } catch {}
  engine.kill();
  process.exit(code);
};
setTimeout(() => { console.error('timed out'); stop(3); }, 420000).unref();

const url = await new Promise((resolve, reject) => {
  let log = '';
  const t = setTimeout(() => reject(new Error(`the engine printed no URL: ${log.slice(-500)}`)), 60000);
  const on = (d) => { log += d; const m = /(http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]+)/.exec(log); if (m) { clearTimeout(t); resolve(m[1]); } };
  engine.stdout.on('data', on);
  engine.stderr.on('data', on);
}).catch((err) => { console.error(err.message); return stop(2); });

context = await chromium.launchPersistentContext(profile, {
  executablePath: browserPath, headless: true, viewport: { width: 1440, height: 900 }, locale: 'en-US',
  args: ['--no-first-run', '--no-default-browser-check', '--lang=en-US']
});
const page = context.pages()[0] || await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('response', (r) => { if (r.status() >= 400 && !r.url().includes('/favicon')) errors.push(`${r.status()} ${new URL(r.url()).pathname}`); });
const shot = (name) => page.screenshot({ path: path.join(SHOTS, name) });

try {
  await page.goto(url, { waitUntil: 'load' });

  // 1. the first run tour starts by itself and runs to the end
  await page.waitForFunction(() => window.hivedeskTour && window.hivedeskTour.index === 0, null, { timeout: 30000 });
  await page.waitForTimeout(1200);
  const total = await page.evaluate(() => window.hivedeskTour.total);
  check(total >= 10, `the tour has ${total} steps`);
  const seen = [];
  for (let i = 0; i < total; i++) {
    await page.waitForTimeout(900);
    const st = await page.evaluate(() => ({ id: window.hivedeskTour.step, spot: !document.querySelector('.tour-spot')?.hidden, text: document.querySelector('.tour-text')?.textContent || '' }));
    seen.push(st.id);
    if (!st.spot || !st.text) check(false, `tour step ${st.id} has a spotlight and text`);
    if (i === 0) await shot('hive-1440-tour-step1.png');
    if (i === 4) await shot('hive-1440-tour-step5.png');
    if (i < total - 1) { if (i % 2) await page.keyboard.press('ArrowRight'); else { await page.focus('.tour-bubble [data-primary]'); await page.keyboard.press('Enter'); } }
  }
  check(seen.includes('office'), 'the tour shows the Office toggle');
  await page.click('.tour-bubble [data-primary]');
  await page.waitForTimeout(500);
  check(await page.evaluate(() => window.hivedeskTour.index === -1 && localStorage.getItem('hivedesk.tour.v1') === 'done'), `the tour ran start to finish (${seen.join(', ')})`);

  // 2. tooltips: hover, delay, title, help and shortcut, never on top of the target
  await page.hover('.hdock [data-win="files"]');
  await page.waitForTimeout(900);
  const tip = await page.evaluate(() => {
    const t = document.querySelector('.hd-tip');
    const a = t.getBoundingClientRect();
    const b = document.querySelector('.hdock [data-win="files"]').getBoundingClientRect();
    const overlap = !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
    return { on: t.classList.contains('on'), title: t.querySelector('.hd-tip-t').textContent, help: t.querySelector('.hd-tip-h').textContent, overlap };
  });
  check(tip.on && tip.title && tip.help, `a dock tooltip shows a title and help (${tip.title}: ${tip.help})`);
  check(!tip.overlap, 'the tooltip does not cover its target');
  await page.hover('.topbar .ibtn[data-ta="top.palette"]');
  await page.waitForTimeout(900);
  await shot('hive-1440-tooltip.png');
  check(await page.evaluate(() => /K/.test(document.querySelector('.hd-tip-k')?.textContent || '')), 'the palette tooltip shows its shortcut');
  await page.mouse.move(700, 450);

  // 3. voice mode never acts on a request before a clear yes
  const voice = await page.evaluate(async () => {
    await window.hivedeskVoice.say('build a tiny page that says hello');
    const pending = !!window.hivedeskVoice.pending;
    await window.hivedeskVoice.say('no');
    return { pending, after: !!window.hivedeskVoice.pending };
  });
  check(voice.pending && !voice.after, 'voice mode asks before acting and a no cancels');
  await page.keyboard.press('Escape');

  // 4. every language at 1440 and 375: no page overflow, no clipped controls, no raw keys
  const scan = () => page.evaluate(() => {
    const out = [];
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    if (document.documentElement.scrollWidth > document.documentElement.clientWidth) out.push('the page scrolls sideways');
    for (const e of document.querySelectorAll('.topbar button, .win-title, .tb button, .seg button, .btn, .hchip')) {
      if (!vis(e)) continue;
      const cs = getComputedStyle(e);
      const label = (e.getAttribute('aria-label') || e.textContent).trim().slice(0, 40);
      if (e.scrollWidth > e.clientWidth + 2 && cs.textOverflow !== 'ellipsis' && cs.overflowX !== 'auto' && !e.querySelector('.ellipsis')) out.push(`clipped: ${label}`);
      if (e.getBoundingClientRect().right > innerWidth + 1) out.push(`off screen: ${label}`);
    }
    const raw = [...document.querySelectorAll('body *')].filter((e) => !e.children.length && /^[a-z]+(\.[a-zA-Z0-9]+)+$/.test(e.textContent.trim()) && !/\.(js|css|html|md|svg|json|png|txt)$/.test(e.textContent.trim())).map((e) => e.textContent.trim());
    if (raw.length) out.push(`raw keys: ${[...new Set(raw)].slice(0, 6).join(', ')}`);
    return out;
  });
  for (const [w, h] of [[1440, 900], [375, 812]]) {
    await page.setViewportSize({ width: w, height: h });
    for (const code of CODES) {
      await page.evaluate((c) => import('/js/i18n.js').then((m) => m.setLocale(c)), code);
      await page.waitForTimeout(500);
      const problems = await scan();
      const lang = await page.evaluate(() => document.documentElement.lang);
      check(lang === code && !problems.length, `${code} at ${w} px renders without overflow${problems.length ? `: ${problems.join('; ')}` : ''}`);
    }
  }

  // 5. screenshots in Japanese, German and Portuguese, loaded fresh in that language
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const code of ['ja', 'de', 'pt-BR']) {
    await page.evaluate((c) => localStorage.setItem('hivedesk.lang', c), code);
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => document.querySelector('.boot')?.hasAttribute('hidden'), null, { timeout: 30000 });
    await page.waitForTimeout(2500);
    check(await page.evaluate(() => document.querySelector('#ask')?.placeholder !== 'What should the crew build today?'), `${code}: the request box is translated`);
    await shot(`hive-1440-${code}.png`);
  }
  await page.evaluate(() => localStorage.setItem('hivedesk.lang', 'en'));
} catch (err) {
  check(false, `no exception (${err.message})`);
} finally {
  const unique = [...new Set(errors)];
  check(!unique.length, `no console errors${unique.length ? `: ${unique.slice(0, 5).join(' | ')}` : ''}`);
  console.log(failures.length ? `\n${failures.length} problems` : '\nall checks passed');
  await stop(failures.length ? 1 : 0);
}
