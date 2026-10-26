#!/bin/bash
# Builds build/Kadans.app (menu bar shell) and copies it to ~/Applications/Kadans.app.
# --no-install: build only, no copy to ~/Applications.
# The repo path is baked into Info.plist (KadansRepo); KADANS_REPO overrides it at run time.
# Nothing here starts at login: no login item, no launch agent.
set -euo pipefail

INSTALL=1
for arg in "$@"; do
  case "$arg" in
    --no-install) INSTALL=0 ;;
    *) echo "build-app: unknown option: $arg (only --no-install)" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/build/Kadans.app"
LOCK="$HOME/.cache/kadans-heavy"

# swift build is a heavy job: one at a time across trees.
mkdir -p "$HOME/.cache"
until mkdir "$LOCK" 2>/dev/null; do sleep 5; done
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT
(cd "$ROOT/app/mac" && swift build -c release 2>&1 | tail -n 15)
rmdir "$LOCK"
trap - EXIT

BIN="$ROOT/app/mac/.build/release/Kadans"
[ -x "$BIN" ] || { echo "build-app: binary not found: $BIN" >&2; exit 1; }

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/Kadans"
cp -R "$ROOT/app/web" "$APP/Contents/Resources/web"

xml_escape() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
REPO_XML="$(printf '%s' "$ROOT" | xml_escape)"
VERSION="$(node -p "require('$ROOT/package.json').version" 2>/dev/null || echo 0.1.0)"

cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>Kadans</string>
  <key>CFBundleIdentifier</key><string>dev.kadans.app</string>
  <key>CFBundleName</key><string>Kadans</string>
  <key>CFBundleDisplayName</key><string>Kadans</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>KadansRepo</key><string>$REPO_XML</string>
</dict>
</plist>
EOF
plutil -lint "$APP/Contents/Info.plist" >/dev/null

codesign --force -s - "$APP"
codesign --verify "$APP"

if [ "$INSTALL" = 0 ]; then
  echo "built $APP (repo: $ROOT); not installed (--no-install)"
  exit 0
fi
mkdir -p "$HOME/Applications"
rm -rf "$HOME/Applications/Kadans.app"
cp -R "$APP" "$HOME/Applications/Kadans.app"
echo "built $APP (repo: $ROOT); copied to $HOME/Applications/Kadans.app"
