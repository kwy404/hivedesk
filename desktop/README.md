# hivedesk desktop app

hivedesk opens as a desktop app: its own native window with the hive title bar, an icon in the system
tray (the menu bar on macOS), native notifications, folder pickers and a single instance. It is a small
native shell around the same local server and UI that `npx hivedesk` starts. This page is the
technical documentation of the shell, the downloads and their first launch prompts.

## How it works

```text
npx hivedesk  or  hivedesk.exe / hivedesk.app / ./hivedesk
  -> wizard (terminal runs only), local server on 127.0.0.1 with a per run token
  -> desktop runtime: bundled in a package, cached, or downloaded once (checked by SHA-256)
  -> native window (hidden title bar of the OS, hive title bar drawn by desktop/shell.html)
       shell page  = GET /api/desktop/shell?t=<token>   (same origin as the UI)
       UI          = an iframe of /?t=<token> inside the shell
       Node side   = desktop/controller.js talks to the runtime over its local WebSocket
  -> if anything above fails: a plain reason, the one command fix, and an app mode browser window
```

* The window uses the web view of the operating system: WebView2 on Windows, WebKit on macOS,
  WebKitGTK on Linux. No browser engine is bundled.
* The page in the window is served by the hivedesk server itself, so the token cookie and the
  WebSocket work exactly as in a browser. Only `desktop/controller.js` (Node) holds the runtime
  access token; the page asks it through `POST /api/desktop/*` routes, which need the hivedesk token.
* The runtime may only call what the shell needs (`nativeAllowList` in `desktop/native.js`):
  window control, tray, notifications, the folder and file pickers, `os.open` and `app.exit`.
  No file system, process or shell command API is enabled. Its one time token page is consumed by
  the controller right after it connects, so no other local program can read it.

## The runtime and why this one

Requirements: prebuilt binaries for Windows, macOS and Linux; uses the OS web view; no compiler
toolchain on the user's machine (no Rust, C++ or Xcode); a download of a few MB, not a browser engine;
a permissive license; tray, notifications and native dialogs.

Choice: **Neutralinojs 5.6.0** (MIT). One self contained binary per platform, 1.4 to 4.5 MB, driven
over a local WebSocket, so the Node side needs no native module and no build step.

* Native bindings of a web view for Node need a C++ toolchain or prebuilt addons per Node version.
* Shells built on Rust need the Rust toolchain to build an app.
* Bundling a browser engine means 100 MB or more per platform.

Version 5.6.0 and not the newer 6.x line: on this project's Windows 10 test machine, 6.9.0 ignored the
configured window size and returned invalid sizes from `window.getSize`, and 6.8.0 hung with a hidden
window. 5.6.0 honors the size, works hidden and closes cleanly. The pin is in `desktop/platform.js`
(version, archive checksum, and the SHA-256 and size of every binary).

| Platform key | Binary | Size | Notes |
| --- | --- | --- | --- |
| `win-x64` | `neutralino-win_x64.exe` | 2.7 MB | needs WebView2 (built into Windows 11 and current Windows 10) |
| `win-arm64` | `neutralino-win_x64.exe` | 2.7 MB | runs through the x64 emulation of Windows on ARM |
| `mac-x64` | `neutralino-mac_x64` | 2.2 MB | |
| `mac-arm64` | `neutralino-mac_arm64` | 2.2 MB | the `.app` package bundles `mac_universal` (4.5 MB) |
| `linux-x64` | `neutralino-linux_x64` | 1.7 MB | needs WebKitGTK 4.1 (or 4.0) and a display |
| `linux-arm64` | `neutralino-linux_arm64` | 1.8 MB | same |
| `linux-arm` | `neutralino-linux_armhf` | 1.4 MB | same |

Anything else (for example 32 bit Windows or FreeBSD) opens the app mode browser window.

### Where the runtime comes from (`desktop/runtime.js`)

1. `HIVEDESK_RUNTIME`, a path to a runtime binary (for development).
2. `desktop/bin/` inside a downloadable package (the packages bundle it, nothing is downloaded).
3. The cache `~/.hivedesk/runtime/desktop-5.6.0/` (`HIVEDESK_HOME` moves `~/.hivedesk`).
4. A download, once, shown in the terminal as one line, for example
   `Baixando o app para Windows (x64), 2,7 MB`, then a progress line:
   * the binary alone from the hivedesk GitHub release of the running version
     (`hivedesk-runtime-win-x64.exe`, `hivedesk-runtime-mac-arm64`, ...);
   * if that is missing, the upstream release archive `neutralinojs-v5.6.0.zip` (5.1 MB), checked
     against its SHA-256, and only the one binary is taken out of it.

   The binary must match the pinned SHA-256 and size, or it is not used. Later runs start from the
   cache with no network.

## Fallbacks

When the native window cannot start, hivedesk says why in plain words, shows the one command fix
when there is one, and opens an app mode browser window (Edge or Chrome with `--app`, or the
default browser). The engine keeps running either way.

| Reason | Message (English) | Fix shown |
| --- | --- | --- |
| no WebView2 (old Windows 10) | WebView2, the web view Windows needs, is not installed | `winget install Microsoft.EdgeWebView2Runtime` |
| no WebKitGTK | WebKitGTK, the web view Linux needs, is not installed | `sudo apt install libwebkit2gtk-4.1-0`, `sudo dnf install webkit2gtk4.1`, `sudo pacman -S webkit2gtk-4.1` or `sudo zypper install libwebkit2gtk-4_1-0`, from `/etc/os-release` |
| no display (SSH, server) | no graphical display was found | |
| unsupported OS or CPU | there is no desktop app for this system yet | |
| download failed | the app could not be downloaded (error) | |
| checksum mismatch | the downloaded app did not match its checksum, so it was not used | |
| the window did not start or load in 30 s | the native window did not start (error) | |

* `--browser` (or `HIVEDESK_BROWSER=1`) always uses the browser.
* `--no-open` opens nothing; the address is printed.
* The messages are in the 10 UI languages (`cli.desktop.*` keys, see Strings below).

## Native touches

| Feature | How |
| --- | --- |
| Hive title bar | frameless window, `desktop/shell.html` draws the bar: icon, project folder, menu, minimize, maximize, close (traffic light buttons on macOS). Drag to move, double click to maximize, edges to resize. "Use the system title bar" in the menu switches to the OS frame on the next start. |
| Tray or menu bar icon | Open, Pause the crew (Resume the crew), Open project folder, Quit. In Portuguese: Abrir, Pausar equipe, Retomar equipe, Abrir pasta do projeto, Sair. |
| Pause the crew | `crew.update { paused: true }` for every worker (PROTOCOL.md section 4); the title bar shows "Crew paused". |
| Notifications | job done, job failed, waiting for your approval, brief ready; only while the window is not in front. |
| Project folder | menu "Choose project folder" opens the OS folder picker; hivedesk starts again in that folder and remembers it. "Open project folder" opens it in Explorer, Finder or the Linux file manager. |
| Single instance | `~/.hivedesk/desktop/instance.json` (pid, port, token, folder, mode 600). A second run asks the first one (`POST /api/desktop/focus`) to show its window, says so and exits. A lock left by a process that is gone is replaced. |
| Close to tray | closing the window hides it and the crew keeps working; a notification says so (once per run). Turn it off in the menu ("Keep running in the tray when closed"); then closing quits. When the tray icon cannot be created (Linux without an AppIndicator library), closing quits. |
| Window state | size, position and maximized are saved in `~/.hivedesk/desktop/window.json` and restored; minimum 760 by 520; a position that would be off screen is dropped and the window is centered. |
| Settings | `~/.hivedesk/desktop/settings.json`: `closeToTray`, `frame` (`custom` or `system`), `lastDir`. |

### Bridge for the UI inside the window

The UI runs in an iframe of the shell (same origin). On load the shell posts
`{ type: 'hivedesk:desktop:hello', platform, native, ops }` to it. The UI can ask:

```js
parent.postMessage({ type: 'hivedesk:desktop', id: 'r1', op: 'pickFolder', data: { title } }, location.origin);
// ops: pickFolder -> { path }, pickFile { title, multiple, filters: [{ name, extensions }] } -> { paths },
//      openFolder -> { ok }, info -> { mode, platform, dir, paused, closeToTray, frame }
// reply: { type: 'hivedesk:desktop:reply', id: 'r1', ok, result, error }
```

## Installers

`.github/workflows/desktop.yml` builds these on a version tag (`v*`) and attaches them to the GitHub release,
with the app packages below, the signed update manifest and `SHA256SUMS.txt` (desktop/RELEASE.md).

| File | What it does |
| --- | --- |
| `hivedesk-setup.exe` (about 0.3 MB) | The Windows installer: its own rounded 720 by 480 window in the brand, no administrator rights. Welcome, a tour of hivedesk while the app package downloads (the City, agents, P2P with friends, sharing GPU and CPU, the workbench, remote desktop, the phone), the MIT license, the location (default `%LOCALAPPDATA%\Programs\hivedesk`) with Start menu and desktop shortcuts, start with Windows (off) and automatic updates (on), the profile (a display name and an avatar from the gallery, or skip), then the install with progress, speed and time left. The package is pinned by SHA-256 and size at build time. It registers in Apps and Features with an uninstaller, and ends with Open hivedesk. 10 languages, from the Windows display language. GitHub, npm, site and author links in the footer. |
| `hivedesk-setup-offline.exe` (about the size of the package) | The same installer with the app package inside, for machines without a network. |
| `hivedesk-macos.dmg` | The app with a link to Applications over a designed background that shows the drag, the first launch steps and the credits, plus "Read me first.txt". |
| `hivedesk-linux-x86_64.AppImage`, `hivedesk_<v>_amd64.deb`, `hivedesk-<v>-1.x86_64.rpm` | Linux: one file that updates itself, or system packages in `/opt/hivedesk` (the app shows the update command). |
| `hivedesk-linux-install.sh` | Installs into `~/.local` (no root) after checking `SHA256SUMS.txt`, with a menu entry and an icon; `--uninstall` removes it. |

**Why WPF for the Windows installer.** It is built with the C# compiler and WPF that ship with every Windows 10
and 11 (.NET Framework 4.8), the same compiler the launcher already uses, so the installer needs no runtime and
no download beyond itself: 0.3 MB. WPF gives a real vector UI (a transparent rounded window, gradients, the
honeycomb, animated slides) with no web view, so it works on machines where WebView2 is missing, which is exactly
when an installer has to explain that. A web view UI would need WebView2 plus a second native fallback UI.
`hivedesk-setup.exe --render <folder>` draws every page to PNG offscreen, and `--self-test --prefix <folder>`
runs the flow, strings, pages, download resume, SHA-256 check, install, repair, upgrade and uninstall inside one
temporary folder, without a window and without touching the real profile.

**The install layout** (the same for the Linux install script under `~/.local/share/hivedesk`):

```text
%LOCALAPPDATA%\Programs\hivedesk\
  hivedesk.exe          the launcher: starts versions\<current.txt>\
  current.txt           the version in use (one atomic rename switches it)
  versions\1.0.0\       node\, app\, the launcher of that version
  versions\0.9.0\       the previous version, kept for a rollback
  uninstall.exe, hivedesk.ico, update-state.json
```

**The profile.** The installer writes `profile.json` into the hivedesk home (`~/.hivedesk`, or
`HIVEDESK_HOME`): `{ "name": up to 32 characters, "avatar": an id from the gallery }`. The DMG and the Linux
packages have no wizard, so the app shows the same choice once on its first run (Skip is allowed; the app asks
later). The gallery ids live in one file, `desktop/profile/avatars.json` (placeholder monograms until the design
gallery replaces it); `desktop/profile/index.js` validates and writes the file.

## Updates

On start and every 6 hours the app reads the signed manifest of the latest release, verifies its Ed25519
signature with the public key built into the app (`desktop/update/pubkey.js`), downloads the package for its
install kind in the background (resuming a partial download), checks the SHA-256, and offers Update now, When I
close and Remind me later. The new version starts on trial and the previous one comes back automatically if it
does not open its window. The menu has "Update automatically" and "Beta channel"; `npx hivedesk` users get the
`npx hivedesk@latest` notice instead. How it works in detail and how to release: desktop/RELEASE.md.

| Install | How it updates |
| --- | --- |
| Windows installer, Linux install script | a new `versions/<v>` folder, then the `current.txt` pointer; the root launcher is swapped after a healthy start |
| macOS `hivedesk.app` | the bundle is replaced; the old one is kept until the new one is healthy |
| AppImage | the file is replaced the same way |
| `.deb`, `.rpm` | the panel shows `sudo apt install ./hivedesk_<v>_amd64.deb` or `sudo dnf install ./hivedesk-<v>-1.x86_64.rpm` |
| a zip or tar.gz unpacked by hand | the panel links to the release page |
| `npx hivedesk` | the panel and the terminal show `npx hivedesk@latest` |

## App packages

The installers and the updater download these; they also work unpacked by hand. Nothing needs to be installed
first: each package carries its own Node.js and its own desktop runtime.

| File | Contents | Start | Size (about) |
| --- | --- | --- | --- |
| `hivedesk-windows-x64.zip` | `hivedesk/hivedesk.exe` (a small launcher, no console window), `node/node.exe` (official Node.js 24 LTS build) with its LICENSE, `app/` (the npm package files plus `desktop/`), `app/desktop/bin/hivedesk-runtime.exe` with its license, `README.txt` | unzip, double click `hivedesk.exe` | 42 MB |
| `hivedesk-macos-universal.zip` | `hivedesk.app` for Apple Silicon and Intel: `Contents/MacOS/hivedesk` (launcher script), `Contents/Resources/node/bin/node` (universal Node.js 24 LTS made from the official arm64 and x64 builds), `Contents/Resources/app/`, the universal runtime in `app/desktop/bin/`; ad hoc signed | unzip, move to Applications, open | 80 MB |
| `hivedesk-linux-x64.tar.gz` | `hivedesk/hivedesk` (launcher script), `node/bin/node`, `app/`, `hivedesk.desktop`, `hivedesk.png`, `README.txt` | `tar -xzf`, then `./hivedesk/hivedesk` | 35 MB |
| `hivedesk-linux-x86_64.AppImage` | the same folder as one file | `chmod +x`, then run it | 35 MB |
| `hivedesk-runtime-*` | the desktop runtime binaries alone, for `npx hivedesk` (see above), with `hivedesk-runtime-LICENSE.txt` | | 1.4 to 4.5 MB |

The launchers set `HIVEDESK_DESKTOP=1` and run `app/desktop/main.js`: the saved setup from the
wizard (or the recommended defaults), the last project folder (or `~/hivedesk`), then the window.
Logs go to `~/.hivedesk/desktop/launcher.log`; if hivedesk stops with an error, the launcher shows the
last lines in a dialog. The same options as the CLI work (`hivedesk.exe --demo`, `--dir <folder>`).

The local model is not in the packages. The first run downloads it as described in FIRST-RUN.md.

## First launch: the security prompts

The packages are **not signed** with a paid code signing certificate, so each OS asks once.

**Windows (SmartScreen).** "Windows protected your PC" (for `hivedesk-setup.exe` or `hivedesk.exe`). Click **More info**, then **Run anyway**.
If Windows blocks the zip itself, right click the zip, Properties, tick **Unblock**, OK, then unzip.
Some antivirus tools scan a new `hivedesk.exe` for a few seconds on the first start.

**macOS (Gatekeeper).** Open the DMG and drag `hivedesk.app` to Applications (the DMG window shows it), then open it. macOS says it
cannot verify the app. Open **System Settings, Privacy and Security**, scroll down and click
**Open Anyway** next to hivedesk, then confirm with your password. On older macOS versions,
right click (or Control click) the app and choose **Open**. In a terminal this does the same:
`xattr -dr com.apple.quarantine /Applications/hivedesk.app`.
The app is signed ad hoc (Apple Silicon needs a signature to run at all), not with a Developer ID.

**Linux.** No prompt. The archive keeps the execute bits. The AppImage needs `chmod +x` and FUSE 2
(`sudo apt install libfuse2`); without FUSE run it with `--appimage-extract-and-run`. The window needs
WebKitGTK 4.1 (see Fallbacks). The tray icon needs an AppIndicator library
(`libayatana-appindicator3-1`); without it the app works and closing the window quits.

## Environment variables

| Variable | Effect |
| --- | --- |
| `HIVEDESK_BROWSER=1` | same as `--browser` |
| `HIVEDESK_RUNTIME=<path>` | use this runtime binary |
| `HIVEDESK_LANG=<locale>` | language of the desktop strings (`en`, `pt-BR`, `es`, `fr`, `de`, `it`, `ja`, `ko`, `zh-CN`, `ru`) |
| `HIVEDESK_DESKTOP=1` | set by the launchers: package mode (project folder from the settings) |
| `HIVEDESK_DESKTOP_HIDDEN=1` | tests: the window starts hidden, no taskbar entry, no tray, no notifications, never a browser |
| `HIVEDESK_READY_MS=<ms>` | how long to wait for the window to load (default 30000) |
| `HIVEDESK_NO_UPDATE=1` | no update checks in this run |
| `HIVEDESK_UPDATE_TRIAL`, `HIVEDESK_UPDATE_ROLLED_BACK` | set by the update guard on the version it starts |

## Strings

`desktop/i18n.json` has every `cli.desktop.*` key in the 10 UI languages. When the shared
`i18n/<locale>.json` has the same key, the shared one wins, so translators can work in one place.
`desktop/strings.js` formats them with `i18n/index.js`.

## Files

| File | Role |
| --- | --- |
| `index.js` | what the CLI calls: `focusExisting`, `packagedDir`, `openDesktop` |
| `main.js` | entry point of the packages |
| `controller.js` | routes for the shell, tray, notifications, close to tray, window state, project folder, fallback |
| `native.js` | runtime config, process start, its local WebSocket client |
| `wsclient.js` | a minimal WebSocket client (Node 18 has none built in) |
| `platform.js` | platform keys, pinned binaries and checksums, download sources |
| `runtime.js`, `zip.js` | find, download, verify and cache the runtime |
| `detect.js` | web view detection and the launch decision |
| `instance.js` | single instance lock |
| `state.js` | window state and settings store |
| `browser.js` | app mode browser fallback |
| `strings.js`, `i18n.json` | the desktop strings |
| `shell.html` | the hive title bar, menu and the UI frame |
| `app/resources/icons/` | window and tray icons (from `icons/*.svg` by `scripts/icons.mjs`) |
| `launcher/` | Windows launcher source (C#, compiled in CI with the compiler that ships with Windows), macOS and Linux launcher scripts, `Info.plist`, `.desktop`, `AppRun` |
| `update/` | the updater: `version.js`, `manifest.js` (Ed25519 signed `latest.json`), `pubkey.js`, `download.js` (resume, SHA-256), `tar.js`, `layout.js` (install kinds), `apply.js` (stage, swap, rollback), `guard.js` (the restart and the first launch health check), `service.js` (checks, settings, the panel state) |
| `profile/` | the local profile: `avatars.json` (the gallery ids), `index.js` (validate, read, write `profile.json`) |
| `installer/windows/` | `hivedesk-setup.exe`: `Core.cs` (flow, engine, downloader, shortcuts, registry), `Ui.cs` (the window), `Setup.cs` (entry, self-test, renderer), `Theme.xaml`, `Art.xaml`, `strings.json` (10 languages), `app.manifest` |
| `installer/macos/` | `make-dmg.sh`, `background.html` and its PNGs, `Read me first.txt` |
| `installer/linux/` | `hivedesk-linux-install.sh` |
| `release-notes/` | the notes of each version in 10 languages, for the update panel |
| `scripts/` | `package.mjs` (stage a package), `build-setup.mjs` (the Windows installers), `manifest.mjs` (sign `latest.json`), `update-keygen.mjs`, `dmg-art.mjs`, `shell-screens.mjs`, `fetch-node.mjs`, `runtime-assets.mjs`, `icons.mjs`, `smoke.mjs` |

## Tests

* `test/desktop/runtime.test.js`: the platform matrix, download with checksum, the zip fallback,
  a corrupt cache, the cache hit, network failure; downloads are mocked, no network.
* `test/desktop/launch.test.js`: web view detection and the fallback decision, the single instance
  lock, the window state store, the strings in 10 languages, the runtime config.
* `test/desktop/update.test.js`: version order and channels, the manifest signature (good, other key,
  tampered, missing, without the context), the stable and beta checks, the SHA-256 mismatch, resume, archive
  safety, and stage, swap, rollback and the guard on fake installs with Windows and POSIX layouts, the macOS
  bundle and the AppImage.
* `test/desktop/installer.test.js` (Windows): builds `hivedesk-setup.exe` and runs its self-test in a
  temporary prefix.
* `test/desktop/linux-install.test.js`: the install script with its checksum, upgrade and uninstall.
* `test/desktop/profile.test.js`: `profile.json` in a temporary home.
* `node desktop/scripts/smoke.mjs`: a real native window, **hidden**, with a `--demo` engine. It passes
  when the shell reports the UI frame loaded, the UI connected its WebSocket, the runtime says the
  window is not visible, and the runtime process is gone after closing. On the Windows 10 test machine
  it passes in about 9 s.

## Honest limits

* The installers and apps are not signed with a paid certificate or notarized (see the prompts above).
  The updates are signed with the project's own Ed25519 key and checked before they are applied.
* The DMG window layout is set by Finder in CI; if Finder scripting fails on the runner the DMG still works,
  with a plain window.
* `.deb` and `.rpm` installs do not update themselves (there is no package repository yet).
* The frameless window is moved and resized by the page through the runtime; when that feels wrong on
  a setup, "Use the system title bar" in the menu switches to the OS frame.
* Windows on ARM runs the x64 runtime through emulation.
* On Linux the tray icon depends on an AppIndicator library and the desktop environment.
* `npx hivedesk` uses the desktop window once `src/cli.js` calls `desktop/index.js` (the hooks requested
  in NOTES-engine.md) and `desktop` is in the package.json `files`. Until then it opens the browser
  window as before; the downloadable packages do not depend on it.

## Credits

* [Neutralinojs](https://github.com/neutralinojs/neutralinojs) 5.6.0, MIT License, Copyright (c) 2021
  Neutralinojs and contributors. Its license, with the notices of the libraries it includes, ships next
  to the binary in every package and in the release.
* [Node.js](https://nodejs.org/), MIT License, bundled in the packages with its LICENSE file.
* [appimagetool](https://github.com/AppImage/appimagetool), used at build time only.
