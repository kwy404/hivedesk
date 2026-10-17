// Lazy install of the local runtime (node-llama-cpp) into the hivedesk cache, so the package itself stays small.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const RUNTIME_PACKAGE = 'node-llama-cpp';
export const RUNTIME_VERSION = '3.22.1';

export function runtimeDir(home) {
  return path.join(home, 'runtime');
}

function installedEntry(home) {
  const pkgDir = path.join(runtimeDir(home), 'node_modules', RUNTIME_PACKAGE);
  const pkgFile = path.join(pkgDir, 'package.json');
  if (!fs.existsSync(pkgFile)) return null;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
    const exp = pkg.exports?.['.'];
    const rel = (typeof exp === 'string' ? exp : exp?.import || exp?.default) || pkg.module || pkg.main || 'dist/index.js';
    return { entry: path.join(pkgDir, typeof rel === 'string' ? rel : 'dist/index.js'), version: pkg.version };
  } catch {
    return null;
  }
}

/** Where the runtime is, without installing: HIVEDESK_LLAMA_RUNTIME (a node_modules folder that has node-llama-cpp) or the cache. */
export async function findRuntime(home) {
  const fromEnv = process.env.HIVEDESK_LLAMA_RUNTIME;
  if (fromEnv) {
    const direct = path.join(fromEnv, RUNTIME_PACKAGE, 'package.json');
    if (fs.existsSync(direct)) {
      const pkg = JSON.parse(fs.readFileSync(direct, 'utf8'));
      return { entry: path.join(fromEnv, RUNTIME_PACKAGE, 'dist', 'index.js'), version: pkg.version, where: 'env' };
    }
  }
  const cached = installedEntry(home);
  if (cached && fs.existsSync(cached.entry)) return { ...cached, where: 'cache' };
  return null;
}

function npmCli() {
  const guess = [
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
  ];
  return guess.find((p) => fs.existsSync(p)) || null;
}

export class RuntimeError extends Error {
  constructor(code, message, hint) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

/**
 * Installs node-llama-cpp into <home>/runtime. Uses npm next to the running node (no shell).
 * @param {string} home
 * @param {{ onLine?: (line: string) => void, spawnImpl?: typeof spawn }} [opts]
 */
export async function installRuntime(home, opts = {}) {
  const dir = runtimeDir(home);
  fs.mkdirSync(dir, { recursive: true });
  const pkgFile = path.join(dir, 'package.json');
  if (!fs.existsSync(pkgFile)) fs.writeFileSync(pkgFile, JSON.stringify({ name: 'hivedesk-runtime', private: true, type: 'module' }, null, 2));
  // First with the user's npm cache; if that fails for a reason other than the network
  // (a locked or broken shared cache), once more with a private cache inside the runtime folder.
  let r = await npmInstall(dir, [], opts);
  if (r.code !== 0 && !r.offline) {
    opts.onLine?.('retrying with a private npm cache');
    r = await npmInstall(dir, ['--cache', path.join(dir, '.npm-cache'), '--prefer-online'], opts);
  }
  if (r.code !== 0) {
    throw new RuntimeError(r.offline ? 'no_network' : 'install_failed',
      r.offline ? 'Could not download the local runtime (node-llama-cpp): no network.' : `Installing the local runtime (node-llama-cpp) failed (exit code ${r.code}).`,
      r.offline ? 'Check the connection and press Retry, or use --brain ollama or --brain lmstudio.' : 'Run hivedesk --doctor, or use --brain ollama or --brain lmstudio.');
  }
  const found = installedEntry(home);
  if (!found) throw new RuntimeError('install_failed', 'The runtime was installed but could not be found.', 'Delete the runtime folder in the cache and try again.');
  return found;
}

async function npmInstall(dir, extra, opts) {
  const cli = npmCli();
  const args = ['install', `${RUNTIME_PACKAGE}@${RUNTIME_VERSION}`, '--no-audit', '--no-fund', '--omit=dev', '--loglevel=error', '--prefix', dir, ...extra];
  const sp = opts.spawnImpl || spawn;
  const child = cli
    ? sp(process.execPath, [cli, ...args], { cwd: dir, windowsHide: true })
    : sp(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { cwd: dir, windowsHide: true, shell: process.platform === 'win32' });
  let tail = '';
  const onData = (c) => {
    const text = String(c);
    tail = (tail + text).slice(-4000);
    for (const line of text.split(/\r?\n/)) if (line.trim()) opts.onLine?.(line.trim());
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  const code = await new Promise((resolve) => {
    child.on('error', (err) => { tail += String(err.message); resolve(-1); });
    child.on('close', resolve);
  });
  return { code, offline: code !== 0 && /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ECONNRESET|network/i.test(tail) };
}

/** Imports node-llama-cpp, installing it first when needed. */
export async function loadRuntime(home, opts = {}) {
  let found = await findRuntime(home);
  let installed = false;
  if (!found) {
    if (opts.noInstall) return null;
    opts.onInstall?.();
    found = await installRuntime(home, opts);
    installed = true;
  }
  const mod = await import(pathToFileURL(found.entry).href);
  return { mod, version: found.version, entry: found.entry, installed };
}
