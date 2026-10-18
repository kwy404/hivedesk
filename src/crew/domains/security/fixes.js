// Suggested fixes for audit findings: small, exact patches (one line, or one new line) that the user
// approves one by one before anything is written. Findings without a safe mechanical fix keep only
// their advice. A fix that touches a secret never carries the secret in its summary or diff.
import path from 'node:path';
import { SECRET_RULES, mask } from './scan.js';

const JS = new Set(['.js', '.mjs', '.cjs', '.ts']);

/** Upper snake case name for an environment variable ("apiKey" -> "API_KEY"). */
export function envName(name) {
  return String(name || 'SECRET').replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase() || 'SECRET';
}

/** A text with every secret shaped part masked. */
export function redact(text) {
  let s = String(text || '');
  for (const r of SECRET_RULES) s = s.replace(new RegExp(r.re.source, r.re.flags), (m) => mask(m));
  return s.replace(/(["'`])([A-Za-z0-9+/_=-]{16,})\1/g, (m, q, v) => `${q}${mask(v)}${q}`);
}

function lineOf(text, n) {
  return String(text).split('\n')[n - 1] ?? null;
}

const once = (text, search) => search && text.split(search).length === 2;

/**
 * The patch for one finding, or null.
 * @param {any} finding from auditProject
 * @param {(p: string) => string | null} read file text by path
 * @returns {null | { path: string, search?: string, replace?: string, create?: boolean, content?: string, summary: string, secret?: boolean }}
 */
export function fixFor(finding, read) {
  const text = read(finding.file);
  const ext = path.extname(finding.file).toLowerCase();
  if (finding.id === 'config.env-not-ignored') {
    const gi = read('.gitignore');
    if (gi == null) return { path: '.gitignore', create: true, content: '.env\n.env.*\n!.env.example\n', summary: 'Create .gitignore with .env so secrets are never committed' };
    const last = gi.split('\n').filter(Boolean).pop();
    if (!last || !once(gi, last)) return null;
    return { path: '.gitignore', search: last, replace: `${last}\n.env`, summary: 'Add .env to .gitignore' };
  }
  if (text == null || !finding.line) return null;
  const line = lineOf(text, finding.line);
  if (line == null || !once(text, line)) return null;
  const patch = (replace, summary, extra = {}) => (replace !== line ? { path: finding.file, search: line, replace, summary, ...extra } : null);
  switch (finding.id) {
    case 'config.no-csp': {
      const inlineScript = /<script\b(?![^>]*\bsrc=)[^>]*>\s*\S/i.test(text) || /\son[a-z]+\s*=/i.test(text);
      const inlineStyle = /<style\b|\sstyle\s*=/i.test(text);
      const policy = [`default-src 'self'`, `img-src 'self' data:`, `script-src 'self'${inlineScript ? ` 'unsafe-inline'` : ''}`, `style-src 'self'${inlineStyle ? ` 'unsafe-inline'` : ''}`, `object-src 'none'`, `base-uri 'self'`].join('; ');
      const m = /<head\b[^>]*>/i.exec(line);
      if (!m) return null;
      const indent = (line.match(/^\s*/) || [''])[0];
      return patch(`${line.slice(0, m.index + m[0].length)}\n${indent}  <meta http-equiv="Content-Security-Policy" content="${policy}">${line.slice(m.index + m[0].length)}`, `Add a Content-Security-Policy to ${finding.file}${inlineScript ? ' (inline scripts still allowed; move them to files to drop unsafe-inline)' : ''}`);
    }
    case 'code.inner-html': {
      const m = /\.(innerHTML|outerHTML)\s*=\s*([^;]+);?\s*$/.exec(line);
      if (!m || m[1] !== 'innerHTML' || /[<>]|`[^`]*</.test(m[2])) return null;
      return patch(line.replace(/\.innerHTML(\s*=)/, '.textContent$1'), `Use textContent instead of innerHTML in ${finding.file}:${finding.line}`);
    }
    case 'code.weak-hash':
      return patch(line.replace(/createHash\s*\(\s*(['"])(md5|sha1)\1/i, 'createHash($1sha256$1').replace(/hashlib\.(md5|sha1)\s*\(/i, 'hashlib.sha256('), `Use SHA-256 instead of MD5 or SHA-1 in ${finding.file}:${finding.line} (stored hashes must be recomputed)`);
    case 'code.tls-off':
      if (/NODE_TLS_REJECT_UNAUTHORIZED/.test(line)) return null;
      return patch(line.replace(/rejectUnauthorized\s*:\s*false/, 'rejectUnauthorized: true').replace(/\bverify\s*=\s*False/, 'verify=True'), `Turn certificate checks back on in ${finding.file}:${finding.line}`);
    case 'code.unsafe-deserialize':
      if (!/\byaml\.load\s*\(/.test(line) || /Loader\s*=/.test(line)) return null;
      return patch(line.replace(/\byaml\.load\s*\(/, 'yaml.safe_load('), `Use yaml.safe_load in ${finding.file}:${finding.line}`);
    case 'secret.assignment': {
      if (!JS.has(ext) || /(^|\/)(www|public|static|resources|dist)\//.test(finding.file)) return null;
      const name = envName(finding.name);
      const m = /(["'`])[^"'`\s]{8,}\1/.exec(line.slice(line.search(/[:=]/) + 1));
      if (!m) return null;
      const at = line.search(/[:=]/) + 1 + m.index;
      const replace = `${line.slice(0, at)}process.env.${name}${line.slice(at + m[0].length)}`;
      return { path: finding.file, search: line, replace, secret: true, summary: `Read ${name} from the environment instead of the hardcoded value in ${finding.file}:${finding.line} (also rotate the old key)` };
    }
    default:
      return null;
  }
}

/** Every fix the findings allow, at most `limit`, one per file and line. */
export function proposeFixes(findings, read, limit = 12) {
  const out = [];
  const seen = new Set();
  findings.forEach((f, index) => {
    if (out.length >= limit) return;
    const key = `${f.file}:${f.line}`;
    if (seen.has(key)) return;
    const fix = fixFor(f, read);
    if (!fix) return;
    seen.add(key);
    out.push({ ...fix, finding: index, severity: f.severity, findingId: f.id });
  });
  return out;
}
