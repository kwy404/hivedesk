import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { describe, it, expect, afterEach } from 'vitest';
import { RemoteDesk } from '../../src/remote/desk.js';
import { FileTransfers } from '../../src/remote/transfer.js';
import { ClipSync, CLIP_LIMITS, decodeNative } from '../../src/remote/clipsync.js';
import { createInprocPair, flush, FakeHelper } from './inproc-port.js';
import { tmpDir, waitFor } from '../helpers.js';

const WIN = { view: true, control: true, kind: 'win-input', hotkey: true, indicator: true, reason: null };
const MAC = { view: true, control: false, kind: null, hotkey: false, indicator: false, reason: 'macos_unsigned' };
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(200)]);
const dirs = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function side(p2p, support, root, name) {
  const helpers = [];
  const desk = new RemoteDesk({ p2p, support, startHelper: () => { const h = new FakeHelper(); helpers.push(h); setImmediate(() => { h.ready(); h.lock(false); }); return h; } });
  const transfers = new FileTransfers({ p2p, desk, downloadsDir: path.join(root, `${name}-dl`) });
  const clips = new ClipSync({ p2p, desk, transfers, provider: null, root: path.join(root, `${name}-dl`) });
  return { desk, transfers, clips, helpers, helper: () => helpers[helpers.length - 1] };
}

async function setup({ dir = 'both', hostSupport = WIN, viewerSupport = WIN } = {}) {
  const pair = createInprocPair();
  const root = tmpDir('hivedesk-clip-');
  dirs.push(root);
  const host = side(pair.host.port, hostSupport, root, 'host');
  const viewer = side(pair.viewer.port, viewerSupport, root, 'viewer');
  const sid = pair.open();
  viewer.desk.ask(sid, { clipboard: true });
  await flush();
  const [rq] = host.desk.snapshot().requests;
  host.desk.answer(rq.id, { allow: true, view: true, clipboard: dir });
  await flush(40);
  return { pair, host, viewer, sid, root };
}

const kinds = (e) => e.audit.map((l) => l.entry);

describe('clipboard sync', () => {
  it('text with HTML copied on the viewer is pasted on the host, and only metadata is audited', async () => {
    const t = await setup();
    expect(t.viewer.helper().calls).toContainEqual(['clipWatch', true]);
    t.viewer.helper().emit('clip', { t: 'clip', text: b64('secret note'), html: b64('<b>secret note</b>') });
    await flush(40);
    const set = t.host.helper().calls.filter((c) => c[0] === 'clipSet').pop();
    expect(set[1]).toEqual({ kind: 'text', text: 'secret note', html: '<b>secret note</b>' });
    const audit = JSON.stringify([...t.pair.host.audit, ...t.pair.viewer.audit]);
    expect(audit).not.toMatch(/secret note/);
    expect(kinds(t.pair.host).find((e) => e.kind === 'clip.sync')).toMatchObject({ dir: 'in', item: 'text', bytes: 11 + 18 });
    expect(t.host.clips.status()).toEqual([expect.objectContaining({ name: 'Rita', dir: 'both' })]);
  });

  it('a PNG copied on the host is pasted on the viewer', async () => {
    const t = await setup();
    t.host.helper().emit('clip', { t: 'clip', png: PNG.toString('base64') });
    await flush(40);
    const set = t.viewer.helper().calls.filter((c) => c[0] === 'clipSet').pop();
    expect(set[1].kind).toBe('image');
    expect(Buffer.compare(set[1].png, PNG)).toBe(0);
    expect(t.pair.host.sent.find((m) => m.t === 'clip.image').stream).toBe(2);
  });

  it('follows the direction of the grant', async () => {
    const t = await setup({ dir: 'to_viewer' });
    t.viewer.helper().emit('clip', { t: 'clip', text: b64('from viewer') });
    await flush(40);
    expect(t.pair.viewer.sent.some((m) => m.t === 'clip.text')).toBe(false);
    t.host.helper().emit('clip', { t: 'clip', text: b64('from host') });
    await flush(40);
    expect(t.viewer.helper().calls.filter((c) => c[0] === 'clipSet').pop()[1].text).toBe('from host');
    // A forged message against the direction is refused by the host.
    t.pair.viewer.port.send(t.sid, 2, 'clip.text', { text: 'forced' });
    await flush(40);
    expect(t.host.helper().calls.some((c) => c[0] === 'clipSet')).toBe(false);
    expect(kinds(t.pair.host).find((e) => e.kind === 'clip.refused')).toMatchObject({ reason: 'direction' });
  });

  it('nothing syncs without the clipboard grant', async () => {
    const pair = createInprocPair();
    const root = tmpDir('hivedesk-clip-');
    dirs.push(root);
    const host = side(pair.host.port, WIN, root, 'host');
    const viewer = side(pair.viewer.port, WIN, root, 'viewer');
    const sid = pair.open();
    viewer.desk.ask(sid, { clipboard: true });
    await flush();
    const [rq] = host.desk.snapshot().requests;
    host.desk.answer(rq.id, { allow: true, view: true });
    await flush(40);
    expect(host.clips.canSend(sid)).toBe(false);
    pair.viewer.port.send(sid, 2, 'clip.text', { text: 'x' });
    await flush(40);
    expect(kinds(pair.host).find((e) => e.kind === 'clip.refused')).toMatchObject({ reason: 'direction' });
  });

  it('caps sizes: text over 1 MB is not sent', async () => {
    const t = await setup();
    const big = 'x'.repeat(CLIP_LIMITS.text + 1);
    const r = await t.viewer.clips.localCopy({ kind: 'text', text: big }, { auto: false, sessionId: t.sid });
    expect(r).toEqual({ sent: 0, reason: 'too_large' });
    expect(kinds(t.pair.viewer).find((e) => e.kind === 'clip.dropped')).toMatchObject({ reason: 'too_large' });
    t.pair.viewer.port.send(t.sid, 2, 'clip.image', { png: Buffer.alloc(16, 1).toString('base64') });
    await flush(40);
    expect(kinds(t.pair.host).find((e) => e.kind === 'clip.refused')).toMatchObject({ reason: 'bad_item' });
  });

  it('never syncs while a screen is locked or the session is paused', async () => {
    const t = await setup();
    t.host.helper().lock(true);
    await flush();
    t.viewer.helper().emit('clip', { t: 'clip', text: b64('while host locked') });
    t.host.helper().emit('clip', { t: 'clip', text: b64('from a locked host') });
    await flush(40);
    expect(t.host.helper().calls.some((c) => c[0] === 'clipSet')).toBe(false);
    expect(t.viewer.helper().calls.some((c) => c[0] === 'clipSet')).toBe(false);
    t.host.helper().lock(false);
    await flush(40);
    t.host.desk.pause(t.sid, true);
    await flush(40);
    t.viewer.helper().emit('clip', { t: 'clip', text: b64('while paused') });
    t.host.helper().emit('clip', { t: 'clip', text: b64('host while paused') });
    await flush(40);
    expect(t.host.helper().calls.some((c) => c[0] === 'clipSet')).toBe(false);
    expect(t.viewer.helper().calls.some((c) => c[0] === 'clipSet')).toBe(false);
    t.host.desk.pause(t.sid, false);
    await flush(40);
    t.viewer.helper().emit('clip', { t: 'clip', text: b64('after resume') });
    await flush(40);
    expect(t.host.helper().calls.filter((c) => c[0] === 'clipSet').pop()[1].text).toBe('after resume');
  });

  it('a pasted item is not sent back (no echo)', async () => {
    const t = await setup();
    t.viewer.helper().emit('clip', { t: 'clip', text: b64('ping') });
    await flush(40);
    t.host.helper().emit('clip', { t: 'clip', text: b64('ping') });
    await flush(40);
    expect(t.pair.host.sent.filter((m) => m.t === 'clip.text')).toHaveLength(0);
  });

  it('files and folders copied on one side arrive in a folder on the other, then sit on its clipboard', async () => {
    const t = await setup();
    const src = path.join(t.root, 'src');
    fs.mkdirSync(path.join(src, 'docs', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(src, 'docs', 'a.txt'), 'alpha');
    fs.writeFileSync(path.join(src, 'docs', 'sub', 'b.bin'), crypto.randomBytes(70_000));
    fs.writeFileSync(path.join(src, 'top.txt'), 'top');
    const done = new Promise((r) => t.host.clips.once('filesDone', r));
    t.viewer.helper().emit('clip', { t: 'clip', files: [b64(path.join(src, 'docs')), b64(path.join(src, 'top.txt'))] });
    const f = await done;
    expect(f.native).toBe(true);
    expect(fs.readFileSync(path.join(f.folder, 'docs', 'a.txt'), 'utf8')).toBe('alpha');
    expect(fs.readFileSync(path.join(f.folder, 'docs', 'sub', 'b.bin'))).toEqual(fs.readFileSync(path.join(src, 'docs', 'sub', 'b.bin')));
    expect(fs.readFileSync(path.join(f.folder, 'top.txt'), 'utf8')).toBe('top');
    const set = t.host.helper().calls.filter((c) => c[0] === 'clipSet').pop()[1];
    expect(set).toEqual({ kind: 'files', paths: [path.join(f.folder, 'docs'), path.join(f.folder, 'top.txt')] });
    expect(kinds(t.pair.host).find((e) => e.kind === 'clip.files.done')).toMatchObject({ items: 5 });
  });

  it('a large set of copied files waits for the paste click', async () => {
    const t = await setup();
    t.host.clips.autoFetchBytes = 10;
    const src = path.join(t.root, 'big.bin');
    fs.writeFileSync(src, crypto.randomBytes(5000));
    const offered = new Promise((r) => t.host.clips.once('files', r));
    t.viewer.helper().emit('clip', { t: 'clip', files: [b64(src)] });
    const o = await offered;
    await flush(40);
    expect(t.pair.host.sent.some((m) => m.t === 'clip.files.get')).toBe(false);
    const done = new Promise((r) => t.host.clips.once('filesDone', r));
    await t.host.clips.fetch(o.id);
    const f = await done;
    expect(fs.statSync(path.join(f.folder, 'big.bin')).size).toBe(5000);
  });

  it('peer files outside a paste are refused: a clip offer that nobody fetched does not land', async () => {
    const t = await setup();
    t.pair.viewer.port.send(t.sid, 1, 'file.offer', { id: 'ft_00112233445566aa', name: 'x', size: 3, sha256: 'a'.repeat(64), chunks: 1, clipId: 'cf_0011223344556677', rel: 'x' });
    await flush(40);
    expect(kinds(t.pair.host).find((e) => e.kind === 'file.refused')).toMatchObject({ clip: true });
  });

  it('without a native clipboard the window takes the item once', async () => {
    const t = await setup({ hostSupport: MAC });
    const got = new Promise((r) => t.host.clips.once('clip', r));
    t.viewer.helper().emit('clip', { t: 'clip', text: b64('to the browser') });
    const c = await got;
    expect(t.host.clips.take(c.id)).toMatchObject({ kind: 'text', text: 'to the browser', from: 'Rita' });
    expect(() => t.host.clips.take(c.id)).toThrow(/gone/);
  });

  it('decodes the helper messages', () => {
    expect(decodeNative({ files: [b64('C:\\a b\\c.txt')] })).toEqual({ kind: 'files', paths: ['C:\\a b\\c.txt'] });
    expect(decodeNative({ text: b64('hi') })).toEqual({ kind: 'text', text: 'hi', html: undefined });
    expect(decodeNative({ tooLarge: 'text' })).toBe(null);
  });
});
