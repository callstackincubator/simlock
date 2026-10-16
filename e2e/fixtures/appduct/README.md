# Appduct playground fixture apps

Two built apps for the agent-device slow tests (#477): an iOS simulator build
and an Android debug build of Appduct's native playground. They are committed
so a test installs them without building an app or downloading anything.

Repo: https://github.com/callstackincubator/appduct
Commit: `0e68131bdd4b8a789314812caf1995b496c52ae9`

The commit is the tag `v0.15.0`. Both apps are built from it.

## Build commands

```bash
# iOS, from playground-native/ios at the pin (needs Xcode and xcodegen)
xcodegen generate
xcodebuild build -project AppductPlayground.xcodeproj -scheme AppductPlayground \
  -configuration Debug -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' -derivedDataPath build \
  ARCHS=arm64 CODE_SIGNING_ALLOWED=NO
# -> build/Build/Products/Debug-iphonesimulator/AppductPlayground.app

# Android, from playground-native/android at the pin (needs JDK 17 and ANDROID_HOME)
./gradlew :app:assembleDebug
# -> app/build/outputs/apk/debug/app-debug.apk, committed as AppductPlayground.apk
```

Where each output goes:

- `AppductPlayground.app` is copied whole to `ios/AppductPlayground.app/`.
- `app-debug.apk` is copied to `android/AppductPlayground.apk`.

## Tool versions of this build

- Xcode 27.0 (build 27A266a)
- xcodegen 2.45.4
- JDK 17 (Zulu), Gradle 8.14.3 (the wrapper's)
- Android SDK platform 35 (`compileSdk`)

## App ids

- iOS: `com.callstack.appduct.playgroundnative`
- Android: `com.callstack.appduct.playground`

## Screen ids

From Appduct's playground contract; #477 uses these: `tab-tools`,
`tab-status`, `connection-state`, `call-count`.

## Notes

- Both are debug builds, as Appduct's own device suite uses.
- The iOS build runs on arm64 simulators only (Apple silicon Macs). It is
  unsigned; the arm64 linker signs it ad hoc, which the simulator accepts.
- The Android build is signed with the builder's debug key.

## Files

| File                                                      | SHA-256                                                            |
| --------------------------------------------------------- | ------------------------------------------------------------------ |
| `android/AppductPlayground.apk`                           | `023e23a7f47f53c0b7914088b6f91d802212297faad126dadf1de81982d9f2a7` |
| `ios/AppductPlayground.app/AppductPlayground`             | `1d434163aab86e0266796e6fada8619c296193e086f84ddd1495290c4ba27fea` |
| `ios/AppductPlayground.app/AppductPlayground.debug.dylib` | `d4e2ef2949c1a1b27ee70bc79b23b40dd8b470bf98047372503f6c9dc1ee38ca` |
| `ios/AppductPlayground.app/Info.plist`                    | `444c14b8188fd231c52e4e3711ca681ec370ad1883d145e4ef6533c05e52dc90` |
| `ios/AppductPlayground.app/PkgInfo`                       | `82502191c9484b04d685374f9879a0066069c49b8acae7a04b01d38d07e8eca0` |
| `ios/AppductPlayground.app/__preview.dylib`               | `2b569eb3932de0d2908fa99589f9078d6d9abc5bea8c9fbf03d84980986dd287` |

## Refresh

1. Build at the new pin with the commands above.
2. Replace the files under `ios/` and `android/`.
3. Update the tag, the commit, the tool versions and the table above in the
   same commit.
4. Check by hand: `plutil -extract CFBundleIdentifier raw` on `Info.plist`,
   `lipo -info` on the executable, and `aapt dump badging` on the APK.
