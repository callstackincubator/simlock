#!/bin/zsh
# Builds DeviceStreamPoC.app next to this script. Requires Xcode 27 (CoreDevice 642.x) on macOS 26.
set -euo pipefail
cd "$(dirname "$0")"
PF=/Library/Developer/PrivateFrameworks
APP=build/DeviceStreamPoC.app
rm -rf build && mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp Info.plist "$APP/Contents/Info.plist"
xcrun clang -fobjc-arc -c Sources/MediaBridge.m -o build/MediaBridge.o
# why: the private enum stubs intentionally omit cases. Optimizing clients can treat
# them as uninhabited (CodableValue traps in Dictionary.compactMapValues).
# Keep this reverse-engineering demo unoptimized, like the proven CLI probe.
xcrun swiftc -Onone -g -I Stubs -module-cache-path build/module-cache -import-objc-header Sources/MediaBridge.h \
  -o "$APP/Contents/MacOS/DeviceStreamPoC" \
  Sources/*.swift build/MediaBridge.o \
  "$PF/CoreDevice.framework/Versions/A/CoreDevice" \
  "$PF/CoreDeviceUtilities.framework/Versions/A/CoreDeviceUtilities" \
  "$PF/CoreDevice.framework/Versions/A/Frameworks/CoreDeviceMediaStreamSupport.framework/Versions/A/CoreDeviceMediaStreamSupport"
codesign --force --sign - "$APP"
echo "built $APP"
