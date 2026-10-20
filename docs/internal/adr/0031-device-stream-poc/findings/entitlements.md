# DeviceStreamPoC entitlement investigation

Date: 15 October 2026. Host: macOS 26.6.1 (25G76), arm64; System Integrity Protection enabled. Installed DeviceHub reports version 27.0, build 255.2.6.6.

## Conclusion

There is no ordinary local signing fix identified for `com.apple.videoconference.allow-conferencing`. It is a restricted entitlement on this machine. Adding it produces a valid code signature but prevents the process from launching. Making it legitimate would require authorization from Apple, not merely an Apple Development or Developer ID certificate. No public capability or request route for this particular entitlement was found.

This does not prove that every possible video implementation is blocked. It establishes that the current AVConference implementation cannot be enabled simply by changing the PoC's signing flags.

## Evidence

1. The current `build.sh` signs ad hoc and does not apply `entitlements.plist`. Inspection confirms that the app currently carries no entitlements. That is intentional: applying the experimental entitlement would make it unlaunchable.
2. The actual `DeviceHub.app/Contents/MacOS/DeviceHub` executable contains the conferencing entitlement. Inspect that executable explicitly: inspecting the app bundle selects `DevicesTrampoline`, which has an empty entitlement dictionary.
3. Existing system logs from 14:10:25 and 14:10:29 Europe/Warsaw show `avconferenced` rejecting `vcMediaStreamSetSessionConfig` with `entitlementStatus=2`. This is a daemon-side authorization failure. It is separate from Camera consent and from the PoC's Swift interface declarations.
4. A fresh minimal C program that only prints a marker was packaged into four separate app bundles and signed ad hoc. It has no dependency on CoreDevice, AVConference, the phone, or the Swift stubs.

| Probe | codesign and strict verification | Execution |
| --- | --- | --- |
| Empty entitlements | Both passed | Reached main; exit 0 |
| Ordinary camera entitlement | Both passed | Reached main; exit 0 |
| Conferencing entitlement | Both passed | SIGKILL before main |
| Conferencing entitlement + Hardened Runtime | Both passed | SIGKILL before main |

The two failing probes produced AMFI error -424 at 14:51:49 Europe/Warsaw: “The file is adhoc signed but contains restricted entitlements”. Kernel logs also recorded fatal code-signature validation failures. The control probes show why generic AMFI warnings about ad-hoc signatures should not themselves be mistaken for the fatal cause.

Probe source, entitlement plists, app bundles and machine-readable results are in `work/entitlement-audit/`. The probes were executed outside the agent sandbox; no system protection was changed.

## What might make the entitlement usable

Apple would have to authorize its use for this app through an applicable signing/provisioning arrangement, if Apple offers one. Restricted entitlements in third-party macOS apps require authorization in a provisioning profile. A developer certificate alone does not grant arbitrary entitlement keys. Apple's published macOS capability list does not list this conferencing entitlement. Asking Apple Developer Technical Support about availability is reasonable, but approval should not be assumed.

Root execution, Camera permission, changing the bundle identifier, notarization, or adding a sandbox exception are not substitutes for entitlement authorization. No paid signing identity or Apple-issued profile granting this entitlement was tested or available as evidence in this investigation.

The report's statement that disabling SIP and AMFI is the only route is too absolute. It omits possible Apple authorization and implementations that avoid this daemon. It also does not demonstrate that changing those protections would resolve every subsequent streaming check. No protection changes, injection, or patches to Apple binaries were attempted.

## Product paths

- **Existing USB implementation:** the project already contains CoreMediaIO/AVCaptureSession video capture plus CoreDevice HID input. The pasted report predates that code. Existing app logs show the muxed iOS device being selected, capture starting and HID events being sent. The log reports an initial format of 0x0, so this inspection alone does not establish frame quality or sustained video delivery. I did not retest the phone UI.
- **Custom receiver research:** the installed CoreDevice binary exports `RemoteDevice.startMediaStream(with:)`, `stopMediaStream(with:)`, stream support queries, and negotiation helpers. CoreDeviceMediaStreamSupport then constructs AVConference streams. This identifies a plausible separation point: negotiate through CoreDevice, receive the transport independently, and decode/render in our process. It would require reconstructing the negotiation and transport contract, codec framing and any encryption/feedback. Symbols and successful negotiation do not prove usable packets are obtainable without further privileges. No custom receiver was built in this investigation.

For Wi-Fi video, a bounded next experiment is to prove that a standalone, unentitled client can obtain and receive the negotiated media transport without constructing an AVConference video stream. Only after that succeeds should work proceed to codec decoding and rendering. This changes the video implementation; it does not grant the restricted entitlement.

## Limits of the original report

An observed authorization failure does not establish that it is the only gate. Similarly, a few successful CoreDevice operations do not establish that everything in CoreDevice is unrestricted. Swift library evolution helps ABI resilience, but does not promise compatibility for hand-written declarations of private APIs across Xcode releases.

The stubs also expose `requestLastDecodedFrame()` and `receivedLastDecodedFrame(Data)`, so the statement that frames never enter the client process should be limited to the normal remote-layer rendering path; these declarations alone do not verify the optional frame-copy behavior.

## Sources

- [Apple TN3125: Inside Code Signing — Provisioning Profiles](https://developer.apple.com/documentation/technotes/tn3125-inside-code-signing-provisioning-profiles), especially Entitlements on macOS and The how.
- [Apple: Supported capabilities (macOS)](https://developer.apple.com/help/account/reference/supported-capabilities-macos/).
- [Apple DTS: entitlement categories](https://developer.apple.com/forums/thread/735356).
- Local project source, signed executable metadata, installed framework exported symbols, existing app/system logs, and fresh isolated signing probes described above.

The app source, build script, app signature and system security configuration were left unchanged. This investigation added only this report and files under `work/entitlement-audit/`.
