// The checks runner of the prompt library: small static checks that a playbook lists in its `checks`
// and that the QA and Test steps run on the workspace without a model. Each check looks at the files of
// its own type and is skipped when there is none. Level "error" blocks QA; "warn" is reported as a note.
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { checkHtml, checkCss } from '../../tools/check.js';
import { scanSecrets } from '../domains/security/scan.js';

const SECRET_SCAN = (fs) => fs.flatMap((f) => scanSecrets(f.path, f.text).map((x) => `${f.path}:${x.line}: ${x.title}`));

const HTML = ['.html', '.htm'];
const CSS = ['.css'];
const JS = ['.js', '.mjs', '.cjs'];
const MD = ['.md', '.markdown'];
const PY = ['.py'];
const TEXTUAL = [...HTML, ...CSS, ...JS, ...MD, ...PY, '.json', '.txt', '.yml', '.yaml', '.toml', '.sh', '.webmanifest'];
const YAML = ['.yml', '.yaml'];
/** Files without a useful extension that the domain checks read (Dockerfile, Containerfile). */
const NAMED_FILES = /(^|\/)(Dockerfile|Containerfile)(\.[\w-]+)?$/;
const base = (p) => path.posix.basename(String(p));
const jsonOf = (f) => { try { return JSON.parse(f.text); } catch { return null; } };
const named = (fs, re) => fs.filter((f) => re.test(base(f.path)));

const ext = (p) => path.extname(String(p)).toLowerCase();
const noComments = (html) => html.replace(/<!--[\s\S]*?-->/g, '');
/** HTML without comments and without the bodies of script and style blocks. */
const markup = (html) => noComments(html).replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '<$1></$1>');
const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return m ? (m[2] ?? m[3] ?? m[4] ?? '') : null;
};
const hasAttr = (tag, name) => new RegExp(`\\s${name}(\\s*=|\\s|>|/)`, 'i').test(tag);
const tags = (html, name) => [...markup(html).matchAll(new RegExp(`<${name}\\b[^>]*>`, 'gi'))].map((m) => m[0]);
const textOf = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const jsNoComments = (js) => js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
/** CSS text of a file: the .css itself, or the <style> blocks of an HTML page. */
const cssOf = (f) => (CSS.includes(ext(f.path)) ? f.text : [...f.text.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n'));
const scriptsOf = (html) => [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
  .filter((m) => !/\bsrc=/i.test(m[1]) && !/type=["']?(application\/(ld\+)?json|text\/template)/i.test(m[1]))
  .map((m) => ({ module: /type=["']?module/i.test(m[1]), code: m[2] }));

// ------------------------------------------------------------------ colors, for the contrast check
const NAMED = { white: '#ffffff', black: '#000000', red: '#ff0000', green: '#008000', blue: '#0000ff', gray: '#808080', grey: '#808080', yellow: '#ffff00', orange: '#ffa500', purple: '#800080', navy: '#000080', silver: '#c0c0c0', maroon: '#800000', teal: '#008080' };

export function parseColor(value) {
  const v = String(value || '').trim().toLowerCase();
  if (NAMED[v]) return parseColor(NAMED[v]);
  let m = v.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a };
  }
  m = v.match(/^rgba?\(\s*(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)(?:\s*[,/]\s*(\d*\.?\d+)(%?))?\s*\)$/);
  if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : m[5] ? +m[4] / 100 : +m[4] };
  return null;
}

function luminance({ r, g, b }) {
  const lin = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio between two colors (1 to 21). */
export function contrastRatio(a, b) {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

function cssVars(css) {
  const vars = {};
  for (const m of css.matchAll(/(--[\w-]+)\s*:\s*([^;}]+)/g)) if (!(m[1] in vars)) vars[m[1]] = m[2].trim();
  return vars;
}

function resolveVar(value, vars, depth = 0) {
  const v = String(value || '').trim();
  const m = v.match(/^var\(\s*(--[\w-]+)\s*(?:,\s*([^)]+))?\)$/);
  if (!m) return v;
  if (depth > 5) return '';
  return resolveVar(vars[m[1]] ?? m[2] ?? '', vars, depth + 1);
}

function contrastIssues(file, css) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const vars = cssVars(clean);
  const issues = [];
  for (const m of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const decl = {};
    for (const d of m[2].split(';')) {
      const i = d.indexOf(':');
      if (i > 0) decl[d.slice(0, i).trim().toLowerCase()] = d.slice(i + 1).replace(/!important/, '').trim();
    }
    const fg = parseColor(resolveVar(decl.color, vars));
    const bgRaw = decl['background-color'] ?? (decl.background && !/url\(|gradient/.test(decl.background) ? decl.background : undefined);
    const bg = parseColor(resolveVar(bgRaw, vars));
    if (!fg || !bg || fg.a < 1 || bg.a < 1) continue;
    const ratio = contrastRatio(fg, bg);
    if (ratio < 4.5) issues.push(`${file}: "${m[1].trim().slice(0, 60)}" has text contrast ${ratio.toFixed(2)} to 1, below 4.5 to 1`);
  }
  return issues;
}

// ------------------------------------------------------------------ JS syntax without running the code
/** Syntax problems of a JS source: classic scripts parse in a vm (no process), modules with node --check on stdin. */
export function jsSyntax(file, code, { module } = {}) {
  const isModule = module ?? (ext(file) === '.mjs' || /^\s*(import\s[\w{*"']|import\(|export\s)/m.test(code));
  if (!isModule) {
    try {
      new vm.Script(code.replace(/^#!.*/, ''), { filename: file });
      return [];
    } catch (err) {
      return [`${file}: syntax error ${String(err.message).split('\n')[0]}`];
    }
  }
  const r = spawnSync(process.execPath, ['--input-type=module', '--check', '-'], { input: code.replace(/^#!.*/, ''), encoding: 'utf8', timeout: 15000, windowsHide: true });
  if (r.status === 0) return [];
  const lines = String(r.stderr || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const msg = lines.find((l) => /Error/.test(l) && !l.startsWith('at ')) || 'does not parse';
  const where = lines[0]?.match(/:(\d+)$/);
  return [`${file}: syntax error${where ? ` on line ${where[1]}` : ''}: ${msg}`];
}

// ------------------------------------------------------------------ the registry
const each = (files, exts, fn) => files.filter((f) => exts.includes(ext(f.path))).flatMap((f) => fn(f) || []);

/**
 * id -> { level, types, describe, run(files, ctx) -> string[] }
 * `types` are the file extensions the check reads; with none of them in the workspace the check is skipped.
 */
export const CHECKS = {
  // HTML structure
  'html.doctype': { level: 'error', types: HTML, describe: 'the page starts with <!doctype html>', run: (fs) => each(fs, HTML, (f) => (/^\s*(<!--[\s\S]*?-->\s*)*<!doctype html>/i.test(f.text) ? [] : [`${f.path}: does not start with <!doctype html>`])) },
  'html.lang': { level: 'error', types: HTML, describe: '<html> has a lang attribute', run: (fs) => each(fs, HTML, (f) => (/<html\b[^>]*\blang=["']?[a-z]/i.test(f.text) ? [] : [`${f.path}: <html> has no lang attribute`])) },
  'html.title': { level: 'error', types: HTML, describe: 'a non empty <title>', run: (fs) => each(fs, HTML, (f) => (/<title>\s*[^<\s][^<]*<\/title>/i.test(f.text) ? [] : [`${f.path}: missing or empty <title>`])) },
  'html.viewport': { level: 'error', types: HTML, describe: 'the viewport meta is present', run: (fs) => each(fs, HTML, (f) => (/<meta[^>]+name=["']?viewport[^>]+content=["'][^"']*width=device-width/i.test(f.text) ? [] : [`${f.path}: missing <meta name="viewport" content="width=device-width, initial-scale=1">`])) },
  'html.charset': { level: 'warn', types: HTML, describe: 'a charset meta near the top', run: (fs) => each(fs, HTML, (f) => (/<meta[^>]+charset=["']?utf-8/i.test(f.text) ? [] : [`${f.path}: missing <meta charset="utf-8">`])) },
  'html.balanced': { level: 'error', types: HTML, describe: 'every tag is closed and nested right', run: (fs) => each(fs, HTML, (f) => checkHtml(f.path, f.text).filter((i) => /never closed|not closed|stray/.test(i))) },
  'html.h1': {
    level: 'error', types: HTML, describe: 'exactly one <h1>',
    run: (fs) => each(fs, HTML, (f) => {
      const n = tags(f.text, 'h1').length;
      return n === 1 ? [] : [n ? `${f.path}: ${n} <h1> elements, use one` : `${f.path}: no <h1>`];
    })
  },
  'html.heading-order': {
    level: 'warn', types: HTML, describe: 'heading levels do not skip (h2 then h4)',
    run: (fs) => each(fs, HTML, (f) => {
      const levels = [...markup(f.text).matchAll(/<h([1-6])\b/gi)].map((m) => +m[1]);
      for (let i = 1; i < levels.length; i++) if (levels[i] > levels[i - 1] + 1) return [`${f.path}: heading jumps from h${levels[i - 1]} to h${levels[i]}`];
      return [];
    })
  },
  'html.main': { level: 'error', types: HTML, describe: 'a <main> landmark', run: (fs) => each(fs, HTML, (f) => (tags(f.text, 'main').length || /role=["']main/i.test(f.text) ? [] : [`${f.path}: no <main> landmark`])) },
  'html.nav': { level: 'error', types: HTML, describe: 'navigation links sit in a <nav>', run: (fs) => each(fs, HTML, (f) => (tags(f.text, 'nav').length ? [] : [`${f.path}: no <nav> element for the navigation links`])) },
  'html.img-alt': { level: 'error', types: HTML, describe: 'every <img> has alt', run: (fs) => each(fs, HTML, (f) => tags(f.text, 'img').filter((t) => !hasAttr(t, 'alt')).slice(0, 3).map((t) => `${f.path}: ${t.slice(0, 60)} has no alt text`)) },
  'html.img-dimensions': { level: 'warn', types: HTML, describe: 'images have width and height (no layout shift)', run: (fs) => each(fs, HTML, (f) => tags(f.text, 'img').filter((t) => !hasAttr(t, 'width') || !hasAttr(t, 'height')).slice(0, 2).map((t) => `${f.path}: ${t.slice(0, 60)} has no width and height`)) },
  'html.lazy-images': {
    level: 'warn', types: HTML, describe: 'images after the first load lazily',
    run: (fs) => each(fs, HTML, (f) => { const imgs = tags(f.text, 'img').slice(1); return imgs.length && !imgs.every((t) => /loading=["']?lazy/i.test(t)) ? [`${f.path}: images below the first one should have loading="lazy"`] : []; })
  },
  'html.labels': {
    level: 'error', types: HTML, describe: 'every form control has a label',
    run: (fs) => each(fs, HTML, (f) => {
      const src = markup(f.text);
      const fors = new Set([...src.matchAll(/<label\b[^>]*\bfor=["']?([^"'\s>]+)/gi)].map((m) => m[1]));
      // Controls wrapped by a <label> count as labelled.
      const wrapped = new Set();
      for (const m of src.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/gi)) for (const c of m[1].matchAll(/<(input|select|textarea)\b[^>]*>/gi)) wrapped.add(c[0]);
      const out = [];
      for (const m of src.matchAll(/<(input|select|textarea)\b[^>]*>/gi)) {
        const t = m[0];
        const type = (attr(t, 'type') || '').toLowerCase();
        if (['hidden', 'submit', 'button', 'reset', 'image'].includes(type)) continue;
        if (wrapped.has(t) || hasAttr(t, 'aria-label') || hasAttr(t, 'aria-labelledby') || (attr(t, 'id') && fors.has(attr(t, 'id')))) continue;
        out.push(`${f.path}: ${t.slice(0, 70)} has no label`);
      }
      return out.slice(0, 4);
    })
  },
  'html.form-submit': {
    level: 'error', types: HTML, describe: 'every form has a submit button',
    run: (fs) => each(fs, HTML, (f) => [...markup(f.text).matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/gi)]
      .filter((m) => !/<button\b(?![^>]*type=["']?(button|reset))[^>]*>|<input\b[^>]*type=["']?submit/i.test(m[1]))
      .map(() => `${f.path}: a <form> has no submit button`))
  },
  'html.button-type': { level: 'warn', types: HTML, describe: 'buttons say their type', run: (fs) => each(fs, HTML, (f) => (tags(f.text, 'button').some((t) => !hasAttr(t, 'type')) ? [`${f.path}: a <button> has no type (button or submit)`] : [])) },
  'html.input-types': {
    level: 'warn', types: HTML, describe: 'email, phone and number fields use the right input type',
    run: (fs) => each(fs, HTML, (f) => tags(f.text, 'input').filter((t) => {
      const name = `${attr(t, 'name') || ''} ${attr(t, 'id') || ''}`.toLowerCase();
      const type = (attr(t, 'type') || 'text').toLowerCase();
      return (/email/.test(name) && type !== 'email') || (/phone|tel\b/.test(name) && type !== 'tel');
    }).slice(0, 2).map((t) => `${f.path}: ${t.slice(0, 60)} should use type="email" or type="tel"`))
  },
  'html.no-inline-handlers': { level: 'error', types: HTML, describe: 'no inline event handlers (onclick=)', run: (fs) => each(fs, HTML, (f) => { const m = markup(f.text).match(/<[a-z][^>]*\s(on[a-z]+)\s*=/i); return m ? [`${f.path}: inline handler ${m[1]}=, use addEventListener in a script`] : []; }) },
  'html.no-inline-styles': { level: 'warn', types: HTML, describe: 'no style="" attributes', run: (fs) => each(fs, HTML, (f) => { const n = (markup(f.text).match(/<[a-z][^>]*\sstyle\s*=/gi) || []).length; return n > 2 ? [`${f.path}: ${n} inline style attributes, move them to the stylesheet`] : []; }) },
  'html.link-text': {
    level: 'error', types: HTML, describe: 'links have real text (no empty links, no "click here")',
    run: (fs) => each(fs, HTML, (f) => {
      const out = [];
      for (const m of markup(f.text).matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
        const text = textOf(m[2]);
        const named = /aria-label=|title=/i.test(m[1]) || /<img\b[^>]*alt=["'][^"']+/i.test(m[2]);
        if (!text && !named) out.push(`${f.path}: a link has no text`);
        else if (/^(click here|here|read more|more|link)$/i.test(text)) out.push(`${f.path}: link text "${text}" does not say where it goes`);
      }
      return out.slice(0, 3);
    })
  },
  'html.external-rel': { level: 'error', types: HTML, describe: 'target="_blank" links have rel="noopener"', run: (fs) => each(fs, HTML, (f) => (tags(f.text, 'a').some((t) => /target=["']?_blank/i.test(t) && !/rel=["'][^"']*noopener/i.test(t)) ? [`${f.path}: a target="_blank" link has no rel="noopener"`] : [])) },
  'html.unique-ids': {
    level: 'error', types: HTML, describe: 'ids are unique',
    run: (fs) => each(fs, HTML, (f) => {
      const seen = new Set();
      const dup = new Set();
      for (const m of markup(f.text).matchAll(/\sid=["']([^"']+)["']/gi)) (seen.has(m[1]) ? dup : seen).add(m[1]);
      return dup.size ? [`${f.path}: duplicate id ${[...dup].slice(0, 3).join(', ')}`] : [];
    })
  },
  'html.table-headers': { level: 'error', types: HTML, describe: 'data tables have <th> headers', run: (fs) => each(fs, HTML, (f) => [...markup(f.text).matchAll(/<table\b[\s\S]*?<\/table>/gi)].filter((m) => !/<th\b/i.test(m[0])).map(() => `${f.path}: a <table> has no <th> header cells`)) },
  'html.meta-description': { level: 'error', types: HTML, describe: 'a meta description of 50 to 160 characters', run: (fs) => each(fs, HTML, (f) => { const m = f.text.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i) || f.text.match(/<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["']/i); return !m ? [`${f.path}: no meta description`] : m[1].length < 50 || m[1].length > 160 ? [`${f.path}: the meta description has ${m[1].length} characters, use 50 to 160`] : []; }) },
  'html.og-tags': { level: 'warn', types: HTML, describe: 'og:title and og:description for link previews', run: (fs) => each(fs, HTML, (f) => (/property=["']og:title/i.test(f.text) && /property=["']og:description/i.test(f.text) ? [] : [`${f.path}: missing og:title or og:description`])) },
  'html.json-ld': {
    level: 'error', types: HTML, describe: 'structured data in valid JSON-LD',
    run: (fs) => each(fs, HTML, (f) => {
      const blocks = [...f.text.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
      if (!blocks.length) return [`${f.path}: no <script type="application/ld+json"> block`];
      for (const b of blocks) { try { JSON.parse(b[1]); } catch (e) { return [`${f.path}: the JSON-LD block is not valid JSON (${e.message})`]; } }
      return [];
    })
  },
  'html.skip-link': { level: 'warn', types: HTML, describe: 'a skip link to the main content', run: (fs) => each(fs, HTML, (f) => (/<a\b[^>]*href=["']#(main|content)[^"']*["']/i.test(f.text) ? [] : [`${f.path}: no skip link (<a href="#main">)`])) },
  'html.script-defer': { level: 'warn', types: HTML, describe: 'scripts in <head> use defer or type="module"', run: (fs) => each(fs, HTML, (f) => { const head = (f.text.match(/<head\b[\s\S]*?<\/head>/i) || [''])[0]; return tags(head, 'script').some((t) => /\ssrc=/i.test(t) && !/\b(defer|async)\b|type=["']?module/i.test(t)) ? [`${f.path}: a script in <head> blocks rendering, add defer`] : []; }) },
  'html.dialog-a11y': {
    level: 'error', types: HTML, describe: 'a dialog has a role, a name and a close control',
    run: (fs) => each(fs, HTML, (f) => {
      const src = markup(f.text);
      const d = src.match(/<dialog\b[^>]*>|<[a-z]+\b[^>]*role=["']dialog["'][^>]*>/i);
      if (!d) return [`${f.path}: no <dialog> or role="dialog" element`];
      const out = [];
      if (!/aria-label(ledby)?=/i.test(d[0])) out.push(`${f.path}: the dialog has no aria-labelledby or aria-label`);
      if (!/<dialog\b/i.test(d[0]) && !/aria-modal=["']true/i.test(d[0])) out.push(`${f.path}: the role="dialog" element has no aria-modal="true"`);
      if (!/close|fechar|cancel/i.test(src)) out.push(`${f.path}: the dialog has no visible close control`);
      return out;
    })
  },
  'html.tabs-a11y': {
    level: 'error', types: HTML, describe: 'tabs use tablist, tab with aria-selected and tabpanel',
    run: (fs) => each(fs, HTML, (f) => {
      const s = markup(f.text);
      const out = [];
      if (!/role=["']tablist/i.test(s)) out.push(`${f.path}: no role="tablist"`);
      if (!/role=["']tab["']/i.test(s) || !/aria-selected=/i.test(s)) out.push(`${f.path}: the tabs need role="tab" and aria-selected`);
      if (!/role=["']tabpanel/i.test(s)) out.push(`${f.path}: no role="tabpanel"`);
      return out;
    })
  },
  'html.aria-live': { level: 'error', types: HTML, describe: 'status messages go to an aria-live region', run: (fs) => each(fs, HTML, (f) => (/aria-live=|role=["'](status|alert|log)["']|<output\b/i.test(f.text) ? [] : [`${f.path}: no aria-live, role="status" or role="alert" region for messages`])) },
  'html.svg-a11y': {
    level: 'error', types: HTML, describe: 'inline SVG graphics have a text alternative',
    run: (fs) => each(fs, HTML, (f) => [...noComments(f.text).matchAll(/<svg\b([^>]*)>([\s\S]*?)<\/svg>/gi)]
      .filter((m) => !/aria-hidden=["']true/i.test(m[1]) && !/aria-label(ledby)?=/i.test(m[1]) && !/<title\b/i.test(m[2]))
      .slice(0, 2).map(() => `${f.path}: an <svg> has no <title>, aria-label, or aria-hidden="true"`))
  },

  // CSS
  'css.braces': { level: 'error', types: [...CSS, ...HTML], describe: 'braces are balanced', run: (fs) => fs.filter((f) => CSS.includes(ext(f.path)) || /<style/i.test(f.text)).flatMap((f) => checkCss(f.path, cssOf(f))) },
  'css.media-query': { level: 'error', types: [...CSS, ...HTML], describe: 'at least one width media query (responsive)', run: (fs) => { const all = fs.map(cssOf).join('\n'); return /@media[^{]*\((min|max)-width/i.test(all) || /@container|clamp\(|minmax\(|auto-fit|auto-fill/i.test(all) ? [] : ['no width media query, container query or fluid grid in the styles']; } },
  'css.focus-visible': { level: 'error', types: [...CSS, ...HTML], describe: 'visible focus styles', run: (fs) => (/:focus(-visible|-within)?\b/.test(fs.map(cssOf).join('\n')) ? [] : ['no :focus or :focus-visible style']) },
  'css.reduced-motion': {
    level: 'error', types: [...CSS, ...HTML], describe: 'motion respects prefers-reduced-motion',
    run: (fs) => { const all = fs.map(cssOf).join('\n'); return /animation\s*:|@keyframes|transition\s*:/i.test(all) && !/prefers-reduced-motion/i.test(all) ? ['animations or transitions without a prefers-reduced-motion rule'] : []; }
  },
  'css.dark-scheme': { level: 'error', types: [...CSS, ...HTML], describe: 'a dark color scheme', run: (fs) => (/prefers-color-scheme\s*:\s*dark|\[data-theme=["']?dark|\.dark\b|color-scheme\s*:[^;]*dark/i.test(fs.map(cssOf).join('\n')) ? [] : ['no dark scheme (prefers-color-scheme: dark or a data-theme="dark" rule)']) },
  'css.custom-properties': { level: 'warn', types: [...CSS, ...HTML], describe: 'colors and sizes as custom properties on :root', run: (fs) => (/:root\s*\{[^}]*--[\w-]+\s*:/i.test(fs.map(cssOf).join('\n')) ? [] : ['no custom properties on :root (--color-text and the like)']) },
  'css.contrast': { level: 'error', types: [...CSS, ...HTML], describe: 'text and background pairs reach 4.5 to 1', run: (fs) => fs.flatMap((f) => contrastIssues(f.path, cssOf(f))).slice(0, 4) },
  'css.no-important': { level: 'warn', types: [...CSS, ...HTML], describe: 'at most three !important', run: (fs) => { const n = (fs.map(cssOf).join('\n').match(/!important/g) || []).length; return n > 3 ? [`${n} uses of !important, fix the specificity instead`] : []; } },
  'css.box-sizing': { level: 'warn', types: [...CSS, ...HTML], describe: 'box-sizing: border-box', run: (fs) => (/box-sizing\s*:\s*border-box/i.test(fs.map(cssOf).join('\n')) ? [] : ['no box-sizing: border-box reset']) },
  'css.min-font-size': { level: 'warn', types: [...CSS, ...HTML], describe: 'no font size below 12 px', run: (fs) => { const m = [...fs.map(cssOf).join('\n').matchAll(/font-size\s*:\s*(\d+(?:\.\d+)?)px/gi)].find((x) => +x[1] < 12); return m ? [`font-size ${m[1]}px is too small to read, use at least 12px`] : []; } },
  'css.no-fixed-width': { level: 'warn', types: [...CSS, ...HTML], describe: 'no fixed widths wider than a phone', run: (fs) => { const m = [...fs.map(cssOf).join('\n').replace(/@media[^{]*\{[\s\S]*?\}\s*\}/g, '').matchAll(/(?<![-\w])width\s*:\s*(\d+)px/gi)].find((x) => +x[1] > 400); return m ? [`width: ${m[1]}px overflows a 375 px screen, use max-width or a percentage`] : []; } },

  // JavaScript
  'js.syntax': {
    level: 'error', types: [...JS, ...HTML], describe: 'scripts parse (node --check)',
    run: (fs) => fs.flatMap((f) => (JS.includes(ext(f.path)) ? jsSyntax(f.path, f.text, { module: ext(f.path) === '.mjs' ? true : ext(f.path) === '.cjs' ? false : undefined }) : HTML.includes(ext(f.path)) ? scriptsOf(f.text).flatMap((s) => jsSyntax(`${f.path} <script>`, s.code, { module: s.module })) : []))
  },
  'js.no-eval': { level: 'error', types: [...JS, ...HTML], describe: 'no eval or new Function', run: (fs) => fs.filter((f) => JS.includes(ext(f.path)) || HTML.includes(ext(f.path))).flatMap((f) => (/\beval\s*\(|new\s+Function\s*\(/.test(jsNoComments(f.text)) ? [`${f.path}: uses eval or new Function`] : [])) },
  'js.no-document-write': { level: 'error', types: [...JS, ...HTML], describe: 'no document.write', run: (fs) => fs.flatMap((f) => (/document\.write(ln)?\s*\(/.test(f.text) ? [`${f.path}: uses document.write`] : [])) },
  'js.safe-dom': {
    level: 'error', types: [...JS, ...HTML], describe: 'no innerHTML built from variables (use textContent)',
    run: (fs) => fs.filter((f) => JS.includes(ext(f.path)) || HTML.includes(ext(f.path))).flatMap((f) => {
      const src = jsNoComments(HTML.includes(ext(f.path)) ? scriptsOf(f.text).map((s) => s.code).join('\n') : f.text);
      const bad = [...src.matchAll(/\b(innerHTML|outerHTML)\s*\+?=\s*([^;\n]+)/g)].find((m) => !/^\s*(['"])[^'"$]*\1\s*$/.test(m[2]) && !/^\s*`[^`$]*`\s*$/.test(m[2]));
      return bad || /insertAdjacentHTML\s*\(/.test(src) ? [`${f.path}: HTML is built from data (${bad ? bad[1] : 'insertAdjacentHTML'}), use textContent or createElement`] : [];
    })
  },
  'js.strict-equality': { level: 'warn', types: JS, describe: '=== and !== instead of == and !=', run: (fs) => each(fs, JS, (f) => (/[^=!<>]==[^=]|!=[^=]/.test(jsNoComments(f.text).replace(/[!=]=\s*null\b/g, '').replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '""')) ? [`${f.path}: uses == or !=, use === and !==`] : [])) },
  'js.no-var': { level: 'warn', types: JS, describe: 'const and let, not var', run: (fs) => each(fs, JS, (f) => (/(^|[;{}\s])var\s+[\w$]/m.test(jsNoComments(f.text)) ? [`${f.path}: uses var, use const or let`] : [])) },
  'js.no-console-log': { level: 'warn', types: JS, describe: 'no leftover console.log in browser code', run: (fs) => each(fs, JS, (f) => (/console\.log\(/.test(jsNoComments(f.text)) && !/process\.|require\(|from ['"]node:/.test(f.text) ? [`${f.path}: leftover console.log`] : [])) },
  'js.json-parse-guarded': { level: 'error', types: [...JS, ...HTML], describe: 'JSON.parse is inside try and catch', run: (fs) => fs.filter((f) => JS.includes(ext(f.path)) || HTML.includes(ext(f.path))).flatMap((f) => (/JSON\.parse\s*\(/.test(f.text) && !/\btry\s*\{/.test(f.text) ? [`${f.path}: JSON.parse without try and catch, bad data would crash it`] : [])) },
  'js.storage-guarded': { level: 'error', types: [...JS, ...HTML], describe: 'localStorage access survives a blocked or full storage', run: (fs) => fs.filter((f) => JS.includes(ext(f.path)) || HTML.includes(ext(f.path))).flatMap((f) => (/localStorage\./.test(f.text) && !/\btry\s*\{/.test(f.text) ? [`${f.path}: localStorage is used without try and catch`] : [])) },
  'js.async-errors': { level: 'warn', types: JS, describe: 'awaited calls have error handling', run: (fs) => each(fs, JS, (f) => (/\bawait\b/.test(f.text) && !/\btry\s*\{|\.catch\(/.test(f.text) ? [`${f.path}: await without try and catch or .catch`] : [])) },
  'js.no-sync-in-handlers': { level: 'warn', types: JS, describe: 'servers do not block on sync file reads per request', run: (fs) => each(fs, JS, (f) => (/createServer\s*\(/.test(f.text) && /(readFileSync|writeFileSync)\s*\(/.test(f.text.slice(f.text.search(/createServer\s*\(/))) ? [`${f.path}: a request handler uses a sync file call`] : [])) },

  // Node servers and CLIs
  'node.shebang': { level: 'error', types: JS, describe: 'a CLI script starts with #!/usr/bin/env node', run: (fs) => each(fs, JS, (f) => (/process\.argv/.test(f.text) && !/^#!\/usr\/bin\/env node/.test(f.text) ? [`${f.path}: reads process.argv but has no #!/usr/bin/env node line`] : [])) },
  'node.exit-code': { level: 'error', types: JS, describe: 'a CLI exits with a non zero code on failure', run: (fs) => each(fs, JS, (f) => (/process\.argv/.test(f.text) && !/process\.exit\(\s*[1-9]|process\.exitCode\s*=\s*[1-9]/.test(f.text) ? [`${f.path}: never sets a non zero exit code on errors`] : [])) },
  'node.http-status': {
    level: 'error', types: JS, describe: 'an HTTP server sends status codes and a 404',
    run: (fs) => each(fs, JS, (f) => {
      if (!/createServer\s*\(/.test(f.text)) return [];
      const out = [];
      if (!/writeHead\s*\(|statusCode\s*=/.test(f.text)) out.push(`${f.path}: the server never sets a status code`);
      if (!/404/.test(f.text)) out.push(`${f.path}: the server has no 404 for unknown routes`);
      return out;
    })
  },
  'node.json-content-type': { level: 'error', types: JS, describe: 'JSON responses say application/json', run: (fs) => each(fs, JS, (f) => (/createServer\s*\(/.test(f.text) && /JSON\.stringify/.test(f.text) && !/application\/json/.test(f.text) ? [`${f.path}: sends JSON without content-type application/json`] : [])) },
  'node.body-limit': { level: 'error', types: JS, describe: 'request bodies have a size limit', run: (fs) => each(fs, JS, (f) => (/createServer\s*\(/.test(f.text) && /on\(\s*['"]data['"]/.test(f.text) && !/(length|size|bytes)\s*>\s*[\d_]+|limit/i.test(f.text) ? [`${f.path}: reads the request body with no size limit`] : [])) },
  'node.esm': { level: 'warn', types: JS, describe: 'ES modules with node: imports', run: (fs) => each(fs, JS, (f) => (/\brequire\s*\(\s*['"](fs|path|http|url|os|crypto|child_process)['"]\s*\)/.test(f.text) ? [`${f.path}: use import from "node:..." instead of require`] : [])) },

  // Data files
  'json.valid': { level: 'error', types: ['.json'], describe: 'JSON files parse', run: (fs) => each(fs, ['.json'], (f) => { try { JSON.parse(f.text); return []; } catch (e) { return [`${f.path}: invalid JSON (${e.message})`]; } }) },
  'pkg.scripts': {
    level: 'warn', types: ['.json'], describe: 'package.json has name, version, type and a test script',
    run: (fs) => fs.filter((f) => path.posix.basename(f.path) === 'package.json').flatMap((f) => {
      let p;
      try { p = JSON.parse(f.text); } catch { return [`${f.path}: invalid JSON`]; }
      return ['name', 'version'].filter((k) => !p[k]).map((k) => `${f.path}: no "${k}"`).concat(p.scripts?.test ? [] : [`${f.path}: no "test" script`]);
    })
  },
  'csv.consistent': { level: 'error', types: ['.csv'], describe: 'every CSV row has the header column count', run: (fs) => each(fs, ['.csv'], (f) => { const rows = f.text.trim().split(/\r?\n/).filter(Boolean).map((l) => l.split(',').length); const bad = rows.findIndex((n) => n !== rows[0]); return bad > 0 && !/"/.test(f.text) ? [`${f.path}: row ${bad + 1} has ${rows[bad]} columns, the header has ${rows[0]}`] : []; }) },

  // Python
  'py.indent': { level: 'error', types: PY, describe: 'indentation does not mix tabs and spaces', run: (fs) => each(fs, PY, (f) => (/^\t/m.test(f.text) && /^ {2,}\S/m.test(f.text) ? [`${f.path}: mixes tabs and spaces`] : [])) },
  'py.main-guard': { level: 'warn', types: PY, describe: 'scripts run under if __name__ == "__main__"', run: (fs) => each(fs, PY, (f) => (/^def main\b|^[a-z_]+\(.*\)\s*$/m.test(f.text) && !/__name__\s*==\s*["']__main__["']/.test(f.text) ? [`${f.path}: no if __name__ == "__main__": guard`] : [])) },
  'py.no-bare-except': { level: 'error', types: PY, describe: 'no bare except:', run: (fs) => each(fs, PY, (f) => (/^\s*except\s*:/m.test(f.text) ? [`${f.path}: bare except: hides every error, name the exception`] : [])) },
  'py.balanced': {
    level: 'error', types: PY, describe: 'brackets and quotes are balanced',
    run: (fs) => each(fs, PY, (f) => {
      const s = f.text.replace(/("""|''')[\s\S]*?\1/g, '').replace(/#.*$/gm, '').replace(/(['"])(?:\\.|(?!\1)[^\\\n])*\1/g, '""');
      const pairs = { ')': '(', ']': '[', '}': '{' };
      const st = [];
      for (const ch of s) {
        if ('([{'.includes(ch)) st.push(ch);
        else if (pairs[ch]) { if (st.pop() !== pairs[ch]) return [`${f.path}: unbalanced ${ch}`]; }
      }
      return st.length ? [`${f.path}: ${st.length} unclosed bracket`] : [];
    })
  },

  // Markdown and docs
  'md.h1': { level: 'error', types: MD, describe: 'Markdown files start with a # heading', run: (fs) => each(fs, MD, (f) => (/^\s*(<!--[\s\S]*?-->\s*)?#\s+\S/.test(f.text) ? [] : [`${f.path}: does not start with a # heading`])) },
  'md.fences': { level: 'error', types: MD, describe: 'code fences are closed', run: (fs) => each(fs, MD, (f) => ((f.text.match(/^\s*```/gm) || []).length % 2 ? [`${f.path}: a code fence is not closed`] : [])) },
  'md.sections': { level: 'warn', types: MD, describe: 'docs have at least two ## sections', run: (fs) => each(fs, MD, (f) => ((f.text.match(/^##\s+\S/gm) || []).length >= 2 ? [] : [`${f.path}: fewer than two ## sections`])) },
  'md.local-links': {
    level: 'error', types: MD, describe: 'local links in Markdown point to files that exist',
    run: (fs, ctx) => each(fs, MD, (f) => [...f.text.matchAll(/\]\(([^)\s#]+)(#[^)]*)?\)/g)].map((m) => m[1]).filter((r) => !/^[a-z]+:|^\/\//i.test(r))
      .filter((r) => ctx.exists && !ctx.exists(path.posix.normalize(path.posix.join(path.posix.dirname(f.path), r))))
      .slice(0, 3).map((r) => `${f.path}: links to ${r}, which does not exist`))
  },
  'md.changelog': { level: 'error', types: MD, describe: 'CHANGELOG has version headings with dates', run: (fs) => fs.filter((f) => /changelog/i.test(f.path)).flatMap((f) => (/^##\s+\[?\d+\.\d+\.\d+\]?.*\d{4}-\d{2}-\d{2}|^##\s+\[?unreleased/im.test(f.text) ? [] : [`${f.path}: no "## 1.2.0 - 2026-01-31" style version heading`])) },

  // Domain skeletons (src/crew/domains/templates/): mobile (PWA and Capacitor), desktop (Neutralinojs),
  // browser extensions, games, backend, CLI, DevOps, and the security rules of the audit.
  'pwa.manifest': {
    level: 'error', types: ['.json', '.webmanifest'], describe: 'a web app manifest with name, start_url, display and icons',
    run: (fs) => {
      const m = named(fs, /^(manifest\.webmanifest|manifest\.json|site\.webmanifest)$/).filter((f) => !/"manifest_version"/.test(f.text));
      if (!m.length) return ['no manifest.webmanifest (an installable app needs one)'];
      return m.flatMap((f) => {
        const j = jsonOf(f);
        if (!j) return [`${f.path}: invalid JSON`];
        const out = ['name', 'start_url', 'display'].filter((k) => !j[k]).map((k) => `${f.path}: no "${k}"`);
        if (!Array.isArray(j.icons) || !j.icons.length) out.push(`${f.path}: no icons`);
        return out;
      });
    }
  },
  'pwa.service-worker': {
    level: 'error', types: [...JS, ...HTML], describe: 'a service worker is registered for offline use',
    run: (fs) => (fs.some((f) => /serviceWorker\.register\s*\(/.test(f.text)) ? [] : ['no navigator.serviceWorker.register call, the app does not work offline'])
  },
  'capacitor.config': {
    level: 'error', types: ['.json'], describe: 'capacitor.config.json has appId, appName and webDir',
    run: (fs) => {
      const c = named(fs, /^capacitor\.config\.json$/);
      if (!c.length) return ['no capacitor.config.json'];
      return c.flatMap((f) => {
        const j = jsonOf(f);
        if (!j) return [`${f.path}: invalid JSON`];
        const out = ['appId', 'appName', 'webDir'].filter((k) => !j[k]).map((k) => `${f.path}: no "${k}"`);
        if (j.appId && !/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/i.test(j.appId)) out.push(`${f.path}: appId "${j.appId}" is not a reverse domain id like com.example.app`);
        return out;
      });
    }
  },
  'neu.config': {
    level: 'error', types: ['.json'], describe: 'neutralino.config.json has an app id, a window and a restricted native allow list',
    run: (fs) => {
      const c = named(fs, /^neutralino\.config\.json$/);
      if (!c.length) return ['no neutralino.config.json'];
      return c.flatMap((f) => {
        const j = jsonOf(f);
        if (!j) return [`${f.path}: invalid JSON`];
        const out = [];
        if (!j.applicationId) out.push(`${f.path}: no "applicationId"`);
        if (!j.modes?.window) out.push(`${f.path}: no "modes.window" section`);
        if (!Array.isArray(j.nativeAllowList)) out.push(`${f.path}: no "nativeAllowList", list only the native calls the app uses`);
        else if (j.nativeAllowList.some((x) => x === '*' || x === 'os.*' || x === 'os.execCommand')) out.push(`${f.path}: nativeAllowList allows running commands (os.*), allow only what the app uses`);
        return out;
      });
    }
  },
  'ext.manifest-v3': {
    level: 'error', types: ['.json'], describe: 'a Manifest V3 extension manifest with narrow permissions',
    run: (fs) => {
      const m = named(fs, /^manifest\.json$/).filter((f) => /"manifest_version"/.test(f.text));
      if (!m.length) return ['no extension manifest.json with "manifest_version"'];
      return m.flatMap((f) => {
        const j = jsonOf(f);
        if (!j) return [`${f.path}: invalid JSON`];
        const out = [];
        if (j.manifest_version !== 3) out.push(`${f.path}: manifest_version is ${j.manifest_version}, use 3`);
        for (const k of ['name', 'version']) if (!j[k]) out.push(`${f.path}: no "${k}"`);
        if (j.background?.scripts || j.background?.page) out.push(`${f.path}: background pages are Manifest V2, use background.service_worker`);
        const hosts = [...(j.host_permissions || []), ...(j.permissions || [])];
        if (hosts.some((h) => h === '<all_urls>' || h === '*://*/*')) out.push(`${f.path}: asks for every site (<all_urls>), list the sites it needs or use activeTab`);
        return out;
      });
    }
  },
  'ext.no-remote-code': {
    level: 'error', types: [...JS, ...HTML], describe: 'extension code loads no remote scripts',
    run: (fs) => fs.filter((f) => JS.includes(ext(f.path)) || HTML.includes(ext(f.path))).flatMap((f) => (/<script[^>]+src=["']https?:|importScripts\s*\(\s*["']https?:|import\s*\(\s*["']https?:/i.test(f.text) ? [`${f.path}: loads code from the network, extensions must ship all code in the package`] : []))
  },
  'game.loop': {
    level: 'error', types: [...JS, ...HTML], describe: 'a canvas game loop on requestAnimationFrame with a time step',
    run: (fs) => {
      const all = fs.filter((f) => JS.includes(ext(f.path)) || HTML.includes(ext(f.path))).map((f) => f.text).join('\n');
      const out = [];
      if (!/getContext\s*\(\s*['"](2d|webgl2?)['"]/.test(all)) out.push('no canvas getContext call');
      if (!/requestAnimationFrame\s*\(/.test(all)) out.push('no requestAnimationFrame loop (setInterval games stutter and keep running in background tabs)');
      else if (!/\b(dt|delta|elapsed|timestamp|now)\b/i.test(all)) out.push('the loop ignores the frame time, so speed depends on the screen refresh rate');
      return out;
    }
  },
  'node.test-runner': {
    level: 'error', types: JS, describe: 'tests use node:test and node:assert',
    run: (fs) => {
      const tests = fs.filter((f) => JS.includes(ext(f.path)) && /(^|\/)(test|tests)\/|\.test\.m?js$|(^|\/)test\.m?js$/.test(f.path));
      if (!tests.length) return ['no test file (test/*.test.js)'];
      return tests.filter((f) => !/['"]node:test['"]/.test(f.text) || !/node:assert/.test(f.text)).map((f) => `${f.path}: import test from "node:test" and assert from "node:assert/strict"`);
    }
  },
  'cli.help': {
    level: 'error', types: JS, describe: 'a CLI answers --help and rejects unknown flags',
    run: (fs) => each(fs, JS, (f) => {
      if (!/process\.argv/.test(f.text) || !/^#!/.test(f.text)) return [];
      const out = [];
      if (!/--help|['"]-h['"]/.test(f.text)) out.push(`${f.path}: no --help`);
      if (!/unknown (option|flag|argument)|parseArgs\s*\(/i.test(f.text)) out.push(`${f.path}: unknown flags are not rejected`);
      return out;
    })
  },
  'sec.no-secrets': {
    level: 'error', types: [], describe: 'no API keys, tokens or private keys in the files',
    run: (fs) => SECRET_SCAN(fs).slice(0, 5)
  },
  'sec.no-shell-input': {
    level: 'error', types: [...JS, ...PY], describe: 'shell commands are not built from input',
    run: (fs) => fs.filter((f) => JS.includes(ext(f.path)) || PY.includes(ext(f.path))).flatMap((f) => {
      const src = JS.includes(ext(f.path)) ? jsNoComments(f.text) : f.text;
      const bad = /\b(exec|execSync)\s*\(\s*(`[^`]*\$\{|\w+\s*\+|['"][^'"]*['"]\s*\+)/.test(src) || /\b(os\.system|subprocess\.(run|call|Popen))\s*\(\s*f["']|shell\s*=\s*True/.test(src);
      return bad ? [`${f.path}: a shell command is built from a variable, use execFile or spawn with an argument list`] : [];
    })
  },
  'sec.sql-params': {
    level: 'error', types: [...JS, ...PY], describe: 'SQL uses parameters, not string concatenation',
    run: (fs) => fs.filter((f) => JS.includes(ext(f.path)) || PY.includes(ext(f.path))).flatMap((f) => (/\b(SELECT|INSERT|UPDATE|DELETE)\b[^;\n]*?(\$\{|['"]\s*\+\s*\w|['"]\s*%\s*\w|\{\w+\})/.test(f.text) ? [`${f.path}: SQL is built from strings, use placeholders (? or $1) and pass the values`] : []))
  },
  'sec.csp': {
    level: 'error', types: HTML, describe: 'pages set a Content-Security-Policy',
    run: (fs) => each(fs, HTML, (f) => (/http-equiv=["']Content-Security-Policy/i.test(f.text) ? [] : [`${f.path}: no <meta http-equiv="Content-Security-Policy">`]))
  },
  'sec.weak-crypto': {
    level: 'error', types: [...JS, ...PY], describe: 'no MD5 or SHA-1 for security and no Math.random for tokens',
    run: (fs) => fs.filter((f) => JS.includes(ext(f.path)) || PY.includes(ext(f.path))).flatMap((f) => {
      const out = [];
      if (/createHash\s*\(\s*['"](md5|sha1)['"]|hashlib\.(md5|sha1)\s*\(/i.test(f.text)) out.push(`${f.path}: MD5 or SHA-1 hash, use SHA-256 (and scrypt for passwords)`);
      if (/(token|secret|password|session|nonce|salt)\w*\s*[=:][^;\n]*Math\.random\(/i.test(f.text)) out.push(`${f.path}: Math.random for a secret value, use crypto.randomBytes or crypto.randomUUID`);
      return out;
    })
  },
  'container.nonroot': {
    level: 'error', types: [], describe: 'container images run as a non root user',
    run: (fs) => named(fs, NAMED_FILES).filter((f) => !/^\s*USER\s+(?!root\b|0\b)\S+/m.test(f.text)).map((f) => `${f.path}: no USER line, the container runs as root`)
  },
  'container.pinned': {
    level: 'error', types: [], describe: 'base images are pinned to a version, not latest',
    run: (fs) => named(fs, NAMED_FILES).flatMap((f) => [...f.text.matchAll(/^\s*FROM\s+(\S+)/gim)].map((m) => m[1])
      .filter((img) => img.toLowerCase() !== 'scratch' && !/^\$/.test(img) && (!/:[\w.-]+$/.test(img.replace(/^[^/]+:\d+\//, '')) || /:latest$/.test(img)))
      .map((img) => `${f.path}: FROM ${img} is not pinned, use a version tag`))
  },
  'ci.workflow': {
    level: 'error', types: YAML, describe: 'CI workflows have jobs, pinned steps and no secrets echoed',
    run: (fs) => each(fs, YAML, (f) => {
      if (!/(^|\/)(\.github\/workflows|\.gitlab-ci|ci)\b/.test(f.path) && !/^\s*jobs\s*:/m.test(f.text)) return [];
      const out = [];
      if (!/^\s*jobs\s*:|^\s*stages\s*:/m.test(f.text)) out.push(`${f.path}: no jobs section`);
      if (/uses:\s*\S+@(main|master|latest)\b/.test(f.text)) out.push(`${f.path}: an action is used from a moving branch, pin a version`);
      if (/echo\s+[^\n]*\$\{\{\s*secrets\./.test(f.text)) out.push(`${f.path}: a secret is printed to the log`);
      return out;
    })
  },

  // Files of the workspace
  'file.readme': { level: 'error', types: [], describe: 'a README.md exists', run: (fs) => (fs.some((f) => /(^|\/)readme\.md$/i.test(f.path)) ? [] : ['no README.md']) },
  'file.test': { level: 'error', types: [], describe: 'a test file exists', run: (fs) => (fs.some((f) => /(^|\/)(test|tests)\/|\.test\.|\.spec\.|(^|\/)test\.m?js$|(^|\/)test_[\w]+\.py$/i.test(f.path)) ? [] : ['no test file (test.mjs, *.test.js or test_*.py)']) },
  'file.nonempty': { level: 'error', types: [], describe: 'no empty files', run: (fs) => fs.filter((f) => TEXTUAL.includes(ext(f.path)) && !f.text.trim()).map((f) => `${f.path}: the file is empty`) },
  'text.no-placeholder': {
    level: 'error', types: TEXTUAL, describe: 'no lorem ipsum, TODO or placeholder text',
    run: (fs) => fs.filter((f) => TEXTUAL.includes(ext(f.path))).flatMap((f) => {
      // TODO markers count only in capitals, so a todo list app passes.
      const m = f.text.match(/lorem ipsum|your (text|content|name) here|placeholder text/i) || f.text.match(/\b(TODO|FIXME|TBD)\b/);
      return m ? [`${f.path}: placeholder "${m[0]}"`] : [];
    }).slice(0, 4)
  }
};

/**
 * The files of a workspace as { path, text } (text files only, up to 200 KB each).
 * @param {{ list: () => Array<{ path: string }>, read: (p: string) => string }} ws
 */
export function filesOf(ws) {
  const out = [];
  for (const f of ws.list()) {
    if (!TEXTUAL.includes(ext(f.path)) && ext(f.path) !== '.csv' && !NAMED_FILES.test(f.path) && !/(^|\/)\.env(\.[\w-]+)?$/.test(f.path)) continue;
    try { out.push({ path: f.path, text: String(ws.read(f.path)).slice(0, 200_000) }); } catch { /* unreadable */ }
  }
  return out;
}

/**
 * Runs the listed checks.
 * @param {string[]} ids check ids (unknown ids are reported as skipped)
 * @param {{ files?: Array<{ path: string, text: string }>, ws?: any, only?: string[] }} where
 *   only: the files whose contents are checked (for example the files a job wrote); the workspace level
 *   checks (file.readme, file.test) still see every file
 * @returns {{ passed: boolean, results: Array<{ id: string, level: string, status: 'pass' | 'fail' | 'skip', issues: string[] }>, issues: string[], notes: string[] }}
 */
export function runChecks(ids, where = {}) {
  const everything = where.files || (where.ws ? filesOf(where.ws) : []);
  const files = where.only ? everything.filter((f) => where.only.includes(f.path)) : everything;
  const names = new Set(everything.map((f) => f.path));
  const ctx = { exists: where.ws ? (p) => { try { return where.ws.exists(p); } catch { return false; } } : (p) => names.has(p) };
  const results = [];
  for (const id of [...new Set(ids || [])]) {
    const c = CHECKS[id];
    if (!c) { results.push({ id, level: 'warn', status: 'skip', issues: [] }); continue; }
    if (c.types.length && !files.some((f) => c.types.includes(ext(f.path)))) { results.push({ id, level: c.level, status: 'skip', issues: [] }); continue; }
    let issues;
    try { issues = c.run(c.types.length ? files : everything, ctx) || []; } catch (err) { issues = [`${id} could not run: ${err.message}`]; }
    results.push({ id, level: c.level, status: issues.length ? 'fail' : 'pass', issues });
  }
  const issues = results.filter((r) => r.level === 'error').flatMap((r) => r.issues.map((i) => `[${r.id}] ${i}`));
  const notes = results.filter((r) => r.level !== 'error').flatMap((r) => r.issues.map((i) => `[${r.id}] ${i}`));
  return { passed: issues.length === 0, results, issues, notes };
}
