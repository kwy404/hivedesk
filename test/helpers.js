import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tmpDir(prefix = 'hivedesk-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function waitFor(fn, { timeout = 10000, interval = 10 } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      let v;
      try { v = fn(); } catch (err) { return reject(err); }
      if (v) return resolve(v);
      if (Date.now() - started > timeout) return reject(new Error('waitFor timed out'));
      setTimeout(tick, interval);
    };
    tick();
  });
}

/** Collects frames from a ws client. */
export function frames(conn) {
  const list = [];
  conn.on('message', (t) => list.push(JSON.parse(t)));
  return list;
}
