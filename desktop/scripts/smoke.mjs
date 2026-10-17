// Real smoke test of the native window, invisible: the window starts hidden (no taskbar entry, no tray,
// no notifications), loads the shell and the desktop UI from a --demo engine, then everything closes.
// Proof comes from the server side: the shell reports the UI frame loaded, the UI connects its WebSocket,
// and the runtime says the window is not visible. Never opens a browser.
//   node desktop/scripts/smoke.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startHive, cacheHome } from '../../src/index.js';
import { openDesktop } from '../controller.js';
import { ensureRuntime } from '../runtime.js';
import { platformKey } from '../platform.js';

const t0 = Date.now();
const sec = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const key = platformKey();
if (!key) { console.log(`smoke: no desktop runtime for ${process.platform}-${process.arch}`); process.exit(0); }

// The runtime comes from the real cache (downloaded once, checked), like a normal first run.
const rt = await ensureRuntime({ home: cacheHome(), key, appVersion: '0.0.0-smoke', log: (l) => console.log(`  ${l}`) });
console.log(`runtime: ${rt.source} ${rt.path} (${sec()})`);

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hivedesk-smoke-home-'));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hivedesk-smoke-dir-'));
const app = await startHive({ dir, home, demo: true, demoApproveMs: 300 });
const result = { ok: false };
let desk = null;
try {
  desk = await openDesktop({
    app, url: app.url, args: { open: true }, dir, home, hidden: true, fallback: false,
    env: { ...process.env, HIVEDESK_RUNTIME: rt.path, HIVEDESK_READY_MS: '45000' },
    log: (l) => console.log(`  ${l}`), version: '0.0.0'
  });
  result.mode = desk.mode;
  result.decision = desk.decision;
  if (desk.mode !== 'native') throw new Error(`expected the native window, got ${desk.mode}: ${JSON.stringify(desk.decision)}`);
  result.frame = desk.readyInfo.frame;
  console.log(`shell and UI frame loaded (${sec()}): ${JSON.stringify(result.frame)}`);
  const until = Date.now() + 20000;
  while (app.server.clients.size === 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
  result.uiClients = app.server.clients.size;
  console.log(`UI WebSocket clients: ${result.uiClients} (${sec()})`);
  result.visible = await desk.native.call('window.isVisible');
  result.size = await desk.native.call('window.getSize');
  console.log(`window visible: ${result.visible}, size ${result.size.width}x${result.size.height}`);
  // Let the demo job run a moment inside the hidden window, then check the UI asked for its assets.
  await new Promise((r) => setTimeout(r, 3000));
  result.events = app.bus.seq;
  result.ok = result.uiClients > 0 && result.visible === false && !!result.frame && /hivedesk/i.test(result.frame.title || '');
} catch (err) {
  result.error = err.message;
} finally {
  const child = desk?.native?.child;
  if (desk) await desk.close();
  await app.close();
  await new Promise((r) => setTimeout(r, 500));
  result.runtimeExited = !child || child.exitCode !== null || child.signalCode !== null;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(JSON.stringify(result, null, 2));
console.log(result.ok && result.runtimeExited ? `smoke: ok (${sec()})` : 'smoke: FAILED');
process.exit(result.ok && result.runtimeExited ? 0 : 1);
