// simlock-device-capture — streams one physical iPhone's screen on stdout, through CoreDevice's
// media stream.
//
// Usage:
//   simlock-device-capture <UDID> [--codec avcc] [--fps N] [--bitrate BPS]
//                               [--max-dimension PX] [--duration SEC]
//
// The wire, the envelope, the lifecycle and the encoders are the same as simlock-screen-capture's;
// both live in SimlockCapture, and both end on 64, 1 or 0 — this program's version gate adds 69.
// What differs is where the pictures come from: CoreDevice asks the iPhone for an HEVC media stream,
// this program receives it as RTP, decodes it, and hands each picture to the same encode loop a
// simulator's framebuffer goes into.
//
// Version gate: the first thing this program does, before any CoreDevice call, is read CoreDevice's
// own version and refuse a Mac it was not written against (exit 69). The framework is linked `weak`,
// so the program starts on a Mac without it long enough to say so.
//
// SIMLOCK_COREDEVICE_INFO_PLIST names another Info.plist to read that version from, for the slow lane
// only; the driver never passes it.
import Foundation
import SimlockCapture

// Claims the bitstream before anything can print, including the negotiator bridge's own logs.
Wire.claimStdout()

guard let options = parseOptions(Array(CommandLine.arguments.dropFirst())) else {
    log("usage: simlock-device-capture <UDID> [--codec avcc|mjpeg] [--fps N] [--bitrate BPS] [--max-dimension PX] [--duration SEC]")
    exit(64)
}

if let refusal = CoreDeviceVersion.refusal(for: CoreDeviceVersion.read()) {
    fail(69, refusal)
}

await runCapture(options: options, source: DeviceScreenSource())
