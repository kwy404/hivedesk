# Phone remote protocol (Stream 7)

Code: `src/phone/` (engine), `ui/phone/core/` (shared by the engine, the desktop window and the page), `ui/phone/`
(desktop window), `docs/remote/` (the public page, `https://kwy404.github.io/hivedesk/remote/`). Tests: `test/phone/`.
The engine is the authority: the page renders and asks; every phone command is checked on the desktop.

## 1. Pieces

| Where | What |
| --- | --- |
| Engine (`src/phone/hub.js`) | the desktop's phone key, one time invites, the handshakes, sessions, paired phones and grants, the check of every command, rate limits, session expiry, audit |
| Desktop window (`ui/phone/desktop.js`) | the QR code, the accept dialog, the phone list with grants and Remove, the relay listener; it only moves ciphertext (`ui/phone/bridge.js`) |
| Phone page (`docs/remote/`) | the phone's own key in IndexedDB, the relay knock, WebRTC, the handshake and session (`ui/phone/core/client.js`), the UI |

## 2. The invite (QR code)

`https://kwy404.github.io/hivedesk/remote/#p=<base64url(0x01 || secret[32] || pin[12])>`, in the fragment, so the web
server never sees it; the page removes it from the address bar at once. From `secret`, HKDF-SHA256 gives `topic` (16
bytes, the relay topic `hivedesk/p1/<topic>`), `seal` (the AES-GCM key of the relay messages) and `psk` (mixed into the
handshake). `pin` is the first 12 bytes of `SHA-256("hivedesk phone host v1|" || desktop phone key)`: the phone refuses
any other computer. An invite lives 5 minutes and is burned by the first handshake that names it (`used`); after
expiry the answer is `expired`.

## 3. Handshakes (`ui/phone/core/handshake.js`)

The Stream 2 handshake of PLAN 3.3 on primitives every phone browser has: ECDH P-256 ephemerals, AES-256-GCM, and
Ed25519 identities where WebCrypto has them, else ECDSA P-256. The desktop's phone key is always ECDSA P-256
(`<home>/identity/phone-key.pem`). Transcript hashes `T(...)` are length prefixed SHA-256.

* Pairing: `ph.1 { v, inv, e, n }`, `ph.2 { e, n, box: AEAD_k1({ key, sig, name, peerId }) }`,
  `ph.3 { box: AEAD_k2({ alg, key, sig, name }) }`; `k1 = HKDF(ECDH || psk)`, both signatures over the transcript,
  six SAS words from `SHA-256("hivedesk phone v1 sas", th3, pkH, pkG)` on both screens, then the desktop's Accept
  (it needs `sasMatches: true`). Both keep a reconnect secret `r = HKDF(k2, th3, "hivedesk phone v1 reconnect")`.
* Known phone: `pk.1 { v, e, n, from: { alg, key, id }, to: pin, sig }`, `pk.2 { e, n, box: AEAD_k({ sig }) }` with
  `k = HKDF(ECDH || r)`. A removed phone gets `unknown_phone`.
* A failure is a plaintext `ph.fail { code }`: `unknown`, `used`, `expired`, `bad`, `busy`, `timeout`, `unknown_phone`.
* Phone id: `"ph1" + base32(SHA-256("hivedesk phone id v1|", alg, "|", key))[0..25]`, never a p2p PeerId.

### 3.1 Transport

The browser pipe of Stream 2 with its own commands: the window meets the phone on the public MQTT relays
(`ui/lend/core/relay.js`), every relay message sealed with AES-GCM, swaps one WebRTC offer and answer, and moves
frames between the data channel and the engine (`phone.pipe.open`, `phone.pipe.in`, live `phone.pipe.out`, sent to
that window only). Pairing uses the invite topic; known phones knock on the desktop's public home topic
(`hivedesk/p1/h<HKDF(pkH)>`), each sealed with its own key `HKDF(r, "home seal")`, so phones cannot read each other's
offers. Frames larger than one data channel message are split as in `ui/lend/core/p2p-pipe.js`. Honest limit: the
desktop window must be open (as for every browser pipe in 1.0).

## 4. Session (`ui/phone/core/session.js`, `messages.js`)

Frames `{ s, n, ct }`, AES-256-GCM per direction, nonce = stream id and 64 bit counter, additional data
`hivedesk phone v1 frame|<sessionId>|<s>|<n>`; the counter must grow strictly (ordered channel), three bad frames
close the session, an unknown type or one travelling the wrong way closes it (`bad_message`), per type rates
answer `error { code: "rate_limited" }`. A session ends after 2^24 messages, after 8 hours (`expired`) or 90 seconds
without a frame (`idle`); the phone pings every 10 seconds and reconnects by itself.

| Type | Stream | Way | Body |
| --- | --- | --- | --- |
| `ping`, `pong`, `error`, `session.close` | 1 | both | |
| `pair.accept`, `pair.refuse` | 1 | down | `{ deviceId, grants, host }`, `{ reason }` |
| `welcome`, `grants` | 1 | down | `{ deviceId, name, host, grants, expiresAt, idleMs }`, `{ grants }` |
| `cmd` | 1 | up | `{ op, a }`, 40 per 10 s |
| `cmd.re` | 1 | down | `{ ok, result }` or `{ ok: false, error: { code, message, grant? } }` |
| `state`, `feed`, `notice` | 1 | down | the status view, activity lines, notifications |
| `cap.request`, `remote.*` | 1, 3 | see remote.md | only with `phone.remote`; then src/remote/ checks everything |

## 5. Grants (`ui/phone/core/grants.js`)

| Grant | Default | Allows | Commands (rate) |
| --- | --- | --- | --- |
| `phone.status` | on | City, jobs, tasks, activity, approval count | `state.get` |
| `phone.crew` | off | requests through the refiner, brief answer, chat, voice input | `job.create` (6/min), `brief.approve`, `chat.send` (20/min), `chat.log` |
| `phone.approve` | off | full approval cards, approve and reject | `approval.get`, `approval.resolve` (30/min) |
| `phone.control` | off | pause and resume workers, cancel jobs | `worker.pause`, `worker.resume`, `job.cancel` |
| `phone.notify` | off | notices while the page is open | `notify.set` |
| `phone.remote` | off | asking for `remote.view` or `remote.control`, granted per session in the Stream 6 dialog | |

Every command reads the phone's record again (a removal or a grant change applies at once), checks the grant and
the rates, then runs the engine command as the local user through the router (`run`). A phone cannot approve an
action whose approval carries `remoteOrigin` (a model on another machine); it can reject it. Commands that change
something are audited as `phone.cmd { deviceId, op, ok, code?, ids or counts }`, never request or chat text.

## 6. What leaves the desktop (`src/phone/view.js`)

Jobs (last 20), their tasks, the crew and their states, the queue size, the brain state, the City in numbers, the
approval count; the cards (tool, command, path, diff up to 48 KB) with `phone.approve`; the general chat with
`phone.crew`. Never file contents, settings, provider keys, prompts, memory, peers or the audit log.

## 7. Engine commands (local person only, `src/phone/index.js`)

`phone.status`, `phone.invite.create` (returns the link and `rendezvous { topic, seal }`, never the psk),
`phone.invite.cancel`, `phone.pair.answer { requestId, accept, sasMatches, grants }`, `phone.grants { deviceId, grants }`,
`phone.revoke { deviceId }`, `phone.listen` (home topic and per phone seal keys for the window), `phone.pipe.open`,
`phone.pipe.in`, `phone.pipe.close`. Live: `phone.changed { v }` (no content), `phone.pipe.out`, `phone.pipe.closed`.

Audit entries: `phone.invite.created|cancelled|used|expired|refused`, `phone.pair.requested|accepted|refused|failed|lost`,
`phone.session.open|close`, `phone.reconnect.refused`, `phone.cmd`, `phone.refused` (at most once per 10 s per phone and
reason), `phone.grants`, `phone.revoked`, `phone.remote.request|grant|revoke` and the remote module's own entries.

## 8. Remote screen from the phone

`createPhonePort(hub)` implements the port of `src/remote/port.js` over phone sessions; `combinePorts(p2pPort, phonePort)`
gives src/remote/ one port for both. The host keeps every Stream 6 rule (dialog, session grants, indicator, kill switch,
lock detection, input checks, helper). The page's viewer (`docs/remote/js/viewer.js`, loaded on demand) has touch and
touchpad modes, pinch zoom and pan, a keyboard toggle with a US key map, special keys with sticky modifiers, quality and
End; it only sends `remote.input` events.

## 9. The page

Static, no build step: `scripts/phone-page.mjs` copies the shared modules into `docs/remote/js/vendor/` (the test fails
on drift). CSP: `default-src 'none'`, scripts and styles from the page only, `connect-src` the page and the four relays.
Refuses to run in a frame. Installable PWA with an offline shell (`sw.js`). 10 languages, chosen from the browser.
JavaScript under 100 KB gzipped without the viewer (checked in `test/phone/page.test.js`).

## Not done

* Notifications only while the page is open (no Web Push: it would need a push server).
* Known phones reconnect only while the desktop window is open (the browser pipe of 1.0).
* The phone keyboard maps characters with the US layout; other characters are not typed.
* Clipboard and file transfer are not offered on the phone (`limits` are always off).
