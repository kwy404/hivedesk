import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { startBench, fakeClient, fakeP2p, PEER_A, PEER_B } from './harness.js';
import { TextDoc } from '../../ui/lend/collab/crdt.js';
import { tmpDir } from '../helpers.js';

const until = async (fn, ms = 5000) => {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 15));
  }
};

describe('peers reach the workbench only through grants', () => {
  let b;
  let p2p;
  const peers = [{ peerId: PEER_A, name: 'Rita', online: true }, { peerId: PEER_B, name: 'Bo', online: true }];
  beforeEach(async () => {
    p2p = fakeP2p({ peers });
    b = await startBench({ p2p });
    b.write('index.html', '<p>hi</p>\n');
  });
  afterEach(async () => { await b.close(); });

  it('refuses a peer without a grant, an expired grant and a revoked grant', async () => {
    const rita = fakeClient('r', { kind: 'peer', peerId: PEER_A });
    await expect(b.run('wb.fs.read', { path: 'index.html' }, rita)).rejects.toMatchObject({ code: 'not_granted' });
    const g = p2p.give(PEER_A, 'workspace.read', { expiresAt: new Date(Date.now() - 1000).toISOString(), scope: 'session' });
    await expect(b.run('wb.fs.read', { path: 'index.html' }, rita)).rejects.toMatchObject({ code: 'not_granted' });
    g.expiresAt = new Date(Date.now() + 60_000).toISOString();
    expect((await b.run('wb.fs.read', { path: 'index.html' }, rita)).content).toBe('<p>hi</p>\n');
    g.revokedAt = new Date().toISOString();
    await expect(b.run('wb.fs.read', { path: 'index.html' }, rita)).rejects.toMatchObject({ code: 'not_granted' });
    // A grant for another peer is not mine.
    p2p.give(PEER_B, 'workspace.read');
    await expect(b.run('wb.fs.read', { path: 'index.html' }, rita)).rejects.toMatchObject({ code: 'not_granted' });
    // No identity at all is refused before anything else.
    await expect(b.run('wb.fs.read', { path: 'index.html' }, fakeClient('x', { kind: 'peer' }))).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('lets a reader read and search the workspace but not write, and never other roots or settings', async () => {
    const proj = tmpDir('hivedesk-wb-other-');
    const { root } = await b.run('wb.roots.add', { path: proj });
    p2p.give(PEER_A, 'workspace.read');
    const rita = fakeClient('r', { kind: 'peer', peerId: PEER_A });
    expect((await b.run('wb.fs.list', {}, rita)).entries.map((e) => e.name)).toEqual(['index.html']);
    expect((await b.run('wb.search', { query: 'hi', wait: true }, rita)).hits).toBe(1);
    await expect(b.run('wb.fs.list', { root: root.id }, rita)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(b.run('wb.fs.write', { path: 'x.txt', content: 'x' }, rita)).rejects.toMatchObject({ code: 'not_granted' });
    for (const type of ['wb.settings.set', 'wb.roots.add', 'wb.roots.list', 'wb.fs.watch', 'wb.peers']) {
      await expect(b.run(type, { path: proj }, rita)).rejects.toMatchObject({ code: 'forbidden' });
    }
    const info = await b.run('wb.info', {}, rita);
    expect(info.roots).toEqual([{ id: 'ws', name: 'workspace', workspace: true }]);
    expect(JSON.stringify(info)).not.toContain(proj);
  });

  it('sends every write of a proposer through host approval, even a new file', async () => {
    p2p.give(PEER_A, 'workspace.propose');
    const rita = fakeClient('r', { kind: 'peer', peerId: PEER_A });
    const pending = b.run('wb.fs.write', { path: 'new.txt', content: 'from rita\n' }, rita);
    await until(() => b.app.approvals.pending.size === 1);
    const [id, p] = [...b.app.approvals.pending][0];
    expect(p.approval).toMatchObject({ tool: 'workbench.write', workerId: 'peer:Rita', strict: true, origin: { kind: 'peer', label: 'Rita' } });
    b.app.approvals.approveAll('auto');
    expect(b.app.approvals.pending.size).toBe(1);
    expect(p.approval.summary).toContain('Rita');
    expect(p.approval.diff).toContain('+from rita');
    expect(fs.existsSync(path.join(b.ws, 'new.txt'))).toBe(false);
    b.app.approvals.resolve(id, true, null, 'user');
    await pending;
    expect(fs.readFileSync(path.join(b.ws, 'new.txt'), 'utf8')).toBe('from rita\n');

    const del = b.run('wb.fs.delete', { path: 'index.html' }, rita);
    await until(() => b.app.approvals.pending.size === 1);
    b.app.approvals.resolve([...b.app.approvals.pending.keys()][0], false, 'no thanks', 'user');
    await expect(del).rejects.toMatchObject({ code: 'rejected' });
    expect(fs.existsSync(path.join(b.ws, 'index.html'))).toBe(true);
  });
});

describe('editing together through the engine', () => {
  let b;
  let p2p;
  beforeEach(async () => {
    p2p = fakeP2p({ peers: [{ peerId: PEER_A, name: 'Rita', online: true }, { peerId: PEER_B, name: 'Bo', online: true }] });
    b = await startBench({ p2p });
    b.write('app.js', 'let x = 1;\n');
  });
  afterEach(async () => { await b.close(); });

  /** A replica the way the browser keeps one (ui/lend/collab/docs.js). */
  async function replica(client, peer) {
    const sent = [];
    const pushClient = peer ? { ...client, push: (type, data) => { sent.push({ type, data }); return true; } } : client;
    const r = await b.run('wb.doc.open', { path: 'app.js' }, pushClient);
    const doc = TextDoc.fromSnapshot(r.snap, r.client);
    return { r, doc, client: pushClient, sent, frames: () => (peer ? sent : client.frames.filter((f) => f.kind === 'wb').map((f) => ({ type: f.type, data: f.data }))) };
  }

  it('routes edits between a window here and a peer with workspace.propose, and saves with approval', async () => {
    p2p.give(PEER_A, 'workspace.propose');
    const me = await replica(fakeClient('me'));
    const rita = await replica(fakeClient('r', { kind: 'peer', peerId: PEER_A }), true);
    expect(me.r.client).not.toBe(rita.r.client);
    expect(rita.doc.text()).toBe('let x = 1;\n');

    const ops = rita.doc.edit(8, 1, '2');
    await b.run('wb.doc.ops', { path: 'app.js', ops }, rita.client);
    await until(() => me.frames().some((f) => f.type === 'doc.ops'));
    me.doc.apply(me.frames().find((f) => f.type === 'doc.ops').data.ops);
    expect(me.doc.text()).toBe('let x = 2;\n');

    // An insert under someone else's id is refused.
    const forged = me.doc.edit(0, 0, '// ');
    await expect(b.run('wb.doc.ops', { path: 'app.js', ops: forged }, rita.client)).rejects.toMatchObject({ code: 'forbidden' });

    const save = b.run('wb.doc.save', { path: 'app.js' }, rita.client);
    await until(() => b.app.approvals.pending.size === 1);
    b.app.approvals.resolve([...b.app.approvals.pending.keys()][0], true, null, 'user');
    await save;
    expect(fs.readFileSync(path.join(b.ws, 'app.js'), 'utf8')).toBe('let x = 2;\n');
  });

  it('lets a reader follow edits and cursors but not edit or save', async () => {
    p2p.give(PEER_B, 'workspace.read');
    const me = await replica(fakeClient('me'));
    const bo = await replica(fakeClient('bo', { kind: 'peer', peerId: PEER_B }), true);
    expect(bo.r.canEdit).toBe(false);
    const ops = me.doc.edit(0, 0, '// hi\n');
    await b.run('wb.doc.ops', { path: 'app.js', ops }, me.client);
    await until(() => bo.sent.some((f) => f.type === 'doc.ops'));
    bo.doc.apply(bo.sent.find((f) => f.type === 'doc.ops').data.ops);
    expect(bo.doc.text()).toBe('// hi\nlet x = 1;\n');
    await expect(b.run('wb.doc.ops', { path: 'app.js', ops: bo.doc.edit(0, 0, 'x') }, bo.client)).rejects.toMatchObject({ code: 'not_granted' });
    await expect(b.run('wb.doc.save', { path: 'app.js' }, bo.client)).rejects.toMatchObject({ code: 'not_granted' });
    await b.run('wb.doc.presence', { file: 'app.js', sel: [{ a: bo.doc.anchorAt(2), h: bo.doc.anchorAt(3) }] }, bo.client);
    await until(() => me.frames().some((f) => f.type === 'doc.presence'));
    expect(me.frames().find((f) => f.type === 'doc.presence').data).toMatchObject({ from: bo.r.client, file: 'app.js' });
  });

  it('takes a crew change into a clean document and keeps unsaved edits otherwise', async () => {
    const me = await replica(fakeClient('me'));
    await b.app.toolbox.execute('write_file', { path: 'app.js', content: 'let x = 3;\n' }, { workerId: 'dev', approval: false });
    await until(() => me.frames().some((f) => f.type === 'doc.ops'));
    const f = me.frames().find((x) => x.type === 'doc.ops');
    me.doc.apply(f.data.ops);
    expect(me.doc.text()).toBe('let x = 3;\n');
    expect(f.data.saved).toBe('let x = 3;\n');
    await b.run('wb.doc.ops', { path: 'app.js', ops: me.doc.edit(0, 0, '/* mine */') }, me.client);
    await b.app.toolbox.execute('write_file', { path: 'app.js', content: 'let x = 4;\n' }, { workerId: 'dev', approval: false });
    await until(() => me.frames().some((x) => x.type === 'doc.disk'));
    expect(me.frames().find((x) => x.type === 'doc.disk').data).toMatchObject({ path: 'app.js', by: 'dev' });
  });
});
