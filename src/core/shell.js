// The subcommand shell of `hivedesk <command>` (PLAN.md section 9).
// src/cli.js owns start, city and doctor. Other modules register theirs:
//   src/p2p/cli.js       export const P2P_SUBCOMMANDS = { invite, join, peers }  (Stream 2): fn(argv, { home, stdin, stdout, stderr }) => exit code
// or, for a module that wants the shell to parse its flags:
//                        export const subcommands = { name: { summary, usage, options, run(ctx) } }
// `share` is built in too and runs runShare() from src/compute/share-cli.js (Stream 3), which has its own parser.
// A subcommand is { summary, usage, options: { name: 'string' | 'boolean' }, run(ctx) => exit code }.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..');

/** Where each subcommand that is not built into src/cli.js comes from. */
export const PROVIDERS = Object.freeze({
  invite: 'p2p/cli.js',
  join: 'p2p/cli.js',
  peers: 'p2p/cli.js'
});

export const SUMMARIES = Object.freeze({
  start: 'start the engine and open the window (the default)',
  city: 'print the City of this project: buildings, agents, tasks by state, peers online',
  invite: 'invite a friend: prints six words, then asks you to accept',
  join: 'join a friend\'s City with the six words',
  peers: 'known peers and what each may do here',
  share: 'what this machine shares with peers (off by default)',
  doctor: 'check Node, GPU, RAM, disk, models, the project log and ports'
});

/** @type {Map<string, any>} subcommands registered in process (tests, plug-ins) */
const registered = new Map();

export function registerSubcommand(name, def) {
  if (!/^[a-z][a-z-]{1,20}$/.test(name)) throw new Error(`bad subcommand name ${name}`);
  if (!def || typeof def.run !== 'function') throw new Error(`subcommand ${name} needs run()`);
  registered.set(name, def);
}

export function unregisterSubcommand(name) {
  registered.delete(name);
}

export const BUILTIN = Object.freeze(['start', 'city', 'doctor', 'share', 'help']);
export const isSubcommand = (word) => BUILTIN.includes(word) || word in PROVIDERS || registered.has(word);

/**
 * Finds the handler of a subcommand that src/cli.js does not build in.
 * @returns {Promise<{ def: any } | { missing: string }>}
 */
export async function loadSubcommand(name, srcDir = SRC) {
  if (registered.has(name)) return { def: registered.get(name) };
  const rel = PROVIDERS[name];
  if (!rel) return { missing: `unknown command ${name}` };
  const file = path.join(srcDir, rel);
  if (!fs.existsSync(file)) return { missing: `"hivedesk ${name}" is not in this build yet (${rel} is missing)` };
  const mod = await import(pathToFileURL(file).href);
  // A plain runner that parses its own arguments: fn(argv, { home, stdin, stdout, stderr }) => exit code.
  const raw = mod.P2P_SUBCOMMANDS?.[name];
  if (typeof raw === 'function') return { def: { raw: true, run: raw } };
  const def = mod.subcommands?.[name];
  if (!def || typeof def.run !== 'function') return { missing: `"hivedesk ${name}" is not in this build yet (${rel} has no handler for it)` };
  return { def };
}

/**
 * Parses `--key value`, `--key=value`, `--flag`, `--no-flag` and positionals against a spec.
 * Every subcommand also takes --dir, --json and --help.
 * @param {string[]} argv
 * @param {Record<string, 'string' | 'boolean'>} [options]
 * @returns {{ flags: Record<string, any>, positionals: string[] }}
 */
export function parseFlags(argv, options = {}) {
  const spec = { dir: 'string', json: 'boolean', help: 'boolean', ...options };
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { positionals.push(a); continue; }
    let [key, val] = a.slice(2).split(/=(.*)/s);
    let negated = false;
    if (!(key in spec) && key.startsWith('no-') && spec[key.slice(3)] === 'boolean') { key = key.slice(3); negated = true; }
    const kind = spec[key];
    if (!kind) throw Object.assign(new Error(`unknown option: --${key}`), { code: 'usage' });
    if (kind === 'boolean') {
      if (val !== undefined) throw Object.assign(new Error(`--${key} takes no value`), { code: 'usage' });
      flags[key] = !negated;
    } else {
      if (val === undefined) {
        val = argv[++i];
        if (val === undefined || val.startsWith('--')) throw Object.assign(new Error(`--${key} needs a value`), { code: 'usage' });
      }
      flags[key] = val;
    }
  }
  return { flags, positionals };
}

// ---------------------------------------------------------------- the running engine
/** <home>/engine.json: the engine `hivedesk start` is running, so other subcommands can talk to it. */
export const engineFile = (home) => path.join(home, 'engine.json');

export function writeEngineFile(home, info) {
  try {
    fs.mkdirSync(home, { recursive: true });
    const tmp = `${engineFile(home)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, pid: process.pid, startedAt: new Date().toISOString(), ...info }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, engineFile(home));
  } catch { /* other subcommands then start their own engine */ }
}

export function removeEngineFile(home, pid = process.pid) {
  try {
    const cur = JSON.parse(fs.readFileSync(engineFile(home), 'utf8'));
    if (cur.pid === pid) fs.unlinkSync(engineFile(home));
  } catch { /* gone */ }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

function request(port, token, p, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? '' : JSON.stringify(body);
    const headers = { host: `127.0.0.1:${port}`, authorization: `Bearer ${token}` };
    if (body !== undefined) Object.assign(headers, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) });
    const req = http.request({ host: '127.0.0.1', port, path: p, method: body === undefined ? 'GET' : 'POST', timeout: timeoutMs, headers }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => { try { resolve(JSON.parse(text)); } catch { reject(new Error('the engine answered something that is not JSON')); } });
    });
    req.on('timeout', () => req.destroy(new Error('the engine did not answer in time')));
    req.on('error', reject);
    req.end(data || undefined);
  });
}

/**
 * The engine that `hivedesk start` runs on this machine, if one answers.
 * @returns {Promise<null | { port: number, dir: string, pid: number, command: (type: string, data?: object) => Promise<any>, state: () => Promise<any> }>}
 */
export async function findEngine(home, { timeoutMs = 3000 } = {}) {
  let info;
  let token;
  try {
    info = JSON.parse(fs.readFileSync(engineFile(home), 'utf8'));
    token = fs.readFileSync(path.join(home, 'token'), 'utf8').trim();
  } catch { return null; }
  if (!info || !Number.isInteger(info.port) || !alive(info.pid) || !/^[0-9a-f]{32}$/.test(token)) return null;
  const command = async (type, data = {}) => {
    const r = await request(info.port, token, '/api/command', { type, data }, timeoutMs);
    if (!r.ok) throw Object.assign(new Error(r.error?.message || 'the command failed'), { code: r.error?.code || 'internal' });
    return r.result;
  };
  try { await command('ping'); } catch { return null; }
  return { port: info.port, dir: info.dir, pid: info.pid, command, state: () => request(info.port, token, '/api/state', undefined, timeoutMs) };
}
