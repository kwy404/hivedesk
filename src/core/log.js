// The append only event log in segments (PLAN.md section 1.4).
//   <project>/.hivedesk/events/000001.jsonl ...  one file per segment, named by its first seq, at most 64 MB each
//   <project>/.hivedesk/events.jsonl            the 0.x log, read as segment 0 and never written again
// Without a segment folder the log is one file (the 0.x layout, used by tests and tools).
import fs from 'node:fs';
import path from 'node:path';

export const SEGMENT_BYTES = 64 * 1024 * 1024;
const SEGMENT_NAME = /^(\d{6,})\.jsonl$/;

export const segmentName = (firstSeq) => `${String(firstSeq).padStart(6, '0')}.jsonl`;

/**
 * Parses jsonl text into events: blank lines and a torn line (a crash in the middle of a write) are skipped,
 * and so is any event whose seq does not move forward.
 */
export function parseEvents(text, after = 0, out = []) {
  let last = out.length ? out[out.length - 1].seq : after;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e || typeof e.seq !== 'number' || e.seq <= last) continue;
    out.push(e);
    last = e.seq;
  }
  return out;
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (err) { if (err.code === 'ENOENT') return ''; throw err; }
}

function endsWithNewline(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    if (!size) return true;
    const b = Buffer.alloc(1);
    fs.readSync(fd, b, 0, 1, size - 1);
    return b[0] === 0x0a;
  } catch {
    return true;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export class SegmentLog {
  /**
   * @param {{ dir?: string | null, legacyFile?: string | null, segmentBytes?: number, readOnly?: boolean }} opts
   * dir: the segment folder; legacyFile: the single 0.x file (read first; written only when there is no dir).
   */
  constructor(opts = {}) {
    this.dir = opts.dir || null;
    this.legacyFile = opts.legacyFile || null;
    this.segmentBytes = opts.segmentBytes || SEGMENT_BYTES;
    this.readOnly = !!opts.readOnly;
    if (!this.dir && !this.legacyFile) throw new Error('SegmentLog needs a dir or a file');
    if (this.dir && !this.readOnly) fs.mkdirSync(this.dir, { recursive: true });
    /** the file appends go to, its size and whether its last line is torn */
    this._current = null;
  }

  /** The segments, oldest first: [{ file, firstSeq, legacy }]. */
  segments() {
    const out = [];
    if (this.legacyFile && fs.existsSync(this.legacyFile)) out.push({ file: this.legacyFile, firstSeq: 0, legacy: true });
    if (this.dir && fs.existsSync(this.dir)) {
      const segs = [];
      for (const f of fs.readdirSync(this.dir)) {
        const m = SEGMENT_NAME.exec(f);
        if (m) segs.push({ file: path.join(this.dir, f), firstSeq: Number(m[1]), legacy: false });
      }
      segs.sort((a, b) => a.firstSeq - b.firstSeq);
      out.push(...segs);
    }
    return out;
  }

  /** Every event, in order. */
  readAll() {
    return this.readFrom(0);
  }

  /** Events with seq > `seq`; segments that end before it are not read. */
  readFrom(seq = 0) {
    const segs = this.segments();
    const out = [];
    for (let i = 0; i < segs.length; i++) {
      const next = segs[i + 1];
      if (next && next.firstSeq <= seq + 1) continue;
      parseEvents(readText(segs[i].file), seq, out);
    }
    return out;
  }

  /** The last event in the log (reads only the last non empty segment). */
  lastEvent() {
    const segs = this.segments();
    for (let i = segs.length - 1; i >= 0; i--) {
      const list = parseEvents(readText(segs[i].file));
      if (list.length) return list[list.length - 1];
    }
    return null;
  }

  /** Total bytes on disk, for the doctor and `hivedesk city`. */
  bytes() {
    let n = 0;
    for (const s of this.segments()) { try { n += fs.statSync(s.file).size; } catch { /* gone */ } }
    return n;
  }

  _open(seq) {
    if (!this.dir) {
      const file = this.legacyFile;
      let size = 0;
      try { size = fs.statSync(file).size; } catch { /* new */ }
      return { file, size, torn: !endsWithNewline(file) };
    }
    const segs = this.segments().filter((s) => !s.legacy);
    const last = segs[segs.length - 1];
    if (last) {
      const size = fs.statSync(last.file).size;
      if (size < this.segmentBytes) return { file: last.file, size, torn: !endsWithNewline(last.file) };
    }
    return { file: path.join(this.dir, segmentName(seq)), size: 0, torn: false };
  }

  /** Appends one event (a JSON line). A torn last line from a crash is closed first, so the new line stays whole. */
  append(event) {
    if (this.readOnly) throw new Error('this log is open read only');
    const line = JSON.stringify(event) + '\n';
    const bytes = Buffer.byteLength(line);
    if (!this._current) this._current = this._open(event.seq);
    let cur = this._current;
    if (this.dir && cur.size > 0 && cur.size + bytes > this.segmentBytes) {
      cur = this._current = { file: path.join(this.dir, segmentName(event.seq)), size: 0, torn: false };
    }
    const text = cur.torn ? '\n' + line : line;
    fs.appendFileSync(cur.file, text);
    cur.size += Buffer.byteLength(text);
    cur.torn = false;
  }
}
