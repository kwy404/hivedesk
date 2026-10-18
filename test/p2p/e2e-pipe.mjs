// End to end test of browser-pipe with two real hivedesk engines and one headless browser.
//   1. The lender runs `hivedesk --lend` (its own HIVEDESK_HOME). Its Lend screen shows the form;
//      Make words gives six words.
//   2. The borrower (another hivedesk, its own home) opens the Join window with the words in the
//      address: the window meets the lender's window on the public MQTT relays, opens a WebRTC
//      data channel, and both engines run the handshake through it.
//   3. Both screens show the same six check words; the lender clicks "They match".
//   4. The borrower sees the grants; the lender's "Lending now" lists the borrower.
//   5. Stop lending revokes every compute grant in both engines.
// Needs network access to the public brokers and STUN. Screenshots go to HIVEDESK_SHOTS (or the
// temp folder). Usage: node test/p2p/e2e-pipe.mjs
// Env: HIVEDESK_BROWSER (Edge or Chrome), HIVEDESK_SHOTS (folder for the screenshots).

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const temps = [];
const kids = [];
const temp = (name) => {
  const d = mkdtempSync(join(tmpdir(), `hivedesk-pipe-${name}-`));
  temps.push(d);
  return d;
};

function findBrowser() {
  return [
    process.env.HIVEDESK_BROWSER,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/usr/bin/microsoft-edge',
    '/usr/bin/google-chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ].find((p) => p && existsSync(p));
}

/** Starts `hivedesk` in a child process with its own home and project folder; resolves { port, token }. */
function engine(name, extra = []) {
  const home = temp(`${name}-home`);
  const dir = temp(`${name}-dir`);
  const child = spawn(process.execPath, [join(root, 'src', 'cli.js'), '--no-open', '--no-download', '--no-city', '--dir', dir, '--port', '0', ...extra], {
    env: { ...process.env, HIVEDESK_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  kids.push(child);
  let out = '';
  child.stdout.on('data', (c) => (out += c));
  child.stderr.on('data', (c) => (out += c));
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${name} did not start:\n${out}`)), 30000);
    const check = setInterval(() => {
      const m = /open:\s+http:\/\/127\.0\.0\.1:(\d+)\/\?t=([0-9a-f]{32})/.exec(out);
      if (m) {
        clearTimeout(t);
        clearInterval(check);
        resolve({ port: Number(m[1]), token: m[2], home, log: () => out });
      }
    }, 100);
    child.on('exit', (code) => reject(new Error(`${name} exited with ${code}:\n${out}`)));
  });
}

const step = (s) => console.log(`- ${s}`);

async function main() {
  const { chromium } = await import('playwright-core');
  const exe = findBrowser();
  if (!exe) throw new Error('No Edge or Chrome found; set HIVEDESK_BROWSER');
  const shots = process.env.HIVEDESK_SHOTS || temp('shots');
  mkdirSync(shots, { recursive: true });

  const lender = await engine('lender', ['--lend']);
  const borrower = await engine('borrower');
  step(`lender on ${lender.port}, borrower on ${borrower.port}`);

  const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--no-first-run', '--no-default-browser-check'] });
  try {
    const ctxL = await browser.newContext({ viewport: { width: 1100, height: 900 } });
    const ctxB = await browser.newContext({ viewport: { width: 1100, height: 900 } });
    const pl = await ctxL.newPage();
    const pb = await ctxB.newPage();
    for (const [p, n] of [[pl, 'lender'], [pb, 'borrower']]) p.on('console', (m) => m.type() === 'error' && console.log(`  [${n}] ${m.text()}`));

    await pl.goto(`http://127.0.0.1:${lender.port}/lend/?t=${lender.token}`);
    await pl.waitForSelector('[data-act="offer"]', { timeout: 20000 });
    await pl.screenshot({ path: join(shots, 'p2p-lend-form.png'), fullPage: true });
    step('the Lend form is up');
    await pl.click('[data-act="offer"]');
    await pl.waitForSelector('.lend-words.is-big', { timeout: 30000 });
    const words = (await pl.getAttribute('.lend-words.is-big', 'data-words')).split(' ');
    await pl.screenshot({ path: join(shots, 'p2p-lend-words.png'), fullPage: true });
    step(`six words: ${words.length}`);

    await pb.goto(`http://127.0.0.1:${borrower.port}/lend/?t=${borrower.token}#w=${words.join('-')}`);
    await pl.waitForSelector('[data-act="match"]', { timeout: 90000 });
    const sasL = await pl.getAttribute('.lend-confirm .lend-words', 'data-words');
    await pb.waitForSelector('.lend-p2p-join .lend-words', { timeout: 30000 });
    const sasB = await pb.getAttribute('.lend-p2p-join .lend-words', 'data-words');
    await pl.screenshot({ path: join(shots, 'p2p-lend-confirm.png'), fullPage: true });
    await pb.screenshot({ path: join(shots, 'p2p-join-sas.png'), fullPage: true });
    if (!sasL || sasL !== sasB) throw new Error(`check words differ: ${sasL} / ${sasB}`);
    step('both screens show the same six check words');

    await pl.click('[data-act="match"]');
    await pb.waitForSelector('[data-phase="accepted"]', { timeout: 30000 });
    await pl.waitForSelector('.lend-peer .lend-dot.is-on', { timeout: 30000 });
    await pl.screenshot({ path: join(shots, 'p2p-lend-now.png'), fullPage: true });
    await pb.screenshot({ path: join(shots, 'p2p-join-accepted.png'), fullPage: true });
    step('accepted: the lender lists the borrower online with its grants');

    await pl.click('[data-act="stop"]');
    await pl.waitForFunction(() => !document.querySelector('.lend-peer'), null, { timeout: 15000 });
    step('Stop lending revoked every compute grant');
    console.log(`screenshots in ${shots}`);
  } finally {
    await browser.close();
  }
}

main()
  .then(() => {
    console.log('e2e browser-pipe: ok');
    process.exitCode = 0;
  })
  .catch((err) => {
    console.error(`e2e browser-pipe failed: ${err.stack || err.message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    for (const k of kids) k.kill();
    setTimeout(() => {
      for (const d of temps) if (!process.env.HIVEDESK_SHOTS || !d.includes('shots')) try { rmSync(d, { recursive: true, force: true }); } catch { /* busy */ }
    }, 500);
  });
