// The code workbench, engine side (PLAN section 11): project roots, file operations, search
// and replace, terminals, source control, settings and shared documents. Registered like the
// other plug-ins, with the server's `command` and `route`:
//
//   import('./workbench/index.js').default({ bus, toolbox, approvals, server, config, p2p })
//
// Every command checks its origin first (origin.js). The person at this machine (a token
// holder) may use everything. A peer reaches only the commands with a capability in POLICY,
// only on the workspace root, and only while it holds that grant; its writes always go through
// host approval. Terminals are never reachable by a peer except a terminal the person shared
// with that peer (share.js). Agents never reach the workbench.
//
// Frames to a window use their own kind, { kind: 'wb', type, data }, sent only to the window
// that asked, so they are never relayed to Code together guests with the engine frames.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkbenchError, originOf, POLICY } from './origin.js';
import { SettingsFile } from './settings.js';
import { Root, relPath, MAX_EDIT_BYTES } from './fs.js';
import { Searcher } from './search.js';
import { TerminalManager } from './pty.js';
import { TerminalShares, SHARE_MINUTES, DEFAULT_MINUTES } from './share.js';
import { Scm } from './scm.js';
import { DocRoom } from './docs.js';
import { unifiedDiff } from '../tools/diff.js';
import { skipDir } from './glob.js';

export { POLICY, WorkbenchError };
export const WORKBENCH_PROTOCOL = 1;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STRINGS = path.resolve(HERE, '..', '..', 'i18n', 'parts', 'workbench.en.json');
const READ_CAPS = ['workspace.read', 'workspace.propose'];

function homeOf(config = {}) {
  return config.home || (process.env.HIVEDESK_HOME ? path.resolve(process.env.HIVEDESK_HOME) : path.join(os.homedir(), '.hivedesk'));
}

/** True when a grant lets a peer use one of these capabilities now. Pure. */
export function peerGrantValid(grant, peerId, names, now = Date.now()) {
  if (!grant || grant.peerId !== peerId || grant.grantedBy !== 'user' || grant.revokedAt) return false;
  if (!names.includes(grant.capability?.name)) return false;
  if (grant.expiresAt !== null && grant.expiresAt !== undefined && !(Date.parse(grant.expiresAt) > now)) return false;
  return true;
}

function realNative(p) {
  try { return fs.realpathSync.native(p); } catch { return path.resolve(p); }
}

function samePathOrInside(child, parent) {
  const r = path.relative(parent, child);
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
}

export default function registerWorkbench(ctx) {
  const { bus, toolbox, approvals, server } = ctx;
  const config = ctx.config || {};
  const home = homeOf(config);
  const p2p = ctx.p2p || null;
  const settings = new SettingsFile(ctx.settingsFile || path.join(home, 'settings.json'));
  const wsRoot = new Root({ id: 'ws', name: 'workspace', workspace: toolbox.ws, isWorkspace: true });
  const roots = new Map(); // id -> Root (user roots, opened lazily)
  const searcher = new Searcher({ excludes: () => settings.get().searchExcludes });
  const terms = new TerminalManager({ settings: () => settings.get(), importer: ctx.ptyImporter, forceBasic: !!ctx.forceBasicTerminal });
  const shares = new TerminalShares({ terms, p2p });
  const scm = new Scm({ gitBin: ctx.gitBin });
  const handlers = new Map();
  const clientState = new Map(); // client id -> { client, terms: Map, watch: Set, closed }
  const watchers = new Map(); // root id -> { watcher, clients: Set, timer, paths: Set }
  let closed = false;

  /* ---------- roots ---------- */
  function rootList() {
    const out = [wsRoot.info()];
    for (const r of settings.get().roots) {
      let ok = true;
      try { ok = fs.statSync(r.path).isDirectory(); } catch { ok = false; }
      out.push({ id: r.id, name: r.name, path: r.path, workspace: false, missing: !ok || undefined });
    }
    return out;
  }

  function getRoot(id) {
    const rid = typeof id === 'string' && id ? id : 'ws';
    if (rid === 'ws') return wsRoot;
    const rec = settings.get().roots.find((r) => r.id === rid);
    if (!rec) throw new WorkbenchError('not_found', 'no such project root');
    let r = roots.get(rid);
    if (!r || r.path !== fs.realpathSync(rec.path)) {
      r = new Root({ id: rec.id, name: rec.name, path: rec.path });
      roots.set(rid, r);
    }
    return r;
  }

  function addRoot(p) {
    if (typeof p !== 'string' || !p.trim()) throw new WorkbenchError('bad_request', 'a folder path is required');
    const abs = path.resolve(p.trim());
    if (!path.isAbsolute(p.trim())) throw new WorkbenchError('bad_request', 'use the full path of the folder');
    let real;
    try { real = fs.realpathSync.native(abs); } catch { throw new WorkbenchError('not_found', `the folder does not exist: ${abs}`); }
    if (!fs.statSync(real).isDirectory()) throw new WorkbenchError('bad_request', 'that is a file, not a folder');
    if (path.parse(real).root === real) throw new WorkbenchError('bad_request', 'a whole drive cannot be a project root; pick a project folder');
    const homeReal = realNative(home);
    if (samePathOrInside(real, homeReal) || samePathOrInside(homeReal, real)) throw new WorkbenchError('forbidden', 'the hivedesk folder (keys, tokens, identity) cannot be opened as a project root');
    if (samePathOrInside(real, os.homedir()) && path.relative(os.homedir(), real) === '') throw new WorkbenchError('bad_request', 'your whole home folder cannot be a project root; pick a project folder');
    const s = settings.get();
    if (samePathOrInside(real, realNative(wsRoot.path)) || s.roots.some((r) => path.relative(realNative(r.path), real) === '')) throw new WorkbenchError('conflict', 'this folder is already open');
    const id = `r_${Math.random().toString(36).slice(2, 10)}`;
    settings.set({ ...s, roots: [...s.roots, { id, path: real, name: path.basename(real), addedAt: new Date().toISOString() }] });
    return rootList().find((r) => r.id === id);
  }

  function removeRoot(id) {
    const s = settings.get();
    if (!s.roots.some((r) => r.id === id)) throw new WorkbenchError('not_found', 'no such project root');
    settings.set({ ...s, roots: s.roots.filter((r) => r.id !== id) });
    roots.delete(id);
    const w = watchers.get(id);
    if (w) { try { w.watcher.close(); } catch { /* closed */ } watchers.delete(id); }
    return { removed: id };
  }

  /* ---------- clients and frames ---------- */
  function stateOf(client) {
    if (!client) return null;
    const id = client.id || 'rest';
    let st = clientState.get(id);
    if (!st) {
      st = { client, terms: new Map(), watch: new Set(), closed: false };
      clientState.set(id, st);
      const conn = client.conn;
      if (conn && typeof conn.on === 'function') conn.on('close', () => dropClient(id));
    }
    return st;
  }

  function push(client, type, data) {
    if (!client) return false;
    if (typeof client.push === 'function') return client.push(type, data) !== false;
    if (client.conn?.sendJson) return client.conn.sendJson({ kind: 'wb', type, data }) !== false;
    return false;
  }

  function dropClient(id) {
    const st = clientState.get(id);
    if (!st) return;
    st.closed = true;
    for (const sub of st.terms.values()) sub.off();
    st.terms.clear();
    for (const rid of st.watch) unwatch(rid, id);
    room.leave(id);
    clientState.delete(id);
  }

  /* ---------- authorization ---------- */
  function peerHas(peerId, names) {
    if (!p2p?.grantsFor) return null;
    let list = [];
    try { list = p2p.grantsFor(peerId) || []; } catch { list = []; }
    return list.find((g) => peerGrantValid(g, peerId, names)) || null;
  }

  function authorize(type, client, data) {
    const policy = POLICY[type];
    const origin = originOf(client);
    if (origin.kind === 'user') return { origin, local: true };
    if (origin.kind !== 'peer' || !origin.peerId) throw new WorkbenchError('forbidden', 'only the person at this machine can use the workbench');
    if (!policy?.peer) throw new WorkbenchError('forbidden', `${type} is not available to peers`);
    const names = policy.peer === 'workspace.read' ? READ_CAPS : [policy.peer];
    const grant = peerHas(origin.peerId, names);
    if (!grant) throw new WorkbenchError('not_granted', `${type} needs the ${policy.peer} permission from the host`);
    if (data && data.root !== undefined && data.root !== 'ws') throw new WorkbenchError('forbidden', 'peers can only use the shared workspace');
    const canEdit = !!peerHas(origin.peerId, ['workspace.propose']);
    const peer = (() => { try { return (p2p.peers?.() || []).find((p) => p.peerId === origin.peerId); } catch { return null; } })();
    return { origin, local: false, peerId: origin.peerId, sessionId: origin.sessionId, canEdit, name: peer?.name || origin.peerId.slice(0, 12), policy };
  }

  function cmd(type, fn) {
    const handler = async (data, client) => {
      if (closed) throw new WorkbenchError('conflict', 'the workbench is stopping');
      const d = data && typeof data === 'object' ? data : {};
      const who = authorize(type, client, d);
      return fn(d, client, who);
    };
    handlers.set(type, handler);
    server?.command?.(type, handler);
  }

  /** Host approval for a peer's change; resolves only when the person approves. */
  async function approve(who, { tool, summary, diff, args }) {
    if (who.local) return;
    if (!approvals) throw new WorkbenchError('conflict', 'approvals are not available');
    // strict with the origin: approval mode off, approveAll and a Code together guest can never answer it.
    const r = await approvals.request({ tool, args, summary: `${who.name}: ${summary}`, diff, workerId: `peer:${who.name}`, strict: true, origin: { kind: 'peer', id: who.peerId, label: who.name } });
    if (!r.approved) throw new WorkbenchError('rejected', `the host rejected this${r.note ? `: ${r.note}` : ''}`);
  }

  /* ---------- file operations ---------- */
  const fileEvent = (rel, before, after, workerId) => {
    try { toolbox.fileEvent(rel, before, after, { workerId }); } catch { /* the log reports its own errors */ }
  };
  const readSmall = (root, rel) => {
    try { const r = root.read(rel); return r.content; } catch { return null; }
  };

  async function writeFile(root, rel, content, who, { approved = false } = {}) {
    const p = relPath(rel);
    if (!p) throw new WorkbenchError('bad_request', 'a file path is required');
    if (typeof content !== 'string') throw new WorkbenchError('bad_request', 'content must be text');
    if (root.isWorkspace) {
      if (!who.local && !approved) {
        const before = readSmall(root, p);
        await approve(who, { tool: 'workbench.write', summary: `${before == null ? 'Create' : 'Change'} ${p}`, diff: unifiedDiff(p, before, content), args: { path: p, bytes: Buffer.byteLength(content) } });
      }
      const r = await toolbox.execute('write_file', { path: p, content }, { workerId: who.local ? 'user' : `peer:${who.name}`, approval: false });
      if (!r.ok) throw new WorkbenchError('bad_request', r.error);
      return { path: p, bytes: Buffer.byteLength(content) };
    }
    root.write(p, content);
    return { path: p, bytes: Buffer.byteLength(content) };
  }

  /* ---------- shared documents ---------- */
  const room = new DocRoom({
    read: (p) => {
      const r = wsRoot.read(p);
      if (r.content == null && (r.tooLarge || r.binary)) throw new WorkbenchError('bad_request', r.binary ? 'binary files cannot be edited' : 'this file is too large to edit');
      return r.content;
    },
    write: async (p, content, sub) => {
      await writeFile(wsRoot, p, content, sub.who);
    }
  });
  const roomSub = (client, who, d = {}) => {
    const id = who.local ? (client?.id || 'rest') : `peer:${who.peerId}:${who.sessionId || ''}`;
    const sub = room.join({
      id,
      kind: who.local ? 'local' : 'peer',
      peerId: who.peerId,
      name: typeof d.name === 'string' ? d.name.slice(0, 40) : who.name,
      color: /^#[0-9a-fA-F]{6}$/.test(d.color || '') ? d.color : undefined,
      canEdit: who.local ? true : who.canEdit,
      send: (type, data) => (who.local ? push(client, type, data) : (client?.push ? client.push(type, data) : p2p?.send?.(who.peerId, { t: `wb.${type}`, body: data })))
    });
    sub.who = who;
    sub.canEdit = who.local ? true : who.canEdit;
    if (who.local) stateOf(client);
    return sub;
  };

  const offBus = bus?.on?.((ev) => {
    if (ev.type !== 'file.changed') return;
    const d = ev.data || {};
    if (d.op === 'delete') room.fileRemoved(d.path);
    else if (typeof d.content === 'string') room.fileChanged(d.path, d.content, { by: d.workerId });
    else {
      const text = readSmall(wsRoot, d.path);
      if (typeof text === 'string') room.fileChanged(d.path, text, { by: d.workerId });
    }
  }) || (() => {});

  /* ---------- watching user roots for changes made outside hivedesk ---------- */
  function watch(rootId, clientId) {
    const root = getRoot(rootId);
    let w = watchers.get(root.id);
    if (!w) {
      let watcher = null;
      try {
        // The native real path: libuv on Windows compares it with the long names it reports.
        watcher = fs.watch(fs.realpathSync.native(root.path), { recursive: true, persistent: false }, (_ev, name) => {
          if (!name) return;
          const rel = String(name).split(path.sep).join('/');
          if (rel.split('/').some((seg) => skipDir(seg))) return;
          w.paths.add(rel);
          if (w.timer) return;
          w.timer = setTimeout(() => {
            w.timer = null;
            const paths = [...w.paths].slice(0, 500);
            w.paths.clear();
            for (const id of w.clients) push(clientState.get(id)?.client, 'fs.changed', { root: root.id, paths });
          }, 200);
        });
        watcher.on('error', () => {});
      } catch {
        watcher = null;
      }
      w = { watcher, clients: new Set(), timer: null, paths: new Set() };
      watchers.set(root.id, w);
    }
    w.clients.add(clientId);
    return !!w.watcher;
  }

  function unwatch(rootId, clientId) {
    const w = watchers.get(rootId);
    if (!w) return;
    w.clients.delete(clientId);
    if (!w.clients.size) {
      clearTimeout(w.timer);
      try { w.watcher?.close(); } catch { /* closed */ }
      watchers.delete(rootId);
    }
  }

  /* ---------- commands ---------- */
  cmd('wb.info', async (d, client, who) => {
    const cap = await terms.capability();
    const base = { protocol: WORKBENCH_PROTOCOL, local: who.local };
    if (!who.local) return { ...base, roots: [wsRoot.info()].map((r) => ({ id: r.id, name: r.name, workspace: true })), canEdit: who.canEdit };
    return { ...base, roots: rootList(), terminal: cap, share: { available: shares.available(), minutes: SHARE_MINUTES, defaultMinutes: DEFAULT_MINUTES }, settings: settings.get(), platform: process.platform };
  });
  cmd('wb.settings.get', () => ({ settings: settings.get() }));
  cmd('wb.settings.set', (d) => ({ settings: settings.patch(d.settings && typeof d.settings === 'object' ? d.settings : d) }));
  cmd('wb.roots.list', () => ({ roots: rootList() }));
  cmd('wb.roots.add', (d) => ({ root: addRoot(d.path) }));
  cmd('wb.roots.remove', (d) => removeRoot(String(d.id || '')));

  cmd('wb.fs.list', (d) => getRoot(d.root).list(d.dir || ''));
  cmd('wb.fs.files', (d) => getRoot(d.root).files({ exclude: settings.get().searchExcludes }));
  cmd('wb.fs.read', (d) => getRoot(d.root).read(d.path));
  cmd('wb.fs.write', (d, client, who) => writeFile(getRoot(d.root), d.path, d.content, who));
  cmd('wb.fs.count', (d) => getRoot(d.root).countUnder(d.path));
  cmd('wb.fs.mkdir', async (d, client, who) => {
    const root = getRoot(d.root);
    const p = relPath(d.path);
    await approve(who, { tool: 'workbench.mkdir', summary: `Create the folder ${p}`, args: { path: p } });
    return root.mkdir(p);
  });
  cmd('wb.fs.rename', async (d, client, who) => {
    const root = getRoot(d.root);
    const from = relPath(d.from);
    const to = relPath(d.to);
    await approve(who, { tool: 'workbench.rename', summary: `Move ${from} to ${to}`, args: { from, to } });
    // Contents of the files that move, for the file.changed events of the workspace.
    const keep = root.isWorkspace ? new Map() : null;
    if (keep) {
      const st = root.stat(from);
      const list = st.type === 'dir' ? root._filesUnder(from) : [from];
      for (const f of list.slice(0, 2000)) keep.set(f, readSmall(root, f));
    }
    const r = root.rename(from, to);
    if (keep) {
      for (const m of r.moved) {
        const text = keep.get(m.from);
        if (text == null) continue;
        fileEvent(m.from, text, null, who.local ? 'user' : `peer:${who.name}`);
        fileEvent(m.to, null, text, who.local ? 'user' : `peer:${who.name}`);
      }
    }
    return r;
  });
  cmd('wb.fs.delete', async (d, client, who) => {
    const root = getRoot(d.root);
    const p = relPath(d.path);
    if (!p) throw new WorkbenchError('bad_request', 'the root itself cannot be deleted');
    const st = root.stat(p);
    if (!st.type) throw new WorkbenchError('not_found', `not found: ${p}`);
    let recursive = false;
    if (st.type === 'dir') {
      const count = root.countUnder(p);
      if (count.files + count.folders > 0) {
        // A folder with things inside: the window shows the counts and sends them back.
        if (!d.recursive || Number(d.confirmFiles) !== count.files) throw new WorkbenchError('confirm_required', `${p} holds ${count.files} files and ${count.folders} folders; confirm to delete them all`, { count });
        recursive = true;
      }
    }
    const before = root.isWorkspace && st.type === 'file' ? readSmall(root, p) : null;
    const contents = root.isWorkspace && st.type === 'dir' ? new Map(root._filesUnder(p).slice(0, 2000).map((f) => [f, readSmall(root, f)])) : null;
    await approve(who, { tool: 'workbench.delete', summary: `Delete ${p}${recursive ? ' and everything in it' : ''}`, diff: st.type === 'file' && before != null ? unifiedDiff(p, before, null) : undefined, args: { path: p, recursive } });
    const r = root.remove(p, { recursive });
    if (root.isWorkspace) {
      const by = who.local ? 'user' : `peer:${who.name}`;
      if (st.type === 'file') { if (before != null) fileEvent(p, before, null, by); }
      else for (const [f, text] of contents) if (text != null) fileEvent(f, text, null, by);
    }
    return r;
  });
  cmd('wb.fs.watch', (d, client) => {
    const st = stateOf(client);
    if (!st) throw new WorkbenchError('bad_request', 'watching needs a WebSocket');
    const root = getRoot(d.root);
    if (d.on === false) { unwatch(root.id, client.id); st.watch.delete(root.id); return { watching: false }; }
    st.watch.add(root.id);
    return { watching: watch(root.id, client.id) };
  });

  cmd('wb.search', async (d, client) => {
    const root = getRoot(d.root);
    const canStream = !!client && !d.wait && (typeof client.push === 'function' || !!client.conn?.sendJson);
    const searchId = `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    if (!canStream) {
      const results = [];
      const summary = await searcher.search(root, d, { onResult: (r) => results.push(r), maxHits: d.maxHits, searchId });
      return { ...summary, results };
    }
    searcher.search(root, d, { onResult: (r) => push(client, 'search.result', { searchId, ...r }), maxHits: d.maxHits, searchId })
      .then((summary) => push(client, 'search.done', summary))
      .catch((err) => push(client, 'search.done', { searchId, error: { code: err.code || 'internal', message: err.message } }));
    return { searchId };
  });
  cmd('wb.search.cancel', (d) => ({ cancelled: searcher.cancel(String(d.searchId || '')) }));
  cmd('wb.replace.preview', (d) => searcher.previewReplace(getRoot(d.root), d));
  cmd('wb.replace.apply', async (d, client, who) => {
    const preview = searcher.takePreview(d.previewId);
    const root = getRoot(preview.rootId);
    if (!who.local && !root.isWorkspace) throw new WorkbenchError('forbidden', 'peers can only use the shared workspace');
    const only = Array.isArray(d.paths) && d.paths.length ? new Set(d.paths.map(String)) : null;
    const chosen = [...preview.entries.values()].filter((e) => !only || only.has(e.path));
    if (!who.local) {
      const diff = chosen.slice(0, 30).map((e) => e.changes.slice(0, 20).map((c) => `@@ ${e.path}:${c.line}\n-${c.before}\n+${c.after}`).join('\n')).join('\n');
      await approve(who, { tool: 'workbench.replace', summary: `Replace in ${chosen.length} files`, diff, args: { files: chosen.length } });
    }
    const done = [];
    const skipped = [];
    for (const e of chosen) {
      let cur;
      try { cur = root.read(e.path); } catch { skipped.push({ path: e.path, reason: 'gone' }); continue; }
      if (cur.content == null || cur.sha !== e.sha) { skipped.push({ path: e.path, reason: 'changed since the preview' }); continue; }
      if (Buffer.byteLength(e.after) > MAX_EDIT_BYTES) { skipped.push({ path: e.path, reason: 'too large' }); continue; }
      try {
        await writeFile(root, e.path, e.after, who, { approved: true });
        done.push({ path: e.path, count: e.count });
      } catch (err) {
        skipped.push({ path: e.path, reason: err.message });
      }
    }
    return { files: done, skipped, total: done.reduce((n, f) => n + f.count, 0) };
  });

  /* ---------- terminals ---------- */
  function subscribeTerm(client, term) {
    const st = stateOf(client);
    if (!st || st.terms.has(term.id)) return;
    let pending = '';
    let timer = null;
    const flush = () => {
      timer = null;
      if (!pending) return;
      const data = pending;
      pending = '';
      push(client, 'term.data', { termId: term.id, data });
    };
    const offData = term.onData((text) => {
      pending += text;
      if (pending.length > 64 * 1024) flush();
      else if (!timer) { timer = setTimeout(flush, 12); timer.unref?.(); }
    });
    const offExit = term.onExit((exit) => { flush(); push(client, 'term.exit', { termId: term.id, ...exit }); });
    st.terms.set(term.id, { off: () => { clearTimeout(timer); offData(); offExit(); } });
  }

  cmd('wb.term.open', async (d, client) => {
    if (!client) throw new WorkbenchError('bad_request', 'a terminal needs a WebSocket');
    const root = getRoot(d.root);
    let cwd = root.path;
    if (d.cwd) {
      const st = root.stat(d.cwd);
      if (st.type === 'dir') cwd = st.abs;
    }
    const term = await terms.open({ cwd, rootId: root.id, cols: Number(d.cols) || 80, rows: Number(d.rows) || 24 });
    subscribeTerm(client, term);
    return { ...term.info(), reason: term.reason };
  });
  cmd('wb.term.list', () => ({ terminals: terms.list().map((t) => ({ ...t, shares: shares.list(t.termId) })) }));
  cmd('wb.term.attach', (d, client) => {
    const term = terms.get(d.termId);
    subscribeTerm(client, term);
    return { ...term.info(), scrollback: term.buffer, shares: shares.list(term.id) };
  });
  cmd('wb.term.input', (d) => ({ bytes: terms.get(d.termId).write(d.data) }));
  cmd('wb.term.resize', (d) => { const t = terms.get(d.termId); t.resize(d.cols, d.rows); return { cols: t.cols, rows: t.rows }; });
  cmd('wb.term.close', async (d) => {
    const t = terms.close(d.termId);
    await shares.unshare({ termId: t.id });
    return { termId: t.id };
  });
  cmd('wb.term.share', (d) => shares.share({ termId: String(d.termId || ''), peerId: d.peerId, mode: d.mode, minutes: d.minutes }));
  cmd('wb.term.unshare', (d) => shares.unshare({ termId: String(d.termId || ''), peerId: d.peerId }));
  cmd('wb.peers', () => {
    if (!p2p?.peers) return { available: false, peers: [] };
    return { available: shares.available(), peers: (p2p.peers() || []).map((p) => ({ peerId: p.peerId, name: p.name, online: !!p.online })) };
  });

  /* ---------- source control ---------- */
  const scmEvent = (root, type, data) => { if (root.isWorkspace) bus?.emit?.(type, data); };
  cmd('wb.scm.status', (d) => scm.status(getRoot(d.root)));
  cmd('wb.scm.diff', (d) => scm.diff(getRoot(d.root), d.path, { staged: !!d.staged }));
  cmd('wb.scm.stage', (d) => scm.stage(getRoot(d.root), d.paths));
  cmd('wb.scm.unstage', (d) => scm.unstage(getRoot(d.root), d.paths));
  cmd('wb.scm.discard', (d) => scm.discard(getRoot(d.root), d.paths));
  cmd('wb.scm.commit', async (d) => {
    const root = getRoot(d.root);
    const r = await scm.commit(root, { message: d.message, amend: !!d.amend });
    scmEvent(root, 'github.committed', { sha: r.sha, branch: r.branch, subject: String(d.message || '').split('\n')[0].slice(0, 200), files: r.files.length, by: 'user' });
    return r;
  });
  cmd('wb.scm.branches', (d) => scm.branches(getRoot(d.root)));
  cmd('wb.scm.checkout', async (d) => {
    const root = getRoot(d.root);
    const r = await scm.checkout(root, { branch: d.branch, create: !!d.create });
    if (d.create) scmEvent(root, 'github.branch', { branch: r.branch });
    return r;
  });
  cmd('wb.scm.stashes', (d) => scm.stashes(getRoot(d.root)));
  cmd('wb.scm.log', (d) => scm.log(getRoot(d.root), d.n));
  cmd('wb.scm.init', (d) => scm.init(getRoot(d.root)));

  /* ---------- shared documents ---------- */
  cmd('wb.doc.open', (d, client, who) => room.open(roomSub(client, who, d), d.path));
  cmd('wb.doc.ops', (d, client, who) => room.ops(roomSub(client, who), d.path, d.ops));
  cmd('wb.doc.presence', (d, client, who) => room.presence(roomSub(client, who), d.file ?? d.path, d.sel));
  cmd('wb.doc.save', (d, client, who) => room.save(roomSub(client, who), d.path));
  cmd('wb.doc.close', (d, client, who) => { room.close(roomSub(client, who), d.path); return {}; });
  cmd('wb.doc.reload', (d, client, who) => room.reload(roomSub(client, who), d.path));
  cmd('wb.doc.people', () => ({ people: room.people() }));

  /* ---------- strings (i18n/parts/workbench.en.json, until they are merged into en.json) ---------- */
  server?.route?.('GET', '/api/workbench/strings', (req, res) => {
    let body = '{}';
    try { body = fs.readFileSync(STRINGS, 'utf8'); } catch { /* none */ }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
    res.end(body);
  });

  const offGrants = p2p?.onGrantChange?.((ev) => shares.onGrantChange(ev)) || (() => {});

  return {
    POLICY,
    roots: rootList,
    getRoot,
    settings,
    terms,
    shares,
    room,
    searcher,
    /** Runs a workbench command as a peer: for src/p2p after it verified the peer (Stream 2). */
    peerCommand(peer, type, data) {
      const h = handlers.get(type);
      if (!h) throw new WorkbenchError('bad_request', `unknown command: ${type}`);
      const client = { id: `peer:${peer.peerId}:${peer.sessionId || ''}`, origin: { kind: 'peer', peerId: peer.peerId, sessionId: peer.sessionId }, push: peer.push };
      return h(data, client);
    },
    /** A `term.*` message from a peer session (PLAN section 4), already decrypted by src/p2p. */
    handlePeerMessage(peer, msg) {
      if (!msg || typeof msg.t !== 'string') throw new WorkbenchError('bad_request', 'bad message');
      if (msg.t.startsWith('term.')) return shares.handlePeer(peer.peerId, msg);
      throw new WorkbenchError('bad_request', `unknown message ${msg.t}`);
    },
    /** A peer session closed: drop its documents. */
    peerGone(peer) {
      for (const id of [...room.subs.keys()]) if (id.startsWith(`peer:${peer.peerId}:`)) room.leave(id);
    },
    async close() {
      closed = true;
      offBus();
      offGrants();
      for (const id of [...clientState.keys()]) dropClient(id);
      for (const w of watchers.values()) { clearTimeout(w.timer); try { w.watcher?.close(); } catch { /* closed */ } }
      watchers.clear();
      await shares.closeAll();
      terms.closeAll();
      await searcher.close();
    }
  };
}
