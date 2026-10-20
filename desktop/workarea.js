// The work area maximize of the custom (borderless) frame, and keeping the window on a display.
//
// Why: on Windows the custom frame is a window without WS_CAPTION and WS_THICKFRAME. ShowWindow(SW_MAXIMIZE)
// on such a window fills the whole monitor rectangle, so the taskbar is covered. Instead of the native
// maximize, the controller places the window exactly on rcWork of its monitor and remembers the bounds to
// restore. macOS keeps the native maximize: Neutralino calls [NSWindow zoom:], which uses the screen's
// visibleFrame (no dock, no menu bar) also for a borderless window. Linux keeps gtk_window_maximize, which
// the window manager fits inside the panels (_NET_WORKAREA).
//
// Units. Neutralino 5.6 on Windows makes its process per monitor DPI aware (webview.h setDpi calls
// SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE)), and window.move, window.setSize,
// window.getSize and window.getPosition go straight to MoveWindow, SetWindowPos and GetWindowRect with no
// scaling. So on Windows every value the runtime takes or returns is in physical pixels, at 100, 125 and 150
// percent alike (the shell page multiplies its CSS pixels by devicePixelRatio before it moves the window
// for the same reason). The display helper below asks for per monitor awareness too, so rcWork comes back in
// physical pixels and is used as is. If that request fails (an old Windows, a policy), Windows hands a DPI
// unaware process rectangles scaled to 96 DPI; the display mode (EnumDisplaySettings) always reports the
// real pixels and position of the monitor, so the factor pelsWidth / monitorWidth turns those rectangles
// back into physical pixels (normalizeDisplays). On macOS and Linux the runtime works in points and logical
// pixels and the native maximize is kept, so nothing is converted there.
import { spawn } from 'node:child_process';
import { encodeCommand } from '../src/compute/win-gpu.js';

/** @typedef {{ x: number, y: number, width: number, height: number }} Rect */
/** @typedef {{ monitor: Rect, work: Rect, primary: boolean, scale: number }} Display */

const isNum = Number.isFinite;
export const validRect = (r) => !!r && [r.x, r.y, r.width, r.height].every(isNum) && r.width > 0 && r.height > 0;
const roundRect = (r) => ({ x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) });

/** The area two rectangles share (0 when they do not touch). */
export function overlap(a, b) {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * Turns the helper's answer into displays in physical pixels.
 * A rectangle that came back scaled to 96 DPI (the helper could not get DPI awareness) is mapped onto the
 * real pixels of the display mode: physical = modePosition + (logical - monitorOrigin) * pelsWidth / monitorWidth.
 * @param {any} raw { aware, list: [{ monitor, work, primary, dpi, mode: { x, y, width, height } }] }
 * @returns {Display[]}
 */
export function normalizeDisplays(raw) {
  const list = Array.isArray(raw?.list) ? raw.list : Array.isArray(raw) ? raw : raw?.list ? [raw.list] : [];
  const out = [];
  for (const d of list) {
    if (!validRect(d?.monitor) || !validRect(d?.work)) continue;
    let monitor = roundRect(d.monitor);
    let work = roundRect(d.work);
    const mode = validRect(d.mode) ? d.mode : null;
    const k = mode ? mode.width / monitor.width : 1;
    if (mode && Math.abs(k - 1) > 0.01 && k > 0.2 && k < 8) {
      const map = (r) => roundRect({ x: mode.x + (r.x - monitor.x) * k, y: mode.y + (r.y - monitor.y) * k, width: r.width * k, height: r.height * k });
      work = map(work);
      monitor = map(monitor);
    }
    const dpi = isNum(d.dpi) && d.dpi > 0 ? d.dpi : 96 * (mode && k > 0.2 && k < 8 ? k : 1);
    out.push({ monitor, work, primary: d.primary === true, scale: Math.round((dpi / 96) * 100) / 100 });
  }
  return out;
}

/** Logical (96 DPI) pixels of a display to physical pixels and back, for values the shell page sends in CSS pixels. */
export const toPhysical = (v, scale) => Math.round(v * (scale > 0 ? scale : 1));
export const toLogical = (v, scale) => Math.round(v / (scale > 0 ? scale : 1));

/**
 * The display a window is on, like MonitorFromWindow(MONITOR_DEFAULTTONEAREST): the one sharing the largest
 * area with the window, else the one nearest to its center, else the primary one.
 * @param {Display[]} displays @param {Rect} rect
 */
export function pickDisplay(displays, rect) {
  if (!displays?.length) return null;
  if (!validRect(rect)) return displays.find((d) => d.primary) || displays[0];
  let best = null;
  let bestArea = 0;
  for (const d of displays) {
    const a = overlap(d.monitor, rect);
    if (a > bestArea) { best = d; bestArea = a; }
  }
  if (best) return best;
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  let dist = Infinity;
  for (const d of displays) {
    const m = d.monitor;
    const dx = Math.max(m.x - cx, 0, cx - (m.x + m.width));
    const dy = Math.max(m.y - cy, 0, cy - (m.y + m.height));
    const dd = dx * dx + dy * dy;
    if (dd < dist) { dist = dd; best = d; }
  }
  return best;
}

/** A width x height rectangle in the middle of a work area (never larger than it). */
export function centerIn(work, width, height) {
  const w = Math.round(Math.min(width, work.width));
  const h = Math.round(Math.min(height, work.height));
  return { x: Math.round(work.x + (work.width - w) / 2), y: Math.round(work.y + (work.height - h) / 2), width: w, height: h };
}

/** The bounds of the work area maximize: exactly the work area of the window's display. */
export function workAreaBounds(displays, rect) {
  const d = pickDisplay(displays, rect);
  return d ? { ...d.work } : null;
}

/**
 * True when the title bar of a window is reachable: at least `grab` pixels of its top strip
 * (`bar` pixels high) lie inside the work area of one display.
 */
export function reachable(displays, rect, { bar = 36, grab = 120 } = {}) {
  if (!validRect(rect)) return false;
  const strip = { x: rect.x, y: rect.y, width: rect.width, height: Math.min(bar, rect.height) };
  return displays.some((d) => {
    const w = Math.min(strip.x + strip.width, d.work.x + d.work.width) - Math.max(strip.x, d.work.x);
    const top = rect.y >= d.work.y && rect.y < d.work.y + d.work.height - Math.min(bar, rect.height) / 2;
    return w >= Math.min(grab, rect.width) && top;
  });
}

/**
 * Keeps saved or restored bounds on screen: no larger than the work area of the chosen display, and
 * moved to the center of that work area when the title bar would be off every display.
 * @param {Display[]} displays @param {Rect} rect @param {{ width: number, height: number }} [min]
 * @returns {Rect}
 */
export function clampToDisplays(displays, rect, min = { width: 0, height: 0 }) {
  if (!displays?.length || !validRect(rect)) return rect;
  const d = pickDisplay(displays, rect) || displays[0];
  const wa = d.work;
  const width = Math.max(Math.min(rect.width, wa.width), Math.min(min.width || 0, wa.width));
  const height = Math.max(Math.min(rect.height, wa.height), Math.min(min.height || 0, wa.height));
  let out = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(width), height: Math.round(height) };
  if (!reachable(displays, out)) {
    const home = overlap(d.monitor, rect) > 0 ? d : (displays.find((x) => x.primary) || d);
    out = centerIn(home.work, out.width, out.height);
  }
  return out;
}

/** True when two rectangles are the same within `tol` pixels on every side. */
export function sameRect(a, b, tol = 1) {
  return validRect(a) && validRect(b) && Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol
    && Math.abs(a.width - b.width) <= tol && Math.abs(a.height - b.height) <= tol;
}

// One JSON line per "displays" request. The type is compiled once per helper process.
export const WIN_DISPLAYS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ok = $false
try {
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class HdDisplays {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct MONITORINFOEX { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct DEVMODE {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
    public short dmSpecVersion, dmDriverVersion, dmSize, dmDriverExtra; public int dmFields;
    public int dmPositionX, dmPositionY, dmDisplayOrientation, dmDisplayFixedOutput;
    public short dmColor, dmDuplex, dmYResolution, dmTTOption, dmCollate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
    public short dmLogPixels; public int dmBitsPerPel, dmPelsWidth, dmPelsHeight, dmDisplayFlags, dmDisplayFrequency;
    public int dmICMMethod, dmICMIntent, dmMediaType, dmDitherType, dmReserved1, dmReserved2, dmPanningWidth, dmPanningHeight;
  }
  delegate bool EnumProc(IntPtr hMonitor, IntPtr hdc, IntPtr rect, IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, EnumProc proc, IntPtr data);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFOEX info);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool EnumDisplaySettings(string device, int mode, ref DEVMODE dm);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("shcore.dll")] static extern int SetProcessDpiAwareness(int value);
  [DllImport("shcore.dll")] static extern int GetDpiForMonitor(IntPtr hMonitor, int type, out uint x, out uint y);
  static bool Aware() {
    try { if (SetThreadDpiAwarenessContext(new IntPtr(-4)) != IntPtr.Zero) return true; } catch { }
    try { int hr = SetProcessDpiAwareness(2); if (hr == 0 || hr == unchecked((int)0x80070005)) return true; } catch { }
    try { return SetProcessDPIAware(); } catch { return false; }
  }
  static string R(RECT r) { return "{\"x\":" + r.Left + ",\"y\":" + r.Top + ",\"width\":" + (r.Right - r.Left) + ",\"height\":" + (r.Bottom - r.Top) + "}"; }
  public static string List() {
    bool aware = Aware();
    List<string> items = new List<string>();
    EnumProc proc = delegate (IntPtr h, IntPtr hdc, IntPtr rect, IntPtr data) {
      MONITORINFOEX mi = new MONITORINFOEX(); mi.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));
      if (!GetMonitorInfo(h, ref mi)) return true;
      StringBuilder s = new StringBuilder();
      s.Append("{\"monitor\":").Append(R(mi.rcMonitor)).Append(",\"work\":").Append(R(mi.rcWork));
      s.Append(",\"primary\":").Append((mi.dwFlags & 1) != 0 ? "true" : "false");
      try { uint dx, dy; if (GetDpiForMonitor(h, 0, out dx, out dy) == 0) s.Append(",\"dpi\":").Append(dx); } catch { }
      DEVMODE dm = new DEVMODE(); dm.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE));
      if (EnumDisplaySettings(mi.szDevice, -1, ref dm) && dm.dmPelsWidth > 0)
        s.Append(",\"mode\":{\"x\":" + dm.dmPositionX + ",\"y\":" + dm.dmPositionY + ",\"width\":" + dm.dmPelsWidth + ",\"height\":" + dm.dmPelsHeight + "}");
      s.Append("}");
      items.Add(s.ToString());
      return true;
    };
    EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, proc, IntPtr.Zero);
    GC.KeepAlive(proc);
    return "{\"type\":\"displays\",\"aware\":" + (aware ? "true" : "false") + ",\"list\":[" + String.Join(",", items.ToArray()) + "]}";
  }
}
'@
$ok = $true } catch { }
while (($line = [Console]::In.ReadLine()) -ne $null) {
  $cmd = $line.Trim()
  if ($cmd -eq 'quit') { break }
  if ($cmd -eq 'displays') {
    if ($ok) { try { [Console]::Out.WriteLine([HdDisplays]::List()) } catch { [Console]::Out.WriteLine('{"type":"displays","list":[],"error":"failed"}') } }
    else { [Console]::Out.WriteLine('{"type":"displays","list":[],"error":"no type"}') }
    [Console]::Out.Flush()
  }
}
`;

/**
 * The displays of this PC through one hidden PowerShell process that compiles the type once and stays for
 * `idleMs` after the last request (so a click on Maximize answers in milliseconds, and an idle app holds
 * no extra process). Any failure answers null; the caller then falls back.
 */
export class WinDisplays {
  /** @param {{ spawnImpl?: typeof spawn, exe?: string, idleMs?: number }} [o] */
  constructor(o = {}) {
    this.spawnImpl = o.spawnImpl || spawn;
    this.exe = o.exe || 'powershell.exe';
    this.idleMs = o.idleMs ?? 120000;
    this.proc = null;
    this.waiters = [];
    this.failures = 0;
    this.idle = null;
    this.chain = Promise.resolve();
  }

  _start() {
    if (this.proc || this.failures >= 3) return;
    let proc;
    try {
      proc = this.spawnImpl(this.exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodeCommand(WIN_DISPLAYS_SCRIPT)], {
        windowsHide: true, stdio: ['pipe', 'pipe', 'ignore']
      });
    } catch {
      this.failures = 3;
      return;
    }
    this.proc = proc;
    let buf = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      if (this.proc !== proc) return;
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('{')) continue;
        const w = this.waiters.shift();
        if (!w) continue;
        try { w.resolve(JSON.parse(line)); } catch { w.resolve(null); }
      }
    });
    const dead = () => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.failures++;
      for (const w of this.waiters.splice(0)) w.resolve(null);
    };
    proc.on('error', dead);
    proc.on('exit', dead);
    proc.stdin.on('error', () => { /* gone; exit handles it */ });
    proc.unref?.();
    proc.stdout.unref?.();
    proc.stdin.unref?.();
  }

  /** @returns {Promise<Display[] | null>} */
  list(timeoutMs = 6000) {
    const run = () => new Promise((resolve) => {
      clearTimeout(this.idle);
      this._start();
      if (!this.proc) return resolve(null);
      const w = { resolve: (v) => { clearTimeout(timer); resolve(v); } };
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i !== -1) this.waiters.splice(i, 1);
        this.failures++;
        this.close();
        resolve(null);
      }, timeoutMs);
      timer.unref?.();
      this.waiters.push(w);
      try { this.proc.stdin.write('displays\n'); } catch { w.resolve(null); }
    }).then((raw) => {
      if (this.idleMs > 0) { this.idle = setTimeout(() => this.close(), this.idleMs); this.idle.unref?.(); }
      const list = raw ? normalizeDisplays(raw) : [];
      return list.length ? list : null;
    });
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }

  close() {
    clearTimeout(this.idle);
    const p = this.proc;
    this.proc = null;
    for (const w of this.waiters.splice(0)) w.resolve(null);
    if (p) {
      try { p.stdin.write('quit\n'); p.stdin.end(); } catch { /* gone */ }
      setTimeout(() => { try { p.kill(); } catch { /* gone */ } }, 1000).unref?.();
    }
  }
}

/**
 * The work area maximize of one window. `call` is NativeWindow.call (Neutralino methods), `displays`
 * answers the displays in the runtime's units (or null). maximize() answers false when there is no display
 * information; the caller then uses the native maximize.
 */
export class WorkAreaMax {
  /** @param {{ call: (m: string, d?: object) => Promise<any>, displays: () => Promise<Display[] | null>, min?: { width: number, height: number }, sizeExtra?: object }} o */
  constructor(o) {
    this.call = o.call;
    this.displays = o.displays;
    this.min = o.min || { width: 0, height: 0 };
    this.sizeExtra = o.sizeExtra || {};
    this.maximized = false;
    this.restore = null;
    this.placed = null;
    this.busy = 0;
    this.nativeOnly = false;
  }

  async bounds() {
    const [s, p] = await Promise.all([this.call('window.getSize'), this.call('window.getPosition')]);
    return { x: p.x, y: p.y, width: s.width, height: s.height };
  }

  /** Moves and sizes the window, then reads it back; a second pass when the first did not land (a DPI change on the way). */
  async place(r) {
    let now = null;
    for (let i = 0; i < 2; i++) {
      await this.call('window.move', { x: r.x, y: r.y });
      await this.call('window.setSize', { width: r.width, height: r.height, ...this.sizeExtra });
      now = await this.bounds();
      if (sameRect(now, r)) break;
    }
    return now;
  }

  async _run(fn) {
    this.busy++;
    try { return await fn(); } finally { this.busy--; }
  }

  /** Starts maximized: the saved normal bounds become the restore bounds, the window already sits on `work`. */
  adopt(restore, work) {
    this.maximized = true;
    this.restore = validRect(restore) ? { ...restore } : null;
    this.placed = validRect(work) ? { ...work } : null;
  }

  maximize() {
    return this._run(async () => {
      if (await this.call('window.isMaximized')) await this.call('window.unmaximize');
      const cur = await this.bounds();
      const list = await this.displays();
      const wa = list && workAreaBounds(list, cur);
      if (!wa) return false;
      if (!(this.maximized && this.restore)) this.restore = cur;
      this.maximized = true;
      this.placed = await this.place(wa);
      return true;
    });
  }

  unmaximize() {
    return this._run(async () => {
      const r = this.restore;
      this.maximized = false;
      this.restore = null;
      this.placed = null;
      if (!r) return true;
      const list = await this.displays();
      await this.place(list ? clampToDisplays(list, r, this.min) : r);
      return true;
    });
  }

  toggle() { return this.maximized ? this.unmaximize() : this.maximize(); }

  /** Places the window on the work area again when something moved it while maximized at start (the runtime's first show). */
  async ensure() {
    if (!this.maximized || this.busy) return;
    const now = await this.bounds();
    const list = await this.displays();
    const wa = list && workAreaBounds(list, now);
    if (wa && !sameRect(now, wa)) await this._run(async () => { this.placed = await this.place(wa); });
    else if (wa) this.placed = now;
  }

  /**
   * Follows the real window on each state read. Win+Up, the taskbar or the system menu maximize natively
   * (the whole monitor): that becomes a work area maximize, with the normal placement as restore bounds.
   * A maximized window that the OS or the user moved away from the work area is no longer maximized.
   * @returns {Promise<boolean>} maximized
   */
  async sync({ nativeMax, minimized, bounds }) {
    if (this.busy || minimized) return this.maximized;
    if (!nativeMax) this.nativeOnly = false;
    if (nativeMax && this.nativeOnly) return true;
    if (nativeMax) {
      await this._run(async () => {
        await this.call('window.unmaximize');
        const normal = await this.bounds();
        const list = await this.displays();
        const wa = list && workAreaBounds(list, normal);
        // No display information: give the window back its native maximize and leave it so.
        if (!wa) { this.nativeOnly = true; await this.call('window.maximize'); return; }
        if (!(this.maximized && this.restore)) this.restore = normal;
        this.maximized = true;
        this.placed = await this.place(wa);
      });
      return this.maximized || this.nativeOnly;
    }
    if (this.maximized && this.placed && validRect(bounds) && !sameRect(bounds, this.placed, 2)) {
      this.maximized = false;
      this.restore = null;
      this.placed = null;
    }
    return this.maximized;
  }
}
