// Where the GitHub connection is kept: only on this machine, in <HIVEDESK_HOME>/github.json,
// readable by the current user only. A token never leaves this module except to call GitHub
// or to give git one push or clone through the environment.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const FILE_NAME = 'github.json';

/** Limits a file or folder to the current user. POSIX modes, plus an ACL on Windows. */
export function restrict(p, { dir = false, platform = process.platform, exec = execFileSync } = {}) {
  try { fs.chmodSync(p, dir ? 0o700 : 0o600); } catch { /* ignore */ }
  if (platform !== 'win32') return true;
  const user = process.env.USERNAME;
  if (!user) return false;
  const who = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${user}` : user;
  try {
    // Drop inherited entries and grant full control to the current user only.
    exec('icacls', [p, '/inheritance:r', '/grant:r', `${who}:${dir ? '(OI)(CI)F' : 'F'}`], { stdio: 'ignore', windowsHide: true, timeout: 10_000 });
    return true;
  } catch {
    try {
      exec('icacls', [p, '/inheritance:r', '/grant:r', `${user}:${dir ? '(OI)(CI)F' : 'F'}`], { stdio: 'ignore', windowsHide: true, timeout: 10_000 });
      return true;
    } catch { return false; }
  }
}

export class CredentialStore {
  /** @param {string} home the hivedesk home folder (HIVEDESK_HOME or ~/.hivedesk) */
  constructor(home, opts = {}) {
    this.home = home;
    this.file = path.join(home, FILE_NAME);
    this.restrict = opts.restrict || restrict;
  }

  /** @returns {{ source: 'pat'|'gh'|'device', token?: string, login: string, name?: string, id?: number, avatarUrl?: string, savedAt: string } | null} */
  read() {
    try {
      const rec = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return rec && typeof rec.source === 'string' && typeof rec.login === 'string' ? rec : null;
    } catch { return null; }
  }

  /** Writes atomically with owner only permissions from the first byte. */
  save(rec) {
    const fresh = !fs.existsSync(this.home);
    fs.mkdirSync(this.home, { recursive: true, mode: 0o700 });
    if (fresh) this.restrict(this.home, { dir: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    const data = JSON.stringify({ ...rec, savedAt: new Date().toISOString() }, null, 2);
    const fd = fs.openSync(tmp, 'w', 0o600);
    try { fs.writeSync(fd, data); } finally { fs.closeSync(fd); }
    this.restrict(tmp);
    fs.renameSync(tmp, this.file);
    this.restrict(this.file);
    return this.read();
  }

  clear() {
    try { fs.unlinkSync(this.file); return true; } catch { return false; }
  }

  /** What may be shown in the UI or logged: never the token. */
  publicView() {
    const r = this.read();
    if (!r) return null;
    return { source: r.source, login: r.login, name: r.name || null, avatarUrl: r.avatarUrl || null, savedAt: r.savedAt };
  }
}

/** Reads the optional user config (<home>/config.json). The device flow needs github.clientId there. */
export function readConfig(home) {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
    return c && typeof c === 'object' ? c : {};
  } catch { return {}; }
}
