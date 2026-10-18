#!/bin/sh
# Builds hivedesk-macos.dmg: the app, a link to Applications, the brand background with the first launch
# steps, the volume icon and "Read me first.txt". macOS only (hdiutil, Finder for the window layout).
#   desktop/installer/macos/make-dmg.sh <hivedesk.app> <out.dmg> <version>
set -eu
APP="$1"; OUT="$2"; VERSION="$3"
HERE="$(cd "$(dirname "$0")" && pwd)"
ICNS="$HERE/../../icons/hivedesk.icns"
VOL="hivedesk"
WORK="$(mktemp -d)"
STAGE="$WORK/stage"
RW="$WORK/rw.dmg"
mkdir -p "$STAGE/.background"
ditto "$APP" "$STAGE/hivedesk.app"
ln -s /Applications "$STAGE/Applications"
tiffutil -cathidpicheck "$HERE/background.png" "$HERE/background@2x.png" -out "$STAGE/.background/background.tiff"
sed "s/@VERSION@/$VERSION/" "$HERE/Read me first.txt" > "$STAGE/Read me first.txt"
cp "$ICNS" "$STAGE/.VolumeIcon.icns"
SIZE_MB=$(( $(du -sm "$STAGE" | cut -f1) + 60 ))
hdiutil create -srcfolder "$STAGE" -volname "$VOL" -fs HFS+ -fsargs "-c c=64,a=16,e=16" -format UDRW -size "${SIZE_MB}m" "$RW"
DEV="$(hdiutil attach -readwrite -noverify -noautoopen "$RW" | awk '/Apple_HFS/ { print $1; exit }')"
MNT="/Volumes/$VOL"
# The volume icon.
if command -v SetFile >/dev/null 2>&1; then SetFile -a C "$MNT" || true; fi
# The window: icon view, the background, the two icons over their slots, the readme below the fold.
layout() {
  osascript <<OSA
tell application "Finder"
  tell disk "$VOL"
    open
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set the bounds of container window to {200, 120, 860, 588}
    set opts to the icon view options of container window
    set arrangement of opts to not arranged
    set icon size of opts to 112
    set text size of opts to 13
    set background picture of opts to file ".background:background.tiff"
    set position of item "hivedesk.app" of container window to {165, 215}
    set position of item "Applications" of container window to {495, 215}
    set position of item "Read me first.txt" of container window to {330, 620}
    close
    open
    update without registering applications
    delay 2
    close
  end tell
end tell
OSA
}
if ! layout; then echo "make-dmg: Finder layout failed; the DMG works, without the designed window" >&2; fi
chmod -Rf go-w "$MNT" || true
sync
hdiutil detach "$DEV" -quiet || hdiutil detach "$DEV" -force
rm -f "$OUT"
hdiutil convert "$RW" -format ULFO -o "$OUT"
rm -rf "$WORK"
echo "make-dmg: $OUT"
