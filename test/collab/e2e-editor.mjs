// End to end test of the Code window in one headless Edge (fresh --user-data-dir).
//   1. The editor loads lazily from the local copy (no CDN) and shows the file with its language.
//   2. A crew worker rewrites the file: "Dev is editing" marks show and the review lists hunks.
//   3. Reject one hunk (the old lines come back and are saved), accept the other.
//   4. Typing and Ctrl+S save through the engine tools.
// Usage: node test/collab/e2e-editor.mjs   Env: HIVEDESK_BROWSER, HIVEDESK_E2E_SHOTS

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { startHive } from '../../src/index.js';
import { createFakeBrain } from '../../src/brain/fake.js';

const temps = [];
let app = null;
let ctx = null;
let failed = 0;
const temp = (n) => {
  const d = mkdtempSync(join(tmpdir(), `hivedesk-editor-${n}-`));
  temps.push(d);
  return d;
};
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
  if (!ok) failed++;
}
const exe = [process.env.HIVEDESK_BROWSER, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', '/usr/bin/microsoft-edge', '/usr/bin/google-chrome'].find((p) => p && existsSync(p));

async function main() {
  if (!exe) throw new Error('No Edge or Chrome found. Set HIVEDESK_BROWSER.');
  app = await startHive({ dir: temp('dir'), home: temp('home'), brain: createFakeBrain({ respond: () => 'x' }) });
  const before = 'body {\n  color: black;\n}\n\nh1 {\n  font-size: 2rem;\n}\n';
  await app.toolbox.execute('write_file', { path: 'style.css', content: before }, { workerId: 'user' });
  ctx = await chromium.launchPersistentContext(temp('profile'), { executablePath: exe, headless: true, args: ['--no-first-run', '--no-default-browser-check'], viewport: { width: 1440, height: 900 }, locale: 'en-US' });
  const p = ctx.pages()[0] || (await ctx.newPage());
  await p.addInitScript(() => {
    try {
      localStorage.setItem('hivedesk.tour.v1', 'done');
      localStorage.setItem('hivedesk.lang', 'en');
    } catch {
      // fine
    }
  });
  p.on('pageerror', (e) => console.log(`[page error] ${e.message}`));
  const cdn = [];
  p.on('request', (r) => !r.url().startsWith(app.url.split('/?')[0]) && !r.url().startsWith('blob:') && !r.url().startsWith('data:') && cdn.push(r.url()));
  await p.goto(app.url, { waitUntil: 'commit', timeout: 60000 });
  await p.waitForFunction(() => window.hivedeskEditor && document.querySelector('.dock-shelf'), null, { timeout: 60000 });
  const loadedBefore = await p.evaluate(() => !!window.monaco);
  check('the editor is not loaded before the Code window opens', !loadedBefore);
  await p.evaluate(() => window.hivedeskEditor.open('style.css'));
  await p.waitForFunction(() => window.hivedeskEditor.api?.editor?.getModel()?.getValue().includes('color: black'), null, { timeout: 120000 });
  const info = await p.evaluate(() => ({ lang: window.hivedeskEditor.api.editor.getModel().getLanguageId(), minimap: !!document.querySelector('.ed-monaco .minimap'), status: document.querySelector('.ed-status').textContent }));
  check('the Code window shows the file with CSS highlighting, a minimap and a status bar', info.lang === 'css' && info.minimap && /CSS/.test(info.status) && /Ln 1, Col 1/.test(info.status), info.status);
  check('nothing loads from outside this hivedesk', cdn.length === 0, cdn.slice(0, 3).join(' '));

  // A crew write.
  const after = 'body {\n  color: #2b1d12;\n}\n\nh1 {\n  font-size: 2rem;\n}\n\n.hero {\n  padding: 4rem;\n}\n';
  await app.toolbox.execute('write_file', { path: 'style.css', content: after }, { workerId: 'dev' });
  await p.waitForFunction((want) => window.hivedeskEditor.api.text('style.css') === want, after, { timeout: 15000 });
  const marks = await p.waitForFunction(() => document.querySelectorAll('.ed-crew-line').length, null, { timeout: 5000 }).then((x) => x.jsonValue(), () => 0);
  check('the crew write shows in the open editor with "is editing" marks', marks > 0, `${marks} marked lines`);
  await p.click('[data-act="review"]');
  await p.waitForSelector('.ed-hunk-list li', { timeout: 15000 });
  const hunks = await p.locator('.ed-hunk-list li').count();
  check('the review shows each crew change side by side as a hunk', hunks === 2 && (await p.locator('.ed-review .monaco-diff-editor').count()) === 1, `${hunks} hunks`);
  if (process.env.HIVEDESK_E2E_DEBUG) console.log(JSON.stringify(await p.evaluate(() => [...document.querySelectorAll('.ed-hunks, .ed-hunk-list li')].map((el) => { const r = el.getBoundingClientRect(); const top = document.elementFromPoint(r.x + 20, r.y + r.height / 2); return [el.className || el.tagName, Math.round(r.y), Math.round(r.height), top?.className]; }))));
  if (process.env.HIVEDESK_E2E_SHOTS) await p.screenshot({ path: join(process.env.HIVEDESK_E2E_SHOTS, 'editor-review.png') });
  await p.locator('.ed-hunk-list li').first().locator('[data-act="reject"]').click();
  const rejected = 'body {\n  color: black;\n}\n\nh1 {\n  font-size: 2rem;\n}\n\n.hero {\n  padding: 4rem;\n}\n';
  const disk1 = await waitDisk(rejected);
  check('reject puts the old lines back and saves them', disk1 === rejected, JSON.stringify(disk1));
  await p.waitForFunction(() => document.querySelectorAll('.ed-hunk-list li').length === 1, null, { timeout: 10000 });
  await p.locator('.ed-hunk-list li [data-act="accept"]').click();
  await p.waitForFunction(() => document.querySelector('.ed-review')?.hidden, null, { timeout: 10000 });
  check('accept keeps the change and the review is done', (await app.toolbox.ws.read('style.css')) === rejected);

  // Typing and Ctrl+S.
  await p.evaluate(() => {
    const ed = window.hivedeskEditor.api.editor;
    ed.setPosition({ lineNumber: 1, column: 1 });
    ed.focus();
  });
  await p.keyboard.type('/* hivedesk */\n');
  await p.keyboard.press('Control+S');
  const disk2 = await waitDisk(null, (t) => t.startsWith('/* hivedesk */'));
  check('typing and Ctrl+S save through the engine tools', !!disk2 && disk2.startsWith('/* hivedesk */'));
  const changed = app.bus.events.filter((e) => e.type === 'file.changed' && e.data.path === 'style.css' && e.data.workerId === 'user').length;
  check('every save is a file.changed event from you', changed >= 3, `${changed} events`);
}

async function waitDisk(want, test) {
  const end = Date.now() + 15000;
  for (;;) {
    let t = null;
    try {
      t = app.toolbox.ws.read('style.css');
    } catch {
      // not yet
    }
    if (want !== null ? t === want : t && test(t)) return t;
    if (Date.now() > end) return t;
    await new Promise((r) => setTimeout(r, 150));
  }
}

main()
  .catch((err) => {
    failed++;
    console.log(`FAIL ${err.message.split('\n')[0]}`);
  })
  .finally(async () => {
    await Promise.race([ctx?.close(), new Promise((r) => setTimeout(r, 10000))]).catch(() => {});
    await Promise.race([app?.close(), new Promise((r) => setTimeout(r, 5000))]).catch(() => {});
    for (const d of temps) {
      try {
        rmSync(d, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        // the OS cleans temp later
      }
    }
    console.log(failed ? `${failed} check(s) failed` : 'all Code window e2e checks passed');
    process.exit(failed ? 1 : 0);
  });
setTimeout(() => {
  console.log('FAIL the e2e took longer than 4 minutes');
  ctx?.close().catch(() => {});
  setTimeout(() => process.exit(1), 5000);
}, 4 * 60 * 1000).unref();
