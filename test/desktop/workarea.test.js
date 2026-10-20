// The work area maximize of the custom frame: the bounds math, the DPI conversion, restore, the off screen
// clamp, the display helper's protocol and the runtime config.
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  overlap, normalizeDisplays, toPhysical, toLogical, pickDisplay, workAreaBounds, reachable, clampToDisplays,
  centerIn, sameRect, WorkAreaMax, WinDisplays
} from '../../desktop/workarea.js';
import { runtimeConfig } from '../../desktop/native.js';
import { MIN } from '../../desktop/state.js';

// One 1920x1080 monitor with the taskbar at the bottom (40 px at 100 percent).
const ONE = [{ monitor: { x: 0, y: 0, width: 1920, height: 1080 }, work: { x: 0, y: 0, width: 1920, height: 1040 }, primary: true, scale: 1 }];
// Two monitors: the primary as above, and a 2560x1440 one on its right at 150 percent with a 72 px taskbar.
const TWO = [
  ...ONE,
  { monitor: { x: 1920, y: 0, width: 2560, height: 1440 }, work: { x: 1920, y: 0, width: 2560, height: 1368 }, primary: false, scale: 1.5 }
];

describe('displays and DPI', () => {
  it('keeps physical rectangles from a DPI aware helper as they are', () => {
    const raw = { aware: true, list: [{ monitor: { x: 0, y: 0, width: 1920, height: 1080 }, work: { x: 0, y: 0, width: 1920, height: 1040 }, primary: true, dpi: 96, mode: { x: 0, y: 0, width: 1920, height: 1080 } }] };
    expect(normalizeDisplays(raw)).toEqual(ONE);
  });

  it('maps rectangles scaled to 96 DPI back to physical pixels at 125 and 150 percent', () => {
    // 1920x1080 at 125 percent seen by a DPI unaware process: 1536x864, taskbar 32 logical px (40 physical).
    const at125 = normalizeDisplays({ list: [{ monitor: { x: 0, y: 0, width: 1536, height: 864 }, work: { x: 0, y: 0, width: 1536, height: 832 }, primary: true, mode: { x: 0, y: 0, width: 1920, height: 1080 } }] });
    expect(at125[0]).toEqual({ monitor: { x: 0, y: 0, width: 1920, height: 1080 }, work: { x: 0, y: 0, width: 1920, height: 1040 }, primary: true, scale: 1.25 });
    // A secondary 2560x1440 at 150 percent: its own position comes from the display mode.
    const at150 = normalizeDisplays({ list: [{ monitor: { x: 1920, y: 0, width: 1707, height: 960 }, work: { x: 1920, y: 0, width: 1707, height: 912 }, mode: { x: 1920, y: 0, width: 2560, height: 1440 } }] });
    expect(at150[0].monitor).toEqual({ x: 1920, y: 0, width: 2560, height: 1440 });
    expect(at150[0].work).toEqual({ x: 1920, y: 0, width: 2560, height: 1368 });
    expect(at150[0].scale).toBe(1.5);
  });

  it('drops broken entries and accepts a single object', () => {
    expect(normalizeDisplays(null)).toEqual([]);
    expect(normalizeDisplays({ list: [{ monitor: { x: 0, y: 0, width: 0, height: 10 }, work: {} }] })).toEqual([]);
    expect(normalizeDisplays({ list: { monitor: ONE[0].monitor, work: ONE[0].work, primary: true, dpi: 120 } })[0].scale).toBe(1.25);
  });

  it('converts CSS pixels and physical pixels at 100, 125 and 150 percent', () => {
    expect(toPhysical(1280, 1)).toBe(1280);
    expect(toPhysical(1280, 1.25)).toBe(1600);
    expect(toPhysical(1280, 1.5)).toBe(1920);
    expect(toLogical(1040, 1.25)).toBe(832);
    expect(toLogical(1368, 1.5)).toBe(912);
    expect(toPhysical(10, 0)).toBe(10);
  });
});

describe('work area bounds', () => {
  it('is exactly the work area of the monitor the window is on', () => {
    expect(workAreaBounds(ONE, { x: 262, y: 128, width: 1280, height: 820 })).toEqual({ x: 0, y: 0, width: 1920, height: 1040 });
    expect(workAreaBounds(TWO, { x: 2400, y: 100, width: 1280, height: 820 })).toEqual({ x: 1920, y: 0, width: 2560, height: 1368 });
    // Across both: the monitor with the larger share, like MonitorFromWindow.
    expect(workAreaBounds(TWO, { x: 1500, y: 100, width: 1280, height: 820 })).toEqual(TWO[1].work);
    expect(workAreaBounds(TWO, { x: 1000, y: 100, width: 1280, height: 820 })).toEqual(TWO[0].work);
  });

  it('follows a taskbar on the left or at the top', () => {
    const left = [{ ...ONE[0], work: { x: 62, y: 0, width: 1858, height: 1080 } }];
    expect(workAreaBounds(left, { x: 300, y: 50, width: 900, height: 600 })).toEqual({ x: 62, y: 0, width: 1858, height: 1080 });
    const top = [{ ...ONE[0], work: { x: 0, y: 40, width: 1920, height: 1040 } }];
    expect(workAreaBounds(top, { x: 300, y: 50, width: 900, height: 600 })).toEqual({ x: 0, y: 40, width: 1920, height: 1040 });
  });

  it('picks the nearest monitor for a window outside all of them, and the primary without a rectangle', () => {
    expect(pickDisplay(TWO, { x: 9000, y: 100, width: 800, height: 600 })).toBe(TWO[1]);
    expect(pickDisplay(TWO, { x: -3000, y: 100, width: 800, height: 600 })).toBe(TWO[0]);
    expect(pickDisplay(TWO, null)).toBe(TWO[0]);
    expect(pickDisplay([], { x: 0, y: 0, width: 1, height: 1 })).toBeNull();
    expect(overlap({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 10, height: 10 })).toBe(25);
    expect(overlap({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 10, height: 10 })).toBe(0);
  });
});

describe('never off screen', () => {
  it('keeps bounds whose title bar is reachable', () => {
    const r = { x: 262, y: 128, width: 1280, height: 820 };
    expect(reachable(ONE, r)).toBe(true);
    expect(clampToDisplays(ONE, r, MIN)).toEqual(r);
  });

  it('brings back bounds saved on a monitor that is gone, or above the top, or under the taskbar', () => {
    const gone = { x: 2400, y: 100, width: 1280, height: 820 };
    expect(reachable(ONE, gone)).toBe(false);
    expect(clampToDisplays(ONE, gone, MIN)).toEqual({ x: 320, y: 110, width: 1280, height: 820 });
    expect(clampToDisplays(ONE, { x: 100, y: -500, width: 1280, height: 820 }, MIN)).toEqual({ x: 320, y: 110, width: 1280, height: 820 });
    expect(clampToDisplays(ONE, { x: 100, y: 1030, width: 1280, height: 820 }, MIN)).toEqual({ x: 320, y: 110, width: 1280, height: 820 });
    expect(clampToDisplays(ONE, { x: -1250, y: 100, width: 1280, height: 820 }, MIN).x).toBe(320);
  });

  it('shrinks bounds larger than the work area, but not under the minimum the area allows', () => {
    expect(clampToDisplays(ONE, { x: 0, y: 0, width: 2500, height: 1400 }, MIN)).toEqual({ x: 0, y: 0, width: 1920, height: 1040 });
    const small = [{ monitor: { x: 0, y: 0, width: 800, height: 600 }, work: { x: 0, y: 0, width: 800, height: 560 }, primary: true, scale: 1 }];
    expect(clampToDisplays(small, { x: 0, y: 0, width: 1000, height: 700 }, MIN)).toEqual({ x: 0, y: 0, width: 800, height: 560 });
    expect(centerIn({ x: 1920, y: 0, width: 2560, height: 1368 }, 1280, 820)).toEqual({ x: 2560, y: 274, width: 1280, height: 820 });
  });

  it('leaves bounds alone without display information', () => {
    const r = { x: 9000, y: 9000, width: 800, height: 600 };
    expect(clampToDisplays(null, r)).toBe(r);
    expect(sameRect({ x: 0, y: 0, width: 10, height: 10 }, { x: 1, y: 0, width: 10, height: 11 })).toBe(true);
    expect(sameRect({ x: 0, y: 0, width: 10, height: 10 }, { x: 3, y: 0, width: 10, height: 10 })).toBe(false);
  });
});

/** A runtime window: GetWindowRect, MoveWindow, SetWindowPos and a native maximize that covers the monitor. */
function fakeWindow(rect, { monitor = ONE[0].monitor, dpiJump = null } = {}) {
  const w = { rect: { ...rect }, zoomed: false, normal: null, calls: [], sizes: [] };
  w.call = async (m, d = {}) => {
    w.calls.push(m);
    switch (m) {
      case 'window.getSize': return { width: w.rect.width, height: w.rect.height };
      case 'window.getPosition': return { x: w.rect.x, y: w.rect.y };
      case 'window.isMaximized': return w.zoomed;
      case 'window.move': w.rect.x = d.x; w.rect.y = d.y; return {};
      case 'window.setSize':
        w.sizes.push(d);
        w.rect.width = d.width; w.rect.height = d.height;
        // A move to a monitor with another DPI: the first size is scaled by the system once.
        if (dpiJump && w.sizes.length === 1) { w.rect.width = Math.round(d.width * dpiJump); w.rect.height = Math.round(d.height * dpiJump); }
        return {};
      case 'window.maximize': w.normal = { ...w.rect }; w.zoomed = true; w.rect = { ...monitor }; return {};
      case 'window.unmaximize': if (w.zoomed) { w.zoomed = false; w.rect = { ...w.normal }; } return {};
      default: throw new Error(`unexpected ${m}`);
    }
  };
  return w;
}

describe('the work area maximize', () => {
  it('maximizes onto the work area, shows as maximized and restores the bounds it had', async () => {
    const w = fakeWindow({ x: 262, y: 128, width: 1280, height: 820 });
    const max = new WorkAreaMax({ call: w.call, displays: async () => ONE, min: MIN, sizeExtra: { resizable: false } });
    expect(await max.toggle()).toBe(true);
    expect(w.rect).toEqual({ x: 0, y: 0, width: 1920, height: 1040 });
    expect(max.maximized).toBe(true);
    expect(max.restore).toEqual({ x: 262, y: 128, width: 1280, height: 820 });
    expect(w.calls).not.toContain('window.maximize');
    expect(w.sizes.every((s) => s.resizable === false)).toBe(true);
    await max.toggle();
    expect(w.rect).toEqual({ x: 262, y: 128, width: 1280, height: 820 });
    expect(max.maximized).toBe(false);
    expect(max.restore).toBeNull();
  });

  it('uses the monitor the window is on, and restores onto a display when the old place is gone', async () => {
    let list = TWO;
    const w = fakeWindow({ x: 2600, y: 200, width: 1280, height: 820 });
    const max = new WorkAreaMax({ call: w.call, displays: async () => list, min: MIN });
    await max.maximize();
    expect(w.rect).toEqual({ x: 1920, y: 0, width: 2560, height: 1368 });
    list = ONE; // the second monitor was unplugged
    await max.unmaximize();
    expect(reachable(ONE, w.rect)).toBe(true);
    expect(w.rect).toEqual({ x: 320, y: 110, width: 1280, height: 820 });
  });

  it('places again when the first move lands with another size (a DPI change on the way)', async () => {
    const w = fakeWindow({ x: 100, y: 100, width: 1000, height: 700 }, { dpiJump: 1.5 });
    const max = new WorkAreaMax({ call: w.call, displays: async () => ONE });
    await max.maximize();
    expect(w.rect).toEqual(ONE[0].work);
    expect(w.sizes.length).toBe(2);
  });

  it('turns a native maximize (Win+Up, the taskbar) into the work area maximize', async () => {
    const w = fakeWindow({ x: 262, y: 128, width: 1280, height: 820 });
    const max = new WorkAreaMax({ call: w.call, displays: async () => ONE });
    await w.call('window.maximize');
    expect(w.rect).toEqual(ONE[0].monitor); // the whole monitor, taskbar covered
    expect(await max.sync({ nativeMax: true, minimized: false, bounds: w.rect })).toBe(true);
    expect(w.zoomed).toBe(false);
    expect(w.rect).toEqual(ONE[0].work);
    expect(max.restore).toEqual({ x: 262, y: 128, width: 1280, height: 820 });
    await max.toggle();
    expect(w.rect).toEqual({ x: 262, y: 128, width: 1280, height: 820 });
  });

  it('is no longer maximized once the window was moved away, and ignores a minimized window', async () => {
    const w = fakeWindow({ x: 262, y: 128, width: 1280, height: 820 });
    const max = new WorkAreaMax({ call: w.call, displays: async () => ONE });
    await max.maximize();
    expect(await max.sync({ nativeMax: false, minimized: true, bounds: { x: -32000, y: -32000, width: 160, height: 28 } })).toBe(true);
    expect(await max.sync({ nativeMax: false, minimized: false, bounds: ONE[0].work })).toBe(true);
    expect(await max.sync({ nativeMax: false, minimized: false, bounds: { x: 0, y: 0, width: 1000, height: 700 } })).toBe(false);
    expect(max.restore).toBeNull();
  });

  it('starts maximized on the work area with the saved bounds to restore, and fixes a moved first show', async () => {
    const w = fakeWindow({ x: 0, y: 0, width: 1920, height: 1040 });
    const max = new WorkAreaMax({ call: w.call, displays: async () => ONE });
    max.adopt({ x: 262, y: 128, width: 1280, height: 820 }, ONE[0].work);
    w.rect.x = 262; // the runtime's first show moved it
    await max.ensure();
    expect(w.rect).toEqual(ONE[0].work);
    await max.toggle();
    expect(w.rect).toEqual({ x: 262, y: 128, width: 1280, height: 820 });
  });

  it('answers false without display information, and does not loop on a native fallback', async () => {
    const w = fakeWindow({ x: 262, y: 128, width: 1280, height: 820 });
    const max = new WorkAreaMax({ call: w.call, displays: async () => null });
    expect(await max.maximize()).toBe(false);
    expect(max.maximized).toBe(false);
    await w.call('window.maximize');
    expect(await max.sync({ nativeMax: true, minimized: false, bounds: w.rect })).toBe(true);
    expect(max.nativeOnly).toBe(true);
    const before = w.calls.length;
    expect(await max.sync({ nativeMax: true, minimized: false, bounds: w.rect })).toBe(true);
    expect(w.calls.length).toBe(before);
  });
});

/** A fake powershell.exe that answers the helper protocol. */
function fakeSpawn(answer) {
  const procs = [];
  const spawnImpl = (exe, args, opts) => {
    const p = new EventEmitter();
    p.args = args;
    p.opts = opts;
    p.stdout = new EventEmitter();
    p.stdout.setEncoding = () => {};
    p.stdin = new EventEmitter();
    p.lines = [];
    p.stdin.write = (s) => {
      p.lines.push(s);
      if (s === 'displays\n') setImmediate(() => { const a = answer(p); if (a !== undefined) p.stdout.emit('data', a); });
      return true;
    };
    p.stdin.end = () => {};
    p.kill = () => { p.killed = true; p.emit('exit', 0); };
    procs.push(p);
    return p;
  };
  return { spawnImpl, procs };
}

describe('the Windows display helper', () => {
  it('runs one hidden PowerShell with the encoded script and reuses it', async () => {
    const line = JSON.stringify({ type: 'displays', aware: true, list: [{ monitor: ONE[0].monitor, work: ONE[0].work, primary: true, dpi: 96 }] });
    const { spawnImpl, procs } = fakeSpawn(() => `${line}\r\n`);
    const d = new WinDisplays({ spawnImpl, idleMs: 0 });
    expect(await d.list()).toEqual(ONE);
    expect(await d.list()).toEqual(ONE);
    expect(procs.length).toBe(1);
    expect(procs[0].opts.windowsHide).toBe(true);
    expect(procs[0].args).toContain('-EncodedCommand');
    d.close();
    expect(procs[0].lines).toContain('quit\n');
  });

  it('answers null on a broken answer, a timeout or a crash, and stops after three failures', async () => {
    const { spawnImpl, procs } = fakeSpawn((p) => (procs.indexOf(p) === 0 ? '{"type":"displays","list":[],"error":"no type"}\n' : undefined));
    const d = new WinDisplays({ spawnImpl, idleMs: 0 });
    expect(await d.list(200)).toBeNull();
    expect(await d.list(50)).toBeNull(); // no answer: timed out, the process is replaced
    procs.at(-1).emit('exit', 1);
    expect(await d.list(50)).toBeNull();
    const n = procs.length;
    expect(await d.list(50)).toBeNull();
    expect(procs.length).toBeLessThanOrEqual(n + 1);
    d.close();
  });

  it('closes the process after the idle time', async () => {
    const line = JSON.stringify({ list: [{ monitor: ONE[0].monitor, work: ONE[0].work, primary: true }] });
    const { spawnImpl, procs } = fakeSpawn(() => `${line}\n`);
    const d = new WinDisplays({ spawnImpl, idleMs: 20 });
    await d.list();
    await new Promise((r) => setTimeout(r, 60));
    expect(procs[0].lines).toContain('quit\n');
    expect(d.proc).toBeNull();
  });
});

describe('runtime config and the maximize', () => {
  const state = { width: 1280, height: 820, x: 262, y: 128, maximized: true };
  it('never asks the runtime to maximize the custom frame', () => {
    const c = runtimeConfig({ url: 'http://127.0.0.1:1/x', state, frame: 'custom' });
    expect(c.modes.window.maximize).toBeUndefined();
    expect(c.modes.window).toMatchObject({ borderless: true, x: 262, y: 128, width: 1280, height: 820, center: false });
    expect(runtimeConfig({ url: 'http://127.0.0.1:1/x', state }).modes.window.maximize).toBeUndefined();
  });
  it('keeps the native maximize for the system frame', () => {
    const c = runtimeConfig({ url: 'http://127.0.0.1:1/x', state, frame: 'system' });
    expect(c.modes.window).toMatchObject({ maximize: true, borderless: false });
  });
});
