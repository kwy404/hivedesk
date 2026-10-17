// The desktop app: what src/cli.js calls (see the "desktop hook" lines there). See desktop/README.md.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lockFile, focusRunning } from './instance.js';
import { WindowStore } from './state.js';
import { desktopStrings, pickLocale } from './strings.js';
import { openDesktop } from './controller.js';

export { openDesktop };
export { platformKey, target, TARGETS, RUNTIME } from './platform.js';
export { checkWebview, decideLaunch } from './detect.js';
export { ensureRuntime } from './runtime.js';

/**
 * Single instance: when hivedesk already runs, bring its window to the front and say so.
 * @returns {Promise<boolean>} true when this run should stop here
 */
export async function focusExisting({ home, args, dir, log = console.log }) {
  const running = await focusRunning(lockFile(home), { start: null });
  if (!running) return false;
  const S = await desktopStrings(pickLocale());
  const want = dir || (args.dir ? path.resolve(args.dir) : null);
  if (want && running.dir && path.resolve(running.dir) !== path.resolve(want)) log(`hivedesk: ${S.t('cli.desktop.alreadyOpenDir', { dir: running.dir })}`);
  else log(`hivedesk: ${S.t('cli.desktop.alreadyOpen')}`);
  return true;
}

/**
 * The project folder when started from a downloaded package (HIVEDESK_DESKTOP=1, no terminal):
 * the last folder chosen in the app, the wizard's saved folder, or ~/hivedesk.
 */
export function packagedDir({ home, env = process.env }) {
  if (env.HIVEDESK_DESKTOP !== '1') return null;
  const last = new WindowStore(path.join(home, 'desktop')).settings().lastDir;
  if (last && fs.existsSync(last)) return last;
  try {
    const c = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
    if (c && typeof c.dir === 'string' && fs.existsSync(c.dir)) return c.dir;
  } catch { /* no saved setup */ }
  const dir = path.join(os.homedir(), 'hivedesk');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
