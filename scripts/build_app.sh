#!/usr/bin/env bash
# Build "Analog Brick.app" into ./build. Requires macOS 13+ with Xcode or the Command Line Tools.
#
#   scripts/build_app.sh              # release build for this Mac's architecture
#   UNIVERSAL=1 scripts/build_app.sh  # arm64 + x86_64 (needs full Xcode)
#   CONFIG=debug scripts/build_app.sh
#   SIGN_IDENTITY="Developer ID Application: …" scripts/build_app.sh   # instead of ad-hoc signing
set -euo pipefail
cd "$(dirname "$0")/.."

CONFIG="${CONFIG:-release}"
APP_NAME="Analog Brick"
APP="build/${APP_NAME}.app"
SIGN_IDENTITY="${SIGN_IDENTITY:--}"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "error: the app can only be built on macOS (BrickCore tests run anywhere: swift test)" >&2
  exit 1
fi

echo "▸ Compiling (${CONFIG})"
if [[ "${UNIVERSAL:-0}" == "1" ]]; then
  swift build -c "$CONFIG" --arch arm64 --arch x86_64 --product AnalogBrick
  BIN_DIR="$(swift build -c "$CONFIG" --arch arm64 --arch x86_64 --show-bin-path)"
else
  swift build -c "$CONFIG" --product AnalogBrick
  BIN_DIR="$(swift build -c "$CONFIG" --show-bin-path)"
fi

echo "▸ Assembling ${APP}"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$APP/Contents/Library/LaunchAgents"
cp "$BIN_DIR/AnalogBrick" "$APP/Contents/MacOS/AnalogBrick"
cp resources/Info.plist "$APP/Contents/Info.plist"
cp resources/com.analogbrick.AnalogBrick.resume.plist "$APP/Contents/Library/LaunchAgents/"
rsync -a --delete --exclude '.DS_Store' web/ "$APP/Contents/Resources/web/"

if [[ -f resources/AppIcon-1024.png ]]; then
  echo "▸ Icon"
  ICONSET="build/AppIcon.iconset"
  rm -rf "$ICONSET" && mkdir -p "$ICONSET"
  for size in 16 32 128 256 512; do
    sips -z $size $size resources/AppIcon-1024.png --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
    double=$((size * 2))
    sips -z $double $double resources/AppIcon-1024.png --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
  done
  iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"
  rm -rf "$ICONSET"
fi

echo "▸ Signing (${SIGN_IDENTITY})"
if [[ "$SIGN_IDENTITY" == "-" ]]; then
  codesign --force --deep --sign - --entitlements resources/AnalogBrick.entitlements "$APP"
else
  codesign --force --deep --options runtime --timestamp --sign "$SIGN_IDENTITY" --entitlements resources/AnalogBrick.entitlements "$APP"
fi
codesign --verify --deep --strict "$APP"

echo "✓ Built ${APP}"
echo "  Run it:      open \"${APP}\""
echo "  Install it:  cp -R \"${APP}\" /Applications/"
