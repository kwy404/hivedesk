// Security mode: a read only audit of a project folder. Secret scan (keys, tokens, private keys),
// risky code patterns (eval, innerHTML with data, SQL built from strings, shell commands built from
// input, weak crypto, TLS checks turned off, missing CSP) and the dependency list against an offline
// list of known risky version ranges (advisories.json). Nothing here writes a file: fixes are only
// proposed (fixes.js) and wait for the user's approval.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SEVERITIES = Object.freeze(['critical', 'high', 'medium', 'low']);
const RANK = { critical: 0, high: 1, medium: 2, low: 3 };

const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'coverage', '.next', '.cache', 'vendor', '__pycache__', '.venv', 'venv', '.hivedesk', 'bin', 'obj', 'target']);
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.vue', '.svelte', '.html', '.htm', '.json', '.py', '.rb', '.php', '.go', '.java', '.kt', '.cs', '.rs', '.sh', '.bash', '.ps1', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.conf', '.env', '.txt', '.md', '.xml', '.properties', '.gradle', '.tf', '.sql', '.pem', '.key']);
const MAX_FILE = 512 * 1024;
const MAX_FILES = 4000;

// ------------------------------------------------------------------ secrets
/** Known secret shapes. Each match is reported masked, never in full. */
export const SECRET_RULES = [
  { id: 'secret.private-key', title: 'Private key', severity: 'critical', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/g },
  { id: 'secret.aws-key', title: 'AWS access key id', severity: 'critical', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: 'secret.github-token', title: 'GitHub token', severity: 'critical', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/g },
  { id: 'secret.slack-token', title: 'Slack token', severity: 'high', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { id: 'secret.stripe-key', title: 'Stripe secret key', severity: 'critical', re: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/g },
  { id: 'secret.google-key', title: 'Google API key', severity: 'high', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: 'secret.model-key', title: 'AI provider API key', severity: 'critical', re: /\bsk-(?:proj-|ant-[a-z0-9]+-)?[A-Za-z0-9_-]{32,}\b/g },
  { id: 'secret.npm-token', title: 'npm token', severity: 'high', re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { id: 'secret.jwt', title: 'JSON Web Token', severity: 'medium', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}\b/g },
  { id: 'secret.url-password', title: 'Password inside a connection URL', severity: 'high', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@'"]+:([^\s@'"/]{4,})@[^\s'"]+/gi, group: 1 }
];

/** name = "value" where the name says secret, key, token or password. */
const ASSIGN = /\b([A-Za-z_][\w.-]*?(?:secret|passw(?:or)?d|pwd|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|auth))\b["']?\s*[:=]\s*(["'`])([^"'`\s]{8,})\2/gi;
const PLACEHOLDER = /^(?:x+|\*+|\.+|<[^>]*>|\$\{[^}]*\}|\{\{[^}]*\}\}|%[^%]+%|your[_-]?|change[_-]?me|changeit|example|sample|dummy|test|fake|placeholder|replace[_-]?me|todo|none|null|undefined|secret|password|token|redacted)/i;

/** Shannon entropy in bits per character. */
export function entropy(s) {
  const n = new Map();
  for (const ch of s) n.set(ch, (n.get(ch) || 0) + 1);
  let e = 0;
  for (const c of n.values()) { const p = c / s.length; e -= p * Math.log2(p); }
  return e;
}

/** The value with only its first characters visible. */
export function mask(value) {
  const v = String(value);
  if (v.startsWith('-----BEGIN')) return '-----BEGIN ... PRIVATE KEY-----';
  return v.length <= 8 ? '*'.repeat(v.length) : `${v.slice(0, 4)}${'*'.repeat(Math.min(12, v.length - 4))}`;
}

const lineAt = (text, index) => text.slice(0, index).split('\n').length;

/**
 * Secrets in one file: known shapes plus secret named assignments with a high entropy value.
 * @returns {Array<{ id: string, title: string, severity: string, line: number, match: string, name?: string }>}
 */
export function scanSecrets(file, text) {
  const out = [];
  const seen = new Set();
  const s = String(text || '');
  if (/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock)$/.test(file)) return out;
  const example = /\.(example|sample|template)$|(^|\/)\.env\.(example|sample|template)$/i.test(file) || /(^|\/)(test|tests|fixtures?|__tests__)\//.test(file);
  for (const r of SECRET_RULES) {
    r.re.lastIndex = 0;
    for (const m of s.matchAll(r.re)) {
      const value = r.group ? m[r.group] : m[0];
      if (PLACEHOLDER.test(value)) continue;
      const line = lineAt(s, m.index);
      const key = `${line}:${value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ id: r.id, title: r.title, severity: example ? 'low' : r.severity, line, match: mask(value) });
    }
  }
  for (const m of s.matchAll(ASSIGN)) {
    const [, name, , value] = m;
    if (PLACEHOLDER.test(value) || /^(process\.env|os\.environ|env\.|import\.meta)/.test(value) || /^[a-z]+(\.[a-z]+)+$/i.test(value)) continue;
    if (value.length < 12 || entropy(value) < 3.2) continue;
    const line = lineAt(s, m.index);
    if ([...seen].some((k) => k.startsWith(`${line}:`))) continue;
    seen.add(`${line}:${value}`);
    out.push({ id: 'secret.assignment', title: `Hardcoded secret in "${name}"`, severity: example ? 'low' : 'high', line, match: mask(value), name });
  }
  return out;
}

// ------------------------------------------------------------------ risky code
const JS_EXT = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.vue', '.svelte']);
const PY_EXT = new Set(['.py']);
const HTML_EXT = new Set(['.html', '.htm']);

/** Pattern rules: which files, a regex per line, the severity and the fix advice. */
export const CODE_RULES = [
  { id: 'code.eval', title: 'eval or new Function runs strings as code', severity: 'high', langs: JS_EXT, re: /\beval\s*\(|\bnew\s+Function\s*\(|\bset(?:Timeout|Interval)\s*\(\s*['"`]/, fix: 'Parse the data instead (JSON.parse) or call the function directly; never run text as code.' },
  { id: 'code.inner-html', title: 'innerHTML set from a variable (cross site scripting)', severity: 'high', langs: new Set([...JS_EXT, '.html', '.htm']), re: /\.(?:innerHTML|outerHTML)\s*\+?=\s*(?!\s*['"`][^'"`$]*['"`]\s*;?\s*$)[^;]+|insertAdjacentHTML\s*\(|dangerouslySetInnerHTML/, fix: 'Use textContent for text, or build elements with createElement; sanitize when HTML is really needed.' },
  { id: 'code.document-write', title: 'document.write', severity: 'medium', langs: new Set([...JS_EXT, '.html', '.htm']), re: /\bdocument\.write(?:ln)?\s*\(/, fix: 'Create elements with the DOM API instead.' },
  { id: 'code.sql-concat', title: 'SQL built by string concatenation (SQL injection)', severity: 'high', langs: new Set([...JS_EXT, ...PY_EXT, '.php', '.java', '.cs', '.go', '.rb']), re: /\b(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b[^;\n]*?(?:\$\{|['"]\s*\+\s*[\w(]|['"]\s*%\s*[\w(]|\{\w+\}|\.format\s*\()/i, fix: 'Use placeholders (? or $1) and pass the values as parameters.' },
  { id: 'code.shell-input', title: 'Shell command built from a variable (command injection)', severity: 'high', langs: new Set([...JS_EXT, ...PY_EXT, '.php', '.rb']), re: /\b(?:exec|execSync)\s*\(\s*(?:`[^`]*\$\{|[\w.]+\s*\+|['"][^'"]*['"]\s*\+)|\bspawn(?:Sync)?\s*\([^)]*shell\s*:\s*true|\bos\.system\s*\(\s*(?:f['"]|[\w.]+\s*[+%])|\bsubprocess\.\w+\([^)]*shell\s*=\s*True|\b(?:shell_exec|system|passthru)\s*\(\s*\$/, fix: 'Use execFile or spawn with an argument list (or subprocess.run([...]) without shell=True) and validate the input.' },
  { id: 'code.weak-hash', title: 'MD5 or SHA-1 hash', severity: 'medium', langs: new Set([...JS_EXT, ...PY_EXT, '.php', '.java', '.go']), re: /createHash\s*\(\s*['"](?:md5|sha1)['"]|hashlib\.(?:md5|sha1)\s*\(|\bmd5\s*\(\s*\$|MessageDigest\.getInstance\(\s*"(?:MD5|SHA-?1)"/i, fix: 'Use SHA-256 for integrity and scrypt, bcrypt or argon2 for passwords.' },
  { id: 'code.insecure-random', title: 'Math.random used for a secret value', severity: 'medium', langs: JS_EXT, re: /(?:token|secret|password|passwd|session|nonce|salt|otp|code)\w*\s*[=:][^;\n]*Math\.random\s*\(/i, fix: 'Use crypto.randomBytes(32).toString("hex") or crypto.randomUUID().' },
  { id: 'code.tls-off', title: 'TLS certificate checks turned off', severity: 'high', langs: new Set([...JS_EXT, ...PY_EXT]), re: /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0|\bverify\s*=\s*False/, fix: 'Keep certificate checks on; trust a private CA with the ca option instead.' },
  { id: 'code.unsafe-deserialize', title: 'Unsafe deserialization', severity: 'high', langs: PY_EXT, re: /\bpickle\.loads?\s*\(|\byaml\.load\s*\((?![^)]*SafeLoader)|\bmarshal\.loads\s*\(/, fix: 'Use json, or yaml.safe_load; never unpickle data from outside.' },
  { id: 'code.cors-any', title: 'CORS allows every origin', severity: 'medium', langs: new Set([...JS_EXT, ...PY_EXT]), re: /Access-Control-Allow-Origin['"]?\s*[,:]\s*['"]\*['"]|origin\s*:\s*['"]\*['"]|allow_origins\s*=\s*\[\s*['"]\*['"]/, fix: 'List the origins that may call the API.' },
  { id: 'code.http-url', title: 'Plain http:// request', severity: 'low', langs: new Set([...JS_EXT, ...PY_EXT]), re: /\b(?:fetch|axios\.\w+|requests\.\w+|http\.get)\s*\(\s*['"`]http:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/, fix: 'Use https:// so the data is encrypted in transit.' },
  { id: 'code.debug-on', title: 'Debug mode on', severity: 'medium', langs: PY_EXT, re: /\bdebug\s*=\s*True\b|^\s*DEBUG\s*=\s*True\b/, fix: 'Read debug from an environment variable that is off in production.' }
];

const JS_COMMENT = /^\s*(\/\/|\*|\/\*)/;
const PY_COMMENT = /^\s*#/;

/** Risky patterns in one file, one finding per rule and line. */
export function scanCode(file, text) {
  const ext = path.extname(file).toLowerCase();
  const out = [];
  const lines = String(text || '').split('\n');
  const rules = CODE_RULES.filter((r) => r.langs.has(ext));
  if (!rules.length) return out;
  let inScript = !HTML_EXT.has(ext);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (HTML_EXT.has(ext)) {
      if (/<script\b/i.test(l)) inScript = true;
      if (!inScript) continue;
    }
    if ((PY_EXT.has(ext) ? PY_COMMENT : JS_COMMENT).test(l) || l.length > 2000) {
      if (HTML_EXT.has(ext) && /<\/script>/i.test(l)) inScript = false;
      continue;
    }
    for (const r of rules) if (r.re.test(l)) out.push({ id: r.id, title: r.title, severity: r.severity, line: i + 1, snippet: l.trim().slice(0, 160), fix: r.fix });
    if (HTML_EXT.has(ext) && /<\/script>/i.test(l)) inScript = false;
  }
  if (HTML_EXT.has(ext) && /<html\b|<head\b/i.test(text) && !/http-equiv=["']Content-Security-Policy/i.test(text)) {
    const at = lines.findIndex((l) => /<head\b/i.test(l));
    out.push({ id: 'config.no-csp', title: 'No Content-Security-Policy', severity: 'low', line: at + 1 || 1, snippet: '<head>', fix: 'Add <meta http-equiv="Content-Security-Policy" content="default-src \'self\'"> and widen only what the page needs.' });
  }
  return out;
}

// ------------------------------------------------------------------ dependencies
let advisories = null;
/** The offline advisory list (advisories.json). */
export function loadAdvisories() {
  if (!advisories) {
    try { advisories = JSON.parse(fs.readFileSync(path.join(HERE, 'advisories.json'), 'utf8')); } catch { advisories = { updated: null, npm: [], pypi: [] }; }
  }
  return advisories;
}

/** "1.2.3" -> [1, 2, 3]; null when there is no version number. */
export function parseVersion(v) {
  const m = String(v || '').match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  return m ? [+m[1], +(m[2] || 0), +(m[3] || 0)] : null;
}

export function lessThan(a, b) {
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] < b[i]; }
  return false;
}

/** Dependencies of a project: package.json (with the locked versions when a lockfile exists) and requirements.txt. */
export function listDependencies(read) {
  const deps = [];
  const pkg = safeJson(read('package.json'));
  const lock = safeJson(read('package-lock.json'));
  if (pkg) {
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const [name, range] of Object.entries(pkg[field] || {})) {
        const locked = lock?.packages?.[`node_modules/${name}`]?.version || lock?.dependencies?.[name]?.version || null;
        deps.push({ ecosystem: 'npm', name, range: String(range), locked, dev: field === 'devDependencies', file: 'package.json' });
      }
    }
  }
  const req = read('requirements.txt');
  if (req) {
    for (const line of req.split(/\r?\n/)) {
      const m = line.replace(/#.*/, '').trim().match(/^([A-Za-z0-9_.-]+)\s*(?:\[[^\]]*\])?\s*([=<>!~]=?\s*[\w.*]+)?/);
      if (m && m[1]) deps.push({ ecosystem: 'pypi', name: m[1].toLowerCase(), range: (m[2] || '').replace(/\s+/g, ''), locked: /^==/.test(m[2] || '') ? m[2].replace(/^==\s*/, '') : null, dev: false, file: 'requirements.txt' });
    }
  }
  return deps;
}

function safeJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * Dependencies inside a known risky range. With a lockfile the locked version decides; without one,
 * the lowest version the range allows ("^4.17.0" can still install 4.17.0).
 */
export function checkDependencies(deps, db = loadAdvisories()) {
  const out = [];
  for (const d of deps) {
    if (/^(file:|link:|git|https?:|workspace:)/.test(d.range)) continue;
    const version = parseVersion(d.locked || d.range);
    if (!version) continue;
    for (const a of db[d.ecosystem] || []) {
      if (a.name !== d.name) continue;
      const fixed = parseVersion(a.fixed);
      if (!fixed || !lessThan(version, fixed)) continue;
      out.push({
        id: 'dep.known-risk', title: `${d.name} ${d.locked || d.range}: ${a.title}`, severity: a.severity, file: d.file, line: 0,
        snippet: `${d.name}@${d.locked || d.range}`, fix: `Update ${d.name} to ${a.fixed} or later${a.ref ? ` (${a.ref})` : ''}.`, dependency: d.name, advisory: a.ref || null,
        basis: d.locked ? 'locked version' : 'lowest version the range allows'
      });
    }
  }
  return out;
}

// ------------------------------------------------------------------ the audit
/** Files of a folder for the audit (read only walk, skips build output and dependencies). */
export function walk(root) {
  const out = [];
  const visit = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      const abs = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) visit(abs); continue; }
      if (!e.isFile()) continue;
      const rel = path.relative(root, abs).split(path.sep).join('/');
      const ext = path.extname(e.name).toLowerCase();
      if (!TEXT_EXT.has(ext) && !/^(\.env(\..+)?|\.gitignore|Dockerfile.*|Containerfile|\.npmrc|\.pypirc|id_rsa|id_ed25519|credentials)$/i.test(e.name)) continue;
      out.push(rel);
    }
  };
  visit(root);
  return out;
}

/**
 * Audits a project folder without writing anything.
 * @param {{ root?: string, files?: Array<{ path: string, text: string }> }} where a folder, or files in memory (tests)
 * @returns {{ findings: any[], scanned: number, counts: Record<string, number>, dependencies: number, advisoriesUpdated: string | null }}
 */
export function auditProject(where) {
  let files = where.files;
  if (!files) {
    files = [];
    for (const rel of walk(where.root)) {
      try {
        const abs = path.join(where.root, rel);
        if (fs.statSync(abs).size > MAX_FILE) continue;
        const text = fs.readFileSync(abs, 'utf8');
        if (text.includes('\u0000')) continue;
        files.push({ path: rel, text });
      } catch { /* unreadable */ }
    }
  }
  const byPath = new Map(files.map((f) => [f.path, f.text]));
  const findings = [];
  for (const f of files) {
    for (const s of scanSecrets(f.path, f.text)) {
      findings.push({ ...s, category: 'secret', file: f.path, snippet: s.match, fix: /\.env/.test(f.path) ? 'Keep this file out of version control (.gitignore) and rotate the key if it was ever shared.' : 'Move the value to an environment variable, rotate the key, and keep it out of version control.' });
    }
    for (const c of scanCode(f.path, f.text)) findings.push({ ...c, category: c.id.startsWith('config.') ? 'config' : 'code', file: f.path });
  }
  if (byPath.has('.env') && !/^\.env$/m.test(byPath.get('.gitignore') || '')) {
    findings.push({ id: 'config.env-not-ignored', title: '.env is not in .gitignore', severity: 'high', category: 'config', file: '.gitignore', line: 0, snippet: '.env', fix: 'Add .env to .gitignore so secrets are never committed.' });
  }
  const deps = listDependencies((p) => byPath.get(p) ?? null);
  findings.push(...checkDependencies(deps).map((d) => ({ ...d, category: 'dependency' })));
  findings.sort((a, b) => RANK[a.severity] - RANK[b.severity] || a.file.localeCompare(b.file) || a.line - b.line);
  const counts = Object.fromEntries(SEVERITIES.map((s) => [s, findings.filter((f) => f.severity === s).length]));
  return { findings, scanned: files.length, counts, dependencies: deps.length, advisoriesUpdated: loadAdvisories().updated || null };
}
