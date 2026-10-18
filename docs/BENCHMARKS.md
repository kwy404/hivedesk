# Benchmarks

Real runs of catalog models on one PC, used to tune the recommendation (`src/brain/catalog/measured.js`).
Rerun them with `node test/catalog/bench.mjs` (results in `~/.hivedesk/bench-results.json`).

## The machine

| Part | Value |
| --- | --- |
| GPU | NVIDIA GeForce GTX 1060 6 GB (driver 560.94, CUDA 12.6 reported) |
| Backend used by the runtime | Vulkan (node-llama-cpp 3.22.1 picked its prebuilt Vulkan binary) |
| CPU | Intel Core i5-4440, 4 cores, 4 threads, AVX2, no AVX-512 |
| RAM | 16 GB DDR3-1600, two modules |
| OS | Windows 10 |

## How it was measured

* One model process at a time. Before each run the script checks `nvidia-smi` and the process list and
  waits while another model runs on the PC (it did wait, twice, for another stream's model run).
* The local brain of hivedesk (`createLocalBrain`, GPU first, the free RAM guard), the context size in the
  table, greedy decoding (temperature 0), and the process exits after the run so the VRAM is released.
* **Load:** from the start of the load to a ready context. **Tokens/s:** while writing, after the first
  token. **VRAM:** `nvidia-smi` memory used during the run minus before. **RAM:** peak resident memory of the
  process.
* **Quality probe:** one prompt, "landing page para a padaria Pao da Vila" (menu with prices, hours with
  Sunday closed, a tel link, cake orders, JSON-LD, a mobile media query, focus styles), answered as
  `index.html` and `style.css`, then checked by the 13 checks of the bakery playbook
  (`src/crew/library/entries/web-pages/bakery-site.json`). One greedy sample per model: a coarse probe,
  not a leaderboard.

## Results

| Model | Context | Runs | Load | Tokens/s | VRAM | RAM | Quality probe |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Qwen2.5-Coder 3B Q4_K_M | 4096 | GPU, 37 of 37 layers | 12.6 s | **48.0** | 2.3 GB | 0.5 GB | 10 of 13 (missed focus-visible, meta description, contrast) |
| Qwen2.5-Coder 3B Q8_0 | 4096 | GPU, 37 of 37 layers | 15.7 s | **27.9** | 3.6 GB | 0.6 GB | 12 of 13 (missed focus-visible) |
| Qwen2.5-Coder 7B Q3_K_M | 4096 | GPU, 29 of 29 layers | 18.8 s | **8.7** | 3.9 GB | 0.5 GB | 13 of 13 |
| Qwen2.5-Coder 7B Q3_K_M | 8192 | GPU, 29 of 29 layers | 19.6 s | 11.2 (300 tokens) | 4.5 GB | 0.5 GB | not run |
| Qwen2.5-Coder 7B IQ4_XS | 4096 | GPU, 29 of 29 layers | 26.2 s | **20.6** | 4.3 GB | 0.6 GB | 12 of 13 (missed meta description) |
| Qwen2.5-Coder 7B IQ4_XS | 8192 | GPU, 29 of 29 layers | 31.4 s | 24.6 (300 tokens) | 4.9 GB | 0.6 GB | not run |
| Qwen2.5-Coder 7B Q4_K_M | 4096 | 29 layers, spilled into shared memory | 72.8 s | **4.0** | 5.5 GB | 2.0 GB | 12 of 13 (missed contrast) |
| Qwen2.5-Coder 7B Q4_K_M | 8192 | GPU, 27 of 29 layers | 43.6 s | 4.9 (300 tokens) | 4.6 GB | 0.9 GB | not run |
| Qwen2.5-Coder 7B Q4_K_M | 2048 | did not run, twice: "A context size of 2048 is too large for the available VRAM" (the runtime's own fit check) | | | | | |
| Qwen2.5-Coder 3B Q4_K_M | 4096 | CPU only, 4 threads, through hivedesk | refused twice by the free RAM guard (3.2 and 3.4 GB free, 4.0 GB needed) while other work used the RAM | | | | |
| Qwen2.5-Coder 3B Q4_K_M | n/a | CPU only, 4 threads, `llama-bench` of llama.cpp b11716 | | 1.2 (prompt: 15.1) | none | 2.1 GB mapped | measured while other processes kept the CPU at 91 to 94 percent: a floor, not the real speed |
| Qwen2.5-Coder 1.5B Q4_K_M | 2048 | CPU only, 2 threads, rpc-server of llama.cpp b11716 on this PC | 76 s (weights sent over RPC) | **6.5** (prompt: 17.5) | none | about 1.2 GB | not run (the CPU was idle then) |

The 300 token rows are short speed checks with a near empty context, so they read a little faster than
the 1000 token runs.

**CPU only.** The hivedesk run of the 3B on the CPU could not happen: the free RAM guard needs 4 GB free
and other work on this PC kept 2 to 3.5 GB free for hours. The `llama-bench` run went through but with the
CPU at 91 to 94 percent from other processes, so 1.2 tokens/s is a floor. The clean CPU data point is the
1.5B through rpc-server with 2 threads on an idle CPU: 6.5 tokens/s, about 7 GB of weights read per second,
0.28 of the 25.6 GB/s the two DDR3-1600 channels allow. The CPU estimate now uses 0.35 of the bandwidth
(was 0.6), which gives about 4 tokens/s for the 3B Q4_K_M on this CPU.

## What this changed in the recommendation for 6 GB cards

1. **7B IQ4_XS is the pick for a 6 GB card**, not the 3B: it runs fully on the GPU at 20 to 25 tokens/s,
   even with an 8192 token context, and passed 12 of 13 checks against 10 of 13 for the 3B Q4_K_M.
2. **7B Q4_K_M is not offered as "fits your GPU" on 6 GB.** On paper it fits (4.7 GB of weights), but next
   to a 4096 context it spilled into shared memory and ran at 4 tokens/s. The VRAM budget for dedicated
   cards now keeps 0.75 GB for the display and the driver (estimate 5.64 GB ran, 5.71 GB spilled).
3. **Q3_K is slow on this card.** 7B Q3_K_M ran at 8.7 tokens/s, about a third of what its size predicts
   (the Vulkan Q3_K path on Pascal). The engine uses the measured numbers here, and applies the same 0.35
   factor to Q3_K files on other GTX 10 series cards (`QUANT_FACTORS`).
4. **"Faster" on a measured machine only promises measured speeds:** on this PC it offers the 3B Q8_0
   (27.9 tokens/s, 12 of 13) instead of an unmeasured 3 bit 7B.
5. The bandwidth model holds on this GPU (3B Q4_K_M: 46 estimated, 48 measured; 3B Q8_0: 27 and 27.9), so
   the GPU efficiency stays at 0.5 of the memory bandwidth for unmeasured cards.
6. **CPU estimates are lower**: 0.35 of the memory bandwidth instead of 0.6 (see CPU only above).

The recommendation engine shows "measured" next to these speeds and "estimate" everywhere else.

## Pooled model over llama.cpp RPC, one PC

`node test/pool/e2e-pool.mjs` runs a lender and a borrower engine on this PC, joined by a relay that
stands in for the two browsers: Qwen2.5-Coder 0.5B Q4_K_M, every layer on the lender's rpc-server (CPU
share, 2 threads), the tunnel carrying the RPC bytes as JSON frames.

| Step | Result |
| --- | --- |
| Load through the tunnel | 28.9 s, 12,435 frames (the weights travel once to the lender) |
| First turn (prompt included) | 16 tokens in 12.2 s |
| Cancel during a long turn | stopped at once; the next turn answered |
| Revoke on the lender | rpc-server killed; the next turn failed, as it should |

This proves the plumbing, not the speed of two real PCs: on a local network add one round trip per token
per lender, over the internet much more.
