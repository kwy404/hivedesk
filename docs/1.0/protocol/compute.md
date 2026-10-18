# Compute plane protocol (Stream 3)

Code: `src/compute/`. Contracts: `docs/1.0/PLAN.md` sections 2, 4 to 8 and 10. This file lists what the code does and the few additions to the frozen shapes.

## Additions to the frozen shapes

* `ShareSettings` gets two blocks, both off by default. The frozen top level fields stay and mirror the GPU block, so older readers keep working.
  * `gpu: { enabled, maxVramBytes, maxConcurrentJobs, maxJobSeconds, remoteInference, modelDownload }`
  * `cpu: { enabled, maxThreads, maxRamBytes }`. A CPU peer job runs one at a time, within `maxJobSeconds`, with the runtime's thread cap set to `maxThreads` while it runs.
  * `enabled` is derived: `gpu.enabled || cpu.enabled`. `remoteInference` lets peer jobs use the GPU; CPU sharing on its own allows CPU peer jobs.
* `RejectCode` gets `"ram"`: a CPU job over the owner's RAM limit or over free RAM minus a 2 GB reserve.
* `Resource` (and `resource.advert`) gets `cpu.threads`, `cpu.avx2`, `gpus[].vramUsedBytes`, `gpus[].integrated`, `serving: { model, device, gpuIndex, vramBytes, bytes } | null` (the model the worker serves and where), and `insideHours`. `gpus[].source` may also be `"dxgi"` or `"cim"` (names and sizes only, live numbers unknown).

## The link the compute plane needs from p2p

`src/compute/worker.js` documents `ComputeLink`. Stream 2's adapter provides:

| Member | Meaning |
| --- | --- |
| `selfId` | this engine's peerId |
| `send(peerId, type, body)` | `true` when handed to an open session. Stream 2 picks the stream from the type: `job.offer`, `job.accept`, `job.reject`, `job.heartbeat`, `job.token`, `job.result`, `job.error` on stream 2; `job.cancel`, `job.revoke`, `resource.advert` on stream 1 |
| `onMessage(fn)` | decrypted, size capped compute messages `(peerId, type, body)`; the peerId is the verified session peer |
| `hasGrant(peerId, cap)` | a valid, unexpired grant this engine issued to `peerId` (worker side) |
| `holdsGrant(peerId, cap)` | a valid grant `peerId` issued to this engine, as announced (requester side) |
| `peers()` | `[{ peerId, name, online, blocked, rttMs }]` |
| `onPeer(fn)` | `{ type: 'online' \| 'offline' \| 'resumed' \| 'grant.revoked' \| 'grant.expired' \| 'blocked', peerId, capability? }` |
| `audit(entry)` | optional: append to the hash chained audit log |

Tests use an in process stand in, `test/compute/inproc.js`, until the merge swaps in the real sessions.

## Worker rules (before anything runs)

In order, each with its reject code: payload shape and job type (`bad_input`, a type other than `inference` is also audited), grant (`not_granted`), 30 offers a minute per peer (`rate_limited`), listed peers (`not_granted`), sharing on (`sharing_off`), hours (`outside_hours`), input rules of PLAN section 5 (`bad_input`; `maxTokens` above the owner's limit is lowered, not refused), a loaded model (`model_missing`), the device is shared (`sharing_off`), allowlist (`model_not_allowed`, `model_missing`), concurrency (`busy`), VRAM or RAM from the live probe (`vram`, `ram`). Free VRAM that is not measured and no VRAM limit set is refused: the owner has to set `--max-vram`.

The worker runs a turn only on a local runtime, another local runtime, or a compatible server on 127.0.0.1. Never a cloud key, never another peer. The turn sits in the crew scheduler's peer lane: owner turns always go first and a running owner turn is never preempted.

## Timers

| What | Value | Who |
| --- | --- | --- |
| lease | 15 s, renewed by each delivered heartbeat | worker renews, requester expires it |
| heartbeat | every 5 s with the VRAM the lease holds | worker |
| no token | 30 s, then `timeout` and `job.cancel` | requester |
| hard deadline | `min(job maxSeconds, share.maxJobSeconds)` from the lease | worker aborts, requester adds 5 s slack |
| resume grace | 15 s after a session closes, lease and token timers paused | both |
| offer answer | 10 s, then `disconnected` | requester |
| choice | 60 s for Retry locally, Retry another peer, Use partial or Cancel, then the failure stands | requester |
| no candidate | waits 30 s for a resource change, then `no_candidate` with the reasons | requester |

## Events

Logged: `job.created`, `job.scheduled { jobId, decision }`, `job.state { jobId, state, error?, choices?, choiceDeadline? }`, `job.ended` (final record, no text), worker side `job.leased`, `job.running`, `job.refused`, `job.served`; `share.changed`; `resources.changed` (free VRAM or RAM moved by 10 percent, at most every 10 s).

Live (never logged): `resources.sample` (this machine, every 2 s while a window is open or `compute.resources` was asked in the last 30 s, 15 s otherwise), `resources.peer` (a peer's advert, `reportedBy` its name), `job.token { jobId, n }` (a count, no text).

## Commands (local user only)

`compute.share.get`, `compute.share.set { change }`, `compute.resources`, `compute.decide { model?, promptChars?, maxTokens?, priority? }`, `compute.jobs`, `compute.job.choose { jobId, choice }`, `compute.job.cancel { jobId }`, `compute.job.stop { jobId } | { all: true }` (the owner's Stop: revoke). `GET /api/compute/resources`.

## Files

`~/.hivedesk/settings.json` section `share`, `~/.hivedesk/jobs/<yyyy-mm>.jsonl` final job records (counts, models, outcomes, reasons; no prompt or answer text).

## Not done yet (marked, never faked)

* Downloading a model for a peer (`modelDownload`): the worker answers `model_missing` with "not available in this build" instead of downloading.
* A worker serves only the model that is loaded; it never swaps the owner's model for a peer.
* `format: "json"` without a schema runs as text on the worker; the requester validates and retries once.
* Ollama and LM Studio pick their own device; the worker counts them as the discrete GPU when there is one, else the CPU, and cannot cap their threads (CPU jobs on them are refused when a thread count is known and over the limit).
* Wiring into the engine and the `share` subcommand are Stream 1's (NOTES-s1-core.md); the real link is Stream 2's (NOTES-s2-p2p.md).

## Tasks

A job started by a crew turn carries the crew task, worker and crew job (`options.turn` from `src/crew/scheduler.js`, `job.created.crewJobId`). `src/compute/task-bridge.js` moves the 1.0 task of that crew job: `waiting { kind: 'resource' }` while no machine can run it, `waiting { kind: 'peer' }` while a person chooses after a failure, `tasks.jobFailed` when no choice was made, and back to work when the job goes on. `job.state` carries `waiting` and `usedPartial` for it.
