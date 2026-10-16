// End to end test of Lend your PC with two real hivedesk instances and two Edge contexts.
//   1. The friend runs `hivedesk --lend` with the fake brain. Its Lend screen shows six words,
//      a QR code and a share link.
//   2. The host (another hivedesk, no model) opens the "Use a friend's PC" window and pastes the
//      whole phrase into the first box: the paste spread fills the six boxes and connects over
//      the public MQTT relays and WebRTC.
//   3. Both sides show the same six confirmation words; both confirm.
//   4. The host's crew gets a job. Its model turn goes to the friend's brain: the host logs a
//      turn on the remote brain, the friend's live log shows the request answered.
//   5. The friend stops lending: the host's remote brain is detached.
// Each Edge context gets a fresh --user-data-dir. Needs network access to the public brokers.
//
// Both hivedesk instances run in this process through startHive (real HTTP and WebSocket
// servers on 127.0.0.1, separate folders), so the friend can be given a fake brain.
// Usage: node test/lend/e2e-lend.mjs
// Env:   HIVEDESK_BROWSER (path to Edge or Chrome), PLAYWRIGHT_CORE (path to playwright-core
//        when it is not installed in this package), HIVEDESK_E2E_HEADED=1 to watch.

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startHive } from '../../src/index.js';
import { createFakeBrain } from '../../src/brain/fake.js';
import { demoRespond } from '../../src/demo.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const temps = [];
const apps = [];

function temp(name) {
  const dir = mkdtempSync(join(tmpdir(), `hivedesk-e2e-${name}-`));
  temps.push(dir);
  return dir;
}

async function loadPlaywright() {
  try {
    return await import('playwright-core');
  } catch {
    const fallbacks = [process.env.PLAYWRIGHT_CORE, join(root, '..', 'filefinch', 'node_modules', 'playwright-core')].filter(Boolean);
    for (const p of fallbacks) {
      if (existsSync(p)) return createRequire(pathToFileURL(join(p, 'package.json')))(p);
    }
    throw new Error('playwright-core is not installed. npm i -D playwright-core, or set PLAYWRIGHT_CORE to an installed copy.');
  }
}

function findBrowser() {
  return [
    process.env.HIVEDESK_BROWSER,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/microsoft-edge',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome',
  ].find((p) => p && existsSync(p));
}

let failed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
  if (!ok) failed++;
  return ok;
}

/**
 * Starts one hivedesk in this process (the same startHive the CLI uses) and returns
 * { origin, token, app }. The friend gets a fake brain that answers like the demo script.
 */
async function startOne(name, opts) {
  const app = await startHive({ dir: temp(name), home: temp(`${name}-home`), ...opts });
  apps.push(app);
  const u = new URL(app.url);
  return { origin: u.origin, token: u.searchParams.get('t'), app };
}

async function api(hive, type, data = {}) {
  const r = await fetch(`${hive.origin}/api/command`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${hive.token}` },
    body: JSON.stringify({ type, data }),
  });
  return r.json();
}

async function events(hive) {
  const r = await fetch(`${hive.origin}/api/events?since=0&limit=5000`, { headers: { authorization: `Bearer ${hive.token}` } });
  return (await r.json()).events || [];
}

async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function main() {
  const { chromium } = await loadPlaywright();
  const exe = findBrowser();
  if (!exe) throw new Error('No Edge or Chrome found. Set HIVEDESK_BROWSER.');

  const fake = createFakeBrain({ id: 'fake', label: 'Fake brain of the friend', model: 'fake-lender', respond: demoRespond, delayMs: 300 });
  const friend = await startOne('friend', { lend: true, brain: fake });
  // The host has no model of its own: a placeholder brain keeps the brain manager from
  // installing a runtime, and is removed right away, so every turn needs the friend.
  const host = await startOne('host', { brain: createFakeBrain({ id: 'placeholder', respond: () => '' }) });
  host.app.scheduler.removeBrain('placeholder', 'test: the host has no model');
  check('two hivedesk instances started', true, `${friend.origin} lends, ${host.origin} borrows`);

  const launch = (name) =>
    chromium.launchPersistentContext(temp(`${name}-profile`), {
      executablePath: exe,
      headless: process.env.HIVEDESK_E2E_HEADED !== '1',
      args: ['--disable-features=WebRtcHideLocalIpsWithMdns', '--no-first-run'],
      permissions: ['clipboard-read', 'clipboard-write'],
    });
  const [ctxF, ctxH] = await Promise.all([launch('friend'), launch('host')]);
  const pf = ctxF.pages()[0] || (await ctxF.newPage());
  const ph = ctxH.pages()[0] || (await ctxH.newPage());
  for (const [p, n] of [
    [pf, 'friend'],
    [ph, 'host'],
  ])
    p.on('pageerror', (e) => console.log(`[${n} page error] ${e.message}`));

  // HIVEDESK_E2E_SHOTS=<folder> keeps a screenshot of both screens at each step.
  const shotDir = process.env.HIVEDESK_E2E_SHOTS;
  const shots = async (step) => {
    if (!shotDir) return;
    await pf.screenshot({ path: join(shotDir, `friend-${step}.png`), fullPage: true }).catch(() => {});
    await ph.screenshot({ path: join(shotDir, `host-${step}.png`), fullPage: true }).catch(() => {});
  };

  // 1. The friend's Lend screen.
  await pf.goto(`${friend.origin}/lend/?t=${friend.token}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pf.locator('.lend-screen[data-phase="share"]').waitFor({ timeout: 60000 });
  const words = (await pf.getAttribute('.lend-words.is-big', 'data-words')).split(' ');
  check('the Lend screen shows six words', words.length === 6, words.join(' '));
  check('the Lend screen shows a QR code', (await pf.locator('.lend-qr svg path').count()) === 1);
  const link = await pf.inputValue('.lend-link');
  check('the share link carries the words', link.endsWith(`#w=${words.join('-')}`), link);

  await shots('share');
  // 2. The host pastes the whole phrase into the first box.
  await ph.goto(`${host.origin}/lend/?t=${host.token}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await ph.locator('.lend-join[data-phase="form"]').waitFor({ timeout: 20000 });
  await ph.focus('#lend-w0');
  await ph.evaluate((text) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    document.getElementById('lend-w0').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, `My hivedesk words: ${words.join(', ')}`);
  const spreadOk = await ph.evaluate(() => window.hivedeskJoin.state.phase !== 'form' || [...document.querySelectorAll('.lend-box')].every((b) => b.value));
  check('a pasted phrase fills the six boxes and connects', spreadOk);

  // 3. Confirmation words.
  await Promise.all([pf.locator('[data-phase="confirm"]').waitFor({ timeout: 90000 }), ph.locator('[data-phase="confirm"]').waitFor({ timeout: 90000 })]);
  const cf = await pf.getAttribute('.lend-words.is-confirm', 'data-words');
  const ch = await ph.getAttribute('.lend-words.is-confirm', 'data-words');
  check('both sides show the same confirmation words', cf === ch && cf.split(' ').length === 6, cf);
  check('the confirmation words differ from the pairing words', cf !== words.join(' '));
  await shots('confirm');
  await pf.click('[data-act="confirm"]');
  await ph.click('[data-act="confirm"]');
  await pf.locator('.lend-screen[data-phase="lending"]').waitFor({ timeout: 20000 });
  await ph.locator('.lend-join[data-phase="borrowing"]').waitFor({ timeout: 20000 });
  const attached = await waitFor(async () => (await events(host)).find((e) => e.type === 'brain.attached' && e.data.kind === 'remote'), 10000, 'brain.attached');
  check('the host attached the friend as a remote brain', !!attached, attached.data.label);

  // 4. A host turn answered by the friend's fake brain.
  const job = await api(host, 'job.create', { request: 'a tiny static landing page for a bakery', approval: true });
  check('the host created a job', job.ok, JSON.stringify(job.result || job.error));
  const turn = await waitFor(async () => (await events(host)).find((e) => e.type === 'turn.started' && e.data.brainId === attached.data.brainId), 60000, 'a turn on the remote brain');
  check('the host scheduler sent a turn to the friend', !!turn, `${turn.data.workerId} turn ${turn.data.n}`);
  await pf.locator('.lend-log tr[data-status="done"]').first().waitFor({ timeout: 60000 });
  check('the friend log shows the request answered', true);
  const ended = await waitFor(async () => (await events(host)).find((e) => e.type === 'turn.ended' && e.data.brainId === attached.data.brainId), 30000, 'turn.ended on the remote brain');
  check('the host turn ended with the friend answer', ended.data.completionTokens > 0, `${ended.data.completionTokens} tokens in ${ended.data.ms} ms`);
  const served = (await events(friend)).filter((e) => e.type === 'lend.served' || e.type === 'brain.served' || e.type === 'lend.request');
  check('the friend server logged the served request', served.some((e) => e.type === 'lend.served'), served.map((e) => e.type).join(', '));
  check('the friend fake brain answered the host turn', fake.calls.length > 0, `${fake.calls.length} call(s)`);
  const leaked = (await events(friend)).some((e) => JSON.stringify(e).includes('bakery'));
  check('the friend event log holds no prompt text', !leaked);

  await shots('lending');
  // 5. Stop lending at any time.
  await pf.click('[data-act="stop"]');
  await pf.locator('.lend-screen[data-phase="stopped"]').waitFor({ timeout: 10000 });
  const detached = await waitFor(async () => (await events(host)).find((e) => e.type === 'brain.detached' && e.data.brainId === attached.data.brainId), 20000, 'brain.detached');
  check('stopping detaches the brain on the host', !!detached, detached.data.reason);
  const refused = await api(friend, 'lend.chat', { messages: [{ role: 'user', content: 'hi' }] });
  check('the friend server refuses after stop', refused.ok === false, refused.error?.code);

  await shots('stopped');
  await Promise.race([Promise.all([ctxF.close(), ctxH.close()]), new Promise((r) => setTimeout(r, 10000))]);
}

main()
  .catch((err) => {
    failed++;
    console.log(`FAIL ${err.message}`);
  })
  .finally(() => {
    // Close both instances, but never let a slow shutdown hang the test run.
    Promise.race([Promise.allSettled(apps.map((a) => a.close())), new Promise((r) => setTimeout(r, 5000))]).then(() => {
      for (const d of temps) {
        try {
          rmSync(d, { recursive: true, force: true, maxRetries: 3 });
        } catch {
          // a browser may still hold a profile file for a moment; the OS cleans temp later
        }
      }
      console.log(failed ? `${failed} check(s) failed` : 'all lend e2e checks passed');
      process.exit(failed ? 1 : 0);
    });
  });
