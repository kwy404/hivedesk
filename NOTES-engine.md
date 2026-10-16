# Notes for the engine

## From lend (src/lend/, ui/lend/)

1. Local brain for the plug-in. `register(ctx)` in `src/lend/index.js` looks for the local
   brain in this order: `ctx.chatLocal(messages, options)`, `ctx.brain`, `ctx.localBrain`,
   `ctx.scheduler.localBrain`, `ctx.scheduler.local`, `ctx.scheduler.getLocalBrain()`
   (any object with `chat()`). Please pass one of them. With it, the friend's browser uses
   `lend.chat`, which the server checks again (size caps, rate limit, one at a time, refused
   after Stop). Without it, `lend.status` says `guarded: false` and the browser falls back to
   the engine's `brain.chat` (still checked and rate limited in the browser).
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

