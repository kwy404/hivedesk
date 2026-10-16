// A small text CRDT for Code together (RGA: replicated growable array).
//
// Every character gets a unique id [client, clock] from a Lamport clock. An insert names the id
// of the character it goes after (its origin, or null for the start). To place it, a replica
// starts right after the origin and skips every character with a greater id (a higher clock, or
// the same clock and a greater client). That rule gives every replica the same order no matter
// in which order concurrent inserts arrive. Deletes only mark characters as gone (tombstones),
// so later inserts can still name them as origins.
//
// Ops:
//   { i: [client, clock], o: [client, clock] | null, s: 'text' }  insert s, char n gets clock + n
//   { d: [[client, clock, length], ...] }                          delete those ids
// An op whose origin or target is not known yet waits until it is (causal delivery).

const key = (c, k) => `${c}\u0001${k}`;

/** True when id a orders before id b among siblings: greater clock first, then greater client. */
const greater = (a, b) => a.k > b.k || (a.k === b.k && a.c > b.c);

export class TextDoc {
  /** client: a short string unique in the session (the host gives every guest one). */
  constructor(client) {
    if (!client || typeof client !== 'string') throw new TypeError('A TextDoc needs a client id');
    this.client = client;
    this.clock = 0;
    this.items = []; // { c, k, ch, del }
    this.byId = new Map();
    this.waiting = []; // ops that arrived before what they depend on
    this.visible = 0;
  }

  /** A document that starts with text, created by one client (usually the host). */
  static fromText(text, client) {
    const doc = new TextDoc(client);
    if (text) doc.edit(0, 0, text);
    return doc;
  }

  /** The visible text. */
  text() {
    let out = '';
    for (const it of this.items) if (!it.del) out += it.ch;
    return out;
  }

  get length() {
    return this.visible;
  }

  /** Array position of the item at visible offset `at` (the first visible item at or after it). */
  _posOfOffset(at) {
    let seen = 0;
    for (let p = 0; p < this.items.length; p++) {
      if (this.items[p].del) continue;
      if (seen === at) return p;
      seen++;
    }
    return this.items.length;
  }

  /** Id of the visible character just before offset `at`, or null at the start. */
  _originAt(at) {
    if (at <= 0) return null;
    let seen = 0;
    for (const it of this.items) {
      if (it.del) continue;
      seen++;
      if (seen === at) return [it.c, it.k];
    }
    const last = this.items[this.items.length - 1];
    return last ? [last.c, last.k] : null;
  }

  /** Visible offset of the item at array position p (deleted items count as the next visible spot). */
  _offsetOfPos(p) {
    let n = 0;
    for (let i = 0; i < p && i < this.items.length; i++) if (!this.items[i].del) n++;
    return n;
  }

  /**
   * A local edit: replace `remove` characters at visible offset `at` with `insert`.
   * Applies it here and returns the ops to send to the others.
   */
  edit(at, remove, insert = '') {
    at = Math.max(0, Math.min(at | 0, this.visible));
    remove = Math.max(0, Math.min(remove | 0, this.visible - at));
    const ops = [];
    if (remove > 0) {
      const ranges = [];
      let seen = 0;
      for (const it of this.items) {
        if (it.del) continue;
        if (seen >= at && seen < at + remove) {
          const last = ranges[ranges.length - 1];
          if (last && last[0] === it.c && last[1] + last[2] === it.k) last[2]++;
          else ranges.push([it.c, it.k, 1]);
        }
        seen++;
        if (seen >= at + remove) break;
      }
      const op = { d: ranges };
      this._applyDelete(op);
      ops.push(op);
    }
    if (insert) {
      const op = { i: [this.client, this.clock + 1], o: this._originAt(at), s: String(insert) };
      this._applyInsert(op);
      ops.push(op);
    }
    return ops;
  }

  _known(id) {
    return id === null || this.byId.has(key(id[0], id[1]));
  }

  _ready(op) {
    if (op.s !== undefined) return this._known(op.o);
    return op.d.every(([c, k, n]) => {
      for (let j = 0; j < n; j++) if (!this.byId.has(key(c, k + j))) return false;
      return true;
    });
  }

  /**
   * Applies ops from another replica. Returns the visible changes, in order, for an editor:
   * [{ at, remove, insert }] where each change applies to the text left by the previous one.
   */
  apply(ops) {
    const changes = [];
    this.waiting.push(...ops);
    let progress = true;
    while (progress && this.waiting.length) {
      progress = false;
      for (let w = 0; w < this.waiting.length; w++) {
        const op = this.waiting[w];
        if (!this._ready(op)) continue;
        this.waiting.splice(w, 1);
        w--;
        progress = true;
        if (op.s !== undefined) {
          const ch = this._applyInsert(op);
          if (ch) changes.push(ch);
        } else changes.push(...this._applyDelete(op));
      }
    }
    return changes;
  }

  _applyInsert(op) {
    const [c, k0] = op.i;
    if (this.byId.has(key(c, k0))) return null; // a duplicate
    let p = op.o ? this.items.indexOf(this.byId.get(key(op.o[0], op.o[1]))) + 1 : 0;
    const first = { c, k: k0 };
    while (p < this.items.length && greater(this.items[p], first)) p++;
    const at = this._offsetOfPos(p);
    const added = [];
    for (let n = 0; n < op.s.length; n++) {
      const it = { c, k: k0 + n, ch: op.s[n], del: false };
      added.push(it);
      this.byId.set(key(c, it.k), it);
    }
    // The characters of one insert are always adjacent: nobody could name them as an origin yet.
    this.items.splice(p, 0, ...added);
    this.visible += added.length;
    this.clock = Math.max(this.clock, k0 + op.s.length - 1);
    return { at, remove: 0, insert: op.s };
  }

  _applyDelete(op) {
    const changes = [];
    for (const [c, k, n] of op.d) {
      for (let j = 0; j < n; j++) {
        const it = this.byId.get(key(c, k + j));
        if (!it || it.del) continue;
        const at = this._offsetOfPos(this.items.indexOf(it));
        it.del = true;
        this.visible--;
        const last = changes[changes.length - 1];
        if (last && last.at === at) last.remove++;
        else changes.push({ at, remove: 1, insert: '' });
      }
    }
    return changes;
  }

  /** A stable reference to a visible offset: the id of the char there, or null for the end. */
  anchorAt(offset) {
    const p = this._posOfOffset(Math.max(0, offset | 0));
    const it = this.items[p];
    return it ? [it.c, it.k] : null;
  }

  /** The visible offset of an anchor (a deleted char resolves to where it was). */
  offsetOf(anchor) {
    if (!anchor) return this.visible;
    const it = this.byId.get(key(anchor[0], anchor[1]));
    if (!it) return this.visible;
    return this._offsetOfPos(this.items.indexOf(it));
  }

  /** The whole state, for a guest who opens the document: runs of [client, clock, text | length, deleted?]. */
  snapshot() {
    const runs = [];
    let last = null;
    for (const it of this.items) {
      if (last && last[0] === it.c && last[1] + last.len === it.k && !!last[4] === it.del) {
        last.len++;
        if (!it.del) last[2] += it.ch;
        continue;
      }
      last = [it.c, it.k, it.del ? 0 : it.ch];
      last.len = 1;
      if (it.del) last[4] = 1;
      runs.push(last);
    }
    return {
      clock: this.clock,
      runs: runs.map((r) => (r[4] ? [r[0], r[1], r.len, 1] : [r[0], r[1], r[2]])),
    };
  }

  static fromSnapshot(snap, client) {
    const doc = new TextDoc(client);
    for (const r of snap.runs || []) {
      const [c, k, body, del] = r;
      const len = del ? body : body.length;
      for (let n = 0; n < len; n++) {
        const it = { c: String(c), k: k + n, ch: del ? '' : body[n], del: !!del };
        doc.items.push(it);
        doc.byId.set(key(it.c, it.k), it);
        if (!it.del) doc.visible++;
      }
    }
    doc.clock = Math.max(snap.clock | 0, ...doc.items.map((it) => it.k));
    return doc;
  }
}

/** The smallest single edit that turns a into b: { at, remove, insert }, or null when equal. */
export function diffText(a, b) {
  if (a === b) return null;
  let start = 0;
  const max = Math.min(a.length, b.length);
  while (start < max && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  return { at: start, remove: endA - start, insert: b.slice(start, endB) };
}

/** Checks the shape of ops from the network. Throws on anything else. */
export function readOps(ops, { maxOps = 500, maxChars = 200000 } = {}) {
  if (!Array.isArray(ops) || ops.length > maxOps) throw new Error('bad ops');
  const id = (v) => Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && v[0].length <= 24 && Number.isInteger(v[1]) && v[1] >= 0;
  let chars = 0;
  return ops.map((op) => {
    if (op && typeof op.s === 'string' && id(op.i) && (op.o === null || id(op.o))) {
      chars += op.s.length;
      if (!op.s.length || chars > maxChars) throw new Error('bad insert');
      return { i: [op.i[0], op.i[1]], o: op.o ? [op.o[0], op.o[1]] : null, s: op.s };
    }
    if (op && Array.isArray(op.d) && op.d.length <= 10000) {
      return { d: op.d.map((r) => {
        if (!Array.isArray(r) || typeof r[0] !== 'string' || r[0].length > 24 || !Number.isInteger(r[1]) || !Number.isInteger(r[2]) || r[1] < 0 || r[2] < 1 || r[2] > maxChars) throw new Error('bad delete');
        return [r[0], r[1], r[2]];
      }) };
    }
    throw new Error('bad op');
  });
}
