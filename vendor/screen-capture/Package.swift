// swift-tools-version:6.0
//
// Two programs that stream one device's screen on stdout, over one library:
//
//   simlock-screen-capture  the framebuffer of one booted iOS Simulator
//   simlock-device-capture  the HEVC media stream of one physical iPhone, through CoreDevice
//
// Both write the same envelope, take the same arguments and exit the same codes; only the
// `ScreenSource` behind them differs. See NOTICE.md for the per-file record, and LICENSES/ for the
// license text of the parts that are not ours. The simulator capture pipeline and the encoders came
// from serve-sim (Apache-2.0), copied from Sources/SimNative and Sources/SimNativeSupport with two
// changes:
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
import PackageDescription

let package = Package(
    name: "simlock-screen-capture",
    platforms: [.macOS(.v14)],
    targets: [
        // The shared half of both programs: the options, the envelope, the lifecycle, the scaler
        // and the encoders. `public` is only what the two executables reach.
        .target(
            name: "SimlockCapture",
            path: "Sources/SimlockCapture",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .executableTarget(
            name: "simlock-screen-capture",
            dependencies: ["SimlockCapture"],
            path: "Sources/simlock-screen-capture",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        // The one piece of Objective-C in the package, and the only reason it has two languages:
        // SwiftPM refuses a target that mixes Swift and Objective-C sources.
        .target(
            name: "SimlockMediaBridge",
            path: "Sources/SimlockMediaBridge",
            publicHeadersPath: "include"
        ),
        // A physical iPhone's stream. Only this target knows CoreDevice exists, and it links it
        // `weak` (F27): on a Mac without the framework the program must still start long enough to
        // print why it cannot stream, rather than dying in the loader.
        //
        // `-Onone` is load-bearing: the CoreDevice stubs under `Stubs/` leave enum cases out, and an
        // optimizing client may treat an enum with no declared case as uninhabited. The `-I` path is
        // absolute because a relative one does not resolve through the build's own working
        // directory; `Context.packageDirectory` is the package's own path, so it stays put when the
        // checkout moves.
        .executableTarget(
            name: "simlock-device-capture",
            dependencies: ["SimlockCapture", "SimlockMediaBridge"],
            path: "Sources/simlock-device-capture",
            swiftSettings: [
                .swiftLanguageMode(.v5),
                .unsafeFlags([
                    "-Onone",
                    "-I", Context.packageDirectory + "/Stubs",
                ]),
            ],
            linkerSettings: [
                .unsafeFlags([
                    "-F", "/Library/Developer/PrivateFrameworks",
                    "-Xlinker", "-weak_framework", "-Xlinker", "CoreDevice",
                    "-Xlinker", "-weak_library", "-Xlinker",
                    "/Library/Developer/PrivateFrameworks/CoreDeviceUtilities.framework/Versions/A/CoreDeviceUtilities",
                ]),
            ]
        ),
    ]
)
