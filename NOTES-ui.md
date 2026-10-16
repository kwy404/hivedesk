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
