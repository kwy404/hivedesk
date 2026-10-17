#!/usr/bin/env node
// Entry point of the downloadable packages (hivedesk.exe, hivedesk.app, the Linux folder and AppImage).
// The same start as `npx hivedesk`, without a terminal: the saved setup (or the recommended defaults),
// the last project folder, then the native window. Accepts the same options as the CLI.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, startUrl } from '../src/cli.js';
import { startHive, VERSION, cacheHome } from '../src/index.js';
import { focusExisting, packagedDir, openDesktop } from './index.js';

process.env.HIVEDESK_DESKTOP = '1';

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`hivedesk: ${err.message}`);
    process.exit(2);
  }
  if (args.version) { console.log(VERSION); return; }
  if (args.help || args.doctor) { console.log('hivedesk desktop: for the options and the checks, run "npx hivedesk --help" or "npx hivedesk --doctor" in a terminal.'); return; }
  const home = cacheHome();
  if (args.open && await focusExisting({ home, args })) return;
  let dir = path.resolve(args.dir || packagedDir({ home }) || process.cwd());
  let setup = null;
  if (!(args.demo || args.model || args.brain || args.lend || args.join)) {
    const { wizardSetup } = await import('../src/wizard/index.js');
    setup = await wizardSetup({ home, cwd: dir, yes: true });
    if (setup?.demo) args.demo = true;
  }
  if (args.demo && !args.dir) dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hivedesk-demo-'));
  const log = (line) => console.log(`  ${line}`);
  console.log(`hivedesk ${VERSION} desktop${args.demo ? ' (demo)' : ''} in ${dir}`);
  const app = await startHive({
    dir, port: args.port, demo: !!args.demo, lend: !!args.lend, log,
    progress: () => {},
    flags: {
      brain: args.brain, model: args.model, url: args.url, noDownload: !args.download,
      gpu: args.cpu ? false : undefined, ctx: args.ctx,
      ...(setup && !setup.demo ? setup.flags : {})
    }
  });
  if (setup) app.hive.setSettings({ approvalMode: setup.approvalMode, crew: setup.crew });
  let stopping = false;
  const stop = async () => {
    if (stopping) process.exit(130);
    stopping = true;
    try { await app.close(); } catch { /* exit anyway */ }
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  const url = startUrl(app.server.port, app.server.token, args);
  if (args.open) await openDesktop({ app, url, args, dir, home, log, quit: stop, version: VERSION, configLang: setup?.lang });
  else console.log(`  open: ${url}`);
}

main().catch((err) => {
  console.error(`hivedesk: ${err?.stack || err}`);
  process.exit(1);
});
