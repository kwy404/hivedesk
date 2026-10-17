<p align="center">
  <img src="assets/banner.svg" width="900" alt="hivedesk: a whole crew of AI workers, running on your own machine. A honeycomb desktop with a timeline, a crew chat, a code window and a live preview, with Mel the bee foreman.">
</p>

<p align="center"><b>Your own AI crew. One command away.</b></p>

<p align="center">
  <a href="https://kwy404.github.io/hivedesk/">Website</a> &middot;
  <a href="#install">Install</a> &middot;
  <a href="#honest-about-the-limits">Limits</a> &middot;
  <a href="https://www.npmjs.com/package/hivedesk">npm</a> &middot;
  <a href="https://github.com/kwy404/hivedesk/releases/latest">Latest release</a> &middot;
  <a href="i18n/README.pt-BR.md">Português</a>
</p>

<p align="center">
  Made by <b>Alexandre Kohler</b>
  &nbsp;<a href="https://github.com/kwy404" rel="me noopener"><img src="assets/icons/github-honey.svg" width="16" height="16" alt=""> GitHub</a>
  &nbsp;<a href="https://www.linkedin.com/in/alexandre-silva-173687256/" rel="me noopener"><img src="assets/icons/linkedin-honey.svg" width="16" height="16" alt=""> LinkedIn</a>
</p>

Run `npx hivedesk` and a short wizard sets everything up: it reads your hardware, installs the local runtime, downloads the right model with a progress bar and opens the Hive in your browser. The Hive is a desktop where a crew of AI workers plans, talks and builds real files in a folder on your computer, with a model that runs on your own machine. No account, no API key.

<p align="center">
  <img src="docs/assets/shots/hive.webp" width="900" alt="The Hive in demo mode: the timeline of a bakery landing page job, the crew chat, a live preview of the page, the Files window with a diff and the Dev worker after a turn, with the worker dock at the bottom.">
</p>

## Install

```bash
npx hivedesk
```

The wizard asks for the language, the project folder, which brain to use, how the crew should work and who is on it. Every question has a recommended default, so pressing Enter all the way works. Run it again and it offers to reuse the same setup; `--yes` skips the questions.

Prefer a double click? The [website](https://kwy404.github.io/hivedesk/#download) has one-click launchers for Windows (`hivedesk-windows.cmd`), macOS (`hivedesk-macos.command`) and Linux (`hivedesk-linux.sh`). Each one checks for Node.js 18 or newer and runs `npx hivedesk@latest`; if Node.js is missing, it opens the official download page and says why. They are not code signed, so Windows SmartScreen and macOS Gatekeeper ask before the first run.

### What the first run does

1. Starts a server on `127.0.0.1` with a secret token in the URL and opens your browser, which shows a progress bar while the rest runs.
2. Uses Ollama or LM Studio if one of them is already running with a model, and skips the download.
3. Detects the hardware: OS, CPU cores, RAM, free disk and the GPU with its VRAM.
4. Installs the local runtime `node-llama-cpp` into `~/.hivedesk/runtime/`, once. It is not a dependency of the package, so `npx hivedesk` itself stays small.
5. Picks a model and downloads it into `~/.hivedesk/models/`, showing its name, size and source. A cut download resumes, and the file is checked against its published SHA-256.
6. Loads the model, GPU first. If less than half of the layers fit, or free RAM is short, it does not load half a model and freeze your machine: it falls back and says why.

| Your hardware | Model (Qwen2.5-Coder Instruct, Q4_K_M) | Download | Runs on |
| --- | --- | --- | --- |
| GPU with 10 GB of VRAM or more | 14B | 9.0 GB | GPU |
| GPU with 7 to 10 GB of VRAM | 7B | 4.7 GB | GPU |
| GPU with 4 to 7 GB of VRAM (for example a GTX 1060 6 GB) | 3B | 2.1 GB | GPU, every layer |
| No usable GPU, 16 GB of RAM or more | 3B | 2.1 GB | CPU |
| No usable GPU, 8 to 16 GB of RAM | 1.5B | 1.1 GB | CPU |
| Under 8 GB of RAM | 0.5B | 0.5 GB | CPU, with a warning that results will be basic |

The choice and the reason are shown in one line, for example "NVIDIA GeForce GTX 1060 6GB (6.4 GB VRAM) found: using Qwen2.5-Coder 3B (2.1 GB), fully on the GPU." Change it in Settings or with `--model 14b|7b|3b|1.5b|0.5b|<path>`. The exact behavior, including what happens when the disk is short, the network drops or the GPU fails, is in [FIRST-RUN.md](FIRST-RUN.md).

**How long the first run takes.** Mostly the model download, plus a few hundred MB for the runtime. At 100 Mbit/s the 3B model takes about 3 minutes and the 7B about 6. After that a run is ready in the time it takes to load the model.

### Requirements

- Node.js 18 or newer, on Windows, macOS or Linux.
- Disk: 0.5 to 9.0 GB for the model, plus up to about 0.7 GB for the runtime.
- Free RAM to load it: 2.5 GB when the model goes to the GPU; on the CPU, the model size plus 1.5 GB (at least 4 GB).
- A GPU is optional: NVIDIA, Apple Silicon and others through the runtime.
- A network connection on the first run.

### Options

| Flag | What it does |
| --- | --- |
| `--yes` | Skip the setup questions (the saved setup, or the recommended defaults). |
| `--demo` | No model at all: a scripted job replays so you can look around. Every event is labeled as a demo. |
| `--model <name or path>` | `14b`, `7b`, `3b`, `1.5b`, `0.5b` or a GGUF file, instead of the automatic choice. |
| `--brain ollama`, `--brain lmstudio`, `--brain openai` | Use that brain. `openai` takes `--url`, `--model` and the key in `HIVEDESK_API_KEY`. |
| `--no-download` | Never download a model; the Hive offers the download instead. |
| `--cpu`, `--ctx <n>` | Do not use the GPU; set the context size. |
| `--dir <folder>` | The project folder. Files go to `<folder>/.hivedesk/`. |
| `--port <n>`, `--no-open` | Pick the port; do not open the browser. |
| `--lend`, `--join <link or words>` | Lend your model to a friend, or join one (see below). |
| `--doctor` | Check Node, the GPU, RAM, disk and the models, then exit. |

`HIVEDESK_HOME` moves the cache folder `~/.hivedesk/`.

## Honest about the limits

A small model on your own machine is private and free to run. It is also slower and less capable than the biggest models in a data center. Please read this before you start.

- **It needs a model.** Without one, nothing is generated. The first run downloads one, 0.5 to 9.0 GB, unless Ollama or LM Studio is already running or you add a key.
- **It is slower than it looks in videos.** Workers take turns on one model, so a job takes minutes, not seconds. On the CPU only, the model writes a few tokens per second.
- **It works best with you steering.** Ask for one thing at a time, read the diffs and approve the steps. Large apps in one go are out of reach for a small model.

<p align="center">
  <img src="assets/illustrations/hardware.svg" width="900" alt="Three hardware tiers shown as honey jars: no GPU runs a small model slowly, a mid range GPU runs a bigger model for small and medium tasks, a bigger GPU or a key handles bigger jobs.">
</p>

| Hardware | Model it runs | Speed | Good for |
| --- | --- | --- | --- |
| No GPU | Qwen2.5-Coder 0.5B or 1.5B, or 3B with 16 GB of RAM | Slow, a few tokens per second | Small, single file tasks. Expect to wait. |
| GPU with 4 to 7 GB | Qwen2.5-Coder 3B, fully on the GPU | Usable | Small tasks, components, scripts, copy. |
| GPU with 7 to 10 GB | Qwen2.5-Coder 7B | Good | Small and medium tasks, with you steering. |
| 10 GB or more, or a key | Qwen2.5-Coder 14B, or a bigger model through Ollama, LM Studio or a cloud provider with your own key | Faster | Bigger jobs and longer plans. |

**Great at:** landing pages, small CRUD apps, scripts, UI components, tests, docs and copy, fixing a bug you describe.

**Not great at:** large or complex apps in one go, long jobs without you reading and approving the steps, speed on a machine without a GPU, and anything at all without a model.

**Privacy:** your files stay on your machine. The network is used for the first run download, and then only for what you turn on: Lend mode and Code together (with a friend you paired with), GitHub, cloud providers with your own key, extensions from a URL, and the browser's speech recognition in voice mode, which may send audio to the browser maker's service. A fully local speech recognizer is not shipped yet. Lend mode sends only model prompts and answers: one request at a time, at most 20 per minute, prompts up to 120,000 characters, and the friend can stop at any time. There is no TURN relay built in, so two very strict networks may not connect.

## How it works

<p align="center">
  <img src="assets/illustrations/crew.svg" width="900" alt="You ask for a bakery landing page. Mel the foreman plans it: the Writer writes the copy, the Designer does layout and styles, Dev builds the page and QA runs the checks and sends a fix back. Below, one local model with a queue of workers taking turns.">
</p>

1. **Ask.** Type what you want, or hold <kbd>Ctrl</kbd> <kbd>Space</kbd> and say it.
2. **Refine.** Mel turns the request into a brief: the goal, what to build, the constraints, the checks and any open question. The job waits until you use the brief, edit it or keep your own words. You can turn it off in Settings.
3. **Plan.** Mel splits the brief into a task graph and assigns it. Jobs that went well become playbooks Mel reuses.
4. **Build.** Workers take turns on one model and write real files in your workspace. Every write is a diff; commands, deletes and changes to files you already had wait for your approval.
5. **Check.** QA runs the checks and sends what fails back as fix tasks.
6. **Ship.** At the end, a report suggests an improved prompt for next time. Connect GitHub and the crew can make a branch per job, commit, push and open a pull request with its CI status; each action is shown as a plan and runs only when you confirm it.

The default crew is **Mel** (foreman and planner), **Dev**, **Designer**, **QA** and **Writer**. Hire your own with a role, an avatar color and a list of allowed tools. Tools only reach the workspace folder; commands run with a timeout, an output cap and no network by default.

## Inside the Hive

- **Office mode.** Toggle it in the top bar and the desktop becomes a small honeycomb office drawn from real engine events. Drag a sticky note from Mel's board onto a bee to hand it a task.
- **Code together.** Invite a friend into the Code window: you edit the same files and see each other's cursors. Their saves go through approval mode, as a diff.
- **Voice.** Push to talk with <kbd>Ctrl</kbd> <kbd>Space</kbd>; Mel answers out loud in the UI language.
- **Themes.** Eight built in, a visual editor with a contrast report, import and export, or ask the crew to design one.
- **Extensions.** Install from a folder, a zip or a URL. Each one asks for its permissions and runs in a sandbox.
- **10 languages.** English, Português, Español, Français, Deutsch, Italiano, 日本語, 한국어, 简体中文 and Русский. The Hive follows your browser and switches live.
- **A guided tour** with Mel on the first open; replay it from Help or the command palette.
- **Replay** any moment from the append-only event log, a <kbd>Ctrl</kbd> <kbd>K</kbd> command palette, windows that snap, and a phone layout with stacked cards.

## Lend your PC

<p align="center">
  <img src="assets/illustrations/lend.svg" width="900" alt="Your PC runs the Hive and keeps the files. A friend's PC runs npx hivedesk --lend and shows six words, a request log and a Stop lending button. Between them an encrypted peer link carries only model prompts and replies.">
</p>

1. The friend runs `npx hivedesk --lend` and gets six words, a QR code and a share link.
2. You enter the words in **Use a friend's PC**, open the link, or start with `npx hivedesk --join "<link>"`. The two browsers pair over WebRTC and show the same confirmation words.
3. Your crew sends model turns to the friend's machine. The friend sees every request and can stop lending at any time.

The words work once and expire after 10 minutes. Pairing goes through public MQTT relays that only see a random topic and ciphertext.

## FAQ

**Do I need an account or an API key?** No. Keys are optional, only to add a cloud provider or an OpenAI compatible endpoint; they stay in a key store on your machine.

**Can I look around without downloading a model?** Yes: `npx hivedesk --demo` replays a scripted job, labeled as a demo.

**Can I use a model I already have?** Yes: Ollama or LM Studio are picked up when they run, or pass `--model` with a GGUF file.

**Why does a job take minutes?** All workers share one model and take turns. The queue is on screen.

**How do I remove it?** Delete `~/.hivedesk/` and the `.hivedesk/` folder in your project; if you installed it with npm, run `npm rm -g hivedesk`.

## Docs

- [FIRST-RUN.md](FIRST-RUN.md): what the first run does, step by step, and what happens when something fails.
- [PROTOCOL.md](PROTOCOL.md): the contract between the engine, the UI and the plug-ins.
- [CHANGELOG.md](CHANGELOG.md), [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## More from kwy404

[Monsoon](https://kwy404.github.io/monsoon/) (the CSS of the site), [Voodoo.js](https://kwy404.github.io/Voodoo.js/) (the interactive parts), [kastor](https://kwy404.github.io/kastor/), [fontsketch](https://kwy404.github.io/fontsketch/), [filefinch](https://kwy404.github.io/filefinch/), [howlden](https://kwy404.github.io/howlden/), [installkite](https://kwy404.github.io/installkite/), [a11ymedic](https://kwy404.github.io/a11ymedic/) and [cookieowl](https://kwy404.github.io/cookieowl/).

## License

[MIT](LICENSE). Made by Alexandre Kohler (<a href="https://github.com/kwy404" rel="me noopener">GitHub</a>, <a href="https://www.linkedin.com/in/alexandre-silva-173687256/" rel="me noopener">LinkedIn</a>).
