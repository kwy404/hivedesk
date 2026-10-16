#!/usr/bin/env node
// hivedesk command line.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HELP = `hivedesk: a crew of AI workers that build real files on your machine with a local model.

Usage: npx hivedesk [options]

  --dir <folder>        project folder (default: the current folder); files go to <folder>/.hivedesk/
  --port <n>            port on 127.0.0.1 (default: a random free port)
  --no-open             do not open the browser
  --model <path|uri>    use this GGUF file instead of the automatic choice
  --brain <name>        ollama, lmstudio or openai (with --url, --model and HIVEDESK_API_KEY)
  --url <url>           base URL for --brain
  --no-download         never download a model; the UI offers the download instead
  --cpu                 do not use the GPU
  --ctx <n>             context size for the local model (default: up to 8192)
  --demo                scripted demo, no model; every event is labeled as a demo
  --lend                lend this machine's model to a paired friend (opens the Lend screen)
  --join <link|words>   open the desktop with "Use a friend's PC" filled in with these six words
  --doctor              check Node, GPU, RAM, disk and models, then exit
  --version             print the version
  --help                this help

First run: see FIRST-RUN.md. Cache folder: ~/.hivedesk (or HIVEDESK_HOME).`;

export function parseArgs(argv) {
  const o = { open: true, download: true };
  const takes = new Set(['dir', 'port', 'model', 'brain', 'url', 'ctx', 'join']);
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
    else if (['demo', 'lend', 'doctor', 'help', 'version', 'cpu'].includes(key)) o[key] = true;
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
  let dir = path.resolve(args.dir || process.cwd());
  if (args.demo && !args.dir) dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hivedesk-demo-'));
  const progress = makeProgress();
  const log = (line) => { progress(null); console.log(`  ${line}`); };
  console.log(`hivedesk ${VERSION}${args.demo ? ' (demo: no model, scripted crew)' : ''}${args.lend ? ' (lend mode)' : ''}`);
  const app = await startHive({
    dir,
    port: args.port,
    demo: !!args.demo,
    lend: !!args.lend,
    log,
    progress,
    flags: {
      brain: args.brain, model: args.model, url: args.url, noDownload: !args.download,
      gpu: args.cpu ? false : undefined, ctx: args.ctx
    }
  });
  console.log(`  folder: ${path.join(dir, '.hivedesk')}`);
  console.log(`  open:   ${app.url}`);
  const openUrl = startUrl(app.server.port, app.server.token, args);
  if (openUrl !== app.url) console.log(`          ${openUrl}`);
  if (args.open) openBrowser(openUrl);
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
