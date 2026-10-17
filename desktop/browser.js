// The fallback: an app mode browser window (no tabs, no address bar), or the default browser.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

/** Edge or Chrome (or Chromium) on this machine, for an app mode window. */
export function findAppBrowser({ platform = process.platform, env = process.env, exists = fs.existsSync } = {}) {
  const list = [];
  if (platform === 'win32') {
    const roots = [env['PROGRAMFILES(X86)'], env.PROGRAMFILES, env.LOCALAPPDATA, 'C:/Program Files (x86)', 'C:/Program Files'].filter(Boolean);
    for (const r of roots) {
      list.push(path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
      list.push(path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    }
  } else if (platform === 'darwin') {
    for (const r of ['/Applications', path.join(os.homedir(), 'Applications')]) {
      list.push(`${r}/Google Chrome.app/Contents/MacOS/Google Chrome`);
      list.push(`${r}/Microsoft Edge.app/Contents/MacOS/Microsoft Edge`);
      list.push(`${r}/Chromium.app/Contents/MacOS/Chromium`);
    }
  } else {
    const dirs = String(env.PATH || '/usr/bin:/usr/local/bin').split(':');
    for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable']) {
      for (const d of dirs) list.push(path.join(d, name));
    }
  }
  return list.find((p) => exists(p)) || null;
}

/** The default browser, a normal tab. */
export function openDefaultBrowser(url) {
  try {
    const opts = { stdio: 'ignore', detached: true, windowsHide: true };
    let child;
    if (process.platform === 'win32') child = spawn('rundll32', ['url.dll,FileProtocolHandler', url], opts);
    else if (process.platform === 'darwin') child = spawn('open', [url], opts);
    else child = spawn('xdg-open', [url], opts);
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * An app mode window of Edge or Chrome with its own profile under the cache folder, so it opens as a
 * separate window and remembers its size. Falls back to the default browser.
 * @returns {'app' | 'browser' | 'none'}
 */
export function openAppWindow(url, { home, exe = findAppBrowser() } = {}) {
  if (exe) {
    try {
      const profile = path.join(home || path.join(os.homedir(), '.hivedesk'), 'desktop', 'browser-profile');
      fs.mkdirSync(profile, { recursive: true });
      const child = spawn(exe, [`--app=${url}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--window-size=1280,820'], { stdio: 'ignore', detached: true, windowsHide: false });
      child.on('error', () => openDefaultBrowser(url));
      child.unref();
      return 'app';
    } catch { /* fall through */ }
  }
  return openDefaultBrowser(url) ? 'browser' : 'none';
}
