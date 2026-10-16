# Changelog

## 0.1.0 (2026-10-17)

First release.

* `npx hivedesk` starts a local server on 127.0.0.1 with a per run token and opens the Hive desktop.
* Zero setup first run: detects the hardware, installs the local runtime (node-llama-cpp) into `~/.hivedesk`, downloads the right Qwen2.5-Coder GGUF (1.5B, 3B or 7B, Q4_K_M) with progress, checks its SHA-256 and loads it. Uses Ollama or LM Studio instead when one is running. See FIRST-RUN.md.
* Fallbacks with plain messages: not enough disk (a smaller model), no network (retry later, `--model`, `--demo`), a failed GPU init (CPU and a smaller model).
* The crew: Mel plans, Dev, Designer, Writer and QA work, and you can hire your own workers.
* The loop: request, plan, task graph, workers taking turns on one model through a fair scheduler, tools, QA with fix rounds, done.
* Every tool call is a JSON action checked by a schema; the local model is grammar constrained, so small models always produce valid calls.
* Workspace tools: list, read, write, edit, delete, run (allow list, timeout, output cap, Node permission flags when available), static checks and preview.
* Approval mode (on by default) for commands, deletes and changes to files that existed before the job.
* Playbooks: a job that ends well is saved and reused for similar requests.
* Replay: `events.jsonl` is the source of truth; any moment can be rebuilt.
* `--doctor` checks Node, the GPU, RAM, disk, the runtime and the models present.
* `--demo` runs a scripted job with no model; every event is labeled as a demo.
* Lend your PC: a paired friend's model can take turns for your crew (see the README).
* Protocol for the UI and plug-ins in PROTOCOL.md.
