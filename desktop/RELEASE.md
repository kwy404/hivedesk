# Releasing hivedesk (installers and signed updates)

A version tag builds everything in `.github/workflows/desktop.yml` and attaches it to the GitHub release.
The installed apps update themselves from that release, but only after checking an Ed25519 signature over
the update manifest (`latest.json`) with the public key built into the app.

## One time: the update signing key

The key pair already exists. The private key is outside the repository:

```text
C:\Users\Hadouken Game Center\.hivedesk-release\update-key.pem      (Ed25519, PKCS8, readable only by you)
```

Its public half is in `desktop/update/pubkey.js` (`IOUmwMSYcKVyZeXELVHUwwH/RMC/searO2JlbByp+lY=`) and ships in
every build. Back the private key up somewhere safe (a password manager). If it is lost, the apps already
installed can never verify another update and their users must download a new installer by hand.

**Give the key to GitHub Actions** (run this once yourself, in PowerShell, with the GitHub CLI logged in):

```powershell
Get-Content -Raw "$HOME\.hivedesk-release\update-key.pem" | gh secret set HIVEDESK_UPDATE_KEY --repo kwy404/hivedesk
```

The same from Git Bash: `gh secret set HIVEDESK_UPDATE_KEY --repo kwy404/hivedesk < ~/.hivedesk-release/update-key.pem`.

With a key that does not match `desktop/update/pubkey.js`, the release stops in the first job ("Update signing
key") with an error, and nothing is published. An unsigned manifest is never written.

**Without the secret** the release still goes out: the key check and the manifest step print a warning and skip,
and the release gets every installer and package plus `SHA256SUMS.txt`, but no `latest.json`. Installed apps do
not see it as an update until it is signed. Sign it from your PC (GitHub CLI logged in, the key in
`%USERPROFILE%\.hivedesk-release\update-key.pem`):

```powershell
node desktop/scripts/sign-release.mjs --tag v1.0.0 --dry-run   # prints the commands, reads nothing
node desktop/scripts/sign-release.mjs --tag v1.0.0
```

It downloads the release assets into a temporary folder (`gh release download`), writes and signs `latest.json`
with `desktop/scripts/manifest.mjs` (the key goes to that process only, never to a log), rewrites `SHA256SUMS.txt`
with the manifest included, and uploads `latest.json`, `latest.json.sig` and `SHA256SUMS.txt` with
`gh release upload --clobber`. Run it from a checkout of the same tag, so the release notes file is there.

Check a key locally: `HIVEDESK_UPDATE_KEY="$(cat ~/.hivedesk-release/update-key.pem)" node desktop/scripts/manifest.mjs --check`.

## Every release

1. Set the version in `package.json` (for example `1.1.0`, or `1.1.0-beta.1` for the beta channel).
2. Write `desktop/release-notes/<version>.json` with the notes in all 10 languages
   (`en`, `pt-BR`, `es`, `fr`, `de`, `it`, `ja`, `ko`, `zh-CN`, `ru`). The update panel shows them.
3. Commit, then tag and push the tag: `git tag v1.1.0 && git push origin v1.1.0`.
4. The workflow checks the key and the notes, runs the desktop tests, builds and tests every installer, signs
   `latest.json`, writes `SHA256SUMS.txt` and creates the release. A version with a `-` becomes a pre-release,
   which only the beta channel receives.

## What a release contains

| File | For |
| --- | --- |
| `hivedesk-setup.exe` | Windows installer (about 0.3 MB): downloads `hivedesk-windows-x64.zip`, pinned by SHA-256 and size |
| `hivedesk-setup-offline.exe` | Windows installer with the app inside |
| `hivedesk-macos.dmg` | macOS, Apple Silicon and Intel |
| `hivedesk-linux-x86_64.AppImage` | Linux, one file, updates itself |
| `hivedesk_<v>_amd64.deb`, `hivedesk-<v>-1.x86_64.rpm` | Linux packages (installed in `/opt/hivedesk`) |
| `hivedesk-linux-install.sh` | Linux install into `~/.local`, checks `SHA256SUMS.txt`, updates itself |
| `hivedesk-windows-x64.zip`, `hivedesk-macos-universal.zip`, `hivedesk-linux-x64.tar.gz` | the app packages the installers and the updater download (also usable unpacked by hand) |
| `latest.json`, `latest.json.sig` | the update manifest: version, notes in 10 languages, URL, size and SHA-256 of each app package; its Ed25519 signature |
| `hivedesk-runtime-*` | the desktop runtime binaries that `npx hivedesk` downloads |
| `SHA256SUMS.txt` | the SHA-256 of every file above |

## How an installed app updates

1. On start (after 8 seconds) and every 6 hours, it reads `latest.json` and `latest.json.sig` of the latest
   release (stable), or of the newest release including pre-releases (beta). Settings in the app menu:
   "Update automatically" and "Beta channel".
2. It verifies the signature with the embedded public key, refuses a version that is not newer, and picks the
   package for its install kind (`desktop/update/layout.js`).
3. It downloads in the background, resuming a partial download, and checks the size and SHA-256.
4. It stages the new version next to the running one. The panel offers Update now, When I close and Remind me later.
5. On restart, a guard process from the old version switches with one rename (the `current.txt` pointer on
   Windows and the Linux install script, the `.app` bundle on macOS, the AppImage file) and starts the new
   version on trial. If the new version does not report its window within 2 minutes, or exits first, the guard
   switches back and starts the previous version, which then says so.

`.deb` and `.rpm` installs and hand unpacked zips show the command or the download link instead; `npx hivedesk`
users see "npx hivedesk@latest" in the terminal and in the panel.

## Rotating the key

Only when the private key may have leaked: run `node desktop/scripts/update-keygen.mjs --force`, commit the new
`desktop/update/pubkey.js`, set the secret again with the command above, and release. Apps built with the old key
reject manifests signed with the new one, so their users install the new version once by hand.
