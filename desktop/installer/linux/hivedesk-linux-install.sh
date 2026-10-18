#!/bin/sh
# hivedesk for Linux: installs into ~/.local (no root), with a menu entry and an icon, and updates itself.
#   sh hivedesk-linux-install.sh                 install hivedesk @VERSION@
#   sh hivedesk-linux-install.sh --uninstall     remove it (your projects and ~/.hivedesk stay)
# Options: --prefix <dir> (default ~/.local), --from <dir> (use files already downloaded there).
# The download is checked against SHA256SUMS.txt of the release before anything is installed.
set -eu

VERSION="@VERSION@"
REPO="kwy404/hivedesk"
PREFIX="${HIVEDESK_PREFIX:-$HOME/.local}"
FROM=""
ACTION="install"
FILE="hivedesk-linux-x64.tar.gz"

while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) PREFIX="$2"; shift 2 ;;
    --from) FROM="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --uninstall) ACTION="uninstall"; shift ;;
    -h|--help) sed -n '2,7p' "$0"; exit 0 ;;
    *) echo "hivedesk: unknown option $1" >&2; exit 2 ;;
  esac
done

ROOT="$PREFIX/share/hivedesk"
BIN="$PREFIX/bin"
APPS="$PREFIX/share/applications"
ICONS="$PREFIX/share/icons/hicolor/512x512/apps"
say() { printf '  %s\n' "$*"; }
die() { printf 'hivedesk: %s\n' "$*" >&2; exit 1; }

if [ "$ACTION" = "uninstall" ]; then
  [ -f "$ROOT/current.txt" ] || die "hivedesk is not installed in $ROOT"
  rm -rf "$ROOT"
  rm -f "$BIN/hivedesk" "$APPS/hivedesk.desktop" "$ICONS/hivedesk.png"
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS" >/dev/null 2>&1 || true
  say "hivedesk was removed. Your projects and ~/.hivedesk were kept."
  exit 0
fi

case "$VERSION" in
  @*) die "this copy of the script has no version; download it from https://github.com/$REPO/releases" ;;
  *[!0-9A-Za-z.+-]*|'') die "bad version $VERSION" ;;
esac
case "$(uname -m)" in
  x86_64|amd64) ;;
  *) die "the Linux build is for x86_64; on $(uname -m) run: npx hivedesk" ;;
esac
command -v tar >/dev/null 2>&1 || die "tar is needed"
if command -v sha256sum >/dev/null 2>&1; then SHA="sha256sum"
elif command -v shasum >/dev/null 2>&1; then SHA="shasum -a 256"
else die "sha256sum is needed"; fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT INT TERM
fetch() {
  if command -v curl >/dev/null 2>&1; then curl -fL --retry 3 --progress-bar -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then wget -q --show-progress -O "$2" "$1"
  else die "curl or wget is needed"; fi
}

say "hivedesk $VERSION for Linux"
if [ -n "$FROM" ]; then
  cp "$FROM/$FILE" "$TMP/$FILE"
  cp "$FROM/SHA256SUMS.txt" "$TMP/SHA256SUMS.txt"
else
  BASE="https://github.com/$REPO/releases/download/v$VERSION"
  fetch "$BASE/SHA256SUMS.txt" "$TMP/SHA256SUMS.txt"
  fetch "$BASE/$FILE" "$TMP/$FILE"
fi

# The checksum, before anything is written outside the temporary folder.
EXPECT="$(awk -v f="$FILE" '{ n = $2; sub(/^\*/, "", n); if (n == f) print $1 }' "$TMP/SHA256SUMS.txt")"
[ -n "$EXPECT" ] || die "$FILE is not listed in SHA256SUMS.txt"
GOT="$(cd "$TMP" && $SHA "$FILE" | awk '{ print $1 }')"
[ "$GOT" = "$EXPECT" ] || die "the download does not match its SHA-256 (expected $EXPECT, got $GOT); nothing was installed"
say "SHA-256 checked"

# Same layout as the Windows installer: versions/<version>, current.txt, and the launcher at the root.
STAGING="$ROOT/versions/.$VERSION.staging"
rm -rf "$STAGING"
mkdir -p "$STAGING"
tar -xzf "$TMP/$FILE" -C "$STAGING" --strip-components=1
[ -f "$STAGING/app/desktop/main.js" ] && [ -x "$STAGING/node/bin/node" ] && [ -x "$STAGING/hivedesk" ] || { rm -rf "$STAGING"; die "the package is incomplete"; }
PREVIOUS="$(cat "$ROOT/current.txt" 2>/dev/null || true)"
rm -rf "$ROOT/versions/$VERSION"
mv "$STAGING" "$ROOT/versions/$VERSION"
cp "$ROOT/versions/$VERSION/hivedesk" "$ROOT/hivedesk.new"
chmod 755 "$ROOT/hivedesk.new"
mv -f "$ROOT/hivedesk.new" "$ROOT/hivedesk"
printf '%s\n' "$VERSION" > "$ROOT/current.txt.tmp"
mv -f "$ROOT/current.txt.tmp" "$ROOT/current.txt"
for d in "$ROOT"/versions/*; do
  n="$(basename "$d")"
  [ "$n" = "$VERSION" ] || [ "$n" = "$PREVIOUS" ] || rm -rf "$d"
done
if [ -n "$PREVIOUS" ] && [ "$PREVIOUS" != "$VERSION" ]; then
  printf '{"state":"ok","version":"%s","previous":"%s"}\n' "$VERSION" "$PREVIOUS" > "$ROOT/update-state.json"
else
  printf '{"state":"ok","version":"%s"}\n' "$VERSION" > "$ROOT/update-state.json"
fi

mkdir -p "$BIN" "$APPS" "$ICONS"
ln -sf "$ROOT/hivedesk" "$BIN/hivedesk"
cp "$ROOT/versions/$VERSION/hivedesk.png" "$ICONS/hivedesk.png" 2>/dev/null || true
cat > "$APPS/hivedesk.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=hivedesk
Comment=Your agents. Your machines. Your City.
Exec="$ROOT/hivedesk" %U
Icon=hivedesk
Terminal=false
Categories=Development;
StartupWMClass=hivedesk
DESKTOP
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS" >/dev/null 2>&1 || true

say "installed in $ROOT"
say "open it from the app menu, or run: $BIN/hivedesk"
case ":$PATH:" in *":$BIN:"*) ;; *) say "(add $BIN to your PATH to run hivedesk from a terminal)" ;; esac
say "the window needs WebKitGTK 4.1, for example: sudo apt install libwebkit2gtk-4.1-0"
