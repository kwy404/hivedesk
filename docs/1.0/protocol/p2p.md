# P2P control plane protocol (Stream 2)

Code: `src/p2p/`, the Lend adapter in `src/lend/share.js`, the window half in `ui/lend/core/p2p-pipe.js` and `ui/lend/p2p-screen.js`. Contracts: `docs/1.0/PLAN.md` sections 2, 3, 4, 8 and 9. This file lists what the code does and the additions to the frozen shapes.

## Identity

* `~/.hivedesk/identity/key.pem` (Ed25519, PKCS8) and `identity.json`. Written with a temp file and rename; POSIX mode 600, on Windows an ACL with inheritance removed (the user, SYSTEM and Administrators, the rule OpenSSH applies to keys). The doctor reads the ACL as SIDs from `icacls /save`.
* `peerId = "hd1" + base32(sha256(raw public key))`, 52 characters in all (the first 49 base32 characters, 245 bits). Stream 3's `wire.js` uses the same length.
* Fingerprint: `{ hex, words: six BIP39 words from the first 66 bits, short: "hd1abcd-efgh" }`.
* A key that exists but cannot be read is an error, never a silent new identity. `rotateIdentity` writes a new key and returns an `identity.rotated` statement signed by the old key (`verifyRotation`).
* The node starts on the first `p2p.*` command, so an engine that never pairs creates nothing. `--demo` uses a throw away home.

## Handshakes (src/p2p/handshake.js)

Exactly PLAN 3.3, with these details:

* Transcript hashes are `T(...)`: SHA-256 over parts, each prefixed with a 4 byte length. Messages are hashed as the exact text that crossed the wire.
* `hs.1 { t, v: 2, inv: topic, e, n }`. The topic picks the invite on a listener with several.
* `hs.2` carries `AEAD_k1({ id, sig, offeredCaps, hostName })`; the host signature covers `T(m1, eH, nH, pkH, offeredCaps, hostName)`.
* `hs.3` carries `AEAD_k2({ id, sig, name, requestedCaps })`; the guest signature covers `T(T(m1, m2), pkG, requestedCaps, name)`.
* After `hs.3` the host sends an encrypted `ping`, the guest's key confirmation. A failure after `hs.3` is a plaintext `hs.fail { code }`.
* The invite is burned by the first handshake that starts on it, whatever its outcome. Both sides then say "the words did not work".
* Known peer reconnect: `hs.k1 { v, e, n, from: PeerIdentity, to: peerId, sig }`, `hs.k2 { e, n, box: AEAD({ publicKey, sig }) }`. The responder's session is unconfirmed until the initiator's first frame opens (the initiator sends `ping` at once); an unconfirmed session closes after the handshake deadline.
* Session id: `"ss_" + base32(sha256("hivedesk v2 session id", th))`, 16 characters.

## Sessions (src/p2p/session.js)

* Frame `{ s, n, ct }`; nonce = 32 bit stream id and 64 bit counter; additional data `hivedesk v2 frame|<sessionId>|<s>|<n>`.
* Rekey: epoch = `floor(n / 2^20)`, `key(e+1) = HKDF(key(e), "hivedesk v2 rekey")`. The 60 minute rekey jumps the counter to the next epoch boundary, so both sides stay in step without a message. Old keys are wiped.
* Replay window of 128 counters. Three frames that do not open close the session (`bad_frame`); an unknown type, or a type on the wrong stream, closes it (`bad_message`); a body that fails its normalizer is answered with `error { code: "bad_input" }`.
* Control frames leave before media and compute frames queued in the same turn.
* Liveness: a ping every 5 s; a session that heard nothing for 10 s closes (`no answer`), PLAN 8.
* Frames up to 1.7 MB of text (a 1.1 MB `job.result` after base64).

## Message table additions

* `error { code, message }` with `re`: the answer to a refused message (`not_granted`, `not_accepted`, `rate_limited`, `bad_input`, `unsupported`).
* `identity.rotated`: the signed rotation statement.
* A type may answer a refusal in its own protocol: `job.offer` without `compute.inference` is answered with `job.reject { code: "not_granted" }`.
* Before the host accepts, only `ping`, `pong`, `error`, `session.close`, `join.accept` and `join.refuse` travel.
* Other streams register the bodies of their types with `registerMessage(type, { normalize, cap, stream, max, rate })` (`remote.*`, `term.*`, `file.*`).

## Capabilities (src/p2p/caps.js)

The PLAN list plus four compute resources, each with its own limits:

| Capability | Limits | Scope |
| --- | --- | --- |
| `compute.inference` | `maxConcurrentJobs` 1..4, `maxJobSeconds` 10..1800, `maxTokensPerJob` 1..8192, `models` | standing, default 1 day, at most 30 |
| `compute.gpu` | `maxVramBytes`, `gpus` (indexes, empty means any), `maxUtilPct` | standing |
| `compute.cpu` | `maxThreads`, `maxLoadPct` | standing |
| `compute.ram` | `maxBytes` | standing |
| `compute.storage` | `maxBytes`, `modelDownload` (default false) | standing |
| `city.member` | `maxAgents` 0..4 | standing |
| `remote.view`, `remote.control` | lifetime 5, 15 or 60 minutes | session only |
| `terminal.share.read`, `terminal.share.write` | default 15, at most 60 minutes | session only |
| `clipboard.text` | `maxBytes` up to 64 KB | session only |
| `file.send` | `maxBytes` up to 2 GB | session only |

* `effectiveCompute(grants)` gives `{ inference, gpu, cpu, ram, storage, allowed }`; a job needs inference and a GPU or CPU grant. The worker enforces the numbers.
* Only `origin.kind === 'user'` grants, answers a join, blocks or forgets. Expiry and session end revoke as `system`.
* `expiresAt: null` only for `city.view` and `chat` on known peers. Session grants live in memory and end with their session; standing grants live in `peers/<peerId>.json`.
* `control` implies `view` for `remote.*`, and `write` implies `read` for `terminal.share.*`.
* The join dialog toggles: `city.view` on, everything else off.

## Audit (src/p2p/audit.js)

`audit/<yyyy-mm>.jsonl`, `{ seq, ts, prevHash, hash, entry }`, `hash = sha256(canonical({ seq, ts, prevHash, entry }))`, chained across months. A torn last line is dropped on open and recorded as `audit.repaired`. Fields named words, phrase, psk, key, secret, prompt, messages or text are never written. Refused messages are audited at most once per peer and type every 10 s.

## Engine commands (local user only, src/p2p/engine.js)

`p2p.identity`, `p2p.invite.create { caps, minutes }` (returns the words once and `rendezvous: { topic, seal }`, never the psk), `p2p.invite.cancel`, `p2p.invite.list`, `p2p.join { words, requestedCaps, name, via: 'pipe' | 'lan', address? }`, `p2p.join.status`, `p2p.join.requests`, `p2p.join.answer { requestId, accept, sasMatches, caps }`, `p2p.peers`, `p2p.grant { peerId, capability, minutes, scope }`, `p2p.revoke { grantId }`, `p2p.block`, `p2p.unblock`, `p2p.forget`, `p2p.audit { limit, verify }`, `p2p.lan.listen { host, port }`, `p2p.lan.stop`, `p2p.connect { peerId, address }`, `p2p.pipe.open { joinId? | peerId? }`, `p2p.pipe.in { pipeId, data }`, `p2p.pipe.close { pipeId }`.

Lend: `lend.offer { form }`, `lend.accept { requestId, form, sasMatches }`, `lend.grants`, `lend.revoke { peerId }`; `lend.stop` also revokes every compute grant; `lend.status` gains `p2p: { started, lending }`.

Live frames: `p2p.join.request` (the dialog data), `p2p.join.gone`, `p2p.join.decided`, `p2p.join.update { joinId, phase: rendezvous | handshake | sas | accepted | refused | failed }`, `p2p.peers`, `p2p.cap.request`, `p2p.invite.burned`, `p2p.invite.expired`; to one window only: `p2p.pipe.out { pipeId, data }` and `p2p.pipe.closed`.

Logged events (ids and names, never words, SAS words or keys): `p2p.join { peerId, accepted, reason? }`, `p2p.peer { peerId, online, reason? }`, `p2p.grant { grantId, peerId, capability, expiresAt, scope }`, `p2p.revoke { grantId, peerId, capability, reason }`.

## Transports

* `inproc` (tests); `ws-lan` (`/hivedesk/p2p`, default port 4175, off until `p2p.lan.listen` or `hivedesk invite --lan`; every other request gets a bare 404; at most 32 connections); `browser-pipe` (the window's data channel; parts of 60,000 characters as `~id:i/n:`).
* Relay meeting point for 1.0: topic `hivedesk/v2/<topic>`, messages sealed with AES-GCM under the engine's `seal` key (`ui/lend/core/pairing.js` takes a prepared `{ topic, key }`).
* `rtc-node` is not built (PLAN 3.4, after 1.0).

## ComputeLink (src/p2p/compute-link.js)

The members of `docs/1.0/protocol/compute.md`: `selfId`, `send`, `onMessage`, `hasGrant`, `holdsGrant`, `peers`, `onPeer` (`online`, `resumed`, `offline`, `grant.revoked` and `grant.expired` in both directions, `blocked`), `audit`. The engine exposes one per engine: `attachP2P(ctx).computeLink()`. The peerId given to `onMessage` is the verified session peer, which the requester puts in `remoteOrigin`.

## CLI and doctor

`src/p2p/cli.js` exports `P2P_SUBCOMMANDS = { invite, join, peers }`, each `(argv, { home, stdin, stdout, stderr }) => exit code`. They use the running engine through its token when there is one, else a headless node. From a terminal they pair over `--lan`; through the relays they say that a window is needed. The Accept in the terminal asks "Do these check words match on their screen?", then each capability.

`runDoctor({ p2p: true })` adds: identity and key privacy, peer store, audit chain, the stable port 4174 (free, or a hivedesk), the LAN port, the relays over WSS (an upgrade with `Sec-WebSocket-Protocol: mqtt`), and the NAT type from STUN binding requests to two servers from one UDP socket: open, cone, symmetric, blocked or unknown.

## Since the 1.0 integration

* **City port** (`src/p2p/city-port.js`): the facade of `src/city/membership.js` (`peerId`, `on('session.open' | 'session.closed' | 'grants.changed')`, `onMessage`, `send`, `hasGrant`, `grantsOf`, `peer`). `city.reply { re, ok, result?, error? }` is in the message table (stream 1); `city.cmd` keeps its body `id`. A `city.cmd` the node refuses (not granted, rate limited) comes back to the membership as a `city.reply` with the error at once. `city.member` includes what `city.view` allows, in the node too. Peer city commands then run through the engine router as `{ kind: 'peer', peerId }` (the second check, `data.as` from the session), and the router's peer commands are audited here as `command` entries.
* **By address** (remote desktop, `docs/1.0/protocol/remote.md`): `node.listenAddress(on)`, `node.dialAddress(address, conn)`. The invite handshake with a meeting point derived from the public 10 digit address (`deriveAddressInvite`): its psk is not a secret, so the session is authenticated only by the two Ed25519 identities, the dialer checks that the answering key owns the dialed address, both sides get the SAS, and nothing is granted (the trust of a new peer stays `unknown`). Incoming handshakes per address are limited to 10 per minute (`address.rate_limited` in the audit log). `p2p.address` gives the window the meeting point while listening; `p2p.pipe.open { dialId }` hands a data channel to a dial (live `p2p.dial.pipe`).
* **Remote port** (`src/p2p/remote-port.js`): `src/remote/port.js` over the node. It registers the `remote.*`, `clip.*` and `file.*` types with their streams, caps and rates, carries a clipboard item above one frame as `remote.part` messages on stream 2 (joined before any handler, 16 MB at most), and keeps the grant limits (`remote.view` and `remote.control` `{ clipboard, files }`, `clipboard.text { dir }`).
* `peer.online` carries `via: 'invite' | 'known' | 'address'`; `held.granted` fires when a peer announces a grant it gave this engine.

## Not done (marked, never faked)

* PAKE (SPAKE2 or CPace): not needed with the 66 bit words, burn on first failure and the SAS (PLAN 3.3). The handshake machines are where it would go.
* `rtc-node`: headless peers across NATs need a window until then.
* The terminal `invite` and `join` pair over the LAN only, by address (no multicast discovery).
* An `identity.rotated` statement is made and verified, but sending it to known peers and the `hivedesk identity --rotate` command are not wired (Stream 1's CLI shell).
* `test/p2p/e2e-pipe.mjs` is manual (public brokers and a browser); `test/p2p/compute-link.test.js` runs once `src/compute/` is merged.
