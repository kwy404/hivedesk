// Where the editor's documents come from.
//   room   the engine's shared documents (src/workbench/docs.js): every window on this machine
//          and every peer with a workspace grant edit the same CRDT, routed by the engine
//   collab Code together in the browser (ui/lend/collab), while such a session runs
//   plain    files of a project root outside the workspace: loaded and saved as they are
// All three give the editor the same handle: text(), savedText, dirty, localEdit(), setText(),
// save(), anchor(), offset() and the 'remote' and 'saved' events.

import { Emitter } from '/lend/core/emitter.js';
import { DocHub } from '/lend/collab/docs.js';
import { collab, COLORS } from '/lend/collab/client.js';
import { wb, onFrame } from './net.js';

const LONG = 15 * 60 * 1000;

export class RoomSession extends Emitter {
  constructor() {
    super();
    this.mode = 'room';
    this.hub = null;
    this.client = null;
    this.list = [];
    this.cursors = new Map();
    this.saved = new Map();
    this.offs = [
      onFrame((f) => this._frame(f)),
      globalThis.hivedesk.on('hello', () => this._reset()),
    ];
  }

  profile() {
    const p = collab.profile || {};
    return { name: p.name || 'You', color: COLORS.includes(p.color) ? p.color : COLORS[0] };
  }

  docs() {
    if (this.hub) return this.hub;
    const hub = new DocHub({
      client: 'pending',
      transport: {
        load: async (path) => {
          const r = await wb('wb.doc.open', { path, ...this.profile() });
          hub.client = r.client;
          this.client = r.client;
          this.saved.set(path, r.saved);
          return { snap: r.snap };
        },
        send: (path, ops) => { wb('wb.doc.ops', { path, ops }).catch((err) => this.emit('error', err)); },
        save: (path) => wb('wb.doc.save', { path }, { timeout: LONG }),
      },
    });
    hub.on('opened', (h) => {
      if (this.saved.has(h.path)) h.savedText = this.saved.get(h.path);
    });
    this.hub = hub;
    return hub;
  }

  async _handle(path) {
    return this.hub ? this.hub.peek(path) : null;
  }

  async _frame(f) {
    const d = f.data || {};
    switch (f.type) {
      case 'doc.ops': {
        const h = await this.hub?.receive(d.path, d.ops, d.from);
        if (h && typeof d.saved === 'string') {
          h.savedText = d.saved;
          h.emit('saved', d.saved);
        }
        break;
      }
      case 'doc.saved': {
        const h = await this._handle(d.path);
        if (h && typeof d.content === 'string') {
          h.savedText = d.content;
          h.emit('saved', d.content);
        }
        break;
      }
      case 'doc.presence':
        if (d.from === this.client) return;
        if (d.file) this.cursors.set(d.from, { file: d.file, sel: d.sel || [] });
        else this.cursors.delete(d.from);
        this.emit('presence', { from: d.from, file: d.file, sel: d.sel || [] });
        break;
      case 'doc.people':
        this.list = (d.people || []).filter((p) => p && typeof p.id === 'string');
        for (const id of [...this.cursors.keys()]) if (!this.list.some((p) => p.id === id)) this.cursors.delete(id);
        this.emit('people');
        break;
      case 'doc.disk':
        this.emit('disk', d);
        break;
      case 'doc.reset':
      case 'doc.removed':
        this.hub?.docs.delete(d.path);
        this.emit('reset', d);
        break;
      default:
    }
  }

  _reset() {
    // The engine restarted or the connection came back: our documents are gone there.
    if (!this.hub) return;
    this.hub = null;
    this.saved.clear();
    this.cursors.clear();
    this.emit('change', 'room');
  }

  myId() { return this.client || 'me'; }
  canEdit() { return true; }
  people() { return this.list.length > 1 ? this.list : []; }
  presence() { return this.cursors; }
  setPresence(p) { wb('wb.doc.presence', { file: p.file || null, sel: p.sel || [] }).catch(() => {}); }
  close(path) { wb('wb.doc.close', { path }).catch(() => {}); this.hub?.docs.delete(path); }
  reload(path) { return wb('wb.doc.reload', { path }); }
  dispose() { for (const off of this.offs) off?.(); this.offs = []; }
}

/** A file of a root outside the workspace: no CRDT, saved with wb.fs.write. */
export class PlainHandle extends Emitter {
  constructor(root, path, text) {
    super();
    this.root = root;
    this.path = path;
    this._text = text;
    this.savedText = text;
  }
  text() { return this._text; }
  get dirty() { return this._text !== this.savedText; }
  localEdit(at, remove, insert) {
    this._text = this._text.slice(0, at) + insert + this._text.slice(at + remove);
    this.emit('change', { local: true });
  }
  setText(text, from = 'disk') {
    if (text === this._text) return false;
    const old = this._text;
    this._text = text;
    this.emit('remote', [{ at: 0, remove: old.length, insert: text }], from);
    return true;
  }
  async save() {
    const content = this._text;
    await wb('wb.fs.write', { root: this.root, path: this.path, content }, { timeout: LONG });
    this.savedText = content;
    this.emit('saved', content);
    return content;
  }
  anchor(offset) { return [String(offset), 0]; }
  offset(a) { return Number(a?.[0]) || 0; }
}

/** The session for workspace files right now: Code together when it runs, else the engine room. */
export function sessionFor(room) {
  return collab.mode !== 'solo' ? collab : room;
}

export { collab };
