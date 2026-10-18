// A search worker (worker_threads). Reads files and matches them off the main thread, so a
// slow regular expression never blocks the engine; the pool terminates a worker to cancel.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { parentPort } from 'node:worker_threads';
import { buildRegex, findInText, replaceInText } from './match.js';

const MAX_BYTES = 2 * 1024 * 1024;

function readText(abs) {
  let st;
  try { st = fs.lstatSync(abs); } catch { return null; }
  if (!st.isFile() || st.size > MAX_BYTES) return null;
  const buf = fs.readFileSync(abs);
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return null;
  return buf.toString('utf8');
}

parentPort.on('message', (job) => {
  try {
    const re = buildRegex(job.spec);
    if (job.type === 'search') {
      let left = job.limit;
      const results = [];
      for (const f of job.files) {
        if (left <= 0) break;
        const text = readText(f.abs);
        if (text == null) continue;
        const hits = findInText(text, re, left);
        if (hits.length) {
          left -= hits.length;
          results.push({ path: f.rel, hits });
        }
      }
      parentPort.postMessage({ id: job.id, ok: true, results, scanned: job.files.length });
    } else if (job.type === 'replace') {
      const results = [];
      for (const f of job.files) {
        const text = readText(f.abs);
        if (text == null) continue;
        const r = replaceInText(text, re, job.replacement, { regex: !!job.spec.regex });
        if (r.count) results.push({ path: f.rel, sha: crypto.createHash('sha1').update(text).digest('hex'), count: r.count, after: r.after, changes: r.changes });
      }
      parentPort.postMessage({ id: job.id, ok: true, results, scanned: job.files.length });
    } else {
      parentPort.postMessage({ id: job.id, ok: false, error: `unknown job ${job.type}` });
    }
  } catch (err) {
    parentPort.postMessage({ id: job.id, ok: false, error: err.message, code: err.code });
  }
});
