// simlock-screen-capture — streams the framebuffer of one booted iOS Simulator on stdout.
//
// Usage:
//   simlock-screen-capture <UDID> [--codec avcc|mjpeg] [--fps N] [--bitrate BPS]
//                              [--max-dimension PX] [--duration SEC]
//   simlock-screen-capture <UDID> --input
//
// `--input` writes no picture: it injects the touches, scrolls and keys the daemon sends on stdin
// into the simulator and says its native size once on stdout (see InputMode.swift).
//
// Environment:
//   SIMLOCK_IOS_DEVICE_SET   the `simctl --set` root the device lives in (see FrameCapture)
//
// The wire
// --------
// The inherited stdout becomes the video channel and is never written to again by anyone else:
// before anything else happens, fd 1 is redirected onto stderr, so every stray `print()` — the
// copied capture code logs that way, and so does anything a framework might add — lands on the
// log stream instead of cutting a hole in the bitstream. Frames go to a private duplicate of the
// original stdout.
//
// Each frame is one write in serve-sim's AVCC envelope: a 4-byte big-endian length (covering the
// tag byte that follows it), then a tag, then the payload. Tags 0x01-0x04 are serve-sim's (avcC
// description, keyframe, delta, JPEG seed); 0x05 is this tool's own JSON meta frame, written first
// so a relay learns the codec and the size before any video arrives.
//
// stderr is UTF-8 text: the log, plus a single `RESULT <json>` line at exit. A caller that wants
// the video must keep the two streams apart — which simlock's process port already does, and
// which the `device.exec` protocol cannot because its output chunks are strings.
//
// Lifecycle: capture runs until SIGTERM/SIGINT/SIGHUP or until stdin closes. The daemon stops a
// stream by closing stdin, and kills the process only if it is still running 2 s later, so "the
// viewer pressed stop" and "the viewer went away" are the same event here, and no capture can
// outlive the connection that asked for it.
//
// Exit codes: 64 on bad usage, 1 when the source fails to start or stops with a reason, 0 on every
// clean end. The options, the envelope, the lifecycle and the encoders are SimlockCapture's; this
// file is the simulator source and the name of the program.
import Foundation
import SimlockCapture

// Claims the bitstream before anything can print, including the source this program is about to
// build: FrameCapture logs with `print` while it starts.
Wire.claimStdout()

let arguments = Array(CommandLine.arguments.dropFirst())
if arguments.count == 2, arguments[1] == "--input" {
    await runInput(udid: arguments[0])
}

guard let options = parseOptions(arguments) else {
    log("usage: simlock-screen-capture <UDID> [--codec avcc|mjpeg] [--fps N] [--bitrate BPS] [--max-dimension PX] [--duration SEC] | simlock-screen-capture <UDID> --input")
    exit(64)
}

await runCapture(options: options, source: SimulatorSource())
