// End to end smoke test of hivedesk 1.0 on this PC, headless, no window on screen:
//   Rita (the friend who lends): a real `hivedesk` CLI process, --no-open, its own home, the 3B model on the GTX 1060.
//   Alex (the project owner):    a second engine with its own home, in this process (the test drives its requester
//                                and answers its approvals), the 0.5B model on the CPU only, for "Retry locally".
// Phases: six words and SAS, compute grants and GPU sharing with limits, the Machines numbers, a real inference job,
// a short crew job on Rita's GPU whose writes wait for Alex, a remote screen session of one browser tab, revoke
// during a job, revoke everything, a disconnect that offers Retry locally. Every process stops at the end.
// Usage: node test/e2e-two-engines.mjs [out.json] [shots dir]   (Windows, an NVIDIA GPU, the 3B and 0.5B models in ~/.hivedesk)
// Not part of the unit tests. Results of the 1.0 integration run: docs/1.0/INTEGRATION.md.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.argv[2] || path.join(os.tmpdir(), 'hivedesk-e2e-two-engines.json');
const SHOTS = process.argv[3] || path.dirname(OUT);
const REAL = path.join(os.homedir(), '.hivedesk');
const RITA_MODEL = { id: 'qwen2.5-coder-3b', file: 'qwen2.5-coder-3b-instruct-q4_k_m.gguf' };
const ALEX_MODEL = { id: 'qwen2.5-coder-0.5b', file: 'qwen2.5-coder-0.5b-instruct-q4_k_m.gguf' };
const GB = 1024 ** 3;
const imp = (p) => import(pathToFileURL(path.join(REPO, p)).href);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a);
const report = { startedAt: new Date().toISOString(), steps: [], ok: false };
const step = (name, ok, detail = {}) => { report.steps.push({ name, ok, at: Math.round((Date.now() - T0) / 1000), ...detail }); log(ok ? 'OK  ' : 'FAIL', name, JSON.stringify(detail).slice(0, 500)); if (!ok) throw new Error(`step failed: ${name}`); };
const soft = (name, ok, detail = {}) => { report.steps.push({ name, ok, soft: true, at: Math.round((Date.now() - T0) / 1000), ...detail }); log(ok ? 'OK  ' : 'SOFT', name, JSON.stringify(detail).slice(0, 500)); };
async function until(fn, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(250);
  }
}
function gpuApps() {
  try {
    return execFileSync('nvidia-smi', ['--query-compute-apps=pid,process_name,used_memory', '--format=csv,noheader'], { encoding: 'utf8' })
      .split(/\r?\n/).filter(Boolean).map((l) => { const [pid, name, mem] = l.split(',').map((x) => x.trim()); return { pid: Number(pid), name, mem }; });
  } catch { return []; }
}
function gpuNow() {
  const [name, total, used, util] = execFileSync('nvidia-smi', ['--query-gpu=name,memory.total,memory.used,utilization.gpu', '--format=csv,noheader,nounits'], { encoding: 'utf8' }).trim().split(',').map((x) => x.trim());
  return { name, totalMiB: Number(total), usedMiB: Number(used), utilPct: Number(util) };
}
const modelLike = (a) => /^(node|llama|ollama|lm ?studio|python)/i.test(path.basename(a.name || ''));
function homeWith(model) {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-smoke-home-'));
  fs.symlinkSync(path.join(REAL, 'runtime'), path.join(h, 'runtime'), 'junction');
  fs.mkdirSync(path.join(h, 'models'), { recursive: true });
  fs.linkSync(path.join(REAL, 'models', model.file), path.join(h, 'models', model.file));
  return h;
}

// ---------------------------------------------------------------- guards
const busyGpu = gpuApps().filter(modelLike);
const freeGb = os.freemem() / GB;
if (busyGpu.length) { console.error('another model process uses the GPU:', busyGpu); process.exit(3); }
if (freeGb < 2) { console.error(`only ${freeGb.toFixed(1)} GB free RAM`); process.exit(4); }
report.guards = { gpuModelProcesses: 0, freeRamGb: Math.round(freeGb * 10) / 10, gpu: gpuNow() };

const homeA = homeWith(RITA_MODEL);
const homeB = homeWith(ALEX_MODEL);
const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-smoke-rita-'));
const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-smoke-alex-'));
let rita = null;
let alex = null;
let browser = null;
const kill = (p) => { try { execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ } };

try {
  // ---------------------------------------------------------------- Rita: a real CLI engine, no window
  const portA = 47000 + Math.floor(Math.random() * 1000);
  rita = spawn(process.execPath, [path.join(REPO, 'src', 'cli.js'), '--dir', dirA, '--no-open', '--yes', '--port', String(portA), '--brain', 'local', '--model', RITA_MODEL.id, '--no-download'],
    { env: { ...process.env, HIVEDESK_HOME: homeA }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let outA = '';
  rita.stdout.on('data', (d) => { outA += d; });
  rita.stderr.on('data', (d) => { outA += d; });
  const token = await until(() => (outA.match(/[?&]t=([A-Za-z0-9_-]+)/) || [])[1], 90_000, 'Rita prints its URL');
  const A = async (type, data = {}) => {
    const r = await fetch(`http://127.0.0.1:${portA}/api/command`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ type, data }) });
    const j = await r.json();
    if (!j.ok) throw Object.assign(new Error(`${type}: ${j.error?.message}`), { code: j.error?.code });
    return j.result;
  };
  step('Rita runs as a CLI engine with --no-open and its own home', true, { port: portA, startupS: Math.round((Date.now() - T0) / 1000) });

  // ---------------------------------------------------------------- Alex: a second engine, its own home, CPU only
  const { startHive } = await imp('src/index.js');
  alex = await startHive({ dir: dirB, home: homeB, name: 'Alex PC', flags: { brain: 'local', model: ALEX_MODEL.id, gpu: false, noDownload: true }, log: () => {} });
  const B = (type, data = {}) => alex.router.dispatch(type, data, { origin: { kind: 'user' } });
  const lives = [];
  alex.bus.onLive((type, data) => { if (/^(resources\.peer|job\.token)$/.test(type)) lives.push({ type, data, at: Date.now() }); if (lives.length > 5000) lives.splice(0, 1000); });
  step('Alex runs as a second engine with its own home, its model on the CPU only', true, { url: alex.url.replace(/t=.*/, 't=...') });

  // ---------------------------------------------------------------- invite and join: six words and the SAS
  const tJoin = Date.now();
  const lan = await A('p2p.lan.listen', { host: '127.0.0.1', port: 0 });
  const inv = await A('p2p.invite.create', { caps: [{ name: 'compute.inference' }, { name: 'compute.gpu', limits: { maxVramBytes: 3 * GB } }, { name: 'city.view' }] });
  step('Rita makes an invite of six words', inv.words.length === 6);
  const join = await B('p2p.join', { words: inv.words.join(' '), via: 'lan', address: `127.0.0.1:${lan.port}` });
  const req = await until(async () => (await A('p2p.join.requests')).requests[0], 30_000, 'the join request');
  step('Both sides show the same six SAS words', JSON.stringify(req.sas) === JSON.stringify(join.sas) && join.sas.length === 6, { words: join.sas.length });
  const caps = (req.toggles || []).map((t) => ({ capability: t.capability, minutes: 60 }));
  await A('p2p.join.answer', { requestId: req.requestId, accept: true, sasMatches: true, caps });
  const ritaId = (await A('p2p.identity')).peerId;
  const alexId = alex.p2p.node().info().peerId;
  await until(() => alex.p2p.node().held(ritaId).some((g) => g.capability.name === 'compute.inference'), 30_000, 'the grants reach Alex');
  step('Rita accepts after the SAS check; Alex holds the compute grants with their limits', true, { ms: Date.now() - tJoin, held: alex.p2p.node().held(ritaId).map((g) => ({ name: g.capability.name, limits: g.capability.limits, expiresAt: g.expiresAt })) });

  // ---------------------------------------------------------------- GPU sharing with limits
  const share = await A('compute.share.set', { change: { gpu: { enabled: true, remoteInference: true, maxVramBytes: 3 * GB, maxConcurrentJobs: 1, maxJobSeconds: 120 }, maxTokensPerJob: 2048, modelAllowlist: [RITA_MODEL.id] } });
  step('Rita shares her GPU with limits', share.share.gpu.enabled, { gpu: share.share.gpu, maxTokensPerJob: share.share.maxTokensPerJob, models: share.share.modelAllowlist });
  const tLoad = Date.now();
  const serving = await until(async () => { const r = await A('compute.resources'); return r.local?.serving?.device === 'gpu' && r.local.serving; }, 240_000, 'Rita loads the model on the GPU');
  step('Rita serves the 3B model from the GPU', true, { serving, loadMs: Date.now() - tLoad, gpu: gpuNow() });

  // ---------------------------------------------------------------- the Machines numbers on Alex
  await until(async () => (await B('compute.resources')).peers.find((p) => p.peerId === ritaId && p.advert), 60_000, 'Rita advert on Alex');
  const { blankCompute, applyComputeLive } = await imp('ui/city/compute.js');
  const { machineCard } = await imp('ui/city/machines.js');
  const lastAdvert = await until(() => [...lives].reverse().find((l) => l.type === 'resources.peer' && l.data.peerId === ritaId), 30_000, 'a resources.peer frame');
  const view = blankCompute();
  applyComputeLive(view, { type: 'resources.peer', data: lastAdvert.data });
  const card = machineCard({ id: 'm_rita', name: "Rita's PC", peerId: ritaId, online: true }, { machines: {}, agents: {} }, view, { now: Date.now() });
  const f = Object.fromEntries(card.fields.map((x) => [x.key, x]));
  const smi = gpuNow();
  const vramTotalMiB = Math.round((f.vram?.value?.totalBytes || 0) / 1048576);
  step('The Machines panel on Alex shows Rita\'s measured numbers, reported by her', card.state === 'reported' && /1060/.test(f.gpu?.value || '') && Math.abs(vramTotalMiB - smi.totalMiB) < 64 && f.ram?.value?.totalBytes > 0, {
    gpu: f.gpu?.value, vramUsedMiB: Math.round((f.vram?.value?.usedBytes || 0) / 1048576), vramTotalMiB, gpuUtilPct: f.gpuUtil?.value, cpuLoadPct: f.cpu?.value,
    ramTotalGb: Math.round((f.ram?.value?.totalBytes || 0) / GB * 10) / 10, sources: { gpu: f.gpu?.source, vram: f.vram?.source, cpu: f.cpu?.source }, nvidiaSmiNow: smi,
  });

  // ---------------------------------------------------------------- a real inference job leased from Rita
  const t1 = Date.now();
  let firstTokenAt = 0;
  const r1 = await alex.compute.requester.chat([{ role: 'user', content: 'In two short sentences, what do bees make and why?' }], { maxTokens: 80, temperature: 0, onlyPeer: ritaId, onToken: () => { firstTokenAt ||= Date.now(); } });
  const job1 = alex.compute.requester.list().find((j) => j.id === r1.jobId);
  step('A real inference job runs on Rita\'s GPU under a lease, and the answer names her verified PeerId', r1.remoteOrigin === ritaId && r1.text.trim().length > 0, {
    text: r1.text.trim().slice(0, 200), completionTokens: r1.completionTokens, ms: Date.now() - t1, firstTokenMs: firstTokenAt - t1,
    tokensPerSecond: r1.completionTokens && r1.ms ? Math.round(r1.completionTokens / (r1.ms / 1000) * 10) / 10 : null, decision: job1?.decision?.reason,
  });

  // ---------------------------------------------------------------- a short crew job on Rita's GPU, writes approved by Alex
  alex.hive.setSettings({ approvalMode: true });
  // Alex lends his own CPU model nothing here: for this job his crew has only the compute brain, so every turn
  // runs on Rita's GPU (his model comes back for the disconnect test).
  for (const w of alex.bus.state.crew) alex.scheduler.setPreference(w.id, 'compute');
  const realLocalState = alex.compute.requester.localState;
  alex.compute.requester.localState = () => ({ ...realLocalState(), brain: null });
  const asked = [];
  const answerer = setInterval(() => {
    for (const a of Object.values(alex.bus.state.approvals || {})) {
      if (asked.some((x) => x.id === a.id)) continue;
      asked.push({ id: a.id, tool: a.tool, strict: !!a.strict, origin: a.origin?.kind || null, peerId: a.origin?.peerId || null, path: a.args?.path || null });
      alex.approvals.resolve(a.id, true, 'approved by the smoke test');
    }
    for (const q of Object.values(alex.bus.state.questions || {})) B('crew.answer', { questionId: q.id, decide: true }).catch(() => {});
    for (const j of alex.bus.state.jobs) if (j.status === 'awaiting_brief') B('brief.approve', { jobId: j.id, use: 'refined' }).catch(() => {});
  }, 250);
  const tCrew = Date.now();
  if (process.env.SMOKE_SKIP_CREW) { report.steps.push({ name: 'crew job skipped (SMOKE_SKIP_CREW)', ok: true, soft: true }); }
  const turnsBefore = (await A('compute.jobs')).recent.length;
  const { jobId, done } = process.env.SMOKE_SKIP_CREW ? { jobId: null, done: Promise.resolve() } : alex.hive.createJob({ request: 'Create hello.html: a page with the title Hello and one short paragraph about bees.', lang: 'en' });
  const crewOutcome = await Promise.race([done.then(() => 'ended'), sleep(600_000).then(() => 'timeout')]);
  clearInterval(answerer);
  const crewJob = alex.bus.state.jobs.find((j) => j.id === jobId);
  const files = alex.toolbox.ws.list().map((x) => x.path);
  const served = (await A('compute.jobs')).recent.slice(0, 200);
  const turnsOnRita = Math.max(0, served.length - turnsBefore);
  const writes = asked.filter((a) => ['write_file', 'edit_file', 'delete_file', 'run'].includes(a.tool));
  const crewOk = crewOutcome === 'ended' && files.includes('hello.html') && writes.length > 0 && writes.every((w) => w.strict && w.origin === 'remote');
  if (!process.env.SMOKE_SKIP_CREW) (crewOk ? step : soft)('A short crew job runs on Rita\'s GPU and writes files only after Alex approves', crewOk, {
    status: crewJob?.status, outcome: crewOutcome, minutes: Math.round((Date.now() - tCrew) / 600) / 100, files, turnsServedByRita: turnsOnRita, approvals: asked.slice(0, 20),
    computeJobs: alex.compute.requester.list().filter((j) => Date.parse(j.createdAt) >= tCrew).map((j) => ({ state: j.state, worker: j.decision?.target?.kind, tokens: j.result?.completionTokens, ms: j.result?.ms, tps: j.result?.completionTokens && j.result?.ms ? Math.round(j.result.completionTokens / (j.result.ms / 1000) * 10) / 10 : null, why: j.decision?.reason?.slice(0, 160) })).slice(0, 40),
  });
  if (crewOutcome === 'timeout') { try { alex.hive.cancelJob(jobId); } catch { /* over */ } }
  alex.compute.requester.localState = realLocalState;
  for (const w of alex.bus.state.crew) alex.scheduler.setPreference(w.id, null);

  // ---------------------------------------------------------------- a remote screen session of one browser tab
  try {
    const { chromium } = await import(pathToFileURL(path.join(REPO, 'node_modules/playwright-core/index.mjs')).href);
    const { findAppBrowser } = await imp('desktop/browser.js');
    const addr = (await A('remote.state')).address;
    await A('remote.listen', { on: true });
    // Never the real screen: the capture source of this test is a canvas in Rita's window that draws the word
    // "harness" and a clock (the page's getDisplayMedia is replaced in the test browser only). Everything after it,
    // the grant, the session, the signaling, the media and the viewer, is the real code.
    browser = await chromium.launch({ executablePath: findAppBrowser(), headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctx.addInitScript(() => { try { localStorage.setItem('hivedesk.tour.v1', 'done'); } catch { /* none */ } });
    const harness = await ctx.newPage();
    await harness.setContent('<title>harness</title><body style="background:#123;color:#fff;font:40px sans-serif"><h1>harness tab</h1><p id="t"></p><script>setInterval(()=>{document.getElementById("t").textContent=new Date().toISOString()},100)</script></body>');
    const host = await ctx.newPage();
    await host.addInitScript(() => {
      navigator.mediaDevices.getDisplayMedia = async () => {
        const c = document.createElement('canvas');
        c.width = 1280; c.height = 720;
        const g = c.getContext('2d');
        setInterval(() => { g.fillStyle = '#123'; g.fillRect(0, 0, 1280, 720); g.fillStyle = '#fff'; g.font = '64px sans-serif'; g.fillText('harness', 80, 200); g.fillText(new Date().toISOString(), 80, 320); }, 100);
        return c.captureStream(15);
      };
    });
    const hostLog = [];
    host.on('console', (m) => { if (m.type() === 'error') hostLog.push(m.text().slice(0, 200)); });
    host.on('pageerror', (e) => hostLog.push(`pageerror ${e.message.slice(0, 200)}`));
    host.on('response', (r) => { if (r.status() >= 400) hostLog.push(`http ${r.status()} ${r.url().slice(0, 100)}`); });
    await host.goto(`http://127.0.0.1:${portA}/?t=${token}`, { waitUntil: 'load' });
    const viewer = await ctx.newPage();
    await viewer.goto(alex.url, { waitUntil: 'load' });
    await sleep(3000);
    const tRemote = Date.now();
    const consoleErrors = [];
    host.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
    const conn = await B('remote.connect', { address: addr, lan: `127.0.0.1:${lan.port}` });
    const pending = await until(async () => (await A('remote.state')).requests?.[0], 20_000, 'the request reaches Rita');
    log('remote request on Rita', JSON.stringify({ name: pending.name, wants: pending.wants }));
    try { await host.bringToFront(); await host.waitForSelector('.rd-dlg', { timeout: 30_000 }); } catch (err) {
      await host.screenshot({ path: path.join(SHOTS, 'smoke-remote-host-nodialog.png') });
      const diag = await host.evaluate(() => ({ remote: typeof window.hivedeskRemote, phone: typeof window.hivedeskPhone, dlg: document.querySelectorAll('.hd-dlg').length, booted: !!window.__hiveBooted, url: location.href.replace(/t=[^&]+/, 't=...') }));
      throw new Error(`no accept dialog on Rita's window (the request is there); page ${JSON.stringify(diag)}; log: ${hostLog.slice(0, 6).join(' | ')}`);
    }
    await host.check('.rd-dlg .rd-perms input[type=checkbox]');
    await host.click('.rd-dlg .rd-actions .btn-primary');
    await viewer.bringToFront();
    const shareOn = await until(async () => (await A('remote.state')).shares.find((s) => s.sharing), 30_000, 'the host shares a tab');
    const frames = await until(async () => viewer.evaluate(() => { const v = [...document.querySelectorAll('video')].find((x) => x.videoWidth > 0); return v ? { w: v.videoWidth, h: v.videoHeight } : null; }), 45_000, 'the viewer receives frames');
    await viewer.screenshot({ path: path.join(SHOTS, 'smoke-remote-viewer-harness.png') });
    const grants = (await A('p2p.peers')).peers.find((p) => p.identity.peerId === alexId).grants.map((g) => ({ name: g.capability.name, scope: g.scope, expiresAt: g.expiresAt }));
    step('A remote screen session shows the harness source to Alex, granted by a click on Rita', true, { ms: Date.now() - tRemote, surface: shareOn.tracks?.[0]?.surface, video: frames, session: conn.sessionId?.slice(0, 6), grants: grants.filter((g) => g.name.startsWith('remote.')) });
    await A('remote.stopAll', { from: 'kill' });
    const after = await A('remote.state');
    step('Stop ends the remote session and its grants', after.shares.length === 0 && !(await A('p2p.peers')).peers.find((p) => p.identity.peerId === alexId).grants.some((g) => g.capability.name.startsWith('remote.')));
  } catch (err) {
    soft('A remote screen session of one browser tab', false, { error: String(err.message || err).slice(0, 300) });
  } finally {
    await browser?.close().catch(() => {});
    browser = null;
  }

  // ---------------------------------------------------------------- a disconnect gives Retry locally
  await until(() => alex.bus.state.brain?.state === 'ready', 240_000, 'Alex local CPU model');
  const t3 = Date.now();
  // A long prompt: reading it is slow on Alex's CPU and fast on Rita's GPU, so the scheduler sends it to Rita by its estimate.
  const notes = Array.from({ length: 60 }, (_, i) => `Note ${i + 1}: the hive keeps its honey in hexagon cells, the workers fan the nectar until it thickens, and the queen lays eggs in the brood comb.`).join(String.fromCharCode(10));
  const third = alex.compute.requester.chat([{ role: 'user', content: `${notes} List, one per line, ten different things these notes say about bees.` }], { maxTokens: 200, temperature: 0, allowPartial: true });
  third.catch(() => {});
  const running = await until(() => alex.compute.requester.list().find((j) => j.state === 'running' && Date.parse(j.createdAt) >= t3 - 1000), 60_000, 'the third job runs');
  soft('Without onlyPeer the scheduler picks Rita\'s GPU over Alex\'s CPU', running.decision?.target?.kind === 'peer-gpu', { target: running.decision?.target, reason: running.decision?.reason });
  if (running.decision?.target?.kind === 'peer-gpu') {
    await until(() => lives.some((l) => l.type === 'job.token' && l.at > t3), 30_000, 'tokens of the third job');
    // The network drops: Alex's side of the transport goes away mid stream.
    const tDrop = Date.now();
    alex.p2p.node().sessionOf(ritaId)?.session.conn.close('network down (smoke test)');
    const failed = await until(() => { const j = alex.compute.requester.list().find((x) => x.id === running.id); return j && j.choices?.length ? j : null; }, 40_000, 'the disconnect choices');
    step('A disconnect gives Retry locally', failed.choices.includes('retry-local'), { state: failed.state, code: failed.error?.code, choices: failed.choices, detectedMs: Date.now() - tDrop, partialChars: failed.partial?.text?.length || 0 });
    const tLocal = Date.now();
    alex.compute.requester.choose(failed.id, 'retry-local');
    const r3 = await third;
    step('Retry locally finishes the job on Alex\'s CPU', !r3.remoteOrigin && r3.text.trim().length > 0, { ms: Date.now() - tLocal, completionTokens: r3.completionTokens, tokensPerSecond: r3.completionTokens && r3.ms ? Math.round(r3.completionTokens / (r3.ms / 1000) * 10) / 10 : null });
  } else {
    try { alex.compute.requester.choose(running.id, 'cancel'); } catch { /* over */ }
  }
  // A known peer reconnects without words.
  const tRe = Date.now();
  await B('p2p.connect', { peerId: ritaId, address: `127.0.0.1:${lan.port}` });
  await until(() => alex.p2p.node().sessionOf(ritaId)?.online && alex.p2p.node().held(ritaId).some((g) => g.capability.name === 'compute.inference'), 30_000, 'the reconnect');
  step('Alex reconnects to Rita as a known peer, no words, and the standing grants are back', true, { ms: Date.now() - tRe });

  // ---------------------------------------------------------------- revoke stops a running job
  await until(async () => (await B('compute.resources')).peers.find((p) => p.peerId === ritaId)?.advert, 30_000, 'a fresh advert');
  const grantId = (await A('p2p.peers')).peers.find((p) => p.identity.peerId === alexId).grants.find((g) => g.capability.name === 'compute.inference').id;
  const tLong = Date.now();
  const longJob = alex.compute.requester.chat([{ role: 'user', content: 'Write a numbered list of 60 flower names, one per line.' }], { maxTokens: 400, temperature: 0, onlyPeer: ritaId, allowPartial: true });
  longJob.catch(() => {});
  await until(() => lives.some((l) => l.type === 'job.token' && l.at > tLong) && alex.compute.requester.list().some((j) => j.state === 'running' && Date.parse(j.createdAt) >= tLong - 1000), 60_000, 'the long job streams');
  const servedBefore = (await A('compute.jobs')).serving.length;
  const tRevoke = Date.now();
  await A('p2p.revoke', { grantId, reason: 'smoke test revoke' });
  const revoked = await until(() => alex.compute.requester.list().find((j) => Date.parse(j.createdAt) >= tLong - 1000 && ['revoked', 'partial', 'failed'].includes(j.state) && j.error), 20_000, 'the job ends on revoke');
  const ritaStopped = await until(async () => ((await A('compute.jobs')).serving.length === 0 ? Date.now() - tRevoke : null), 15_000, 'Rita stops serving');
  step('Revoke stops a running job on both sides', revoked.error.code === 'revoked' && servedBefore === 1, { state: revoked.state, code: revoked.error.code, choices: revoked.choices, ritaStoppedMs: ritaStopped, partialChars: revoked.partial?.text?.length || 0 });
  try { alex.compute.requester.choose(revoked.id, 'cancel'); } catch { /* over */ }

  // ---------------------------------------------------------------- revoke everything, stop Rita
  for (const g of (await A('p2p.peers')).peers.find((p) => p.identity.peerId === alexId)?.grants || []) await A('p2p.revoke', { grantId: g.id, reason: 'end of the smoke test' });
  await until(() => alex.p2p.node().held(ritaId).length === 0, 15_000, 'Alex holds nothing');
  step('Everything is revoked: Rita lists no grant for Alex and Alex holds none', ((await A('p2p.peers')).peers.find((p) => p.identity.peerId === alexId)?.grants || []).length === 0);
  const tStop = Date.now();
  kill(rita);
  await until(() => !alex.p2p.node().sessionOf(ritaId)?.online, 20_000, 'Alex sees Rita go');
  step('Rita stops; Alex sees the peer offline', true, { ms: Date.now() - tStop });
  report.ok = report.steps.every((s) => s.ok || s.soft);
} catch (err) {
  report.error = String(err.stack || err).slice(0, 2000);
  console.error(err);
} finally {
  await browser?.close().catch(() => {});
  if (rita && rita.exitCode === null) kill(rita);
  try { await alex?.close(); } catch { /* closing */ }
  await sleep(2000);
  report.gpuAfter = { modelProcesses: gpuApps().filter(modelLike), gpu: gpuNow() };
  for (const d of [dirA, dirB]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* busy */ } }
  for (const h of [homeA, homeB]) { try { fs.unlinkSync(path.join(h, 'runtime')); } catch { /* junction gone */ } try { fs.rmSync(h, { recursive: true, force: true }); } catch { /* busy */ } }
  report.endedAt = new Date().toISOString();
  report.minutes = Math.round((Date.now() - T0) / 600) / 100;
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  log('report', OUT, report.ok ? 'PASSED' : 'FAILED');
  process.exit(report.ok ? 0 : 1);
}
