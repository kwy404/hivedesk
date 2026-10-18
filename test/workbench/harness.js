// A real engine with the workbench registered, for the workbench tests.
import fs from 'node:fs';
import path from 'node:path';
import { startHive } from '../../src/index.js';
import { createFakeBrain } from '../../src/brain/fake.js';
import registerWorkbench from '../../src/workbench/index.js';
import { tmpDir } from '../helpers.js';

export async function startBench(opts = {}) {
  const dir = tmpDir('hivedesk-wb-');
  const home = tmpDir('hivedesk-wb-home-');
  const app = await startHive({ dir, brain: createFakeBrain({ id: 'fake', respond: () => ({ tool: 'done', args: { summary: 'ok' } }) }), home, city: false, memoryHome: null });
  const wb = registerWorkbench({
    bus: app.bus,
    toolbox: app.toolbox,
    approvals: app.approvals,
    server: { command: app.server.command, route: app.server.route },
    config: { dir, home, workspace: app.paths.workspace },
    p2p: opts.p2p || null,
    ptyImporter: opts.ptyImporter,
    forceBasicTerminal: opts.forceBasicTerminal
  });
  const ws = app.paths.workspace;
  const run = (type, data = {}, client = null) => app.server.runCommand(type, data, client);
  return {
    app, wb, dir, home, ws, run,
    write(rel, text) {
      const abs = path.join(ws, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, text);
    },
    async close() {
      await wb.close();
      await app.close();
    }
  };
}

/** A fake WebSocket client: collects the `wb` frames sent to it. */
export function fakeClient(id = 'c1', origin) {
  const frames = [];
  const handlers = new Map();
  return {
    id,
    origin,
    frames,
    conn: {
      sendJson(f) { frames.push(f); return true; },
      on(ev, fn) { handlers.set(ev, fn); }
    },
    closeConn() { handlers.get('close')?.(); },
    of(type) { return frames.filter((f) => f.kind === 'wb' && f.type === type).map((f) => f.data); }
  };
}

/** A stand-in for the P2P plane of Stream 2: grants in memory, messages recorded. */
export function fakeP2p({ peers = [] } = {}) {
  const grants = [];
  const sent = [];
  const audited = [];
  let n = 0;
  const listeners = new Set();
  return {
    grants, sent, audited,
    peers: () => peers,
    grant(req) {
      const g = { id: `gr_${String(++n).padStart(12, 'a')}`, peerId: req.peerId, capability: req.capability, grantedBy: 'user', grantedAt: new Date().toISOString(), expiresAt: req.expiresAt, scope: req.scope };
      grants.push(g);
      return g;
    },
    revoke(id) {
      const g = grants.find((x) => x.id === id);
      if (g && !g.revokedAt) {
        g.revokedAt = new Date().toISOString();
        for (const fn of listeners) fn({ grantId: id, revokedAt: g.revokedAt });
      }
    },
    grantsFor: (peerId) => grants.filter((g) => g.peerId === peerId),
    send(peerId, msg) { sent.push({ peerId, ...msg }); return true; },
    audit: (e) => audited.push(e),
    onGrantChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /** A grant the host gave in the join dialog (workspace.read and so on). */
    give(peerId, name, { expiresAt = null, scope = 'standing' } = {}) {
      const g = { id: `gr_${String(++n).padStart(12, 'b')}`, peerId, capability: { name }, grantedBy: 'user', grantedAt: new Date().toISOString(), expiresAt, scope };
      grants.push(g);
      return g;
    }
  };
}

export const PEER_A = 'hd1' + 'a'.repeat(49);
export const PEER_B = 'hd1' + 'b'.repeat(49);
