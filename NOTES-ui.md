# Notes for the UI

## From lend (src/lend/, ui/lend/)

1. Window type and dock slot:
   ```js
   import { lendWindow, mountLend } from '/lend/index.js';
   // lendWindow = { type: 'lend', title, icon: 'link', dock: { slot: 'lend', label }, mount(el) }
   ```
   and link `/lend/lend.css` once. The window needs about 560 by 520 px; it works at 375 px.
2. When `hello.lend` is true, show the Lend screen full size: `mountLend(el)`, or send the
   browser to `/lend/`.
3. When the page opens with `#w=...` in the hash, open the lend window: it fills the six
   boxes and connects by itself.

## From the site (docs/)

1. The site uses real captures of `--demo` at 1600 by 1000 in `docs/assets/shots/` (`hive.png`, `files.png`, `approval.png`, `phone.png`). If you save better ones in `ui/screenshots/`, tell the site owner or copy them over with the same names.
2. Possible bug seen in those captures: in the Files window, the Diff view of `style.css` and `index.html` shows a round code icon floating over the line gutter, and each diff line is split across columns (old number, new number and text far apart, text cut at the right). The Code view looks right.

## From the engine (2026-10-16 evening)

1. New window `ui/js/widgets/brief.js` (Brief and report), imported in `ui/js/main.js`. It keeps its own state from
   the events `brief.proposed`, `brief.approved` and `job.report` (PROTOCOL.md), opens by itself, and sends
   `brief.approve { jobId, use: refined | edited | original, text? }` and `playbook.save { jobId }`. Its strings are
   plain English for now: please move them to `i18n/` keys when you do the other windows.
2. `/i18n/<file>` is served now (json and js only, token required). In the headless smoke test (`node test/e2e-ui.mjs`)
   the top bar showed raw keys such as `top.ask.placeholder`, `top.build`, `chat.placeholderGeneral`: `i18n/en.json`
   did not exist yet at 20:50.
3. Settings: `brain.probe` options now carry `bytes` and `recommended: true` for the model chosen by the hardware
   table, and `recommended.reason` is the one line explanation; the event `brain.choice` carries the same line.
4. New settings keys: `refine` (prompt refiner on or off) and `crew` (builtin roles that take part).

## From the engine (22:10)

New engine features with UI pieces. I did not commit `ui/js/main.js` because it has your uncommitted work;
my lines are in your working copy (imports of the three windows below and four menu items after `dock.lend`).
Please keep them when you commit.

1. New windows, in their own files (please move their strings to `i18n/` keys like you did for `brief.js`):
   * `ui/js/widgets/memory.js`: Memory (search, pin, edit, delete, "forget this", memory on or off, privacy note,
     sessions with report, improved prompt and "Continue this session"). Commands: `memory.list|add|update|delete|forget`,
     `session.list|get|continue`, `settings.set { memory }`. Event `memory.used { items }` on the job lists the memories used.
   * `ui/js/widgets/providers.js`: Providers (a card per cloud provider: masked key, model list, Test connection,
     Remove key; brain per worker via `settings.set { workerBrains }`; tokens per brain from `/api/state` `usage`).
     Keys never come back: `provider.list` only says `configured`.
   * `ui/js/widgets/prompts.js`: Prompts (debug): `turn.recent` and `turn.prompt { turnId }` give the exact prompt,
     the answer and the token budget of the last 40 turns. `turn.started` also carries `budget`.
2. `brief.js`: the brief now has `questions[].options` (multiple choice, at most 3, for vague requests) and
   `brief.proposed.vague`. Please render each question as option buttons (the default is `answer`) and send the
   picks with `brief.approve { jobId, use: 'refined', answers: ['notes', 'dark', ...] }` (by question index).
3. QA reports now carry findings with a severity; `qa.report.issues` stays a list of strings (high and medium only).
4. Installable app (PWA): `ui/manifest.webmanifest`, `ui/sw.js`, `ui/pwa.js` and `ui/offline.html` are in place and served
   without the token. Please add to the `<head>` of `ui/index.html`:
   `<link rel="manifest" href="/manifest.webmanifest">` and `<script type="module" src="/pwa.js"></script>`.
   The CLI now opens an app style window (`--app`, own profile in `~/.hivedesk/browser-profile`), uses port 4174 when free,
   and keeps the token in `~/.hivedesk/token`, so the installed app reopens without a token in the URL.

## From desktop (desktop/)

1. In the desktop app the UI runs in an iframe of `desktop/shell.html` (same origin, the hive title
   bar is above it). On load the shell posts `{ type: 'hivedesk:desktop:hello', platform, native, ops }`
   to the UI. If you want native pickers (for example the GGUF file in Settings, or a project folder):
   `parent.postMessage({ type: 'hivedesk:desktop', id, op: 'pickFile', data: { title, filters: [{ name: 'GGUF', extensions: ['gguf'] }] } }, location.origin)`
   and listen for `{ type: 'hivedesk:desktop:reply', id, ok, result: { paths } }`. Ops: `pickFolder`,
   `pickFile`, `openFolder`, `info`. Details in desktop/README.md.
2. i18n: `desktop/i18n.json` has the `cli.desktop.*` keys in the 10 languages. Please merge them into
   `i18n/<locale>.json` (the shared file wins when it has the key).

## From themes and extensions (ui/themes/, ui/extensions/)

1. `ui/js/main.js` imports `../themes/index.js` and `../extensions/index.js` (two lines). They register the windows
   `themes`, `theme-editor`, `extensions` and `ext-widget`, their dock buttons (`addDockItem`) and Ctrl K entries (`globalThis.hivedeskPalette`).
2. `ui/js/sound.js`: `play` and `preview` read `globalThis.hivedeskSoundPack?.[name]` first, so a theme can bring its own sound pack.
   `null` keeps the built-in sounds.
3. A theme sets CSS custom properties inline on `<html>` plus `data-hd-theme` and `data-hd-scheme`. `ui/themes/themes.css` overrides the
   parts of hive.css and polish.css drawn with fixed charcoal (top bar, dock, hex buttons, tooltips, menus, toasts, palette, dialogs,
   tour bubble, hover tints) for the other themes. New fixed colors would look wrong in the light themes: please prefer
   `var(--panel*)`, `var(--text*)` and `var(--hd-hover)` for new surfaces.
4. Strings live under `themes.*` and `extensions.*` in all 10 `i18n/*.json` files; `ui/extensions/strings.js` keeps an English copy as fallback.
5. Suggestion: a "Themes" entry in Settings (next to the motion and wallpaper choices) that opens the gallery.

## From github and changelog (ui/github/, ui/changelog/)

1. **One import** in `ui/js/main.js`: `import '../github/index.js';` registers the `github` and `changelog` window types, two dock
   buttons through `addDockItem`, the Ctrl K entries through `globalThis.hivedeskPalette`, and the confirmation card.
2. **For the voice mode and the palette:**
   ```js
   import { runIntent } from '/github/index.js';   // also window.hivedeskGitHub.runIntent
   const r = await runIntent('faça commit e push');                     // shows the card, runs only on Yes
   const r = await runIntent(text, { confirm: async (plan) => yes });   // or { yes, edits }
   // r = { ok, ran, parsed, plan, result? | message? | error? }
   ```
   `plan.title` / `plan.titleKey`, `plan.steps[]` (`key`, `text`, `params`, `remote`), `plan.facts[]` and `plan.warnings[]` can be read
   aloud; `stepLabel(step, plan)` gives the translated sentence. Anything but an explicit yes runs nothing.
3. **Strings:** 243 keys under `github.*` and `changelog.*` were added to all 10 `i18n/*.json` files (additions only, no existing key changed).
   `ui/github/strings/<locale>.json` keeps the same tables as a fallback if the shared files are regenerated without them.
4. The card sits at z-index 9970/9971 so it stays above the guided tour (9860 to 9900) and below tooltips.

## From Code together and the Code editor (ui/editor/, ui/lend/collab/)

Hooks in shared files (already in place, please keep them when you edit these files):

1. `ui/js/net.js`: `useRemote(transport)` and `isRemote()`. While a remote transport is set, the desktop
   renders the host's session (frames from `transport.onFrame`, commands to `transport.send`) and the local
   socket is ignored. `useRemote(null)` returns to this PC's engine.
2. `ui/js/main.js`: `import '/editor/register.js'`. It registers the window types `editor` (the Code window),
   `collab` (Code together) and replaces `code`: `wm.open('code', path)` now opens the Code window on that file.
   Files, the palette and the dock can keep calling `wm.open('code', path)`, or use `window.hivedeskEditor.open(path)`.
3. `ui/js/palette.js`: entries from `globalThis.hivedeskPalette` (functions `q => [{ group, label, run, icon }]`).
4. register.js adds two dock buttons (Code, Code together) and the people avatars at the start of `.topbar .bar-right`.
   If you prefer real dock items or a top bar slot, give me the API and I will switch.
5. Live preview for guests: the preview iframe serves this PC's workspace, so a guest sees its own (empty)
   preview. A guest can read every file of the host through `files.read`. If you want the guest preview to show
   the host's site, check `window.hivedeskCollab?.mode === 'guest'` and build the page from `files.read`.
6. Strings: 105 keys under `code.*` and `collab.*` in all 10 `i18n/*.json` files (additions only).

## From the prompt library (src/crew/library/, 2026-10-17)

About 500 expert playbooks (one JSON file per entry in `src/crew/library/entries/<category>/`). For every planned
task the engine picks 1 to 3 (BM25 over the task, the request, the brief and the file types, plus role, room and
task kind), they go into the prompt under `<playbook>`, and their `checks` run in QA and in the City Test room.

1. New files, committed: `ui/js/widgets/library.js` (Library window: search, category filter, favorites, read an
   entry, add your own), `ui/js/widgets/library-used.js` ("Playbooks used" block with Swap, shown inside Brief and
   report) and `ui/js/widgets/library-strings.js` (strings for the 10 locales; keys `library.*` in `i18n/*.json`
   win when you add them, so you can move them there whenever you like).
2. Hooks in shared files: `ui/js/main.js` imports `./widgets/library.js` and adds one menu item after
   "Prompts (debug)"; `ui/js/widgets/brief.js` imports `usedView, usedBox` and appends `usedView(jobId)` between
   the brief and the report. Please keep these lines when you commit those files.
3. Events (on the job): `library.preview { picks }` after `brief.proposed` (job level picks, swappable while the
   brief waits); `library.selected { tasks: [{ taskId, workerId, picks: [{ id, title, score, terms, pinned?,
   swapped?, reranked? }], candidates, budget, used }] }` after `job.planned` and `task.added`, and again after
   a swap or a cloud model re-rank; `library.checks { results: [{ id, level, status, issues }] }` when QA runs.
4. Commands: `library.list { q?, category?, role?, favorites?, limit? }` -> `{ entries, total, stats }`;
   `library.get { id }`; `library.favorite { id, on }`; `library.add { entry }` (saved as
   `~/.hivedesk/library/my-<id>.json`); `library.remove { id }` (own entries only); `library.preview { text, role? }`;
   `library.job { jobId }` -> `{ preview, tasks }` (to rebuild the block after a reload);
   `library.swap { jobId, taskId?, from?, to? }` (a task only while it is pending; without taskId it pins and
   blocks for the whole job, before the plan).
5. A nice to have for later: a small "playbooks" chip on the task cards of the Timeline and the City task board,
   from the `library.selected` events.
