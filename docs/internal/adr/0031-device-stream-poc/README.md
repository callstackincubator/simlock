# DeviceStreamPoC

A third-party macOS app that mirrors a physical iPhone and sends touches to it, built by
reverse-engineering what Xcode 27's **DeviceHub.app** does under the hood.

Requirements: macOS 26, Xcode 27 (CoreDevice 642.x), an iPhone paired with Xcode and connected over USB.

```bash
./build.sh
open build/DeviceStreamPoC.app
```

Pick the iPhone, press **Start mirror**, allow Camera access when asked (iOS screen-capture devices are
treated as cameras by TCC), then click / drag / two-finger-scroll on the video to touch the device.
A drag that starts within 3% of an edge is sent as an edge gesture (bottom edge = home gesture).

## How DeviceHub works

| Concern | Framework | Notes |
| --- | --- | --- |
| Shell | `DeviceHub.app` → `DeviceKit.framework` | DeviceHub only instantiates `DeviceKit.DeviceManagementWindow()`. |
| Discovery / control | `CoreDevice.framework` (`/Library/Developer/PrivateFrameworks`) | Client of `coredeviced`; devices reached over the RemotePairing tunnel (`remotepairingd`), USB or Wi‑Fi. Entry: `CoreDeviceService.sharedConnection` → `DeviceManager` → `RemoteDevice`. |
| Video | `CoreDeviceMediaStreamSupport.framework` + private `AVConference` | `MediaStreamSession.makeVideoStream(withConfiguration: .receiveMirroredPrimary(layer:timeout:))` negotiates `com.apple.coredevice.feature.startmediastream` with an `AVCMediaStreamNegotiator` offer, gets a socket pair on the tunnel, and `avconferenced` renders the decoded video into the CALayer (`AVCRemoteVideoClient`). Frames never enter the client process. |
| Touch / keys | `CoreDevice` HID capabilities + `UniversalHID.framework` | Legacy digitizer: `RemoteDevice.getImplementation(for: CapabilityStaticMember<DigitizerHIDCapability>())` → `HIDDigitizer.send(pointOne:…)` (`IndigoHIDDigitizer`, normalized 0…1 coordinates). Newer path: `UniversalHIDService` virtual HID services + HID reports. |

## What a third-party app can and cannot use

* **Works without entitlements**: everything in CoreDevice — discovery, device/display info, screenshots
  (`CaptureScreenshotCapability`), and the remote HID digitizer (verified: taps, drags, edge gestures).
* **Gated**: the AVConference video path. `avconferenced` rejects `vcMediaStreamSetSessionConfig` unless the
  client holds `com.apple.videoconference.allow-conferencing`, a restricted entitlement; AMFI refuses to load a
  non-Apple binary that claims it. The "Try CoreDevice media stream" button reproduces the refusal.
* **Public substitute for video**: CoreMediaIO `kCMIOHardwarePropertyAllowScreenCaptureDevices` exposes a
  USB-connected iPhone as a muxed `AVCaptureDevice` (what QuickTime Player uses). This app renders it with
  `AVCaptureVideoPreviewLayer` and maps clicks back through `captureDevicePointConverted(fromLayerPoint:)`.

## Layout

* `Sources/main.swift` — the app (AppKit): CoreMediaIO capture, CoreDevice discovery, digitizer input, the media-stream experiment.
* `Stubs/*.swiftmodule/*.swiftinterface` — hand-written Swift interfaces for the private frameworks (they ship none). The frameworks are built with library evolution, so calls go through stable dispatch thunks; declarations must match the real signatures/manglings (see comments).
* `Tools/listdevices.swift`, `Tools/tap.swift` — CLI checks. `tap <device> x y [x2 y2]` taps or swipes in normalized coordinates; `EDGE=bottom` makes it an edge gesture.
* `build.sh`, `Info.plist`, `entitlements.plist` (the entitlement experiment; not applied by default).

Environment switches for testing: `AUTOSTART=<device name substring>`, `AUTOTAP=x,y` (device space) or
`AUTOTAP=view:fx,fy` (fraction of the video view), `LOGFILE=<path>`.
