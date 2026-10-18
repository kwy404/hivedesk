// The interface the remote desktop module needs from the p2p control plane (Stream 2, src/p2p/).
// src/remote/ never touches keys, transports or the peer store itself; it asks this port.
// Shapes follow docs/1.0/PLAN.md section 2 (Grant, Session, Peer) and section 4 (Msg).
// The inproc pair in test/remote/inproc-port.js implements the same port for tests.

/**
 * @typedef {import('./types.js').Grant} Grant
 * @typedef {import('./types.js').Session} Session
 * @typedef {import('./types.js').PeerView} PeerView
 *
 * @typedef {object} P2PPort
 * @property {string} localPeerId
 * @property {(sessionId: string) => Session | null} session       an open session by id
 * @property {(peerId: string) => PeerView | null} peer            name and fingerprint words, for the host dialog
 * @property {(sessionId: string, stream: 1 | 2 | 3, type: string, body: object) => boolean} send
 *           sends one message inside the encrypted session; false when the session is gone
 * @property {(prefix: string, fn: (session: Session, msg: { t: string, ts: number, body: any }) => void) => () => void} onMessage
 *           messages whose type starts with prefix ("remote.", "clip.", "file."), already decrypted, from a verified peer
 * @property {(fn: (event: 'open' | 'close', session: Session) => void) => () => void} onSession
 * @property {object} caps
 * @property {(peerId: string, capability: { name: string, limits?: object }, o: { expiresAt: string, scope: 'session', sessionId: string }) => Grant} caps.grant
 *           only ever called right after a click of the local person (grantedBy "user")
 * @property {(grantId: string, reason: string) => void} caps.revoke
 * @property {(peerId: string, name: string) => Grant | null} caps.find
 *           a grant this engine issued to peerId for that capability, not revoked (expiry is checked here too)
 * @property {(sessionId: string, name: string) => Grant | null} caps.held
 *           a grant the remote announced it gave this engine (grantsThere); advisory, the remote enforces
 * @property {(sessionId: string, capability: { name: string }, reason: string) => void} caps.request
 *           sends cap.request
 * @property {(fn: (session: Session, req: { capability: { name: string }, reason: string }) => void) => () => void} caps.onRequest
 *           incoming cap.request for any capability (the port rate limits to 5 per minute)
 * @property {(fn: (change: { kind: 'granted' | 'revoked', grant: Grant, here: boolean }) => void) => () => void} caps.onChange
 * @property {object} audit
 * @property {(entry: object) => { hash: string } | void} audit.append   the hash chained audit log
 *
 * Optional, for connecting by the 10 digit address (src/remote/address.js). Without them the address is
 * shown but "Connect" says that the p2p layer cannot dial by address yet.
 * @property {string} [localPublicKey]   base64url of this install's Ed25519 public key
 * @property {() => Array<{ peerId: string, publicKey: string, name: string }>} [knownPeers]
 * @property {(topic: string, on: boolean) => void} [listenAddress]
 *           listen for incoming handshakes on the rendezvous topic of this machine's address (public relays)
 * @property {(topic: string, o: { address: string }) => Promise<{ sessionId: string }>} [dialAddress]
 *           rendezvous on the topic of a partner's address and run the identity handshake (no invite phrase:
 *           the host's Accept, or its unattended password, is what lets the caller in)
 */

const NEED = ['send', 'onMessage', 'onSession', 'session', 'peer'];
const NEED_CAPS = ['grant', 'revoke', 'find', 'held', 'request', 'onRequest', 'onChange'];

/** Throws when an object does not implement the port, naming what is missing. */
export function assertPort(p2p) {
  if (!p2p || typeof p2p !== 'object') throw new Error('remote: no p2p port');
  const missing = [
    ...NEED.filter((k) => typeof p2p[k] !== 'function'),
    ...NEED_CAPS.filter((k) => typeof p2p.caps?.[k] !== 'function').map((k) => `caps.${k}`),
    ...(typeof p2p.audit?.append === 'function' ? [] : ['audit.append']),
    ...(typeof p2p.localPeerId === 'string' ? [] : ['localPeerId'])
  ];
  if (missing.length) throw new Error(`remote: the p2p port lacks ${missing.join(', ')}`);
  return p2p;
}
