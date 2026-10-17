#!/usr/bin/env node
// hivedesk command line.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import crypto from 'node:crypto';
import { hasRealLog } from './bus.js';

const HELP = `hivedesk: a crew of AI workers that build real files on your machine with a local model.

Usage: npx hivedesk [options]

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
  --demo                scripted demo, no model; every event is labeled as a demo. It runs in a
                        temporary folder with its own home and never writes into a project
  --demo-dir <folder>   run the demo in this folder instead (never one with a real project log)
  --lend                lend this machine's model to a paired friend (opens the Lend screen)
  --join <link|words>   open the desktop with "Use a friend's PC" filled in with these six words
  --yes                 skip the setup questions (the saved setup, or the recommended defaults)
  --doctor              check Node, GPU, RAM, disk and models, then exit
  --version             print the version
  --help                this help

First run: see FIRST-RUN.md. Cache folder: ~/.hivedesk (or HIVEDESK_HOME).`;

export { hasRealLog };

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
    else if (['demo', 'lend', 'doctor', 'help', 'version', 'cpu', 'yes', 'browser', 'new-token'].includes(key)) o[key] = true;
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

/**
 * Where --demo runs: a new temporary folder; --demo-dir <folder> when given. A --dir that is a real
 * project (a folder with files in it) is refused, so the demo never writes into a project's log.
 */
export function demoFolder(args, { tmp = os.tmpdir(), cwd = process.cwd() } = {}) {
  if (args['demo-dir']) {
    const dir = path.resolve(cwd, args['demo-dir']);
    if (hasRealLog(dir)) throw new Error(`${dir} holds a real hivedesk project; the demo needs a folder of its own`);
    return dir;
  }
  if (args.dir) {
    const dir = path.resolve(cwd, args.dir);
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch { entries = []; }
    const demoOnly = entries.length === 1 && entries[0] === '.hivedesk' && fs.existsSync(path.join(dir, '.hivedesk', 'events.jsonl')) && !hasRealLog(dir);
    if (entries.length && !demoOnly) throw new Error(`--demo will not run in ${dir}: the folder is not empty. Leave out --dir for a temporary demo folder, or pass --demo-dir <folder>`);
    return dir;
  }
  return fs.mkdtempSync(path.join(tmp, 'hivedesk-demo-'));
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

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`hivedesk: ${err.message}\nRun "hivedesk --help" for the options.`);
    process.exit(2);
  }
  if (args.join && !joinWords(args.join)) {
    console.error('hivedesk: --join needs a share link or the six words');
    process.exit(2);
  }
  const { startHive, VERSION, cacheHome, runDoctor } = await import('./index.js');
  if (args.help) return console.log(HELP);
  if (args.version) return console.log(VERSION);
  if (args.doctor) {
    const { formatDoctor } = await import('./doctor.js');
    const report = await runDoctor({ home: cacheHome(), model: args.model });
    console.log(formatDoctor(report));
    process.exitCode = report.ok ? 0 : 1;
    return;
  }
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
  if (args['demo-dir'] && !args.demo) {
    console.error('hivedesk: --demo-dir goes with --demo');
    process.exit(2);
  }
  // The demo never touches a real project or the real ~/.hivedesk: its own folder and its own home.
  let demoHome;
  if (args.demo) {
    try { dir = demoFolder(args); } catch (err) { console.error(`hivedesk: ${err.message}`); process.exit(2); }
    demoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hivedesk-demo-home-'));
  }
  const progress = makeProgress();
  const log = (line) => { progress(null); console.log(`  ${line}`); };
  console.log(`hivedesk ${VERSION}${args.demo ? ' (DEMO: no model, scripted crew, a separate demo folder)' : ''}${args.lend ? ' (lend mode)' : ''}`);
  const port = args.port !== undefined ? args.port : await stablePort(4174);
  const app = await startHive({
    dir,
    port,
    token: args.demo ? undefined : loadToken(cacheHome(), !!args['new-token']),
    demo: !!args.demo,
    ...(demoHome ? { home: demoHome } : {}),
    lend: !!args.lend,
    city: args.city !== false,
    log,
    progress,
    flags: {
      brain: args.brain, model: args.model, url: args.url, noDownload: !args.download,
      gpu: args.cpu ? false : undefined, ctx: args.ctx,
      ...(setup && !setup.demo ? setup.flags : {})
    }
  });
  if (setup) app.hive.setSettings({ approvalMode: setup.approvalMode, crew: setup.crew });
  console.log(`  ${args.demo ? 'demo folder' : 'folder'}: ${path.join(dir, '.hivedesk')}`);
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
