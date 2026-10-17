# What `npx hivedesk` does on the first run

This is the exact behavior of the engine. The README and the site quote it.

## 1. The setup wizard (terminal)

`npx hivedesk` in a terminal starts a short wizard. Every question has a recommended default, so pressing Enter all the way works. Arrows move, Space ticks, Enter confirms, Ctrl+C quits.

1. **Welcome:** Mel's header and one line on what hivedesk does.
2. **Language:** Português or English, preselected from the OS locale. This is the language of the wizard; the desktop has its own language menu.
3. **Project folder:** this folder, or type a path. Files go to `<folder>/.hivedesk/`.
4. **Brain:** first the detected hardware (GPU and VRAM, RAM, free disk), then the options:
   * the recommended local model from the table below, with its size and the reason (tagged "recommended");
   * the other local sizes;
   * Ollama or LM Studio, when one is running on this machine (then it is the recommended choice);
   * a cloud provider with your own API key: Anthropic, OpenAI, xAI, Google Gemini, or any OpenAI compatible endpoint (OpenRouter, Groq, Mistral, a local server). The key is typed hidden, saved only in `~/.hivedesk/keys.json`, and a tiny test call says OK or shows the error;
   * demo mode, with no model (a scripted crew to look around).
5. **Download:** for a local model that is not downloaded yet, the size, the source (Hugging Face, Qwen) and the destination, then "Download it now?" (Enter is yes). Saying no goes back to step 4.
6. **Working mode:** approve each risky step (recommended) or automatic.
7. **Crew:** the default crew (Mel, Dev, Designer, QA, Writer) or pick the roles with a checkbox list.
8. **Summary**, then "Open hivedesk now?" and "Open as an app (its own window)?" (both default to yes).

The answers are saved in `~/.hivedesk/config.json` (never the API key). On later runs the wizard asks only "Use the same setup as last time?"; answering no runs the full wizard with the old answers as defaults.

When the wizard does not run:

| Case | What happens |
| --- | --- |
| `--yes` | no questions: the saved setup, or the recommended defaults below |
| no terminal (a script, CI) | the same as `--yes` |
| `--demo`, `--model`, `--brain`, `--lend`, `--join` | those flags decide, no wizard |

## 2. The model, chosen by the hardware

Free disk and free RAM are checked first. All models are Qwen2.5-Coder Instruct, Q4_K_M, from the official Qwen repositories on Hugging Face:

| Hardware | Model | Download | Runs on |
| --- | --- | --- | --- |
| GPU with 10 GB of VRAM or more | 14B | 9.0 GB | GPU |
| GPU with 7 to 10 GB of VRAM | 7B | 4.7 GB | GPU |
| GPU with 4 to 7 GB of VRAM (for example a GTX 1060 6 GB) | 3B | 2.1 GB | GPU, every layer, so it is fast and leaves VRAM for the context |
| No usable GPU, 16 GB of RAM or more | 3B | 2.1 GB | CPU |
| No usable GPU, 8 to 16 GB of RAM | 1.5B | 1.1 GB | CPU |
| Under 8 GB of RAM | 0.5B | 0.5 GB | CPU, with a warning that results will be basic and a suggestion to use Ollama, LM Studio or a key |

The decision and the reason are shown in one line in the terminal and in the UI, for example:
"NVIDIA GeForce GTX 1060 6GB (6.4 GB VRAM) found: using Qwen2.5-Coder 3B (2.1 GB), fully on the GPU."
Change it later in Settings (a list with sizes and a "recommended" tag) or with `--model 14b|7b|3b|1.5b|0.5b|<path to a GGUF file>`.

If Ollama or LM Studio is running (and the wizard did not choose something else), hivedesk uses it and downloads nothing. With Ollama it prefers a `qwen2.5-coder` model.

## 3. Runtime, download and loading

1. **The local runtime** `node-llama-cpp` is installed into `~/.hivedesk/runtime/` the first time (it is not a dependency of the package, so `npx hivedesk` itself stays small). It uses prebuilt binaries (CUDA, Vulkan, Metal or CPU). If the user's npm cache is locked or broken, the install is retried once with a private cache.
2. **The download** goes to `~/.hivedesk/models/` with a progress bar (speed and time left) in the terminal and in the UI. A cut download resumes where it stopped. The file is checked against its published SHA-256 before use.
3. **Loading, GPU first:**
   * as many layers as fit go to the GPU next to the context; the log and the model status say how many, for example "vulkan, 37 of 37 layers on the GPU". If less than half of the layers fit, it does not run the model half on the CPU: it steps down to the next smaller model on the GPU (see below);
   * on the GPU the weights are read once and uploaded, so almost nothing stays in RAM (measured with the 3B on a GTX 1060: 0.45 GB resident, against 2.4 GB when the file is memory mapped); on the CPU they are memory mapped, not copied;
   * free RAM is checked before loading: 2.5 GB when the model goes to the GPU, the model size plus 1.5 GB (at least 4 GB) on the CPU. With less, it does not load, so the machine does not freeze; it says how much is free and what to do;
   * context size: 4096 tokens, or 8192 on a GPU with 8 GB of VRAM or more (`--ctx` overrides it).
4. **The window:** the server listens on `127.0.0.1` (port 4174 when free, otherwise any free port) with a secret token, and hivedesk opens in its own app window when a Chromium based browser is installed (Edge, Chrome, Brave or Chromium, started with `--app` and a separate profile in `~/.hivedesk/browser-profile`); otherwise in the default browser. `--browser` forces the normal browser, `--no-open` opens nothing. The desktop can also be installed from the browser ("Install hivedesk"): the installed app opens the local server, and shows a "start hivedesk" page when it is not running. The token is kept in `~/.hivedesk/token` so the installed app keeps working; `--new-token` makes a new one.

## 4. Second run

The runtime and the model are cached in `~/.hivedesk/`, so a second run asks one question (or none with `--yes`) and is ready in the time it takes to load the model: 11 to 50 seconds for the 3B on a GTX 1060 6 GB in our runs.

## 5. Every job

1. **The prompt refiner.** Mel first rewrites the request as a brief: the goal, what to build (files and features), the constraints, acceptance criteria as a checklist, and open questions with the defaults it will use. A short, vague request ("crie um app") is expanded into a concrete small project with up to 3 multiple choice questions (type of app, style, where the data is saved), each with a default. The job waits: the UI shows your request next to the brief with **Edit**, **Use this** and **Use mine**. Settings can turn the refiner off.
2. **Memory.** A few relevant memories (decisions, preferences, past sessions) are put into the prompts; the UI shows which. Memory is stored only on this computer (`.hivedesk/memory.json`, `~/.hivedesk/memory.json`, `.hivedesk/sessions/`) and can be viewed, edited, pinned, deleted, forgotten or turned off in the Memory window. It reaches a cloud provider only when that provider is the brain serving the job.
3. **The crew works** from the approved brief: one task per worker at a time, read before edit, small patches, checks after every change, QA against the acceptance criteria with findings by severity, at most 3 fix rounds, then an honest report. The crew writes its prompts and replies in English.
4. **The report** lists what was built, the files changed, the checks and their results, and what is still missing, plus an **improved prompt** that would rebuild or extend the result next time and 2 or 3 suggested next prompts. Both can be copied with one click and saved as a playbook.

## 6. Hive City (0.2.0, not released yet)

On start the engine also opens the city (CITY-PROTOCOL.md). Nothing is downloaded and no model turn is spent for it.

1. **This machine** gets a stable id and a building: `~/.hivedesk/city/machine.json` holds the id (`m_` and 8 hex characters) and the name, "My PC" until you rename it. The building shows the GPU, the model and the load.
2. **The crew become agents.** Each worker gets a file in `~/.hivedesk/city/agents/` with its level, XP, stats and private memory. An agent saved by another project on the same machine comes back with its level and memory. Only pinned entries and facts, preferences and decisions go into its prompts; the "finished a task" entries do not.
3. **The rooms** (Lobby, Design, Code, Review, Test, Ops, Library) are added with their rules. A task put in a room is claimed by an idle agent who works there; a Lobby task goes to Mel, who plans it into crew tasks. A job typed in the top bar runs as before, and its planned tasks also appear on the board and go through Review (the checks of the changed files) and Test (the crew QA report).
4. **After a restart** the tasks that were in progress open again in their room and are claimed again, borrows are ended, and friends' buildings stay dark until they join again. `.hivedesk/city/snapshot.json` is a cache for friends who join late; deleting it is fine.
5. **With a friend** (Code together): the friend's browser sends its machine and agents to your engine through your browser, which signs every city command with the guest's name. Guests never get a shell: their tasks run with approval mode on and without the `run` and `delete_file` tools, Ops is closed to them, and they can change only their own machine, agents and tasks.

`--demo` also plays a city scenario: during the bakery job Rita joins with the six words and Dev borrows her GPU for three turns; after it, a task goes Design, Code, Review (by Rita's agent Pip), Test, done. No model runs and every event is labeled demo.

## Opting out

| Flag | Effect |
| --- | --- |
| `--yes` | no questions (saved setup or defaults) |
| `--no-download` | never downloads; if no model is found the UI says "no model yet: choose one" and offers the download |
| `--model <name or path>` | `14b`, `7b`, `3b`, `1.5b`, `0.5b`, or a GGUF file |
| `--brain ollama` / `--brain lmstudio` | use that server and nothing else |
| `--brain anthropic\|openai\|xai\|gemini\|compatible` | a cloud provider with the key saved in Settings, Providers (or `HIVEDESK_API_KEY`) |
| `--demo` | no model at all: a scripted job replays; every event is labeled as a demo |
| `--doctor` | prints the checks (Node, GPU, RAM, disk, models found) and exits |
| `--no-open`, `--browser` | open nothing, or the normal browser instead of an app window |
| `--no-city` | no Hive City: no agents, rooms, task bus or city files |

`HIVEDESK_HOME` moves the cache folder.

## When something goes wrong

Every failure prints a plain message and a suggestion, in the terminal and in the UI. The server keeps running so you can fix it from Settings.

| Problem | What hivedesk does | Suggestion shown |
| --- | --- | --- |
| Not enough free disk for the chosen model | tries the next smaller model that fits; if none fits, stops before downloading | free some space, or use `--model` with a file you already have, or run Ollama or LM Studio |
| No network (runtime install or model download) | stops that step, keeps any partial download for later | check the connection and press Retry, or use `--model <file.gguf>`, or `--demo` to look around |
| The model does not fit in the GPU memory (less than half of the layers, or not the context) | loads the next smaller model on the GPU instead (downloading it first if needed), and says so | close other GPU apps, or keep the smaller model |
| The GPU backend fails to initialize | loads the 1.5B model on the CPU instead (downloading it first if needed), and says so | update the GPU driver, or keep the CPU mode (slower) |
| Not enough free RAM to load the model | does not load it | close some apps and press Retry, or use a smaller model, or Ollama or LM Studio |
| The runtime install fails | retries once with a private npm cache, then stops and keeps the server up | run `hivedesk --doctor`, or use Ollama or LM Studio with `--brain` |
| The model file is corrupt (checksum mismatch) | deletes it and downloads it again once | none unless it fails twice |
| A cloud key is refused, rate limited or times out | a clear error (HTTP 401, 429 after waiting for `retry-after`, or the timeout); the key never appears in logs or events | check the key in Settings, Providers |

## Honest limits

* Without a model nothing is generated. The first run needs a download of 0.5 to 9.0 GB unless a model server is already running or you use a cloud key.
* Measured on a GTX 1060 6 GB with the 3B fully on the GPU: 17 to 39 tokens per second while writing, a tiny static page in about 2 to 2.5 minutes after loading. On the CPU only, expect a few tokens per second.
* Hive City Test runs the static checks, not your test suite, and a friend's agent works only while that friend lends a model.
* Workers take turns on one model, so a job takes minutes, not seconds, and small models still make mistakes: read the report, it says what is missing.
