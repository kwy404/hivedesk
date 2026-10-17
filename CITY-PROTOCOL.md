# Hive City protocol (city version 1)

This file is the contract between the city engine (`src/city/`) and the City UI (`ui/city/`).
It extends PROTOCOL.md: same transport, same frames (`event`, `live`, `command`, `reply`), same token rules.
It only grows: fields and types may be added, nothing is renamed or removed while `city` is `1`.
Clients must ignore fields, event types and live types they do not know.

## 1. Where the city lives

* The city is part of the host engine. Every city change is a normal event on the bus with a type that starts with `city.`, appended to `.hivedesk/events.jsonl` like any other event. There is one log and one writer: the host engine. Its order is the order of the city.
* `hello.state.city` and `GET /api/state` (field `city`) carry the whole `CityState` (section 3). `hello.city` is `1` when the engine has a city.
* The pure reducer is served at `GET /lib/city.js` (the file `src/city/state.js`, no Node imports). `reduceCity(city, event)` applies one event and returns the same object; `initialCity()` gives an empty city. It also reads a few crew events (`worker.status`, `turn.started`, `turn.ended`, `crew.updated`), so feed it every event, not only `city.*`.
* A friend's machine never writes the log. Its browser sends commands to the host through the Code together data channel (`cmd` frames), and the host's browser forwards them to the host engine with `as: { id, name }` added (`ui/lend/collab/roles.js`). The host engine relays every event back to every guest (the existing `engine` frames), so all screens reduce the same events in the same order.

## 2. Conflict rules

Simple and explicit: **the owner of an entity wins**.

| entity | owner | who may change it |
| --- | --- | --- |
| machine | the person at that machine (`owner: "host"` or `"peer:<guestId>"`) | only its owner |
| agent | the owner of its home machine | only that owner (memory, tools, name, retire). The host may still move any agent and assign it tasks inside the host's project |
| room | the host | only the host (extensions add rooms through the host) |
| task | the host's project | the host; a guest may change only tasks it created, and never approve a hop of a task it did not create |
| borrow | the lender machine decides accept, refuse and limits; either side may stop it | |

A command that breaks a rule fails with `forbidden`. Commands without `as` come from the host's own browser.

## 3. Shapes

```text
CityState {
  v: 1, host: machineId, lastSeq,
  machines: { [id]: Machine },
  rooms:    { [id]: Room },
  agents:   { [id]: Agent },
  tasks:    { [id]: CityTask },
  borrows:  { [id]: Borrow },
  hops:     Hop[]                 the last 200, oldest first
}

Machine {
  id,                             "m_" + 8 hex, stable per install (~/.hivedesk/city/machine.json)
  name, host: boolean, owner: "host" | "peer:<guestId>", online: boolean,
  gpu: { name?, vramBytes?, backend? } | null, ramBytes?, cpus?,
  model?: string,                 the model this machine runs, if any
  brainId?: string,               the scheduler brain that runs turns on this machine (host: its local brain; friend: the relay brain from brain.attach)
  lending: { turns, active },     turns served to borrowers this session, active borrows
  agents: string[],               ids of the agents homed here
  via?: "words" | "qr" | "link" | "local" | "demo",
  color?: "#rrggbb", joinedAt, leftAt?
}

Room {
  id, name, kind: "work" | "review" | "test" | "board" | "library" | "ops",
  tools: string[],                tools allowed inside (PROTOCOL.md tool names); an agent's tools are cut to these while it works here
  accepts: string[],              what a task may do here: "design" | "code" | "docs" | "ops" | "review" | "test" | "plan"
  requireApproval: boolean,       after the agent's work or verdict the task waits for the user (city.task.approve)
  hostOnly: boolean,              guests cannot send tasks here (Ops)
  mode?: "auto" | "model" | "checks",  review rooms: how a review is made (section 6)
  builtin: boolean, ext?: string, order: number, color?
}
  builtin ids: "lobby", "design", "code", "review", "test", "ops", "library"

Agent {
  id,                             a local crew agent uses its worker id ("dev"); a friend's agent "<machineId>:<id>"
  workerId,                       the crew worker that acts for it (PROTOCOL.md Worker)
  name, role, avatar, color,
  specialization: string[],       room ids it works in, the first one is its home room
  level, xp,
  tools: string[], permissions: { shell: boolean, write: boolean },
  memory: { count, highlights: [{ id, kind, text }] },   pinned first, then the newest, at most 4; the full list is private (city.agent.memory.list)
  room,                           the room it stands in now
  taskId: string | null,
  status: "idle" | "thinking" | "waiting_model" | "working" | "reviewing" | "testing" | "waiting" | "sleeping" | "offline",
  brain: { kind: "local" | "lent" | "cloud" | "remote", machineId?, label? },
  home: machineId, builtin: boolean, retired: boolean,
  stats: { done, reviews, tests, loops }
}

CityTask {
  id: "ct_<n>", title, detail, criteria: string[],
  pipeline: string[],             room ids in order, for example ["design","code","review","test"]
  stage: number,                  index in pipeline; equal to pipeline.length when done
  room,                           the room it is in now ("lobby" while open on the board)
  status: "open" | "claimed" | "in_progress" | "in_review" | "in_test" | "done" | "blocked" | "cancelled",
  agentId: string | null,         who holds it now
  wantAgent?: string,             dragged onto this agent: only it may claim the next hop
  author?: string,                the agent that did the last work hop (review and test pick someone else)
  loops: number, maxLoops: 3,
  awaiting?: string | null,       a room id: waiting for the user's approval there
  issues: string[],               from the last failed review or test
  files: string[],                files this task changed
  verdicts: [{ room, agentId, passed, issues, by: "agent" | "user" | "checks" | "qa" }],
  link?: { jobId, taskId },       a crew task this city task mirrors (planner tasks)
  jobId?: string,                 the crew job running the current hop of a city task
  parent?: string, children?: string[],   a Lobby task that Mel planned into crew tasks
  createdBy: { kind: "user" | "planner" | "agent" | "guest", id, name? },
  guest: boolean,                 created by a guest: host approval rules and no shell (section 8)
  spec?: string,                  what the Design hop wrote
  createdAt, updatedAt, demo?: true
}

Hop {
  id: "h_<n>", taskId, from: roomId | null, to: roomId, agentId: string | null,
  by: "agent" | "user" | "system" | "guest", reason, loop: number, ts
}

Borrow {
  id: "bw_<n>", agentId, from: machineId,   the borrower's home machine
  to: machineId,                  the lender
  status: "pending" | "active" | "ended",
  limit: { turns, minutes },      the lender may lower them when accepting
  used: { turns, completionTokens, ms },
  reason?: string,                why it ended: "limit" | "time" | "stopped" | "refused" | "expired" | "left" | "brain_gone"
  requestedBy, createdAt, startedAt?, endedAt?
}
```

## 4. Events (`kind: "event"`, logged)

Every city event is a normal Event (`seq`, `ts`, `type`, `data`, `demo?`).

| type | data |
| --- | --- |
| `city.started` | `{ city: 1, host: machineId, version }` once per engine start |
| `city.machine.joined` | `{ machine: Machine }` a building appears (also the host at first start) |
| `city.machine.updated` | `{ machine: { id, ...changed } }` |
| `city.machine.left` | `{ machineId, reason }` its building goes dark; its agents become `offline` |
| `city.room.added` | `{ room: Room }` |
| `city.room.updated` | `{ room: { id, ...changed } }` |
| `city.room.removed` | `{ roomId }` (builtin rooms cannot be removed) |
| `city.agent.joined` | `{ agent: Agent }` hired, loaded from disk, or contributed by a friend |
| `city.agent.updated` | `{ agent: { id, ...changed } }` |
| `city.agent.moved` | `{ agentId, from, to, taskId? }` walk from one room to another |
| `city.agent.status` | `{ agentId, status, detail? }` city side changes (reviewing, testing, sleeping, offline); crew `worker.status` is mapped by the reducer |
| `city.agent.leveled` | `{ agentId, level, xp }` |
| `city.agent.memory` | `{ agentId, count, highlights }` the public view after a memory change (never the full list) |
| `city.agent.retired` | `{ agentId }` |
| `city.task.created` | `{ task: CityTask }` |
| `city.task.claimed` | `{ taskId, agentId, room, bid?: { score, skill, load, level, rivals } }` |
| `city.task.hop` | `{ hop: Hop, task: { id, room, stage, status, agentId, loops } }` every move of a task, including loops back |
| `city.task.updated` | `{ task: { id, ...changed } }` |
| `city.task.verdict` | `{ taskId, room, agentId, passed, issues: string[], by }` |
| `city.task.awaiting` | `{ taskId, room }` waiting for the user at this hop |
| `city.task.done` | `{ taskId, by }` |
| `city.task.blocked` | `{ taskId, reason }` |
| `city.task.cancelled` | `{ taskId, by }` |
| `city.borrow.requested` | `{ borrow: Borrow }` the agent asks to walk across the bridge |
| `city.borrow.answered` | `{ borrowId, accepted, limit?, by }` |
| `city.borrow.turn` | `{ borrowId, turnId, completionTokens, ms }` one model turn ran on the lender (counts only, never text) |
| `city.borrow.ended` | `{ borrowId, reason, used }` |
| `city.demo.step` | `{ step, text }` `--demo` only: a caption for the scripted scenario |

## 5. Live frames (`kind: "live"`, never logged)

| type | data |
| --- | --- |
| `city.presence` | `{ id, name, color, x, y, room?, building?, ts }` a person's cursor in the city; `id` is `"h"` for the host or the guest id. At most 15 per second per person; the engine drops extra ones |
| `city.presence.left` | `{ id }` |
| `city.machine.load` | `{ machineId, load, queue, tps }` load 0..1 (busy brain slots), sent when it changes, at most twice a second |

## 6. Commands (`kind: "command"`)

All take an optional `as: { id, name }` (added by the host's browser for a guest; never sent by a guest itself).

| type | data | result |
| --- | --- | --- |
| `city.state` | `{}` | `{ city: CityState, lastSeq }` |
| `city.sync` | `{ since?: seq }` | `{ snapshot?: CityState, snapshotSeq?, tail: Event[], lastSeq }`. With `since` at or after the snapshot, only the tail. Otherwise the last snapshot plus every city relevant event after it. A late joiner applies the snapshot, then the tail, then the live events with `seq > lastSeq` |
| `city.task.create` | `{ title, detail?, room?, agentId?, criteria?: string[], pipeline?: string[] }` room `"lobby"` (the default without agentId): Mel plans it into crew tasks. room `"design"`: pipeline design, code, review, test. Any other work room: that room, review, test. `agentId`: dragged onto an agent | `{ task }` |
| `city.task.assign` | `{ taskId, agentId }` drag a task onto an agent: it takes the next hop | `{ task }` |
| `city.task.move` | `{ taskId, room }` drag a task into a room: its pipeline continues from there | `{ task }` |
| `city.task.approve` | `{ taskId, note? }` approve the current hop (also skips a running review or test) | `{ task }` |
| `city.task.reject` | `{ taskId, note }` send it back to its work room (a loop) | `{ task }` |
| `city.task.retry` | `{ taskId }` a blocked task opens again at its current room, loops reset | `{ task }` |
| `city.task.cancel` | `{ taskId }` | `{ task }` |
| `city.agent.hire` | `{ name, role, prompt?, specialization?: string[], tools?: string[], avatar?, color? }` also hires the crew worker (`crew.hired`) | `{ agent }` |
| `city.agent.update` | `{ agentId, name?, role?, specialization?, tools?, avatar?, color? }` | `{ agent }` |
| `city.agent.move` | `{ agentId, room }` | `{ agent }` |
| `city.agent.retire` | `{ agentId }` builtin agents can be put to sleep (`status: "sleeping"`), not retired | `{}` |
| `city.agent.wake` | `{ agentId }` | `{ agent }` |
| `city.agent.memory.list` | `{ agentId }` owner only | `{ entries: AgentMemory[] }` |
| `city.agent.memory.add` | `{ agentId, text, kind?, pinned? }` | `{ entry }` |
| `city.agent.memory.update` | `{ agentId, id, text?, kind?, pinned? }` | `{ entry }` |
| `city.agent.memory.delete` | `{ agentId, id }` | `{}` |
| `city.agents.local` | `{}` this machine's own persistent agents and machine card (what a guest's browser reads from its own engine before joining) | `{ machine, agents: Agent[] }` |
| `city.machine.join` | `{ machine: { id, name, gpu?, ramBytes?, cpus?, model?, color? }, agents?: Agent[], brainId?, via? }` a friend's building and the agents it contributes | `{ machineId, agents: string[] }` |
| `city.machine.update` | `{ machineId, name?, model?, brainId?, color? }` | `{ machine }` |
| `city.machine.leave` | `{ machineId, reason? }` | `{}` |
| `city.borrow.request` | `{ agentId, machineId, turns?: 1..50 (6), minutes?: 1..60 (10) }` | `{ borrow }` |
| `city.borrow.answer` | `{ borrowId, accept: boolean, turns?, minutes? }` lender only; limits can only go down | `{ borrow }` |
| `city.borrow.stop` | `{ borrowId }` either side | `{ borrow }` |
| `city.presence` | `{ x, y, room?, building?, name?, color? }` | `{}` (send it at most 15 times a second) |
| `city.room.add` | `{ id, name, kind?, tools?, accepts?, requireApproval?, color? }` host only | `{ room }` |
| `city.room.update` | `{ roomId, name?, tools?, requireApproval?, mode?, color? }` host only | `{ room }` |
| `city.room.remove` | `{ roomId }` host only, not builtin | `{}` |

```text
AgentMemory { id, kind: "fact" | "preference" | "decision" | "task", text (max 300), pinned, ts }
              at most 40 per agent; the oldest unpinned entry goes first
```

Error codes: the PROTOCOL.md ones plus `forbidden` (a conflict rule or a guest rule) and `rate_limited`.

## 7. Behavior the UI can rely on

**Routing.** An open task waits in its room. An agent may claim it when the agent is awake, online, has no other city task, works in that room (`specialization`) and its home machine has a brain. With `wantAgent` only that agent may claim. Otherwise the agents bid: `score = 0.6 * skill + 0.25 * min(level, 10) / 10 + 0.15 * (1 - load)` where skill is 1 for the agent's home room and 0.6 for its other rooms, and load is its home machine load. The best score claims (`city.task.claimed` with the bid). A review is never claimed by the task's author; a test prefers someone who is neither author nor reviewer.

**Pipeline.** Each claim and each move emits `city.task.hop`. Work rooms (`design`, `code`, `library`, `ops` and extension work rooms) run a crew job with one task for the claiming agent; `review` checks the changed files, and in `model` mode (or `auto` for tasks the crew did not plan) the reviewer agent reads the diff against the criteria; `test` runs the static checks on the changed files (for planner tasks it waits for the crew QA report). A failed review or test sends the task back to the last work room with the issues (`loops + 1`); after `maxLoops` (3) it is `blocked`. A room with `requireApproval` emits `city.task.awaiting` and waits.

**Planner tasks.** When Mel plans a job (`job.planned`), each build and docs task (not the QA and fix tasks) becomes a CityTask with `link`, `createdBy.kind = "planner"`. The crew runs the work hop as before; QA fix rounds of the crew are the loops of these tasks. A Lobby task (`city.task.create` with room `"lobby"`) starts a crew job; its planned tasks become its `children` and it is done when they are.

**Agents.** Crew workers are agents. Levels: `level = floor((1 + sqrt(1 + 8 * xp / 25)) / 2)` (0 xp is level 1, 25 xp level 2, 75 xp level 3, 150 xp level 4). XP: work hop finished 10, review 4, test 3, task done without a loop 5 more for the author.

**Borrowing.** `city.borrow.requested` is shown to the lender, who answers. While a borrow is `active` the agent's model turns go to the lender's `brainId` (the agent walks across the bridge; each `city.borrow.turn` is a light on the bridge). It ends at its turn or time limit, when either side stops it, when the lender leaves, or when that brain detaches. Only `messages` and `options` travel, over the existing lend relay (PROTOCOL.md section 6) and the lender's own guard (`src/lend/guard.js`: size caps, rate limit, one at a time, Stop).

**Persistence.** Agents are files per machine in `~/.hivedesk/city/agents/<id>.json` (with the full private memory), so the same Dev keeps its level in every project. Rooms, tasks, hops and borrows replay from the project log. On restart, tasks that were being worked open again in the same room and are claimed again; borrows end with `reason: "stopped"`; friend machines are `online: false` until they join again.

## 8. Safety

* Guests never get a shell: a task created by a guest runs with approval mode on (every change of an existing file waits for the host) and without the `run` and `delete_file` tools, whatever room it is in. Guests cannot send tasks to `hostOnly` rooms (Ops).
* Remote work runs under the host's approval rules, on the host's files. A friend's agent thinks on its own machine (its `brainId`) but its tools run on the host, with the host's approvals.
* Borrowed GPU turns carry prompts only. The host engine logs counts, never prompt text.
* Guest commands: 40 per 10 seconds per guest (`rate_limited`), text sizes capped (title 200, detail 4000, memory text 300, names 40).
* A guest cannot claim the host's machine id or another online machine's id.
* The full memory of an agent never leaves its machine's log: events carry only the count and the highlights.

## 9. Demo

`hivedesk --demo` also plays a city scenario, every event `demo: true`, captioned with `city.demo.step`:
1. a friend, Rita, joins with the six words, her building rises (`city.machine.joined` with `via: "words"`), and she contributes Pip, a reviewer;
2. Dev's machine is busy, so Dev asks to borrow Rita's GPU (`city.borrow.requested`), Rita accepts, Dev crosses the bridge for three turns (`city.borrow.turn`), and the borrow ends at its limit;
3. a task dropped in the Design room flows Design, Code, Review (by Pip), Test and done, every hop an event.
No model runs: the fake demo brain answers for both machines.
