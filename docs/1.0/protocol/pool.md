# Pooled models over p2p (experimental)

A giant model runs across friends' PCs with llama.cpp RPC: the borrower runs `llama-server` with
`--rpc` to loopback ports, each lender runs `ggml-rpc-server` on its loopback, and the RPC bytes travel
inside the encrypted p2p session (`src/p2p/pool-port.js`, `src/brain/pool/p2p.js`). Off by default.

## Gates

| Gate | Where |
| --- | --- |
| `compute.pool { maxLeaseMinutes 5..480 (60), maxLeases 1..4 (1) }` granted by the lender | checked by the node before any `pool.*` handler on the lender runs; `pool.lease.ask` without it is answered `pool.lease.no not_granted` |
| `compute.gpu { maxVramBytes }` for a GPU lease, or `compute.cpu { maxThreads }` and `compute.ram { maxBytes }` for a CPU lease | checked by the lender for each ask; the limits come from these grants, clamped to the lender's machine (VRAM minus 1 GB, cores minus one, RAM minus 4 GB) |
| the experimental switch (`pool.flag.set`), the pinned llama.cpp build, the model file | on the borrower, before any ask |

A share asked for above the granted VRAM or RAM is refused (`vram`, `ram`). A lease expires after
`maxLeaseMinutes`. Revoking or the expiry of any of the four grants, a block, or a closed session ends
every lease of that peer at once: rpc-server is killed, the stream closed, `pool.revoked` sent, and the
borrower stops llama-server and removes the pooled brain. A watchdog stops rpc-server above its memory
limit. Answers of a pooled model carry `remoteOrigin` (the first lender), like other remote output.

## Messages

| Type | From | Stream | Body |
| --- | --- | --- | --- |
| `pool.lease.ask` | borrower | 1 | `{ id: pq_<12 hex>, kind: gpu \| cpu, model, bytes, minutes }` |
| `pool.lease.ok` | lender | 1 | `{ id, leaseId: ls_<12 hex>, kind, limits { vramBytes \| ramBytes, threads }, expiresAt }` |
| `pool.lease.no` | lender | 1 | `{ id, code: not_granted \| vram \| ram \| busy \| crashed \| bad_input, message }` |
| `pool.lease.end` | borrower | 1 | `{ leaseId, reason }` |
| `pool.revoked` | lender | 1 | `{ leaseId, reason: revoked \| expired \| grant_revoked \| grant_expired \| offline \| ram \| vram \| crashed }` |
| `pool.open` | borrower | 2 | `{ leaseId, ch }` a new connection of llama-server |
| `pool.up` / `pool.down` | borrower / lender | 2 | `{ leaseId, ch, b64 }` at most 256 KB per message |
| `pool.ack` / `pool.dack` | borrower / lender | 2 | `{ leaseId, ch, bytes }` bytes written on the other side |
| `pool.close` / `pool.dclose` | borrower / lender | 2 | `{ leaseId, ch, why }` |

Flow control: a side stops reading its socket while more than 4 MB of one channel are not acknowledged.
At most 16 channels per lease. The lender dials only its own rpc-server port on 127.0.0.1; the borrower
listens only on 127.0.0.1.

## Audit

Lender: `pool.lease`, `pool.lease.refused`, `pool.lease.ended` (with `grant`, `revoke`, `grant.expired`
of the node). Borrower: `pool.session`, `pool.lease.revoked`, `pool.session.stopped`.

## Engine commands (local user only)

`pool.p2p.start { id, ctx, peers?: [{ peerId, kind, bytes }], localShare? }` (without `peers`: the meter's
plan), `pool.p2p.stop`, `pool.p2p.status`, `pool.flag.set { on }`, `pool.build.status`,
`pool.build.install { yes: true }`, and `models.pool { id, ctx }`, which counts only online peers that
granted `compute.pool`, uses each session's measured round trip for the speed, and answers
`runnable: true` only when the switch, the build, the model and the granted memory are all there.

## Measured

Two engines on one PC over ws-lan, Qwen2.5-Coder 0.5B Q4_K_M, half of the layers on the lender's CPU
rpc-server (2 threads): load 66 s, first turn 16 tokens in 53 s, while other work kept the CPU about 90
percent busy. A cancel stopped the turn at once; a revoke of `compute.ram` ended the lease, killed
rpc-server and removed the pooled brain. `test/pool/p2p-pool.test.js`.
