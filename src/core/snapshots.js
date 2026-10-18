// Store snapshots (PLAN.md section 1.4): <project>/.hivedesk/snapshots/<seq>.json
// One every 5,000 events or 10 minutes and on close; start replays the log only after the newest usable one.
import fs from 'node:fs';
import path from 'node:path';

export const SNAPSHOT_EVERY = 5000;
export const SNAPSHOT_MS = 10 * 60 * 1000;
const NAME = /^(\d+)\.json$/;

export class SnapshotStore {
  /** @param {{ dir: string, keep?: number, readOnly?: boolean }} opts */
  constructor(opts) {
    this.dir = opts.dir;
    this.keep = Math.max(1, opts.keep || 3);
    this.readOnly = !!opts.readOnly;
  }

  /** Snapshots on disk, newest first. */
  list() {
    if (!fs.existsSync(this.dir)) return [];
    const out = [];
    for (const f of fs.readdirSync(this.dir)) {
      const m = NAME.exec(f);
      if (m) out.push({ seq: Number(m[1]), file: path.join(this.dir, f) });
    }
    return out.sort((a, b) => b.seq - a.seq);
  }

  /**
   * The newest snapshot with seq <= maxSeq that `accept` takes. Broken files are skipped.
   * @param {number} maxSeq
   * @param {(snap: any) => boolean} accept
   */
  latest(maxSeq, accept = () => true) {
    for (const s of this.list()) {
      if (s.seq > maxSeq) continue;
      let snap;
      try { snap = JSON.parse(fs.readFileSync(s.file, 'utf8')); } catch { continue; }
      if (!snap || typeof snap !== 'object' || snap.seq !== s.seq) continue;
      if (accept(snap)) return snap;
    }
    return null;
  }

  /** Writes a snapshot (tmp file plus rename) and keeps only the newest few. */
  write(seq, body) {
    if (this.readOnly) return null;
    fs.mkdirSync(this.dir, { recursive: true });
    const file = path.join(this.dir, `${seq}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...body, seq }));
    fs.renameSync(tmp, file);
    for (const old of this.list().slice(this.keep)) {
      try { fs.unlinkSync(old.file); } catch { /* still open elsewhere: next time */ }
    }
    return file;
  }
}
