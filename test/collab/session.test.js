import { describe, expect, it } from 'vitest';
import { LendPeer } from '../../ui/lend/core/session.js';
import { COLLAB_CODEC, COLLAB_LIMITS } from '../../ui/lend/collab/frames.js';
import { CollabGuest, CollabHost } from '../../ui/lend/collab/session.js';
import { Emitter } from '../../ui/lend/core/emitter.js';
import { linkPair, until, tick } from '../lend/helpers.js';

/** A fake host engine: files on a Map, every command recorded. */
class FakeEngine extends Emitter {
  constructor() {
    super();
    this.files = new Map([['index.html', '<h1>Hi</h1>\n']]);
    this.calls = [];
    this.seq = 3;
  }
  async command(type, data) {
    this.calls.push({ type, data });
    if (type === 'files.read') {
      if (!this.files.has(data.path)) throw Object.assign(new Error('not found'), { code: 'not_found' });
      return { path: data.path, content: this.files.get(data.path) };
    }
    if (type === 'files.write') {
      this.files.set(data.path, data.content);
      return { ok: true };
    }
    if (type === 'job.create') return { jobId: 'j_1' };
    if (type === 'chat.send') return { id: 'm1' };
    return {};
  }
  hello() {
    return Promise.resolve({ kind: 'hello', protocol: 1, version: '0.1.0', demo: false, lend: false, lastSeq: this.seq, state: { lastSeq: this.seq, crew: [] } });
  }
  event(type, data) {
    this.emit('event', { kind: 'event', event: { seq: ++this.seq, ts: new Date().toISOString(), type, data } });
  }
}

function connect(host, name) {
  const [a, b] = linkPair();
  const opts = { codec: COLLAB_CODEC, limits: COLLAB_LIMITS };
  const hostPeer = new LendPeer(a, opts);
  const guestPeer = new LendPeer(b, opts);
  const guest = new CollabGuest({ peer: guestPeer, name, color: '#123456' });
  const record = host.addGuest(hostPeer);
  hostPeer.confirmLocal();
  guestPeer.confirmLocal();
  return { guest, record };
}

/** Types like an editor: the cursor stays in front of the same character while others edit. */
async function typeInto(handle, at, text) {
  const anchor = handle.anchor(at);
  for (const ch of text) {
    handle.localEdit(handle.offset(anchor), 0, ch);
    await tick(0);
  }
}

describe('Code together session', () => {
  it('welcomes a guest with the host engine state and relays crew events', async () => {
    const engine = new FakeEngine();
    const host = new CollabHost({ hive: engine, name: 'Hana' });
    const { guest } = connect(host, 'Ana');
    await until(() => guest.hostHello);
    expect(guest.me).toMatchObject({ id: 'g1' });
    expect(guest.role).toBe('viewer');
    const seen = [];
    guest.on('engine', (f) => seen.push(f.event?.type));
    engine.event('task.status', { taskId: 't1', status: 'running' });
    await until(() => seen.length);
    expect(seen).toEqual(['task.status']);
    await until(() => guest.peers.length === 2);
    expect(guest.peers.map((p) => [p.name, p.role])).toEqual([['Hana', 'host'], ['Ana', 'viewer']]);
  });

  it('a viewer can chat but cannot send commands to the crew', async () => {
    const engine = new FakeEngine();
    const host = new CollabHost({ hive: engine });
    const { guest } = connect(host, 'Ana');
    await until(() => guest.hostHello);
    await expect(guest.command('job.create', { request: 'a page' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(guest.command('settings.set', { approvalMode: false })).rejects.toMatchObject({ code: 'forbidden' });
    await guest.command('chat.send', { channel: 'general', text: 'hello' });
    expect(engine.calls.filter((c) => c.type !== 'files.read')).toEqual([{ type: 'chat.send', data: { channel: 'general', text: 'Ana: hello' } }]);
  });

  it('a collaborator can ask the crew after the host promotes them', async () => {
    const engine = new FakeEngine();
    const host = new CollabHost({ hive: engine });
    const { guest, record } = connect(host, 'Bo');
    await until(() => guest.hostHello);
    host.setRole(record.id, 'collaborator');
    await until(() => guest.role === 'collaborator');
    await expect(guest.command('job.create', { request: 'a page' })).resolves.toEqual({ jobId: 'j_1' });
  });

  it('host and two guests edit one file at once and converge, saved on the host', async () => {
    const engine = new FakeEngine();
    const host = new CollabHost({ hive: engine });
    const a = connect(host, 'Ana');
    const b = connect(host, 'Bo');
    await until(() => a.guest.hostHello && b.guest.hostHello);
    host.setRole(a.record.id, 'collaborator');
    host.setRole(b.record.id, 'collaborator');
    await until(() => a.guest.canEdit && b.guest.canEdit);
    const hh = await host.docs.open('index.html');
    const ha = await a.guest.docs.open('index.html');
    const hb = await b.guest.docs.open('index.html');
    expect(ha.text()).toBe('<h1>Hi</h1>\n');
    await Promise.all([typeInto(ha, 4, 'Ana '), typeInto(hb, 0, '<!-- Bo -->'), typeInto(hh, hh.text().length, '<p>host</p>\n')]);
    await until(() => ha.text() === hh.text() && hb.text() === hh.text() && hh.text().includes('host') && hh.text().includes('Ana') && hh.text().includes('Bo'));
    expect(hh.text()).toBe('<!-- Bo --><h1>Ana Hi</h1>\n<p>host</p>\n');
    await hb.save();
    expect(engine.files.get('index.html')).toBe(hh.text());
    expect(engine.calls.find((c) => c.type === 'files.write').data.as).toEqual({ id: b.record.id, name: 'Bo' });
  });

  it('drops edits from a viewer', async () => {
    const engine = new FakeEngine();
    const host = new CollabHost({ hive: engine });
    const { guest } = connect(host, 'Ana');
    await until(() => guest.hostHello);
    const hg = await guest.docs.open('index.html');
    const hh = await host.docs.open('index.html');
    hg.localEdit(0, 0, 'X');
    await tick(20);
    expect(hh.text()).toBe('<h1>Hi</h1>\n');
  });

  it('a crew write reaches every open copy of the file', async () => {
    const engine = new FakeEngine();
    const host = new CollabHost({ hive: engine });
    const { guest } = connect(host, 'Ana');
    await until(() => guest.hostHello);
    const hg = await guest.docs.open('index.html');
    await host.docs.open('index.html');
    engine.event('file.changed', { path: 'index.html', op: 'modify', workerId: 'dev', content: '<h1>Hello crew</h1>\n' });
    await until(() => hg.text() === '<h1>Hello crew</h1>\n');
  });

  it('relays presence with the sender id and tells everyone who left', async () => {
    const engine = new FakeEngine();
    const host = new CollabHost({ hive: engine });
    const a = connect(host, 'Ana');
    const b = connect(host, 'Bo');
    await until(() => a.guest.hostHello && b.guest.hostHello);
    a.guest.setPresence({ file: 'index.html', sel: [{ a: ['h', 2], h: ['h', 2] }] });
    await until(() => b.guest.presence.get(a.record.id));
    expect(b.guest.presence.get(a.record.id).file).toBe('index.html');
    a.guest.leave();
    await until(() => !b.guest.presence.has(a.record.id) && b.guest.peers.length === 2);
  });
});
