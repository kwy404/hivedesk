// End to end test of Code together with two real hivedesk instances and one pair of headless
// Edge contexts (each with a fresh --user-data-dir).
//   1. The host opens Code together and shares the session: six words, a QR code and a link.
//   2. The guest pastes the whole phrase into the first box: the boxes fill and it connects over
//      the public MQTT relays and WebRTC. Both sides see the same confirmation words.
//   3. The guest's desktop now shows the host's session. As a viewer it cannot ask the crew.
//   4. The host makes the guest a collaborator. Both open index.html in the Code window and type
//      at the same time. The text converges, the host sees the guest's cursor, and the save lands
//      on the host's disk.
//   5. The host's crew starts a job: the guest sees the crew events.
// Needs network access to the public brokers. Nothing is shown on screen.
//
// Usage: node test/collab/e2e-collab.mjs
// Env:   HIVEDESK_BROWSER, HIVEDESK_E2E_SHOTS=<folder> (screenshots of each step)

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { startHive } from '../../src/index.js';
import { createFakeBrain } from '../../src/brain/fake.js';
import { demoRespond } from '../../src/demo.js';

const temps = [];
const apps = [];
const contexts = [];
let failed = 0;

const temp = (name) => {
  const d = mkdtempSync(join(tmpdir(), `hivedesk-collab-${name}-`));
  temps.push(d);
  return d;
};

function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
  if (!ok) failed++;
  return ok;
}

function findBrowser() {
  return [process.env.HIVEDESK_BROWSER, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', '/usr/bin/microsoft-edge', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome'].find((p) => p && existsSync(p));
}

async function startOne(name, opts) {
  const app = await startHive({ dir: temp(name), home: temp(`${name}-home`), ...opts });
  apps.push(app);
  const u = new URL(app.url);
  return { app, url: app.url, origin: u.origin, token: u.searchParams.get('t') };
}

async function api(hive, type, data = {}) {
  const r = await fetch(`${hive.origin}/api/command`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${hive.token}` }, body: JSON.stringify({ type, data }) });
  return r.json();
}

async function main() {
  const exe = findBrowser();
  if (!exe) throw new Error('No Edge or Chrome found. Set HIVEDESK_BROWSER.');
  const brain = createFakeBrain({ id: 'fake', label: 'Fake brain', model: 'fake', respond: demoRespond, delayMs: 200 });
  const host = await startOne('host', { brain });
  // The guest has no model of its own; a placeholder keeps the brain manager from installing one.
  const guest = await startOne('guest', { brain: createFakeBrain({ id: 'placeholder', respond: () => '' }) });
  guest.app.scheduler.removeBrain('placeholder', 'test');
  const start = '<!doctype html>\n<html>\n<body>\n  <h1>Crumb bakery</h1>\n  <p>Fresh bread</p>\n</body>\n</html>\n';
  await api(host, 'files.write', { path: 'index.html', content: start });
  check('two hivedesk instances started', true, `${host.origin} hosts, ${guest.origin} joins`);

  const launch = async (name) => {
    const ctx = await chromium.launchPersistentContext(temp(`${name}-profile`), {
      executablePath: exe,
      headless: true, // never a visible window
      args: ['--no-first-run', '--no-default-browser-check', '--disable-features=WebRtcHideLocalIpsWithMdns'],
      viewport: { width: 1440, height: 900 },
      locale: 'en-US',
    });
    contexts.push(ctx);
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.addInitScript(() => {
      try {
        localStorage.setItem('hivedesk.tour.v1', 'done');
        localStorage.setItem('hivedesk.lang', 'en');
      } catch {
        // fine
      }
    });
    page.on('pageerror', (e) => console.log(`[${name} page error] ${e.message}`));
    return page;
  };
  const ph = await launch('host');
  const pg = await launch('guest');
  const shotDir = process.env.HIVEDESK_E2E_SHOTS;
  const shots = async (step) => {
    if (!shotDir) return;
    await ph.screenshot({ path: join(shotDir, `collab-host-${step}.png`) }).catch(() => {});
    await pg.screenshot({ path: join(shotDir, `collab-guest-${step}.png`) }).catch(() => {});
  };

  for (const [p, hv] of [[ph, host], [pg, guest]]) {
    await p.goto(hv.url, { waitUntil: 'commit', timeout: 60000 });
    await p.waitForFunction(() => window.hivedesk && window.hivedeskEditor && document.querySelector('.dock-shelf'), null, { timeout: 60000 });
  }

  // 1. The host shares.
  await ph.evaluate(() => window.hivedesk.openWindow('collab'));
  await ph.fill('#collab-name', 'Hana');
  await ph.click('[data-act="share"]');
  const words = (await ph.waitForFunction(() => document.querySelector('.collab-invite-words')?.dataset.words, null, { timeout: 60000 }).then((x) => x.jsonValue())).split(' ');
  check('the host shows six words', words.length === 6, words.join(' '));
  check('the host shows a QR code and a link', (await ph.locator('.collab-invite .lend-qr svg path').count()) === 1 && (await ph.inputValue('.collab-invite .lend-link')).includes(`#cw=${words.join('-')}`));

  // 2. The guest pastes the phrase into the first box.
  await pg.evaluate(() => window.hivedesk.openWindow('collab'));
  await pg.fill('#collab-name', 'Ana');
  await pg.evaluate((text) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    document.getElementById('collab-w0').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, `Join me: ${words.join(' ')}`);
  await Promise.all([pg.locator('.collab-panel[data-phase="confirm"]').waitFor({ timeout: 90000 }), ph.locator('[data-act="confirm-guest"]').waitFor({ timeout: 90000 })]);
  const cg = await pg.getAttribute('.lend-words.is-confirm', 'data-words');
  const chost = await ph.getAttribute('.collab-invite .lend-words.is-confirm', 'data-words');
  check('a pasted phrase fills the boxes, and both sides show the same confirmation words', cg === chost && cg.split(' ').length === 6, cg);
  await shots('confirm');
  await pg.click('[data-act="confirm"]');
  await ph.click('[data-act="confirm-guest"]');

  // 3. The guest renders the host's session.
  await pg.waitForFunction(() => window.hivedeskCollab?.mode === 'guest', null, { timeout: 30000 });
  await pg.waitForFunction(() => window.hivedesk.state().files?.['index.html'], null, { timeout: 30000 });
  check('the guest desktop shows the host session', true, 'index.html of the host is in the guest store');
  const refused = await pg.evaluate(() => window.hivedesk.command('job.create', { request: 'x' }).then(() => 'ran', (e) => e.code));
  check('a viewer cannot send commands to the crew', refused === 'forbidden', refused);
  const chat = await pg.evaluate(() => window.hivedesk.command('chat.send', { channel: 'general', text: 'hello from the guest' }).then(() => 'ok', (e) => e.message));
  check('a viewer can chat', chat === 'ok', chat);

  // 4. Collaborator, concurrent editing.
  await ph.selectOption('.collab-role[data-guest="g1"]', 'collaborator');
  await pg.waitForFunction(() => window.hivedeskCollab.role() === 'collaborator', null, { timeout: 15000 });
  check('the host made the guest a collaborator', true);
  const openEditor = async (p) => {
    await p.evaluate(() => window.hivedeskEditor.open('index.html'));
    await p.waitForFunction(() => window.hivedeskEditor.api?.editor?.getModel()?.getValue().includes('Crumb'), null, { timeout: 60000 });
  };
  await openEditor(ph);
  await openEditor(pg);
  const typeAt = async (p, line, text) => {
    await p.evaluate((ln) => {
      const ed = window.hivedeskEditor.api.editor;
      ed.setPosition({ lineNumber: ln, column: ed.getModel().getLineMaxColumn(ln) });
      ed.focus();
    }, line);
    await p.keyboard.type(text, { delay: 25 });
  };
  await Promise.all([typeAt(ph, 4, ' by Hana'), typeAt(pg, 5, ' and pastries from Ana')]);
  const merged = await ph.waitForFunction(() => {
    const t = window.hivedeskEditor.api.text('index.html');
    return t.includes('Crumb bakery</h1> by Hana') && t.includes('Fresh bread</p> and pastries from Ana') ? t : null;
  }, null, { timeout: 30000 }).then((x) => x.jsonValue(), async (err) => {
    await shots('diverged');
    const texts = await Promise.all([ph, pg].map((p) => p.evaluate(() => [window.hivedeskEditor.api.text('index.html'), window.hivedeskEditor.api.editor.getValue(), window.hivedeskCollab.mode])));
    console.log(JSON.stringify(texts, null, 1));
    throw err;
  });
  const guestText = await pg.waitForFunction((want) => window.hivedeskEditor.api.text('index.html') === want, merged, { timeout: 30000 }).then(() => true, () => false);
  check('both edits converge on both sides', guestText, merged.split('\n').slice(3, 5).join(' | '));
  const cursor = await ph.waitForFunction(() => document.querySelector('.ed-rcaret'), null, { timeout: 15000 }).then(() => true, () => false);
  check('the host sees the guest cursor with a name tag', cursor);
  await shots('editing');
  // Format on save tidies the HTML first, so the saved text is the editor's text after the save.
  await ph.evaluate(() => window.hivedeskEditor.api.save('index.html'));
  const saved = await ph.evaluate(() => window.hivedeskEditor.api.text('index.html'));
  const disk = await api(host, 'files.read', { path: 'index.html' });
  check('the merged text is saved on the host disk', disk.result?.content === saved && saved.includes('by Hana') && saved.includes('from Ana'));
  const guestSaved = await pg.waitForFunction((want) => window.hivedeskEditor.api.text('index.html') === want, saved, { timeout: 15000 }).then(() => true, () => false);
  check('the formatted text reaches the guest too', guestSaved);

  // 5. A crew event reaches the guest.
  const job = await api(host, 'job.create', { request: 'add opening hours to the bakery page', approval: false });
  check('the host crew starts a job', job.ok);
  const seen = await pg.waitForFunction(() => {
    const s = window.hivedesk.state();
    const said = (s.chat?.general || []).find((m) => m.from === 'mel' && /opening hours/.test(m.text));
    return s.jobs?.some((j) => /opening hours/.test(j.request)) && said ? `job ${s.jobs[s.jobs.length - 1].id}, Mel: ${said.text.slice(0, 50)}` : null;
  }, null, { timeout: 60000 }).then((x) => x.jsonValue(), () => null);
  if (!seen) {
    console.log('host', JSON.stringify(await ph.evaluate(() => ({ lastSeq: window.hivedesk.state().lastSeq, jobs: window.hivedesk.state().jobs.length }))));
    console.log('guest', JSON.stringify(await pg.evaluate(() => ({ lastSeq: window.hivedesk.state().lastSeq, jobs: window.hivedesk.state().jobs.length, mode: window.hivedeskCollab.mode, chat: (window.hivedesk.state().chat?.general || []).slice(-3).map((m) => m.text) }))));
  }
  check('the guest sees the crew events', !!seen, seen || 'nothing arrived');
  await shots('crew');
}

main()
  .catch((err) => {
    failed++;
    console.log(`FAIL ${err.message.split('\n')[0]}`);
  })
  .finally(async () => {
    await Promise.race([Promise.allSettled(contexts.map((c) => c.close())), new Promise((r) => setTimeout(r, 10000))]);
    await Promise.race([Promise.allSettled(apps.map((a) => a.close())), new Promise((r) => setTimeout(r, 5000))]);
    for (const d of temps) {
      try {
        rmSync(d, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        // a browser may still hold a profile file for a moment
      }
    }
    console.log(failed ? `${failed} check(s) failed` : 'all Code together e2e checks passed');
    process.exit(failed ? 1 : 0);
  });
setTimeout(() => {
  console.log('FAIL the e2e took longer than 6 minutes');
  for (const c of contexts) c.close().catch(() => {});
  setTimeout(() => process.exit(1), 5000);
}, 6 * 60 * 1000).unref();
