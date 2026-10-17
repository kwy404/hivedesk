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
