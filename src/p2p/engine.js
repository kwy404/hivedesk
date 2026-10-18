// The control plane inside a running engine: the p2p.* commands of the local window (PROTOCOL
// growth, documented in docs/1.0/protocol/p2p.md), the browser-pipe and ws-lan transports, and
// live frames for the window. Every command here comes from the local token holder, so its origin
// is the user; peers never reach these commands, their messages arrive only through sessions.
//
// The node starts on the first p2p command, so an engine that never pairs never creates an
// identity. A --demo engine uses a throw away home, never the real identity or peers.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { P2PNode, USER } from './node.js';
import { BrowserPipeHub } from './transport/browser-pipe.js';
import { listenLan, connectLan, LAN_PORT } from './transport/ws-lan.js';
import { deriveInvite, readWords } from './invites.js';
import { b64u } from './encoding.js';
import { isPeerId } from './identity.js';
import { normalizeCapList } from './caps.js';
import { createComputeLink } from './compute-link.js';
import { createRemotePort } from './remote-port.js';

const JOIN_KEEP_MS = 3 * 60_000;

export class P2PError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** The home the control plane uses: the engine's, or a temp folder for a demo. */
export function p2pHome(config = {}) {
  if (config.demo) return fs.mkdtempSync(path.join(os.tmpdir(), 'hivedesk-demo-home-'));
  if (config.home) return config.home;
  return process.env.HIVEDESK_HOME ? path.resolve(process.env.HIVEDESK_HOME) : path.join(os.homedir(), '.hivedesk');
}

/**
 * @param {{ server?: any, bus?: any, config?: any, nodeOptions?: object }} ctx
 * Returns { node(), pipes, close(), status() }.
 */
export function attachP2P(ctx) {
  const { server, bus, config = {} } = ctx;
  const pipes = new BrowserPipeHub();
  const joins = new Map(); // joinId -> { words, state, ... } (guest side, this engine)
  let node = null;
  let lan = null;
  let computeLink = null;
  let remotePort = null;
  const live = (type, data) => bus?.live?.(type, data);
  const event = (type, data) => {
    try {
      bus?.emit?.(type, data);
    } catch { /* the log must never break pairing */ }
  };

  function getNode() {
    if (node) return node;
    node = new P2PNode({ home: p2pHome(config), name: config.name || os.hostname(), ...(ctx.nodeOptions || {}) }).start();
    // What the window and the Activity stream see. Never words, keys or prompt text.
    node.on('join.request', (d) => live('p2p.join.request', d));
    node.on('join.gone', (d) => live('p2p.join.gone', d));
    node.on('join.decided', (d) => {
      live('p2p.join.decided', d);
      event('p2p.join', { peerId: d.peerId, accepted: d.accepted, ...(d.reason ? { reason: d.reason } : {}) });
    });
    node.on('peer.online', (d) => {
      live('p2p.peers', { peers: node.listPeers() });
      event('p2p.peer', { peerId: d.peerId, online: true });
    });
    node.on('peer.offline', (d) => {
      live('p2p.peers', { peers: node.listPeers() });
      event('p2p.peer', { peerId: d.peerId, online: false, reason: String(d.reason).slice(0, 80) });
    });
    node.on('grant.created', (g) => {
      live('p2p.peers', { peers: node.listPeers() });
      event('p2p.grant', { grantId: g.id, peerId: g.peerId, capability: g.capability.name, expiresAt: g.expiresAt, scope: g.scope });
    });
    node.on('grant.revoked', ({ grant, reason }) => {
      live('p2p.peers', { peers: node.listPeers() });
      event('p2p.revoke', { grantId: grant.id, peerId: grant.peerId, capability: grant.capability.name, reason });
    });
    node.on('held.changed', () => live('p2p.peers', { peers: node.listPeers() }));
    node.on('peer.profile', () => live('p2p.peers', { peers: node.listPeers() }));
    node.on('cap.request', (r) => live('p2p.cap.request', r));
    node.on('invite.burned', (d) => live('p2p.invite.burned', d));
    node.on('invite.expired', (d) => live('p2p.invite.expired', d));
    return node;
  }

  const need = (cond, msg) => {
    if (!cond) throw new P2PError('bad_request', msg);
  };
  const peerArg = (d) => {
    need(isPeerId(d.peerId), 'peerId is required');
    return d.peerId;
  };

  // ---- guest side join, shared by the pipe and the LAN paths ----
  function joinUpdate(j, phase, extra = {}) {
    j.phase = phase;
    Object.assign(j, extra);
    live('p2p.join.update', { joinId: j.id, phase, ...extra });
  }

  /** Runs the guest handshake; resolves once the SAS words are known (or it failed). The host's decision follows as live updates. */
  async function runJoin(j, conn) {
    const n = getNode();
    joinUpdate(j, 'handshake');
    let handle;
    try {
      handle = await n.join(j.words, conn, { name: j.name, requestedCaps: j.requestedCaps });
    } catch (err) {
      j.words = null;
      joinUpdate(j, 'failed', { reason: err.code === 'refused' ? 'refused' : err.code === 'timeout' ? 'timeout' : 'words' });
      return;
    }
    j.words = null;
    joinUpdate(j, 'sas', { sas: handle.sas, host: handle.host, offeredCaps: handle.offeredCaps });
    handle.decision.then((d) => joinUpdate(j, d.accepted ? 'accepted' : 'refused', d.accepted ? { grants: d.grants } : { reason: d.reason }));
  }

  function newJoin(d) {
    const words = readWords(d.words);
    const j = { id: 'jn_' + crypto.randomBytes(6).toString('hex'), words, name: typeof d.name === 'string' ? d.name : undefined, requestedCaps: normalizeCapList(d.requestedCaps), phase: 'rendezvous', createdAt: Date.now() };
    joins.set(j.id, j);
    const t = setTimeout(() => {
      if (j.phase === 'rendezvous') joinUpdate(j, 'failed', { reason: 'timeout' });
      j.words = null;
    }, JOIN_KEEP_MS);
    t.unref?.();
    return j;
  }

  const view = (j) => ({ joinId: j.id, phase: j.phase, ...(j.sas ? { sas: j.sas, host: j.host, offeredCaps: j.offeredCaps } : {}), ...(j.reason ? { reason: j.reason } : {}), ...(j.grants ? { grants: j.grants } : {}) });

  const commands = {
    'p2p.identity': () => {
      const n = getNode();
      return { ...n.info(), lan: lan ? { port: lan.port, host: lan.host } : null };
    },
    'p2p.invite.create': async (d) => {
      const inv = await getNode().createInvite({ caps: d.caps, minutes: d.minutes, origin: USER });
      return inv;
    },
    'p2p.invite.cancel': (d) => ({ cancelled: getNode().cancelInvite(String(d.inviteId || '')) }),
    'p2p.invite.list': () => ({ invites: getNode().invites.list() }),
    'p2p.join': async (d) => {
      const j = newJoin(d);
      if (d.via === 'lan') {
        need(typeof d.address === 'string' && d.address.length < 200, 'address is required for a LAN join');
        const conn = await connectLan(d.address);
        await runJoin(j, conn);
        return view(j);
      }
      // browser-pipe: the window meets the host on the relays with these values, opens the data
      // channel, then calls p2p.pipe.open with this joinId. It never gets the psk.
      const inv = await deriveInvite(j.words, getNode().iterations);
      return { ...view(j), rendezvous: { topic: inv.topic, seal: b64u(inv.seal) } };
    },
    'p2p.join.status': (d) => {
      const j = joins.get(String(d.joinId || ''));
      if (!j) throw new P2PError('not_found', 'no such join');
      return view(j);
    },
    'p2p.join.requests': () => ({ requests: getNode().listJoinRequests() }),
    'p2p.join.answer': (d) => getNode().answerJoin(String(d.requestId || ''), { accept: d.accept === true, sasMatches: d.sasMatches, caps: Array.isArray(d.caps) ? d.caps : [], reason: d.reason }, USER),
    'p2p.peers': () => ({ peers: getNode().listPeers(), requests: getNode().listCapRequests() }),
    'p2p.grant': (d) => ({ grant: getNode().grant(peerArg(d), d.capability, { minutes: d.minutes, scope: d.scope }, USER) }),
    'p2p.revoke': (d) => ({ grant: getNode().revoke(String(d.grantId || ''), typeof d.reason === 'string' ? d.reason : 'revoked', USER) }),
    'p2p.block': (d) => ({ blocked: getNode().block(peerArg(d), USER) }),
    'p2p.unblock': (d) => ({ unblocked: getNode().unblock(peerArg(d), USER) }),
    'p2p.forget': (d) => ({ forgotten: getNode().forget(peerArg(d), USER) }),
    'p2p.audit': (d) => {
      const n = getNode();
      return { entries: n.audit.tail(Math.min(500, Math.max(1, Number(d.limit) || 50))), verify: d.verify ? n.audit.verify() : undefined };
    },
    'p2p.lan.listen': async (d) => {
      if (lan) return { port: lan.port, host: lan.host };
      const n = getNode();
      need(typeof d.host === 'string' && d.host.length < 100, 'host is required: the LAN address to listen on (opt in)');
      lan = await listenLan({ host: d.host, port: Number.isInteger(d.port) ? d.port : LAN_PORT, onConnection: (c) => n.accept(c) });
      n._audit({ type: 'lan.listen', port: lan.port });
      return { port: lan.port, host: lan.host };
    },
    'p2p.lan.stop': async () => {
      if (!lan) return { stopped: false };
      await lan.close();
      lan = null;
      getNode()._audit({ type: 'lan.stop' });
      return { stopped: true };
    },
    'p2p.connect': async (d) => {
      const n = getNode();
      const peerId = peerArg(d);
      need(typeof d.address === 'string' && d.address.length < 200, 'address is required');
      const s = await n.connect(peerId, await connectLan(d.address));
      return { sessionId: s.id };
    },
    // The address meeting point for the window while this machine listens by address (remote desktop).
    'p2p.address': () => {
      const n = getNode();
      const address = n.address();
      const listening = [...n.addressBook.values()].some((e) => e.address === address);
      return { address, listening, rendezvous: listening ? n.addressRendezvous(address) : null };
    },
    // ---- browser-pipe ----
    'p2p.pipe.open': (d, client) => {
      const n = getNode();
      if (d.dialId) {
        // The window met the machine of a dial by address on the relays (live p2p.dial.pipe).
        const conn = pipes.open(client);
        if (!remotePort?.pipeArrived(String(d.dialId), conn)) {
          conn.close('no such dial');
          throw new P2PError('not_found', 'no dial waiting for a pipe');
        }
        return { pipeId: conn.pipeId };
      }
      if (d.joinId) {
        const j = joins.get(String(d.joinId));
        if (!j || !j.words || j.phase !== 'rendezvous') throw new P2PError('not_found', 'no join waiting for a pipe');
        const conn = pipes.open(client);
        runJoin(j, conn);
        return { pipeId: conn.pipeId };
      }
      if (d.peerId) {
        const peerId = peerArg(d);
        const conn = pipes.open(client);
        n.connect(peerId, conn).catch(() => {});
        return { pipeId: conn.pipeId };
      }
      // Host side: the window brings a data channel from someone who knocked with our topic.
      const conn = pipes.open(client);
      n.accept(conn);
      return { pipeId: conn.pipeId };
    },
    'p2p.pipe.in': (d, client) => {
      pipes.input(client, d.pipeId, d.data);
      return undefined;
    },
    'p2p.pipe.close': (d, client) => {
      pipes.remoteClosed(client, d.pipeId, typeof d.reason === 'string' ? d.reason : undefined);
      return {};
    },
  };

  for (const [type, fn] of Object.entries(commands)) server?.command?.(type, fn);

  return {
    node: getNode,
    /** The ComputeLink for src/compute/ (one per engine). */
    computeLink: () => (computeLink ??= createComputeLink(getNode())),
    /** The port of the remote desktop module (src/remote/port.js). */
    remotePort: () => (remotePort ??= createRemotePort(getNode(), { live })),
    get started() {
      return !!node;
    },
    pipes,
    commands,
    async close() {
      remotePort?.close();
      if (lan) await lan.close();
      lan = null;
      await node?.close();
    },
  };
}
