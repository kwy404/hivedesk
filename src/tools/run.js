// Runs a command inside the workspace: no shell, an allow list, a timeout, an output cap,
// Node permission flags when the runtime has them, and network blocked on a best effort basis.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const OUTPUT_CAP = 16 * 1024;
export const DEFAULT_TIMEOUT = 60_000;
const NPM_ALLOWED = new Set(['test', 't', 'run', 'run-script']);

/** Splits a command line into argv, honoring simple single and double quotes. */
export function splitArgs(line) {
  const out = [];
  let cur = '';
  let quote = null;
  let has = false;
  for (const ch of String(line)) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (cur || has) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += ch;
    }
  }
  if (quote) throw new Error('unclosed quote in command');
  if (cur || has) out.push(cur);
  return out;
}

let permFlag;
/** `--permission` (Node 22.13+ / 23.5+), `--experimental-permission` (Node 20), or null. */
export function permissionFlag() {
  if (permFlag !== undefined) return permFlag;
  permFlag = null;
  for (const f of ['--permission', '--experimental-permission']) {
    const r = spawnSync(process.execPath, [f, '-e', '0'], { stdio: 'ignore', timeout: 5000 });
    if (r.status === 0) { permFlag = f; break; }
  }
  return permFlag;
}

function npmCli() {
  const guess = [
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
  ];
  return guess.find((p) => fs.existsSync(p)) || null;
}

/**
 * Validates a command and returns how to spawn it.
 * @param {string} command
 * @param {string} cwd workspace root
 * @returns {{ file: string, args: string[], label: string }}
 */
export function planCommand(command, cwd) {
  const argv = splitArgs(command);
  if (!argv.length) throw new Error('empty command');
  const [prog, ...rest] = argv;
  const name = prog.toLowerCase().replace(/\.(exe|cmd)$/, '');
  for (const a of rest) {
    if (/[;&|`$<>]/.test(a)) throw new Error(`shell operators are not allowed: ${a}`);
  }
  if (name === 'node') {
    const flags = [];
    const perm = permissionFlag();
    if (perm) flags.push(perm, `--allow-fs-read=${cwd}`, `--allow-fs-write=${cwd}`);
    const bad = rest.find((a) => /^--(allow-|permission|experimental-permission|inspect|require|import|loader|experimental-loader)/.test(a) || a === '-r');
    if (bad) throw new Error(`node flag not allowed: ${bad}`);
    return { file: process.execPath, args: [...flags, ...rest], label: command };
  }
  if (name === 'npm') {
    if (!NPM_ALLOWED.has(rest[0])) throw new Error('only "npm test" and "npm run <script>" are allowed (no installs)');
    const cli = npmCli();
    if (!cli) throw new Error('npm was not found next to node');
    return { file: process.execPath, args: [cli, '--offline', '--no-update-notifier', ...rest], label: command };
  }
  throw new Error(`command not allowed: ${prog}. Allowed: node <file>, npm test, npm run <script>`);
}

function safeEnv(cwd) {
  const keep = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'windir', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'LANG', 'TERM', 'COMSPEC', 'PATHEXT'];
  const env = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  const dead = 'http://127.0.0.1:9';
  Object.assign(env, {
    HTTP_PROXY: dead, HTTPS_PROXY: dead, http_proxy: dead, https_proxy: dead, NO_PROXY: '', no_proxy: '',
    npm_config_offline: 'true', npm_config_audit: 'false', npm_config_fund: 'false',
    CI: '1', HIVEDESK_WORKSPACE: cwd, FORCE_COLOR: '0'
  });
  return env;
}

function killTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    try { spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
  } else {
    try { child.kill('SIGKILL'); } catch { /* gone */ }
  }
}

/**
 * @param {string} command
 * @param {{ cwd: string, timeout?: number, onOutput?: (stream: string, text: string) => void, signal?: AbortSignal }} opts
 * @returns {Promise<{ command: string, exitCode: number | null, timedOut: boolean, ms: number, stdout: string, stderr: string }>}
 */
export function runCommand(command, opts) {
  const { cwd } = opts;
  const timeout = Math.min(Math.max(opts.timeout || DEFAULT_TIMEOUT, 1000), 300_000);
  const plan = planCommand(command, cwd);
  const started = Date.now();
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const child = spawn(plan.file, plan.args, { cwd, env: safeEnv(cwd), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const cap = (cur, chunk) => (cur.length >= OUTPUT_CAP ? cur : (cur + chunk).slice(0, OUTPUT_CAP));
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => { stdout = cap(stdout, c); opts.onOutput?.('stdout', c); });
    child.stderr.on('data', (c) => { stderr = cap(stderr, c); opts.onOutput?.('stderr', c); });
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeout);
    const onAbort = () => killTree(child);
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const done = (code, errText) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (errText) stderr = cap(stderr, errText);
      resolve({ command: plan.label, exitCode: code, timedOut, ms: Date.now() - started, stdout, stderr });
    };
    child.on('error', (err) => done(null, String(err.message)));
    child.on('close', (code) => done(code));
  });
}
