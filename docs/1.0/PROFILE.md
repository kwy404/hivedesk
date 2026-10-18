# The local profile

Who you are on this machine, so everyone in a City knows who is who. A display name and an avatar
picked from a built-in gallery are shared with peers; everything else (bio, statistics,
achievements) stays local.

## Files in the hivedesk home

| File | Written by | Content |
| --- | --- | --- |
| `profile.json` | the installer (first run), then the app | `{ name, avatar, bio, createdAt, shareAchievements }` |
| `profile-stats.json` | the app | `{ v, stats, unlocked, seen }`, never sent anywhere |

### Installer contract

The installer may write `profile.json` before the first start with only two keys:

```json
{ "name": "Rita Lopes", "avatar": "comb-amber" }
```

* `name`: any string; the app keeps at most 32 characters after removing control, bidi override
  and zero width characters, and trims spaces. An empty result means "no name yet".
* `avatar`: an id from the gallery (`ui/profile/avatars.js`, `AVATAR_IDS`), for example
  `comb-amber`, `bee-blue`, `tower-slate`, `bridge-teal`, `orbit-violet`, `grid-rose`,
  `rings-green`. Anything else is dropped and the monogram of the name is used.
* Any other key is ignored and removed when the app writes the file back.

On the first start the app reads the file, sanitizes it, adds `createdAt` (the "member since"
date) and writes it back. Onboarding then shows the name and avatar prefilled.

## What peers see

After a session opens, each engine sends `profile.hello` on the control stream
(`src/p2p/messages.js`): `{ name, avatar }`, plus `achievements` (a count) only when the user turns
on "share how many achievements you unlocked". The receiver sanitizes it again
(`src/profile/sanitize.js`): name up to 32 characters, avatar id from the allowlist only, never an
image or a URL. A peer without a usable name is shown by its PeerId short form (`hd1` and eight
characters). The profile is kept with the peer (`<home>/p2p/peers/<peerId>.json`) and appears in
`p2p.peers`, the City members, Machines, the peer panel, chat and the remote desktop accept
dialog.

## Statistics

Every number is counted from the engine's own event log (`src/core/bus.js`), once per event: the
last sequence seen is kept per project, so a restart or a replay never counts twice. Sources:

| Number | Event |
| --- | --- |
| projects, jobs finished | `job.done` (projects are distinct project folders) |
| files written | `file.changed` with op create or modify |
| tasks by domain | `task.status` done, the domain from the worker's role |
| crew hours, tokens | `turn.ended` ms and completionTokens |
| models used | `brain.status` ready with a model |
| GPU and CPU hours lent | `job.served` completed, by device |
| hours borrowed | `job.ended` completed on a peer |
| friends connected | `p2p.peer` online, distinct PeerIds |
| remote sessions | `p2p.grant` of a `remote.*` capability |
| playbooks used | `playbook.used` |
| streak | days with a finished job or a model turn |

## Achievements

33 achievements (`ui/profile/achievements.js`), each tested on the counters above and stored with
the date it was first unlocked. Locked ones show how to unlock them. "Clean security check" is
unlocked only by the engine's own doctor run from the Profile page (`profile.check`); "First voice
conversation" by a finished voice utterance in the window (`profile.milestone`).

## Commands (local user only)

| Command | Data | Result |
| --- | --- | --- |
| `profile.get` | none | `{ profile, stats, achievements, peerId, peerShort, address }` |
| `profile.set` | `{ name?, avatar?, bio?, shareAchievements? }` | the same view |
| `profile.milestone` | `{ kind: 'voice' }` | the same view |
| `profile.check` | none | `{ ok, failed }` |

Live frames: `profile.changed` (the view) and `profile.unlocked` (`{ id, at }`).
