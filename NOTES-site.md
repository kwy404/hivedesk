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
