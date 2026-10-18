// The checks `hivedesk doctor` adds from the core (PLAN.md section 9): folders writable, the project log, the port.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { SegmentLog } from './log.js';
import { SnapshotStore } from './snapshots.js';

const MB = 1024 * 1024;

function writable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.write-probe-${process.pid}`);
    fs.writeFileSync(probe, 'x');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

/**
 * @param {{ home: string, dir: string, port?: number, engine?: { port: number, pid: number } | null }} opts
 * @returns {Promise<Array<{ id: string, label: string, ok: boolean, detail: string, hint?: string }>>}
 */
export async function coreChecks(opts) {
  const checks = [];
  const add = (id, label, ok, detail, hint) => checks.push(hint ? { id, label, ok, detail, hint } : { id, label, ok, detail });
  const homeOk = writable(opts.home);
  add('home', 'Home folder', homeOk, `${opts.home} ${homeOk ? 'is writable' : 'is not writable'}`, homeOk ? undefined : 'Set HIVEDESK_HOME to a folder you can write.');
  const root = path.join(opts.dir, '.hivedesk');
  if (fs.existsSync(root)) {
    const ok = writable(root);
    add('project', 'Project folder', ok, `${root} ${ok ? 'is writable' : 'is not writable'}`, ok ? undefined : 'The engine needs to append to the log in this folder.');
    const log = new SegmentLog({ dir: path.join(root, 'events'), legacyFile: path.join(root, 'events.jsonl'), readOnly: true });
    const bytes = log.bytes();
    const segs = log.segments().length;
    const snaps = new SnapshotStore({ dir: path.join(root, 'snapshots'), readOnly: true }).list();
    const big = bytes > 1024 * MB;
    add('log', 'Project log', !big, `${(bytes / MB).toFixed(1)} MB in ${segs} segment${segs === 1 ? '' : 's'}, ${snaps.length ? `newest snapshot at event ${snaps[0].seq}` : 'no snapshot yet'}`,
      big ? 'The log is over 1 GB: file contents ride in file.changed events. Start a new project folder for new work.' : undefined);
  } else {
    const ok = writable(opts.dir);
    add('project', 'Project folder', ok, `${opts.dir} has no .hivedesk yet; it ${ok ? 'is writable' : 'is not writable'}`, ok ? undefined : 'Run hivedesk in a folder you can write, or pass --dir.');
  }
  const port = opts.port || 4174;
  if (opts.engine && opts.engine.port === port) add('port', `Port ${port}`, true, `used by the running hivedesk engine (pid ${opts.engine.pid})`);
  else {
    const free = await portFree(port);
    add('port', `Port ${port}`, true, free ? 'free (the installed app finds the engine there)' : 'taken by another program; hivedesk then uses a random port', free ? undefined : 'The installed app window needs the link printed in the terminal then.');
  }
  return checks;
}
