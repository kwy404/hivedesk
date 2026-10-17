// The window state (size, position, maximized) and the desktop settings, kept in ~/.hivedesk/desktop/.
import fs from 'node:fs';
import path from 'node:path';

export const MIN = Object.freeze({ width: 760, height: 520 });
export const DEFAULT = Object.freeze({ width: 1280, height: 820, maximized: false });
export const DEFAULT_SETTINGS = Object.freeze({ closeToTray: true, frame: 'custom', lastDir: null });

const int = (v) => (Number.isFinite(v) ? Math.round(v) : undefined);

/**
 * Cleans a saved state: sizes at least MIN and at most the largest screen we know of,
 * and a position that keeps the title bar reachable (otherwise the window is centered).
 * @param {any} s
 * @param {{ screen?: { width: number, height: number } }} [o]
 */
export function sanitizeState(s, o = {}) {
  const out = { ...DEFAULT };
  if (!s || typeof s !== 'object') return out;
  const maxW = o.screen?.width || 7680;
  const maxH = o.screen?.height || 4320;
  const w = int(s.width);
  const h = int(s.height);
  if (w) out.width = Math.min(Math.max(w, MIN.width), maxW);
  if (h) out.height = Math.min(Math.max(h, MIN.height), maxH);
  out.maximized = s.maximized === true;
  const x = int(s.x);
  const y = int(s.y);
  if (x !== undefined && y !== undefined) {
    // At least 120 px of the title bar on a screen area; y never above the top edge.
    const visible = x + out.width > 120 && x < maxW - 120 && y >= 0 && y < maxH - 40;
    if (visible) { out.x = x; out.y = y; }
  }
  return out;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

/** A small store with a debounced save, so moving the window does not write on every pixel. */
export class WindowStore {
  /** @param {string} dir usually ~/.hivedesk/desktop */
  constructor(dir, { debounceMs = 400 } = {}) {
    this.file = path.join(dir, 'window.json');
    this.settingsFile = path.join(dir, 'settings.json');
    this.debounceMs = debounceMs;
    this.timer = null;
    this.pending = null;
  }

  load(o) { return sanitizeState(readJson(this.file), o); }

  /** Saves later (or now with flush()); ignores sizes under MIN, which only happen while minimized. */
  save(state) {
    if (!state || state.width < MIN.width / 2 || state.height < MIN.height / 2) return false;
    this.pending = { ...this.loadRaw(), ...state };
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.debounceMs);
    this.timer.unref?.();
    return true;
  }

  loadRaw() { return readJson(this.file) || {}; }

  flush() {
    clearTimeout(this.timer);
    if (!this.pending) return;
    const s = this.pending;
    this.pending = null;
    const clean = { width: int(s.width), height: int(s.height), maximized: !!s.maximized };
    if (int(s.x) !== undefined && int(s.y) !== undefined) { clean.x = int(s.x); clean.y = int(s.y); }
    writeJson(this.file, clean);
  }

  settings() {
    const s = readJson(this.settingsFile) || {};
    return {
      closeToTray: typeof s.closeToTray === 'boolean' ? s.closeToTray : DEFAULT_SETTINGS.closeToTray,
      frame: s.frame === 'system' ? 'system' : 'custom',
      lastDir: typeof s.lastDir === 'string' && s.lastDir ? s.lastDir : null
    };
  }

  setSettings(patch) {
    const next = { ...this.settings() };
    if (typeof patch.closeToTray === 'boolean') next.closeToTray = patch.closeToTray;
    if (patch.frame === 'system' || patch.frame === 'custom') next.frame = patch.frame;
    if (typeof patch.lastDir === 'string' && patch.lastDir) next.lastDir = patch.lastDir;
    writeJson(this.settingsFile, next);
    return next;
  }
}
