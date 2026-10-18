// The update guard: runs from the files of the version being replaced, after that version has quit.
//   1. waits for the old app process to exit (so its files and the single instance lock are free),
//   2. commits the staged version (one rename),
//   3. starts the new version and waits for its first launch health mark,
//   4. healthy: ends the trial and exits, leaving the new app running;
//      not healthy (it exited, or no mark in time): stops it, rolls back and starts the previous version.
// Started by desktop/update/service.js with the path of a plan file (JSON) as its only argument.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { commit, rollback, markHealthy, readHealth, launchCommand, writeState, readState } from './apply.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

function defaultStart(cmd, args, env) {
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false, env });
  child.on('error', () => {});
  child.unref();
  return child;
}

/**
 * @param {{ install: object, version: string, home: string, waitPid?: number, timeoutMs?: number, pollMs?: number,
 *   start?: (cmd: string, args: string[], env: object) => { pid?: number, exitCode?: number | null, kill: () => void, once?: Function },
 *   log?: (s: string) => void, platform?: string }} o
 * @returns {Promise<{ ok: boolean, version: string, rolledBack?: boolean, reason?: string }>}
 */
export async function runGuard(o) {
  const log = o.log || (() => {});
  const pollMs = o.pollMs ?? 250;
  const start = o.start || defaultStart;
  const deadlineExit = Date.now() + 60000;
  while (o.waitPid && alive(o.waitPid) && Date.now() < deadlineExit) await sleep(pollMs);
  const startedAt = Date.now();
  let previous;
  try {
    ({ previous } = commit(o.install, o.version));
  } catch (err) {
    // Nothing was switched: start the version that is still current.
    log(`update: could not switch to ${o.version}: ${err.message}`);
    writeState(o.install, { ...readState(o.install), state: 'failed', failed: o.version, reason: err.message });
    const same = launchCommand(o.install, o.platform);
    if (same) start(same.cmd, same.args, { ...process.env, HIVEDESK_UPDATE_ROLLED_BACK: o.version });
    return { ok: false, version: o.version, rolledBack: false, reason: err.message };
  }
  log(`update: switched to ${o.version} (previous ${previous || 'none'})`);
  const launch = launchCommand(o.install, o.platform);
  const env = { ...process.env, HIVEDESK_UPDATE_TRIAL: o.version };
  delete env.HIVEDESK_UPDATE_ROLLED_BACK;
  const child = start(launch.cmd, launch.args, env);
  let exited = null;
  child.once?.('exit', (code) => { exited = { code }; });
  const deadline = startedAt + (o.timeoutMs || 120000);
  let reason = 'timeout';
  for (;;) {
    const h = readHealth(o.home);
    if (h && h.version === o.version && h.at >= startedAt) {
      markHealthy(o.install, o.version, { platform: o.platform });
      log(`update: ${o.version} is healthy`);
      return { ok: true, version: o.version };
    }
    if (exited) { reason = `exited with code ${exited.code}`; break; }
    if (Date.now() > deadline) break;
    await sleep(pollMs);
  }
  log(`update: ${o.version} failed its first launch (${reason}), rolling back`);
  try { child.kill(); } catch { /* gone */ }
  const st = readState(o.install);
  if (st.state === 'trial') rollback(o.install);
  const back = readState(o.install);
  writeState(o.install, { ...back, state: 'rolledBack', failed: o.version, reason });
  const again = launchCommand(o.install, o.platform);
  start(again.cmd, again.args, { ...process.env, HIVEDESK_UPDATE_ROLLED_BACK: o.version });
  return { ok: false, version: o.version, rolledBack: true, reason };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const plan = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const logFile = path.join(plan.home, 'update', 'guard.log');
  const log = (s) => { try { fs.appendFileSync(logFile, `${new Date().toISOString()} ${s}\n`); } catch { /* no log */ } };
  runGuard({ ...plan, log }).then((r) => { log(JSON.stringify(r)); process.exit(0); }, (err) => { log(`update guard: ${err.stack || err}`); process.exit(1); });
}
