# Core and tasks (hivedesk 1.0, Stream 1)

The contract of `src/core/` and `src/tasks/`. It extends PROTOCOL.md (protocol 1); nothing there is renamed or removed.

## 1. Events

Every event now has an `origin` and may have a `cause`:

```json
{ "seq": 120, "ts": "2026-10-17T21:30:35.580Z", "type": "tasks.transition", "origin": { "kind": "user" }, "cause": "cm_4", "data": { } }
```

* `origin`: `{ kind: "user" | "crew" | "system" | "peer", peerId?, agentId? }`. Events written before 1.0 have none and count as `system`.
  The router sets it for a command (local token holders are `user`, src/p2p/ passes a verified `peer`), the crew engine sets `crew` with the worker id for the work of a job.
* `cause`: the id of the command (`cm_<n>`) or the seq of the event (`job.created`) that started the work.
* Async work keeps both: `runWithOrigin(origin, fn, cause)` in `src/core/origin.js` (AsyncLocalStorage).

### Schemas

Each type is registered in `src/core/events.js` with a small JSON schema (`src/core/schema.js`: type, enum, const, required, properties, additionalProperties, items, anyOf, lengths, pattern, minimum, maximum).
`registerEvent(type, schema)` for one type, `registerEventPrefix(prefix)` for a family a stream has not listed yet (city., p2p., peer., grant., audit., compute., resources., share., workbench., remote., term., ...).

| Mode | When | A bad registered event | An unregistered type |
| --- | --- | --- | --- |
| `strict` | `--strict`, `HIVEDESK_STRICT=1`, `new EventBus({ strict: true })` | throws `SchemaError`, nothing is written | throws |
| `check` | under vitest | throws | written |
| `warn` | default | written, counted in `bus.warnings` | written, counted |

The compute plane's types (docs/1.0/protocol/compute.md) are registered exactly: `job.scheduled`, `job.state`, `job.ended`, `job.leased`, `job.running`, `job.refused`, `job.served`, `share.changed`, `resources.changed`. `job.created` is shared by the 0.x crew jobs (`{ job }`) and compute jobs (`{ jobId, model, priority, taskId?, agentId? }`) and stays loose; the crew and board reducers read only the crew shape.

### New event types

| Type | Data |
| --- | --- |
| `tasks.created` | `{ task: Task }` (state `queued`) |
| `tasks.transition` | `{ taskId, from, to, reason?, waitingFor?, failure?, assignee?, stage?, loops?, attempts?, resumeTo? }` |
| `tasks.updated` | `{ task: { id, ...fields } }` title, detail, criteria, assignee, pipeline, stage, dependsOn, jobIds, maxLoops, maxAttempts, legacy |
| `tasks.logged` | `{ taskId, level: "info" | "warn" | "error", text }` |
| `tasks.artifact` | `{ taskId, artifact: { id, kind: "file" | "diff" | "report" | "link" | "job" | "note", path?, ref?, label?, bytes? } }` |
| `store.migrated` | `{ migration, detail }` once per migration of the project folder |
| `store.restored` | `{ snapshotSeq, replayed, ms, interrupted: taskId[] }` once per start (Restore City) |

## 2. Store by domain

`src/core/store.js` composes pure reducers over the one log:

| Domain | Reducer | Mounted at | UI module |
| --- | --- | --- | --- |
| crew | `src/replay/reduce.js` | the root of `bus.state` (the 0.x shape) | `/lib/reduce.js` |
| city | `src/city/state.js` | `bus.state.city` | `/lib/city.js` |
| tasks | `src/tasks/state.js` | `bus.state.board` | `/lib/tasks.js` |

`bus.state.tasks` stays the 0.x crew task map. Other streams add a domain before the bus is made:

```js
import { registerDomain } from './src/core/store.js';
registerDomain({ name: 'peers', version: 1, initial: () => ({ peers: {} }), reduce: (s, event) => s, file: 'src/p2p/state.js' });
```

A domain reducer is pure and import free, ignores unknown types and never throws (a throw is caught and kept in `store.errors`).
Bump `version` when a reducer change makes old snapshots wrong; a snapshot is used only when every domain version matches.

`bus.state.demo` is true only while the engine runs `--demo` (not sticky any more).

## 3. Log segments and snapshots

```text
<project>/.hivedesk/
  events.jsonl           the 0.x log: read as segment 0, never written again
  events/000001.jsonl    segments named by their first seq, at most 64 MB each
  events/demo-0.2.jsonl  demo events moved out of a 0.2 project (not read)
  snapshots/<seq>.json   { v, ts, seq, store: { v, domains, state } } every 5,000 events, every 10 minutes and on close; the newest 3 are kept
  meta.json              { v, layout: 2, createdWith, migrations: [{ id, at, detail }] }
  demo                   marker: this is a demo folder
```

* Start: the newest snapshot that matches the reducers and is not ahead of the log, then only the events after it.
* `bus.events` (the whole history) is read from the segments on first use; `bus.since(seq)` and `bus.stateAt(seq)` after the snapshot do not need it.
* A torn last line (a crash during a write) is skipped on read and closed with a newline before the next append.
* `bus.info()` and the `store.info` command: `{ lastSeq, segments, bytes, snapshots, restore, warnings, strictness }`.

## 4. Migrations

`src/core/migrate.js`: every JSON file has `v`. A module registers one step per version for the kinds of files it owns:

```js
registerMigration('peer', 0, (d) => ({ ...d, trust: d.trust || 'unknown' }));
const peer = readVersioned(file, 'peer');   // upgraded; a file from a newer hivedesk throws code too_new
writeVersioned(file, 'peer', peer);          // tmp file plus rename
```

`~/.hivedesk/settings.json` is not migrated by the core: its `share` section belongs to `src/compute/share.js`, has its own `v` and is kept as it is.

Project migrations run before the log is opened (`migrateProject`):
* `layout-1.0`: the 0.x `events.jsonl` stays as segment 0.
* `demo-0.2`: in a real (not `--demo`) run, demo events of a 0.2 log move to `events/demo-0.2.jsonl`; `state.json`, `city/snapshot.json` and the snapshots are dropped, so the demo machine leaves the city. A crash in the middle is finished on the next start.

## 5. Demo separation

* `--demo` runs in a fresh temp folder, or in `--dir` only when it is empty or already a demo folder; otherwise `startHive` throws `DemoRefused` (code `demo_refused`) and the CLI exits with 2.
* A demo has its own home inside the demo folder (`.hivedesk/demo-home`, removed when it stops): identity, peers, settings, agents and memory never touch `~/.hivedesk`.
* A demo does not write `~/.hivedesk/engine.json`.

## 6. The command router

`src/core/router.js`; `server.command(type, handler, spec?)` registers through it and `server.runCommand(type, data, client, origin?)` runs through it. Handlers get `(data, client, ctx)` with `ctx = { origin, commandId, capability }`.

| Origin | Allowed |
| --- | --- |
| `user` (a local token holder), `system`, `crew` | every command |
| `peer` | only a command whose spec names a capability (`spec.peer`, or `DEFAULT_PEER_CAPS`) that the grant checker confirms; never a `local: true` command, and never a command of `LOCAL_ONLY_PREFIXES` (`compute.`, `store.`, `brain.`, `provider.`, `settings.`), whatever its spec says |

* `router.setGrantChecker((peerId, capability, { type, data }) => boolean)` is set by src/p2p/. Until then every peer command is refused (`not_granted`). A checker that throws is a no.
* For a peer, `data.as` is replaced by `{ id: peerId, name, verified: true }`: the identity comes from the session, never from the data. For a user, `as` stays (the Code together glue of the host's own tab can only narrow what a command may do).
* 40 commands per 10 s per peer (`rate_limited`), `spec.noRate` for presence like commands.
* `spec.schema` is checked before the handler (`bad_request`).
* `router.onCommand(fn)` sees every dispatch, allowed or refused, for the audit log.
* New error code `not_granted` (HTTP 403).

`DEFAULT_PEER_CAPS`: `city.view` for ping, city.state, city.sync, city.presence, tasks.list, tasks.get; `city.member` for the city task, agent, machine and borrow commands a guest used in 0.2 and tasks.create, tasks.retry, tasks.cancel; `chat` for chat.send; `workspace.read` for files.list and files.read. Everything else is local only.

## 7. Tasks

One model with nine states (PLAN.md section 2, `Task`): `queued`, `assigned`, `working`, `waiting`, `review`, `testing`, `completed`, `failed`, `cancelled`.

| From | To |
| --- | --- |
| queued | assigned, waiting, failed, cancelled |
| assigned | queued, working, waiting, failed, cancelled |
| working | assigned, waiting, review, testing, completed, failed, cancelled |
| waiting | queued, assigned, working, review, testing, failed, cancelled (and waiting, when what it waits for changes) |
| review | assigned, working, testing, waiting, completed, failed, cancelled |
| testing | assigned, working, review, waiting, completed, failed, cancelled |
| completed, cancelled | queued (retry) |
| failed | queued (retry), cancelled |

Rules of the engine (`src/tasks/engine.js`):
* Dependencies must exist; a cycle is refused. A task with unmet dependencies is `waiting { kind: "dependency", ref }`; when they complete it goes to `assigned` (or `queued`); when one fails or is cancelled it fails with `dependency_failed`, and a retry of that one brings it back.
* `loopBack` (review or testing found problems) counts a loop; past `maxLoops` the task fails with `max_loops`.
* Waits: `approval` and `user` show their deadline and never act by themselves; `peer` (default 120 s) and `resource` fail at their deadline (`peer_lost`, `timeout`).
* A failed compute job (`jobFailed`) never leaves a task in `working`: a retryable error (timeout, disconnected, lease_expired, crashed, oom, bad_output) with attempts left waits for a peer; otherwise the task fails (`timeout`, `peer_lost`, `rejected` for revoked, else `error`). Going on after a peer wait is a new attempt.
* A peer changes only the tasks it created.
* Restore City: at start, native tasks that were `working`, `review` or `testing` wait for the user (`ref: "restart"`) and go on from `assigned`; peer deadlines are armed again.

Tasks run by the crew: `tasks.create { run: "crew", assignee: <crew worker> }` becomes a one task crew job (`job.created.job.taskRef`); its progress moves the task (working, waiting for approvals, completed or failed), its files become artifacts and its crew chat the task log. Cancel and reassign stop the job.

0.2 tasks on the board: each crew task is `crew:<id>`, each city task `city:<id>`, and the city task of a planner task joins its crew task. Their state is derived from their 0.2 status (crew: pending or ready to assigned or waiting for dependencies, running to working or testing for QA, waiting_approval to waiting, done, failed, blocked to failed with dependency_failed, skipped to cancelled; city: open, claimed, in_progress, in_review, in_test, done, blocked, cancelled, and awaiting to waiting for approval). Retry, reassign and cancel of those go to the crew (`hive.retryTask`, ...) or to the city commands with the same origin. The steps of a crew job run for a city or native task join that task.

### Commands

| Command | Data | Peers |
| --- | --- | --- |
| `tasks.list` | `{ state?, assignee? }` -> `{ tasks, counts }` (last 20 logs and history lines each) | city.view |
| `tasks.get` | `{ taskId }` -> `{ task }` | city.view |
| `tasks.create` | `{ title, detail?, criteria?, dependsOn?, assignee?, pipeline?, maxLoops?, maxAttempts?, run? }` | city.member (never `run`) |
| `tasks.retry`, `tasks.cancel` | `{ taskId }` | city.member, own tasks only |
| `tasks.reassign` | `{ taskId, agentId }` | no |
| `tasks.update`, `tasks.assign`, `tasks.start`, `tasks.review`, `tasks.test`, `tasks.loop`, `tasks.wait`, `tasks.resume`, `tasks.complete`, `tasks.fail`, `tasks.log`, `tasks.artifact`, `tasks.history` | see `src/tasks/commands.js` | no |
| `store.info` | `{}` | no |

## 8. Command line

`hivedesk [command]`; no command is `start`, and every 0.2 flag still works (`--doctor` is `doctor`).

| Command | Owner |
| --- | --- |
| `start`, `city [--dir] [--json]`, `doctor [--p2p] [--json]`, `help` | src/cli.js |
| `invite`, `join`, `peers` | `src/p2p/cli.js` exports `P2P_SUBCOMMANDS[name](argv, { home, stdin, stdout, stderr })` returning the exit code (Stream 2) |
| `share` | built in; runs `runShare(argv, { home })` of `src/compute/share-cli.js` (Stream 3), which parses its own options |

Other modules may instead export `subcommands`: a provided subcommand is `{ summary, usage, options: { name: 'string' | 'boolean' }, run(ctx) => exitCode }` with
`ctx = { name, flags, positionals, home, dir, version, out, err, findEngine, startHive, loadToken }`. Every subcommand takes `--dir`, `--json` and `--help`.
`findEngine()` returns the engine `hivedesk start` runs (from `<home>/engine.json`, checked with a ping) with `command(type, data)` and `state()`, or null.
A subcommand whose module is missing prints that it is not in this build and exits with 3.
