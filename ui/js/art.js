// Canvas palette for the City and the Office: the CSS tokens of ui/css/tokens.css (as painted by the
// theme engine), read once per theme change, plus the few world colors derived from them. The scenes
// never hard code a UI color; a theme restyles the canvas the same way it restyles the DOM.
// docs/1.0/DESIGN.md, sections 2 and 5.

const HEX = /^#[0-9a-f]{6}$/i;

/** Defaults, the "Mel" theme, used outside a browser (tests) or when a token is not a #RRGGBB color. */
export const DEFAULT_TOKENS = {
  bg: '#0A0B0D', bg2: '#0E1013', panel: '#131519', panel2: '#181B20', panel3: '#1F2329', panel4: '#272C33',
  text: '#E6E8EB', text2: '#B4BAC3', muted: '#8A919B', faint: '#656C76',
  accent: '#F2A93B', accent2: '#F6C46F', accentInk: '#17110A',
  ok: '#62B98C', warn: '#D8A54F', bad: '#E0695C', info: '#72A4DE', link: '#7FD6F0', violet: '#A894E6',
  scheme: 'dark',
};

const VARS = {
  bg: '--bg', bg2: '--bg-2', panel: '--panel', panel2: '--panel-2', panel3: '--panel-3', panel4: '--panel-4',
  text: '--text', text2: '--text-2', muted: '--muted-t', faint: '--faint',
  accent: '--honey', accent2: '--honey-2', accentInk: '--honey-ink',
  ok: '--ok', warn: '--warn', bad: '--bad', info: '--info', link: '--link', violet: '--violet',
};

export function rgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  const v = m ? parseInt(m[1], 16) : 0x8a919b;
  return [v >> 16, (v >> 8) & 255, v & 255];
}
export function mixHex(a, b, t) {
  const A = rgb(a); const B = rgb(b);
  const c = A.map((x, i) => Math.round(x + (B[i] - x) * t));
  return `#${((1 << 24) | (c[0] << 16) | (c[1] << 8) | c[2]).toString(16).slice(1)}`;
}
export const alpha = (hex, a) => { const [r, g, b] = rgb(hex); return `rgba(${r},${g},${b},${a})`; };
export const shade = (hex, t) => (t < 0 ? mixHex(hex, '#000000', -t) : mixHex(hex, '#ffffff', t));

/** An agent or room identity color, muted a little toward neutral gray so no hue shouts. */
export function tone(hex, k = 0.22) { return mixHex(HEX.test(hex || '') ? hex : DEFAULT_TOKENS.accent, '#8A919B', k); }

let cache = null;
let cacheKey = '';

/** The current tokens as #RRGGBB strings. Cheap: recomputed only when the theme changed. */
export function artTokens() {
  if (typeof document === 'undefined') return DEFAULT_TOKENS;
  const root = document.documentElement;
  const key = `${root.dataset.hdTheme || ''}|${root.style.getPropertyValue('--bg')}|${root.style.getPropertyValue('--honey')}|${root.dataset.hdScheme || ''}`;
  if (cache && key === cacheKey) return cache;
  const cs = getComputedStyle(root);
  const out = { ...DEFAULT_TOKENS };
  for (const [k, v] of Object.entries(VARS)) {
    const val = cs.getPropertyValue(v).trim();
    if (HEX.test(val)) out[k] = val.toUpperCase();
  }
  out.scheme = root.dataset.hdScheme === 'light' ? 'light' : 'dark';
  cache = out;
  cacheKey = key;
  return out;
}

/**
 * World colors of the City and the Office for a time of day: graphite surfaces from the tokens,
 * a cool key light, and a day and night shift of a few percent only.
 * @param {number} night 0 at noon, 1 at night
 */
export function worldPalette(night = 0) {
  const T = artTokens();
  const light = T.scheme === 'light';
  const ink = light ? '#1B1F24' : '#000000';
  const k = night * 0.06; // the night shifts surfaces by a few percent
  const dim = (c) => mixHex(c, ink, k);
  const lift = (c, t) => mixHex(c, T.text, t);
  return {
    T, night, light,
    void0: dim(mixHex(T.bg, T.info, light ? 0.06 : 0.035)),
    void1: dim(T.bg),
    mist: alpha(lift(T.bg, 0.06), light ? 0.5 : 0.55),
    // ground: calm basalt tops, crisp faceted sides
    groundA: dim(lift(T.panel4, 0.1)), groundB: dim(lift(T.panel4, 0.075)), groundLine: alpha(T.text, light ? 0.1 : 0.05),
    rim: dim(lift(T.panel4, 0.2)),
    sideA: dim(lift(T.panel3, 0.07)), sideB: dim(lift(T.panel3, 0.02)), sideC: dim(T.panel2), under: dim(mixHex(T.bg, ink, 0.2)),
    strata: alpha(T.text, 0.06),
    path: dim(lift(T.panel4, 0.17)), pathEdge: dim(lift(T.panel4, 0.24)),
    // architecture: a light concrete model in a dark void
    plinthTop: dim(lift(T.panel4, 0.3)), plinthL: dim(lift(T.panel4, 0.16)), plinthR: dim(lift(T.panel4, 0.08)),
    floor: dim(lift(T.panel3, 0.11)), floorLine: alpha(T.text, light ? 0.08 : 0.05),
    wallL: dim(lift(T.panel4, 0.24)), wallR: dim(lift(T.panel4, 0.17)), cap: dim(lift(T.panel4, 0.42)), capSide: dim(lift(T.panel4, 0.12)),
    glassTop: dim(mixHex(T.panel2, T.info, 0.26)), glassBot: dim(mixHex(T.bg2, T.info, 0.1)), glassHi: alpha('#FFFFFF', 0.07),
    part: dim(lift(T.panel4, 0.34)), partL: dim(lift(T.panel4, 0.2)), partR: dim(lift(T.panel4, 0.12)),
    deskTop: dim(lift(T.panel4, 0.5)), deskL: dim(lift(T.panel4, 0.28)), deskR: dim(lift(T.panel4, 0.18)), leg: dim(lift(T.panel3, 0.04)),
    screen: dim(T.bg2), metal: dim(lift(T.panel4, 0.36)),
    tower: dim(lift(T.panel4, 0.36)), towerL: dim(lift(T.panel4, 0.22)), towerR: dim(lift(T.panel4, 0.12)),
    deck: dim(lift(T.panel4, 0.26)), deckSide: dim(lift(T.panel4, 0.06)), rail: dim(lift(T.panel4, 0.45)),
    tree: dim(mixHex(lift(T.panel4, 0.12), T.ok, 0.32)), treeB: dim(mixHex(T.panel4, T.ok, 0.26)), trunk: dim(lift(T.panel4, 0.1)),
    lamp: T.accent2,
    label: alpha(T.text, 0.55), labelDim: alpha(T.text, 0.32),
    board: dim(T.panel2), card: dim(lift(T.panel3, 0.05)),
  };
}

/** Status ring color of an agent (docs/1.0/DESIGN.md, section 4). */
export function statusColor(status, T = artTokens()) {
  switch (status) {
    case 'working': case 'thinking': case 'type': case 'plan': return T.accent;
    case 'waiting': case 'wait': case 'stuck': case 'waiting_approval': case 'queued': return T.warn;
    case 'testing': case 'test': return T.ok;
    case 'reviewing': case 'read': return T.info;
    case 'error': return T.bad;
    case 'borrow': return T.link;
    case 'sleeping': case 'sleep': case 'offline': case 'paused': return T.faint;
    default: return T.muted;
  }
}
