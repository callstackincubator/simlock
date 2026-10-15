# Vendored: serve-sim's capture and encoder

A Swift package that streams the framebuffer of one booted iOS Simulator. The
capture pipeline came from **serve-sim**; the encoder, the process around it — the
CLI, the envelope, the build — is ours. Where exactly the line sits is per file,
below.

## Upstream

| | |
|---|---|
| Repository | <https://github.com/EvanBacon/serve-sim> (npm `serve-sim`, `@expo/serve-sim`) |
| Author | Evan Bacon |
| Commit vendored from | `6d009686ed08f7d8bd19bca9f9f67a9237931f44` (2026-10-11) |
| License | Apache-2.0, verbatim: [`LICENSES/serve-sim.APACHE-2.0.txt`](LICENSES/serve-sim.APACHE-2.0.txt) |
| Copyright, per the license appendix | `Copyright 2026 Evan Bacon` |

Upstream ships no `NOTICE` file, so Apache §4(d) is vacuous here, and none of the
files we took carries a per-file license header, so §4(c) has no per-file text to
retain. The license text in `LICENSES/` is upstream's root `LICENSE`, byte for
byte; it is named for the project it covers rather than plain `LICENSE` because
this directory also holds code of ours that the file does not license.

The four upstream files this directory still carries are 586 lines as of that
commit (`FrameCapture` 436, `FramebufferSurfaceSelector` 77, `DeviceDisplaySizes`
48, `SimFrameworks` 25) — a figure that cannot drift, because it is a property of an
immutable commit. Origin is per file, below, and the exact command to measure it is
under "The diff against upstream is the early warning". This notice deliberately
carries no count of our *own* lines: a stale count still reads as a fact.

## Where every file came from

Our target is one flat directory, `Sources/simlock-screen-capture/`; upstream
keeps the same files in two targets, `Sources/SimNative/` and
`Sources/SimNativeSupport/`, and their paths are given per row.

| File in `Sources/simlock-screen-capture/` | Upstream path | Origin |
|---|---|---|
| `SimFrameworks.swift` | `Sources/SimNative/` | theirs, unchanged |
| `Xcode.swift` | `Sources/SimNative/` | theirs, unchanged |
| `FramebufferSurfaceSelector.swift` | `Sources/SimNativeSupport/` | theirs, unchanged |
| `DeviceDisplaySizes.swift` | `Sources/SimNativeSupport/` | theirs, unchanged |
| `FrameCapture.swift` | `Sources/SimNative/` | theirs, **one patch** (deviation 1) |
| `H264Encoder.swift` | `Sources/SimNative/` | **ours**, rewritten from upstream's |
| `VideoEncoder.swift` | `Sources/SimNative/` | **ours**, rewritten from upstream's |
| `PixelBufferUtils.swift` | `Sources/SimNative/` | **ours**, rewritten from upstream's |
| `Xcode.swift` | `Sources/SimNative/` | **ours**, rewritten from upstream's |
| `main.swift` | — | ours, entirely: the CLI, the frame envelope, the lifecycle |
| `scripts/unframe.mjs` | — | ours, entirely: a hand-run diagnostic |
| `Package.swift` | — | ours, entirely |

Four files are ours because they were rewritten rather than copied. All four use
only public Apple API — VideoToolbox, CoreVideo, CoreMedia, ImageIO, Foundation —
which is what made rewriting them possible at all, and it is why they carry none of
the breakage risk this notice is mostly about. The rewrite kept the wire contract
byte-identical on purpose: the H.264 payload is still AVCC, the description frame is
still an `avcC` record, and on a live capture the `description` payload came out the
same bytes before and after. What a rewrite cannot survive is the diff below
reporting a small comparison for those four, so read that section for which files it
still means.

`Xcode.swift` is the weakest provenance claim of the four, and saying so is the
honest thing: it wraps `xcode-select -p` in a `Process`, and any rewrite of that
converges on the same few calls. Apache-2.0 covers expression, not the idea, so a
rewrite that looks alike proves little. It is listed as ours because it was typed
here, not because it is clever.

Three files were taken and later removed as dead weight, each still byte-identical
to upstream when removed, and nothing in our build reached any of them:
`Sources/SimNative/StreamFormat.swift` (our `main.swift` writes the same envelope
itself), `Sources/SimNativeSupport/DeviceHubKeyboardRouting.swift` and
`Sources/SimNativeSupport/DevicePose.swift`.

## What upstream has that we did not take

The whole of serve-sim's NodeAPI binding and everything behind it: the
node-swift module `sim-module.swift`, the HID injection and accessibility
bridges (`HIDInjector.swift`, `AccessibilityBridge.swift`,
`DeviceHubKeyboardBridge.swift`, `DuoHIDBridge.swift`), the capture orchestration
we replaced with `main.swift` (`CaptureEngine.swift`), the Duo hardware renderer
(`SimDuoRenderer/*`), the Objective-C camera, accessibility and HID helpers
(`SimCameraInjector/*`, `SimCameraHelper/*`, `SimAXSettings/*`, `SimDuoHID/*`),
and all of serve-sim's TypeScript server and preview UI. simlock needs one thing
from serve-sim: the framebuffer of a device nobody is looking at, encoded.

## Deviations

Two that change behaviour, both deliberate. Each is here because a later reader
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

One mechanical consequence of flattening two upstream targets into one:
`FrameCapture.swift` no longer says `import SimNativeSupport`, because there is
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

| Reached by | Member | Declared in `facebook/idb` at `66c6f7bb98324212dcf047dc7330048303b0163d` |
|---|---|---|
| selector | `SimServiceContext sharedServiceContextForDeveloperDir:error:` | `PrivateHeaders/CoreSimulator/SimServiceContext.h` |
| selector | `defaultDeviceSetWithError:` | same |
| selector | `deviceSetWithPath:error:` | same |
| selector | `SimDevice io` | `PrivateHeaders/CoreSimulator/SimDevice.h` |
| selector | `SimDevice deviceType` | same |
| selector | `updateIOPorts` | `PrivateHeaders/CoreSimulator/SimDeviceIOClient.h` |
| selector | `SimDeviceIOPort descriptor` | `PrivateHeaders/CoreSimDeviceIO/SimDeviceIOPortInterface-Protocol.h` |
| selector | `framebufferSurface` | `PrivateHeaders/CoreSimDeviceIO/SimDisplayIOSurfaceRenderable-Protocol.h`, `SimScreen-Protocol.h` |
| selector | `unregisterScreenCallbacksWithUUID:` | `PrivateHeaders/CoreSimDeviceIO/SimScreen-Protocol.h` |
| selector | `SimDeviceType mainScreenSize` | `PrivateHeaders/CoreSimulator/SimDeviceType.h` |
| selector | `portIdentifier` | **not declared there** |
| KVC | `SimDevice UDID`, `stateString` | `PrivateHeaders/CoreSimulator/SimDevice.h` |
| KVC | `SimDeviceSet devices` | `PrivateHeaders/CoreSimulator/SimDeviceSet.h` |
| KVC | `SimDeviceIOClient deviceIOPorts` | `PrivateHeaders/CoreSimulator/SimDeviceIOClient.h` |
| KVC | `SimDeviceType bundlePath`, `bundleURL` | **not declared there** (`idb` declares `bundle` only) |
| class | `NSClassFromString("SimServiceContext")` | `PrivateHeaders/CoreSimulator/SimServiceContext.h` |
| file schema | `Contents/Resources/capabilities.plist` inside a device type's bundle | **not declared there**, and undocumented by Apple |

That is nineteen distinct private members: eleven selectors, six key-value-coding
keys, one class name and one plist schema. `facebook/idb` is MIT-licensed, and
fifteen of the nineteen are declared in its `PrivateHeaders/CoreSimulator/` and
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

What is *not* in idb is the other half of the story, and it is where a break will
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

That prints three things and nothing else — the `MODIFIED FILE` header Apache §4(b)
asks for, the device-set patch, and the deleted `import SimNativeSupport` — which is
the whole claim of this notice in one screenful. If that diff ever grows past those
three, either someone edited upstream's capture logic or Apple moved something
upstream, and both deserve to be noticed rather than committed. For any other file
still listed as upstream's, substitute its upstream path in both places:

```sh
UPSTREAM=packages/serve-sim/Sources/SimNative/SimFrameworks.swift   # or SimNativeSupport/…
curl -sL "https://raw.githubusercontent.com/EvanBacon/serve-sim/6d009686ed08f7d8bd19bca9f9f67a9237931f44/$UPSTREAM" \
  | diff -u - "Sources/simlock-screen-capture/$(basename "$UPSTREAM")"
```

Run it before and after an Xcode upgrade, and again before taking anything new
from upstream. A file whose diff grows by lines nobody wrote is the notification
that something moved.

This is the reason not to rewrite a private-API file to escape a license: for the
four files we did rewrite the comparison above stops being a detector, because a
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

`main.swift`, `H264Encoder.swift`, `VideoEncoder.swift`, `PixelBufferUtils.swift`,
`Xcode.swift`, `scripts/unframe.mjs` and `Package.swift`, plus `NOTICE.md` and the
`LICENSES/` entry's file name. Everything else in `Sources/simlock-screen-capture/`
is serve-sim's, with the one patch above.

Ours is under the project's MIT license, like the rest of this repository. That is
permitted rather than a relicensing: Apache-2.0 lets a licensee add its own terms to
its own modifications and to the derivative as a whole, provided the four §4
conditions still travel — the license text in `LICENSES/`, the change notices in the
deviations above, and the attribution here. The Apache-2.0 text covers the serve-sim
code this directory carries and nothing else in it. Whether MIT and Apache-2.0
should be stated as one combined license for this directory or kept as two explicit
layers is a legal judgement, and this notice deliberately does the second: it names
which file licenses which bytes, so nobody has to guess what shipping this directory
obliges us to.
