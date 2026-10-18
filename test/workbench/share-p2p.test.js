// Terminal sharing between two real engines: the host shares one terminal with a session grant
// (limits.terminalId) through the node, the guest attaches and types over the encrypted session,
// and a revoke closes it. Peers never reach the local workbench commands.
import { describe, it, expect } from 'vitest';
import { startHive } from '../../src/index.js';
import { createFakeBrain } from '../../src/brain/fake.js';
import { tmpDir, waitFor } from '../helpers.js';

const brain = () => createFakeBrain({ respond: () => ({ tool: 'done', args: { summary: 'ok' } }) });
const cmd = (app, type, data = {}, client = null) => app.router.dispatch(type, data, { origin: { kind: 'user' }, client });

async function pair() {
  const host = await startHive({ dir: tmpDir(), home: tmpDir(), brain: brain(), name: 'Hana PC' });
  const guest = await startHive({ dir: tmpDir(), home: tmpDir(), brain: brain(), name: 'Rita PC' });
  const lan = await cmd(host, 'p2p.lan.listen', { host: '127.0.0.1', port: 0 });
  const inv = await cmd(host, 'p2p.invite.create', { caps: [{ name: 'city.view' }] });
  const join = await cmd(guest, 'p2p.join', { words: inv.words.join(' '), via: 'lan', address: `127.0.0.1:${lan.port}` });
  const req = await waitFor(async () => (await cmd(host, 'p2p.join.requests')).requests[0]);
  expect(req.sas).toEqual(join.sas);
  await cmd(host, 'p2p.join.answer', { requestId: req.requestId, accept: true, sasMatches: true, caps: [{ capability: { name: 'city.view' } }] });
  const guestId = guest.p2p.node().info().peerId;
  const hostId = host.p2p.node().info().peerId;
  await waitFor(() => host.p2p.node().sessionOf(guestId)?.online && guest.p2p.node().sessionOf(hostId)?.online);
  return { host, guest, guestId, hostId, close: async () => { await guest.close(); await host.close(); } };
}

describe('terminal sharing over p2p sessions', () => {
  it('shares one terminal with a session grant, the guest attaches and types, and a revoke closes it', async () => {
    const e = await pair();
    const frames = [];
    const off = e.guest.bus.onLive((type, data) => { if (type === 'p2p.workbench') frames.push(data); });
    const client = { id: 'win1', push: () => true };
    try {
      const t = await cmd(e.host, 'wb.term.open', {}, client);
      const share = await cmd(e.host, 'wb.term.share', { termId: t.termId, peerId: e.guestId, mode: 'write', minutes: 5 });
      const grant = e.host.p2p.node().grantsOf(e.guestId).find((g) => g.id === share.grantId);
      expect(grant).toMatchObject({ scope: 'session', capability: { name: 'terminal.share.write', limits: { terminalId: t.termId } } });
      await waitFor(() => frames.find((f) => f.t === 'term.offer' && f.body.termId === t.termId));
      await cmd(e.guest, 'p2p.workbench.send', { peerId: e.hostId, t: 'term.attach', body: { termId: t.termId } });
      await waitFor(() => frames.find((f) => f.t === 'term.reply' && f.body.ok && f.body.result?.termId === t.termId));
      await cmd(e.guest, 'p2p.workbench.send', { peerId: e.hostId, t: 'term.input', body: { termId: t.termId, data: 'echo shared-ok\r\n' } });
      await waitFor(() => frames.filter((f) => f.t === 'term.data').map((f) => f.body.data).join('').includes('shared-ok'), { timeout: 20000 });
      // A peer can never open a terminal or run a local workbench command.
      await cmd(e.guest, 'p2p.workbench.send', { peerId: e.hostId, t: 'wb.cmd', body: { id: 'c1', type: 'wb.term.open', data: {} } });
      await waitFor(() => frames.find((f) => f.t === 'wb.reply' && f.body.re === 'c1' && f.body.ok === false));
      await cmd(e.host, 'p2p.revoke', { grantId: share.grantId });
      await waitFor(() => frames.find((f) => f.t === 'term.closed' && f.body.termId === t.termId));
      const audit = e.host.p2p.node().audit.tail(100).map((a) => a.entry.type);
      expect(audit).toEqual(expect.arrayContaining(['terminal.share.start', 'terminal.share.attach']));
      await cmd(e.host, 'wb.term.close', { termId: t.termId });
    } finally {
      off();
      await e.close();
    }
  });
});
