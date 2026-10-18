#!/usr/bin/env node
// hivedesk command line.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import crypto from 'node:crypto';
import { isSubcommand, loadSubcommand, parseFlags, findEngine, writeEngineFile, removeEngineFile } from './core/shell.js';

const HELP = `hivedesk: a crew of AI workers that build real files on your machine with a local model.

Usage: npx hivedesk [command] [options]

Commands (no command means start):
  start                 start the engine and open the window
  city                  print the City of this project: buildings, agents, tasks by state, peers online
  invite                invite a friend: prints six words, then asks you to accept
  join "<words>"        join a friend's City with the six words
  peers                 known peers and what each may do here
  share                 what this machine shares with peers (off by default)
  doctor [--p2p]        check Node, GPU, RAM, disk, models, the project log and ports
  help                  this help

Options of start:
  --dir <folder>        project folder (default: the current folder); files go to <folder>/.hivedesk/
  --port <n>            port on 127.0.0.1 (default: a random free port)
  --no-open             do not open a window
  --browser             open in the normal browser instead of an app window
  --new-token           make a new access token (an installed app window then needs to be opened again from the terminal link)
  --model <name|path>   14b, 7b, 3b, 1.5b, 0.5b, or a GGUF file, instead of the automatic choice
  --brain <name>        ollama, lmstudio or openai (with --url, --model and HIVEDESK_API_KEY)
  --url <url>           base URL for --brain
  --no-download         never download a model; the UI offers the download instead
  --no-city             run without Hive City (agents, rooms and the task bus); the 0.1 desktop works the same
  --cpu                 do not use the GPU
  --ctx <n>             context size for the local model (default: up to 8192)
  --demo                scripted demo, no model, in its own demo folder; every event is labeled as a demo
  --demo-dir <folder>   run the demo in this folder (empty, or a demo folder; never a real project)
  --lend                lend this machine's model to a paired friend (opens the Lend screen)
  --join <link|words>   open the desktop with "Use a friend's PC" filled in with these six words
  --strict              refuse events that do not match their schema (for development)
  --yes                 skip the setup questions (the saved setup, or the recommended defaults)
  --doctor              the same as "hivedesk doctor"
  --version             print the version
  --help                this help

First run: see FIRST-RUN.md. Cache folder: ~/.hivedesk (or HIVEDESK_HOME).`;

export function parseArgs(argv) {
  const o = { open: true, download: true };
  const takes = new Set(['dir', 'port', 'model', 'brain', 'url', 'ctx', 'join', 'demo-dir']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument: ${a}`);
    let [key, val] = a.slice(2).split(/=(.*)/s);
    if (takes.has(key)) {
      if (val === undefined) {
        val = argv[++i];
        if (val === undefined || val.startsWith('--')) throw new Error(`--${key} needs a value`);
      }
      o[key] = val;
    } else if (key === 'no-open') o.open = false;
    else if (key === 'no-download') o.download = false;
    else if (key === 'no-city') o.city = false;
    else if (['demo', 'lend', 'doctor', 'help', 'version', 'cpu', 'yes', 'browser', 'new-token', 'strict'].includes(key)) o[key] = true;
    else throw new Error(`unknown option: --${key}`);
  }
  if (o.port !== undefined) {
    const p = Number(o.port);
    if (!Number.isInteger(p) || p < 0 || p > 65535) throw new Error('--port must be a number from 0 to 65535');
    o.port = p;
  }
  if (o.ctx !== undefined) {
    const c = Number(o.ctx);
    if (!Number.isInteger(c) || c < 1024) throw new Error('--ctx must be a number of at least 1024');
    o.ctx = c;
  }
  if (o.brain && !['ollama', 'lmstudio', 'openai', 'local'].includes(o.brain)) throw new Error('--brain must be ollama, lmstudio or openai');
  return o;
}

/** Six words from a share link (#w=...) or from words separated by spaces or dashes. */
export function joinWords(input) {
  const s = String(input || '');
  const m = s.match(/[#&?]w=([^&#\s]+)/);
  const raw = m ? decodeURIComponent(m[1]) : s;
  const words = raw.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  return words.length === 6 ? words.join('-') : null;
}

/** The page to open: the desktop, the Lend screen (--lend) or the desktop with a join link (--join). */
export function startUrl(port, token, args) {
  const base = `http://127.0.0.1:${port}`;
  if (args.lend) return `${base}/lend/?t=${token}`;
  if (args.join) {
    const w = joinWords(args.join);
    if (w) return `${base}/?t=${token}#w=${w}`;
  }
  return `${base}/?t=${token}`;
}

/** The access token, kept in ~/.hivedesk/token (mode 600) so an installed app window keeps working across runs. */
export function loadToken(home, rotate = false) {
  const file = path.join(home, 'token');
  if (!rotate) {
    try {
      const t = fs.readFileSync(file, 'utf8').trim();
      if (/^[0-9a-f]{32}$/.test(t)) return t;
    } catch { /* first run */ }
  }
  const t = crypto.randomBytes(16).toString('hex');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(file, t + '\n', { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* not supported */ }
  return t;
}

/** A stable port (4174) when it is free, so the installed app finds the server; otherwise any free port. */
export function stablePort(preferred = 4174) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(0));
    srv.listen(preferred, '127.0.0.1', () => srv.close(() => resolve(preferred)));
  });
}

/** Installed Chromium based browsers, best first (Edge on Windows, then Chrome, Brave, Chromium). */
export function chromiumCandidates(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    const roots = [env['ProgramFiles(x86)'], env.ProgramFiles, env.LOCALAPPDATA].filter(Boolean);
    const rel = ['Microsoft/Edge/Application/msedge.exe', 'Google/Chrome/Application/chrome.exe', 'BraveSoftware/Brave-Browser/Application/brave.exe', 'Chromium/Application/chrome.exe'];
    return rel.flatMap((r) => roots.map((x) => path.join(x, r)));
  }
  if (platform === 'darwin') {
    return ['Google Chrome', 'Microsoft Edge', 'Brave Browser', 'Chromium'].map((n) => `/Applications/${n}.app/Contents/MacOS/${n}`);
  }
  return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/microsoft-edge', '/usr/bin/brave-browser', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'];
}

/** The arguments for an app style window: no tabs or address bar, its own profile folder. */
export function appArgs(url, home) {
  return [`--app=${url}`, '--window-size=1440,900', `--user-data-dir=${path.join(home, 'browser-profile')}`, '--no-first-run', '--no-default-browser-check'];
}

/** Opens hivedesk in its own app window when a Chromium based browser is installed, else in the default browser. */
export function openApp(url, home) {
  const exe = chromiumCandidates().find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
  if (!exe) return openBrowser(url) && 'browser';
  try {
    const child = spawn(exe, appArgs(url, home), { stdio: 'ignore', detached: true, windowsHide: false });
    child.on('error', () => openBrowser(url));
    child.unref();
    return 'app';
  } catch {
    return openBrowser(url) && 'browser';
  }
}

export function openBrowser(url) {
  try {
    const opts = { stdio: 'ignore', detached: true, windowsHide: true };
    let child;
    if (process.platform === 'win32') child = spawn('rundll32', ['url.dll,FileProtocolHandler', url], opts);
    else if (process.platform === 'darwin') child = spawn('open', [url], opts);
    else child = spawn('xdg-open', [url], opts);
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function makeProgress() {
  const tty = process.stdout.isTTY;
  let last = 0;
  let shown = false;
  return (text) => {
    if (text == null) {
      if (shown && tty) process.stdout.write('\n');
      shown = false;
      return;
    }
    const now = Date.now();
    if (tty) {
      const cols = process.stdout.columns || 100;
      process.stdout.write('\r' + text.slice(0, cols - 1).padEnd(cols - 1));
      shown = true;
    } else if (now - last > 5000) {
      // Not a terminal (logs, CI): one line every few seconds.
      process.stdout.write(text + '\n');
      last = now;
    }
  };
}

/**
 * Splits the command line into a subcommand and its arguments. No subcommand means start;
 * the 0.2 flag --doctor still means doctor.
 * @returns {{ command: string, rest: string[] }}
 */
export function splitCommand(argv) {
  const first = argv[0];
  if (first !== undefined && !first.startsWith('--')) {
    if (isSubcommand(first)) return { command: first, rest: argv.slice(1) };
    throw Object.assign(new Error(`unknown command: ${first}`), { code: 'usage' });
  }
  if (argv.includes('--doctor')) return { command: 'doctor', rest: argv.filter((a) => a !== '--doctor') };
  return { command: 'start', rest: argv };
}

const usageError = (err) => {
  console.error(`hivedesk: ${err.message}\nRun "hivedesk help" for the commands and options.`);
  process.exit(2);
};

async function runStart(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    return usageError(err);
  }
  if (args.join && !joinWords(args.join)) {
    console.error('hivedesk: --join needs a share link or the six words');
    process.exit(2);
  }
  const { startHive, VERSION, cacheHome } = await import('./index.js');
  if (args.help) return console.log(HELP);
  if (args.version) return console.log(VERSION);
  // >>> desktop hook (desktop/README.md): a second run focuses the open window; packages pick the folder.
  const desktop = args.open ? await import('../desktop/index.js').catch(() => null) : null;
  if (desktop && await desktop.focusExisting({ home: cacheHome(), args })) return;
  if (desktop && !args.dir) args.dir = desktop.packagedDir({ home: cacheHome() }) || undefined;
  // <<< desktop hook
  let dir = path.resolve(args.dir || process.cwd());
  // The first run wizard: only in a real terminal, and not when flags already decide everything.
  let setup = null;
  const decided = args.demo || args.model || args.brain || args.lend || args.join;
  const tty = process.stdin.isTTY && process.stdout.isTTY;
  if (!decided && (tty || args.yes)) {
    const { wizardSetup } = await import('./wizard/index.js');
    try {
      setup = await wizardSetup({ home: cacheHome(), cwd: dir, yes: !!args.yes || !tty });
    } catch (err) {
      if (err.code === 'cancelled') { console.log('  bye'); process.exit(130); }
      throw err;
    }
    if (setup) {
      if (!args.dir) dir = setup.dir;
      if (setup.demo) args.demo = true;
      if (setup.open === false) args.open = false;
    }
  }
  const progress = makeProgress();
  const log = (line) => { progress(null); console.log(`  ${line}`); };
  console.log(`hivedesk ${VERSION}${args.demo ? ' (DEMO: no model, scripted crew, a separate demo folder)' : ''}${args.lend ? ' (lend mode)' : ''}`);
  const port = args.port !== undefined ? args.port : await stablePort(4174);
  let app;
  try {
    app = await startHive({
      // A demo gets a fresh demo folder unless --dir names an empty or demo folder (src/core/demo.js).
      dir: args.demo ? (args['demo-dir'] || args.dir) : dir,
      port,
      token: args.demo ? undefined : loadToken(cacheHome(), !!args['new-token']),
      demo: !!args.demo,
      lend: !!args.lend,
      city: args.city !== false,
      strict: args.strict ? true : undefined,
      log,
      progress,
      flags: {
        brain: args.brain, model: args.model, url: args.url, noDownload: !args.download,
        gpu: args.cpu ? false : undefined, ctx: args.ctx,
        ...(setup && !setup.demo ? setup.flags : {})
      }
    });
  } catch (err) {
    if (err.code === 'demo_refused') { console.error(`hivedesk: ${err.message}`); process.exit(2); }
    throw err;
  }
  dir = app.dir;
  if (setup) app.hive.setSettings({ approvalMode: setup.approvalMode, crew: setup.crew });
  // Other subcommands (city, invite, peers, share) find this engine through <home>/engine.json. A demo is not announced.
  if (!args.demo) writeEngineFile(cacheHome(), { port: app.server.port, dir, version: VERSION });
  console.log(`  folder: ${path.join(dir, '.hivedesk')}`);
  console.log(`  open:   ${app.url}`);
  const openUrl = startUrl(app.server.port, app.server.token, args);
  if (openUrl !== app.url) console.log(`          ${openUrl}`);
  console.log('  press Ctrl+C to stop');
  let stopping = false;
  const stop = async () => {
    if (stopping) process.exit(130);
    stopping = true;
    progress(null);
    console.log('\n  stopping...');
    if (!args.demo) removeEngineFile(cacheHome());
    try { await app.close(); } catch { /* exit anyway */ }
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  // >>> desktop hook: the native window, or the app window / browser as a fallback.
  if (args.open && desktop && setup?.app !== false) {
    await desktop.openDesktop({ app, url: openUrl, args, dir, home: cacheHome(), log, progress, quit: stop,
      version: VERSION, configLang: setup?.lang, openFallback: (u) => openApp(u, cacheHome()) });
  } else if (args.open) {
    const how = args.browser || setup?.app === false ? (openBrowser(openUrl) && 'browser') : openApp(openUrl, cacheHome());
    if (how) console.log(`  opened ${how === 'app' ? 'in its own app window' : 'in the browser'}`);
  }
  // <<< desktop hook
}

/** `hivedesk city`: from the running engine of this folder, else read only from the log. */
async function runCity(argv) {
  let parsed;
  try { parsed = parseFlags(argv, {}); } catch (err) { return usageError(err); }
  if (parsed.flags.help) return console.log('Usage: hivedesk city [--dir <folder>] [--json]\n\nPrints the City of a project: buildings, agents, tasks by state and peers online.');
  const { cacheHome } = await import('./index.js');
  const { citySummary, formatCity } = await import('./core/city-report.js');
  const dir = path.resolve(parsed.flags.dir || process.cwd());
  const root = path.join(dir, '.hivedesk');
  let summary;
  const engine = await findEngine(cacheHome());
  if (engine && path.resolve(engine.dir || '') === dir) {
    const [state, info] = await Promise.all([engine.state(), engine.command('store.info')]);
    summary = citySummary(state, { dir, source: 'engine', info });
  } else {
    if (!fs.existsSync(root)) {
      console.error(`hivedesk: ${dir} is not a hivedesk project yet (no .hivedesk folder). Run "hivedesk" there first, or pass --dir.`);
      process.exitCode = 1;
      return;
    }
    const { EventBus } = await import('./core/bus.js');
    const bus = new EventBus({ dir: root, readOnly: true, strict: false });
    summary = citySummary(bus.state, { dir, source: 'log', info: bus.info() });
    bus.close();
  }
  console.log(parsed.flags.json ? JSON.stringify(summary, null, 2) : formatCity(summary));
}

/** `hivedesk doctor [--p2p]`: the 0.2 checks plus the core checks; the p2p checks come from src/doctor.js (Stream 2). */
async function runDoctorCmd(argv) {
  let parsed;
  try { parsed = parseFlags(argv, { model: 'string', p2p: 'boolean' }); } catch (err) { return usageError(err); }
  if (parsed.flags.help) return console.log('Usage: hivedesk doctor [--p2p] [--model <name|path>] [--dir <folder>] [--json]');
  const { cacheHome, runDoctor } = await import('./index.js');
  const { formatDoctor } = await import('./doctor.js');
  const { coreChecks } = await import('./core/doctor-checks.js');
  const home = cacheHome();
  const report = await runDoctor({ home, model: parsed.flags.model, p2p: !!parsed.flags.p2p });
  const extra = await coreChecks({ home, dir: path.resolve(parsed.flags.dir || process.cwd()), engine: await findEngine(home, { timeoutMs: 1500 }) });
  report.checks.push(...extra);
  report.ok = report.checks.every((c) => c.ok);
  console.log(parsed.flags.json ? JSON.stringify(report, null, 2) : formatDoctor(report));
  process.exitCode = report.ok ? 0 : 1;
}

/** `hivedesk share`: ShareSettings, through runShare() of src/compute/share-cli.js (Stream 3). Exit code 3: not in this build. */
async function runShareCmd(argv) {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'compute', 'share-cli.js');
  if (!fs.existsSync(file)) {
    console.error('hivedesk: "hivedesk share" is not in this build yet (compute/share-cli.js is missing).');
    process.exitCode = 3;
    return;
  }
  const { cacheHome } = await import('./index.js');
  const { runShare } = await import('./compute/share-cli.js');
  process.exitCode = runShare(argv, { home: cacheHome() });
}

/** A subcommand of another module (invite, join, peers). Exit code 3: not in this build. */
async function runProvided(name, argv) {
  const found = await loadSubcommand(name);
  if (found.missing) {
    console.error(`hivedesk: ${found.missing}.`);
    if (name === 'join') console.error('  Until then, "hivedesk --join <words>" opens the window with the words filled in.');
    process.exitCode = 3;
    return;
  }
  const def = found.def;
  if (def.raw) {
    const { cacheHome } = await import('./index.js');
    const code = await def.run(argv, { home: cacheHome(), stdin: process.stdin, stdout: process.stdout, stderr: process.stderr });
    process.exitCode = Number.isInteger(code) ? code : 0;
    return;
  }
  let parsed;
  try { parsed = parseFlags(argv, def.options || {}); } catch (err) { return usageError(err); }
  if (parsed.flags.help) return console.log(def.usage || `Usage: hivedesk ${name}`);
  const index = await import('./index.js');
  const home = index.cacheHome();
  const code = await def.run({
    name, flags: parsed.flags, positionals: parsed.positionals, home,
    dir: path.resolve(parsed.flags.dir || process.cwd()), version: index.VERSION,
    out: (line) => console.log(line), err: (line) => console.error(line),
    findEngine: (o) => findEngine(home, o), startHive: index.startHive, loadToken: (rotate) => loadToken(home, rotate)
  });
  process.exitCode = Number.isInteger(code) ? code : 0;
}

async function main() {
  const argv = process.argv.slice(2);
  let cmd;
  try { cmd = splitCommand(argv); } catch (err) { return usageError(err); }
  switch (cmd.command) {
    case 'help': return console.log(HELP);
    case 'start': return runStart(cmd.rest);
    case 'city': return runCity(cmd.rest);
    case 'doctor': return runDoctorCmd(cmd.rest);
    case 'share': return runShareCmd(cmd.rest);
    default: return runProvided(cmd.command, cmd.rest);
  }
}

const invoked = process.argv[1] && path.resolve(process.argv[1]);
const selfPath = fileURLToPath(import.meta.url);
let isMain = false;
try { isMain = !!invoked && fs.realpathSync(invoked) === fs.realpathSync(selfPath); } catch { isMain = false; }
if (isMain) {
  main().catch((err) => {
    console.error(`hivedesk: ${err?.message || err}`);
    process.exit(1);
  });
}
