// Single instance: one hivedesk window per user. A second run asks the first one to come to the front.
import fs from 'node:fs';
import path from 'node:path';

export const lockFile = (home) => path.join(home, 'desktop', 'instance.json');

/** True when a process with this id exists (EPERM means it exists but belongs to someone else). */
export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

export function readLock(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && Number.isInteger(v.pid) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Takes the lock atomically (exclusive create). A lock left by a process that is gone is replaced.
 * @param {string} file
 * @param {{ pid: number, port: number, token: string, dir: string }} info
 * @param {{ alive?: (pid: number) => boolean }} [o]
 * @returns {{ ok: true } | { ok: false, existing: object }}
 */
export function acquireLock(file, info, o = {}) {
  const alive = o.alive || isAlive;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeSync(fd, JSON.stringify({ ...info, startedAt: new Date().toISOString() }));
      fs.closeSync(fd);
      return { ok: true };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const existing = readLock(file);
      if (existing && existing.pid !== info.pid && alive(existing.pid)) return { ok: false, existing };
      try { fs.unlinkSync(file); } catch { /* raced with another start */ }
    }
  }
  const existing = readLock(file);
  return existing && existing.pid === info.pid ? { ok: true } : { ok: false, existing };
}

/** Updates the port and token after the server started (same owner only). */
export function updateLock(file, info) {
  const cur = readLock(file);
  if (!cur || cur.pid !== info.pid) return false;
  fs.writeFileSync(file, JSON.stringify({ ...cur, ...info }), { mode: 0o600 });
  return true;
}

/** Removes the lock when this process owns it. */
export function releaseLock(file, pid = process.pid) {
  const cur = readLock(file);
  if (cur && cur.pid !== pid) return false;
  try { fs.unlinkSync(file); } catch { /* already gone */ }
  return true;
}

/**
 * Asks a running instance to show its window.
 * @returns {Promise<object | null>} the running instance, or null when there is none (stale locks are removed)
 */
export async function focusRunning(file, { fetchImpl = globalThis.fetch, alive = isAlive, timeoutMs = 2000, start } = {}) {
  const cur = readLock(file);
  if (!cur) return null;
  if (cur.pid === process.pid) return null;
  if (!alive(cur.pid)) { releaseLock(file, cur.pid); return null; }
  if (!cur.port || !cur.token || typeof fetchImpl !== 'function') return cur;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const res = await fetchImpl(`http://127.0.0.1:${cur.port}/api/desktop/focus`, {
      method: 'POST', signal: ctl.signal,
      headers: { authorization: `Bearer ${cur.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ start: start || null })
    });
    clearTimeout(timer);
    if (res.ok) return cur;
  } catch { /* not answering */ }
  // The process lives but does not answer as hivedesk: the pid was reused. Forget the lock.
  releaseLock(file, cur.pid);
  return null;
}
