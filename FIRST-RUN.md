# What `npx hivedesk` does on the first run

This is the exact behavior of the engine. The README and the site quote it.

## Zero setup, no questions

1. **Starts the server** on `127.0.0.1` (random free port, a secret token in the URL) and opens the browser. The Hive shows "model loading" with a progress bar while the steps below run. The terminal shows the same progress.
2. **Looks for a model server already running.** If Ollama (`127.0.0.1:11434`) or LM Studio (`127.0.0.1:1234`) answers and has at least one model, hivedesk uses it and skips steps 3 to 6. With Ollama it prefers a `qwen2.5-coder` model when one is installed.
3. **Detects the hardware:** OS, CPU cores, RAM, free disk and the GPU with its VRAM (NVIDIA through `nvidia-smi`, Apple Silicon through unified memory, others through the runtime itself).
4. **Installs the local runtime** `node-llama-cpp` into `~/.hivedesk/runtime/` if it is not there yet. It is not a dependency of the package, so `npx hivedesk` itself stays small. It uses prebuilt binaries for the usual platforms (CUDA, Vulkan, Metal or CPU).
5. **Picks a model** from the official Qwen repositories on Hugging Face:

   | Hardware | Model | Download |
   | --- | --- | --- |
   | GPU with 6 GB of VRAM or more | Qwen2.5-Coder 7B Instruct, Q4_K_M | 4.7 GB |
   | GPU with 3.5 GB or more, or no GPU and 16 GB of RAM or more | Qwen2.5-Coder 3B Instruct, Q4_K_M | 2.1 GB |
   | anything else | Qwen2.5-Coder 1.5B Instruct, Q4_K_M | 1.1 GB |

6. **Downloads it** into `~/.hivedesk/models/` with a progress bar in the terminal and in the UI. The model name, size and source (`huggingface.co/Qwen/...`) are shown as information; the download does not wait for an answer. A cut download resumes where it stopped. The file is checked against its published SHA-256 before use.
7. **Loads the model, GPU first**, then the crew shows "ready" and the request box is enabled.

   * As many layers as fit go to the GPU next to the context (CUDA, Vulkan or Metal); the log and the model status show how many, for example "vulkan, 37 of 37 layers on the GPU". If less than half of the layers fit, it does not run the model half on the CPU: it falls back (see below).
   * The weights are memory mapped, not copied into RAM.
   * Free RAM is checked before loading: 2.5 GB when the model goes to the GPU, the model size plus 1.5 GB (at least 4 GB) on the CPU. With less, it does not load, so the machine never freezes; it says how much is free and what to do.
   * Context size: 4096 tokens, or 8192 on a GPU with 8 GB of VRAM or more. On a 6 GB card a 7B model only fits fully on the GPU with 4096 (with 8192 some layers stay on the CPU and generation drops from about 11 to under 2 tokens per second). `--ctx` overrides it.

## Second run

The runtime and the model are cached in `~/.hivedesk/`, so a second run skips the install and the download and is ready in seconds (the time to load the model into memory).

## Opting out

| Flag | Effect |
| --- | --- |
| `--no-download` | never downloads; if no model is found the UI says "no model yet: choose one" and offers the download button |
| `--model <path or uri>` | use this GGUF file (a local path, or an `hf:` / `https:` URI that is downloaded the same way) |
| `--brain ollama` / `--brain lmstudio` | use that server and nothing else |
| `--brain openai` | any OpenAI compatible endpoint, with `--url` and the key in the env var `HIVEDESK_API_KEY` |
| `--demo` | no model at all: a scripted job replays so you can look around; every event is labeled as a demo |
| `--doctor` | prints the checks (Node, GPU, RAM, disk, models found) and exits |

`HIVEDESK_HOME` moves the cache folder.

## When something goes wrong

Every failure prints a plain message and a suggestion, in the terminal and in the UI. The server keeps running so you can fix it from the Settings window.

| Problem | What hivedesk does | Suggestion shown |
| --- | --- | --- |
| Not enough free disk for the chosen model | tries the next smaller model that fits; if none fits, stops before downloading | free some space, or use `--model` with a file you already have, or run Ollama or LM Studio |
| No network (runtime install or model download) | stops that step, keeps any partial download for later | check the connection and press Retry, or use `--model <file.gguf>`, or `--demo` to look around |
| The GPU fails to initialize, or less than half of the layers fit in VRAM | loads the 1.5B model on the CPU instead (downloading it first if needed), and says so | update the GPU driver, or close other GPU apps, or keep the CPU mode (slower) |
| Not enough free RAM to load the model | does not load it | close some apps and press Retry, or use a smaller model, or Ollama or LM Studio |
| The runtime install fails | stops, keeps the server up | run `hivedesk --doctor`, or use Ollama or LM Studio with `--brain` |
| The model file is corrupt (checksum mismatch) | deletes it and downloads it again once | none unless it fails twice |

## Honest limits

* Without a model nothing is generated. The first run needs a download of 1.1 to 4.7 GB unless a model server is already running.
* On the CPU only, the crew is slow (a few tokens per second).
* Workers take turns on one model, so a job takes minutes, not seconds.
