# Notes for the engine

## From lend (src/lend/, ui/lend/)

1. Plug-in loading: please call the default export of `src/lend/index.js` with
   `{ scheduler, bus, server, config }` as PROTOCOL.md section 6 says. `lend.chat` runs the
   friend's turn through `scheduler.turn({ workerId: 'lend:friend', messages, options })`
   after its own checks (size caps, rate limit, one at a time, refused after Stop). Without the
   plug-in the browser falls back to the engine's `brain.chat` (still checked in the browser).
2. Error codes: when a `server.command` handler throws an error with `err.code`
   (`rate_limited`, `busy`, `stopped`, `prompt_too_long`, `not_lending`...), please keep that
   code in the failed `reply`.
3. `--lend`: please open the browser at `/lend/?t=<token>` (the standalone Lend screen), or
   let the desktop mount it (see UI below).
4. `--join <link or six words>` (optional): open `/?t=<token>#w=word-word-word-word-word-word`
   so the "Use a friend's PC" window opens filled in and connects.
5. The e2e test `test/lend/e2e-lend.mjs` needs `playwright-core` as a devDependency (it falls
   back to the env var `PLAYWRIGHT_CORE`, a path to an installed copy). Script suggestion:
   `"e2e:lend": "node test/lend/e2e-lend.mjs"`.

