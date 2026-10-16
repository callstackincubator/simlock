// swift-tools-version:6.0
//
// simlock-screen-capture — a standalone Swift CLI that streams the framebuffer of a booted
// iOS Simulator to stdout.
//
// Origin: see NOTICE.md for the per-file record, and LICENSES/ for the license text of the parts
// that are not ours. The private-API capture path is serve-sim's (Apache-2.0), copied from
// Sources/SimNative and Sources/SimNativeSupport with two changes:
//
//  1. `FrameCapture.findSimDevice` also searches the device set named by
//     SIMLOCK_IOS_DEVICE_SET. serve-sim searches only CoreSimulator's default set, and simlock
//     boots every simulator in its own `simctl --set` root (ADR 0001), so without this patch it
//     cannot see a simlock device at all.
//  2. There is no node-swift binding. serve-sim's binding is `sim-module.swift`, the only file in
//     that package that needs NodeAPI; a process that writes frames to stdout instead does not
//     need it, and the daemon can then supervise the capture the same way it supervises every
//     other tool it runs.
//
// The encoders are serve-sim's files rewritten here: `H264Encoder.swift`, `VideoEncoder.swift`,
// `PixelBufferUtils.swift` and `Xcode.swift` now use public VideoToolbox, CoreVideo, CoreMedia and
// ImageIO, and as modified files of serve-sim they stay under Apache-2.0 (see NOTICE.md).
//
// One target, so the copied types keep their internal visibility and need no `public` edits.
import PackageDescription

let package = Package(
    name: "simlock-screen-capture",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "simlock-screen-capture",
            path: "Sources/simlock-screen-capture",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)
