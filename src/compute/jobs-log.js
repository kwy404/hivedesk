// ~/.hivedesk/jobs/<yyyy-mm>.jsonl: one final record per job requested or served (PLAN section 1.4).
// Counts, models, outcomes and reasons only; never prompt or answer text.
import fs from 'node:fs';
import path from 'node:path';

const TEXT_KEYS = new Set(['text', 'messages', 'content', 'prompt', 'partial', 'result', 'input']);

export class JobLog {
  /** @param {string | null} dir the jobs folder, or null for no file */
  constructor(dir) {
    this.dir = dir;
  }

  file(at = new Date()) {
    const m = `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`;
    return path.join(this.dir, `${m}.jsonl`);
  }

  append(rec) {
    if (!this.dir) return;
    const clean = {};
    for (const [k, v] of Object.entries(rec || {})) if (!TEXT_KEYS.has(k)) clean[k] = v;
    fs.mkdirSync(this.dir, { recursive: true });
    fs.appendFileSync(this.file(), JSON.stringify({ v: 1, ts: new Date().toISOString(), ...clean }) + '\n');
  }

  /** The newest records of this month, newest first. */
  recent(limit = 50) {
    if (!this.dir) return [];
    try {
      const lines = fs.readFileSync(this.file(), 'utf8').split('\n').filter(Boolean);
      return lines.slice(-limit).reverse().map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch {
      return [];
    }
  }
}
