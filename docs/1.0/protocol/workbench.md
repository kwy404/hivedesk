# Workbench protocol (Stream 5)

Engine side: `src/workbench/`. Window side: `ui/workbench/`. Commands use the usual `{ kind: "command", id, type, data }` frames (PROTOCOL.md section 4). Frames the engine sends to one window only have their own kind, `{ kind: "wb", type, data }`, so the Code together relay (which forwards `event` and `live` frames to guests) never carries them.

## Origins and capabilities

`client.origin` is `{ kind: "user" | "crew" | "system" | "peer", peerId?, sessionId? }`, set by the engine (Stream 1 router, Stream 2 sessions), never by the browser. No origin means the local token holder (`user`).

| Command group | Local user | Peer | Agent (crew) |
| --- | --- | --- | --- |
| `wb.term.*` | yes | never (only `term.*` messages on a shared terminal, below) | never |
| `wb.scm.*`, `wb.settings.*`, `wb.roots.*`, `wb.fs.watch`, `wb.peers` | yes | never | never |
| `wb.fs.list`, `wb.fs.files`, `wb.fs.read`, `wb.fs.count`, `wb.search`, `wb.search.cancel`, `wb.doc.open`, `wb.doc.presence`, `wb.doc.close`, `wb.doc.people`, `wb.info` | yes | `workspace.read` or `workspace.propose`, workspace root only | never |
| `wb.fs.write`, `wb.fs.mkdir`, `wb.fs.rename`, `wb.fs.delete`, `wb.replace.preview`, `wb.replace.apply`, `wb.doc.ops`, `wb.doc.save`, `wb.doc.reload` | yes | `workspace.propose`; every write waits for host approval, new files included | never |

The table is `POLICY` in `src/workbench/origin.js`. A grant counts when it names the peer, `grantedBy: "user"`, is not revoked and is not expired.

## Commands

All take `root` (default `"ws"`, the workspace; other ids are folders the user added, `r_...`).

| Command | Data | Result |
| --- | --- | --- |
| `wb.info` | | `{ protocol, roots, terminal: { kind: "pty" \| "basic", reason? }, share: { available, minutes, defaultMinutes }, settings, platform }` |
| `wb.settings.get` / `wb.settings.set` | `{ settings: patch }` | `{ settings }` |
| `wb.roots.list` / `wb.roots.add` / `wb.roots.remove` | `{ path }` / `{ id }` | refuses relative paths, drives, the home folder itself and the hivedesk folder |
| `wb.fs.list` | `{ dir }` | `{ dir, entries: [{ name, path, type: "file" \| "dir" \| "link", bytes?, heavy? }], truncated }` |
| `wb.fs.files` | | `{ files: [{ path, bytes }], truncated }` with the ignore rules |
| `wb.fs.read` | `{ path }` | `{ path, bytes, content, sha }`, or `binary` / `tooLarge` (over 2 MB) with `content: null` |
| `wb.fs.write` | `{ path, content }` | workspace writes go through the tools (`file.changed` events); other roots never enter the log |
| `wb.fs.mkdir`, `wb.fs.rename { from, to }`, `wb.fs.count`, `wb.fs.delete { path, recursive?, confirmFiles? }` | | a folder with content needs `recursive` and `confirmFiles` equal to the current file count, else `confirm_required` |
| `wb.fs.watch` | `{ on? }` | `fs.changed` frames `{ root, paths }` for changes made outside hivedesk |
| `wb.search` | `{ query, regex, caseSensitive, wholeWord, include, exclude, maxHits?, wait? }` | `{ searchId }` then `search.result { searchId, path, hits }` and `search.done` frames; with `wait` (or REST) the results in the reply. At most 5,000 hits, files up to 2 MB, 30 s, two worker threads |
| `wb.replace.preview` | search fields plus `replace`, `paths?` | `{ previewId, files: [{ path, count, changes }], total }`, nothing written |
| `wb.replace.apply` | `{ previewId, paths? }` | `{ files, skipped }`; a file changed since the preview is skipped |
| `wb.term.open` | `{ cols, rows, cwd? }` | `{ termId, kind, shell, cwd }`; output as `term.data { termId, data }`, end as `term.exit { termId, code, signal }` |
| `wb.term.list`, `wb.term.attach`, `wb.term.input { data }`, `wb.term.resize`, `wb.term.close` | `{ termId }` | `attach` returns the last 256 KB of output |
| `wb.term.share` | `{ termId, peerId, mode: "read" \| "write", minutes: 5 \| 15 \| 60 }` | creates a session grant through P2P, below |
| `wb.term.unshare` | `{ termId, peerId? }` | revokes |
| `wb.scm.status`, `wb.scm.diff { path, staged }`, `wb.scm.stage`, `wb.scm.unstage`, `wb.scm.discard { paths }`, `wb.scm.commit { message, amend? }`, `wb.scm.branches`, `wb.scm.checkout { branch, create? }`, `wb.scm.stashes`, `wb.scm.log`, `wb.scm.init` | | commit takes only what is staged; workspace commits log `github.committed` |
| `wb.doc.open { path, name?, color? }` | | `{ path, snap, saved, client, canEdit }` (a CRDT snapshot, `ui/lend/collab/crdt.js`) |
| `wb.doc.ops { path, ops }`, `wb.doc.presence { file, sel }`, `wb.doc.save`, `wb.doc.reload`, `wb.doc.close` | | frames `doc.ops`, `doc.presence`, `doc.saved`, `doc.disk`, `doc.people`, `doc.reset`, `doc.removed` |

Inserts in `wb.doc.ops` must carry the client id the room gave that window or peer; anything else is refused (`forbidden`).

## What the workbench needs from src/p2p (Stream 2)

`registerWorkbench({ ..., p2p })` takes an object with:

```ts
interface WorkbenchP2P {
  grant(req: { peerId: PeerId; capability: Capability; scope: "session"; expiresAt: string; grantedBy: "user" }): Grant | Promise<Grant>;
  revoke(grantId: string, reason: string): void | Promise<void>;
  grantsFor(peerId: PeerId): Grant[];              // grants this engine issued to that peer
  send(peerId: PeerId, msg: { t: string; body: object }): boolean;   // stream 1, encrypted session
  audit(entry: object): void;                       // hash chained audit log
  peers?(): Array<{ peerId: PeerId; name: string; online: boolean }>;
  onGrantChange?(fn: (ev: { grantId: string; revokedAt?: string }) => void): () => void;
}
```

And the workbench gives back, from its `register` result:
* `peerCommand({ peerId, sessionId, push }, type, data)`: runs a `wb.*` command as that peer (`push(type, data)` delivers the frames).
* `handlePeerMessage({ peerId }, { t, body })`: the `term.*` messages of PLAN section 4.
* `peerGone({ peerId })`: the session closed.

### Terminal sharing messages (stream 1)

| Message | Direction | Body | Check on this machine |
| --- | --- | --- | --- |
| `term.offer` | host to peer | `{ termId, mode, expiresAt, shell, cols, rows }` | sent when the user shares |
| `term.attach` | peer to host | `{ termId }` | a valid `terminal.share.read` or `.write` grant with `limits.terminalId` equal to `termId`, `scope: "session"`, the grant of the current share |
| `term.input` | peer to host | `{ termId, data }` | the same with `terminal.share.write` |
| `term.detach` | peer to host | `{ termId }` | |
| `term.data` | host to peer | `{ termId, data }` at most 32 KB each | the grant is checked again before every flush |
| `term.closed` | host to peer | `{ termId, reason }` | stop, revoke, expiry or exit |

`term.open`, `term.resize` and `term.close` from a peer are refused. Audit entries: `terminal.share.start`, `.attach`, `.input` (byte count per burst, never the text), `.stop`.

## Since the 1.0 integration

* `src/index.js` loads the workbench with the p2p port of `src/p2p/workbench-port.js`; every `wb.*` command is local only in the router and refused for any non user origin before the workbench's own check.
* Terminal shares are node grants (`terminal.share.read` or `.write`, `scope: "session"`, `limits.terminalId`). `term.attach`, `term.input` and `term.detach` from a session reach `handlePeerMessage` and are answered with `term.reply { re, ok, result? | error? }`; a peer's `wb.cmd { id, type, data }` runs through `peerCommand` and is answered with `wb.reply`; streamed frames go back as `wb.push { type, data }`. On the receiving engine these arrive as the live frame `p2p.workbench`, and the window answers with `p2p.workbench.send` (local user only).
* `node-pty` 1.1.0 is an `optionalDependency`: npm and npx installs get its prebuilt binaries on Windows and macOS (Linux builds it when a toolchain exists). The desktop packages carry no `node_modules`, so the desktop app uses the labeled basic terminal over pipes until per platform node-pty builds for the bundled Node are added to the desktop workflow.
* Package size: `ui/screenshots` (14 MB of development captures) is left out of the npm package (`!ui/screenshots` in `files`, honored by `desktop/scripts/package.mjs` too); with the vendored TypeScript service and xterm.js the package is about 7 MB packed, 23 MB unpacked.
