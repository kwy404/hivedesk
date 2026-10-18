// The hash chained audit log (PLAN 1.4): <home>/audit/<yyyy-mm>.jsonl, append only, one line
// per entry { seq, ts, prevHash, hash, entry }, hash = sha256(canonical({ seq, ts, prevHash, entry })).
// The chain runs across the monthly files. Entries hold who did what and counts, never secrets:
// no invite words, no keys, no prompt text (callers pass only such fields; long strings are cut).

import fs from 'node:fs';
import path from 'node:path';
import { canonical } from './encoding.js';
import { sha256 } from './primitives.js';

export const GENESIS = '0'.repeat(64);
const MAX_ENTRY = 4096;
const FILE_RE = /^\d{4}-\d{2}\.jsonl$/;

const hashOf = (seq, ts, prevHash, entry) => sha256(canonical({ seq, ts, prevHash, entry })).toString('hex');

/** Copies an entry into plain JSON: strings cut to 200 chars, depth 4, functions and keys dropped. */
function cleanEntry(value, depth = 0) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return value.slice(0, 200);
  if (depth > 4 || typeof value !== 'object') return null;
  if (Array.isArray(value)) return value.slice(0, 32).map((v) => cleanEntry(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value).slice(0, 32)) {
    if (v === undefined || typeof v === 'function') continue;
    if (/^(words|phrase|psk|key|privateKey|secret|prompt|messages|text)$/i.test(k)) continue;
    out[k.slice(0, 40)] = cleanEntry(v, depth + 1);
  }
  return out;
}

export class AuditLog {
  /** @param {{ dir: string, now?: () => number, readOnly?: boolean }} opts readOnly: for the doctor, no repair and no append */
  constructor({ dir, now = () => Date.now(), readOnly = false }) {
    this.dir = dir;
    this.now = now;
    this.seq = 0;
    this.lastHash = GENESIS;
    this.repaired = null;
    this.readOnly = readOnly;
    if (readOnly) return;
    fs.mkdirSync(dir, { recursive: true });
    this._loadTail();
  }

  files() {
    try {
      return fs.readdirSync(this.dir).filter((f) => FILE_RE.test(f)).sort();
    } catch {
      return [];
    }
  }

  _loadTail() {
    const files = this.files();
    for (let i = files.length - 1; i >= 0; i--) {
      const file = path.join(this.dir, files[i]);
      const text = fs.readFileSync(file, 'utf8');
      if (!text) continue;
      // A crash while appending can leave a torn last line. Drop it so the chain stays linear.
      if (!text.endsWith('\n')) {
        const keep = text.slice(0, text.lastIndexOf('\n') + 1);
        fs.writeFileSync(file, keep);
        this.repaired = { file: files[i], droppedBytes: text.length - keep.length };
        if (!keep) continue;
        return this._fromLine(keep.trimEnd().split('\n').pop());
      }
      return this._fromLine(text.trimEnd().split('\n').pop());
    }
  }

  _fromLine(line) {
    const rec = JSON.parse(line);
    this.seq = rec.seq;
    this.lastHash = rec.hash;
  }

  /** Appends one entry and returns the record. Entry is { type, ... } with counts and ids only. */
  append(entry) {
    if (this.readOnly) throw new Error('this audit log was opened read only');
    const clean = cleanEntry(entry);
    if (!clean || typeof clean.type !== 'string') throw new TypeError('an audit entry needs a type');
    let text = canonical(clean);
    if (text.length > MAX_ENTRY) {
      text = canonical({ type: clean.type, truncated: true });
    }
    const body = JSON.parse(text);
    const seq = this.seq + 1;
    const ts = new Date(this.now()).toISOString();
    const prevHash = this.lastHash;
    const hash = hashOf(seq, ts, prevHash, body);
    const rec = { seq, ts, prevHash, hash, entry: body };
    fs.appendFileSync(path.join(this.dir, `${ts.slice(0, 7)}.jsonl`), JSON.stringify(rec) + '\n');
    this.seq = seq;
    this.lastHash = hash;
    return rec;
  }

  /** Every record, oldest first (for export and verify). */
  *records() {
    for (const f of this.files()) {
      const lines = fs.readFileSync(path.join(this.dir, f), 'utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i]) continue;
        yield { file: f, line: i + 1, text: lines[i] };
      }
    }
  }

  /** Walks the whole chain. Returns { ok, count, lastHash } or { ok: false, at, reason }. */
  verify() {
    let prev = GENESIS;
    let seq = 0;
    let count = 0;
    for (const r of this.records()) {
      let rec;
      try {
        rec = JSON.parse(r.text);
      } catch {
        return { ok: false, count, at: `${r.file}:${r.line}`, reason: 'unreadable line' };
      }
      if (rec.seq !== seq + 1) return { ok: false, count, at: `${r.file}:${r.line}`, reason: `sequence jumps from ${seq} to ${rec.seq}` };
      if (rec.prevHash !== prev) return { ok: false, count, at: `${r.file}:${r.line}`, reason: 'previous hash does not match' };
      if (hashOf(rec.seq, rec.ts, rec.prevHash, rec.entry) !== rec.hash) return { ok: false, count, at: `${r.file}:${r.line}`, reason: 'entry was changed' };
      prev = rec.hash;
      seq = rec.seq;
      count++;
    }
    return { ok: true, count, lastHash: prev };
  }

  /** The last n records, newest last. */
  tail(n = 50) {
    const out = [];
    const files = this.files();
    for (let i = files.length - 1; i >= 0 && out.length < n; i--) {
      const lines = fs.readFileSync(path.join(this.dir, files[i]), 'utf8').trimEnd().split('\n').filter(Boolean);
      for (let j = lines.length - 1; j >= 0 && out.length < n; j--) {
        try {
          out.push(JSON.parse(lines[j]));
        } catch { /* reported by verify */ }
      }
    }
    return out.reverse();
  }
}
