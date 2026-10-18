// Phone remote plug-in (docs/1.0/protocol/phone.md). The engine calls the default export with
//   { bus, server, home, p2p?, run, hostName?, now? }
// and gets back { hub, port, close() }; `port` is the remote desktop port for phone sessions
// (src/phone/port.js), to give src/remote/ through combinePorts. Every phone.* command is for the
// local person only (spec local: true, and the handler checks the origin again). Live frames carry
// no content: the window pulls with phone.status, except the pipe frames, which go to one window only.

import path from 'node:path';
import { AuditLog } from '../p2p/audit.js';
import { PhoneHub, PhoneError } from './hub.js';
import { PhonePipeHub } from './pipe.js';
import { createPhonePort, combinePorts } from './port.js';

export const COMMANDS = ['phone.status', 'phone.invite.create', 'phone.invite.cancel', 'phone.pair.answer', 'phone.grants', 'phone.revoke', 'phone.listen', 'phone.pipe.open', 'phone.pipe.in', 'phone.pipe.close'];

/**
 * @param {{ bus: any, server: { command: Function }, home: string, p2p?: any, run: (type: string, data: object) => Promise<any>,
 *   hostName?: () => string, now?: () => number, hubOptions?: object }} ctx
 */
export default async function registerPhone(ctx) {
  const { bus, server, home } = ctx;
  if (typeof ctx.run !== 'function') throw new Error('phone: the engine must pass run(type, data) for the commands a phone may start');
  // One audit chain per home: the p2p node's when the control plane is there, else our own.
  let own = null;
  const audit = (entry) => {
    const node = ctx.p2p?.node?.();
    if (node?._audit) return node._audit(entry);
    own ??= new AuditLog({ dir: path.join(home, 'audit'), now: ctx.now });
    return own.append(entry);
  };
  const peerId = () => {
    try { return ctx.p2p?.started ? ctx.p2p.node().info().peerId : null; } catch { return null; }
  };
  const hub = new PhoneHub({
    home, run: ctx.run, state: () => bus.state, audit, now: ctx.now, peerId,
    hostName: ctx.hostName || (() => 'hivedesk'), ...(ctx.hubOptions || {})
  });
  await hub.start();
  const pipes = new PhonePipeHub();
  const port = createPhonePort(hub, { localPeerId: () => peerId() || 'local', now: ctx.now });

  let version = 0;
  hub.on('changed', () => bus.live?.('phone.changed', { v: ++version }));
  const offBus = bus.on?.((event) => hub.onEvent(event));

  const local = (fn) => async (d, client, c) => {
    if (c?.origin && c.origin.kind !== 'user') throw new PhoneError('forbidden', 'phone commands are for the person at this computer');
    return fn(d || {}, client);
  };
  const cmd = (name, fn) => server.command(name, local(fn), { local: true });

  cmd('phone.status', () => ({ phones: hub.phones(), requests: hub.pairRequests(), invites: [...hub.invites.values()].filter((i) => !i.used).map((i) => ({ inviteId: i.id, expiresAt: new Date(i.expiresAt).toISOString() })), sessions: [...hub.sessions.values()].filter((r) => r.accepted).map((r) => ({ deviceId: r.deviceId, sessionId: r.id, expiresAt: new Date(r.expiresAt).toISOString() })) }));
  cmd('phone.invite.create', () => hub.createInvite());
  cmd('phone.invite.cancel', (d) => ({ cancelled: hub.cancelInvite(String(d.inviteId || '')) }));
  cmd('phone.pair.answer', (d) => hub.answerPair(String(d.requestId || ''), { accept: d.accept === true, sasMatches: d.sasMatches, grants: d.grants }));
  cmd('phone.grants', (d) => ({ phone: hub.setGrants(String(d.deviceId || ''), d.grants) }));
  cmd('phone.revoke', (d) => hub.revoke(String(d.deviceId || '')));
  cmd('phone.listen', () => hub.listenKeys());
  cmd('phone.pipe.open', (d, client) => {
    const conn = pipes.open(client);
    hub.accept(conn);
    return { pipeId: conn.pipeId };
  });
  cmd('phone.pipe.in', (d, client) => {
    pipes.input(client, d.pipeId, d.data);
    return undefined;
  });
  cmd('phone.pipe.close', (d, client) => {
    pipes.remoteClosed(client, d.pipeId, typeof d.reason === 'string' ? d.reason : undefined);
    return {};
  });

  return {
    hub,
    port,
    pipes,
    combine: (p2pPort) => combinePorts(p2pPort, port),
    async close() {
      offBus?.();
      await hub.close();
    }
  };
}

export { combinePorts, createPhonePort };
