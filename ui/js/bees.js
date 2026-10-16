// Original SVG bee avatars for Mel and the crew, drawn in the style of the approved
// concept art (big round head, glossy eyes with two highlights, cheek blush, striped
// body, translucent wings, warm rim light, outline brown #24160C). One function draws
// every bee; the role picks the prop and the worker color tints it.

let n = 0;
const OUT = '#24160C';

const ROLE_KIND = {
  mel: 'mel', foreman: 'mel', planner: 'mel',
  dev: 'dev', developer: 'dev', code: 'dev',
  designer: 'designer', design: 'designer', ui: 'designer',
  qa: 'qa', tester: 'qa', test: 'qa',
  writer: 'writer', docs: 'writer', copy: 'writer',
};

export function beeKind(worker) {
  if (!worker) return 'hired';
  return ROLE_KIND[worker.id] || ROLE_KIND[String(worker.role || '').toLowerCase().split(/\W/)[0]] || 'hired';
}

function shade(hex, amt) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return hex || '#FFB531';
  const v = parseInt(m[1], 16);
  const f = (c) => Math.max(0, Math.min(255, Math.round(c + (amt < 0 ? c * amt : (255 - c) * amt))));
  const r = f(v >> 16), g = f((v >> 8) & 255), b = f(v & 255);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

/**
 * @param {{ id?: string, role?: string, color?: string, name?: string }} worker
 * @param {{ kind?: string, title?: string }} [opts]
 * @returns {string} SVG markup
 */
export function beeSvg(worker = {}, opts = {}) {
  const k = opts.kind || beeKind(worker);
  const id = `b${++n}`;
  const c = worker.color || '#FFB531';
  const c1 = shade(c, 0.35), c2 = shade(c, -0.35);
  const title = opts.title ?? (worker.name ? `${worker.name}` : 'bee');
  const initial = (worker.name || '?').trim().charAt(0).toUpperCase();

  const defs = `
  <radialGradient id="${id}h" cx=".36" cy=".3" r=".8"><stop offset="0" stop-color="#FFE7A1"/><stop offset=".45" stop-color="#FFC444"/><stop offset="1" stop-color="#E48A18"/></radialGradient>
  <radialGradient id="${id}b" cx=".38" cy=".25" r=".85"><stop offset="0" stop-color="#FFD978"/><stop offset=".55" stop-color="#F5A62A"/><stop offset="1" stop-color="#C26A14"/></radialGradient>
  <radialGradient id="${id}e" cx=".38" cy=".32" r=".8"><stop offset="0" stop-color="#5A3B26"/><stop offset=".55" stop-color="#2A190D"/><stop offset="1" stop-color="#120A04"/></radialGradient>
  <radialGradient id="${id}t" cx=".35" cy=".3" r=".8"><stop offset="0" stop-color="#FFF3C8"/><stop offset=".5" stop-color="#FFBA3A"/><stop offset="1" stop-color="#D07414"/></radialGradient>
  <linearGradient id="${id}w" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".88"/><stop offset=".6" stop-color="#FFF1CF" stop-opacity=".55"/><stop offset="1" stop-color="#FFD98A" stop-opacity=".42"/></linearGradient>
  <linearGradient id="${id}c" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient>
  <radialGradient id="${id}i" cx=".34" cy=".22" r=".95"><stop offset="0" stop-color="#FFFDF7"/><stop offset=".45" stop-color="#F1E6D2"/><stop offset="1" stop-color="#BDA985"/></radialGradient>
  <clipPath id="${id}k"><ellipse cx="32" cy="60" rx="17" ry="12"/></clipPath>
  <clipPath id="${id}hc"><circle cx="32" cy="32" r="17.2"/></clipPath>`;

  const wings = `
  <g opacity=".95">
    <ellipse cx="13.5" cy="25" rx="10.5" ry="6" transform="rotate(-32 13.5 25)" fill="url(#${id}w)" stroke="${OUT}" stroke-opacity=".7" stroke-width="1"/>
    <ellipse cx="50.5" cy="25" rx="10.5" ry="6" transform="rotate(32 50.5 25)" fill="url(#${id}w)" stroke="${OUT}" stroke-opacity=".7" stroke-width="1"/>
    <path d="M7 22.5 Q13 22 19 25 M45 25 Q51 22 57 22.5" stroke="#fff" stroke-opacity=".55" stroke-width=".7" fill="none" stroke-linecap="round"/>
  </g>`;

  const body = `
  <ellipse cx="32" cy="60" rx="17" ry="12" fill="url(#${id}b)" stroke="${OUT}" stroke-width="1.4"/>
  <g clip-path="url(#${id}k)"><rect x="10" y="53.5" width="44" height="3.6" fill="#2E1D10"/><rect x="10" y="60.5" width="44" height="3.6" fill="#2E1D10"/></g>`;

  const antennae = (lx = 26, ly = 16, rx = 38, ry = 16) => `
  <path d="M${lx} ${ly} Q${lx - 2} ${ly - 7} ${lx - 6} ${ly - 10}" stroke="${OUT}" stroke-width="1.6" fill="none" stroke-linecap="round"/>
  <path d="M${rx} ${ry} Q${rx + 2} ${ry - 7} ${rx + 6} ${ry - 10}" stroke="${OUT}" stroke-width="1.6" fill="none" stroke-linecap="round"/>
  <circle cx="${lx - 6}" cy="${ly - 10}" r="2.4" fill="url(#${id}t)" stroke="${OUT}" stroke-width="1"/>
  <circle cx="${rx + 6}" cy="${ry - 10}" r="2.4" fill="url(#${id}t)" stroke="${OUT}" stroke-width="1"/>`;

  const head = `
  <circle cx="32" cy="32" r="17.2" fill="url(#${id}h)" stroke="${OUT}" stroke-width="1.6"/>
  <g clip-path="url(#${id}hc)">
    <path d="M40 48 Q51 40 49 26 Q47 44 32 49.5Z" fill="#B4600E" opacity=".35"/>
    <path d="M17 30 Q18 18 30 15.5" stroke="#fff" stroke-opacity=".5" stroke-width="1.4" fill="none" stroke-linecap="round"/>
  </g>`;

  const face = `
  <ellipse cx="25.6" cy="31.6" rx="3.7" ry="4.5" fill="url(#${id}e)"/>
  <ellipse cx="38.4" cy="31.6" rx="3.7" ry="4.5" fill="url(#${id}e)"/>
  <circle cx="24.4" cy="30" r="1.35" fill="#fff"/><circle cx="37.2" cy="30" r="1.35" fill="#fff"/>
  <circle cx="26.8" cy="33.4" r=".6" fill="#fff" opacity=".85"/><circle cx="39.6" cy="33.4" r=".6" fill="#fff" opacity=".85"/>
  <ellipse cx="20.6" cy="38" rx="2.9" ry="1.7" fill="#FF7E5F" opacity=".42"/>
  <ellipse cx="43.4" cy="38" rx="2.9" ry="1.7" fill="#FF7E5F" opacity=".42"/>
  <path d="M27.6 38.4 Q32 44.4 36.4 38.4 Q32 40.2 27.6 38.4Z" fill="#4A2412" stroke="${OUT}" stroke-width=".8" stroke-linejoin="round"/>
  <path d="M30 41.2 Q32 42.6 34 41.2 Q32 40.6 30 41.2Z" fill="#E5735A"/>`;

  const brows = (raise) => `
  <path d="M22.6 25.6 Q25.4 ${raise ? 23.2 : 24.4} 28.4 25.4" stroke="${OUT}" stroke-width="1.1" fill="none" stroke-linecap="round"/>
  <path d="M35.6 25.4 Q38.6 24.4 41.4 25.6" stroke="${OUT}" stroke-width="1.1" fill="none" stroke-linecap="round"/>`;

  let back = '';
  let top = '';
  let ant = antennae();
  let browRaise = false;

  switch (k) {
    case 'mel':
      ant = antennae(25, 14, 39, 14);
      browRaise = true;
      top = `
  <path d="M14.6 26.6 Q15 11.4 32 10.8 Q49 11.4 49.4 26.6Z" fill="url(#${id}i)" stroke="${OUT}" stroke-width="1.4"/>
  <path d="M15.2 22.6 Q32 19.6 48.8 22.6 L49.2 25.6 Q32 22.8 14.8 25.6Z" fill="#E9951E" stroke="${OUT}" stroke-width=".8"/>
  <ellipse cx="32" cy="26.8" rx="20.4" ry="3" fill="#EFE4CF" stroke="${OUT}" stroke-width="1.3"/>
  <path d="M32 13.2 l3.2 1.85 v3.7 L32 20.6 l-3.2-1.85 v-3.7Z" fill="#FFB531" stroke="${OUT}" stroke-width=".8"/>
  <path d="M19 19 Q22 13.6 28 12.6" stroke="#fff" stroke-opacity=".75" stroke-width="1.1" fill="none" stroke-linecap="round"/>
  <path d="M48.6 31 Q49.6 40 42.4 43.4" stroke="${OUT}" stroke-width="1.6" fill="none" stroke-linecap="round"/>
  <circle cx="41.6" cy="43.6" r="1.9" fill="#3A281A" stroke="${OUT}" stroke-width=".8"/>
  <rect x="47" y="27.6" width="4" height="6.4" rx="1.6" fill="#3A281A" stroke="${OUT}" stroke-width=".8"/>`;
      break;
    case 'dev':
      top = `
  <path d="M15.4 25.4 Q15.8 12.6 32 12.2 Q45.4 12.4 48.4 21.8 Q55 22.8 57.6 25.4 Q51.6 27.2 48.6 26 Q32 23.2 15.4 25.4Z" fill="url(#${id}c)" stroke="${OUT}" stroke-width="1.3"/>
  <path d="M21 18.6 Q25 14.4 31 14" stroke="#fff" stroke-opacity=".45" stroke-width="1.1" fill="none" stroke-linecap="round"/>
  <circle cx="32" cy="12.6" r="1.5" fill="${c2}" stroke="${OUT}" stroke-width=".7"/>
  <g fill="#fff" fill-opacity=".1" stroke="${OUT}" stroke-width="1.3"><rect x="20.4" y="27.4" width="10.4" height="8.6" rx="2.4"/><rect x="33.2" y="27.4" width="10.4" height="8.6" rx="2.4"/></g>
  <path d="M30.8 30.4 Q32 29.4 33.2 30.4" stroke="${OUT}" stroke-width="1.2" fill="none"/>
  <rect x="25" y="52" width="14" height="8.4" rx="2.2" fill="#1E1A16" stroke="${OUT}" stroke-width=".8"/>
  <path d="M29.4 54.4 l-2 1.8 2 1.8 M34.6 54.4 l2 1.8-2 1.8 M32.8 53.8 l-1.6 4.8" stroke="${c1}" stroke-width=".9" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
      ant = antennae(26, 13.5, 38, 13.5);
      break;
    case 'designer':
      ant = antennae(30, 13, 40, 15);
      top = `
  <path d="M12.6 23.6 Q12 12.4 30 11.6 Q47.4 11.4 46.6 19.6 Q41 24.6 12.6 23.6Z" fill="url(#${id}c)" stroke="${OUT}" stroke-width="1.3"/>
  <path d="M17 18.4 Q21 13.8 29 13.4" stroke="#fff" stroke-opacity=".45" stroke-width="1.1" fill="none" stroke-linecap="round"/>
  <path d="M30 11.8 q.4-2.6 2.4-2.8" stroke="${OUT}" stroke-width="1.4" fill="none" stroke-linecap="round"/>
  <path d="M51 46 L58.6 29.4" stroke="#8A5A34" stroke-width="2.2" stroke-linecap="round"/>
  <path d="M58.6 29.4 l1.6-3.6 q1.6 1.8 .2 4.6Z" fill="${c1}" stroke="${OUT}" stroke-width=".7"/>
  <circle cx="46" cy="41" r="1.2" fill="${c}" opacity=".9"/>`;
      break;
    case 'qa':
      browRaise = true;
      top = `
  <circle cx="38.4" cy="31.8" r="7.2" fill="#fff" fill-opacity=".14" stroke="${OUT}" stroke-width="1.8"/>
  <circle cx="38.4" cy="31.8" r="5.6" fill="none" stroke="${c1}" stroke-width="1"/>
  <path d="M35 28.2 Q36.6 26.8 38.6 26.8" stroke="#fff" stroke-opacity=".8" stroke-width="1.1" fill="none" stroke-linecap="round"/>
  <path d="M43.6 37 L50.8 45.4" stroke="${OUT}" stroke-width="3.4" stroke-linecap="round"/>
  <path d="M43.6 37 L50.8 45.4" stroke="${c}" stroke-width="1.8" stroke-linecap="round"/>
  <circle cx="32" cy="56" r="4.2" fill="${c}" stroke="${OUT}" stroke-width=".9"/>
  <path d="M30 56 l1.4 1.4 2.8-2.9" stroke="#1E1A16" stroke-width="1.1" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
      break;
    case 'writer':
      top = `
  <g fill="#fff" fill-opacity=".1" stroke="${OUT}" stroke-width="1.2"><circle cx="25.6" cy="31.8" r="5.4"/><circle cx="38.4" cy="31.8" r="5.4"/></g>
  <path d="M31 31 Q32 30.2 33 31" stroke="${OUT}" stroke-width="1.1" fill="none"/>
  <g transform="rotate(-38 47 16)"><rect x="40.6" y="14.4" width="13" height="3.4" rx=".8" fill="#FFCF5A" stroke="${OUT}" stroke-width=".8"/><path d="M53.6 14.4 l3 1.7-3 1.7Z" fill="#F2D7B0" stroke="${OUT}" stroke-width=".7"/><rect x="38.4" y="14.4" width="2.4" height="3.4" fill="${c}" stroke="${OUT}" stroke-width=".7"/></g>
  <path d="M17.4 50.6 Q32 57.2 46.6 50.6 L45 55 Q32 60.6 19 55Z" fill="url(#${id}c)" stroke="${OUT}" stroke-width="1"/>`;
      break;
    default:
      top = `
  <path d="M15.2 24.6 Q32 18.4 48.8 24.6 L48.4 28 Q32 22.4 15.6 28Z" fill="url(#${id}c)" stroke="${OUT}" stroke-width="1.1"/>
  <path d="M48.4 25.4 l5.6-2.6 -1.2 4.4 2.6 3 -5.6-.8Z" fill="url(#${id}c)" stroke="${OUT}" stroke-width=".9" stroke-linejoin="round"/>
  <path d="M32 50.6 l5.2 3 v6 L32 62.6 l-5.2-3 v-6Z" fill="${c}" stroke="${OUT}" stroke-width=".9"/>
  <text x="32" y="59" text-anchor="middle" font-family="system-ui, sans-serif" font-size="6.2" font-weight="700" fill="#1E1A16">${initial.replace(/[<&>]/g, '')}</text>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" class="bee bee-${k}" role="img" aria-label="${String(title).replace(/"/g, '&quot;')}"><defs>${defs}</defs>${back}${wings}${body}${ant}${head}${face}${brows(browRaise)}${top}</svg>`;
}

/** Avatar element: bee on a soft hexagon in the worker color. */
export function beeAvatar(worker, size = 32, { ring = true, status } = {}) {
  const el = document.createElement('span');
  el.className = `bee-av${ring ? ' bee-av-ring' : ''}`;
  el.style.setProperty('--av', `${size}px`);
  el.style.setProperty('--wc', worker?.color || '#FFB531');
  el.innerHTML = beeSvg(worker || {}, { title: '' });
  el.querySelector('svg').setAttribute('aria-hidden', 'true');
  if (status) {
    const dot = document.createElement('span');
    dot.className = `sdot sdot-${status}`;
    el.append(dot);
  }
  return el;
}
