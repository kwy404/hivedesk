// Static checks QA can run without a model: HTML structure, local links, JS syntax, CSS braces, JSON.
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr', '!doctype']);
const RAW = new Set(['script', 'style']);

export function checkHtml(file, html, exists) {
  const issues = [];
  if (!/<!doctype html>/i.test(html)) issues.push(`${file}: missing <!doctype html>`);
  if (!/<title>[^<]+<\/title>/i.test(html)) issues.push(`${file}: missing or empty <title>`);
  if (!/<html[^>]*\blang=/i.test(html)) issues.push(`${file}: <html> has no lang attribute`);
  if (!/<meta[^>]+name=["']?viewport/i.test(html)) issues.push(`${file}: missing <meta name="viewport">`);
  // Tag balance, skipping script and style bodies and comments.
  const src = html.replace(/<!--[\s\S]*?-->/g, '');
  const stack = [];
  const re = /<\/?([a-zA-Z][a-zA-Z0-9-]*|!doctype)\b[^>]*?(\/?)>/g;
  let m;
  while ((m = re.exec(src))) {
    const tag = m[1].toLowerCase();
    const closing = m[0].startsWith('</');
    if (!closing && RAW.has(tag)) {
      const end = src.toLowerCase().indexOf(`</${tag}`, re.lastIndex);
      if (end === -1) { issues.push(`${file}: <${tag}> is never closed`); break; }
      const close = src.indexOf('>', end);
      re.lastIndex = close === -1 ? src.length : close + 1;
      continue;
    }
    if (VOID.has(tag) || m[2] === '/') continue;
    if (!closing) stack.push(tag);
    else {
      const i = stack.lastIndexOf(tag);
      if (i === -1) issues.push(`${file}: stray </${tag}>`);
      else {
        for (const open of stack.splice(i).slice(1)) {
          if (!['p', 'li', 'td', 'th', 'tr', 'option', 'dt', 'dd'].includes(open)) issues.push(`${file}: <${open}> is not closed before </${tag}>`);
        }
      }
    }
  }
  for (const open of stack) {
    if (!['p', 'li', 'td', 'th', 'tr', 'option', 'dt', 'dd', 'html', 'body', 'head'].includes(open)) issues.push(`${file}: <${open}> is never closed`);
  }
  // Local references.
  const refRe = /\b(?:src|href)=["']([^"'#?]+)[^"']*["']/gi;
  while ((m = refRe.exec(html))) {
    const ref = m[1].trim();
    if (!ref || /^(https?:|mailto:|tel:|data:|javascript:|\/\/)/i.test(ref)) continue;
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), ref.replace(/^\//, '')));
    if (exists && !exists(target) && !exists(target.replace(/\/$/, '') + '/index.html')) issues.push(`${file}: links to ${ref}, which does not exist`);
  }
  const imgRe = /<img\b(?![^>]*\balt=)[^>]*>/gi;
  if (imgRe.test(html)) issues.push(`${file}: an <img> has no alt text`);
  return issues;
}

export function checkCss(file, css) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/"[^"]*"|'[^']*'/g, '""');
  let depth = 0;
  for (const ch of clean) {
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth < 0) return [`${file}: unexpected }`];
    }
  }
  return depth ? [`${file}: ${depth} unclosed {`] : [];
}

export function checkJs(file, abs) {
  const r = spawnSync(process.execPath, ['--check', abs], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  if (r.status === 0) return [];
  const msg = (r.stderr || '').split('\n').filter((l) => l.trim() && !l.startsWith('    at ') && !l.startsWith('Node.js')).slice(0, 4).join(' ').replace(/\s+/g, ' ');
  return [`${file}: syntax error ${msg.replace(abs, file)}`.trim()];
}

/**
 * Checks every file of the workspace (or the listed ones).
 * @param {import('./workspace.js').Workspace} ws
 * @param {string[]} [only]
 */
export function checkWorkspace(ws, only) {
  const files = ws.list().map((f) => f.path).filter((p) => !only || only.includes(p));
  const issues = [];
  if (!files.length) return { passed: false, checked: [], issues: ['the workspace is empty'] };
  const exists = (rel) => ws.exists(rel);
  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    try {
      if (ext === '.html' || ext === '.htm') issues.push(...checkHtml(f, ws.read(f), exists));
      else if (ext === '.css') issues.push(...checkCss(f, ws.read(f)));
      else if (ext === '.js' || ext === '.mjs' || ext === '.cjs') issues.push(...checkJs(f, ws.resolve(f)));
      else if (ext === '.json') {
        try { JSON.parse(ws.read(f)); } catch (e) { issues.push(`${f}: invalid JSON (${e.message})`); }
      }
    } catch (e) {
      issues.push(`${f}: ${e.message}`);
    }
  }
  return { passed: issues.length === 0, checked: files, issues };
}
