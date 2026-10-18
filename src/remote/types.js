// JSDoc shapes for src/remote/. Grant, Session and Peer are the PLAN section 2 contracts of src/p2p/.

/**
 * @typedef {{ name: string, limits?: Record<string, any> }} Capability
 * @typedef {{
 *   id: string, peerId: string, capability: Capability, grantedBy: 'user', grantedAt: string,
 *   expiresAt: string | null, scope: 'session' | 'standing', revokedAt?: string, sessionId?: string
 * }} Grant
 * @typedef {{ id: string, peerId: string, role: 'host' | 'guest', state: 'open' | 'resuming' | 'closed' }} Session
 * @typedef {{ peerId: string, name: string, words: string[], short?: string, trust?: string }} PeerView
 *
 * A request waiting for the host's click.
 * @typedef {{
 *   id: string, sessionId: string, peerId: string, name: string, words: string[],
 *   wants: 'view' | 'control', agentId?: string, reason: string, at: number
 * }} RemoteRequest
 *
 * One remote desktop session on the host: a peer (or a local agent) that may see this screen.
 * @typedef {{
 *   sessionId: string, peerId: string, name: string, agentId?: string,
 *   grantIds: string[], mode: 'view' | 'control', expiresAt: number, startedAt: number,
 *   sharing: boolean, surface: string | null, display: number | null,
 *   clipboard: boolean, files: boolean
 * }} HostShare
 *
 * A normalized input event from a viewer (wire format of remote.input, PLAN section 12.3).
 * @typedef {(
 *   { k: 'move', x: number, y: number } |
 *   { k: 'btn', b: 0 | 1 | 2, down: boolean } |
 *   { k: 'wheel', dx: number, dy: number } |
 *   { k: 'key', code: string, down: boolean }
 * )} InputEvent
 */

export {};
