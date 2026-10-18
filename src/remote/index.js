// Remote desktop plug-in (docs/1.0/PLAN.md section 12, protocol in docs/1.0/protocol/remote.md).
// The engine calls the default export with { bus, server, p2p, home }. Without the p2p control plane
// (src/p2p/, Stream 2) remote desktop says it is unavailable; nothing is simulated.
//
// Every remote.* command is for the local person only: a command that arrives with a peer or crew
// origin is refused. Live frames carry no content (no SDP, no clipboard, no chat, no names): they only
// say "something changed", and the window pulls the data with a command, so a 0.2 Code together relay
// that forwards engine frames to guests cannot leak a host's addresses, clipboard or chat.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { RemoteDesk, RemoteError } from './desk.js';
import { FileTransfers, MAX_FILE, safeName } from './transfer.js';
import { ClipSync, CLIP_LIMITS } from './clipsync.js';
import { LinuxClipboard, linuxClipboardKind } from './clipnative.js';
import { Unattended } from './unattended.js';
import { helperSupport, startHelper, hasProgram } from './helper.js';
import { deriveAddress, parseAddress, formatAddress, addressTopic, findCollision, avatarFor } from './address.js';
import { DURATIONS, DEFAULT_MINUTES, HOTKEY, QUALITY } from './policy.js';

const MAX_SIGNALS = 400;

/** Refuses anything that is not the local person (PLAN section 1.3: the router passes origin; 0.2 clients are local). */
function localOnly(ctx) {
  const kind = ctx?.origin?.kind;
  if (kind && kind !== 'user') throw new RemoteError('forbidden', 'remote desktop commands are for the person at this computer');
}

export const COMMANDS = [
  'remote.state', 'remote.address', 'remote.connect', 'remote.listen', 'remote.answer', 'remote.ask', 'remote.stop', 'remote.stopAll',
  'remote.signal', 'remote.signals', 'remote.share.started', 'remote.share.removed', 'remote.display', 'remote.pause', 'remote.input',
  'remote.screen', 'remote.quality', 'remote.chat.send', 'remote.chat.log', 'remote.clip.send', 'remote.clip.take', 'remote.clip.fetch',
  'remote.clip.folder', 'remote.file.offer', 'remote.file.answer', 'remote.file.cancel', 'remote.file.pause',
  'remote.unattended.get', 'remote.unattended.set', 'remote.unattended.connect'
];

/**
 * @param {{
 *   bus: { live: (type: string, data?: object) => void },
 *   server: { command: Function, route: Function },
 *   p2p?: import('./port.js').P2PPort, home?: string, downloadsDir?: string,
 *   support?: object, startHelper?: Function, clipboardProvider?: object | null, now?: () => number
 * }} ctx
 */
export default function registerRemote(ctx) {
  const { bus, server } = ctx;
  // The engine router passes (data, client, { origin }): only the person at this computer reaches these.
  const cmd = (name, fn) => server.command(name, async (d, c, ctx) => { localOnly(ctx); return fn(d || {}, c); }, { local: true });

  if (!ctx.p2p) {
    const reason = 'no_p2p';
    cmd('remote.state', () => ({ available: false, reason, durations: DURATIONS, defaultMinutes: DEFAULT_MINUTES }));
    for (const n of COMMANDS.filter((x) => x !== 'remote.state')) {
      cmd(n, () => { throw new RemoteError('conflict', 'remote desktop needs the p2p control plane, which is not running'); });
    }
    return { available: false, reason, close() {} };
  }

  const p2p = ctx.p2p;
  const home = ctx.home || path.join(process.cwd(), '.hivedesk');
  const support = ctx.support || helperSupport();
  const addressOf = (peerId) => {
    const key = p2p.peer(peerId)?.publicKey;
    try { return key ? deriveAddress(key) : null; } catch { return null; }
  };
  const myAddress = (() => { try { return p2p.localPublicKey ? deriveAddress(p2p.localPublicKey) : null; } catch { return null; } })();
  const unattended = new Unattended({ file: ctx.home === null ? null : path.join(home, 'remote', 'unattended.json'), now: ctx.now });
  const desk = new RemoteDesk({ p2p, support, startHelper: ctx.startHelper || startHelper, unattended, addressOf, now: ctx.now });
  const transfers = new FileTransfers({ p2p, desk, downloadsDir: ctx.downloadsDir, now: ctx.now });
  let provider = ctx.clipboardProvider;
  if (provider === undefined) {
    const kind = process.platform === 'linux' ? linuxClipboardKind(process.env, hasProgram) : null;
    provider = kind ? new LinuxClipboard({ kind }) : null;
  }
  const clips = new ClipSync({ p2p, desk, transfers, provider, root: ctx.downloadsDir, now: ctx.now });
  const outbox = path.join(home, 'remote', 'outbox');
  const signals = new Map();
  let listening = false;
  let version = 0;
  const changed = () => bus.live('remote.changed', { v: ++version });

  desk.on('state', changed);
  transfers.on('changed', changed);
  clips.on('changed', changed);
  desk.on('signal', (s) => {
    const q = signals.get(s.sessionId) || [];
    if (q.length < MAX_SIGNALS) q.push({ kind: s.kind, sdp: s.sdp, candidate: s.candidate });
    signals.set(s.sessionId, q);
    bus.live('remote.signal', { sessionId: s.sessionId });
  });
  desk.on('ended', (e) => { signals.delete(e.sessionId); bus.live('remote.ended', { sessionId: e.sessionId, reason: e.reason }); });
  desk.on('refused', (e) => bus.live('remote.ended', { sessionId: e.sessionId, reason: e.reason === 'declined' ? 'refused' : e.reason }));
  desk.on('chat', (c) => bus.live('remote.chat', { sessionId: c.sessionId, mine: c.mine }));
  desk.on('quality', (q) => bus.live('remote.quality', { sessionId: q.sessionId }));
  clips.on('clip', (c) => bus.live('remote.clip', { id: c.id, sessionId: c.sessionId, kind: c.kind, bytes: c.bytes }));
  clips.on('applied', (c) => bus.live('remote.clip.applied', { sessionId: c.sessionId, kind: c.kind }));
  clips.on('files', (f) => bus.live('remote.clip.files', { id: f.id, sessionId: f.sessionId, count: f.count, total: f.total }));
  clips.on('filesDone', (f) => bus.live('remote.clip.filesDone', { id: f.id, sessionId: f.sessionId, count: f.count, native: f.native }));
  transfers.on('incoming', (f) => bus.live('remote.file', { id: f.id, kind: 'incoming' }));
  transfers.on('received', (f) => { if (!f.clipId) bus.live('remote.file', { id: f.id, kind: 'received' }); });

  const state = () => ({
    available: true, durations: DURATIONS, defaultMinutes: DEFAULT_MINUTES, hotkey: HOTKEY, quality: QUALITY, limits: CLIP_LIMITS,
    address: myAddress, addressText: myAddress ? formatAddress(myAddress) : null, listening, canDial: typeof p2p.dialAddress === 'function',
    unattended: unattended.info(),
    ...desk.snapshot(),
    requests: desk.snapshot().requests.map((r) => ({ ...r, addressText: r.address ? formatAddress(r.address) : null, avatar: avatarFor(r.address || r.peerId, r.name) })),
    clipboard: { synced: clips.status(), folder: clips.folder, native: !!(desk.support.kind === 'win-input' || provider), pendingFiles: [...clips.inFiles.values()].map((f) => ({ id: f.id, sessionId: f.sessionId, count: f.entries.length, total: f.total, state: f.state })) },
    transfers: transfers.list(),
    incoming: [...transfers.in.values()].filter((t) => t.state === 'offered').map((t) => ({ id: t.id, sessionId: t.sessionId, from: t.peerName, name: t.name, size: t.size }))
  });

  const setListen = (on) => {
    if (!myAddress || typeof p2p.listenAddress !== 'function') throw new RemoteError('conflict', 'the p2p layer cannot listen on an address yet');
    p2p.listenAddress(addressTopic(myAddress), on === true);
    listening = on === true;
    desk.audit(listening ? 'remote.listen.on' : 'remote.listen.off', { address: myAddress });
    changed();
    return { listening };
  };

  cmd('remote.state', () => state());
  cmd('remote.address', () => ({ address: myAddress, text: myAddress ? formatAddress(myAddress) : null, grouped: myAddress ? formatAddress(myAddress, '334') : null }));
  cmd('remote.listen', (d) => setListen(d.on === true));
  cmd('remote.connect', async (d) => {
    const parsed = parseAddress(d.address);
    if (!parsed.ok) throw new RemoteError('bad_request', parsed.code === 'check_digit' ? 'that address has a typo (the last digit does not match)' : 'an address has 10 digits');
    if (parsed.address === myAddress) throw new RemoteError('bad_request', 'that is the address of this computer');
    if (typeof p2p.dialAddress !== 'function') throw new RemoteError('conflict', 'the p2p layer cannot dial by address yet');
    const clash = findCollision(parsed.address, p2p.knownPeers?.() || [], p2p.localPublicKey);
    // lan: an optional LAN address (host:port) of the other machine; without it the window meets it on the relays.
    const { sessionId } = await p2p.dialAddress(addressTopic(parsed.address), { address: parsed.address, ...(typeof d.lan === 'string' && d.lan.length < 200 ? { lan: d.lan } : {}) });
    desk.audit('remote.dial', { address: parsed.address, collision: !!clash });
    if (d.password) desk.askUnattended(sessionId, { password: String(d.password), control: d.control === true, clipboard: d.clipboard === true, files: d.files === true });
    else desk.ask(sessionId, { control: d.control === true, clipboard: d.clipboard === true, files: d.files === true, reason: d.reason });
    return { sessionId, collision: clash ? { name: clash.name } : null };
  });
  // Host
  cmd('remote.answer', (d) => desk.answer(String(d.requestId || ''), {
    allow: d.allow === true, minutes: d.minutes, view: d.view === true, control: d.control === true, clipboard: d.clipboard, files: d.files === true
  }));
  cmd('remote.share.started', (d) => desk.shareStarted(String(d.sessionId || ''), { surface: d.surface, width: d.width, height: d.height, index: d.index }));
  cmd('remote.share.removed', (d) => desk.shareRemoved(String(d.sessionId || ''), Number(d.index)));
  cmd('remote.display', (d) => desk.setDisplay(String(d.sessionId || ''), d.index, Number.isInteger(d.track) ? d.track : 0));
  cmd('remote.pause', (d) => desk.pause(String(d.sessionId || ''), d.on === true));
  cmd('remote.stop', (d) => desk.stop(String(d.sessionId || ''), 'host'));
  cmd('remote.stopAll', (d) => desk.stopAll(['tray', 'banner', 'kill', 'hotkey'].includes(d.from) ? d.from : 'kill'));
  cmd('remote.unattended.get', () => unattended.info());
  cmd('remote.unattended.set', (d) => {
    const info = unattended.configure({ enabled: d.enabled === true, password: d.password, allow: d.allow || {}, minutes: d.minutes, peers: d.peers });
    desk.audit(info.enabled ? 'remote.unattended.on' : 'remote.unattended.off', { allow: info.allow, minutes: info.minutes, peers: info.peers });
    changed();
    return info;
  });
  // Viewer
  cmd('remote.ask', (d) => desk.ask(String(d.sessionId || ''), { control: d.control === true, clipboard: d.clipboard === true, files: d.files === true, reason: d.reason }));
  cmd('remote.unattended.connect', (d) => desk.askUnattended(String(d.sessionId || ''), { password: d.password, control: d.control === true, clipboard: d.clipboard === true, files: d.files === true }));
  cmd('remote.input', (d) => desk.sendInput(String(d.sessionId || ''), d.events));
  cmd('remote.screen', (d) => desk.askScreen(String(d.sessionId || ''), { op: d.op, display: d.display }));
  cmd('remote.quality', (d) => desk.setQuality(String(d.sessionId || ''), d.preset));
  // Both
  cmd('remote.signal', (d) => desk.signal(String(d.sessionId || ''), d.signal));
  cmd('remote.signals', (d) => {
    const id = String(d.sessionId || '');
    if (!desk.shares.has(id) && !desk.views.has(id)) throw new RemoteError('not_found', 'no remote desktop session with that id');
    const q = signals.get(id) || [];
    signals.delete(id);
    const share = desk.shares.get(id);
    return { signals: q, quality: share ? share.quality : undefined };
  });
  cmd('remote.chat.send', (d) => desk.chat(String(d.sessionId || ''), d.text));
  cmd('remote.chat.log', (d) => ({ lines: desk.chatLog(String(d.sessionId || '')) }));
  cmd('remote.clip.send', async (d) => {
    const it = d.item || {};
    let item = null;
    if (it.kind === 'text') item = { kind: 'text', text: String(it.text ?? ''), html: typeof it.html === 'string' ? it.html : undefined };
    else if (it.kind === 'image' && typeof it.png === 'string') item = { kind: 'image', png: Buffer.from(it.png, 'base64') };
    if (!item) throw new RemoteError('bad_request', 'the window can send text or a PNG image');
    const r = await clips.localCopy(item, { auto: false, sessionId: String(d.sessionId || '') });
    if (!r.sent && r.reason) throw new RemoteError('bad_request', `clipboard: ${r.reason.replace('_', ' ')}`);
    if (!r.sent) throw new RemoteError('forbidden', 'clipboard sync is not allowed in this direction right now');
    return r;
  });
  cmd('remote.clip.take', (d) => clips.take(String(d.id || '')));
  cmd('remote.clip.fetch', (d) => clips.fetch(String(d.id || '')));
  cmd('remote.clip.folder', (d) => clips.setFolder(d.path));
  cmd('remote.file.offer', (d) => transfers.offer(String(d.sessionId || ''), String(d.path || '')));
  cmd('remote.file.answer', (d) => transfers.answer(String(d.id || ''), d.accept === true));
  cmd('remote.file.cancel', (d) => transfers.cancel(String(d.id || '')));
  cmd('remote.file.pause', (d) => transfers.pause(String(d.id || ''), d.on === true));

  // A file from a browser window (a picker or a drop): streamed to the outbox, then offered, then removed.
  server.route('POST', '/api/remote/upload', async (req, res, url) => {
    const reply = (status, body) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
    if (req.headers['x-hivedesk-upload'] !== '1') return reply(400, { error: { code: 'bad_request', message: 'missing upload header' } });
    const sessionId = String(url.searchParams.get('sessionId') || '');
    const name = safeName(url.searchParams.get('name') || 'file');
    const len = Number(req.headers['content-length']);
    if (!Number.isFinite(len) || len < 0 || len > MAX_FILE) return reply(413, { error: { code: 'bad_request', message: 'files are limited to 2 GB' } });
    if (!transfers._allowed(sessionId)) return reply(403, { error: { code: 'forbidden', message: 'file transfer was not allowed for this session' } });
    await fsp.mkdir(outbox, { recursive: true });
    const dir = await fsp.mkdtemp(path.join(outbox, 'up-'));
    const file = path.join(dir, name);
    let size = 0;
    try {
      await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(file);
        req.on('data', (c) => { size += c.length; if (size > len || size > MAX_FILE) { req.destroy(); out.destroy(); reject(new RemoteError('bad_request', 'upload larger than announced')); } });
        req.pipe(out);
        out.on('finish', resolve);
        out.on('error', reject);
        req.on('error', reject);
      });
      const r = await transfers.offer(sessionId, file, { temp: true });
      return reply(200, { ok: true, result: r });
    } catch (err) {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
      return reply(err.code === 'forbidden' ? 403 : 400, { error: { code: err.code || 'bad_request', message: String(err.message) } });
    }
  });

  return {
    available: true,
    desk,
    transfers,
    clips,
    unattended,
    address: myAddress,
    /** For a local agent that asks to see the screen (view only; the host's dialog decides). */
    agentRequest: (agentId, o) => desk.agentRequest(agentId, o),
    agentMayView: (agentId) => desk.agentMayView(agentId),
    /** The kill switch for the desktop tray and anything else outside the window. */
    stopAll: (from = 'tray') => desk.stopAll(from),
    close() {
      if (listening) { try { p2p.listenAddress(addressTopic(myAddress), false); } catch { /* gone */ } }
      clips.close();
      transfers.close();
      desk.close();
    }
  };
}
