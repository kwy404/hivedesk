# Notes for Hive City (src/city/ engine, ui/city/ UI)

## From the City UI (ui/city/)

The City UI reads everything through one adapter, `ui/city/model.js`, so the final names in
`CITY-PROTOCOL.md` win and only the adapter changes. Until that file exists the UI runs against a
local mock (`?city=mock`, `ui/city/mock.js`) that follows these assumptions:

1. `hello.state.city` carries a snapshot: `{ machines, rooms, agents, tasks, people }`.
2. Logged events under `city.*` change it (machine joined or left, agent moved, task claimed,
   moved or done, GPU borrow started or ended). Presence (cursors) is a `live` frame, never logged.
3. Commands the UI sends: create a task (in a room or for an agent), assign a task by drag,
   move an agent to a room, edit an agent's memory and tools, hire and retire, set lent capacity,
   and the user's own cursor (throttled to about 10 per second).

When the city is missing from `hello` the UI derives your building from the crew and the jobs, so
the City view works on an older engine too.

## From the city engine (src/city/)

`CITY-PROTOCOL.md` is written and is the contract. Points that answer the list above:

1. `hello.state.city` is the full `CityState` (`machines`, `rooms`, `agents`, `tasks`, `borrows`,
   `hops`). People are not in it: they are the live `city.presence` frames plus the `online`
   machines. `hello.city` is `1`.
2. The reducer is served at `/lib/city.js` (`initialCity`, `reduceCity`). Feed it every event: it
   also maps the crew `worker.status` to the agent status.
3. Lent capacity: the lender sets limits when it answers a borrow (`city.borrow.answer` with
   `turns` and `minutes`). There is no standing capacity setting yet.
4. The guest side: please send `city.*` commands through the collab `cmd` frame; the host's
   `roles.js` adds `as` (the engine side handles the rest). Before joining, a guest's browser reads
   `city.agents.local` from its own engine and sends `city.machine.join` with that machine and its
   agents (and the `brainId` the host got from `brain.attach`, when it lends).

### Engine status (done, committed)

* `src/city/` is in: agents, rooms, the task bus, the pipeline with loops, machines, borrows,
  presence, `city.sync`, persistence and the `--demo` scenario. `npm test` covers it (`test/city/`).
* `/lib/city.js` exports `initialCity`, `reduceCity`, `replayCity`, `ROOMS`, `levelFor`,
  `publicMemory`, `statusForKind`, `isCityEvent`. Pure, no imports.
* `ui/lend/collab/roles.js` now allows the `city.*` commands (viewers: see, join with a building,
  lend and borrow; collaborators: the task board) and replaces any `as` with the real guest.
* What the browser glue still has to do (UI side, `ui/lend/` or `ui/city/`):
  1. Guest, after `welcome`: `city.agents.local` on its own engine, then `city.machine.join`
     to the host through `cmd` (with `brainId` when its brain is attached on the host).
  2. Host, when a guest's peer closes: `city.machine.leave { machineId }` (the host may do it
     for any machine).
  3. Guest, on `city.agent.leveled` for one of its own agents: `city.agents.save` on its own
     engine, so the level it earned in a friend's city is kept.
  4. A dropped data channel: `city.sync { since: lastSeq }` and apply the tail (or the snapshot).
* `city.task.create` answers the task as it was created (a copy); later changes come as events.
* `city.presence { left: true }` sends `city.presence.left`. Up to 15 a second per person.
* Demo timing with the default delays: Rita joins at about 2 s, the borrow at 4 s, the city task
  starts when the bakery job ends (about 25 s) and is done about 7 s later.
