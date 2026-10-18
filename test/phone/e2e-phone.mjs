// End to end test of the phone remote in headless Edge or Chrome, one browser, two contexts:
//   desktop  the real hivedesk window of an in-process engine (startHive, demo folder), with the
//            phone and remote screen UIs installed the way src/index.js and ui/js/main.js will load them
//   phone    390x844 with touch, opening the QR link exactly as a camera would; the public page is served
//            from docs/remote/ for https://kwy404.github.io/hivedesk/remote/ (its CSP applies), and the
//            public MQTT brokers are answered by test/phone/broker.js, so the real relay, WebRTC, handshake
//            and session code runs without the internet.
// Steps: scan, compare words, accept with grants, send a request, see the job start, approve its brief,
// approve a step, chat, ask for the remote screen, see it and send input. Screenshots go to the folder in
// argv[2] (default: the OS temp folder). Not part of the unit tests: node test/phone/e2e-phone.mjs [dir]
// Env: HIVEDESK_BROWSER (path to Edge or Chrome).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startHive } from '../../src/index.js';
import registerPhone from '../../src/phone/index.js';
import registerRemote from '../../src/remote/index.js';
import { FakeHelper } from '../remote/inproc-port.js';
import { createBroker } from './broker.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DOCS = path.join(ROOT, 'docs');
const candidates = [process.env.HIVEDESK_BROWSER, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', '/usr/bin/microsoft-edge', '/usr/bin/google-chrome'].filter(Boolean);
const browserPath = candidates.find((p) => fs.existsSync(p));
if (!browserPath) { console.error('no Edge or Chrome found; set HIVEDESK_BROWSER'); process.exit(2); }
const out = process.argv[2] || path.join(os.tmpdir(), 'hivedesk-phone-e2e');
const calm = (p) => p.evaluate(() => document.querySelector('.toasts')?.replaceChildren());
fs.mkdirSync(out, { recursive: true });

const failures = [];
const check = (ok, label) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`); if (!ok) failures.push(label); };
const waitFor = async (fn, ms = 20000, label = 'condition') => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hivedesk-phone-e2e-'));
const app = await startHive({ dir, demo: true, demoDelayMs: 120, demoApproveMs: 0, autoStartDemo: false });
const helper = new FakeHelper();
const phone = await registerPhone({ bus: app.bus, server: app.server, home: app.home, p2p: app.p2p, hostName: () => 'Studio PC', run: (type, data) => app.server.runCommand(type, data, null, { kind: 'user' }) });
// The remote screen module on the phone port. The native input helper is the recording fake, so this test never moves the real mouse.
const remote = registerRemote({ bus: app.bus, server: app.server, p2p: phone.port, home: app.home, support: { view: true, control: true, kind: 'win-input', hotkey: true, indicator: true, reason: null }, startHelper: () => helper, clipboardProvider: null });

const browser = await chromium.launch({
  executablePath: browserPath, headless: true,
  args: ['--no-first-run', '--no-default-browser-check', '--disable-features=WebRtcHideLocalIpsWithMdns', '--use-fake-ui-for-media-stream']
});
const broker = createBroker();
const errors = [];
let desk;
let ph;
try {
  // ---------- desktop window ----------
  const dctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await dctx.routeWebSocket(/^wss:\/\/(broker\.emqx\.io|test\.mosquitto\.org|broker\.hivemq\.com|broker-cn\.emqx\.io)/, (ws) => broker.attach(ws));
  desk = await dctx.newPage();
  desk.on('pageerror', (e) => errors.push(`desktop: ${e.message}`));
  await desk.goto(`${app.url}&view=desktop&notour=1`, { waitUntil: 'load' });
  await desk.waitForFunction(() => document.querySelector('.dock, #dock, [data-dock]') || document.body.children.length > 3, null, { timeout: 20000 });
  await desk.evaluate(async () => {
    (await import('/remote/index.js')).install();
    (await import('/phone/desktop.js')).install();
    window.hivedeskPhone.open();
  });
  await desk.click('[data-phone-show]');
  const url = await (await desk.waitForSelector('[data-invite-url]')).getAttribute('data-invite-url');
  check(url.startsWith('https://kwy404.github.io/hivedesk/remote/#p='), 'the QR code encodes the public page with the invite in the fragment');
  await desk.screenshot({ path: path.join(out, 'desktop-qr.png') });

  // ---------- phone ----------
  const pctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block', userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36', locale: 'en-US' });
  await pctx.routeWebSocket(/^wss:\/\/(broker\.emqx\.io|test\.mosquitto\.org|broker\.hivemq\.com|broker-cn\.emqx\.io)/, (ws) => broker.attach(ws));
  const seen = [];
  await pctx.route('https://kwy404.github.io/**', (route) => {
    const u = new URL(route.request().url());
    seen.push(u.pathname + u.search + u.hash);
    let rel = decodeURIComponent(u.pathname.replace(/^\/hivedesk\//, ''));
    if (rel.endsWith('/') || rel === '') rel += 'index.html';
    const file = path.join(DOCS, rel);
    if (!file.startsWith(DOCS) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: 'not found' });
    const type = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' }[path.extname(file)] || 'application/octet-stream';
    return route.fulfill({ status: 200, body: fs.readFileSync(file), headers: { 'content-type': type } });
  });
  pctx.on('request', (r) => { if (!r.url().startsWith('https://kwy404.github.io/') && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) errors.push(`phone requested ${r.url()}`); });
  ph = await pctx.newPage();
  ph.on('pageerror', (e) => errors.push(`phone: ${e.message}`));
  ph.on('console', (m) => { if (m.type() === 'error') errors.push(`phone console: ${m.text()}`); });
  await ph.goto(url, { waitUntil: 'load' });
  await ph.waitForSelector('[data-pair]');
  check(!seen.some((s) => s.includes('p=')), 'the invite never reached the web server');
  check(!(await ph.evaluate(() => location.hash)), 'the invite left the address bar at once');
  await ph.screenshot({ path: path.join(out, 'phone-pair.png') });
  await ph.click('[data-pair]');
  const phoneSas = await (await ph.waitForSelector('[data-sas]', { timeout: 60000 })).getAttribute('data-sas');
  await ph.screenshot({ path: path.join(out, 'phone-pairing.png') });

  // ---------- accept on the desktop ----------
  const deskSas = await (await desk.waitForSelector('[data-sas]', { timeout: 20000 })).getAttribute('data-sas');
  check(deskSas === phoneSas && phoneSas.split(' ').length === 6, 'both screens show the same six words');
  const ticked = await desk.$$eval('[data-grant]', (els) => els.map((e) => [e.getAttribute('data-grant'), e.checked]));
  check(JSON.stringify(ticked) === JSON.stringify([['phone.status', true], ['phone.crew', false], ['phone.approve', false], ['phone.control', false], ['phone.notify', false], ['phone.remote', false]]), 'the accept dialog starts with status on and everything else off');
  await desk.screenshot({ path: path.join(out, 'desktop-accept.png') });
  for (const g of ['phone.crew', 'phone.approve', 'phone.control', 'phone.remote']) await desk.check(`[data-grant="${g}"]`);
  await desk.click('[data-phone-accept]');
  await ph.waitForSelector('nav [data-tab=status]', { timeout: 20000 });
  await ph.waitForSelector('.city', { timeout: 20000 });
  check(phone.hub.phones().length === 1 && phone.hub.phones()[0].online, 'the desktop lists the paired phone as connected');

  // ---------- send a request: the job starts through the refiner ----------
  await ph.click('[data-tab=crew]');
  await ph.fill('#compose', 'Build a small landing page for a bakery');
  await ph.click('[data-send]');
  const job = await waitFor(() => app.bus.state.jobs.find((j) => j.request === 'Build a small landing page for a bakery'), 20000, 'job created');
  check(!!job, 'the request from the phone started a job on the engine');
  await ph.waitForSelector(`[data-job="${job.id}"]`, { timeout: 20000 });
  await waitFor(() => app.bus.state.jobs.find((j) => j.id === job.id)?.status === 'awaiting_brief', 30000, 'brief proposed');
  await ph.waitForSelector(`[data-brief="${job.id}"]`, { timeout: 20000 });
  await calm(ph);
  await ph.evaluate(() => scrollTo(0, 0));
  await ph.screenshot({ path: path.join(out, 'phone-status.png') });
  await ph.click(`[data-brief="${job.id}"]`);
  check(true, 'the phone approved the brief');

  // ---------- approve a step ----------
  const ap = await waitFor(() => app.bus.state.approvals.find((a) => a.jobId === job.id), 60000, 'approval requested');
  await ph.click('[data-tab=approvals]');
  await ph.waitForSelector(`[data-approve="${ap.id}"]`, { timeout: 20000 });
  await ph.evaluate(() => document.querySelector('.ap details')?.setAttribute('open', ''));
  await calm(ph);
  await ph.screenshot({ path: path.join(out, 'phone-approval.png') });
  await ph.click(`[data-approve="${ap.id}"]`);
  await waitFor(() => !app.bus.state.approvals.some((a) => a.id === ap.id), 15000, 'approval resolved');
  check(true, 'a step was approved from the phone');
  const entries = app.p2p.node().audit.tail(300).map((x) => x.entry);
  check(entries.some((e) => e.type === 'phone.cmd' && e.op === 'approval.resolve' && e.ok), 'the audit log records the approval from the phone');

  // ---------- chat ----------
  await ph.click('[data-tab=crew]');
  await ph.click('.seg button:nth-child(2)');
  await ph.fill('#compose', 'Use warm colors, please.');
  await ph.click('[data-send]');
  await waitFor(() => app.bus.state.chat.general.some((m) => m.text === 'Use warm colors, please.'), 10000, 'chat');
  await ph.waitForFunction(() => [...document.querySelectorAll('.msg.me')].some((m) => m.textContent.includes('warm colors')), null, { timeout: 10000 });
  await ph.waitForTimeout(400);
  await calm(ph);
  await ph.screenshot({ path: path.join(out, 'phone-chat.png') });
  check(true, 'a chat message from the phone reached the crew');

  // ---------- remote screen ----------
  // Never capture the real screen of the machine running the test: the host window's getDisplayMedia gets
  // a synthetic 1920x1080 "monitor" painted from a screenshot of the hivedesk window itself.
  const shot = (await desk.screenshot({ type: 'png' })).toString('base64');
  await desk.evaluate(async (png) => {
    const img = new Image();
    img.src = `data:image/png;base64,${png}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = 1920;
    c.height = 1080;
    const g = c.getContext('2d');
    const paint = () => { g.fillStyle = '#0B0A09'; g.fillRect(0, 0, 1920, 1080); g.drawImage(img, 0, 0, 1920, 1290); };
    paint();
    setInterval(paint, 500);
    navigator.mediaDevices.getDisplayMedia = async () => {
      const stream = c.captureStream(15);
      const track = stream.getVideoTracks()[0];
      const base = track.getSettings.bind(track);
      track.getSettings = () => ({ ...base(), displaySurface: 'monitor', width: 1920, height: 1080 });
      return stream;
    };
  }, shot);
  await ph.click('[data-tab=remote]');
  await ph.click('[data-rd=control]');
  const req = await waitFor(() => remote.desk.snapshot().requests[0], 15000, 'remote request');
  check(req.wants === 'control' && req.name.length > 0, 'the computer sees the phone asking for control');
  // The person at the computer ticks control and accepts in the Stream 6 dialog.
  await desk.waitForSelector('.rd-ask', { timeout: 10000 });
  const boxes = await desk.$$('.rd-ask input[type=checkbox]');
  for (const b of boxes.slice(0, 2)) await b.check();
  await desk.click('.rd-ask .btn-primary');
  await ph.waitForSelector('.rv video', { timeout: 15000 });
  const hasVideo = await ph.waitForFunction(() => { const v = document.querySelector('.rv video'); return v && v.srcObject && v.videoWidth > 0; }, null, { timeout: 30000 }).then(() => true, () => false);
  check(hasVideo, 'the phone shows the computer screen as live video');
  helper.ready();
  helper.lock(false);
  await ph.waitForFunction(() => document.querySelector('.rv.rv-ctl'), null, { timeout: 15000 }).catch(() => {});
  const box = await ph.$('.rv-stage');
  const bb = await box.boundingBox();
  await ph.touchscreen.tap(bb.x + bb.width / 2, bb.y + bb.height / 2);
  await waitFor(() => helper.calls.some((c) => c[0] === 'button'), 8000, 'input reached the helper').then(() => check(true, 'a tap on the phone became a click through the host helper'), () => check(false, 'a tap on the phone became a click through the host helper'));
  await ph.click('.rv-bar .rv-b:nth-child(2)');
  await ph.waitForTimeout(600);
  await calm(ph);
  await ph.screenshot({ path: path.join(out, 'phone-remote.png') });
  await ph.click('.rv-top .rv-b');
  await waitFor(() => remote.desk.snapshot().shares.length === 0, 10000, 'share ended').catch(() => {});

  // ---------- revoke ----------
  await phone.hub.revoke(phone.hub.phones()[0].deviceId);
  await ph.waitForSelector('.err-ico', { timeout: 10000 });
  check(true, 'revoking on the desktop disconnects the phone at once');
} catch (err) {
  failures.push(err.message);
  console.error(err);
  try { await ph?.screenshot({ path: path.join(out, 'phone-failure.png') }); } catch { /* none */ }
  try { await desk?.screenshot({ path: path.join(out, 'desktop-failure.png') }); } catch { /* none */ }
} finally {
  const relevant = errors.filter((e) => !/favicon|net::ERR_|stun:|Failed to load resource/.test(e));
  check(relevant.length === 0, `no page errors${relevant.length ? `: ${relevant.slice(0, 5).join(' | ')}` : ''}`);
  await browser.close();
  remote.close();
  await phone.close();
  await app.close();
}
console.log(`screenshots in ${out}`);
if (failures.length) { console.error(`${failures.length} failed`); process.exit(1); }
console.log('phone e2e passed');
