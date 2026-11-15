# Touch-probe fixture app

A one-screen iOS simulator app for the foldable slow test (#1535). It draws a
red dot where it is touched and appends the touch's fraction of its window to
`Documents/touches.txt`, one `x y` line per touch, so a test reads where a tap
landed. The built app is committed so a test installs it without building.

Its own source, MIT: `ios/src/main.swift` and `ios/Info.plist`.

## Build commands

```bash
# from e2e/fixtures/touch-probe/ (needs Xcode; arm64 simulators only)
rm -rf ios/TouchProbe.app && mkdir ios/TouchProbe.app
xcrun --sdk iphonesimulator swiftc -target arm64-apple-ios16.0-simulator -O \
  -o ios/TouchProbe.app/TouchProbe ios/src/main.swift
cp ios/Info.plist ios/TouchProbe.app/Info.plist
codesign --force --sign - ios/TouchProbe.app
```

## App id

`com.callstack.simlock.touchprobe`

## Reading a touch

```bash
xcrun simctl --set <device set> get_app_container <udid> com.callstack.simlock.touchprobe data
# -> <container>/Documents/touches.txt
```

## Notes

- Any orientation (the inner panel of a Duo is wider than tall), iPhone family, unsigned except for the ad hoc signature the
  simulator accepts.
- Built with Xcode 27 (Swift 6.4).
