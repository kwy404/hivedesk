# Changelog

## 0.2.0 (2026-10-17)

Hive City: hivedesk becomes a small distributed system for AI agents on people's computers. The city is the new home view.

### Hive City, engine side (CITY-PROTOCOL.md)

* The city is the state of the system: buildings, rooms, agents, tasks, hops and GPU borrows are `city.*` events in the same append-only log, reduced by `src/city/state.js` (served at `/lib/city.js`) into `state.city` and `hello.state.city`.
* Persistent agents: every crew worker is an agent with a home room, a level and XP from finished work (work 10, review 4, test 3, plus 5 for a task done without a loop), stats, tools and a private memory (at most 40 entries of 300 characters, editable and pinnable). Agents are saved per machine in `~/.hivedesk/city/agents/`, so they keep their level and memory across projects; pinned entries, facts, preferences and decisions go into their prompts.
* Rooms with rules: Lobby, Design, Code, Review, Test, Ops and Library, each with its allowed tools (an agent's tools are cut to the room's while it works there), what it accepts, an optional approval gate and a host only flag (Ops). Extensions add rooms with `city.room.add`.
* The task bus: tasks are created by you (in a room or on an agent), by Mel (a Lobby task is planned into crew tasks; every planner task of a job appears on the board) or by the agents (a failed review or test sends work back). Idle agents bid by skill, level and machine load; claims, hops, verdicts, loops and approvals are events.
* The pipeline: Design writes a spec and criteria, Code runs a crew job with one task, Review reads the diff against the criteria (a model turn for city tasks; the checks of the changed files for planner tasks), Test runs the static checks (for planner tasks, the crew QA report). Failures loop back to the author with the issues, at most 3 times, then the task is blocked. You can approve or send back a task at any hop.
* Machines: your PC is a building with a stable id, its GPU, model and load. A Code together guest can bring their machine and agents (`city.machine.join`); a friend's agent thinks on its own machine's lent brain, and that brain serves only that friend's agents and accepted borrows.
* GPU borrowing: an agent asks another machine for a number of turns and minutes, the lender accepts (and may lower the limits) or refuses, every turn is counted, and either side can stop it. It rides the existing lend relay and the lender's guard; only prompts and answers travel.
* Ownership and safety: the owner of a machine, agent or task wins. Guest commands are signed by the host's browser (`roles.js`), limited to 40 per 10 seconds, and a guest's tasks run with approval mode on, without `run` and `delete_file`, and never in Ops. The full memory of an agent never goes into the log.
* Replication and persistence: late joiners get a snapshot plus the tail (`city.sync`); after a restart the same agents come back and unfinished tasks open again in their room.
* `--demo` plays a city scenario (a friend joins with six words, Dev borrows her GPU for three turns, a task goes Design, Code, Review, Test, done), every event labeled demo. `--no-city` turns the city off.
* The 0.1 APIs are unchanged; PROTOCOL.md gains `hello.city`, `state.city`, `Job.cityTaskId`, the `forbidden` error code and the `city.*` event and command families.

## 0.1.1 (2026-10-17)

* Node.js 20 or newer is required (Node 18 has reached end of life and lacks the global Web Crypto API that pairing uses). The doctor check, the launchers and the docs say so.
* The website shows the real Office mode and the desktop downloads for Windows, macOS and Linux.
* The README on npm matches the current requirements.

## 0.1.0 (2026-10-17)

First release.

### Start

* `npx hivedesk` asks a few questions in a terminal wizard (language, folder, brain, download, working mode, crew), each with a recommended default; later runs ask only "Use the same setup?". `--yes`, or no terminal, skips the questions. See FIRST-RUN.md.
* The model is chosen from the hardware (Qwen2.5-Coder 0.5B to 14B, Q4_K_M) and the reason is shown in one line. Free disk and free RAM are checked first; the runtime (node-llama-cpp) is installed into `~/.hivedesk` on first use; the download resumes and is checked against its SHA-256.
* Loading is GPU first: as many layers as fit next to the context, no memory map on the GPU (0.45 GB resident for the 3B instead of 2.4 GB), a refusal to load when free RAM is short, and the 1.5B on the CPU when the GPU cannot take the model.
* Ollama, LM Studio, and cloud providers with your own key (Anthropic, OpenAI, xAI, Google Gemini, any OpenAI compatible endpoint) work behind the same brain interface. Keys stay in `~/.hivedesk/keys.json`; the browser only sees "configured". A brain can be chosen per worker; tokens are counted per brain.
* hivedesk opens as a native desktop window (from `desktop/`), as an app style browser window, or in the browser; the desktop is installable as an app and shows a "start hivedesk" page when the server is not running.
* `--demo` runs a scripted job with no model; every event is labeled as a demo. `--doctor` checks Node, the GPU, RAM, disk and the models present.

### The crew

* Mel, Dev, Designer, QA and Writer, plus workers you hire with a role, a color and a list of tools.
* The prompt refiner: Mel turns the request into a brief (goal, files and features, constraints, acceptance criteria, open questions with defaults). Vague requests get up to 3 multiple choice questions. The job waits until you use the brief, edit it or keep your own words.
* The loop: brief, plan, task graph, workers taking turns on one model through a fair scheduler, tools, QA against the acceptance criteria with findings by severity, at most 3 fix rounds, done.
* Quality for small local models: one task per worker, read before edit, small search and replace patches, checks after every change, "done" checked against the checks, a short scratchpad of decisions, loops stopped by Mel.
* Every model call is assembled from tagged sections (role, objective, context, tools, rules, process, output) within a token budget per model family; the Prompts window shows the exact prompt, the answer and the budget of each turn.
* At the end, a report (what was built, files, checks, what is missing) and an improved prompt with 2 or 3 next prompts, copyable and savable as a playbook.
* Every tool call is a JSON action checked by a schema; the local model is grammar constrained.
* Workspace tools: list, read, write, edit, delete, run (allow list, timeout, output cap, Node permission flags when available), static checks and preview.
* Approval mode (on by default) for commands, deletes and changes to files that existed before the job. Task retry, reassign and cancel, and pausing a worker.

### Memory and history

* Local memory: project facts, decisions, preferences and session summaries, small and capped, in `.hivedesk/memory.json` and `~/.hivedesk/memory.json`, with search, pin, edit, delete, "forget this" and an off switch.
* One session file per job in `.hivedesk/sessions/`; any session can be reopened and continued.
* Playbooks: a job that ends well is saved and reused for similar requests.
* Replay: `events.jsonl` is the source of truth; any moment can be rebuilt.

### Other

* Lend your PC: a paired friend's model can take turns for your crew (see the README).
* The protocol for the UI and plug-ins is in PROTOCOL.md.
