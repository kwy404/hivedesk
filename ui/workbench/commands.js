// Workbench commands and their keyboard shortcuts. One registry feeds the shortcuts, the
// command palette (Ctrl+Shift+P inside the workbench, and Ctrl+K on the desktop) and the menus.
// The key handling is pure (plain event objects in, a chord string out) so it is tested in Node.

const MOD_ORDER = ['Ctrl', 'Alt', 'Shift'];
const NAMES = { ' ': 'Space', Escape: 'Esc', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', '+': 'Plus' };

/** "ctrl+shift+p" -> "Ctrl+Shift+P"; Cmd on a Mac counts as Ctrl. */
export function normalizeChord(text) {
  const parts = String(text).split('+').map((p) => p.trim()).filter(Boolean);
  const mods = new Set();
  let key = '';
  for (const p of parts) {
    const l = p.toLowerCase();
    if (l === 'ctrl' || l === 'cmd' || l === 'meta' || l === 'mod') mods.add('Ctrl');
    else if (l === 'alt' || l === 'option') mods.add('Alt');
    else if (l === 'shift') mods.add('Shift');
    else key = p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1);
  }
  return [...MOD_ORDER.filter((m) => mods.has(m)), key].join('+');
}

/** The chord of a keyboard event ({ key, code, ctrlKey, metaKey, altKey, shiftKey }). */
export function chordOf(e) {
  let key = e.key || '';
  // Use the physical key for letters and digits, so Shift and keyboard layouts do not change it.
  if (/^Key[A-Z]$/.test(e.code || '')) key = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code || '')) key = e.code.slice(5);
  else if (e.code === 'Backquote') key = '`';
  else if (e.code === 'Backslash') key = '\\';
  else if (e.code === 'Comma') key = ',';
  else if (e.code === 'Period') key = '.';
  else if (e.code === 'Slash') key = '/';
  else if (e.code === 'Equal') key = '=';
  else if (e.code === 'Minus') key = '-';
  key = NAMES[key] || (key.length === 1 ? key.toUpperCase() : key);
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(key)) return '';
  const mods = [];
  if (e.ctrlKey || e.metaKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  return [...mods, key].join('+');
}

export class Commands {
  constructor() {
    this.list = new Map();
    this.byChord = new Map();
  }

  /**
   * @param {{ id: string, title: () => string, keys?: string[], run: (arg?: any) => any, when?: () => boolean, group?: string, palette?: boolean }} c
   */
  register(c) {
    const cmd = { palette: true, group: 'workbench', ...c, keys: (c.keys || []).map(normalizeChord) };
    this.list.set(c.id, cmd);
    for (const k of cmd.keys) {
      if (!this.byChord.has(k)) this.byChord.set(k, []);
      this.byChord.get(k).push(cmd);
    }
    return cmd;
  }

  get(id) {
    return this.list.get(id) || null;
  }

  enabled(cmd) {
    try { return !cmd.when || !!cmd.when(); } catch { return false; }
  }

  run(id, arg) {
    const c = this.list.get(id);
    if (!c || !this.enabled(c)) return false;
    c.run(arg);
    return true;
  }

  /** The command a key event triggers, or null. Later registrations win (more specific panels). */
  forEvent(e) {
    const chord = chordOf(e);
    if (!chord) return null;
    const list = this.byChord.get(chord) || [];
    for (let i = list.length - 1; i >= 0; i--) if (this.enabled(list[i])) return list[i];
    return null;
  }

  /** Entries for a palette: enabled commands with a title. */
  entries() {
    return [...this.list.values()].filter((c) => c.palette && this.enabled(c)).map((c) => ({ id: c.id, label: c.title(), keys: c.keys, group: c.group, run: () => c.run() }));
  }
}

/** Splits a quick open query: ">" commands, "#" workspace symbols, "@" symbols in the file, ":" a line, else files. */
export function parseQuickQuery(text) {
  const s = String(text ?? '');
  const m = /^([>#@:])\s*/.exec(s);
  if (!m) return { mode: 'files', q: s.trim() };
  const mode = { '>': 'commands', '#': 'symbols', '@': 'outline', ':': 'line' }[m[1]];
  return { mode, q: s.slice(m[0].length).trim() };
}

/** Fuzzy score of a label for a query (higher is better), with the matched positions, or null. */
export function fuzzy(label, query) {
  const q = String(query || '').toLowerCase();
  if (!q) return { score: 0, marks: [] };
  const t = String(label).toLowerCase();
  const at = t.indexOf(q);
  if (at >= 0) {
    const boundary = at === 0 || /[\s/._-]/.test(t[at - 1]);
    return { score: 1000 - at - t.length / 100 + (boundary ? 200 : 0), marks: [...Array(q.length)].map((_, i) => at + i) };
  }
  let ti = 0;
  const marks = [];
  for (const ch of q) {
    const f = t.indexOf(ch, ti);
    if (f < 0) return null;
    marks.push(f);
    ti = f + 1;
  }
  const spread = marks[marks.length - 1] - marks[0];
  return { score: 500 - spread - t.length / 100, marks };
}

/** Ranks file paths for quick open: the file name counts more than its folders. */
export function rankFiles(paths, query, limit = 60) {
  const q = String(query || '').trim();
  if (!q) return paths.slice(0, limit).map((p) => ({ path: p, marks: [] }));
  const out = [];
  for (const p of paths) {
    const name = p.split('/').pop();
    const n = fuzzy(name, q);
    const f = fuzzy(p, q);
    if (!n && !f) continue;
    const off = p.length - name.length;
    const best = n && (!f || n.score + 300 >= f.score) ? { score: n.score + 300, marks: n.marks.map((i) => i + off) } : f;
    out.push({ path: p, score: best.score, marks: best.marks });
  }
  out.sort((a, b) => b.score - a.score || a.path.length - b.path.length);
  return out.slice(0, limit);
}
