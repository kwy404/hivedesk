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
import { lockFile, acquireLock, releaseLock } from './instance.js';
import { openAppWindow, openDefaultBrowser } from './browser.js';
import { desktopStrings, pickLocale } from './strings.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHELL = path.join(HERE, 'shell.html');
const OS_NAME = { win32: 'windows', darwin: 'macos', linux: 'linux' };

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
      return { width: size.width, height: size.height, x: pos.x, y: pos.y, maximized: !!max, minimized: !!min };
    } catch {
      return null;
    }
  }
  async function saveState() {
    if (hidden) return;
    const s = await windowState();
    if (!s || s.minimized) return;
    if (s.maximized) store.save({ maximized: true });
    else store.save({ width: s.width, height: s.height, x: s.x, y: s.y, maximized: false });
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
    await saveState();
    store.flush();
    if (!hidden) releaseLock(lock);
    if (native) await native.exit();
    if (o.quit) o.quit();
  }

  function notify(title, content) {
    if (hidden || !native || native.closed) return;
    native.call('os.showNotification', { title, content: String(content || '').slice(0, 240), icon: 'INFO' }).catch(() => {});
  }

  function trayMenu() {
    return [
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
    native.call('os.setTray', { icon: '/resources/icons/trayIcon.png', menuItems: trayMenu() }).catch(() => {});
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
    paused: S.t('cli.desktop.shell.paused')
  });
  const publicState = (extra = {}) => ({
    mode, platform, native: mode === 'native', closeToTray: settings.closeToTray, frame: settings.frame,
    paused: crewPaused(), dir: o.dir, dirName: path.basename(o.dir), ...extra
  });
  server.route('GET', '/api/desktop/shell', (req, res) => {
    const html = fs.readFileSync(SHELL, 'utf8');
    const cfg = { start, platform, native: mode === 'native', strings: shellLabels(), min: MIN, state: publicState() };
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
    if (b.frame) { readyInfo.frame = b.detail || {}; readyResolve(readyInfo); }
    if (b.shell) readyInfo.shell = true;
    json(res, 200, { ok: true });
  });
  server.route('POST', '/api/desktop/window', async (req, res) => {
    const b = await readBody(req);
    if (!native || native.closed) return json(res, 409, { error: 'no native window' });
    try {
      switch (b.op) {
        case 'minimize': await native.call('window.minimize'); break;
        case 'toggleMaximize': await native.call((await native.call('window.isMaximized')) ? 'window.unmaximize' : 'window.maximize'); await saveState(); break;
        case 'close': await onClose(); break;
        case 'move': if (Number.isFinite(b.x) && Number.isFinite(b.y)) await native.call('window.move', { x: Math.round(b.x), y: Math.round(b.y) }); break;
        case 'bounds':
          if ([b.x, b.y, b.width, b.height].every(Number.isFinite)) {
            await native.call('window.setSize', { width: Math.round(b.width), height: Math.round(b.height) });
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
      native = await launchNative({
        binary: rt.path, appDir: path.join(o.home, 'desktop', 'app'),
        config: runtimeConfig({ url: shellUrl, state, frame: settings.frame, hidden, version: o.version })
      });
      mode = 'native';
      native.on('windowClose', () => { onClose().catch(() => {}); });
      native.on('windowFocus', () => { focused = true; });
      native.on('windowBlur', () => { focused = false; });
      native.on('trayMenuItemClicked', (item) => {
        const id = item?.id;
        if (id === 'open') show();
        else if (id === 'pause') setCrewPaused(!crewPaused());
        else if (id === 'folder') revealFolder(o.dir);
        else if (id === 'quit') quit();
      });
      native.on('exit', () => { if (!quitting) { quitting = true; if (!hidden) releaseLock(lock); o.quit?.(); } });
      const timer = new Promise((r) => setTimeout(() => r(null), Number(env.HIVEDESK_READY_MS) || 30000));
      const ok = await Promise.race([ready, timer]);
      if (!ok) throw Object.assign(new Error('not ready'), { code: 'not_ready' });
      if (!hidden) {
        try { await native.call('os.setTray', { icon: '/resources/icons/trayIcon.png', menuItems: trayMenu() }); trayOk = true; } catch (err) { log(`tray: ${err.message}`); }
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

  // Keep the window state fresh while it is shown (the runtime sends no move events).
  const poll = setInterval(() => { if (focused) saveState().catch(() => {}); }, 5000);
  poll.unref?.();
  const onExit = () => {
    clearInterval(poll);
    store.flush();
    if (!hidden) releaseLock(lock);
    if (native) native.kill();
  };
  process.once('exit', onExit);

  return {
    mode, decision, readyInfo, ready,
    get native() { return native; },
    show, quit,
    async close() {
      offBus();
      clearInterval(poll);
      process.removeListener('exit', onExit);
      store.flush();
      if (!hidden) releaseLock(lock);
      if (native) await native.exit();
      native = null;
    }
  };
}

