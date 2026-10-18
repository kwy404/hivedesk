import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { NATIVE_HELPERS, helperHash, verifiedHelper, packagedHelperAllowed } from '../../desktop/native.js';
import { helperSupport, WinHelper } from '../../src/remote/helper.js';
import { X11Helper, parseMonitors, parseLockedHint } from '../../src/remote/x11.js';
import { KEYS } from '../../src/remote/keys.js';
import { flush } from './inproc-port.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HELPERS = path.join(ROOT, 'desktop', 'helpers');

describe('native helpers: the allowlist in desktop/native.js', () => {
  it('lists every file in desktop/helpers/ with its pinned hash', () => {
    for (const f of fs.readdirSync(HELPERS)) {
      const rel = `helpers/${f}`;
      const entry = NATIVE_HELPERS.find((h) => h.file === rel);
      expect(entry, `${rel} is not in NATIVE_HELPERS`).toBeTruthy();
      expect(helperHash(fs.readFileSync(path.join(HELPERS, f), 'utf8'))).toBe(entry.sha256);
    }
  });

  it('verifies the Windows helper and refuses unknown ids and external programs as files', () => {
    expect(verifiedHelper('win-input')).toMatchObject({ ok: true });
    expect(verifiedHelper('evil')).toEqual({ ok: false, code: 'not_listed' });
    expect(verifiedHelper('x11-xdotool')).toEqual({ ok: false, code: 'external' });
  });

  it('a changed helper text no longer matches its hash; line endings do not matter', () => {
    const text = fs.readFileSync(path.join(HELPERS, 'win-input.ps1'), 'utf8');
    const pinned = NATIVE_HELPERS.find((h) => h.id === 'win-input').sha256;
    expect(helperHash(text.replace(/\r?\n/g, '\r\n'))).toBe(pinned);
    expect(helperHash(text + '\nStart-Process calc')).not.toBe(pinned);
  });

  it('packaging takes only listed helper files from desktop/helpers/', () => {
    expect(packagedHelperAllowed('helpers/win-input.ps1')).toBe(true);
    expect(packagedHelperAllowed('helpers\\win-input.ps1')).toBe(true);
    expect(packagedHelperAllowed('helpers/other.exe')).toBe(false);
    expect(packagedHelperAllowed('native.js')).toBe(true);
  });

  it('nothing is bundled for Linux: xdotool and loginctl are external programs', () => {
    for (const h of NATIVE_HELPERS.filter((x) => x.platform === 'linux')) {
      expect(h.file).toBeUndefined();
      expect(h.external).toMatch(/^[a-z]+$/);
    }
  });
});

describe('native helpers: what each system supports', () => {
  const yes = () => true;
  const no = () => false;
  it.each([
    ['win32', {}, yes, { control: true, kind: 'win-input', hotkey: true }],
    ['darwin', {}, yes, { control: false, reason: 'macos_unsigned' }],
    ['linux', { DISPLAY: ':0', XDG_SESSION_TYPE: 'x11' }, yes, { control: true, kind: 'x11-xdotool', hotkey: false, indicator: false }],
    ['linux', { DISPLAY: ':0', XDG_SESSION_TYPE: 'x11' }, no, { control: false, reason: 'no_xdotool' }],
    ['linux', { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' }, yes, { control: false, reason: 'wayland' }],
    ['linux', { XDG_SESSION_TYPE: 'wayland', DISPLAY: ':0' }, yes, { control: false, reason: 'wayland' }],
    ['linux', {}, yes, { control: false, reason: 'no_display' }],
    ['freebsd', {}, yes, { control: false, reason: 'unsupported_os' }]
  ])('%s %j', (platform, env, has, want) => {
    const s = helperSupport({ platform, env, has });
    expect(s.view).toBe(true);
    expect(s).toMatchObject(want);
  });

  it('linux without loginctl gets no control, because the lock state cannot be read', () => {
    const s = helperSupport({ platform: 'linux', env: { DISPLAY: ':0' }, has: (n) => n === 'xdotool' });
    expect(s).toMatchObject({ control: false, reason: 'no_lock_detection' });
  });
});

describe('native helpers: X11 through xdotool and loginctl', () => {
  it('parses xrandr monitors and the LockedHint', () => {
    const mons = parseMonitors('Monitors: 2\n 0: +*DP-1 1920/527x1080/296+0+0  DP-1\n 1: +HDMI-1 2560/597x1440/336+1920+0  HDMI-1\n');
    expect(mons).toEqual([{ x: 0, y: 0, w: 1920, h: 1080, primary: true }, { x: 1920, y: 0, w: 2560, h: 1440, primary: false }]);
    expect(parseLockedHint('yes\n')).toBe(true);
    expect(parseLockedHint('no')).toBe(false);
    expect(parseLockedHint('')).toBe(null);
  });

  it('builds xdotool commands, collapses moves, releases held keys, and fails closed on lock', async () => {
    const calls = [];
    let locked = 'no';
    const execFile = (cmd, args, o, cb) => {
      calls.push([cmd, ...args]);
      if (cmd === 'xrandr') return cb(null, ' 0: +*DP-1 1920/527x1080/296+0+0  DP-1\n');
      if (cmd === 'loginctl') return cb(null, locked);
      return cb(null, '');
    };
    const h = new X11Helper({ execFile, env: { XDG_SESSION_ID: 'c2' }, setInterval: () => ({ unref() {} }), clearInterval: () => {} });
    const events = [];
    h.on('ready', (m) => events.push(['ready', m.displays.length]));
    h.on('lock', (m) => events.push(['lock', m.locked]));
    await flush();
    expect(events).toEqual([['ready', 1], ['lock', false]]);
    h.key(KEYS.ControlLeft, true);
    h.move(10, 10); h.move(20, 20); h.move(30, 30);
    h.button(2, true);
    h.wheel(0, 240);
    await flush();
    const xdo = calls.filter((c) => c[0] === 'xdotool').map((c) => c.slice(1).join(' ')).join(' | ');
    expect(xdo).toMatch(/keydown Control_L/);
    expect(xdo).toMatch(/mousemove 30 30/);
    expect(xdo).toMatch(/mousedown 3/);
    expect(xdo).toMatch(/click --repeat 2 5/);
    locked = 'yes';
    await h._poll();
    await flush();
    expect(events.pop()).toEqual(['lock', true]);
    const after = calls.filter((c) => c[0] === 'xdotool').map((c) => c.slice(1).join(' ')).join(' | ');
    expect(after).toMatch(/keyup Control_L/);
    expect(after).toMatch(/mouseup 3/);
    h.close();
  });

  it('reports an unknown lock state when there is no login session', async () => {
    const execFile = (cmd, args, o, cb) => cb(new Error('no'), '');
    const h = new X11Helper({ execFile, env: {}, setInterval: () => ({ unref() {} }), clearInterval: () => {} });
    const locks = [];
    h.on('lock', (m) => locks.push(m.locked));
    await flush();
    expect(locks[0]).toBe(null);
    h.close();
  });
});

// The real Windows helper, in its -Test mode: no indicator window, no hotkey, no clicks or keys.
// It moves the pointer only to where it already is, so the desktop is not disturbed.
describe.runIf(process.platform === 'win32')('native helpers: the Windows helper process', () => {
  it('starts, reports screens and an unlocked session, answers ping, and exits when stdin closes', async () => {
    const h = new WinHelper({ test: true });
    const got = {};
    const wait = (t) => new Promise((resolve) => { if (got[t]) resolve(got[t]); else h.once(t, resolve); });
    for (const t of ['ready', 'lock', 'pong', 'cursor', 'exit']) h.on(t, (m) => { got[t] = got[t] || m; });
    const ready = await wait('ready');
    expect(ready.test).toBe(true);
    expect(ready.displays.length).toBeGreaterThan(0);
    expect(ready.displays[0].w).toBeGreaterThan(0);
    const lock = await wait('lock');
    expect(lock.locked).toBe(false);
    expect(lock.source).toMatch(/desktop/);
    h.ping();
    await wait('pong');
    h.cursor();
    const at = await wait('cursor');
    h.move(at.x, at.y);
    const again = await new Promise((resolve) => { h.once('cursor', resolve); h.cursor(); });
    expect(again).toMatchObject({ x: at.x, y: at.y });
    h.close();
    const exit = await wait('exit');
    expect(exit.code).toBe(0);
  }, 40000);
});
