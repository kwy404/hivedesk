// Workspace scoped file access. Every path is checked so nothing can leave the workspace.
import fs from 'node:fs';
import path from 'node:path';

export const MAX_WRITE = 512 * 1024;
export const MAX_READ = 256 * 1024;
const MAX_LIST = 2000;
const SKIP_DIRS = new Set(['node_modules', '.git']);

export class PathError extends Error {
  constructor(message) {
    super(message);
    this.code = 'path_denied';
  }
}

export class Workspace {
  /** @param {string} root absolute folder */
  constructor(root) {
    fs.mkdirSync(root, { recursive: true });
    this.root = fs.realpathSync(root);
  }

  /**
   * Turns a relative path from a worker into an absolute path inside the workspace.
   * Rejects absolute paths, drive letters, UNC paths, `..` escapes, NUL bytes and symlinks that point outside.
   */
  resolve(rel) {
    if (typeof rel !== 'string') throw new PathError('path must be a string');
    let p = rel.trim().replace(/\\/g, '/');
    if (p.includes('\0')) throw new PathError('path contains a NUL byte');
    if (p === '' || p === '.' || p === './') return this.root;
    if (p.startsWith('/') || /^[a-zA-Z]:/.test(p) || p.startsWith('//')) throw new PathError(`absolute paths are not allowed: ${rel}`);
    if (/^~/.test(p)) throw new PathError(`home paths are not allowed: ${rel}`);
    const parts = p.split('/').filter((s) => s !== '' && s !== '.');
    if (parts.some((s) => s === '..')) throw new PathError(`".." is not allowed: ${rel}`);
    if (parts.some((s) => /[<>:"|?*]/.test(s) || /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(s))) {
      throw new PathError(`invalid file name: ${rel}`);
    }
    const abs = path.resolve(this.root, ...parts);
    if (!this.contains(abs)) throw new PathError(`path escapes the workspace: ${rel}`);
    // Follow symlinks on the existing part of the path.
    let probe = abs;
    while (!fs.existsSync(probe) && probe !== this.root) probe = path.dirname(probe);
    const real = fs.realpathSync(probe);
    if (!this.contains(real)) throw new PathError(`path escapes the workspace through a link: ${rel}`);
    return abs;
  }

  contains(abs) {
    const r = path.relative(this.root, abs);
    return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
  }

  rel(abs) {
    return path.relative(this.root, abs).split(path.sep).join('/');
  }

  exists(rel) {
    try { return fs.existsSync(this.resolve(rel)); } catch { return false; }
  }

  list(rel = '.') {
    const start = this.resolve(rel);
    const out = [];
    const walk = (dir) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const e of entries) {
        if (out.length >= MAX_LIST) return;
        const abs = path.join(dir, e.name);
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name)) walk(abs);
        } else if (e.isFile()) {
          out.push({ path: this.rel(abs), bytes: fs.statSync(abs).size });
        }
      }
    };
    if (fs.existsSync(start) && fs.statSync(start).isDirectory()) walk(start);
    return out;
  }

  read(rel) {
    const abs = this.resolve(rel);
    if (!fs.existsSync(abs)) throw Object.assign(new Error(`file not found: ${rel}`), { code: 'not_found' });
    const st = fs.statSync(abs);
    if (!st.isFile()) throw new Error(`not a file: ${rel}`);
    if (st.size > MAX_READ) {
      const fd = fs.openSync(abs, 'r');
      const buf = Buffer.alloc(MAX_READ);
      fs.readSync(fd, buf, 0, MAX_READ, 0);
      fs.closeSync(fd);
      return buf.toString('utf8') + `\n[truncated: ${st.size} bytes total]`;
    }
    return fs.readFileSync(abs, 'utf8');
  }

  /** @returns {{ before: string | null, after: string }} */
  write(rel, content) {
    if (typeof content !== 'string') throw new Error('content must be a string');
    if (Buffer.byteLength(content) > MAX_WRITE) throw new Error(`file too large (max ${MAX_WRITE} bytes)`);
    const abs = this.resolve(rel);
    if (abs === this.root) throw new PathError('cannot write the workspace root');
    const before = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    return { before, after: content };
  }

  /** Search and replace. `search` must appear exactly once unless `all` is set. */
  edit(rel, search, replace, all = false) {
    if (typeof search !== 'string' || search === '') throw new Error('search must be a non empty string');
    const before = this.read(rel);
    const count = before.split(search).length - 1;
    if (count === 0) throw new Error(`search text not found in ${rel}`);
    if (count > 1 && !all) throw new Error(`search text appears ${count} times in ${rel}; make it unique or set all`);
    const after = all ? before.split(search).join(replace) : before.replace(search, () => replace);
    return this.write(rel, after);
  }

  remove(rel) {
    const abs = this.resolve(rel);
    if (abs === this.root) throw new PathError('cannot delete the workspace root');
    if (!fs.existsSync(abs)) throw Object.assign(new Error(`file not found: ${rel}`), { code: 'not_found' });
    if (!fs.statSync(abs).isFile()) throw new Error('only files can be deleted');
    const before = fs.readFileSync(abs, 'utf8');
    fs.unlinkSync(abs);
    return { before };
  }
}
