# hivedesk protocol (version 1)

This file is the contract between the engine (`src/`), the desktop UI (`ui/`) and P2P lending (`src/lend/`, `ui/lend/`).
It only grows: fields and types may be added, nothing is renamed or removed while `protocol` is `1`.
Clients must ignore fields and event types they do not know.

## 1. Transport and auth

* The server binds `127.0.0.1` only, on `--port` or a random free port.
* Every run creates a random secret token (32 hex chars). The browser is opened at `http://127.0.0.1:<port>/?t=<token>`.
* Every HTTP request and the WebSocket upgrade must carry the token in one of:
  * query `?t=<token>`
  * header `Authorization: Bearer <token>`
  * cookie `hivedesk_token=<token>` (the server sets it, `HttpOnly; SameSite=Strict; Path=/`, on the first request that had a valid `?t=`, so the UI assets, `/api/*` calls and the preview iframe work without repeating it)
* A request without a valid token gets `401 {"error":{"code":"unauthorized","message":"..."}}`.
* The WebSocket also rejects an `Origin` header that is not `http://127.0.0.1:<port>` or `http://localhost:<port>`. A missing `Origin` (non browser client, tests) is allowed when the token is valid.
* WebSocket endpoint: `GET /ws?t=<token>`. Text frames only, one JSON object per frame (UTF-8). The server sends a ping every 20 s; clients answer with the standard pong (browsers do it automatically).

## 2. Frames

Every frame is a JSON object with a `kind`.

### Server to UI

| kind | when | shape |
| --- | --- | --- |
| `hello` | right after connect | `{ "kind":"hello", "protocol":1, "version":"0.1.0", "demo":false, "lend":false, "lastSeq":42, "state":State }` |
| `event` | every logged event, in order | `{ "kind":"event", "event":Event }` |
| `live` | ephemeral updates, never logged | `{ "kind":"live", "type":"...", "data":{...} }` |
| `reply` | answer to a command | `{ "kind":"reply", "id":"c7", "ok":true, "result":{...} }` or `{ "kind":"reply", "id":"c7", "ok":false, "error":{ "code":"bad_request", "message":"..." } }` |
| `brain.request` | the scheduler wants a model turn from a brain attached by this client (section 6) | `{ "kind":"brain.request", "brainId":"b_remote_1", "requestId":"r_12", "messages":[Message], "options":ChatOptions }` |
| `brain.cancel` | the scheduler aborts a pending request | `{ "kind":"brain.cancel", "brainId":"b_remote_1", "requestId":"r_12" }` |

After `hello`, a client that reconnects can ask for missed events with the `events.since` command.

### UI to server

```json
{ "kind": "command", "id": "c7", "type": "job.create", "data": { "request": "a tiny static landing page" } }
```

`id` is chosen by the client and echoed in the `reply`. Commands are also accepted over REST (`POST /api/command`, section 5).

## 3. Events

Events are the source of truth. They are appended to `.hivedesk/events.jsonl` (one JSON object per line) and broadcast to every client.

```json
{
  "seq": 17,
  "ts": "2026-10-16T18:20:31.512Z",
  "type": "task.status",
  "jobId": "j_3",
  "demo": true,
  "data": { "taskId": "t_3_2", "status": "running" }
}
```

* `seq`: integer, starts at 1, strictly increasing per `.hivedesk` folder (continues across restarts).
* `ts`: ISO 8601 UTC.
* `type`: dotted name, see the list below.
* `jobId`: present when the event belongs to a job.
* `demo`: present and `true` on every event produced by `--demo`. The UI must show a visible "Demo" label while `hello.demo` is true or it renders demo events.
* `data`: payload, shape depends on `type`.

### Shared shapes

```text
Worker   { id, name, role, color, avatar, prompt, tools: string[], builtin: boolean, paused?: boolean }
         avatar is a short glyph or a URL path under /assets/; color is a CSS hex color.
         builtin ids: "mel", "dev", "designer", "qa", "writer"; hired ids start with "w_".
Task     { id, jobId, title, detail, assignee, dependsOn: string[], status, attempts, kind }
         status: "pending" | "ready" | "running" | "review" | "done" | "failed" | "blocked" | "skipped"
         kind:   "build" | "qa" | "fix" | "docs"
Job      { id, request, status, approval, refine, createdAt, finishedAt?, taskIds: string[], playbookId?, summary?,
           briefProposed?: Brief, brief?: { text, source }, report?: Report & { improvedPrompt, nextPrompts } }
         status: "refining" | "awaiting_brief" | "planning" | "running" | "done" | "failed" | "cancelled"
Brief    { goal, build: string[], constraints: string[], acceptance: string[], questions: [{ question, options: string[], answer }], text }
         text is the Markdown the user sees and edits; acceptance items are "- [ ] ..." lines in it.
Report   { built, files: [{ path, op, added, removed }], checks: [{ name, ok, detail }], missing: string[], turns, seconds }
Approval { id, jobId, taskId, workerId, tool, args, summary, diff?, createdAt }
Playbook { id, title, request, prompt?, keywords: string[], tasks: [{ title, detail, assignee, dependsOn: number[] , kind }], createdAt, uses }
Message  { role: "system" | "user" | "assistant", content: string }
```

### Event types

| type | data |
| --- | --- |
| `session.started` | `{ version, protocol, dir, workspace, demo, lend, pid }` |
| `session.stopped` | `{ reason }` |
| `settings.changed` | `{ approvalMode?: boolean, brain?: BrainChoice, sound?: boolean, ... }` (only the changed keys) |
| `brain.status` | `{ state, backend, model?, detail?, hint?, ctx? }` (hint: a plain suggestion to show with an error) state: `"none"` (no model yet) \| `"needs_download"` \| `"downloading"` \| `"loading"` \| `"ready"` \| `"error"` |
| `brain.download.required` | `{ model, file, url, bytes, source }` information only: the download starts by itself right after (see FIRST-RUN.md). With `--no-download` it does not start and the UI offers a button that sends `brain.download` |
| `brain.download.started` | `{ model, file, url, bytes, source, path }` |
| `brain.download.finished` | `{ model, path, bytes, ms }` |
| `brain.download.failed` | `{ model, code, message, hint }` code: `"no_disk"` \| `"no_network"` \| `"http"` \| `"aborted"` \| `"io"` \| `"checksum"` |
| `brain.runtime` | `{ state: "installing" \| "ready" \| "failed", package: "node-llama-cpp", version?, path?, message?, hint? }` |
| `brain.fallback` | `{ from: { backend, model?, gpu? }, to: { backend, model?, gpu? }, reason }` for example a failed GPU init moving to the CPU and a smaller model |
| `brain.choice` | `{ model, id, file, bytes, source, gpu, reason, warning? }` the automatic choice from the hardware table (FIRST-RUN.md) in one line, for example "NVIDIA GeForce GTX 1060 6GB (6.4 GB VRAM) found: using Qwen2.5-Coder 3B (2.1 GB), fully on the GPU." |
| `hardware.detected` | `{ os, arch, cpus, ramBytes, freeRamBytes, gpu: { name?, vramBytes?, backend? } \| null, diskFreeBytes }` |
| `brain.attached` | `{ brainId, label, kind: "local" \| "remote", model? }` |
| `brain.detached` | `{ brainId, reason }` |
| `brain.served` | `{ requestId, promptChars, completionTokens, ms }` (lend side: a request from a friend was answered) |
| `crew.hired` | `{ worker: Worker }` (also emitted for the builtin crew at first start) |
| `crew.updated` | `{ worker: Worker }` |
| `crew.fired` | `{ workerId }` |
| `job.created` | `{ job: Job }` |
| `job.refining` | `{ workerId: "mel" }` Mel is writing the brief |
| `brief.proposed` | `{ original, brief: Brief, vague }` (`vague`: the request was short, so the brief expands it and asks up to 3 multiple choice questions) the job waits (status `awaiting_brief`) until `brief.approve` |
| `brief.approved` | `{ text, source: "refined" \| "edited" \| "original", brief?: Brief, by?: "user" \| "auto" }` the planner and the workers work from `text` |
| `job.report` | `{ report: Report, improvedPrompt, nextPrompts: string[] }` after `job.done` or `job.failed` |
| `memory.used` | `{ items: [{ id, text, kind, scope }] }` the memories put into this job's prompts |
| `memory.changed` | `{ count }` |
| `providers.changed` | `{ providers: { [id]: { label, configured, model, baseUrl?, keyHint } } }` never a key |
| `worker.note` | `{ workerId, taskId, text }` a decision the worker wrote in its scratchpad |
| `job.planning` | `{ workerId: "mel", playbookId?, playbookScore? }` |
| `job.planned` | `{ tasks: Task[], playbookId? }` |
| `job.done` | `{ summary, files: string[] }` |
| `job.failed` | `{ error }` |
| `job.cancelled` | `{ by: "user" }` |
| `task.added` | `{ task: Task }` (QA or the planner adds a fix task later) |
| `task.status` | `{ taskId, status, note? }` (`ready` means pending with every dependency done) |
| `task.updated` | `{ task: { id, ...changed fields } }` for example a new `assignee` |
| `job.resumed` | `{ by: "user" }` a finished or failed job runs again after `task.retry` |
| `queue.updated` | `{ running: [{ workerId, taskId, brainId }], waiting: [{ workerId, taskId }] }` |
| `turn.started` | `{ turnId, workerId, taskId, brainId, n, budget? }` (n: turn number inside the task; budget: `{ family, limit, used, sections, trimmed, version }` of the assembled prompt) |
| `turn.ended` | `{ turnId, workerId, taskId, brainId, promptTokens, completionTokens, ms, tps, error? }` |
| `worker.status` | `{ workerId, status, detail? }` status: `"idle"` \| `"queued"` \| `"thinking"` \| `"tool"` \| `"waiting_approval"` \| `"error"` |
| `chat.message` | `{ id, channel, from, text, taskId? }` channel: `"general"` or `"dm:<workerId>"`; from: a worker id, `"user"` or `"system"` |
| `tool.called` | `{ callId, workerId, taskId, tool, args }` |
| `tool.result` | `{ callId, ok, result?, error? }` result is truncated to 4 KB in the log |
| `file.changed` | `{ path, op: "create" \| "modify" \| "delete", diff, bytes, added, removed, content?, workerId, taskId }` path is relative to the workspace with `/` separators; `content` is included when the file is 64 KB or less (replay uses it) |
| `run.finished` | `{ callId, command, exitCode, timedOut, ms, stdout, stderr }` (each capped at 16 KB) |
| `approval.requested` | `{ approval: Approval }` |
| `approval.resolved` | `{ approvalId, approved, by: "user" \| "auto", note? }` |
| `qa.report` | `{ taskId, passed, issues: string[] }` |
| `playbook.saved` | `{ playbook: Playbook }` |
| `playbook.used` | `{ playbookId, score }` |
| `playbook.deleted` | `{ playbookId }` |
| `lend.*` | reserved for `src/lend/`; the engine logs and forwards them untouched |

### Live frames (not logged)

| type | data |
| --- | --- |
| `turn.token` | `{ turnId, workerId, text }` streamed model text |
| `brain.stats` | `{ brainId, tps, queue: number, loaded: boolean }` |
| `brain.download.progress` | `{ model, received, total, bps }` |
| `brain.runtime.progress` | `{ line }` install output of the runtime |
| `run.output` | `{ callId, stream: "stdout" \| "stderr", text }` |

## 4. Commands

| type | data | result |
| --- | --- | --- |
| `ping` | `{}` | `{ pong: true, ts }` |
| `job.create` | `{ request, approval?: boolean, refine?: boolean, playbookId?: string }` (`refine` defaults to `settings.refine`, true) | `{ jobId }` |
| `brief.approve` | `{ jobId, use: "refined" \| "edited" \| "original", text?, answers? }` (`text` with `edited`; `answers`: the picked option per question, by index) | `{}` |
| `memory.list` | `{ q? }` | `{ entries: MemoryEntry[], enabled }` |
| `memory.add` | `{ text, scope?: "project" \| "user", kind?, pinned? }` | `{ entry }` |
| `memory.update` | `{ id, text?, pinned?, kind? }` | `{ entry }` |
| `memory.delete` | `{ id }` | `{}` |
| `memory.forget` | `{ text }` removes the entry that best matches ("forget this") | `{ forgotten }` |
| `session.list` | `{}` | `{ sessions: [{ id, request, startedAt, status, summary, improvedPrompt, files }] }` |
| `session.get` | `{ id }` | `{ id, records }` (the lines of `.hivedesk/sessions/<id>.jsonl`) |
| `session.continue` | `{ id, request? }` a new job that continues that session | `{ jobId }` |
| `provider.list` | `{}` | `{ providers }` as in `providers.changed` |
| `provider.setKey` | `{ provider, key?, model?, baseUrl? }` provider: `anthropic`, `openai`, `xai`, `gemini`, `compatible` | `{ provider }` (public view) |
| `provider.removeKey` | `{ provider }` | `{ removed }` |
| `provider.test` | `{ provider, model? }` a tiny request | `{ ok, model?, ms, error?, code? }` |
| `provider.models` | `{ provider }` from the provider, or defaults | `{ models }` |
| `turn.recent` | `{}` the last 40 model turns kept in memory | `{ turns: [{ turnId, workerId, taskId, jobId, brainId, budget, chars, ts }] }` |
| `turn.prompt` | `{ turnId }` | `{ turnId, messages, response, budget, ... }` the exact prompt and answer |
| `playbook.save` | `{ jobId }` keep a job plan and its improved prompt as a playbook | `{ playbook }` |
| `job.cancel` | `{ jobId }` | `{}` |
| `chat.send` | `{ channel, text }` user message; in a running job it is added to the context of the addressed worker (or Mel for `general`) | `{ id }` |
| `approval.resolve` | `{ approvalId, approved: boolean, note? }` | `{}` |
| `crew.hire` | `{ name, role, prompt, color?, avatar?, tools?: string[] }` | `{ worker }` |
| `crew.update` | `{ workerId, ...fields }`; `paused: true` makes the scheduler skip that worker's turns (they keep their place in the queue) until `paused: false` | `{ worker }` |
| `crew.fire` | `{ workerId }` (builtin workers cannot be fired) | `{}` |
| `task.retry` | `{ taskId }` a failed, blocked, cancelled or done task goes back in line (status `ready`, or `pending` while its dependencies run); tasks blocked by it are unblocked; a job that already ended is reopened (`job.resumed`) | `{}` |
| `task.reassign` | `{ taskId, workerId }` hand a task that is not done to another worker (`task.updated`); a running task stops and starts again with the new worker; a failed one is also retried | `{}` |
| `task.cancel` | `{ taskId }` the task becomes `skipped` (a running one is stopped); tasks that depend on it become `blocked` | `{}` |
| `settings.set` | `{ approvalMode?, sound?, refine?: boolean, crew?: string[], memory?: boolean, workerBrains?: { [workerId]: provider | "default" } }` (`crew`: the builtin roles that take part; Mel and hired workers always do) | `{ settings }` |
| `brain.probe` | `{}` | `{ hardware, options: BrainOption[], recommended }` |
| `brain.select` | `BrainChoice` | `{ status }` |
| `brain.download` | `{ model? }` start (or retry) the automatic model download; needed only after `--no-download` or a failure | `{}` |
| `brain.attach` | `{ label, model?, ctx? }` this WebSocket becomes a remote brain (section 6) | `{ brainId }` |
| `brain.respond` | `{ requestId, ok, result?: ChatResult, error?: string }` | `{}` |
| `brain.token` | `{ requestId, text }` optional streaming for a pending request | none (no reply) |
| `brain.detach` | `{ brainId }` | `{}` |
| `brain.chat` | `{ messages, options }` run one turn on the local brain; only accepted when the server runs with `--lend` | `ChatResult` |
| `events.since` | `{ seq, limit? }` | `{ events: Event[], lastSeq }` |
| `replay.at` | `{ seq }` | `{ state: State }` state rebuilt from events 1..seq |
| `replay.marks` | `{}` | `{ marks: [{ seq, ts, kind: "job" \| "done" \| "failed" \| "cancelled" \| "approval", jobId, label? }], lastSeq }` jump points for the scrubber |
| `files.list` | `{}` | `{ files: [{ path, bytes }] }` |
| `files.read` | `{ path }` | `{ path, content }` |
| `playbook.list` | `{}` | `{ playbooks }` |
| `playbook.delete` | `{ playbookId }` | `{}` |
| `doctor` | `{}` | `DoctorReport` |

```text
BrainChoice  { backend: "local" | "ollama" | "lmstudio" | "openai" | "fake", model?, url?, key? }
             key is kept in memory only and never logged; settings.changed shows "key": "set".
BrainOption  { backend, label, model?, url?, available: boolean, reason?, bytes?, recommended? }
DoctorReport { ok, checks: [{ id, label, ok, detail, hint? }], hardware, models: [{ file, bytes, path }] }
```

```text
MemoryEntry { id, scope: "project" | "user", kind: "fact" | "preference" | "rejected" | "session" | "decision", text, pinned, uses, createdAt, updatedAt? }
```

Error codes in a failed `reply`: `bad_request`, `not_found`, `conflict`, `unauthorized`, `not_lending`, `busy`, `internal`, plus short snake_case codes from plug-ins (for example `rate_limited`). An unknown command answers `bad_request` with the message `unknown command: <type>`.

## 5. REST

All JSON unless noted. Same token rule as section 1.

| method and path | answer |
| --- | --- |
| `GET /` | `ui/index.html` (text/html) |
| `GET /<path>` | static file from `ui/` |
| `GET /assets/<path>` | static file from `assets/` |
| `GET /lib/reduce.js` | the engine reducer as an ES module, so the UI can rebuild state for the replay scrubber without a round trip |
| `GET /api/health` | `{ ok: true, version, protocol, demo, lend }` |
| `GET /api/state` | `State` |
| `GET /api/events?since=0&limit=500` | `{ events, lastSeq }` |
| `GET /api/replay?seq=N` | `State` at seq N |
| `GET /api/files` | `{ files: [{ path, bytes }] }` |
| `GET /api/file?path=index.html` | `{ path, content }` |
| `GET /api/playbooks` | `{ playbooks }` |
| `GET /api/doctor` | `DoctorReport` |
| `POST /api/command` | body `{ "type": "...", "data": {...} }`, answer `{ ok, result }` or `{ ok:false, error }` |
| `GET /manifest.webmanifest`, `/sw.js`, `/offline.html`, `/pwa.js` | the installable app shell; no token needed (no data in them) |
| `GET /preview/<path>` | the workspace served as a static site (`/preview/` serves `index.html`). This route does not need the token: it is read only, checks the Host header, and is served with `Content-Security-Policy: sandbox allow-scripts ...` so the page runs in an opaque origin and cannot call the API |

### State

```text
State {
  protocol, version, demo, lend, lastSeq,
  settings: { approvalMode, sound, brain: BrainChoice (no key) },
  brain:    { state, backend, model?, detail? },
  brains:   [{ brainId, label, kind, model? }],
  crew:     Worker[],
  workers:  { [workerId]: { status, detail?, taskId? } },
  jobs:     Job[],            newest last
  tasks:    { [taskId]: Task },
  queue:    { running: [...], waiting: [...] },
  approvals: Approval[],      pending only
  chat:     { [channel]: ChatMessage[] },  last 200 per channel
  files:    { [path]: { bytes, content?, lastSeq } },
  runs:     run.finished data[], last 50
  playbooks: Playbook[],
  usage:    { [brainId]: { prompt, completion, turns } },  tokens per brain this session
  providers: { [id]: { label, configured, model } },     never keys
  notes:    { [workerId]: [{ text, taskId, ts }] },        worker scratchpads
  choice:   brain.choice data, memoryCount: number,
  tokens:   { prompt, completion }
}
```

## 6. Brains and remote brains

How the engine picks and installs a brain on start (no questions asked) is described in FIRST-RUN.md.

### The Brain interface (JS, `src/brain/types.js`)

```js
/**
 * @typedef {Object} ChatOptions
 * @property {object}  [schema]      JSON schema the answer must match (grammar constrained when the backend supports it)
 * @property {Array<{name:string, description:string, parameters:object}>} [tools]  informational; the schema is the authority
 * @property {number}  [maxTokens]
 * @property {number}  [temperature]
 * @property {AbortSignal} [signal]   not sent over the wire
 * @property {(text:string)=>void} [onToken]  not sent over the wire
 *
 * @typedef {Object} ChatResult
 * @property {string} text            raw model text
 * @property {any}    [json]          parsed object when a schema was given
 * @property {number} promptTokens
 * @property {number} completionTokens
 * @property {number} ms
 * @property {string} [model]
 *
 * @typedef {Object} Brain
 * @property {string} id
 * @property {string} label
 * @property {"local"|"remote"|"cloud"} kind
 * @property {Set<string>} [only]   the scheduler gives this brain only the turns of these workers
 * @property {(messages: Message[], options?: ChatOptions) => Promise<ChatResult>} chat
 * @property {() => object} [info]
 * @property {() => Promise<void>} [close]
 */
```

Rules for every brain:

* One `chat` call at a time per brain. The scheduler never calls a brain that is busy.
* When `schema` is given, the answer must be a single JSON value matching it. The local adapter enforces this with a grammar. A brain that cannot (for example a plain endpoint) returns the text and the engine parses and validates it, retrying once with the error appended.
* `chat` rejects with an `Error` on failure or abort. The scheduler marks the turn failed and may retry on another brain.

### The scheduler

`src/crew/scheduler.js` keeps a pool of brains and one fair queue of turns (round robin over workers, oldest first inside a worker). When a brain is free it takes the next turn. With only the local brain there is exactly one turn at a time; every attached remote brain adds one more slot. `queue.updated` and `turn.started.brainId` show who runs where.

```js
scheduler.addBrain(brain)            // emits brain.attached
scheduler.removeBrain(brainId)       // emits brain.detached; a running turn on it is re-queued
```

### Remote brain over the WebSocket (no engine code needed)

1. A client (the lend UI on the host) sends `brain.attach { label, model, ctx }` and gets `{ brainId }`.
2. The engine adds a relay brain to the scheduler. When it gets a turn, the engine sends `brain.request` to that same WebSocket.
3. The client carries the request to the friend (WebRTC), the friend's browser sends `brain.chat` to the friend's own hivedesk started with `--lend`, and the answer goes back the same way.
4. The client answers with `brain.respond { requestId, ok, result }` (it may stream `brain.token` before). Timeout: 180 s, then the turn is re-queued on another brain.
5. `brain.detach` or closing the WebSocket removes the brain.

Only `messages` and `options` (schema, maxTokens, temperature) travel. No file content leaves the host unless it is part of a prompt, and nothing on the friend's machine is read or written.

### Server side plug-in (optional)

At start, if `src/lend/index.js` exists, the engine calls its default export:

```js
export default function register({ scheduler, bus, server, config }) {}
```

* `bus.emit(type, data, { jobId })` appends and broadcasts an event (use `lend.*` types).
* `bus.on(listener)` receives every event.
* `server.route(method, path, handler)` adds a REST route under the same token check, `handler(req, res, url)`.
* `server.command(type, handler)` adds a command, `handler(data, client) => result`.
* `config` has `{ dir, port, token, lend, demo, version }`.

The engine does not depend on `src/lend/`; when it is missing, lending is simply off.

## 7. Files on disk

Shared cache for every project (override with the env var `HIVEDESK_HOME`):

```text
~/.hivedesk/
  runtime/         node-llama-cpp installed here on first use (not a dependency of the package)
  models/          downloaded GGUF files (partial downloads end in .part and resume)
```

Per project:


```text
<dir>/.hivedesk/
  events.jsonl     append-only event log (source of truth)
  state.json       snapshot, rewritten at most every 2 s and on exit (a cache; deleted is fine)
  playbooks/       one <id>.json per playbook
  workspace/       the files the crew builds (preview serves this)
```

## 8. Demo mode

`hivedesk --demo` uses a scripted fake brain, so the whole loop runs with no model. Every event carries `"demo": true`, `session.started.data.demo` is true, `hello.demo` is true, and Mel posts a first `chat.message` in `general`: "This is a demo. No model is running; the crew follows a script."
