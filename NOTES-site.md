# Notes for the site

## From lend (src/lend/, ui/lend/)

1. The Lend screen's share link and QR code point to
   `https://kwy404.github.io/hivedesk/lend/#w=word-word-word-word-word-word`
   (`LINK_BASE` in `ui/lend/core/link.js`). Please add a tiny `docs/lend/index.html` that reads
   the words from the hash (the regex `/[#&?]w=([A-Za-z-]+)/`) and shows them big, numbered 1
   to 6, with: "Open hivedesk on your computer, choose Use a friend's PC and enter these six
   words (or paste this link into the first box)." and the command
   `npx hivedesk --join "<the link>"`. Nothing is sent anywhere; the hash never reaches the server.
2. In the "Honest about the limits" section, lending facts you can quote: only prompts and
   answers travel; the friend's files are never read or written; the friend sees every request
   and can stop at any time; at most 20 requests per minute, prompts up to 120,000 characters,
   one request at a time; the pairing words expire after 10 minutes and work once; pairing uses
   public MQTT relays that only see a random topic and ciphertext; no TURN relay is built in,
   so two very strict networks may not connect.

## Status (site)

- Done: `docs/lend/index.html` reads `#w=` and shows the six words, the `--join` command with the public link, and the privacy facts.
- Done: the lending facts are quoted in the limits section of the site and the README.

## From ui (ui/)

Real screenshots of the desktop are in `ui/screenshots/` (Edge headless, `--demo` engine):

| File | What it shows |
| --- | --- |
| `hive-1920-job-running.png` | hero candidate: a demo job mid run, timeline, #general, live preview, diff, Dev streaming |
| `hive-1440-job-running.png` | the same at 1440 by 900 |
| `hive-375-phone.png` | phones: windows become stacked cards, dock at the bottom |
| `hive-1920-context-menu.png` | the right click menu on a task |
| `hive-1920-desktop-menu.png` | the desktop menu with the wallpaper submenu |
| `hive-1920-palette.png` | Ctrl K command palette |
| `hive-1920-hire.png` | the Hire dialog |
| `hive-1920-replay.png` | the replay scrubber rebuilding an earlier moment |
| `hive-1440-model-download.png` | Settings with the model download prompt (size, source, progress). The progress and the "Saved to" path were simulated for the shot; the window is the real UI |

Every demo shot carries the visible "Demo" label in the top bar, as PROTOCOL.md section 8 asks.

## From desktop (desktop/)

hivedesk now opens as a desktop app: its own window with the hive title bar, a tray (menu bar) icon,
native notifications, a folder picker and a single instance. Please update README.md, README.pt-BR.md,
FIRST-RUN.md and the site (marketing copy: "desktop app", do not name the runtime there):

1. Step 1 of FIRST-RUN.md: "Starts the server ... and opens the hivedesk window (a desktop app). The
   first time it downloads the small desktop runtime for your OS (1.4 to 4.5 MB, checked against a
   pinned SHA-256, cached in `~/.hivedesk/runtime/`). If the window cannot open (no WebView2 on an old
   Windows 10, no WebKitGTK on Linux, no display), hivedesk says why, shows the one command fix and
   opens a browser window instead. `--browser` always uses the browser."
2. Downloads section (README and site): `hivedesk-windows-x64.zip`, `hivedesk-macos-universal.zip`,
   `hivedesk-linux-x64.tar.gz` and an AppImage on https://github.com/kwy404/hivedesk/releases, each
   with its own Node.js, nothing to install first. Link `desktop/README.md` for what each contains and
   the first launch prompts (they are not signed: SmartScreen "More info, Run anyway"; macOS
   "Privacy and Security, Open Anyway").
3. Honest limits: the downloads are not signed and do not update themselves; the local model is still
   downloaded on the first run (FIRST-RUN.md).
4. Credits (technical, e.g. the README footer or desktop/README.md link): the desktop shell uses
   Neutralinojs (MIT).

## From the engine (2026-10-16, late)

FIRST-RUN.md is rewritten and is the source to quote. New, all shipped and tested:

1. **Wizard:** runs on every `npx hivedesk` in a terminal; full on the first run, then only "Use the same setup?".
   `--yes` or no terminal skips it. Steps and the hardware table are in FIRST-RUN.md sections 1 and 2.
2. **Cloud providers** (supported options, no comparisons): Anthropic, OpenAI, xAI, Google Gemini, and any OpenAI
   compatible endpoint (OpenRouter, Groq, Mistral, local servers). Keys stay in `~/.hivedesk/keys.json`, never reach
   the browser; Test connection; a brain per worker; tokens per brain. Honest note: providers receive the prompts and
   file contents and bill the user's account.
3. **Memory and sessions:** local only, capped, viewable and editable in the Memory window, "forget this", an off switch,
   sessions that can be reopened and continued.
4. **Prompting:** every model call is assembled from tagged sections with a token budget; the Prompts window shows the
   exact prompt and answer per turn. QA findings carry a severity; at most 3 fix rounds.
5. **Windows:** native desktop window first (desktop/), then an app style browser window, then the browser;
   installable as an app with a "start hivedesk" page when the server is off.
6. **Measured** (README limits section has the line): GTX 1060 6 GB, 3B fully on the GPU, ready in 8 to 15 s from
   cache (about 70 s on the very first run including the 2.1 GB download), 17 to 39 tokens per second while writing,
   a tiny static page in about 1.5 to 2.5 minutes after loading. The 7B did not fit this card with a 4096 context
   tonight; hivedesk now steps down to the 3B on the GPU in that case.

## Status (site), round 2

- The site uses the real Office screenshots (`docs/assets/shots/office-*.webp`), the desktop download names and sizes from desktop/README.md, and live release sizes from the GitHub releases list when a release exists.
- Voice, Code together, themes, extensions, GitHub, the tour and the 10 languages are described from the source comments of ui/ and src/. If any of them changes before the release, please note it here.

## From Code together (ui/lend/collab/)

1. The Code together share link is `https://kwy404.github.io/hivedesk/lend/#cw=word-word-word-word-word-word`
   (`#cw=` so the desktop opens Code together, not Lend). Please let `docs/lend/index.html` read `#cw=` too and say
   "choose Code together" for it.
2. Facts you can quote: guests join with six words, a QR code or the link; confirmation words from both DTLS
   fingerprints; roles viewer (sees everything, can chat) and collaborator (can also ask the crew, approve steps and
   edit files), set by the host; guests never get a shell and every guest command goes through the host's engine and
   its approval rules; edits merge with a small text CRDT and are saved on the host's disk; a guest may also lend its
   model. The editor is served locally and loads only when the Code window opens.

## Language pages (site), 2026-10-17

- The site now has a static page per language: `docs/<lang>/index.html` for pt-BR, es, fr, de, it, ja, ko, zh-Hans
  and ru, built from `docs/index.html` (English source) by `python docs/_i18n/build.py`. Translations live in
  `docs/_i18n/<lang>.json`; `python docs/_i18n/build.py --export` refreshes `docs/_i18n/en.json` after the English
  page changes. The build also writes the SEO block of every page (canonical, hreflang, JSON-LD), `sitemap.xml` and
  `robots.txt`, and reads the version from package.json.
- Test: `python docs/_i18n/check.py` fails on a missing translation, placeholders that differ, an en or em dash, an
  AI product name, English sentences left on a language page, or a broken SEO block. Please wire it into CI next to
  scripts/check-site.mjs (scripts/ and test/ are not my area). Standard library Python only.
- If you edit text in `docs/index.html` (for example the version line), run the export and the build; units that are
  new show up as missing in check.py until they are translated.

## The 1.0 site and READMEs (next/site), 2026-10-17

- `docs/index.html` is the 1.0 landing (English source), with `docs/assets/v1.css` and `docs/assets/v1.js` on top of
  site.css and site.js. Sections: hero (two PCs, the encrypted link, the GPU and the City as an inline SVG), how it
  works, the City, Invite a friend (a step demo), Borrow a GPU (a scheduler demo with reasons, lease and Stop),
  workbench, remote screen, models with the pool meter (marked experimental, not in 1.0), playbooks (a picker over
  `docs/assets/playbooks.json`, built from `src/crew/library/entries/` by `docs/_i18n/build.py`), security, the
  Desktop app or browser table, download, limits, FAQ. All 10 languages are built by `docs/_i18n/build.py`.
- Facts come from docs/1.0/protocol/*.md in the stream worktrees and their code (p2p, compute, city, workbench,
  remote, the model catalog). If a stream changes a number (lease 15 s, invite 10 minutes, grant lengths 5/15/60,
  2 GB files, 41 models, 497 playbooks, control on Windows and X11 only), please note it here.
- Design: graphite surfaces, amber only for the main action and accents, hairlines, small radii, mono labels, short
  motion, no mascot or bursts on this page, per the coordinator's direction. When docs/1.0/DESIGN.md lands in
  hivedesk-design, the tokens at the end of v1.css are the place to align.
- Screenshots: the City shots are still the 0.2.0 demo captures; no 1.0 captures exist in ui/screenshots yet. New
  ones of the Machines panel, the workbench and the remote screen should replace or join them before the release.
- README.md and i18n/README.pt-BR.md are the 1.0 versions, with the same table near the top of Quick Start and
  `assets/illustrations/city-p2p.svg` (`city-p2p-pt.svg`) made from the hero art.
