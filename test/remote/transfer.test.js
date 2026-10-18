import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { describe, it, expect, afterEach } from 'vitest';
import { RemoteDesk } from '../../src/remote/desk.js';
import { FileTransfers, CHUNK, safeName, peerFolder, freePath } from '../../src/remote/transfer.js';
import { createInprocPair, flush } from './inproc-port.js';
import { tmpDir, waitFor } from '../helpers.js';

const VIEW = { view: true, control: false, kind: null, hotkey: false, indicator: false, reason: 'test' };
const dirs = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function setup() {
  const pair = createInprocPair();
  const hostDesk = new RemoteDesk({ p2p: pair.host.port, support: VIEW });
  const viewDesk = new RemoteDesk({ p2p: pair.viewer.port, support: VIEW });
  const root = tmpDir('hivedesk-remote-');
  dirs.push(root);
  const hostFiles = new FileTransfers({ p2p: pair.host.port, desk: hostDesk, downloadsDir: path.join(root, 'host-dl') });
  const viewFiles = new FileTransfers({ p2p: pair.viewer.port, desk: viewDesk, downloadsDir: path.join(root, 'viewer-dl') });
  return { pair, hostDesk, viewDesk, hostFiles, viewFiles, root, sid: pair.open() };
}

async function grant(t, { files = true } = {}) {
  t.viewDesk.ask(t.sid, { files: true });
  await flush();
  const [rq] = t.hostDesk.snapshot().requests;
  t.hostDesk.answer(rq.id, { allow: true, view: true, files });
  await flush();
}

function makeFile(dir, name, size) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, crypto.randomBytes(size));
  return p;
}

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

describe('remote file transfer', () => {
  it('sends a file in 64 KB chunks after the receiver accepts, and checks its SHA-256', async () => {
    const t = setup();
    await grant(t);
    const src = makeFile(t.root, 'report.bin', CHUNK * 3 + 123);
    const incoming = [];
    t.hostFiles.on('incoming', (f) => incoming.push(f));
    const offer = await t.viewFiles.offer(t.sid, src);
    await flush();
    expect(incoming).toEqual([expect.objectContaining({ name: 'report.bin', size: CHUNK * 3 + 123, from: 'Rita' })]);
    const received = new Promise((r) => t.hostFiles.once('received', r));
    await t.hostFiles.answer(offer.id, true);
    const got = await received;
    expect(sha(got.path)).toBe(sha(src));
    expect(got.path).toContain(path.join('host-dl', peerFolder('Rita', t.pair.viewer.peerId)));
    expect(fs.readdirSync(path.dirname(got.path)).some((f) => f.endsWith('.part'))).toBe(false);
    const chunks = t.pair.viewer.sent.filter((m) => m.t === 'file.chunk');
    expect(chunks).toHaveLength(4);
    expect(chunks.every((m) => m.stream === 2)).toBe(true);
    await waitFor(() => t.pair.auditKinds(t.pair.viewer).includes('file.sent'));
    expect(t.pair.host.audit.map((l) => l.entry).find((e) => e.kind === 'file.receive')).toMatchObject({ size: CHUNK * 3 + 123, sha256: sha(src) });
  });

  it('works in the other direction too, and for an empty file', async () => {
    const t = setup();
    await grant(t);
    const src = makeFile(t.root, 'empty.txt', 0);
    const incoming = new Promise((r) => t.viewFiles.once('incoming', r));
    await t.hostFiles.offer(t.sid, src);
    const f = await incoming;
    const received = new Promise((r) => t.viewFiles.once('received', r));
    await t.viewFiles.answer(f.id, true);
    expect(fs.statSync((await received).path).size).toBe(0);
  });

  it('nothing is written when the receiver declines', async () => {
    const t = setup();
    await grant(t);
    const src = makeFile(t.root, 'a.bin', 1000);
    const offer = await t.viewFiles.offer(t.sid, src);
    await flush();
    await t.hostFiles.answer(offer.id, false);
    await flush();
    expect(fs.existsSync(path.join(t.root, 'host-dl'))).toBe(false);
    expect(t.pair.viewer.sent.some((m) => m.t === 'file.chunk')).toBe(false);
  });

  it('needs the file permission: no offer leaves without it, and a forced one is refused', async () => {
    const t = setup();
    await grant(t, { files: false });
    const src = makeFile(t.root, 'a.bin', 10);
    await expect(t.viewFiles.offer(t.sid, src)).rejects.toThrow(/not allowed/);
    const incoming = [];
    t.hostFiles.on('incoming', (f) => incoming.push(f));
    t.pair.viewer.port.send(t.sid, 1, 'file.offer', { id: 'ft_0123456789abcdef', name: 'x', size: 10, sha256: 'a'.repeat(64), chunks: 1 });
    await flush();
    expect(incoming).toHaveLength(0);
    expect(t.pair.auditKinds(t.pair.host)).toContain('file.refused');
  });

  it('a corrupted transfer is thrown away', async () => {
    const t = setup();
    await grant(t);
    const src = makeFile(t.root, 'b.bin', 5000);
    const offer = await t.viewFiles.offer(t.sid, src);
    await flush();
    // Tamper with the chunk on the way.
    t.pair.hold.drop = (type, body) => { if (type === 'file.chunk') body.data = Buffer.alloc(5000, 7).toString('base64'); return false; };
    await t.hostFiles.answer(offer.id, true);
    await waitFor(() => t.pair.auditKinds(t.pair.host).includes('file.failed'));
    const dir = path.join(t.root, 'host-dl', peerFolder('Rita', t.pair.viewer.peerId));
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('resumes from the last written chunk when the same file is offered again after a disconnect', async () => {
    const t = setup();
    await grant(t);
    const src = makeFile(t.root, 'big.bin', CHUNK * 20 + 5);
    const offer = await t.viewFiles.offer(t.sid, src);
    await flush();
    let seen = 0;
    t.pair.hold.drop = (type) => type === 'file.chunk' && ++seen > 5;
    await t.hostFiles.answer(offer.id, true);
    await waitFor(() => seen > 5);
    await flush();
    t.pair.close(t.sid);
    expect(t.pair.auditKinds(t.pair.host)).toContain('file.paused');
    t.pair.hold.drop = null;
    t.sid = t.pair.open();
    await grant(t);
    const received = new Promise((r) => t.hostFiles.once('received', r));
    await t.viewFiles.offer(t.sid, src);
    const got = await received;
    expect(sha(got.path)).toBe(sha(src));
    const resume = t.pair.host.audit.map((l) => l.entry).find((e) => e.kind === 'file.resume');
    expect(resume.from).toBe(5);
  });

  it('keeps peer file names inside the download folder', () => {
    expect(safeName('../../etc/passwd')).toBe('passwd');
    expect(safeName('..\\..\\Windows\\win.ini')).toBe('win.ini');
    expect(safeName('CON')).toBe('file_CON');
    expect(safeName('nul.txt')).toBe('file_nul.txt');
    expect(safeName('a<b>:c"d|e?f*g')).toBe('a_b__c_d_e_f_g');
    expect(safeName('...')).toBe('file');
    expect(safeName('x\u0000y')).toBe('x_y');
    expect(peerFolder('../Rita', 'hd1abcdef123456')).toBe('Rita-123456');
    const d = tmpDir('hivedesk-free-');
    dirs.push(d);
    fs.writeFileSync(path.join(d, 'a.txt'), '');
    expect(path.basename(freePath(d, 'a.txt'))).toBe('a (1).txt');
  });
});
