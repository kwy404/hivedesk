// File operations for the explorer: list, read, write, create folder, rename or move, delete.
// Every path goes through Workspace.resolve (src/tools/workspace.js), so the rules the crew
// lives by apply here too: no absolute paths, no "..", no .git, no device names, no link that
// leaves the root.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Workspace, PathError } from '../tools/workspace.js';
import { WorkbenchError } from './origin.js';
import { skipDir } from './glob.js';
import { walkFiles, MAX_SEARCH_BYTES } from './walk.js';

export const MAX_EDIT_BYTES = 2 * 1024 * 1024;
const MAX_LIST = 5000;

export const sha1 = (text) => crypto.createHash('sha1').update(text).digest('hex');

/** Normalizes a relative path the way the tools do. */
export function relPath(p) {
  const s = String(p ?? '').trim().replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
  return s === '.' ? '' : s;
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export class Root {
  /**
   * @param {{ id: string, name: string, path: string, workspace?: Workspace, isWorkspace?: boolean }} o
   */
  constructor(o) {
    this.id = o.id;
    this.name = o.name;
    this.isWorkspace = !!o.isWorkspace;
    if (o.workspace) this.ws = o.workspace;
    else {
      if (!fs.existsSync(o.path) || !fs.statSync(o.path).isDirectory()) throw new WorkbenchError('not_found', `the folder does not exist: ${o.path}`);
      this.ws = new Workspace(o.path);
    }
    this.path = this.ws.root;
  }

  info() {
    return { id: this.id, name: this.name, path: this.path, workspace: this.isWorkspace };
  }

  resolve(rel) {
    try {
      return this.ws.resolve(relPath(rel));
    } catch (err) {
      if (err instanceof PathError) throw new WorkbenchError('bad_request', err.message);
      throw err;
    }
  }

  /** The children of one folder, folders first. */
  list(dir = '') {
    const abs = this.resolve(dir);
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch (err) {
      if (err.code === 'ENOENT') throw new WorkbenchError('not_found', `no such folder: ${dir || '.'}`);
      if (err.code === 'ENOTDIR') throw new WorkbenchError('bad_request', `not a folder: ${dir}`);
      throw err;
    }
    const base = relPath(dir);
    const out = [];
    for (const e of entries) {
      if (out.length >= MAX_LIST) break;
      if (/^\.git$/i.test(e.name) && !base) continue;
      const rel = base ? `${base}/${e.name}` : e.name;
      if (e.isSymbolicLink()) { out.push({ name: e.name, path: rel, type: 'link' }); continue; }
      if (e.isDirectory()) out.push({ name: e.name, path: rel, type: 'dir', heavy: skipDir(e.name) || undefined });
      else if (e.isFile()) {
        let bytes = 0;
        try { bytes = fs.statSync(path.join(abs, e.name)).size; } catch { /* gone */ }
        out.push({ name: e.name, path: rel, type: 'file', bytes });
      }
    }
    out.sort((a, b) => (a.type === 'dir') !== (b.type === 'dir') ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
    return { dir: base, entries: out, truncated: entries.length > MAX_LIST };
  }

  /** Every file, with the ignore rules (quick open, project diagnostics). */
  files(o = {}) {
    const r = walkFiles(this.path, { maxFiles: o.maxFiles ?? 20000, exclude: o.exclude });
    return { files: r.files.map((f) => ({ path: f.rel, bytes: f.bytes })), truncated: r.truncated };
  }

  stat(rel) {
    const abs = this.resolve(rel);
    try {
      const st = fs.lstatSync(abs);
      return { abs, type: st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other', bytes: st.size, mtimeMs: st.mtimeMs };
    } catch (err) {
      if (err.code === 'ENOENT') return { abs, type: null };
      throw err;
    }
  }

  /** Reads a text file up to 2 MB. Larger or binary files are reported, not read. */
  read(rel) {
    const p = relPath(rel);
    const st = this.stat(p);
    if (!st.type) throw new WorkbenchError('not_found', `file not found: ${p}`);
    if (st.type !== 'file') throw new WorkbenchError('bad_request', `not a file: ${p}`);
    if (st.bytes > MAX_EDIT_BYTES) return { path: p, bytes: st.bytes, tooLarge: true, content: null };
    const buf = fs.readFileSync(st.abs);
    if (looksBinary(buf)) return { path: p, bytes: st.bytes, binary: true, content: null };
    const content = buf.toString('utf8');
    return { path: p, bytes: st.bytes, content, sha: sha1(content), mtimeMs: st.mtimeMs };
  }

  /** @returns {{ before: string | null }} */
  write(rel, content) {
    const p = relPath(rel);
    if (!p) throw new WorkbenchError('bad_request', 'a file path is required');
    if (typeof content !== 'string') throw new WorkbenchError('bad_request', 'content must be text');
    if (Buffer.byteLength(content) > MAX_EDIT_BYTES) throw new WorkbenchError('bad_request', 'file too large (max 2 MB)');
    const st = this.stat(p);
    if (st.type && st.type !== 'file') throw new WorkbenchError('conflict', `${p} is a folder`);
    const before = st.type === 'file' && st.bytes <= MAX_EDIT_BYTES ? fs.readFileSync(st.abs, 'utf8') : null;
    fs.mkdirSync(path.dirname(st.abs), { recursive: true });
    fs.writeFileSync(st.abs, content);
    return { before };
  }

  mkdir(rel) {
    const p = relPath(rel);
    if (!p) throw new WorkbenchError('bad_request', 'a folder path is required');
    const st = this.stat(p);
    if (st.type) throw new WorkbenchError('conflict', `${p} already exists`);
    fs.mkdirSync(st.abs, { recursive: true });
    return { path: p };
  }

  /**
   * Renames or moves a file or folder inside the root. The target must not exist.
   * @returns {{ from: string, to: string, type: 'file' | 'dir', moved: Array<{ from: string, to: string }> }}
   */
  rename(fromRel, toRel) {
    const from = relPath(fromRel);
    const to = relPath(toRel);
    if (!from || !to) throw new WorkbenchError('bad_request', 'both paths are required');
    if (from === to) throw new WorkbenchError('bad_request', 'the new name is the same');
    const a = this.stat(from);
    if (!a.type) throw new WorkbenchError('not_found', `not found: ${from}`);
    if (a.type === 'link' || a.type === 'other') throw new WorkbenchError('bad_request', `only files and folders can be moved: ${from}`);
    const b = this.stat(to);
    const caseOnly = b.type && process.platform !== 'linux' && from.toLowerCase() === to.toLowerCase();
    if (b.type && !caseOnly) throw new WorkbenchError('conflict', `${to} already exists`);
    if (a.type === 'dir' && (to + '/').startsWith(from + '/')) throw new WorkbenchError('bad_request', 'a folder cannot move into itself');
    const moved = a.type === 'dir' ? this._filesUnder(from).map((f) => ({ from: f, to: to + f.slice(from.length) })) : [{ from, to }];
    fs.mkdirSync(path.dirname(b.abs), { recursive: true });
    fs.renameSync(a.abs, b.abs);
    return { from, to, type: a.type, moved };
  }

  /**
   * Deletes a file, an empty folder, or (with recursive) a folder and everything in it.
   * @returns {{ path: string, type: string, removed: string[] }}
   */
  remove(rel, { recursive = false } = {}) {
    const p = relPath(rel);
    if (!p) throw new WorkbenchError('bad_request', 'the root itself cannot be deleted');
    const st = this.stat(p);
    if (!st.type) throw new WorkbenchError('not_found', `not found: ${p}`);
    if (st.type === 'dir') {
      const inside = fs.readdirSync(st.abs);
      if (inside.length && !recursive) throw new WorkbenchError('not_empty', `${p} is not empty`);
      const removed = this._filesUnder(p);
      fs.rmSync(st.abs, { recursive: true, force: false, maxRetries: 2 });
      return { path: p, type: 'dir', removed };
    }
    fs.rmSync(st.abs, { force: false });
    return { path: p, type: st.type, removed: [p] };
  }

  /** Counts what a recursive delete would remove (shown in the confirm dialog). */
  countUnder(rel) {
    const st = this.stat(rel);
    if (st.type !== 'dir') return { files: st.type ? 1 : 0, folders: 0 };
    let files = 0;
    let folders = 0;
    const walk = (abs) => {
      for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
        if (e.isDirectory() && !e.isSymbolicLink()) { folders++; walk(path.join(abs, e.name)); } else files++;
        if (files > 100000) return;
      }
    };
    walk(st.abs);
    return { files, folders };
  }

  _filesUnder(rel) {
    const st = this.stat(rel);
    if (st.type !== 'dir') return [];
    const out = [];
    const walk = (abs, r) => {
      for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
        const child = `${r}/${e.name}`;
        if (e.isDirectory() && !e.isSymbolicLink()) walk(path.join(abs, e.name), child);
        else if (e.isFile()) out.push(child);
        if (out.length > 20000) return;
      }
    };
    walk(st.abs, relPath(rel));
    return out;
  }
}

export { MAX_SEARCH_BYTES };
