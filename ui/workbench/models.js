// Project wide JavaScript and TypeScript (PLAN 11.2, problems and symbols): the files of a root
// are fed to the TypeScript worker as models, so imports resolve between files, go to
// definition crosses files and the worker reports problems for files that are not open.
// Capped: at most 2,000 files, 256 KB each, 24 MB in all. A tab adopts the project model of its
// file and gives it back, with the text on disk, when it closes.

import { wb } from './net.js';
import { languageOf } from '/editor/languages.js';
import { pickProjectFiles, CODE_FILE } from './util.js';

const MAX_FILES = 2000;

export class ProjectModels {
  constructor(monaco, uriFor) {
    this.monaco = monaco;
    this.uriFor = uriFor;
    this.fed = new Map(); // uri string -> { root, path }
    this.adopted = new Set();
    this.status = { state: 'off', files: 0, capped: false };
    this.listeners = new Set();
    this.seq = 0;
  }

  onStatus(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _status(s) { this.status = { ...this.status, ...s }; for (const fn of this.listeners) fn(this.status); }

  /** Feeds a root's code files (the workspace by default). Replaces what was fed before. */
  async feed(root = 'ws') {
    const my = ++this.seq;
    this.clear();
    this._status({ state: 'loading', files: 0, capped: false, root });
    let listing;
    try { listing = await wb('wb.fs.files', { root }); } catch (err) { this._status({ state: 'error', error: err.message }); return; }
    if (my !== this.seq) return;
    const { files, capped } = pickProjectFiles(listing.files || []);
    let done = 0;
    const queue = [...files];
    const work = async () => {
      while (queue.length && my === this.seq) {
        const f = queue.shift();
        let r;
        try { r = await wb('wb.fs.read', { root, path: f.path }); } catch { continue; }
        if (my !== this.seq || r.content == null) continue;
        const uri = this.uriFor(this.monaco, root, f.path);
        if (!this.monaco.editor.getModel(uri)) {
          this.monaco.editor.createModel(r.content, languageOf(f.path), uri);
          this.fed.set(uri.toString(), { root, path: f.path });
        }
        done++;
        if (done % 50 === 0) this._status({ files: done });
      }
    };
    await Promise.all([work(), work(), work(), work(), work(), work()]);
    if (my !== this.seq) return;
    this._status({ state: 'ready', files: done, capped: capped || listing.truncated });
  }

  /** A tab takes over the model of its file. Returns true when it was a project model. */
  adopt(uri) {
    const k = uri.toString();
    if (!this.fed.has(k)) return false;
    this.adopted.add(k);
    return true;
  }

  /** The tab closed: the model goes back to the text on disk and stays for the worker. */
  release(uri, diskText) {
    const k = uri.toString();
    this.adopted.delete(k);
    const m = this.monaco.editor.getModel(uri);
    if (!m) return;
    if (!this.fed.has(k)) { m.dispose(); return; }
    if (typeof diskText === 'string' && m.getValue() !== diskText) m.setValue(diskText);
  }

  /** A file changed on disk: keep a project model that no tab holds in step. */
  update(root, path, text) {
    const uri = this.uriFor(this.monaco, root, path);
    const k = uri.toString();
    if (!this.fed.has(k) || this.adopted.has(k)) return;
    const m = this.monaco.editor.getModel(uri);
    if (text == null) { m?.dispose(); this.fed.delete(k); return; }
    if (m && m.getValue() !== text) m.setValue(text);
  }

  /** A new code file appeared. */
  add(root, path, text) {
    if (!CODE_FILE.test(path) || this.status.state !== 'ready' || this.fed.size >= MAX_FILES || typeof text !== 'string') return;
    const uri = this.uriFor(this.monaco, root, path);
    if (this.monaco.editor.getModel(uri)) return;
    this.monaco.editor.createModel(text, languageOf(path), uri);
    this.fed.set(uri.toString(), { root, path });
  }

  isFed(uri) { return this.fed.has(uri.toString()); }

  clear() {
    for (const k of this.fed.keys()) {
      if (this.adopted.has(k)) continue;
      this.monaco.editor.getModel(this.monaco.Uri.parse(k))?.dispose();
    }
    for (const k of [...this.fed.keys()]) if (!this.adopted.has(k)) this.fed.delete(k);
    this._status({ state: 'off', files: 0 });
  }
}
