// Remote desktop between two real engines: dial by the 10 digit address over a real p2p session
// (ws-lan on localhost), the host's dialog, the grants of the node, revoke, and the rate limits.
import { describe, it, expect } from 'vitest';
import { startHive } from '../../src/index.js';
import { createFakeBrain } from '../../src/brain/fake.js';
import { connectLan } from '../../src/p2p/transport/ws-lan.js';
import { formatAddress } from '../../src/remote/address.js';
import { tmpDir, waitFor } from '../helpers.js';

const brain = () => createFakeBrain({ respond: () => ({ tool: 'done', args: { summary: 'ok' } }) });
const cmd = (app, type, data = {}) => app.router.dispatch(type, data, { origin: { kind: 'user' } });

async function two() {
  const host = await startHive({ dir: tmpDir(), home: tmpDir(), brain: brain(), name: 'Hana PC' });
  const viewer = await startHive({ dir: tmpDir(), home: tmpDir(), brain: brain(), name: 'Rita PC' });
  const lan = await cmd(host, 'p2p.lan.listen', { host: '127.0.0.1', port: 0 });
  return { host, viewer, lan: `127.0.0.1:${lan.port}`, close: async () => { await viewer.close(); await host.close(); } };
}

describe('remote desktop over the p2p control plane', () => {
  it('dials by address, the host clicks Accept, the node holds the grants, and Stop ends them', async () => {
    const e = await two();
    try {
      const hostState = await cmd(e.host, 'remote.state');
      expect(hostState).toMatchObject({ available: true, canDial: true, listening: false });
      // Not listening: the handshake by address is not answered.
      await expect(cmd(e.viewer, 'remote.connect', { address: hostState.address, lan: e.lan })).rejects.toThrow();
      await cmd(e.host, 'remote.listen', { on: true });
      const r = await cmd(e.viewer, 'remote.connect', { address: formatAddress(hostState.address), lan: e.lan, clipboard: true });
      expect(r.sessionId).toMatch(/^ss_/);
      const req = await waitFor(async () => (await cmd(e.host, 'remote.state')).requests[0]);
      expect(req).toMatchObject({ name: 'Rita PC', wants: 'view' });
      expect(req.words).toHaveLength(6);
      // Nothing is granted before the click.
      const viewerId = e.viewer.p2p.node().info().peerId;
      expect(e.host.p2p.node().grantsOf(viewerId)).toHaveLength(0);
      await cmd(e.host, 'remote.answer', { requestId: req.id, allow: true, view: true, clipboard: 'to_viewer', minutes: 5 });
      const grants = e.host.p2p.node().grantsOf(viewerId);
      expect(grants.map((g) => g.capability.name).sort()).toEqual(['clipboard.text', 'remote.view']);
      expect(grants.find((g) => g.capability.name === 'clipboard.text').capability.limits.dir).toBe('to_viewer');
      expect(grants.every((g) => g.scope === 'session' && g.expiresAt)).toBe(true);
      await waitFor(async () => (await cmd(e.viewer, 'remote.state')).views.find((v) => v.state === 'granted'));
      // The host's Stop revokes the grants in the node.
      await cmd(e.host, 'remote.stopAll', { from: 'kill' });
      expect(e.host.p2p.node().grantsOf(viewerId)).toHaveLength(0);
      const audit = e.host.p2p.node().audit.tail(80).map((a) => a.entry.type);
      expect(audit).toEqual(expect.arrayContaining(['address.listen', 'address.session', 'remote.request', 'remote.grant', 'revoke']));
    } finally {
      await e.close();
    }
  });

  it('a published address cannot flood the host: handshakes and dialogs are rate limited', async () => {
    const e = await two();
    try {
      const { address } = await cmd(e.host, 'remote.state');
      await cmd(e.host, 'remote.listen', { on: true });
      const node = e.viewer.p2p.node();
      const results = [];
      for (let i = 0; i < 12; i++) {
        try { await node.dialAddress(address, await connectLan(e.lan)); results.push('ok'); } catch (err) { results.push(err.code || 'failed'); }
      }
      expect(results.filter((x) => x === 'ok').length).toBe(10);
      expect(e.host.p2p.node().audit.tail(200).some((a) => a.entry.type === 'address.rate_limited')).toBe(true);
    } finally {
      await e.close();
    }
  });
});
