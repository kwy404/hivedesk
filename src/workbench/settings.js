// Workbench settings: the `workbench` section of ~/.hivedesk/settings.json (PLAN section 1.4).
// Only this section is read and written here; every other key of the file is kept as it is.
// Writes are a temp file plus a rename, so a crash never leaves half a file.
import fs from 'node:fs';
import path from 'node:path';

export const SETTINGS_VERSION = 1;

export const DEFAULTS = Object.freeze({
  v: SETTINGS_VERSION,
  fontSize: 13,
  lineHeight: 20,
  tabSize: 2,
  insertSpaces: true,
  wordWrap: 'off',
  formatOnSave: true,
  minimap: true,
  lineNumbers: 'on',
  renderWhitespace: 'selection',
  stickyScroll: true,
  theme: 'desk',
  searchExcludes: [],
  projectDiagnostics: true,
  terminal: Object.freeze({ shell: '', fontSize: 13, scrollback: 5000, cursorBlink: true }),
  roots: Object.freeze([])
});

const clampInt = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : d);
const pick = (v, list, d) => (list.includes(v) ? v : d);
const bool = (v, d) => (typeof v === 'boolean' ? v : d);
const GLOB = /^[^\0\n\r]{1,200}$/;

/** A root as stored: an absolute folder the user added with the folder picker. */
function normRoot(r) {
  if (!r || typeof r !== 'object') return null;
  const id = typeof r.id === 'string' && /^r_[a-z0-9]{4,24}$/.test(r.id) ? r.id : null;
  const p = typeof r.path === 'string' && r.path.length < 1024 && !r.path.includes('\0') ? r.path : null;
  if (!id || !p || !path.isAbsolute(p)) return null;
  return { id, path: p, name: String(r.name || path.basename(p) || p).slice(0, 80), addedAt: typeof r.addedAt === 'string' ? r.addedAt : new Date(0).toISOString() };
}

/** Cleans any input into a complete, valid settings object. Unknown keys are dropped. */
export function normalizeSettings(input = {}, base = DEFAULTS) {
  const i = input && typeof input === 'object' ? input : {};
  const t = i.terminal && typeof i.terminal === 'object' ? i.terminal : {};
  const bt = base.terminal || DEFAULTS.terminal;
  const shell = typeof t.shell === 'string' ? t.shell.trim().slice(0, 300) : bt.shell;
  return {
    v: SETTINGS_VERSION,
    fontSize: clampInt(i.fontSize, 8, 32, base.fontSize),
    lineHeight: clampInt(i.lineHeight, 0, 60, base.lineHeight),
    tabSize: clampInt(i.tabSize, 1, 8, base.tabSize),
    insertSpaces: bool(i.insertSpaces, base.insertSpaces),
    wordWrap: pick(i.wordWrap, ['off', 'on', 'bounded', 'wordWrapColumn'], base.wordWrap),
    formatOnSave: bool(i.formatOnSave, base.formatOnSave),
    minimap: bool(i.minimap, base.minimap),
    lineNumbers: pick(i.lineNumbers, ['on', 'off', 'relative'], base.lineNumbers),
    renderWhitespace: pick(i.renderWhitespace, ['none', 'selection', 'boundary', 'all'], base.renderWhitespace),
    stickyScroll: bool(i.stickyScroll, base.stickyScroll),
    theme: pick(i.theme, ['desk', 'hivedesk-dark', 'hivedesk-light'], base.theme),
    searchExcludes: Array.isArray(i.searchExcludes) ? i.searchExcludes.filter((g) => typeof g === 'string' && GLOB.test(g.trim())).map((g) => g.trim()).slice(0, 50) : [...base.searchExcludes],
    projectDiagnostics: bool(i.projectDiagnostics, base.projectDiagnostics),
    terminal: {
      shell: /[\0\n\r]/.test(shell) ? bt.shell : shell,
      fontSize: clampInt(t.fontSize, 8, 32, bt.fontSize),
      scrollback: clampInt(t.scrollback, 500, 50000, bt.scrollback),
      cursorBlink: bool(t.cursorBlink, bt.cursorBlink)
    },
    roots: Array.isArray(i.roots) ? dedupeRoots(i.roots.map(normRoot).filter(Boolean)).slice(0, 20) : [...(base.roots || [])]
  };
}

function dedupeRoots(list) {
  const seen = new Set();
  return list.filter((r) => {
    const k = process.platform === 'win32' ? r.path.toLowerCase() : r.path;
    if (seen.has(k) || seen.has(r.id)) return false;
    seen.add(k);
    seen.add(r.id);
    return true;
  });
}

/** Merges a partial patch (from the Settings tab) onto the current settings. Roots are not patchable here. */
export function patchSettings(current, patch = {}) {
  const p = patch && typeof patch === 'object' ? { ...patch } : {};
  delete p.roots;
  delete p.v;
  const merged = { ...current, ...p, terminal: { ...current.terminal, ...(p.terminal && typeof p.terminal === 'object' ? p.terminal : {}) } };
  return normalizeSettings(merged, current);
}

export class SettingsFile {
  /** @param {string} file absolute path of settings.json */
  constructor(file) {
    this.file = file;
    this.cache = null;
  }

  readAll() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    } catch {
      return {};
    }
  }

  get() {
    this.cache ??= normalizeSettings(this.readAll().workbench || {});
    return this.cache;
  }

  /** Replaces the workbench section (after normalizing) and keeps every other key. */
  set(next) {
    const clean = normalizeSettings(next, DEFAULTS);
    const all = this.readAll();
    all.v ??= 1;
    all.workbench = clean;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${Date.now().toString(36)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2) + '\n');
    fs.renameSync(tmp, this.file);
    this.cache = clean;
    return clean;
  }

  patch(p) {
    return this.set(patchSettings(this.get(), p));
  }
}
