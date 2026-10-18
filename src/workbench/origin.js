// Who is asking. The workbench never trusts identity from the browser: a WebSocket or REST
// caller holding this engine's token is the local user; a peer reaches the workbench only
// through src/p2p (Stream 2), which hands over a verified peerId on `client.origin`.
//
// Origin shape (PLAN section 1.3): { kind: "user" | "crew" | "system" | "peer", peerId?, sessionId?, agentId? }

export class WorkbenchError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.code = code;
    if (extra) Object.assign(this, extra);
  }
}

const KINDS = new Set(['user', 'crew', 'system', 'peer']);

/** The origin of a command. A client without an origin is a local token holder. */
export function originOf(client) {
  const o = client && typeof client === 'object' ? client.origin : null;
  if (!o) return { kind: 'user' };
  if (!KINDS.has(o.kind)) return { kind: 'peer', peerId: null };
  if (o.kind === 'peer') return { kind: 'peer', peerId: typeof o.peerId === 'string' ? o.peerId : null, sessionId: typeof o.sessionId === 'string' ? o.sessionId : undefined };
  return { kind: o.kind, ...(o.agentId ? { agentId: String(o.agentId) } : {}) };
}

export const isLocalUser = (origin) => origin?.kind === 'user';

/**
 * Policy for every workbench command, for the command router of Stream 1 and for this module.
 *   local     only the person at this machine (origin user)
 *   peer      the capability a peer needs; peers act on the workspace root only
 *   approval  a peer's call goes through host approval
 * Agents (origin crew) never reach a workbench command: the crew keeps its own tools.
 */
export const POLICY = Object.freeze({
  'wb.info': { local: true, peer: 'workspace.read' },
  'wb.settings.get': { local: true },
  'wb.settings.set': { local: true },
  'wb.roots.list': { local: true },
  'wb.roots.add': { local: true },
  'wb.roots.remove': { local: true },
  'wb.fs.list': { local: true, peer: 'workspace.read' },
  'wb.fs.files': { local: true, peer: 'workspace.read' },
  'wb.fs.read': { local: true, peer: 'workspace.read' },
  'wb.fs.count': { local: true, peer: 'workspace.read' },
  'wb.fs.write': { local: true, peer: 'workspace.propose', approval: true },
  'wb.fs.mkdir': { local: true, peer: 'workspace.propose', approval: true },
  'wb.fs.rename': { local: true, peer: 'workspace.propose', approval: true },
  'wb.fs.delete': { local: true, peer: 'workspace.propose', approval: true },
  'wb.fs.watch': { local: true },
  'wb.search': { local: true, peer: 'workspace.read' },
  'wb.search.cancel': { local: true, peer: 'workspace.read' },
  'wb.replace.preview': { local: true, peer: 'workspace.propose' },
  'wb.replace.apply': { local: true, peer: 'workspace.propose', approval: true },
  'wb.term.open': { local: true },
  'wb.term.list': { local: true },
  'wb.term.attach': { local: true },
  'wb.term.input': { local: true },
  'wb.term.resize': { local: true },
  'wb.term.close': { local: true },
  'wb.term.share': { local: true },
  'wb.term.unshare': { local: true },
  'wb.scm.status': { local: true },
  'wb.scm.diff': { local: true },
  'wb.scm.stage': { local: true },
  'wb.scm.unstage': { local: true },
  'wb.scm.discard': { local: true },
  'wb.scm.commit': { local: true },
  'wb.scm.branches': { local: true },
  'wb.scm.checkout': { local: true },
  'wb.scm.stashes': { local: true },
  'wb.scm.init': { local: true },
  'wb.scm.log': { local: true },
  'wb.doc.open': { local: true, peer: 'workspace.read' },
  'wb.doc.ops': { local: true, peer: 'workspace.propose' },
  'wb.doc.presence': { local: true, peer: 'workspace.read' },
  'wb.doc.save': { local: true, peer: 'workspace.propose', approval: true },
  'wb.doc.close': { local: true, peer: 'workspace.read' },
  'wb.doc.reload': { local: true, peer: 'workspace.propose' },
  'wb.doc.people': { local: true, peer: 'workspace.read' },
  'wb.peers': { local: true }
});

/** Every terminal command a peer could ever name. All of them are refused for non local origins. */
export const TERMINAL_COMMANDS = Object.freeze(Object.keys(POLICY).filter((k) => k.startsWith('wb.term.')));
