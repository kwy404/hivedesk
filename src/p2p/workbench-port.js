// The p2p side of the code workbench (docs/1.0/protocol/workbench.md, "What the workbench needs
// from src/p2p"). Terminal sharing and the workspace commands of a peer travel inside the
// encrypted session; the workbench is the authority for what a peer may do (POLICY in
// src/workbench/origin.js, the terminal grant with limits.terminalId), and the node only grants,
// revokes and audits.
//
// Message types (stream 1):
//   term.offer, term.data, term.closed           host to peer
//   term.attach, term.input, term.detach         peer to host, answered with term.reply { re, ok, result? | error? }
//   wb.cmd { id, type, data }                    peer to host, a wb.* command run as that peer; answered with wb.reply
//   wb.push { type, data }                       host to peer, the frames a command streams (search results, documents)
// On the side that receives host messages they become the live frame p2p.workbench { peerId, t, body },
// and the window sends its own with the command p2p.workbench.send (local user only).

import { registerMessage, checkedJson, STREAM } from './messages.js';

const KB = 1024;
const reg = (type, max, rate, normalize) => registerMessage(type, { stream: STREAM.CONTROL, max, ...(rate ? { rate } : {}), ...(normalize ? { normalize } : {}) });
const text = (max) => (b) => checkedJson(b, { string: max });
reg('term.offer', 4 * KB);
reg('term.attach', 2 * KB, [20, 10_000]);
reg('term.detach', 2 * KB, [20, 10_000]);
reg('term.input', 16 * KB, [200, 1000], text(8 * KB));
reg('term.data', 72 * KB, [400, 1000], text(64 * KB));
reg('term.closed', 2 * KB);
reg('term.reply', 128 * KB, null, text(96 * KB));
reg('wb.cmd', 1024 * KB, [60, 10_000], (b) => checkedJson(b, { string: 1000 * KB, depth: 10 }));
reg('wb.reply', 1100 * KB, null, (b) => checkedJson(b, { string: 1000 * KB, depth: 12, items: 5000, keys: 1000 }));
reg('wb.push', 512 * KB, [400, 1000], (b) => checkedJson(b, { string: 256 * KB, depth: 12, items: 2000, keys: 1000 }));

const PEER_TERM = new Set(['term.attach', 'term.input', 'term.detach']);
const HOST_TERM = new Set(['term.offer', 'term.data', 'term.closed']);
const err = (e) => ({ code: typeof e?.code === 'string' ? e.code.slice(0, 40) : 'failed', message: String(e?.message || e).slice(0, 300) });

/**
 * @param {import('./node.js').P2PNode} node a started node
 * @param {{ live?: (type: string, data: object) => void }} [opts]
 * Returns the WorkbenchP2P object for registerWorkbench, plus attach(workbench) for the routing.
 */
export function createWorkbenchPort(node, opts = {}) {
  const offs = [];
  const grantFns = new Set();
  const on = (ev, fn) => {
    node.on(ev, fn);
    offs.push(() => node.off(ev, fn));
  };
  on('grant.revoked', ({ grant }) => { for (const fn of [...grantFns]) { try { fn({ grantId: grant.id, revokedAt: grant.revokedAt || new Date().toISOString() }); } catch { /* ignore */ } } });

  const port = {
    grant(req) {
      const exp = Date.parse(req?.expiresAt || '');
      const minutes = Number.isFinite(exp) ? Math.max(1, Math.round((exp - Date.now()) / 60_000)) : undefined;
      return node.grant(req.peerId, req.capability, { minutes, scope: 'session' });
    },
    revoke(grantId, reason) {
      try { node.revoke(grantId, reason || 'revoked'); } catch { /* already gone */ }
    },
    grantsFor: (peerId) => node.grantsOf(peerId),
    send(peerId, msg) {
      const t = String(msg?.t || '');
      try {
        if (t.startsWith('wb.')) node.send(peerId, 'wb.push', { type: t.slice(3), data: msg.body ?? {} });
        else node.send(peerId, t, msg.body ?? {});
        return true;
      } catch {
        return false;
      }
    },
    audit(entry) {
      const e = entry && typeof entry === 'object' ? entry : {};
      return node._audit({ ...e, type: String(e.kind || e.type || 'workbench').slice(0, 40) });
    },
    peers: () => node.listPeers().map((p) => ({ peerId: p.identity.peerId, name: p.identity.name, online: p.online })),
    onGrantChange(fn) { grantFns.add(fn); return () => grantFns.delete(fn); },

    /** Routes the peer messages to the workbench (host side) and the host messages to the window (guest side). */
    attach(workbench) {
      for (const t of PEER_TERM) {
        offs.push(node.handle(t, async (msg, ctx) => {
          try {
            const result = await workbench.handlePeerMessage({ peerId: ctx.peerId }, { t, body: msg.body });
            ctx.reply('term.reply', { ok: true, result: result ?? {} });
          } catch (e) {
            ctx.reply('term.reply', { ok: false, error: err(e) });
          }
        }));
      }
      offs.push(node.handle('wb.cmd', async (msg, ctx) => {
        const b = msg.body || {};
        const type = typeof b.type === 'string' ? b.type : '';
        const answer = (body) => { try { node.send(ctx.peerId, 'wb.reply', { re: typeof b.id === 'string' ? b.id.slice(0, 40) : null, ...body }); } catch { /* gone */ } };
        if (!type.startsWith('wb.')) return answer({ ok: false, error: { code: 'bad_request', message: 'not a workbench command' } });
        try {
          const push = (pt, data) => port.send(ctx.peerId, { t: `wb.${pt}`, body: data });
          const result = await workbench.peerCommand({ peerId: ctx.peerId, sessionId: ctx.sessionId, push }, type, b.data && typeof b.data === 'object' ? b.data : {});
          answer({ ok: true, result: result ?? {} });
        } catch (e) {
          answer({ ok: false, error: err(e) });
        }
      }));
      for (const t of [...HOST_TERM, 'term.reply', 'wb.reply', 'wb.push']) {
        offs.push(node.handle(t, (msg, ctx) => opts.live?.('p2p.workbench', { peerId: ctx.peerId, t, body: msg.body })));
      }
      on('peer.offline', (e) => { try { workbench.peerGone({ peerId: e.peerId }); } catch { /* ignore */ } });
      return port;
    },

    /** The window of this engine sends a peer message (the guest side of a shared terminal or a wb command). */
    sendFromWindow(peerId, t, body) {
      if (!PEER_TERM.has(t) && t !== 'wb.cmd') throw Object.assign(new Error(`${t} cannot be sent from the window`), { code: 'bad_request' });
      return { id: node.send(peerId, t, body && typeof body === 'object' ? body : {}) };
    },
    close() { for (const off of offs.splice(0)) { try { off(); } catch { /* closing */ } } },
  };
  return port;
}
