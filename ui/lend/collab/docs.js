// Shared documents for Code together. One DocHub per browser:
//   host   the documents live here; files load from the host's engine and save through it
//   guest  the documents come from the host (doc.state) and every save goes through the host
//   solo   no session: the same API, so the editor has one code path
// A DocHandle is what the editor binds to: localEdit() for the person typing here, a 'remote'
// event with the changes to apply when someone else (or the crew) changed the text.

import { Emitter } from '../core/emitter.js';
import { TextDoc, diffText } from './crdt.js';

export class DocHandle extends Emitter {
  constructor(hub, path, doc) {
    super();
    this.hub = hub;
    this.path = path;
    this.doc = doc;
    this.savedText = doc.text();
  }

  text() {
    return this.doc.text();
  }

  get dirty() {
    return this.doc.text() !== this.savedText;
  }

  /** The person here typed: replace `remove` chars at `at` with `insert`. */
  localEdit(at, remove, insert) {
    const ops = this.doc.edit(at, remove, insert);
    if (ops.length) this.hub._send(this.path, ops, null);
    this.emit('change', { local: true });
  }

  /** Ops from elsewhere. Emits 'remote' with the visible changes for the editor. */
  applyRemote(ops, from) {
    const changes = this.doc.apply(ops);
    if (changes.length) {
      this.emit('remote', changes, from);
      this.emit('change', { local: false, from });
    }
    return changes;
  }

  /**
   * Makes the text equal to `text` as one edit by this replica (the crew wrote the file, or a
   * hunk was rejected). The editor here gets it as a remote change, the others as ops.
   */
  setText(text, from = 'crew') {
    const d = diffText(this.doc.text(), text);
    if (!d) return false;
    const ops = this.doc.edit(d.at, d.remove, d.insert);
    this.hub._send(this.path, ops, null);
    this.emit('remote', [{ at: d.at, remove: d.remove, insert: d.insert }], from);
    this.emit('change', { local: false, from });
    return true;
  }

  /** Saves the current text through the host's engine. */
  async save() {
    const content = this.doc.text();
    this.saving = content;
    try {
      await this.hub.transport.save(this.path, content);
    } finally {
      this.saving = null;
    }
    this.savedText = content;
    this.emit('saved', content);
    return content;
  }

  /** CRDT anchors for editor offsets (presence travels as anchors, so it survives edits). */
  anchor(offset) {
    return this.doc.anchorAt(offset);
  }

  offset(anchor) {
    return this.doc.offsetOf(anchor);
  }
}

/**
 * transport: {
 *   load(path) => Promise<{ text } | { snap }>,
 *   send(path, ops, from),          ops made here (or relayed by the host)
 *   save(path, content) => Promise,
 * }
 */
export class DocHub extends Emitter {
  constructor({ client, transport }) {
    super();
    this.client = client;
    this.transport = transport;
    this.docs = new Map(); // path -> Promise<DocHandle>
  }

  open(path) {
    if (!this.docs.has(path)) {
      const p = this.transport.load(path).then((r) => {
        const doc = r.snap ? TextDoc.fromSnapshot(r.snap, this.client) : TextDoc.fromText(r.text || '', this.client);
        const h = new DocHandle(this, path, doc);
        this.emit('opened', h);
        return h;
      });
      p.catch(() => this.docs.delete(path));
      this.docs.set(path, p);
    }
    return this.docs.get(path);
  }

  /** The handle when it is already loaded, else null. */
  async peek(path) {
    return this.docs.has(path) ? this.docs.get(path).catch(() => null) : null;
  }

  isOpen(path) {
    return this.docs.has(path);
  }

  _send(path, ops, from) {
    this.transport.send(path, ops, from);
  }

  /** Ops from someone else for a document. Ignored when it is not open here. */
  async receive(path, ops, from) {
    const h = await this.peek(path);
    if (!h) return null;
    h.applyRemote(ops, from);
    return h;
  }

  close() {
    this.docs.clear();
  }
}
