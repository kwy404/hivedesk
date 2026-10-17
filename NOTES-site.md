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
