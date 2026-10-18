// One theme for the whole workbench: the desktop theme tokens (ui/themes/core.js) mapped to the
// code editor theme and the terminal colors, so the editor, the terminal and the panels always
// match the desktop, also for themes made in the Theme editor or by an extension. Pure, no DOM.

const HEX = /^#[0-9a-fA-F]{6}$/;
const hex = (v, d) => (HEX.test(v || '') ? v.toUpperCase() : d);
const strip = (v) => v.slice(1);

function rgb(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function toHex([r, g, b]) {
  return '#' + [r, g, b].map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('').toUpperCase();
}
/** a mixed toward b by t (0..1). */
export function mix(a, b, t) {
  const x = rgb(a);
  const y = rgb(b);
  return toHex(x.map((v, i) => v + (y[i] - v) * t));
}
/** #RRGGBB plus a two digit alpha. */
export const alpha = (h, a) => `${h}${Math.round(Math.max(0, Math.min(1, a)) * 255).toString(16).padStart(2, '0').toUpperCase()}`;

const DEFAULT = {
  scheme: 'dark',
  colors: {
    bg: '#0E0D0B', bg2: '#141210', panel: '#191613', panel2: '#1F1B17', panel3: '#27221D', panel4: '#2F2923', line: '#F2E9DA',
    text: '#F2E9DA', text2: '#CFC4B3', muted: '#9A8F80', faint: '#756B5F',
    accent: '#FFB531', accent2: '#FFD072', accentInk: '#1A1206',
    ok: '#7DC49B', warn: '#E8B45C', bad: '#E57B6E', info: '#86A9D6'
  }
};

function colorsOf(theme) {
  const c = theme?.colors || {};
  const d = DEFAULT.colors;
  const out = {};
  for (const k of Object.keys(d)) out[k] = hex(c[k], d[k]);
  return out;
}

/** The code editor theme (monaco.editor.defineTheme data) for a desktop theme. */
export function editorTheme(theme) {
  const c = colorsOf(theme);
  const light = theme?.scheme === 'light';
  const comment = mix(c.muted, c.bg2, 0.1);
  const string = light ? mix(c.ok, '#000000', 0.35) : mix(c.ok, '#FFFFFF', 0.15);
  const number = light ? mix(c.bad, '#000000', 0.25) : mix(c.bad, c.accent2, 0.35);
  const type = light ? mix(c.info, '#000000', 0.3) : c.info;
  const keyword = light ? mix(c.accent, '#000000', 0.38) : c.accent;
  return {
    base: light ? 'vs' : 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: strip(comment), fontStyle: 'italic' },
      { token: 'keyword', foreground: strip(keyword) },
      { token: 'string', foreground: strip(string) },
      { token: 'number', foreground: strip(number) },
      { token: 'regexp', foreground: strip(number) },
      { token: 'tag', foreground: strip(light ? mix(c.accent, '#000000', 0.45) : c.accent2) },
      { token: 'attribute.name', foreground: strip(mix(c.accent2, c.text2, 0.4)) },
      { token: 'attribute.value', foreground: strip(string) },
      { token: 'type', foreground: strip(type) },
      { token: 'type.identifier', foreground: strip(type) },
      { token: 'delimiter', foreground: strip(c.text2) },
      { token: 'variable', foreground: strip(c.text) },
      { token: 'identifier', foreground: strip(c.text) }
    ],
    colors: {
      'editor.background': c.bg2,
      'editor.foreground': c.text,
      'editorLineNumber.foreground': mix(c.faint, c.bg2, 0.25),
      'editorLineNumber.activeForeground': c.accent2,
      'editorCursor.foreground': c.accent,
      'editor.selectionBackground': alpha(c.accent, 0.22),
      'editor.inactiveSelectionBackground': alpha(c.accent, 0.12),
      'editor.selectionHighlightBackground': alpha(c.accent, 0.1),
      'editor.wordHighlightBackground': alpha(c.info, 0.14),
      'editor.findMatchBackground': alpha(c.accent, 0.4),
      'editor.findMatchHighlightBackground': alpha(c.accent, 0.18),
      'editor.lineHighlightBackground': mix(c.bg2, c.panel2, 0.6),
      'editor.lineHighlightBorder': '#00000000',
      'editorIndentGuide.background1': mix(c.bg2, c.panel3, 0.7),
      'editorIndentGuide.activeBackground1': c.panel4,
      'editorBracketMatch.background': alpha(c.accent, 0.12),
      'editorBracketMatch.border': alpha(c.accent, 0.5),
      'editorWidget.background': c.panel,
      'editorWidget.border': c.panel4,
      'editorSuggestWidget.background': c.panel,
      'editorSuggestWidget.selectedBackground': alpha(c.accent, 0.16),
      'editorHoverWidget.background': c.panel,
      'editorHoverWidget.border': c.panel4,
      'editorGutter.background': c.bg2,
      'editorError.foreground': c.bad,
      'editorWarning.foreground': c.warn,
      'editorInfo.foreground': c.info,
      'minimap.background': c.bg2,
      'scrollbarSlider.background': alpha(c.text, 0.1),
      'scrollbarSlider.hoverBackground': alpha(c.text, 0.18),
      'scrollbarSlider.activeBackground': alpha(c.accent, 0.35),
      'diffEditor.insertedTextBackground': alpha(c.ok, 0.16),
      'diffEditor.removedTextBackground': alpha(c.bad, 0.16),
      'diffEditor.insertedLineBackground': alpha(c.ok, 0.08),
      'diffEditor.removedLineBackground': alpha(c.bad, 0.08),
      'input.background': c.bg2,
      'input.border': c.panel4,
      'focusBorder': alpha(c.accent, 0.6),
      'list.activeSelectionBackground': alpha(c.accent, 0.18),
      'list.hoverBackground': c.panel2,
      'peekView.border': c.accent,
      'peekViewEditor.background': c.bg,
      'peekViewResult.background': c.panel,
      'peekViewTitle.background': c.panel2
    }
  };
}

/** The terminal colors (xterm.js ITheme) for a desktop theme. */
export function terminalTheme(theme) {
  const c = colorsOf(theme);
  const light = theme?.scheme === 'light';
  const tone = (h, t) => (light ? mix(h, '#000000', t) : h);
  return {
    background: c.bg2,
    foreground: c.text,
    cursor: c.accent,
    cursorAccent: c.bg2,
    selectionBackground: alpha(c.accent, 0.3),
    black: light ? c.text : mix(c.bg, c.panel4, 0.5),
    red: tone(c.bad, 0.2),
    green: tone(c.ok, 0.3),
    yellow: tone(c.accent, 0.35),
    blue: tone(c.info, 0.3),
    magenta: tone('#C990D8', 0.3),
    cyan: tone('#6CC7C0', 0.3),
    white: light ? c.panel4 : c.text2,
    brightBlack: c.faint,
    brightRed: tone(mix(c.bad, '#FFFFFF', 0.2), 0.15),
    brightGreen: tone(mix(c.ok, '#FFFFFF', 0.2), 0.25),
    brightYellow: tone(c.accent2, 0.35),
    brightBlue: tone(mix(c.info, '#FFFFFF', 0.2), 0.25),
    brightMagenta: tone('#E0A9EE', 0.3),
    brightCyan: tone('#8EE0D8', 0.3),
    brightWhite: light ? c.text2 : c.text
  };
}

/** The theme id for the editor: follow the desktop, or one of the two fixed themes. */
export function editorThemeId(setting, theme) {
  if (setting === 'hivedesk-dark' || setting === 'hivedesk-light') return setting;
  return theme ? 'hivedesk-desk' : 'hivedesk-dark';
}
