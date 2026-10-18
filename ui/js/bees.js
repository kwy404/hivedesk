// The agent unit: one geometric bee for Mel and the whole crew (docs/1.0/DESIGN.md, section 4).
// A hexagon abdomen in the agent color with two ink bands, a round graphite head, hairline
// antennae, two translucent wings and the role glyph in the middle. No face. The status ring is
// drawn by the container (the City and Office canvas, or the .bee-av ring and dot in the DOM), so
// the same art serves every size from 20 to 96 px.
// The wings sit in <g opacity=".95"> so the canvas scenes can strip them and animate their own.

let n = 0;
const INK = '#14171B';
const HEAD = '#262B32';

const ROLE_KIND = {
  mel: 'mel', foreman: 'mel', planner: 'mel',
  dev: 'dev', developer: 'dev', code: 'dev', coder: 'dev', engineer: 'dev',
  designer: 'designer', design: 'designer', ui: 'designer',
  qa: 'qa', tester: 'qa', test: 'qa', checks: 'qa',
  writer: 'writer', docs: 'writer', copy: 'writer', readme: 'writer',
  reviewer: 'reviewer', review: 'reviewer',
  architect: 'architect',
  ops: 'ops', devops: 'ops', release: 'ops',
};

export function beeKind(worker) {
  if (!worker) return 'hired';
  return ROLE_KIND[worker.id] || ROLE_KIND[String(worker.role || '').toLowerCase().split(/\W/)[0]] || 'hired';
}

function mix(a, b, t) {
  const p = (h) => { const m = /^#?([0-9a-f]{6})$/i.exec(h || ''); const v = m ? parseInt(m[1], 16) : 0xf2a93b; return [v >> 16, (v >> 8) & 255, v & 255]; };
  const A = p(a); const B = p(b);
  const c = A.map((x, i) => Math.max(0, Math.min(255, Math.round(x + (B[i] - x) * t))));
  return `#${((1 << 24) | (c[0] << 16) | (c[1] << 8) | c[2]).toString(16).slice(1)}`;
}

/** The role glyph, drawn in ink around the abdomen center (32, 41). */
const GLYPH = {
  mel: '<path d="M26.5 40.6 32 36.8l5.5 3.8M26.5 45.6 32 41.8l5.5 3.8"/>',
  dev: '<path d="M27.6 37.6 24.4 41l3.2 3.4M36.4 37.6l3.2 3.4-3.2 3.4M33.3 36.6l-2.6 8.8"/>',
  designer: '<path d="M32 35.6l4.2 5.6L32 46.8l-4.2-5.6z"/><path d="M32 41.2v.01"/>',
  qa: '<path d="M27 41.3l3.3 3.3 6.7-6.8"/>',
  writer: '<path d="M26.4 37.6h11.2M26.4 41.4h11.2M26.4 45.2h6.8"/>',
  reviewer: '<circle cx="31" cy="40.4" r="3.5"/><path d="M33.6 43l3.2 3.2"/>',
  architect: '<path d="M32 35.8 28 46.4M32 35.8l4 10.6M29.3 42.8h5.4"/>',
  ops: '<path d="M25.4 41.4h3.2l1.8-3.8 3 7.6 1.8-3.8h3.4"/>',
};

/**
 * @param {{ id?: string, role?: string, color?: string, name?: string }} worker
 * @param {{ kind?: string, title?: string }} [opts]
 * @returns {string} SVG markup
 */
export function beeSvg(worker = {}, opts = {}) {
  const k = opts.kind || beeKind(worker);
  const id = `b${++n}`;
  const raw = /^#[0-9a-f]{6}$/i.test(worker.color || '') ? worker.color : '#F2A93B';
  // identity colors are muted a little toward neutral gray (docs/1.0/DESIGN.md, 2.1)
  const c = mix(raw, '#8A919B', 0.2);
  const c1 = mix(c, '#FFFFFF', 0.16); const c2 = mix(c, '#000000', 0.22);
  const title = opts.title ?? (worker.name ? `${worker.name}` : 'bee');
  const initial = (worker.name || '?').trim().charAt(0).toUpperCase().replace(/[<&>"']/g, '');
  const hex = 'M32 24 46.7 32.5v17L32 58 17.3 49.5v-17z';

  const defs = `<linearGradient id="${id}a" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient>`
    + `<clipPath id="${id}k"><path d="${hex}"/></clipPath>`;
  const wings = '<g opacity=".95">'
    + '<path d="M29 29.5C24 21 13.5 17.5 9.2 21.4 5.4 25 10 32.8 21 33.4z" fill="#E6EAF0" fill-opacity=".16" stroke="#E6EAF0" stroke-opacity=".5" stroke-width="1"/>'
    + '<path d="M35 29.5C40 21 50.5 17.5 54.8 21.4 58.6 25 54 32.8 43 33.4z" fill="#E6EAF0" fill-opacity=".16" stroke="#E6EAF0" stroke-opacity=".5" stroke-width="1"/>'
    + '</g>';
  const antennae = `<path d="M29.6 11.6 25.6 4.6M34.4 11.6l4-7" stroke="${HEAD}" stroke-width="1.6" stroke-linecap="round" fill="none"/>`
    + `<circle cx="25.4" cy="4.3" r="1.7" fill="${c}"/><circle cx="38.6" cy="4.3" r="1.7" fill="${c}"/>`;
  const head = `<circle cx="32" cy="17" r="7.4" fill="${HEAD}" stroke="${INK}" stroke-width="1.2"/>`
    + '<path d="M27.6 14.4a5.4 5.4 0 0 1 5-3" stroke="#FFFFFF" stroke-opacity=".22" stroke-width="1.2" fill="none" stroke-linecap="round"/>';
  const body = `<path d="${hex}" fill="url(#${id}a)" stroke="${INK}" stroke-width="1.4" stroke-linejoin="round"/>`
    + `<g clip-path="url(#${id}k)" fill="${INK}" fill-opacity=".9"><rect x="14" y="29.6" width="36" height="3.4"/><rect x="14" y="49.2" width="36" height="3.4"/></g>`
    + `<path d="M32 58l-1.6 3.6h3.2z" fill="${INK}"/>`;
  const mark = GLYPH[k]
    ? `<g fill="none" stroke="${INK}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${GLYPH[k]}</g>`
    : `<text x="32" y="44.6" text-anchor="middle" font-family="Inter, 'Segoe UI', system-ui, sans-serif" font-size="10" font-weight="700" fill="${INK}">${initial}</text>`;
  // Mel, the foreman: a hexagon badge on the head
  const badge = k === 'mel' ? `<path d="M32 13.6l2.9 1.7v3.4L32 20.4l-2.9-1.7v-3.4z" fill="${c1}"/>` : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" class="bee bee-${k}" role="img" aria-label="${String(title).replace(/"/g, '&quot;')}"><defs>${defs}</defs>${wings}${antennae}${body}${mark}${head}${badge}</svg>`;
}

/** Avatar element: the bee on a quiet hexagon tile tinted by the worker color. */
export function beeAvatar(worker, size = 32, { ring = true, status } = {}) {
  const el = document.createElement('span');
  el.className = `bee-av${ring ? ' bee-av-ring' : ''}`;
  el.style.setProperty('--av', `${size}px`);
  el.style.setProperty('--wc', worker?.color || '#F2A93B');
  el.innerHTML = beeSvg(worker || {}, { title: '' });
  el.querySelector('svg').setAttribute('aria-hidden', 'true');
  if (status) {
    const dot = document.createElement('span');
    dot.className = `sdot sdot-${status}`;
    el.append(dot);
  }
  return el;
}
