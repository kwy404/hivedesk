// Shared documents in the engine (PLAN 11.2, live collaborative editing over p2p sessions).
// The engine holds one CRDT per open file (the RGA of ui/lend/collab/crdt.js, pure and shared
// with the browser) and routes edits between the windows on this machine and peers:
//   workspace.read      a peer may open a document, receive edits and send its cursor
//   workspace.propose   a peer may also send edits; its saves go through host approval
// Every replica writes inserts only under the client id this room gave it, so nobody can
// forge another person's characters.
import { TextDoc, diffText, readOps } from '../../ui/lend/collab/crdt.js';
import { WorkbenchError } from './origin.js';
import { relPath } from './fs.js';

export const MAX_DOC_BYTES = 512 * 1024;
const MAX_DOCS = 64;
const anchor = (a) => (a === null || (Array.isArray(a) && a.length === 2 && typeof a[0] === 'string' && a[0].length <= 24 && Number.isInteger(a[1]) && a[1] >= 0) ? a : undefined);

export class DocRoom {
  /**
   * @param {{
   *   read: (path: string) => string | null,
   *   write: (path: string, content: string, sub: object) => Promise<void>,
   * }} o
   */
  constructor(o) {
    this.o = o;
    this.docs = new Map(); // path -> { doc, saved, subs: Set }
    this.subs = new Map(); // sub id -> sub
    this.seq = 0;
  }

  /**
   * Adds a subscriber: a local window or a peer session.
   * @param {{ id: string, kind: 'local' | 'peer', peerId?: string, name?: string, color?: string, canEdit: boolean, send: (type: string, data: object) => void }} s
   */
  join(s) {
    const existing = this.subs.get(s.id);
    if (existing) return existing;
    const client = s.kind === 'peer' ? `p${++this.seq}` : `l${++this.seq}`;
    const sub = { ...s, client, files: new Set(), presence: null };
    this.subs.set(s.id, sub);
    return sub;
  }

  leave(id) {
    const sub = this.subs.get(id);
    if (!sub) return;
    for (const p of [...sub.files]) this.close(sub, p);
    this.subs.delete(id);
  }

  people() {
    return [...this.subs.values()].map((s) => ({ id: s.client, name: s.name || (s.kind === 'peer' ? 'Peer' : 'You'), color: s.color || '#f2a93b', kind: s.kind, peerId: s.peerId, canEdit: s.canEdit, file: s.presence?.file || null }));
  }

  _broadcast(path, type, data, except) {
    const d = this.docs.get(path);
    if (!d) return;
    for (const s of d.subs) {
      if (s === except) continue;
      try { s.send(type, data); } catch { /* that subscriber is gone */ }
    }
  }

  _peopleChanged() {
    const people = this.people();
    for (const s of this.subs.values()) { try { s.send('doc.people', { people }); } catch { /* gone */ } }
  }

  open(sub, file) {
    const path = relPath(file);
    if (!path) throw new WorkbenchError('bad_request', 'a path is required');
    let d = this.docs.get(path);
    if (!d) {
      if (this.docs.size >= MAX_DOCS) throw new WorkbenchError('busy', 'too many shared documents are open');
      const text = this.o.read(path) ?? '';
      if (Buffer.byteLength(text) > MAX_DOC_BYTES) throw new WorkbenchError('bad_request', 'this file is too large to edit together (max 512 KB)');
      d = { doc: TextDoc.fromText(text, 'e0'), saved: text, subs: new Set() };
      this.docs.set(path, d);
    }
    d.subs.add(sub);
    sub.files.add(path);
    this._peopleChanged();
    return { path, snap: d.doc.snapshot(), saved: d.saved, client: sub.client, canEdit: sub.canEdit };
  }

  close(sub, file) {
    const path = relPath(file);
    const d = this.docs.get(path);
    sub.files.delete(path);
    if (!d) return;
    d.subs.delete(sub);
    if (!d.subs.size) this.docs.delete(path);
    if (sub.presence?.file === path) sub.presence = null;
    this._peopleChanged();
  }

  ops(sub, file, raw) {
    if (!sub.canEdit) throw new WorkbenchError('not_granted', 'you can view this document but not edit it');
    const path = relPath(file);
    const d = this.docs.get(path);
    if (!d || !d.subs.has(sub)) throw new WorkbenchError('not_found', 'open the document first');
    let ops;
    try { ops = readOps(raw); } catch (err) { throw new WorkbenchError('bad_request', `bad edit: ${err.message}`); }
    for (const op of ops) if (op.i && op.i[0] !== sub.client) throw new WorkbenchError('forbidden', 'an edit used another person\'s id');
    d.doc.apply(ops);
    if (Buffer.byteLength(d.doc.text()) > MAX_DOC_BYTES * 2) {
      // Far too big for a source file: undo is not possible in an RGA, so reload everyone from disk.
      this._reset(path, d.saved);
      throw new WorkbenchError('bad_request', 'the document grew too large and was reloaded');
    }
    this._broadcast(path, 'doc.ops', { path, ops, from: sub.client }, sub);
    return { path };
  }

  presence(sub, file, sel) {
    const path = file ? relPath(file) : null;
    const list = Array.isArray(sel) ? sel.slice(0, 8).map((s) => ({ a: anchor(s?.a), h: anchor(s?.h) })).filter((s) => s.a !== undefined && s.h !== undefined) : [];
    sub.presence = { file: path, sel: list };
    for (const s of this.subs.values()) {
      if (s === sub) continue;
      try { s.send('doc.presence', { from: sub.client, file: path, sel: list }); } catch { /* gone */ }
    }
    return {};
  }

  async save(sub, file) {
    const path = relPath(file);
    const d = this.docs.get(path);
    if (!d || !d.subs.has(sub)) throw new WorkbenchError('not_found', 'open the document first');
    if (!sub.canEdit) throw new WorkbenchError('not_granted', 'you cannot save this document');
    const content = d.doc.text();
    await this.o.write(path, content, sub);
    d.saved = content;
    this._broadcast(path, 'doc.saved', { path, content, by: sub.client });
    return { path, bytes: Buffer.byteLength(content) };
  }

  /**
   * The file changed on disk (the crew, or the explorer). A clean document takes the new text
   * as one edit by the engine; a document with unsaved edits keeps them and everyone is told.
   */
  fileChanged(file, content, { by } = {}) {
    const path = relPath(file);
    const d = this.docs.get(path);
    if (!d || typeof content !== 'string') return false;
    const cur = d.doc.text();
    if (cur === content) { d.saved = content; return false; }
    if (cur !== d.saved) {
      this._broadcast(path, 'doc.disk', { path, by: by || null });
      return false;
    }
    const diff = diffText(cur, content);
    const ops = d.doc.edit(diff.at, diff.remove, diff.insert);
    d.saved = content;
    this._broadcast(path, 'doc.ops', { path, ops, from: 'e0', saved: content });
    return true;
  }

  /** A person chose "load theirs": replace the text with the disk text for everyone. */
  reload(sub, file) {
    const path = relPath(file);
    const d = this.docs.get(path);
    if (!d || !d.subs.has(sub)) throw new WorkbenchError('not_found', 'open the document first');
    const disk = this.o.read(path) ?? '';
    const diff = diffText(d.doc.text(), disk);
    d.saved = disk;
    if (diff) {
      const ops = d.doc.edit(diff.at, diff.remove, diff.insert);
      this._broadcast(path, 'doc.ops', { path, ops, from: 'e0', saved: disk });
    } else this._broadcast(path, 'doc.saved', { path, content: disk, by: 'e0' });
    return { path };
  }

  _reset(path, text) {
    const d = this.docs.get(path);
    if (!d) return;
    d.doc = TextDoc.fromText(text, 'e0');
    d.saved = text;
    this._broadcast(path, 'doc.reset', { path, snap: d.doc.snapshot(), saved: text });
  }

  fileRemoved(file) {
    const path = relPath(file);
    if (this.docs.has(path)) this._broadcast(path, 'doc.removed', { path });
  }
}
