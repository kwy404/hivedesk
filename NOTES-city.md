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
