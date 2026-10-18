// The built-in avatar gallery of the local profile (docs/1.0/PROFILE.md): 28 original avatars in
// the 1.0 design language (hexagon tiles, geometric motifs, a few bee and City ones) and a monogram
// fallback from the name. Pure module, no DOM: the engine imports AVATAR_IDS to sanitize what peers
// send (an avatar id from this allowlist only, never an image).

const INK = '#14171B';
const TILE = '#181B20';
const COLORS = {
  amber: '#E0A447', blue: '#6E9FD6', green: '#5FB088', violet: '#9C8BD6', rose: '#CF7F98', teal: '#5DAFAE', slate: '#9AA3AE',
};
const MOTIFS = ['comb', 'bee', 'tower', 'bridge', 'orbit', 'grid', 'rings'];
const PALETTES = {
  comb: ['amber', 'blue', 'green', 'violet'],
  bee: ['amber', 'blue', 'rose', 'green'],
  tower: ['slate', 'amber', 'teal', 'violet'],
  bridge: ['teal', 'amber', 'blue', 'rose'],
  orbit: ['violet', 'amber', 'green', 'blue'],
  grid: ['blue', 'rose', 'amber', 'slate'],
  rings: ['green', 'violet', 'teal', 'amber'],
};

/** Every avatar: { id, motif, color }. 7 motifs, 4 colors each. */
export const AVATARS = Object.freeze(MOTIFS.flatMap((m) => PALETTES[m].map((c) => Object.freeze({ id: `${m}-${c}`, motif: m, color: c }))));
export const AVATAR_IDS = new Set(AVATARS.map((a) => a.id));
export const isAvatarId = (v) => typeof v === 'string' && AVATAR_IDS.has(v);

const HEX = 'M32 3 57.1 17.5v29L32 61 6.9 46.5v-29z';
const hexP = (cx, cy, r) => { const p = []; for (let i = 0; i < 6; i++) { const a = (Math.PI / 3) * i - Math.PI / 2; p.push(`${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`); } return `M${p.join('L')}Z`; };

function motifSvg(m, c) {
  switch (m) {
    case 'comb': return `<g fill="none" stroke="${c}" stroke-width="2.2" stroke-linejoin="round"><path d="${hexP(32, 24, 8)}" fill="${c}"/><path d="${hexP(24.2, 37.5, 8)}"/><path d="${hexP(39.8, 37.5, 8)}"/></g>`;
    case 'bee': return `<path d="M27.5 18.5 23.5 12M36.5 18.5l4-6.5" stroke="${c}" stroke-width="2" stroke-linecap="round" fill="none"/><circle cx="32" cy="22" r="5.5" fill="${c}" fill-opacity=".55"/><path d="${hexP(32, 38, 11)}" fill="${c}"/><g fill="${INK}"><rect x="20" y="33" width="24" height="2.6"/><rect x="20" y="40.4" width="24" height="2.6"/></g>`;
    case 'tower': return `<g fill="${c}"><path d="M23 46V25l9-5.2 9 5.2v21z" fill-opacity=".35"/><path d="M27 46V30h10v16z"/></g><path d="M18 46h28" stroke="${c}" stroke-width="2.2" stroke-linecap="round"/><g fill="${INK}"><rect x="29.2" y="33" width="2" height="2"/><rect x="32.8" y="33" width="2" height="2"/><rect x="29.2" y="38" width="2" height="2"/><rect x="32.8" y="38" width="2" height="2"/></g>`;
    case 'bridge': return `<path d="M16 40c5-9 11-13 16-13s11 4 16 13" fill="none" stroke="${c}" stroke-width="2.4" stroke-linecap="round"/><path d="M14 40h36" stroke="${c}" stroke-width="2.4" stroke-linecap="round"/><g fill="${c}"><circle cx="22" cy="36" r="1.6"/><circle cx="32" cy="30" r="1.6"/><circle cx="42" cy="36" r="1.6"/></g>`;
    case 'orbit': return `<circle cx="32" cy="32" r="12" fill="none" stroke="${c}" stroke-width="2.2"/><circle cx="32" cy="32" r="5" fill="${c}"/><circle cx="43.3" cy="27.9" r="2.6" fill="${c}"/>`;
    case 'grid': return `<g fill="${c}"><rect x="20" y="20" width="10.5" height="10.5" rx="2"/><rect x="33.5" y="20" width="10.5" height="10.5" rx="2" fill-opacity=".45"/><rect x="20" y="33.5" width="10.5" height="10.5" rx="2" fill-opacity=".45"/><rect x="33.5" y="33.5" width="10.5" height="10.5" rx="2"/></g>`;
    case 'rings': return `<g fill="none" stroke="${c}" stroke-width="2.2"><path d="${hexP(32, 32, 14)}"/><path d="${hexP(32, 32, 9)}" stroke-opacity=".6"/></g><path d="${hexP(32, 32, 4)}" fill="${c}"/>`;
    default: return '';
  }
}

/** A gallery avatar as SVG markup (64 viewBox). Unknown ids fall back to the monogram of `name`. */
export function avatarSvg(id, { size = 64, name = '', title = '' } = {}) {
  const a = AVATARS.find((x) => x.id === id);
  if (!a) return monogramSvg(name, { size, title });
  const c = COLORS[a.color];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${size}" height="${size}" role="img" aria-label="${esc(title || a.id)}"><path d="${HEX}" fill="${TILE}" stroke="${c}" stroke-opacity=".55" stroke-width="1.5"/>${motifSvg(a.motif, c)}</svg>`;
}

/** Up to two initials of a name, uppercase; "?" when there is none. */
export function initials(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  const pick = (w) => [...w][0] || '';
  return (words.length > 1 ? pick(words[0]) + pick(words[words.length - 1]) : [...words[0]].slice(0, 2).join('')).toUpperCase();
}

/** The monogram fallback: the initials on a hexagon tile, the color picked from the name. */
export function monogramSvg(name, { size = 64, title = '' } = {}) {
  let h = 0;
  for (const ch of String(name || '')) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  const keys = Object.keys(COLORS);
  const c = COLORS[keys[h % keys.length]];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${size}" height="${size}" role="img" aria-label="${esc(title || name || 'profile')}"><path d="${HEX}" fill="${TILE}" stroke="${c}" stroke-opacity=".55" stroke-width="1.5"/><text x="32" y="38.5" text-anchor="middle" font-family="Inter, 'Segoe UI', system-ui, sans-serif" font-size="17" font-weight="600" fill="${c}">${esc(initials(name))}</text></svg>`;
}

function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
