// Runtime detection and the fallback decision, single instance locking, the window state store and the strings.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkWebview, decideLaunch, webkitFix } from '../../desktop/detect.js';
import { acquireLock, releaseLock, readLock, updateLock, focusRunning, isAlive } from '../../desktop/instance.js';
import { WindowStore, sanitizeState, MIN, DEFAULT } from '../../desktop/state.js';
import { BUILTIN_STRINGS, desktopStrings, pickLocale, formatBytes } from '../../desktop/strings.js';
import { safeStart } from '../../desktop/controller.js';
import { runtimeConfig, NATIVE_ALLOW } from '../../desktop/native.js';

describe('web view detection', () => {
  const regOut = 'HKEY_LOCAL_MACHINE\\SOFTWARE\\...\n    pv    REG_SZ    141.0.3537.71\n';
  it('finds WebView2 on Windows through the registry', () => {
    expect(checkWebview({ platform: 'win32', exec: () => regOut })).toEqual({ ok: true, version: '141.0.3537.71' });
  });
  it('explains a missing WebView2 with the one command fix', () => {
    const r = checkWebview({ platform: 'win32', exec: () => { throw new Error('not found'); } });
    expect(r).toMatchObject({ ok: false, reason: 'no_webview2', fix: 'winget install Microsoft.EdgeWebView2Runtime' });
    expect(checkWebview({ platform: 'win32', exec: () => '    pv    REG_SZ    0.0.0.0\n' }).ok).toBe(false);
  });
  it('needs a display and WebKitGTK on Linux', () => {
    expect(checkWebview({ platform: 'linux', env: {} })).toMatchObject({ ok: false, reason: 'no_display' });
    const has = (p) => p === '/usr/lib/x86_64-linux-gnu/libwebkit2gtk-4.1.so.0';
    expect(checkWebview({ platform: 'linux', env: { DISPLAY: ':0' }, exists: has, exec: () => '' })).toEqual({ ok: true });
    const legacy = (p) => p === '/usr/lib64/libwebkit2gtk-4.0.so.37';
    expect(checkWebview({ platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' }, exists: legacy, exec: () => '' }).ok).toBe(true);
    const viaLdconfig = checkWebview({ platform: 'linux', env: { DISPLAY: ':0' }, exists: () => false, exec: () => 'libwebkit2gtk-4.1.so.0 (libc6,x86-64) => /opt/x' });
    expect(viaLdconfig.ok).toBe(true);
    const missing = checkWebview({ platform: 'linux', env: { DISPLAY: ':0' }, exists: () => false, exec: () => '', readFile: () => 'ID=ubuntu\nID_LIKE=debian\n' });
    expect(missing).toMatchObject({ ok: false, reason: 'no_webkitgtk', fix: 'sudo apt install libwebkit2gtk-4.1-0' });
  });
  it('knows the WebKitGTK package of the common distributions', () => {
    expect(webkitFix('ID=fedora')).toBe('sudo dnf install webkit2gtk4.1');
    expect(webkitFix('ID=arch')).toBe('sudo pacman -S webkit2gtk-4.1');
    expect(webkitFix('ID="opensuse-tumbleweed"\nID_LIKE="opensuse suse"')).toBe('sudo zypper install libwebkit2gtk-4_1-0');
    expect(webkitFix('ID=linuxmint\nID_LIKE="ubuntu debian"')).toBe('sudo apt install libwebkit2gtk-4.1-0');
    expect(webkitFix('ID=gentoo')).toMatch(/WebKitGTK 4.1/);
  });
  it('treats macOS as always ready (WebKit ships with it)', () => {
    expect(checkWebview({ platform: 'darwin' })).toEqual({ ok: true });
  });
});

describe('launch decision', () => {
  const ok = { ok: true };
  it('opens the native window when everything is there', () => {
    expect(decideLaunch({ args: { open: true }, env: {}, key: 'win-x64', webview: ok })).toEqual({ mode: 'native' });
  });
  it('opens nothing with --no-open', () => {
    expect(decideLaunch({ args: { open: false, browser: true }, env: {}, key: 'win-x64', webview: ok }).mode).toBe('none');
  });
  it('uses the browser with --browser or HIVEDESK_BROWSER=1', () => {
    expect(decideLaunch({ args: { open: true, browser: true }, env: {}, key: 'win-x64', webview: ok })).toEqual({ mode: 'browser', reason: 'forced' });
    expect(decideLaunch({ args: { open: true }, env: { HIVEDESK_BROWSER: '1' }, key: 'mac-arm64', webview: ok }).mode).toBe('browser');
  });
  it('falls back to the browser with the reason and the fix', () => {
    expect(decideLaunch({ args: { open: true }, env: {}, key: null, webview: ok })).toEqual({ mode: 'browser', reason: 'unsupported' });
    const r = decideLaunch({ args: { open: true }, env: {}, key: 'linux-x64', webview: { ok: false, reason: 'no_webkitgtk', fix: 'sudo apt install libwebkit2gtk-4.1-0' } });
    expect(r).toEqual({ mode: 'browser', reason: 'no_webkitgtk', fix: 'sudo apt install libwebkit2gtk-4.1-0' });
  });
});

describe('single instance lock', () => {
  let dir;
  let file;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-lock-')); file = path.join(dir, 'desktop', 'instance.json'); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const info = (pid) => ({ pid, port: 4000 + pid, token: `tok${pid}`, dir: `/p/${pid}` });

  it('lets one process in and keeps the second out while the first lives', () => {
    expect(acquireLock(file, info(11), { alive: () => true })).toEqual({ ok: true });
    const second = acquireLock(file, info(22), { alive: () => true });
    expect(second.ok).toBe(false);
    expect(second.existing).toMatchObject({ pid: 11, port: 4011, token: 'tok11' });
  });
  it('replaces the lock of a process that is gone', () => {
    acquireLock(file, info(11), { alive: () => true });
    expect(acquireLock(file, info(22), { alive: (pid) => pid !== 11 })).toEqual({ ok: true });
    expect(readLock(file).pid).toBe(22);
  });
  it('replaces a broken lock file', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{not json');
    expect(acquireLock(file, info(22), { alive: () => true })).toEqual({ ok: true });
  });
  it('only the owner releases or updates the lock', () => {
    acquireLock(file, info(11), { alive: () => true });
    expect(releaseLock(file, 22)).toBe(false);
    expect(updateLock(file, { pid: 22, port: 1 })).toBe(false);
    expect(updateLock(file, { pid: 11, port: 5555 })).toBe(true);
    expect(readLock(file).port).toBe(5555);
    expect(releaseLock(file, 11)).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
  });
  it('asks the running instance to come to the front', async () => {
    acquireLock(file, info(11), { alive: () => true });
    const calls = [];
    const fetchImpl = async (url, init) => { calls.push([url, init.headers.authorization]); return { ok: true }; };
    const r = await focusRunning(file, { fetchImpl, alive: () => true });
    expect(r).toMatchObject({ pid: 11 });
    expect(calls).toEqual([['http://127.0.0.1:4011/api/desktop/focus', 'Bearer tok11']]);
  });
  it('forgets a lock whose process is gone or does not answer as hivedesk', async () => {
    acquireLock(file, info(11), { alive: () => true });
    expect(await focusRunning(file, { fetchImpl: async () => ({ ok: true }), alive: () => false })).toBeNull();
    expect(fs.existsSync(file)).toBe(false);
    acquireLock(file, info(12), { alive: () => true });
    expect(await focusRunning(file, { fetchImpl: async () => { throw new Error('ECONNREFUSED'); }, alive: () => true })).toBeNull();
    expect(fs.existsSync(file)).toBe(false);
  });
  it('knows this process is alive and a silly pid is not', () => {
    expect(isAlive(process.pid)).toBe(true);
    expect(isAlive(-5)).toBe(false);
    expect(isAlive(0)).toBe(false);
  });
});

describe('window state store', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-win-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('starts with the default size and centered', () => {
    expect(new WindowStore(dir).load()).toEqual({ ...DEFAULT });
  });
  it('keeps the minimum size and drops positions that are off screen', () => {
    expect(sanitizeState({ width: 200, height: 100, x: 10, y: 10 })).toMatchObject({ width: MIN.width, height: MIN.height, x: 10, y: 10 });
    expect(sanitizeState({ width: 1000, height: 700, x: -5000, y: 10 }).x).toBeUndefined();
    expect(sanitizeState({ width: 1000, height: 700, x: 100, y: -40 }).y).toBeUndefined();
    expect(sanitizeState({ width: 5000, height: 5000, x: 0, y: 0 }, { screen: { width: 1920, height: 1080 } })).toMatchObject({ width: 1920, height: 1080 });
    expect(sanitizeState({ width: 'big', height: null, maximized: 'yes' })).toEqual({ ...DEFAULT });
    expect(sanitizeState(null)).toEqual({ ...DEFAULT });
  });
  it('saves after a pause, and flush writes now', async () => {
    const s = new WindowStore(dir, { debounceMs: 30 });
    expect(s.save({ width: 1100, height: 700, x: 40, y: 50, maximized: false })).toBe(true);
    expect(fs.existsSync(s.file)).toBe(false);
    await new Promise((r) => setTimeout(r, 80));
    expect(new WindowStore(dir).load()).toEqual({ width: 1100, height: 700, x: 40, y: 50, maximized: false });
    s.save({ maximized: true });
    s.flush();
    expect(new WindowStore(dir).load()).toMatchObject({ width: 1100, height: 700, maximized: true });
  });
  it('ignores the tiny sizes a minimized window reports', () => {
    const s = new WindowStore(dir);
    expect(s.save({ width: 160, height: 28, x: -32000, y: -32000 })).toBe(false);
  });
  it('keeps the settings: close to tray on by default, the frame and the last folder', () => {
    const s = new WindowStore(dir);
    expect(s.settings()).toEqual({ closeToTray: true, frame: 'custom', lastDir: null, profileAsked: false });
    s.setSettings({ closeToTray: false, frame: 'system', lastDir: '/work/site', junk: 1 });
    expect(new WindowStore(dir).settings()).toEqual({ closeToTray: false, frame: 'system', lastDir: '/work/site', profileAsked: false });
    s.setSettings({ frame: 'weird' });
    expect(s.settings().frame).toBe('system');
  });
});

describe('desktop strings', () => {
  it('has every key in all 10 languages with the same placeholders', () => {
    const en = BUILTIN_STRINGS.en;
    const holes = (m) => [...String(m).matchAll(/\{(\w+)/g)].map((x) => x[1]).sort().join(',');
    expect(Object.keys(BUILTIN_STRINGS).sort()).toEqual(['de', 'en', 'es', 'fr', 'it', 'ja', 'ko', 'pt-BR', 'ru', 'zh-CN']);
    for (const [loc, table] of Object.entries(BUILTIN_STRINGS)) {
      expect(Object.keys(table).sort(), loc).toEqual(Object.keys(en).sort());
      for (const k of Object.keys(en)) expect(holes(table[k]), `${loc} ${k}`).toBe(holes(en[k]));
    }
  });
  it('says the download line in Portuguese with a local number format', async () => {
    const S = await desktopStrings('pt-BR');
    expect(S.t('cli.desktop.download', { os: S.t('cli.desktop.os.windows'), arch: 'x64', size: S.bytes(2671616) })).toBe('Baixando o app para Windows (x64), 2,7 MB');
    expect(S.t('cli.desktop.tray.open')).toBe('Abrir');
    expect(S.t('cli.desktop.tray.pause')).toBe('Pausar equipe');
    expect(S.t('cli.desktop.tray.quit')).toBe('Sair');
    expect(formatBytes(2671616, 'en')).toBe('2.7 MB');
  });
  it('picks the language from HIVEDESK_LANG, the wizard, then the OS', () => {
    expect(pickLocale({ env: { HIVEDESK_LANG: 'ja' } })).toBe('ja');
    expect(pickLocale({ env: {}, configLang: 'pt' })).toBe('pt-BR');
    expect(pickLocale({ env: { LANG: 'de_DE.UTF-8' } })).toBe('de');
    expect(pickLocale({ env: { LANG: 'zh_TW.UTF-8' } })).toBe('zh-CN');
  });
});

describe('shell and runtime config', () => {
  it('only starts the frame inside this server', () => {
    expect(safeStart('/?t=abc#w=a-b-c-d-e-f')).toBe('/?t=abc#w=a-b-c-d-e-f');
    expect(safeStart('//evil.example/')).toBe('/');
    expect(safeStart('https://evil.example/')).toBe('/');
    expect(safeStart('/\\evil')).toBe('/');
  });
  it('writes a hidden window with no taskbar entry for tests, and a locked down native API', () => {
    const c = runtimeConfig({ url: 'http://127.0.0.1:1/x', state: { width: 1000, height: 700, x: 5, y: 6 }, hidden: true });
    expect(c.modes.window).toMatchObject({ hidden: true, skipTaskbar: true, width: 1000, height: 700, borderless: true, exitProcessOnClose: false });
    expect(c.modes.window.x).toBeUndefined();
    expect(c.tokenSecurity).toBe('one-time');
    expect(NATIVE_ALLOW.some((m) => /execCommand|spawnProcess|filesystem/.test(m))).toBe(false);
    const shown = runtimeConfig({ url: 'http://127.0.0.1:1/x', state: { width: 1000, height: 700, x: 5, y: 6, maximized: true }, frame: 'system' });
    expect(shown.modes.window).toMatchObject({ x: 5, y: 6, maximize: true, borderless: false, hidden: false });
  });
});
