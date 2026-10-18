// Strict demo separation (PLAN.md section 1.5).
//   --demo always runs in a demo folder: a fresh temp folder, or a folder that is empty or already a demo folder.
//   A demo folder has the marker file <dir>/.hivedesk/demo.
//   The demo gets its own home (identity, peers, settings, agents) inside the demo folder, never ~/.hivedesk.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEMO_MARKER = 'demo';

export class DemoRefused extends Error {
  constructor(dir) {
    super(`--demo runs only in an empty folder or a demo folder, and ${dir} is a real project folder. Leave out --dir to get a fresh demo folder.`);
    this.code = 'demo_refused';
  }
}

export function markerFile(dir) {
  return path.join(dir, '.hivedesk', DEMO_MARKER);
}

export function isDemoFolder(dir) {
  try { return fs.statSync(markerFile(dir)).isFile(); } catch { return false; }
}

function isEmptyFolder(dir) {
  try { return fs.readdirSync(dir).length === 0; } catch (err) { return err.code === 'ENOENT'; }
}

/**
 * The folder a demo runs in, with its marker written. Refuses a real project folder.
 * @param {string} [dir] the --dir the user gave, if any
 * @returns {string}
 */
export function prepareDemoDir(dir) {
  const target = dir ? path.resolve(dir) : fs.mkdtempSync(path.join(os.tmpdir(), 'hivedesk-demo-'));
  if (dir && !isDemoFolder(target) && !isEmptyFolder(target)) throw new DemoRefused(target);
  fs.mkdirSync(path.join(target, '.hivedesk'), { recursive: true });
  if (!isDemoFolder(target)) fs.writeFileSync(markerFile(target), `This folder holds a hivedesk demo. Nothing here came from a model.\ncreated ${new Date().toISOString()}\n`);
  return target;
}

/** The demo's own home: a fresh folder inside the demo folder, removed when the demo stops. */
export function demoHome(dir) {
  const home = path.join(dir, '.hivedesk', 'demo-home');
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(home, { recursive: true });
  return home;
}
