// Ties a running Hive to its window: the shell page, tray, notifications, close to tray, window state,
// project folder and single instance. Works with the native window or, as a fallback, a browser window.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { platformKey } from './platform.js';
import { checkWebview, decideLaunch } from './detect.js';
import { ensureRuntime } from './runtime.js';
import { launchNative, runtimeConfig } from './native.js';
import { WindowStore, MIN } from './state.js';
import { WinDisplays, WorkAreaMax, clampToDisplays, centerIn, workAreaBounds, reachable, validRect } from './workarea.js';
import { lockFile, acquireLock, releaseLock } from './instance.js';
import { openAppWindow, openDefaultBrowser } from './browser.js';
import { desktopStrings, pickLocale } from './strings.js';
import { detectInstall } from './update/layout.js';
import { UpdateService } from './update/service.js';
import { GALLERY, readProfile, writeProfile } from './profile/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });
const SHELL = path.join(HERE, 'shell.html');
const OS_NAME = { win32: 'windows', darwin: 'macos', linux: 'linux' };

/** The only addresses the About panel and the update panel may open. */
export const LINKS = Object.freeze({
  repo: 'https://github.com/kwy404/hivedesk',
  npm: 'https://www.npmjs.com/package/hivedesk',
  site: 'https://kwy404.github.io/hivedesk/',
  github: 'https://github.com/kwy404',
  linkedin: 'https://www.linkedin.com/in/alexandre-silva-173687256/',
  releases: 'https://github.com/kwy404/hivedesk/releases'
});

/** A link id, or the page of one release (only for a valid version). */
export function linkUrl(id, version) {
  if (Object.hasOwn(LINKS, id)) return LINKS[id];
  if (id === 'release' && /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(String(version || ''))) return `${LINKS.releases}/tag/v${version}`;
  return null;
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    let size = 0;
    const parts = [];
    req.on('data', (c) => { size += c.length; if (size <= limit) parts.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8') || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(body));
}

/** Opens a folder in the OS file manager (Explorer, Finder, the Linux default). */
export function revealFolder(dir) {
  const cmd = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  try {
    const child = spawn(cmd, [dir], { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** Only a path inside this server, never another origin ("/", "/lend/?t=..", "/?t=..#w=.."). */
export function safeStart(start) {
  const s = String(start || '/');
  return s.startsWith('/') && !s.startsWith('//') && !s.includes('\\') ? s : '/';
}

/**
 * @param {{
 *   app: { bus: any, server: any, close: () => Promise<void> },
 *   url: string, args: object, dir: string, home: string,
 *   log?: (s: string) => void, progress?: (s: string | null) => void, quit?: () => void,
 *   hidden?: boolean, fallback?: boolean, openFallback?: (url: string) => any, env?: object, version?: string, configLang?: string
 * }} o
 *   openFallback: the CLI's app window opener (returns 'app', 'browser' or a falsy value).
 *   hidden: start the window hidden with no tray and no notifications (tests).
 *   fallback: false never opens a browser (tests).
 */
export async function openDesktop(o) {
  const env = o.env || process.env;
  const log = o.log || (() => {});
  const { bus, server } = o.app;
  const S = await desktopStrings(pickLocale({ env, configLang: o.configLang }));
  const store = new WindowStore(path.join(o.home, 'desktop'));
  const platform = OS_NAME[process.platform] || 'linux';
  const startUrl = new URL(o.url);
  const start = safeStart(startUrl.pathname + startUrl.search + startUrl.hash);
  const token = server.token;
  const key = platformKey();
  // HIVEDESK_DESKTOP_HIDDEN=1: tests of a whole package, invisible (hidden window, no tray, no browser).
  const hidden = !!o.hidden || env.HIVEDESK_DESKTOP_HIDDEN === '1';
  let settings = store.settings();
  // The frame of this run (a change in the menu applies at the next start, like the native style).
  const frame = settings.frame;
  // Windows with the custom frame: maximize onto the work area of the monitor (desktop/workarea.js).
  // o.displays: a display source for tests ({ list(): Promise<Display[] | null>, close() }).
  const workArea = (o.platform || process.platform) === 'win32' && frame !== 'system' && !hidden;
  const displaySource = workArea ? (o.displays || new WinDisplays()) : null;
  const displays = () => (displaySource ? displaySource.list().catch(() => null) : Promise.resolve(null));
  // Asked at once, so the helper is warm and the saved bounds can be checked before the window opens.
  const displaysAtStart = workArea ? displays() : null;
  // Neutralino's window.setSize turns WS_THICKFRAME and WS_MAXIMIZEBOX back on when resizable is true (its
  // default): a sizing border on the borderless window and a native maximize for Win+Up. The custom frame
  // resizes from its own edges, so on Windows every setSize says resizable: false (the style it started with).
  const sizeExtra = workArea ? { resizable: false } : {};
  let wmax = null;
  let native = null;
  let mode = 'none';
  let trayOk = false;
  let focused = true;
  let quitting = false;
  let trayHinted = false;
  let readyResolve;
  const ready = new Promise((r) => { readyResolve = r; });
  const readyInfo = {};

  const lock = lockFile(o.home);
  const lockInfo = { pid: process.pid, port: server.port, token, dir: o.dir };
  if (!hidden) {
    const got = acquireLock(lock, lockInfo);
    if (!got.ok) log(`another hivedesk (pid ${got.existing?.pid}) holds ${lock}`);
  }

  // Updates: off in hidden test runs and with HIVEDESK_NO_UPDATE=1.
  let updates = null;
  if (!hidden && env.HIVEDESK_NO_UPDATE !== '1' && o.version) {
    try {
      const install = detectInstall({ home: o.home, env });
      updates = new UpdateService({ home: o.home, version: o.version, locale: S.locale, install, log, env, requestQuit: () => { quit().catch(() => {}); } });
      updates.on('notice', (n) => { if (install.kind === 'npx') console.log(`  ${S.t('cli.desktop.update.npxLine', { version: n.version })}`); });
      let readyShown = null;
      updates.on('change', (st) => {
        if (st.status === 'ready' && readyShown !== st.version) {
          readyShown = st.version;
          if (!focused) notify(S.t('cli.desktop.notify.updateReady'), S.t('cli.desktop.notify.updateReadyBody', { version: st.version }));
        }
      });
    } catch (err) {
      log(`update: ${err.message}`);
      updates = null;
    }
  }

  const crewPaused = () => {
    const crew = bus.state.crew || [];
    return crew.length > 0 && crew.every((w) => w.paused);
  };
  async function setCrewPaused(paused) {
    for (const w of bus.state.crew || []) {
      if (!!w.paused === paused) continue;
      try { await server.runCommand('crew.update', { workerId: w.id, paused }, null); } catch (err) { log(`pause ${w.id}: ${err.message}`); }
    }
    updateTray();
  }

  async function windowState() {
    if (!native || native.closed) return null;
    try {
      const [size, pos, max, min] = await Promise.all([
        native.call('window.getSize'), native.call('window.getPosition'), native.call('window.isMaximized'), native.call('window.isMinimized')
      ]);
      const bounds = { width: size.width, height: size.height, x: pos.x, y: pos.y };
      // The custom frame on Windows is never natively maximized: a native maximize (Win+Up, the taskbar)
      // turns into the work area maximize here, and "maximized" is the work area state.
      const maximized = wmax ? await wmax.sync({ nativeMax: !!max, minimized: !!min, bounds }) : !!max;
      return { ...bounds, maximized, minimized: !!min };
    } catch {
      return null;
    }
  }
  async function saveState() {
    if (hidden) return;
    const s = await windowState();
    if (!s || s.minimized) return;
    // While maximized the normal bounds are the restore bounds (known for the work area maximize).
    if (s.maximized) store.save(validRect(wmax?.restore) ? { ...wmax.restore, maximized: true } : { maximized: true });
    else store.save({ width: s.width, height: s.height, x: s.x, y: s.y, maximized: false });
  }
  async function toggleMaximize() {
    if (wmax && !wmax.nativeOnly) {
      if (await wmax.toggle()) return;
      log('window: no display information, using the native maximize');
    }
    await native.call((await native.call('window.isMaximized')) ? 'window.unmaximize' : 'window.maximize');
  }
  /** Once the page is up: the saved maximize on the work area, and on macOS and Linux a window kept on its screen. */
  async function placeAfterReady(state) {
    if (hidden || !native || native.closed) return;
    if (wmax) {
      if (wmax.maximized) await wmax.ensure();
      else if (state.maximized && !(await wmax.maximize())) await native.call('window.maximize');
      return;
    }
    // The shell reports the screen it is on (CSS pixels, the runtime's units on macOS and Linux).
    const scr = readyInfo.screen;
    if (frame === 'system' || state.maximized || !validRect(scr)) return;
    const [size, pos] = await Promise.all([native.call('window.getSize'), native.call('window.getPosition')]);
    const b = { x: pos.x, y: pos.y, width: size.width, height: size.height };
    if (!reachable([{ monitor: scr, work: scr }], b)) {
      const c = centerIn(scr, b.width, b.height);
      await native.call('window.move', { x: c.x, y: c.y });
    }
  }

  async function show() {
    if (mode === 'browser') { openAppWindow(o.url, { home: o.home }); return; }
    if (!native || native.closed) return;
    for (const m of ['window.show', 'window.unminimize', 'window.focus']) {
      try { await native.call(m); } catch { /* best effort */ }
    }
  }

  async function quit() {
    if (quitting) return;
    quitting = true;
    try { updates?.applyOnQuit(); } catch (err) { log(`update: ${err.message}`); }
    updates?.stop();
    await saveState();
    store.flush();
    if (!hidden) releaseLock(lock);
    displaySource?.close();
    if (native) await native.exit();
    if (o.quit) o.quit();
  }

  function notify(title, content) {
    if (hidden || !native || native.closed) return;
    native.call('os.showNotification', { title, content: String(content || '').slice(0, 240), icon: 'INFO' }).catch(() => {});
  }

  // While a remote screen share is active (src/remote/), the tray turns red and offers Stop first.
  const remoteSharing = () => { try { return (o.app.remote?.desk?.snapshot?.().shares || []).length > 0; } catch { return false; } };
  const trayIcon = () => (remoteSharing() ? '/resources/icons/trayIconRemote.png' : '/resources/icons/trayIcon.png');
  function trayMenu() {
    return [
      ...(remoteSharing() ? [{ id: 'remoteStop', text: S.t('cli.desktop.tray.remoteStop') }, { id: 'sep0', text: '-' }] : []),
      { id: 'open', text: S.t('cli.desktop.tray.open') },
      { id: 'pause', text: S.t(crewPaused() ? 'cli.desktop.tray.resume' : 'cli.desktop.tray.pause') },
      { id: 'sep1', text: '-' },
      { id: 'folder', text: S.t('cli.desktop.tray.folder') },
      { id: 'sep2', text: '-' },
      { id: 'quit', text: S.t('cli.desktop.tray.quit') }
    ];
  }
  function updateTray() {
    if (!trayOk || !native || native.closed) return;
    native.call('os.setTray', { icon: trayIcon(), menuItems: trayMenu() }).catch(() => {});
  }

  /** Switches the project folder: the same command starts again in the new folder. */
  async function switchProject(dir) {
    const abs = path.resolve(dir);
    store.setSettings({ lastDir: abs });
    log(S.t('cli.desktop.reopen', { dir: abs }));
    const argv = [];
    const raw = process.argv.slice(2);
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] === '--dir') { i++; continue; }
      if (raw[i].startsWith('--dir=')) continue;
      argv.push(raw[i]);
    }
    argv.push('--dir', abs, '--yes');
    await saveState();
    store.flush();
    releaseLock(lock);
    displaySource?.close();
    if (native) await native.exit();
    native = null;
    const child = spawn(process.execPath, [process.argv[1], ...argv], { stdio: 'ignore', detached: true, windowsHide: true, env: { ...process.env, HIVEDESK_DESKTOP: '1' } });
    child.unref();
    quitting = true;
    if (o.quit) o.quit();
  }

  async function pickFolder(title) {
    if (!native || native.closed) return null;
    try {
      const p = await native.call('os.showFolderDialog', { title: title || S.t('cli.desktop.shell.chooseFolder'), defaultPath: o.dir }, 600000);
      return typeof p === 'string' && p ? p : null;
    } catch { return null; }
  }

  // Routes for the shell page (same token rule as the rest of the API: query, header or cookie).
  const shellLabels = () => ({
    menu: S.t('cli.desktop.shell.menu'), chooseFolder: S.t('cli.desktop.shell.chooseFolder'), openFolder: S.t('cli.desktop.tray.folder'),
    closeToTray: S.t('cli.desktop.shell.closeToTray'), systemFrame: S.t('cli.desktop.shell.systemFrame'),
    minimize: S.t('cli.desktop.shell.minimize'), maximize: S.t('cli.desktop.shell.maximize'), restore: S.t('cli.desktop.shell.restore'),
    close: S.t('cli.desktop.shell.close'), pause: S.t('cli.desktop.tray.pause'), resume: S.t('cli.desktop.tray.resume'),
    paused: S.t('cli.desktop.shell.paused'),
    checkUpdates: S.t('cli.desktop.shell.checkUpdates'), autoUpdate: S.t('cli.desktop.shell.autoUpdate'), beta: S.t('cli.desktop.shell.beta'),
    about: S.t('cli.desktop.shell.about'),
    profile: Object.fromEntries(Object.entries(S.table).filter(([k]) => k.startsWith('cli.desktop.profile.')).map(([k, v]) => [k.slice('cli.desktop.profile.'.length), v])),
    update: Object.fromEntries(Object.entries(S.table).filter(([k]) => k.startsWith('cli.desktop.update.') || k.startsWith('cli.desktop.about.')).map(([k, v]) => [k.slice('cli.desktop.'.length), v]))
  });
  const publicState = (extra = {}) => ({
    mode, platform, native: mode === 'native', closeToTray: settings.closeToTray, frame: settings.frame,
    paused: crewPaused(), dir: o.dir, dirName: path.basename(o.dir), ...extra
  });
  server.route('GET', '/api/desktop/shell', (req, res) => {
    const html = fs.readFileSync(SHELL, 'utf8');
    const cfg = {
      start, platform, native: mode === 'native', strings: shellLabels(), min: MIN, state: publicState({ maximized: !!wmax?.maximized }), version: o.version || '', locale: S.locale,
      update: updates ? updates.state() : null,
      // First run (the DMG and the Linux packages have no installer wizard): ask for a name and an avatar once.
      profile: { needed: !hidden && !readProfile(o.home) && !settings.profileAsked, gallery: GALLERY.avatars, nameMax: 32 }
    };
    const body = html
      .replace('{{LANG}}', S.locale)
      .replace('{{PLATFORM}}', platform === 'macos' ? 'mac' : platform)
      .replace('{{CONFIG}}', JSON.stringify(cfg).replace(/</g, '\\u003c'));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
    res.end(body);
  });
  server.route('GET', '/api/desktop/state', async (req, res) => {
    const s = await windowState();
    json(res, 200, publicState({ maximized: !!s?.maximized }));
  });
  server.route('POST', '/api/desktop/focus', async (req, res) => {
    await readBody(req);
    await show();
    json(res, 200, { ok: true, mode });
  });
  server.route('POST', '/api/desktop/ready', async (req, res) => {
    const b = await readBody(req);
    if (b.frame) { readyInfo.frame = b.detail || {}; if (validRect(b.screen)) readyInfo.screen = b.screen; readyResolve(readyInfo); }
    if (b.shell) readyInfo.shell = true;
    json(res, 200, { ok: true });
  });
  server.route('POST', '/api/desktop/window', async (req, res) => {
    const b = await readBody(req);
    if (!native || native.closed) return json(res, 409, { error: 'no native window' });
    try {
      switch (b.op) {
        case 'minimize': await native.call('window.minimize'); break;
        case 'toggleMaximize': await toggleMaximize(); await saveState(); break;
        case 'close': await onClose(); break;
        case 'move': if (Number.isFinite(b.x) && Number.isFinite(b.y)) await native.call('window.move', { x: Math.round(b.x), y: Math.round(b.y) }); break;
        case 'bounds':
          if ([b.x, b.y, b.width, b.height].every(Number.isFinite)) {
            await native.call('window.setSize', { width: Math.round(b.width), height: Math.round(b.height), ...sizeExtra });
            await native.call('window.move', { x: Math.round(b.x), y: Math.round(b.y) });
          }
          break;
        case 'saveState': await saveState(); break;
        default: return json(res, 400, { error: 'unknown op' });
      }
      json(res, 200, { ok: true });
    } catch (err) {
      json(res, 500, { error: err.message });
    }
  });
  server.route('POST', '/api/desktop/settings', async (req, res) => {
    const b = await readBody(req);
    settings = store.setSettings(b);
    json(res, 200, publicState());
  });
  server.route('GET', '/api/desktop/update', (req, res) => {
    json(res, 200, updates ? updates.state() : { status: 'off' });
  });
  server.route('POST', '/api/desktop/update', async (req, res) => {
    const b = await readBody(req);
    if (!updates) return json(res, 409, { error: 'updates are off in this run' });
    try {
      switch (b.op) {
        case 'check': await updates.check({ manual: true }); break;
        case 'now': updates.updateNow().catch((err) => log(`update: ${err.message}`)); break;
        case 'onClose': updates.onClose(); break;
        case 'later': updates.later(); break;
        case 'retry': updates.download().catch(() => {}); break;
        case 'settings': updates.setSettings({ autoUpdate: b.autoUpdate, channel: b.channel }); break;
        default: return json(res, 400, { error: 'unknown op' });
      }
      json(res, 200, updates.state());
    } catch (err) {
      json(res, 500, { error: err.message });
    }
  });
  server.route('POST', '/api/desktop/link', async (req, res) => {
    const b = await readBody(req);
    const url = linkUrl(b.id, updates?.state().version);
    if (!url) return json(res, 400, { error: 'unknown link' });
    let ok = false;
    if (native && !native.closed) {
      try { await native.call('os.open', { url }); ok = true; } catch { ok = false; }
    }
    if (!ok) ok = !!openDefaultBrowser(url);
    json(res, 200, { ok });
  });
  server.route('POST', '/api/desktop/profile', async (req, res) => {
    const b = await readBody(req);
    if (b.skip === true) { settings = store.setSettings({ profileAsked: true }); return json(res, 200, { ok: true, skipped: true }); }
    try {
      const p = writeProfile(o.home, { name: b.name, avatar: b.avatar });
      settings = store.setSettings({ profileAsked: true });
      json(res, 200, { ok: true, profile: p });
    } catch (err) {
      json(res, 400, { error: err.message });
    }
  });
  server.route('POST', '/api/desktop/crew', async (req, res) => {
    const b = await readBody(req);
    await setCrewPaused(!!b.paused);
    json(res, 200, publicState());
  });
  server.route('POST', '/api/desktop/openFolder', async (req, res) => {
    await readBody(req);
    json(res, 200, { ok: revealFolder(o.dir) });
  });
  server.route('POST', '/api/desktop/project', async (req, res) => {
    const b = await readBody(req);
    const dir = b.choose ? await pickFolder() : null;
    json(res, 200, { ok: !!dir, dir });
    if (dir && path.resolve(dir) !== path.resolve(o.dir)) setTimeout(() => switchProject(dir), 50);
  });
  server.route('POST', '/api/desktop/bridge', async (req, res) => {
    const b = await readBody(req);
    const d = b.data || {};
    switch (b.op) {
      case 'info': return json(res, 200, { result: publicState() });
      case 'openFolder': return json(res, 200, { result: { ok: revealFolder(o.dir) } });
      case 'pickFolder': return json(res, 200, { result: { path: await pickFolder(typeof d.title === 'string' ? d.title : undefined) } });
      case 'pickFile': {
        if (!native || native.closed) return json(res, 200, { result: { paths: [] } });
        const filters = Array.isArray(d.filters) ? d.filters.filter((f) => f && typeof f.name === 'string' && Array.isArray(f.extensions)).slice(0, 8) : undefined;
        try {
          const paths = await native.call('os.showOpenDialog', { title: typeof d.title === 'string' ? d.title : undefined, multiSelections: !!d.multiple, filters }, 600000);
          return json(res, 200, { result: { paths: Array.isArray(paths) ? paths : [] } });
        } catch (err) {
          return json(res, 200, { error: err.message });
        }
      }
      default: return json(res, 400, { error: 'unknown op' });
    }
  });

  async function onClose() {
    if (settings.closeToTray && trayOk && !hidden) {
      await saveState();
      try { await native.call('window.hide'); } catch { /* hidden already */ }
      if (!trayHinted) {
        trayHinted = true;
        notify(S.t('cli.desktop.notify.tray'), S.t('cli.desktop.notify.trayBody'));
      }
      return;
    }
    await quit();
  }

  // Notifications: a job ends or the crew waits for the user, while the window is not in front.
  const workerName = (id) => (bus.state.crew || []).find((w) => w.id === id)?.name || id;
  const offBus = bus.on((ev) => {
    if (hidden || focused) return;
    const d = ev.data || {};
    if (ev.type === 'job.done') notify(S.t('cli.desktop.notify.done'), d.summary || '');
    else if (ev.type === 'job.failed') notify(S.t('cli.desktop.notify.failed'), d.error || '');
    else if (ev.demo) return;
    else if (ev.type === 'approval.requested') notify(S.t('cli.desktop.notify.approval'), `${workerName(d.approval?.workerId)}: ${d.approval?.summary || d.approval?.tool || ''}`);
    else if (ev.type === 'brief.proposed') notify(S.t('cli.desktop.notify.brief'), S.t('cli.desktop.notify.briefBody'));
    else if (ev.type === 'crew.updated') updateTray();
  });
  // The remote screen state changes are live frames (remote.changed): the tray follows them.
  let remoteWas = false;
  const offRemote = bus.onLive?.((type) => {
    if (type !== 'remote.changed' && type !== 'remote.ended') return;
    const now = remoteSharing();
    if (now !== remoteWas) { remoteWas = now; updateTray(); }
  });

  // Decide and open.
  const webview = key ? checkWebview() : { ok: false, reason: 'unsupported' };
  let decision = decideLaunch({ args: o.args, env, key, webview });
  const shellUrl = `http://127.0.0.1:${server.port}/api/desktop/shell?t=${token}`;
  if (decision.mode === 'native') {
    try {
      let shown = false;
      const rt = await ensureRuntime({
        home: o.home, key, appVersion: o.version, env, log,
        onStart: (t) => { o.progress?.(null); console.log(`  ${S.t('cli.desktop.download', { os: S.t(`cli.desktop.os.${t.os}`), arch: t.arch, size: S.bytes(t.bytes) })}`); },
        onProgress: (got, total) => { shown = true; o.progress?.(`  ${S.t('cli.desktop.downloadProgress', { done: S.bytes(got), size: S.bytes(total) })}`); }
      });
      if (shown) { o.progress?.(null); log(S.t('cli.desktop.downloadOk', { size: S.bytes(rt.target.bytes) })); }
      const state = store.load();
      // Windows, custom frame: saved bounds outside every display are moved onto one, and a window saved
      // maximized opens straight on the work area of its monitor with the saved normal bounds to restore.
      let open = state;
      let restoreAtStart = null;
      let workAtStart = null;
      if (workArea) {
        const list = await Promise.race([displaysAtStart, sleep(3000).then(() => null)]);
        if (list) {
          const normal = state.x !== undefined
            ? clampToDisplays(list, { x: state.x, y: state.y, width: state.width, height: state.height }, MIN)
            : centerIn((list.find((d) => d.primary) || list[0]).work, state.width, state.height);
          if (state.x !== undefined) open = { ...state, ...normal };
          if (state.maximized) {
            restoreAtStart = normal;
            workAtStart = workAreaBounds(list, normal);
            if (workAtStart) open = { ...state, ...workAtStart };
          }
        }
      }
      native = await launchNative({
        binary: rt.path, appDir: path.join(o.home, 'desktop', 'app'),
        config: runtimeConfig({ url: shellUrl, state: open, frame, hidden, version: o.version })
      });
      mode = 'native';
      if (workArea) {
        wmax = new WorkAreaMax({ call: (m, d) => native.call(m, d), displays, min: MIN, sizeExtra });
        if (workAtStart) wmax.adopt(restoreAtStart, workAtStart);
      } else if (state.maximized && !hidden && frame !== 'system') {
        // macOS ([NSWindow zoom:] uses the visibleFrame) and Linux (the window manager) keep the dock,
        // the menu bar and the panels free with the native maximize of the borderless window.
        native.call('window.maximize').catch((err) => log(`window: ${err.message}`));
      }
      native.on('windowClose', () => { onClose().catch(() => {}); });
      native.on('windowFocus', () => { focused = true; });
      native.on('windowBlur', () => { focused = false; });
      native.on('trayMenuItemClicked', (item) => {
        const id = item?.id;
        if (id === 'remoteStop') { try { o.app.remote?.stopAll?.('tray'); } catch { /* nothing shared */ } updateTray(); }
        else if (id === 'open') show();
        else if (id === 'pause') setCrewPaused(!crewPaused());
        else if (id === 'folder') revealFolder(o.dir);
        else if (id === 'quit') quit();
      });
      native.on('exit', () => { if (!quitting) { quitting = true; if (!hidden) releaseLock(lock); o.quit?.(); } });
      const timer = new Promise((r) => setTimeout(() => r(null), Number(env.HIVEDESK_READY_MS) || 30000));
      const ok = await Promise.race([ready, timer]);
      if (!ok) throw Object.assign(new Error('not ready'), { code: 'not_ready' });
      try { await placeAfterReady(state); } catch (err) { log(`window: ${err.message}`); }
      if (!hidden) {
        try { await native.call('os.setTray', { icon: trayIcon(), menuItems: trayMenu() }); trayOk = true; } catch (err) { log(`tray: ${err.message}`); }
      }
      log(S.t('cli.desktop.opened'));
    } catch (err) {
      if (native) { native.removeAllListeners('exit'); native.kill(); native = null; }
      decision = { mode: 'browser', reason: err.code === 'unsupported' ? 'unsupported' : err.code === 'checksum' ? 'checksum' : err.code === 'not_ready' ? 'not_ready' : err.code === 'start_failed' ? 'start_failed' : 'download_failed', error: err.message };
    }
  }
  if (decision.mode === 'browser') {
    mode = 'browser';
    o.progress?.(null);
    const reason = S.t(`cli.desktop.reason.${decision.reason}`, { error: decision.error || '' });
    if (decision.reason !== 'forced') log(S.t('cli.desktop.fallback', { reason }));
    if (decision.fix) log(S.t('cli.desktop.fix', { command: decision.fix }));
    if (o.fallback !== false && !hidden) {
      // --browser: the normal browser. Otherwise the app mode window (the CLI may pass its own opener).
      const how = decision.reason === 'forced' ? (openDefaultBrowser(o.url) ? 'browser' : 'none') : (o.openFallback ? o.openFallback(o.url) : openAppWindow(o.url, { home: o.home }));
      if (!how || how === 'none') log(S.t('cli.desktop.browserNone', { url: o.url }));
    }
  }

  // The window (or the browser fallback) is up: this is the first launch health mark of an update.
  if (updates) {
    try { updates.reportHealthy(); } catch (err) { log(`update: ${err.message}`); }
    updates.start();
  }

  // Keep the window state fresh while it is shown (the runtime sends no move events).
  const poll = setInterval(() => { if (focused) saveState().catch(() => {}); }, 5000);
  poll.unref?.();
  const onExit = () => {
    clearInterval(poll);
    store.flush();
    if (!hidden) releaseLock(lock);
    displaySource?.close();
    if (native) native.kill();
  };
  process.once('exit', onExit);

  return {
    mode, decision, readyInfo, ready,
    get native() { return native; },
    show, quit,
    updates,
    async close() {
      offBus();
      offRemote?.();
      updates?.stop();
      clearInterval(poll);
      process.removeListener('exit', onExit);
      store.flush();
      if (!hidden) releaseLock(lock);
      displaySource?.close();
      if (native) await native.exit();
      native = null;
    }
  };
}

