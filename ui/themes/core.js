// Theme tokens: schema, validation, WCAG contrast checks with an automatic fix, and the
// mapping to CSS custom properties. Pure ES module with no DOM access, so the engine
// (src/extensions/themes.js), the tests and the desktop all share it.

export const FORMAT = 'hivedesk-theme';
export const VERSION = 1;
export const FILE_SUFFIX = '.hivedesk-theme.json';

export const COLOR_KEYS = [
  'bg', 'bg2', 'panel', 'panel2', 'panel3', 'panel4', 'line',
  'text', 'text2', 'muted', 'faint',
  'accent', 'accent2', 'accentInk',
  'ok', 'warn', 'bad', 'info'
];

export const PATTERNS = ['comb', 'fine', 'dots', 'grid', 'pixel', 'none'];
export const SHADOWS = ['soft', 'deep', 'hard', 'flat'];
export const SOUND_PACKS = ['chime', 'soft', 'wood', 'pixel', 'off'];
export const FONT_PRESETS = {
  system: '"Inter", "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif',
  rounded: 'ui-rounded, "SF Pro Rounded", "Nunito", "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif',
  humanist: '"Seravek", "Gill Sans Nova", "Ubuntu", "Calibri", "Segoe UI", system-ui, sans-serif',
  serif: '"Iowan Old Style", "Palatino Linotype", "Book Antiqua", Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, "Cascadia Code", "SF Mono", Menlo, Consolas, monospace',
  pixel: '"Press Start 2P", "VT323", "Lucida Console", ui-monospace, Consolas, monospace'
};
export const MONO_PRESETS = {
  system: '"JetBrains Mono", "Cascadia Mono", "Cascadia Code", ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  pixel: '"VT323", "Lucida Console", ui-monospace, Consolas, monospace'
};

const HEX = /^#[0-9a-fA-F]{6}$/;
// A font stack may only hold names, quotes, commas, spaces, dots and dashes: no url(), no braces.
const SAFE_FONT = /^[A-Za-z0-9 ,"'._-]{1,240}$/;

const color = (description) => ({ type: 'string', description, minLength: 7, maxLength: 7 });

/**
 * JSON schema for a theme. The brain answers under it (grammar constrained when the backend
 * supports it); `validateTheme` is still the authority because the engine subset has no
 * pattern or number range keywords.
 */
export const THEME_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 40 },
    description: { type: 'string', maxLength: 160 },
    scheme: { enum: ['dark', 'light'] },
    colors: {
      type: 'object',
      properties: Object.fromEntries(COLOR_KEYS.map((k) => [k, color(`${k} as #RRGGBB`)])),
      required: COLOR_KEYS,
      additionalProperties: false
    },
    radius: {
      type: 'object',
      properties: { window: { type: 'integer' }, control: { type: 'integer' }, small: { type: 'integer' } },
      required: ['window', 'control', 'small'],
      additionalProperties: false
    },
    fonts: {
      type: 'object',
      properties: { sans: { enum: Object.keys(FONT_PRESETS) }, mono: { enum: Object.keys(MONO_PRESETS) } },
      required: ['sans', 'mono'],
      additionalProperties: false
    },
    shadow: {
      type: 'object',
      properties: { style: { enum: SHADOWS }, strength: { type: 'number' } },
      required: ['style', 'strength'],
      additionalProperties: false
    },
    pattern: {
      type: 'object',
      properties: { kind: { enum: PATTERNS }, color: color('pattern stroke color'), opacity: { type: 'number' }, size: { type: 'integer' } },
      required: ['kind', 'color', 'opacity', 'size'],
      additionalProperties: false
    },
    lines: { type: 'number', description: 'border strength, 1 is normal' },
    motion: { type: 'number', description: '0 is no motion, 1 is normal, 1.5 is lively' },
    sound: { enum: SOUND_PACKS }
  },
  required: ['name', 'description', 'scheme', 'colors', 'radius', 'fonts', 'shadow', 'pattern', 'lines', 'motion', 'sound'],
  additionalProperties: false
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export function slug(text, fallback = 'theme') {
  const s = String(text || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return /^[a-z0-9]/.test(s) ? s : fallback;
}

/* ---------- color math ---------- */

export function hexToRgb(hex) {
  const n = parseInt(String(hex).slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex([r, g, b]) {
  return '#' + [r, g, b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('').toUpperCase();
}

/** sRGB mix: t = 0 gives a, t = 1 gives b. */
export function mix(a, b, t) {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  return rgbToHex(x.map((v, i) => v + (y[i] - v) * t));
}

export function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2 contrast ratio, 1 to 21. */
export function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const rgba = (hex, a) => {
  const [r, g, b] = hexToRgb(hex);
  return `rgb(${r} ${g} ${b} / ${Math.round(clamp(a, 0, 1) * 1000) / 1000})`;
};

/* ---------- contrast rules ---------- */

/**
 * Text pairs checked against WCAG 2.1. AA asks 4.5 for body text and 3 for large text and
 * interface parts. `faint` only carries hints and timestamps next to readable text, so it
 * gets the large text level. The high contrast theme asks 7 (AAA) for the main pairs.
 */
export function contrastRules(theme) {
  const high = theme.contrast === 'high';
  const body = high ? 7 : 4.5;
  return [
    { fg: 'text', on: ['bg', 'bg2', 'panel', 'panel2', 'panel3'], min: body },
    { fg: 'text2', on: ['panel', 'panel2'], min: body },
    { fg: 'muted', on: ['panel', 'panel2'], min: high ? 7 : 4.5 },
    { fg: 'faint', on: ['panel'], min: high ? 4.5 : 3 },
    { fg: 'accent2', on: ['panel'], min: 4.5 },
    { fg: 'accent', on: ['panel', 'bg'], min: 3 },
    { fg: 'accentInk', on: ['accent'], min: body },
    { fg: 'ok', on: ['panel'], min: 4.5 },
    { fg: 'warn', on: ['panel'], min: 4.5 },
    { fg: 'bad', on: ['panel'], min: 4.5 },
    { fg: 'info', on: ['panel'], min: 4.5 }
  ];
}

/** @returns {{ fg, on, ratio, min, ok }[]} one row per pair */
export function checkContrast(theme) {
  const c = theme.colors;
  const rows = [];
  for (const r of contrastRules(theme)) {
    for (const bg of r.on) {
      const ratio = contrast(c[r.fg], c[bg]);
      rows.push({ fg: r.fg, on: bg, ratio: Math.round(ratio * 100) / 100, min: r.min, ok: ratio >= r.min - 1e-9 });
    }
  }
  return rows;
}

/** The smallest move of `fg` toward white or black that reaches `min` on every background. */
function fixColor(fg, bgs, min) {
  const worst = (hex) => Math.min(...bgs.map((b) => contrast(hex, b)));
  if (worst(fg) >= min) return fg;
  let best = null;
  for (const target of ['#FFFFFF', '#000000']) {
    if (worst(target) < min) continue;
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (worst(mix(fg, target, mid)) >= min) hi = mid; else lo = mid;
    }
    let out = mix(fg, target, hi);
    // Rounding to 8 bit channels can land a hair under the line.
    for (let step = 0; worst(out) < min && step < 20; step++) out = mix(out, target, 0.05);
    if (!best || hi < best.t) best = { t: hi, hex: out };
  }
  return best ? best.hex : (worst('#FFFFFF') >= worst('#000000') ? '#FFFFFF' : '#000000');
}

/**
 * Adjusts the text colors (never the surfaces) until every rule passes.
 * @returns {{ theme: object, fixes: { key: string, from: string, to: string, ratio: number, min: number }[], failing: object[] }}
 */
export function fixContrast(theme) {
  const out = clone(theme);
  const fixes = [];
  for (const r of contrastRules(out)) {
    const from = out.colors[r.fg];
    const to = fixColor(from, r.on.map((k) => out.colors[k]), r.min);
    if (to !== from) {
      out.colors[r.fg] = to;
      const ratio = Math.min(...r.on.map((k) => contrast(to, out.colors[k])));
      const prev = fixes.find((f) => f.key === r.fg);
      if (prev) { prev.to = to; prev.ratio = Math.round(ratio * 100) / 100; prev.min = Math.max(prev.min, r.min); }
      else fixes.push({ key: r.fg, from, to, ratio: Math.round(ratio * 100) / 100, min: r.min });
    }
  }
  return { theme: out, fixes, failing: checkContrast(out).filter((x) => !x.ok) };
}

/* ---------- validation ---------- */

function clone(v) { return JSON.parse(JSON.stringify(v)); }

/** Mel, the default: used to fill gaps in partial themes. Graphite and near black, amber for state and focus (docs/1.0/DESIGN.md). */
export const BASE = {
  format: FORMAT, version: VERSION, id: 'mel', name: 'Mel', description: 'Graphite and near black with amber for state and focus. The default Hive.',
  author: 'hivedesk', scheme: 'dark',
  colors: {
    bg: '#0A0B0D', bg2: '#0E1013', panel: '#131519', panel2: '#181B20', panel3: '#1F2329', panel4: '#272C33', line: '#E4E8EE',
    text: '#E6E8EB', text2: '#B4BAC3', muted: '#8A919B', faint: '#656C76',
    accent: '#F2A93B', accent2: '#F6C46F', accentInk: '#17110A',
    ok: '#62B98C', warn: '#D8A54F', bad: '#E0695C', info: '#72A4DE'
  },
  radius: { window: 10, control: 6, small: 4 },
  fonts: { sans: 'system', mono: 'system' },
  shadow: { style: 'soft', strength: 1 },
  pattern: { kind: 'comb', color: '#E4E8EE', opacity: 0.03, size: 56 },
  lines: 1, motion: 1, sound: 'chime'
};

/**
 * Validates and normalizes a theme (from a file, an import, an extension or the brain).
 * Unknown keys are dropped, numbers are clamped, missing groups come from Mel.
 * @param {any} input
 * @param {{ partial?: boolean }} [opts] partial: fill missing colors from the base instead of failing
 * @returns {{ ok: boolean, errors: string[], theme: object | null }}
 */
export function validateTheme(input, opts = {}) {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, errors: ['a theme must be a JSON object'], theme: null };
  if (input.format != null && input.format !== FORMAT) errors.push(`format must be "${FORMAT}"`);
  if (input.version != null && input.version !== VERSION) errors.push(`version ${input.version} is not supported (expected ${VERSION})`);
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, 40) : '';
  if (!name) errors.push('name is required');
  const scheme = input.scheme === 'light' || input.scheme === 'dark' ? input.scheme : null;
  if (!scheme) errors.push('scheme must be "dark" or "light"');
  const colors = {};
  const src = input.colors && typeof input.colors === 'object' ? input.colors : {};
  for (const k of COLOR_KEYS) {
    const v = src[k];
    if (typeof v === 'string' && HEX.test(v.trim())) colors[k] = v.trim().toUpperCase();
    else if (v == null && opts.partial) colors[k] = BASE.colors[k];
    else errors.push(v == null ? `colors.${k} is required` : `colors.${k} must be a #RRGGBB color`);
  }
  const r = input.radius || {};
  const f = input.fonts || {};
  const sh = input.shadow || {};
  const p = input.pattern || {};
  const fontOf = (v, presets, key) => {
    if (v == null) return 'system';
    if (typeof v === 'string' && presets[v]) return v;
    if (typeof v === 'string' && SAFE_FONT.test(v) && !/url\s*\(/i.test(v)) return v;
    errors.push(`fonts.${key} must be a preset (${Object.keys(presets).join(', ')}) or a plain font list`);
    return 'system';
  };
  const theme = {
    format: FORMAT,
    version: VERSION,
    id: slug(input.id || name, 'theme'),
    name: name || 'Untitled',
    description: typeof input.description === 'string' ? input.description.trim().slice(0, 160) : '',
    author: typeof input.author === 'string' ? input.author.trim().slice(0, 60) : '',
    scheme: scheme || 'dark',
    colors: errors.some((e) => e.startsWith('colors.')) ? { ...BASE.colors, ...colors } : colors,
    radius: {
      window: Math.round(clamp(num(r.window, 10), 0, 28)),
      control: Math.round(clamp(num(r.control, 6), 0, 20)),
      small: Math.round(clamp(num(r.small, 4), 0, 14))
    },
    fonts: { sans: fontOf(f.sans, FONT_PRESETS, 'sans'), mono: fontOf(f.mono, MONO_PRESETS, 'mono') },
    shadow: {
      style: SHADOWS.includes(sh.style) ? sh.style : 'soft',
      strength: clamp(num(sh.strength, 1), 0, 2)
    },
    pattern: {
      kind: PATTERNS.includes(p.kind) ? p.kind : 'comb',
      color: typeof p.color === 'string' && HEX.test(p.color) ? p.color.toUpperCase() : BASE.pattern.color,
      opacity: Math.round(clamp(num(p.opacity, 0.065), 0, 0.3) * 1000) / 1000,
      size: Math.round(clamp(num(p.size, 56), 16, 120))
    },
    lines: Math.round(clamp(num(input.lines, 1), 0.5, 4) * 100) / 100,
    motion: Math.round(clamp(num(input.motion, 1), 0, 1.5) * 100) / 100,
    sound: SOUND_PACKS.includes(input.sound) ? input.sound : 'chime'
  };
  if (input.contrast === 'high') theme.contrast = 'high';
  if (p.color != null && !(typeof p.color === 'string' && HEX.test(p.color))) errors.push('pattern.color must be a #RRGGBB color');
  if (sh.style != null && !SHADOWS.includes(sh.style)) errors.push(`shadow.style must be one of ${SHADOWS.join(', ')}`);
  if (p.kind != null && !PATTERNS.includes(p.kind)) errors.push(`pattern.kind must be one of ${PATTERNS.join(', ')}`);
  if (input.sound != null && !SOUND_PACKS.includes(input.sound)) errors.push(`sound must be one of ${SOUND_PACKS.join(', ')}`);
  return { ok: errors.length === 0, errors, theme: errors.length && !opts.partial ? null : theme };
}

/* ---------- CSS ---------- */

function shadowCss(style, k) {
  if (style === 'flat' || k === 0) return { win: '0 0 0 1px rgb(0 0 0 / .18)', pop: '0 0 0 1px rgb(0 0 0 / .22)' };
  if (style === 'hard') {
    const d = Math.max(2, Math.round(4 * k));
    return { win: `${d}px ${d}px 0 0 rgb(0 0 0 / .55)`, pop: `${d + 2}px ${d + 2}px 0 0 rgb(0 0 0 / .6)` };
  }
  const deep = style === 'deep' ? 1.4 : 1;
  const a = (x) => Math.round(clamp(x * k * deep, 0, 0.95) * 100) / 100;
  return {
    win: `0 0 0 1px rgb(0 0 0 / ${a(0.4)}), 0 1px 0 rgb(255 255 255 / .03) inset, 0 16px 40px -16px rgb(0 0 0 / ${a(0.6)})`,
    pop: `0 0 0 1px rgb(0 0 0 / ${a(0.45)}), 0 24px 48px -16px rgb(0 0 0 / ${a(0.7)})`
  };
}

/** The honeycomb (or another motif) as an SVG data URL for the desktop background. */
export function patternUrl(pattern) {
  const { kind, color: c, opacity: o } = pattern;
  if (kind === 'none' || o <= 0) return { url: 'none', size: 'auto' };
  const st = `fill='none' stroke='${c}' stroke-opacity='${o}' stroke-width='1'`;
  let svg;
  let w;
  let hh;
  switch (kind) {
    case 'dots': w = hh = 24; svg = `<circle cx='12' cy='12' r='1.4' fill='${c}' fill-opacity='${Math.min(1, o * 2.2)}'/>`; break;
    case 'grid': w = hh = 40; svg = `<path d='M40 0H0V40' ${st}/>`; break;
    case 'pixel': w = 32; hh = 32; svg = `<path d='M8 4h8v4h4v8h-4v4H8v-4H4V8h4z' fill='${c}' fill-opacity='${Math.min(1, o * 1.2)}'/>`; break;
    default: w = 56; hh = 97; svg = `<path d='M28 1.5 54.5 16.5v31L28 62.5 1.5 47.5v-31z M28 62.5v34' ${st}/>`;
  }
  const doc = `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${hh}' viewBox='0 0 ${w} ${hh}'>${svg}</svg>`;
  const scale = pattern.size / 56;
  const fine = kind === 'fine' ? 0.6 : 1;
  const size = `${Math.round(w * scale * fine)}px ${Math.round(hh * scale * fine)}px`;
  return { url: `url("data:image/svg+xml,${encodeURIComponent(doc).replace(/'/g, '%27')}")`, size };
}

/**
 * CSS custom properties for a theme. The names match ui/css/hive.css (and Monsoon through it);
 * the `--hd-*` ones are read by ui/themes/themes.css for the parts hive.css draws with fixed colors.
 * @returns {Record<string, string>}
 */
export function themeVars(theme) {
  const c = theme.colors;
  const L = theme.lines;
  const light = theme.scheme === 'light';
  const sh = shadowCss(theme.shadow.style, theme.shadow.strength * (light ? 0.45 : 1));
  const m = theme.motion;
  const pat = patternUrl(theme.pattern);
  const sans = FONT_PRESETS[theme.fonts.sans] || theme.fonts.sans;
  const mono = MONO_PRESETS[theme.fonts.mono] || FONT_PRESETS[theme.fonts.mono] || theme.fonts.mono;
  const v = {
    '--seed': c.accent,
    '--bg': c.bg, '--bg-2': c.bg2,
    '--panel': c.panel, '--panel-2': c.panel2, '--panel-3': c.panel3, '--panel-4': c.panel4,
    '--line': rgba(c.line, 0.065 * L * (light ? 1.9 : 1)),
    '--line-2': rgba(c.line, 0.11 * L * (light ? 1.7 : 1)),
    '--line-3': rgba(c.line, 0.17 * L * (light ? 1.6 : 1)),
    '--text': c.text, '--text-2': c.text2, '--muted-t': c.muted, '--faint': c.faint,
    '--honey': c.accent, '--honey-2': c.accent2, '--honey-ink': c.accentInk,
    '--honey-a': rgba(c.accent, 0.12), '--honey-b': rgba(c.accent, 0.22),
    '--ok': c.ok, '--ok-a': rgba(c.ok, 0.13),
    '--warn': c.warn, '--warn-a': rgba(c.warn, 0.14),
    '--bad': c.bad, '--bad-a': rgba(c.bad, 0.13),
    '--info': c.info, '--info-a': rgba(c.info, 0.13),
    '--outline': mix(c.bg, '#000000', 0.4),
    '--r-win': `${theme.radius.window}px`, '--r-ctl': `${theme.radius.control}px`, '--r-sm': `${theme.radius.small}px`,
    '--t-fast': `${Math.round(150 * m)}ms`, '--t': `${Math.round(200 * m)}ms`, '--t-slow': `${Math.round(250 * m)}ms`,
    '--shadow-win': sh.win, '--shadow-pop': sh.pop,
    '--font-sans': sans, '--font-mono': mono,
    '--ring': rgba(c.accent, 0.6),
    '--background': c.bg, '--foreground': c.text, '--surface': c.panel, '--surface-2': c.panel2, '--surface-3': c.panel3,
    '--muted': c.panel2, '--muted-foreground': c.muted, '--border': rgba(c.line, 0.11 * L * (light ? 1.7 : 1)),
    '--primary': c.accent, '--primary-foreground': c.accentInk, '--success': c.ok, '--warning': c.warn, '--danger': c.bad,
    '--hd-bg': c.bg, '--hd-panel': c.panel, '--hd-panel-2': c.panel2, '--hd-line': rgba(c.line, 0.11 * L), '--hd-text': c.text,
    '--hd-muted': c.muted, '--hd-accent': c.accent,
    '--hd-hover': rgba(c.text, light ? 0.07 : 0.06),
    '--hd-hover-2': rgba(c.text, light ? 0.11 : 0.1),
    '--hd-topbar': rgba(c.bg2, 0.9),
    '--hd-dock': rgba(c.panel, 0.84),
    '--hd-hex': c.panel3,
    '--hd-glow-1': rgba(c.accent, light ? 0.05 : 0.025),
    '--hd-glow-2': rgba(c.info, light ? 0.04 : 0.02),
    '--hd-scrim': rgba(light ? '#2B2620' : '#080706', light ? 0.32 : 0.55),
    '--hd-selection': rgba(c.accent, 0.3),
    '--hd-pattern': pat.url,
    '--hd-pattern-size': pat.size,
    'color-scheme': light ? 'light' : 'dark'
  };
  return v;
}

/** Same variables as one CSS rule body, for previews and exports. */
export function themeCss(theme, selector = ':root') {
  return `${selector} {\n${Object.entries(themeVars(theme)).map(([k, val]) => `  ${k}: ${val};`).join('\n')}\n}\n`;
}

/** File content for export: stable key order, two space indent, final newline. */
export function serializeTheme(theme) {
  const { theme: t } = validateTheme(theme, { partial: true });
  const out = {
    format: FORMAT, version: VERSION, id: t.id, name: t.name, description: t.description, author: t.author, scheme: t.scheme,
    ...(t.contrast ? { contrast: t.contrast } : {}),
    colors: t.colors, radius: t.radius, fonts: t.fonts, shadow: t.shadow, pattern: t.pattern, lines: t.lines, motion: t.motion, sound: t.sound
  };
  return JSON.stringify(out, null, 2) + '\n';
}
