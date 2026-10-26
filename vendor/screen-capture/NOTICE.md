# Vendored: serve-sim's capture and encoder

A Swift package holding two programs that stream one device's screen: a
simulator's framebuffer, and a physical iPhone's media stream. The capture
pipeline and the encoders behind the simulator program came from **serve-sim** —
the encoders rewritten here, but still serve-sim's files modified; the process
around them — the CLI, the envelope, the lifecycle, the build — is ours. The
iPhone program is ours entirely, but for one HEVC capability string from
**idevice** (MIT), recorded under "What is ours". Where exactly the line sits is
per file, below.

## Upstream

|                                     |                                                                                                |
| ----------------------------------- | ---------------------------------------------------------------------------------------------- |
| Repository                          | <https://github.com/EvanBacon/serve-sim> (npm `serve-sim`, `@expo/serve-sim`)                  |
| Author                              | Evan Bacon                                                                                     |
| Commit vendored from                | `6d009686ed08f7d8bd19bca9f9f67a9237931f44` (2026-10-11)                                        |
| License                             | Apache-2.0, verbatim: [`LICENSES/serve-sim.APACHE-2.0.txt`](LICENSES/serve-sim.APACHE-2.0.txt) |
| Copyright, per the license appendix | `Copyright 2026 Evan Bacon`                                                                    |

Upstream ships no `NOTICE` file, so Apache §4(d) is vacuous here, and none of the
files we took carries a per-file license header, so §4(c) has no per-file text to
retain. §4(b) asks every file we modified to say so prominently: each of the six
below that is not upstream's unchanged — `FrameCapture.swift`, `HIDInjector.swift`
and the four we rewrote — opens with a `MODIFIED FILE` header naming serve-sim, its license and
this notice. The license text in `LICENSES/` is upstream's root `LICENSE`, byte for
byte; it is named for the project it covers rather than plain `LICENSE` because
this directory also holds code of ours that the file does not license.

The four files this directory carries as upstream wrote them — unchanged, or with
one patch — are 586 lines as of that commit (`FrameCapture` 436, `FramebufferSurfaceSelector` 77, `DeviceDisplaySizes`
48, `SimFrameworks` 25) — a figure that cannot drift, because it is a property of an
immutable commit. Origin is per file, below, and the exact command to measure it is
under "The diff against upstream is the early warning". This notice deliberately
carries no count of our _own_ lines: a stale count still reads as a fact.

## Where every file came from

The four files serve-sim wrote as they are — unchanged or with one patch — and
the four it wrote that we rewrote all live in two directories: the simulator
source files under `Sources/simlock-screen-capture/`, and the four encoders under
`Sources/SimlockCapture/` (the shared library both programs build on, which is
otherwise all ours). Upstream keeps the same files in two targets,
`Sources/SimNative/` and `Sources/SimNativeSupport/`, and their paths are given
per row.

| File                                                                                | Upstream path               | Origin                                                                                                                                                      |
| ----------------------------------------------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `simlock-screen-capture/SimFrameworks.swift`                                        | `Sources/SimNative/`        | theirs, unchanged                                                                                                                                           |
| `simlock-screen-capture/FramebufferSurfaceSelector.swift`                           | `Sources/SimNativeSupport/` | theirs, unchanged                                                                                                                                           |
| `simlock-screen-capture/DeviceDisplaySizes.swift`                                   | `Sources/SimNativeSupport/` | theirs, unchanged                                                                                                                                           |
| `simlock-screen-capture/FrameCapture.swift`                                         | `Sources/SimNative/`        | theirs, **one patch** (deviation 1)                                                                                                                         |
| `simlock-screen-capture/HIDInjector.swift`                                          | `Sources/SimNative/`        | theirs, **modified by us** — Apache-2.0, `MODIFIED FILE` header; the Duo, Device Hub, pose, Home, app switcher and Lock paths are deleted (deviation 3)     |
| `SimlockCapture/H264Encoder.swift`                                                  | `Sources/SimNative/`        | theirs, **rewritten by us** — a modified file, Apache-2.0, `MODIFIED FILE` header                                                                           |
| `SimlockCapture/VideoEncoder.swift`                                                 | `Sources/SimNative/`        | theirs, **rewritten by us** — a modified file, Apache-2.0, `MODIFIED FILE` header                                                                           |
| `SimlockCapture/PixelBufferUtils.swift`                                             | `Sources/SimNative/`        | theirs, **rewritten by us** — a modified file, Apache-2.0, `MODIFIED FILE` header                                                                           |
| `SimlockCapture/Xcode.swift`                                                        | `Sources/SimNative/`        | theirs, **rewritten by us** — a modified file, Apache-2.0, `MODIFIED FILE` header                                                                           |
| `simlock-screen-capture/InputMode.swift`                                            | —                           | ours, entirely: the `--input` mode that drives `HIDInjector` from stdin                                                                                     |
| `SimlockCapture/Lifecycle.swift`, `SimlockCapture/Options.swift`                    | —                           | ours, entirely: the option parser, the envelope, the lifecycle, the scaler, the encode loop                                                                 |
| `simlock-screen-capture/main.swift`, `simlock-screen-capture/SimulatorSource.swift` | —                           | ours, entirely: the simulator program and its framebuffer as a `ScreenSource`                                                                               |
| `simlock-device-capture/*` (five files)                                             | —                           | ours, entirely: the iPhone program — the version gate, the CoreDevice source, the RTP receiver, the decoder — rewritten from this repo's own PoC (ADR 0031) |
| `SimlockMediaBridge/*`                                                              | —                           | ours, entirely: the negotiator bridge; it carries the `idevice` HEVC feature string below                                                                   |
| `Stubs/*` (three interfaces)                                                        | —                           | ours, entirely: hand-written declarations for the parts of CoreDevice we call                                                                               |
| `scripts/unframe.mjs`                                                               | —                           | ours, entirely: a hand-run diagnostic                                                                                                                       |
| `Package.swift`                                                                     | —                           | ours, entirely                                                                                                                                              |

To diff any of the nine serve-sim files, use the command at the end with the
upstream path from its row and the file's path under `Sources/`.

Four files were rewritten rather than copied, and they are still serve-sim's files,
modified: each was written from upstream's file of the same name, so each carries the
`MODIFIED FILE` header and stays under Apache-2.0, not under our MIT. All four use
only public Apple API — VideoToolbox, CoreVideo, CoreMedia, ImageIO, Foundation —
which is what made rewriting them possible at all, and it is why they carry none of
the breakage risk this notice is mostly about. The rewrite kept the wire contract
byte-identical on purpose: the H.264 payload is still AVCC, the description frame is
still an `avcC` record, and on a live capture the `description` payload came out the
same bytes before and after. What a rewrite cannot survive is the diff below
reporting a small comparison for those four, so read that section for which files it
still means.

`Xcode.swift` shows why the four are not claimed as ours: it wraps
`xcode-select -p` in a `Process`, and any rewrite of that converges on the same few
calls, with the same fallback path. A rewrite made with upstream's file open is a
derivative of it however different the diff looks, so treating all four as modified
Apache-2.0 files is the position that needs no argument.

Three files were taken and later removed as dead weight, each still byte-identical
to upstream when removed, and nothing in our build reached any of them:
`Sources/SimNative/StreamFormat.swift` (our `main.swift` writes the same envelope
itself), `Sources/SimNativeSupport/DeviceHubKeyboardRouting.swift` and
`Sources/SimNativeSupport/DevicePose.swift`.

## What upstream has that we did not take

The whole of serve-sim's NodeAPI binding and everything behind it: the
node-swift module `sim-module.swift`, the HID injection and accessibility
bridges (`AccessibilityBridge.swift`, `DeviceHubKeyboardBridge.swift`,
`DuoHIDBridge.swift`; `HIDInjector.swift` was taken in part, deviation 3), the capture orchestration
we replaced with `main.swift` (`CaptureEngine.swift`), the Duo hardware renderer
(`SimDuoRenderer/*`), the Objective-C camera, accessibility and HID helpers
(`SimCameraInjector/*`, `SimCameraHelper/*`, `SimAXSettings/*`, `SimDuoHID/*`),
and all of serve-sim's TypeScript server and preview UI. simlock needs one thing
from serve-sim: the framebuffer of a device nobody is looking at, encoded.

## Deviations

Four that change behaviour, all deliberate. Each is here because a later reader
must not "clean up" back to upstream's behaviour and silently break a simlock
feature. The mechanical consequences of the package layout — the files not taken,
the import that went away — are named where they show up, not counted here.

**1. `FrameCapture.findSimDevice` searches the device set named by
`SIMLOCK_IOS_DEVICE_SET`.** serve-sim looks devices up in CoreSimulator's default
set only. simlock boots every simulator into its own `simctl --set` root
([ADR 0001](../../docs/internal/adr/0001-simlock-owned-device-roots.md)), so a
simlock device's UDID is not in the default set and unpatched serve-sim answers
`Device <UDID> not found` for a simulator that is demonstrably booted.
CoreSimulator has no environment variable that moves its default set, so the set
has to be named in the lookup: with the variable set, the patch calls
`SimServiceContext deviceSetWithPath:error:` instead of
`defaultDeviceSetWithError:`.

The patch's own comment in `FrameCapture.swift` says the same, and is the
authoritative wording for it.

**2. There is no node-swift binding.** serve-sim exposes its capture as a
NodeAPI module through `sim-module.swift`, the only file of its package that
needs node-swift. We do not embed a Node module: the program writes frames to
stdout, so the daemon supervises a capture exactly as it supervises every other
tool it runs, and `sim-module.swift` was never taken.

**3. `HIDInjector.swift` is serve-sim's file without the paths simlock does not
use or does elsewhere.** The Duo hinge and cover paths (`DuoHIDBridge`), the Device
Hub keyboard bridge (`DeviceHubKeyboardBridge`), the fold pose (`DevicePose`) and the
`home`, `app_switcher` and `lock` buttons are deleted. Home is the daemon's
`xcrun simctl --set <set> launch <udid> com.apple.springboard` (`src/drivers/ios/input/`),
the way upstream does it on Xcode 26 and later ("Xcode 26+ silently drops the Indigo
HID home-button press"), so it has one owner; the app switcher and Lock are Indigo
button presses and are out of scope (#1024). Touch, scroll, key and the rest are
upstream's. The file's own `MODIFIED FILE` header is the authoritative wording.

**4. `FrameCapture.nativeScreenSizes(for:)` is internal, not private.** The input
mode reads the device type's native pixel size from it, because
`getScreenSize` answers only once frames arrive and the input mode captures none.

One mechanical consequence of flattening two upstream targets into one:
`FrameCapture.swift` and `HIDInjector.swift` no longer say `import SimNativeSupport`, because there is
no second target to import. Nothing else differs.

## The maintenance risk, and the escape hatch

The reason this file is longer than a license note: the program reaches into
private Apple frameworks, and an Xcode major version is what breaks that.

`SimFrameworks.swift` `dlopen`s `CoreSimulator.framework` and
`SimulatorKit.framework` from candidate paths — SimulatorKit moved from
`Library/PrivateFrameworks` to `SharedFrameworks` in Xcode 27, which is why both
spellings are tried — and nothing is linked or imported. Every private member is
reached through the Objective-C runtime. The surface, measured off our own
sources:

| Reached by  | Member                                                                | Declared in `facebook/idb` at `66c6f7bb98324212dcf047dc7330048303b0163d`                          |
| ----------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| selector    | `SimServiceContext sharedServiceContextForDeveloperDir:error:`        | `PrivateHeaders/CoreSimulator/SimServiceContext.h`                                                |
| selector    | `defaultDeviceSetWithError:`                                          | same                                                                                              |
| selector    | `deviceSetWithPath:error:`                                            | same                                                                                              |
| selector    | `SimDevice io`                                                        | `PrivateHeaders/CoreSimulator/SimDevice.h`                                                        |
| selector    | `SimDevice deviceType`                                                | same                                                                                              |
| selector    | `updateIOPorts`                                                       | `PrivateHeaders/CoreSimulator/SimDeviceIOClient.h`                                                |
| selector    | `SimDeviceIOPort descriptor`                                          | `PrivateHeaders/CoreSimDeviceIO/SimDeviceIOPortInterface-Protocol.h`                              |
| selector    | `framebufferSurface`                                                  | `PrivateHeaders/CoreSimDeviceIO/SimDisplayIOSurfaceRenderable-Protocol.h`, `SimScreen-Protocol.h` |
| selector    | `unregisterScreenCallbacksWithUUID:`                                  | `PrivateHeaders/CoreSimDeviceIO/SimScreen-Protocol.h`                                             |
| selector    | `registerScreenCallbacksWithUUID:…`, via an `@objc` protocol          | same                                                                                              |
| selector    | `SimDeviceType mainScreenSize`                                        | `PrivateHeaders/CoreSimulator/SimDeviceType.h`                                                    |
| selector    | `portIdentifier`                                                      | **not declared there**                                                                            |
| KVC         | `SimDevice UDID`, `stateString`                                       | `PrivateHeaders/CoreSimulator/SimDevice.h`                                                        |
| KVC         | `SimDeviceSet devices`                                                | `PrivateHeaders/CoreSimulator/SimDeviceSet.h`                                                     |
| KVC         | `SimDeviceIOClient deviceIOPorts`                                     | `PrivateHeaders/CoreSimulator/SimDeviceIOClient.h`                                                |
| KVC         | `SimDeviceType bundlePath`, `bundleURL`                               | **not declared there** (`idb` declares `bundle` only)                                             |
| class       | `NSClassFromString("SimServiceContext")`                              | `PrivateHeaders/CoreSimulator/SimServiceContext.h`                                                |
| file schema | `Contents/Resources/capabilities.plist` inside a device type's bundle | **not declared there**, and undocumented by Apple                                                 |

That is, for the framebuffer path, twenty distinct private members: twelve selectors, six key-value-coding
keys, one class name and one plist schema. `facebook/idb` is MIT-licensed, and
sixteen of the twenty are declared in its `PrivateHeaders/CoreSimulator/` and
`PrivateHeaders/CoreSimDeviceIO/`.
That cross-reference is the escape hatch: when Apple moves or removes one of
them, idb is an independently maintained MIT source to re-read the declaration
from, including the comments there that record which Xcode versions had which
shape (`SimScreen-Protocol.h` and `SimDisplayIOSurfaceRenderable-Protocol.h` in
particular carry that history). The headers are at the root of that repository,
so one fetch reads any of them:

```sh
curl -sL https://raw.githubusercontent.com/facebook/idb/main/PrivateHeaders/CoreSimulator/SimServiceContext.h
curl -sL https://raw.githubusercontent.com/facebook/idb/main/PrivateHeaders/CoreSimDeviceIO/SimScreen-Protocol.h
```

The input mode (`HIDInjector.swift`) reaches a second surface the same way, as
serve-sim's code does and without a second source cross-referenced here:
`SimDeviceLegacyHIDClient` (`initWithDevice:error:`,
`sendWithMessage:freeWhenDone:completionQueue:completion:`), found with
`NSClassFromString` and `class_getMethodImplementation`, and the `IndigoHIDMessageFor…`
C functions (`MouseNSEvent`, `Button`, `HIDArbitrary`, `KeyboardArbitrary`,
`DigitalCrownEvent`), found with `dlsym`. The re-read when Apple moves one is the same
diff of this file against upstream.

What is _not_ in idb is the other half of the story, and it is where a break will
land first: `portIdentifier`, the `bundlePath`/`bundleURL` pair on
`SimDeviceType`, and the `capabilities.plist` schema. Those have no second
source, which is why `DeviceDisplaySizes.swift` treats a missing or unexpected
plist as "fall back to `SimDeviceType.mainScreenSize`" rather than as an error.

## The diff against upstream is the early warning

A private API that Apple changed shows up as a line upstream no longer has, or a
line upstream changed under us. The only way to see that cheaply is to diff our
copy against pristine upstream at the commit above, so: **do not commit pristine
copies.** One source file with two homes is a file somebody will edit in the wrong
one. Fetch instead, and diff (from this directory, so the relative paths resolve):

```sh
curl -sL https://raw.githubusercontent.com/EvanBacon/serve-sim/6d009686ed08f7d8bd19bca9f9f67a9237931f44/packages/serve-sim/Sources/SimNative/FrameCapture.swift \
  | diff -u - Sources/simlock-screen-capture/FrameCapture.swift
```

That prints five things and nothing else — the `MODIFIED FILE` header Apache §4(b)
asks for, the device-set patch, the `private` that became internal on
`nativeScreenSizes`, the deleted `import SimNativeSupport`, and the
`import SimlockCapture` that replaced it — which is the whole claim of this notice
in one screenful. If that diff ever grows past those
five, either someone edited upstream's capture logic or Apple moved something
upstream, and both deserve to be noticed rather than committed. For any other file
in the table, substitute its upstream path in both places — for the four rewritten
ones it prints a whole-file rewrite, which is what their rows say:

```sh
UPSTREAM=packages/serve-sim/Sources/SimNative/SimFrameworks.swift   # or SimNativeSupport/…
LOCAL=Sources/simlock-screen-capture/SimFrameworks.swift   # the encoders live in Sources/SimlockCapture/
curl -sL "https://raw.githubusercontent.com/EvanBacon/serve-sim/6d009686ed08f7d8bd19bca9f9f67a9237931f44/$UPSTREAM" \
  | diff -u - "$LOCAL"
```

Run it before and after an Xcode upgrade, and again before taking anything new
from upstream. A file whose diff grows by lines nobody wrote is the notification
that something moved.

This is the reason not to rewrite a private-API file — and a rewrite would not
escape the license anyway, as the four above show: for the four files we did rewrite the comparison above stops being a detector, because a
whole-file diff can no longer tell you that Apple moved something. That is safe
here and only here — those four touch no private API, so they are not where an Xcode
major bites. For `FrameCapture.swift` and the other three upstream files the
detector still works, and losing it there would mean losing the only cheap warning
this program has.

Upstream's license text, to compare with the copy in `LICENSES/`:

```sh
curl -sL https://raw.githubusercontent.com/EvanBacon/serve-sim/6d009686ed08f7d8bd19bca9f9f67a9237931f44/LICENSE \
  | diff -u - LICENSES/serve-sim.APACHE-2.0.txt
```

Both fetches name the commit in the URL, so a stale upstream is impossible: the
URL either returns that commit's bytes or fails.

## What is ours

`Package.swift`, `NOTICE.md` and the `LICENSES/` entries' file names,
`scripts/unframe.mjs`, the whole of `Sources/SimlockCapture/` but for the four
encoder files (`Lifecycle.swift` and `Options.swift`: the option parser, the
envelope, the lifecycle, the scaler, the encode loop), both programs'
`main.swift`, `Sources/simlock-screen-capture/SimulatorSource.swift` and
`Sources/simlock-screen-capture/InputMode.swift`, the
whole of `Sources/simlock-device-capture/` and `Sources/SimlockMediaBridge/`,
and the three interfaces under `Stubs/`. Everything else is serve-sim's: three
files unchanged, `FrameCapture.swift` with the patches above, `HIDInjector.swift`
with its deletions, and the four rewritten files, which are serve-sim's files modified by us and are Apache-2.0
like the rest of serve-sim's code here.

### idevice (MIT): the HEVC capability string

`SimlockMediaBridge/SimlockMediaBridge.m` replaces the feature string the offer
advertises for payload 100 (HEVC) with:

```text
FLS;MS:-1;LF:-1;LTR;CABAC;POS:0;EOD:1;HTS:2;RR:3;AR:16/9,5/8;XR:16/9,5/8;
```

That string is from the **idevice** project — <https://github.com/jkcoxson/idevice>
(`master`, `3854a5df4a5a6dee71ffce4d8befc2ea356a8065` when taken), MIT,
`Copyright 2026 Jackson Coxson`, verbatim:
[`LICENSES/idevice.MIT.txt`](LICENSES/idevice.MIT.txt), re-fetched with:

```sh
curl -sL https://raw.githubusercontent.com/jkcoxson/idevice/master/LICENSE.txt \
  | diff -u - LICENSES/idevice.MIT.txt
```

It is the receiver's documented standalone-decoder preset; every other spelling
the iPhone has been offered paints torn pictures. The file it lives in is
otherwise ours, and carrying one MIT string inside an MIT file needs no
relicensing — the notice above and the license file travel with it, which is all
the license asks.

Ours is under the project's MIT license, like the rest of this repository. That is
permitted rather than a relicensing: Apache-2.0 lets a licensee add its own terms to
its own modifications and to the derivative as a whole, provided the four §4
conditions still travel — the license text in `LICENSES/`, the change notices (the
`MODIFIED FILE` headers and the deviations above), and the attribution here. The
Apache-2.0 text covers the serve-sim code this directory carries, our rewrites of
four of its files included, and nothing else in it. Whether MIT and Apache-2.0
should be stated as one combined license for this directory or kept as two explicit
layers is a legal judgement, and this notice deliberately does the second: it names
which file licenses which bytes, so nobody has to guess what shipping this directory
obliges us to.
