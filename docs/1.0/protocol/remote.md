# Remote screen protocol (Stream 6)

Code: `src/remote/` (engine), `ui/remote/` (window), `desktop/helpers/` and `desktop/native.js` (native helpers).
Plan: `docs/1.0/PLAN.md` section 12. Every rule below is enforced in the engine of the side that owns the
resource (the host for its screen, mouse, keyboard and clipboard; the receiver for its disk).

## 1. Finding a machine: the 10 digit address

* `address = nine digits + Damm check digit`. The nine digits are `100000000 + (sha256("hivedesk remote address v1\0" || raw Ed25519 public key)[0..16] mod 900000000)`. Shown as `999 999 999 9` or `999 999 9999`.
* The address is not a secret and not a credential. It names the relay topic `hivedesk/r1/` + base64url(sha256("hivedesk remote topic v1|" + address))[0..22]. Whoever answers there must pass the p2p identity handshake, and then the host's Accept (or the unattended password grant).
* Nine digits can collide. `findCollision` checks the known peers; the dialer always sees the answering machine's name and fingerprint words, and the host sees the caller's name, address, avatar and words.
* A machine is reachable only while "Let partners reach this computer by its address" is on (`remote.listen`), which is off by default.

## 2. Messages (inside the encrypted p2p session)

| Type | Stream | Direction | Body | Checked |
| --- | --- | --- | --- | --- |
| `cap.request` | 1 | viewer to host | `{ capability: { name: "remote.view" or "remote.control", limits: { clipboard, files } }, reason }` | rate limited by p2p; opens the host dialog, 60 s countdown |
| `remote.ready` | 1 | host | `{ mode, expiresAt, clipboard: "off" or "to_viewer" or "to_host" or "both", files, control, reason, via, displays }` | sent only after the host's click (or the unattended check) |
| `remote.refused` | 1 | host | `{ reason: "declined" or "timeout" or "busy" or "stopped" or "wrong_password" or "unattended_*" }` | |
| `remote.unattended` | 1 | viewer | `{ password, control }` | scrypt check, known peers only by default, 5 failures lock 15 minutes |
| `remote.sdp`, `remote.ice` | 3 | both | `{ kind, sdp }`, `{ candidate }` | only inside a granted share; SDP up to 32 KB, 256 candidates |
| `remote.input` | 1 | viewer | `{ events: [{ k: "move", x, y, d? } or { k: "btn", b, down } or { k: "wheel", dx, dy } or { k: "key", code, down }] }` | live control grant, expiry, pause, helper, lock fresh and unlocked, whole screen shared, 120 events per second, 240 per message, key allowlist |
| `remote.state` | 1 | host | `{ locked, paused, control, reason, expiresAt, tracks, displays }` | |
| `remote.screen` | 1 | viewer | `{ op: "switch" or "add", display }` | a request; the host picks the screen with a click |
| `remote.quality` | 1 | viewer | `{ preset: "auto" or "balanced" or "quality" or "speed" }` | |
| `remote.chat` | 1 | both | `{ text }` up to 2,000 characters | live share or view |
| `remote.stop` | 1 | both | `{ reason }` | |
| `clip.text` | 2 | both | `{ text, html? }` text up to 1 MB, HTML up to 2 MB | clipboard grant and its direction, not paused, receiver not locked |
| `clip.image` | 2 | both | `{ png }` up to 8 MB (base64 about 11 MB) | same |
| `clip.files` | 1 | both | `{ id, entries: [{ rel, size, dir }], total }` up to 2,000 entries and 2 GB | same |
| `clip.files.get` | 1 | receiver | `{ id }` | sender checks it still may send |
| `file.offer` | 1 | sender | `{ id, name, size, sha256, chunks, clipId?, rel? }` | `file.send` grant and the receiver's Accept, or a paste the receiver asked for |
| `file.answer` | 1 | receiver | `{ id, accept, from }` | `from` resumes at a chunk index |
| `file.chunk` | 2 | sender | `{ id, i, data }` 64 KB base64, in order | 8 in flight |
| `file.ack`, `file.pause`, `file.done`, `file.cancel` | 1 | | | |

Stream 2 needs size caps of at least 12 MB for `clip.image` and 3.5 MB for `clip.text`, and 90 KB for `file.chunk`.

## 3. Grants

`remote.view` or `remote.control` (control implies view), plus optional `clipboard.text` (limits `{ dir }`) and `file.send`,
all `scope: "session"` with `expiresAt` of 5, 15 or 60 minutes. Every box in the host dialog starts unticked; a box
counts only for what the viewer asked for; Accept with neither view nor control ticked grants nothing. A local
agent may get `remote.view` only (no control, clipboard or files). Unattended access grants at most what the host
set, for at most 60 minutes.

## 4. Engine commands (local person only; any peer or crew origin is refused)

`remote.state`, `remote.address`, `remote.listen`, `remote.connect`, `remote.answer`, `remote.ask`, `remote.unattended.get`,
`remote.unattended.set`, `remote.unattended.connect`, `remote.stop`, `remote.stopAll`, `remote.pause`, `remote.share.started`,
`remote.share.removed`, `remote.display`, `remote.screen`, `remote.quality`, `remote.signal`, `remote.signals`, `remote.input`,
`remote.chat.send`, `remote.chat.log`, `remote.clip.send`, `remote.clip.take`, `remote.clip.fetch`, `remote.clip.folder`,
`remote.file.offer`, `remote.file.answer`, `remote.file.cancel`, `remote.file.pause`, and `POST /api/remote/upload`
(header `x-hivedesk-upload: 1`).

Live frames (`remote.changed`, `remote.signal`, `remote.clip`, `remote.clip.files`, `remote.clip.filesDone`, `remote.chat`,
`remote.file`, `remote.ended`, `remote.quality`) carry ids and counts only; the window pulls content with a command.

## 5. Native helpers

Only what `NATIVE_HELPERS` in `desktop/native.js` lists is started or packaged; a shipped helper must match its pinned
SHA-256 (LF normalized).

* Windows: `desktop/helpers/win-input.ps1`, one PowerShell process with inline C#: `SendInput`, `RegisterHotKey`
  (Ctrl+Alt+Shift+K), an always on top indicator with Stop, lock state from `WTSQuerySessionInformation` and the input
  desktop name every 400 ms, clipboard watch (`AddClipboardFormatListener`) and write (CF_UNICODETEXT, CF_HTML,
  PNG and DIB, CF_HDROP). Line protocol in the file header.
* X11: `xdotool` (input), `loginctl` (LockedHint), `xclip` (clipboard), each called when installed, never shipped.
* Wayland: no control; clipboard through `wl-paste` and `wl-copy` when installed.
* macOS: view only. Control needs a signed app; the clipboard uses the window (text and images with focus).
