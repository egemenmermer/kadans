#!/bin/bash
# Builds build/Kadans.app (menu bar shell) and copies it to ~/Applications/Kadans.app
# (KADANS_APPS_DIR overrides ~/Applications; `kadans setup` uses it).
# --no-install: build only, no copy.
# The repo path is baked into Info.plist (KadansRepo); KADANS_REPO overrides it at run time.
# KADANS_BAKE_REPO bakes another path (release builds: ~/.kadans/app/current). KADANS_SIGN_ID signs with that identity,
# hardened runtime and a secure timestamp instead of ad hoc (scripts/release-app.sh).
# k44 Sparkle (premium build only): when both KADANS_SPARKLE_FEED (appcast URL) and KADANS_SPARKLE_PUBKEY (EdDSA public
# key, base64) are set, Sparkle 2 is compiled in (KADANS_SPARKLE=1, own .build-sparkle dir), Sparkle.framework is embedded
# in Contents/Frameworks without its XPC services (Kadans is not sandboxed) and signed inside-out before the app, and
# Info.plist gets SUFeedURL, SUPublicEDKey and automatic daily checks and installs. Without both (the free build that
# `npx kadans setup` compiles) there is no Sparkle at all: nothing fetched, nothing linked, no SU* keys.
# KADANS_BUILD_NUMBER overrides CFBundleVersion (default: from package.json, major*10000 + minor*100 + patch).
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
APPS="${KADANS_APPS_DIR:-$HOME/Applications}"

# swift build is a heavy job: one at a time across trees.
mkdir -p "$HOME/.cache"
until mkdir "$LOCK" 2>/dev/null; do sleep 5; done
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT
SPARKLE=0
if [ -n "${KADANS_SPARKLE_FEED:-}" ] && [ -n "${KADANS_SPARKLE_PUBKEY:-}" ]; then SPARKLE=1; fi
if [ "$SPARKLE" = 1 ]; then
  SCRATCH="$ROOT/app/mac/.build-sparkle"
  (cd "$ROOT/app/mac" && KADANS_SPARKLE=1 swift build -c release --scratch-path "$SCRATCH" 2>&1 | tail -n 15)
else
  SCRATCH="$ROOT/app/mac/.build"
  (cd "$ROOT/app/mac" && env -u KADANS_SPARKLE swift build -c release 2>&1 | tail -n 15)
fi
rmdir "$LOCK"
trap - EXIT

BIN="$SCRATCH/release/Kadans"
[ -x "$BIN" ] || { echo "build-app: binary not found: $BIN" >&2; exit 1; }

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/Kadans"
cp -R "$ROOT/app/web" "$APP/Contents/Resources/web"
if [ "$SPARKLE" = 1 ]; then
  FW="$SCRATCH/release/Sparkle.framework"
  [ -d "$FW" ] || { echo "build-app: Sparkle.framework not found: $FW" >&2; exit 1; }
  mkdir -p "$APP/Contents/Frameworks"
  ditto "$FW" "$APP/Contents/Frameworks/Sparkle.framework" # keeps the Versions symlinks
  # Not sandboxed: Sparkle's Installer/Downloader XPC services are not needed.
  rm -rf "$APP/Contents/Frameworks/Sparkle.framework/Versions/B/XPCServices" "$APP/Contents/Frameworks/Sparkle.framework/XPCServices"
  install_name_tool -add_rpath "@executable_path/../Frameworks" "$APP/Contents/MacOS/Kadans"
fi

xml_escape() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
REPO_XML="$(printf '%s' "${KADANS_BAKE_REPO:-$ROOT}" | xml_escape)"
VERSION="$(node -p "require('$ROOT/package.json').version" 2>/dev/null || echo 0.1.0)"
BUILD="${KADANS_BUILD_NUMBER:-$(printf '%s' "$VERSION" | awk -F'[.-]' '{ printf "%d", $1 * 10000 + $2 * 100 + $3 }')}"
case "$BUILD" in ''|*[!0-9]*) echo "build-app: bad build number: $BUILD" >&2; exit 2 ;; esac
SPARKLE_KEYS=""
if [ "$SPARKLE" = 1 ]; then
  FEED_XML="$(printf '%s' "$KADANS_SPARKLE_FEED" | xml_escape)"
  PUB_XML="$(printf '%s' "$KADANS_SPARKLE_PUBKEY" | xml_escape)"
  SPARKLE_KEYS="  <key>SUFeedURL</key><string>$FEED_XML</string>
  <key>SUPublicEDKey</key><string>$PUB_XML</string>
  <key>SUEnableAutomaticChecks</key><true/>
  <key>SUAutomaticallyUpdate</key><true/>
  <key>SUScheduledCheckInterval</key><integer>86400</integer>
  <key>SUVerifyUpdateBeforeExtraction</key><true/>"
fi

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
  <key>CFBundleVersion</key><string>$BUILD</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>KadansRepo</key><string>$REPO_XML</string>
$SPARKLE_KEYS
</dict>
</plist>
EOF
plutil -lint "$APP/Contents/Info.plist" >/dev/null

# Inside-out: Sparkle's helpers, then the framework, then the app (never --deep for signing).
if [ -n "${KADANS_SIGN_ID:-}" ]; then
  SIGN=(codesign --force --options runtime --timestamp -s "$KADANS_SIGN_ID")
else
  SIGN=(codesign --force -s -)
fi
if [ "$SPARKLE" = 1 ]; then
  SFW="$APP/Contents/Frameworks/Sparkle.framework"
  "${SIGN[@]}" "$SFW/Versions/B/Autoupdate"
  "${SIGN[@]}" "$SFW/Versions/B/Updater.app"
  "${SIGN[@]}" "$SFW"
fi
"${SIGN[@]}" "$APP"
if [ -n "${KADANS_SIGN_ID:-}" ]; then
  codesign --verify --deep --strict "$APP"
else
  codesign --verify --deep "$APP"
fi

if [ "$INSTALL" = 0 ]; then
  echo "built $APP (repo: ${KADANS_BAKE_REPO:-$ROOT}, build $BUILD, sparkle: $([ "$SPARKLE" = 1 ] && echo on || echo off)); not installed (--no-install)"
  exit 0
fi
mkdir -p "$APPS"
rm -rf "$APPS/Kadans.app"
cp -R "$APP" "$APPS/Kadans.app"
echo "built $APP (repo: $ROOT); copied to $APPS/Kadans.app"
