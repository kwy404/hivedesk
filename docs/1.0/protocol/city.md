# City 1.0 protocol additions (Stream 4)

Extends CITY-PROTOCOL.md (city version 1). Only additions; nothing renamed or removed.

## State

* `CityState` gains `name`, `onboarded`, `pipeline` (default `["design", "code", "test", "review"]`) and `members` (`{ [peerId]: CityMembership }`, PLAN section 2).
* `Room` gains `role`: `architect` (design), `developer` (code), `qa` (test), `reviewer` (review), `planner`, `writer`, `ops`.
* `Agent` gains the 1.0 fields, kept by the reducer: `machineId`, `thinksOn { kind: local | peer | cloud, peerId?, model }`, `model`, `permissions { shell, write, tools, capabilities }`, `history { done, reviews, tests, loops, lastTasks }`, `owner` (the PeerId of its machine, when known). Friend agents also carry `granted` (tools the host granted beyond the read only set).
* `CityTask` gains `state` (the nine 1.0 TaskStates), `waitingFor` and `history` (the last 50 state changes with seq, ts, from, to, by, reason).
* `Machine` gains `peerId` (only from a verified p2p session) and `reported: true` for a friend's join data (not verified).

## Events

| type | data |
| --- | --- |
| `city.named` | `{ name }` |
| `city.onboarded` | `{ skipped }` |
| `city.pipeline.updated` | `{ pipeline }` |
| `city.member.joined` | `{ member: CityMembership }` |
| `city.member.updated` | `{ member: { peerId, grants } }` |
| `city.member.left` | `{ peerId, reason: "revoked" \| "peer_lost" }` |
| `city.visit.started` / `city.visit.ended` | guest side: `{ hostPeerId, name?, machineId?, reason? }` |

The reducer also reads `job.scheduled` (`{ jobId, decision, job?: { agentId } }`) to set where an agent thinks.

## Live frames

* `city.machine.load` gains `slots: { busy, total }` and a real `tps` (the last `turn.ended` on that machine's brains, 0 when none). `load` stays for 0.2 clients; it is busy model slots, not CPU or GPU load.
* `city.remote` `{ hostPeerId, event }`: guest side, an event of the friend city this engine visits.

## Commands

| type | who | does |
| --- | --- | --- |
| `city.pipeline.set` | host | `{ pipeline: roomId[] }` the default order for new tasks |
| `city.name.set` | host | `{ name, machineName? }` |
| `city.onboard.done` | host | `{ skipped? }` |
| `city.agent.grant` | host | `{ agentId, tools }` more than read only tools for a friend's agent, never `run` or `delete_file` |
| `city.room.update` | host | now also `role` |
| `city.remote.list`, `.visit`, `.leave`, `.state`, `.cmd` | this engine's own window only | visit a friend's city over p2p (src/city/membership.js) |

`GET /api/city/strings` serves `i18n/parts/city.en.json` until Stream 1 merges it.

## Pipeline

A task dropped in a room follows the rest of `pipeline` from that room; a room outside it goes to that room and then the checking rooms of the pipeline. QA (`test` kind rooms) runs the workspace's `npm test` when package.json has a real test script (verdict `by: "qa"`, the exit code and the last output lines as issues) and the static checks otherwise. The run is always asked for, in any approval mode, when a guest created the task, a friend's agent worked on it, or it changed package.json. Planner tasks keep the 0.2 flow (review checks, then the crew QA report).

## Membership over p2p (src/city/membership.js)

* A peer's `city.cmd` runs as that peer: `who` comes from the session (PeerId, the peer's own name), `as` in the data is dropped.
* `city.view`: `city.state`, `city.sync`, `city.presence`. `city.member`: also the machine, task, agent and borrow commands (the city's owner rules still apply). Host only commands are refused whatever the grants.
* The building id is `m_` + 8 hex of sha256(PeerId); no host brain is ever linked; the agents' tools are read only; they think only through `compute.peerBrainId(peerId)` when Stream 3 provides it.
* Host events go to every peer holding `city.view` or `city.member` as `city.event` frames; `worker.status` and `turn.started` lose free text, `city.agent.memory` never leaves.
* Answers are `city.reply { re, ok, result | error }`; a guest's command has a 10 s deadline.
