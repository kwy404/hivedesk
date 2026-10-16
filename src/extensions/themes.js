// Themes on the engine side: the built-in files in themes/, the user's own in
// ~/.hivedesk/themes/, themes from enabled extensions, and "create a theme with the crew".
import fs from 'node:fs';
import path from 'node:path';
import { validateTheme, fixContrast, checkContrast, serializeTheme, slug, THEME_SCHEMA, FILE_SUFFIX, BASE } from '../../ui/themes/core.js';

export const BUILTIN_ORDER = ['mel', 'colmeia-clara', 'meia-noite', 'floresta', 'neon', 'papel', 'alto-contraste', 'pixel'];

export class ThemeStore {
  /** @param {{ builtinDir: string, home: string, extensions?: () => { extension: string, data: any }[] }} opts */
  constructor(opts) {
    this.builtinDir = opts.builtinDir;
    this.dir = path.join(opts.home, 'themes');
    this.extensions = opts.extensions || (() => []);
    fs.mkdirSync(this.dir, { recursive: true });
  }

  _read(dir, source) {
    const out = [];
    if (!fs.existsSync(dir)) return out;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const v = validateTheme(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
        if (v.ok) out.push({ ...v.theme, source });
      } catch { /* a broken file is skipped */ }
    }
    return out;
  }

  /** Every theme the gallery shows, built-in first in their fixed order. */
  list() {
    const builtin = this._read(this.builtinDir, 'builtin').sort((a, b) => rank(a.id) - rank(b.id));
    const ids = new Set(builtin.map((t) => t.id));
    const fromExt = [];
    for (const { extension, data } of this.extensions()) {
      const v = validateTheme(data);
      if (!v.ok) continue;
      const t = { ...v.theme, id: `${extension}-${v.theme.id}`, source: 'extension', extension };
      if (!ids.has(t.id)) { ids.add(t.id); fromExt.push(t); }
    }
    const user = this._read(this.dir, 'user').filter((t) => !ids.has(t.id));
    return [...builtin, ...fromExt, ...user];
  }

  /** Saves a user theme (new id when it would replace a built-in one). */
  save(input) {
    const v = validateTheme(input);
    if (!v.ok) throw Object.assign(new Error(`the theme has problems: ${v.errors.join('; ')}`), { code: 'bad_request' });
    const theme = v.theme;
    const taken = new Set(this.list().filter((t) => t.source !== 'user').map((t) => t.id));
    let id = theme.id;
    for (let n = 2; taken.has(id); n++) id = `${theme.id}-${n}`;
    theme.id = id;
    fs.writeFileSync(path.join(this.dir, `${id}${FILE_SUFFIX}`), serializeTheme(theme));
    return { ...theme, source: 'user' };
  }

  delete(id) {
    const file = path.join(this.dir, `${slug(id)}${FILE_SUFFIX}`);
    if (!fs.existsSync(file)) throw Object.assign(new Error('only your own themes can be deleted'), { code: 'not_found' });
    fs.rmSync(file);
    return {};
  }
}

const rank = (id) => { const i = BUILTIN_ORDER.indexOf(id); return i === -1 ? 99 : i; };

/** Messages for the brain: a short art direction brief and the token rules. */
export function themeMessages(prompt) {
  return [
    {
      role: 'system',
      content: [
        'You design color themes for hivedesk, a desktop with windows, a top bar and a dock. Answer with one JSON object that matches the schema.',
        'colors: bg is the desktop, bg2 slightly different, panel to panel4 are window surfaces from base to raised, line is the color used for thin borders (drawn at low opacity),',
        'text is the main text, text2 secondary, muted for labels, faint for hints, accent is the brand color for buttons and focus, accent2 a lighter or darker accent used as text, accentInk is text on an accent button,',
        'ok, warn, bad and info are status colors used as text on panels. Every color is #RRGGBB.',
        'Text must be readable: aim for a contrast of at least 4.5 to 1 against the panels.',
        'radius in px (window 0 to 28, control 0 to 20, small 0 to 14). lines 0.5 to 4 (1 is normal). motion 0 to 1.5 (1 is normal).',
        'pattern is the desktop motif: kind comb (honeycomb), fine, dots, grid, pixel or none; opacity 0 to 0.3; size 16 to 120.',
        'shadow.style soft, deep, hard or flat; strength 0 to 2. sound is the sound pack: chime, soft, wood, pixel or off.',
        'The name is short (one to three words) in the language of the request.'
      ].join('\n')
    },
    { role: 'user', content: `Make a theme from this idea: ${String(prompt).slice(0, 600)}` }
  ];
}

/**
 * Runs the "create a theme with the crew" flow: one model turn under the theme schema,
 * validation, then the contrast fix. Nothing is saved: the UI shows a preview to approve.
 * @param {{ scheduler: import('../crew/scheduler.js').Scheduler, prompt: string, signal?: AbortSignal }} opts
 */
export async function generateTheme({ scheduler, prompt, signal }) {
  const text = String(prompt || '').trim();
  if (!text) throw Object.assign(new Error('describe the theme you want'), { code: 'bad_request' });
  if (!scheduler.hasBrain) throw Object.assign(new Error('no model yet: choose one in Settings, then ask again'), { code: 'conflict' });
  let lastErrors = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const messages = themeMessages(text);
    if (lastErrors.length) messages.push({ role: 'user', content: `Your last answer had problems: ${lastErrors.join('; ')}. Answer again with a valid theme.` });
    const r = await scheduler.turn({ workerId: 'mel', messages, options: { schema: THEME_SCHEMA, maxTokens: 1200, temperature: 0.6 }, signal });
    const v = validateTheme({ ...(r.json || {}), author: 'Mel', id: slug(r.json?.name || text) }, { partial: true });
    if (!v.theme || v.errors.some((e) => /^name|^scheme/.test(e))) { lastErrors = v.errors.slice(0, 6); continue; }
    const before = checkContrast(v.theme).filter((x) => !x.ok).length;
    const fixed = fixContrast(v.theme);
    return { theme: fixed.theme, fixes: fixed.fixes, failing: fixed.failing, problemsBefore: before, repaired: v.errors, prompt: text };
  }
  // Two unusable answers: start from Mel so the user still gets an editable draft.
  const fixed = fixContrast({ ...BASE, id: slug(text), name: text.slice(0, 40), author: 'Mel', description: `Draft for: ${text.slice(0, 120)}` });
  return { theme: fixed.theme, fixes: fixed.fixes, failing: fixed.failing, problemsBefore: 0, repaired: lastErrors, prompt: text, fallback: true };
}
