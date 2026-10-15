// simlock-screen-capture — streams the framebuffer of one booted iOS Simulator on stdout.
//
// Usage:
//   simlock-screen-capture <UDID> [--codec avcc|mjpeg] [--fps N] [--bitrate BPS]
//                              [--max-dimension PX] [--duration SEC]
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
// stream by killing the process, so "the viewer pressed stop" and "the viewer went away" are the
// same event here, and no capture can outlive the connection that asked for it.
import Foundation
import CoreMedia
import CoreVideo
import VideoToolbox

// MARK: - Options

struct Options {
    var udid = ""
    var codec = "avcc"
    var fps = 30
    var bitrate = 2_000_000
    var maxDimension = 720
    var duration = 0.0
}

func parseOptions(_ args: [String]) -> Options? {
    var o = Options()
    var positionals: [String] = []
    var i = 0
    while i < args.count {
        let a = args[i]
        func value() -> String? {
            i += 1
            return i < args.count ? args[i] : nil
        }
        switch a {
        case "--codec": guard let v = value() else { return nil }; o.codec = v
        case "--fps": guard let v = value(), let n = Int(v) else { return nil }; o.fps = max(1, min(60, n))
        case "--bitrate": guard let v = value(), let n = Int(v) else { return nil }; o.bitrate = max(100_000, n)
        case "--max-dimension": guard let v = value(), let n = Int(v) else { return nil }; o.maxDimension = max(0, n)
        case "--duration": guard let v = value(), let s = Double(v) else { return nil }; o.duration = max(0, s)
        default:
            if a.hasPrefix("--") { return nil }
            positionals.append(a)
        }
        i += 1
    }
    guard positionals.count == 1 else { return nil }
    o.udid = positionals[0]
    guard o.codec == "avcc" || o.codec == "mjpeg" else { return nil }
    return o
}

// MARK: - Framing

/// serve-sim's AVCC envelope (`Sources/SimNative/StreamFormat.swift`) plus this tool's meta tag.
enum Tag: UInt8 {
    case description = 0x01
    case keyframe = 0x02
    case delta = 0x03
    case seed = 0x04
    case meta = 0x05
}

/// What the frame path mutates, behind one lock. A class rather than an actor because the capture
/// callback is synchronous and stdout needs one writer at a time.
final class Session: @unchecked Sendable {
    let lock = NSLock()
    var scaler: Scaler?
    var scaledSize = Dimensions(width: 0, height: 0)
    var frames = 0
    var bytes = 0
    /// The scaler is sized from the first frame, so a resize mid-session is not tracked (a
    /// rotation changes the framebuffer's long edge and the scale factor with it). The PoC
    /// accepts the first frame's geometry; the fix is to rebuild the scaler on size change.
    var scalerSize = Dimensions(width: 0, height: 0)
}

let session = Session()

/// The video channel: a private duplicate of the stdout we were started with. The inherited fd 1
/// is redirected onto stderr below, so text that any code in this process writes to stdout — the
/// copied capture code logs with `print`, and frameworks do too — cannot reach the bitstream.
let videoFd: Int32 = {
    let fd = dup(STDOUT_FILENO)
    guard fd >= 0 else {
        fatalError("could not duplicate stdout")
    }
    dup2(STDERR_FILENO, STDOUT_FILENO)
    return fd
}()

/// Writes one envelope frame to the video channel: length prefix (covering the tag and payload),
/// tag, payload. A partial write would desynchronize every frame after it, so the whole frame goes
/// out under one lock.
func emit(_ tag: Tag, _ data: Data) {
    let total = UInt32(data.count + 1)
    var out = Data(capacity: data.count + 5)
    out.append(UInt8((total >> 24) & 0xff))
    out.append(UInt8((total >> 16) & 0xff))
    out.append(UInt8((total >> 8) & 0xff))
    out.append(UInt8(total & 0xff))
    out.append(tag.rawValue)
    out.append(data)
    session.lock.lock()
    session.frames += 1
    session.bytes += out.count
    session.lock.unlock()
    out.withUnsafeBytes { pointer in
        var written = 0
        let base = pointer.baseAddress!
        while written < out.count {
            let n = write(videoFd, base + written, out.count - written)
            if n <= 0 {
                // EPIPE is the viewer going away, which is the normal end of a stream.
                _exit(0)
            }
            written += n
        }
    }
}

func log(_ message: String) {
    FileHandle.standardError.write("[capture] \(message)\n".data(using: .utf8)!)
}

/// Resident set of this process, in bytes. This is the number that answers "what does one open
/// stream cost the worker", so it is measured rather than estimated.
func residentBytes() -> UInt64 {
    var info = mach_task_basic_info()
    var count = mach_msg_type_number_t(MemoryLayout<mach_task_basic_info>.size) / 4
    let status = withUnsafeMutablePointer(to: &info) { pointer -> kern_return_t in
        pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
            task_info(mach_task_self_, task_flavor_t(MACH_TASK_BASIC_INFO), $0, &count)
        }
    }
    return status == KERN_SUCCESS ? info.resident_size : 0
}

// MARK: - Downscale
//
// serve-sim captures at the simulator's native framebuffer size (1179x2556 on an iPhone 16). A
// viewer several hops away through the gateway does not need every pixel, and each one is paid
// for twice on the uplink. VTPixelTransferSession scales on the GPU, so the saving is bandwidth
// without a CPU cost on the worker.

/// Not thread-safe by itself: every call happens on the single encode queue.
final class Scaler: @unchecked Sendable {
    private var transfer: VTPixelTransferSession?
    private let pool: CVPixelBufferPool

    init(targetWidth: Int, targetHeight: Int) {
        let attrs: [String: Any] = [
            kCVPixelBufferWidthKey as String: targetWidth,
            kCVPixelBufferHeightKey as String: targetHeight,
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferIOSurfacePropertiesKey as String: [String: Any](),
        ]
        var poolRef: CVPixelBufferPool?
        CVPixelBufferPoolCreate(kCFAllocatorDefault, nil, attrs as CFDictionary, &poolRef)
        self.pool = poolRef!
    }

    /// Scales into a fresh buffer from the pool, or returns nil when the GPU transfer fails.
    func transferFrom(_ source: CVPixelBuffer) -> CVPixelBuffer? {
        if transfer == nil {
            var created: VTPixelTransferSession?
            guard VTPixelTransferSessionCreate(
                allocator: kCFAllocatorDefault,
                pixelTransferSessionOut: &created
            ) == noErr, let created else { return nil }
            transfer = created
        }
        guard let transfer else { return nil }
        var target: CVPixelBuffer?
        guard CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &target) == noErr,
              let target else { return nil }
        guard VTPixelTransferSessionTransferImage(transfer, from: source, to: target) == noErr else {
            return nil
        }
        return target
    }
}

// MARK: - Signal and stdin teardown

func watchExitSources() {
    for sig in [SIGTERM, SIGINT, SIGHUP] {
        signal(sig) { _ in _exit(0) }
    }
    // stdin is a liveness handle: the daemon that closes it is the daemon that asked for stop.
    Thread.detachNewThread {
        var byte: UInt8 = 0
        while read(0, &byte, 1) > 0 {}
        log("stdin closed")
        _exit(0)
    }
}

/// Reports the running totals every few seconds, so a caller's log carries what a stream cost even
/// though a stream ended by a viewer going away has no chance to report at exit.
func watchStats() {
    Thread.detachNewThread {
        var lastFrames = 0
        var lastBytes = 0
        while true {
            Thread.sleep(forTimeInterval: 5)
            session.lock.lock()
            let frames = session.frames
            let bytes = session.bytes
            session.lock.unlock()
            let secs = max(0.001, Date.now.timeIntervalSince(startedAt))
            let window = max(0.001, secs)
            log(
                "STATS {\"fps\": \((Double(frames - lastFrames) / 5 * 10).rounded() / 10), "
                    + "\"kbps\": \(Int(Double(bytes - lastBytes) * 8 / 5 / 1000)), "
                    + "\"totalFrames\": \(frames), \"totalBytes\": \(bytes), "
                    + "\"avgKbps\": \(Int(Double(bytes) * 8 / window / 1000)), "
                    + "\"rssMb\": \(Int(residentBytes() / 1_048_576))}"
            )
            lastFrames = frames
            lastBytes = bytes
        }
    }
}

// MARK: - Main

guard let options = parseOptions(Array(CommandLine.arguments.dropFirst())) else {
    log("usage: simlock-screen-capture <UDID> [--codec avcc|mjpeg] [--fps N] [--bitrate BPS] [--max-dimension PX] [--duration SEC]")
    exit(64)
}

watchExitSources()

let startedAt = Date.now
watchStats()
let capture = FrameCapture()
let encoder = H264Encoder(fps: options.fps, bitrate: options.bitrate)
let jpegEncoder = VideoEncoder(quality: 0.7)

/// A captured frame, handed from the capture queue to the encode queue.
struct Pending: @unchecked Sendable {
    let buffer: CVPixelBuffer
    /// Monotonic nanoseconds (`DispatchTime.uptimeNanoseconds`), so a wall-clock jump cannot stall
    /// the fps throttle.
    let atNanos: UInt64
}

let (frames, sink) = AsyncStream.makeStream(of: Pending.self, bufferingPolicy: .bufferingNewest(1))

// Capture fires on SimulatorKit's render callbacks plus a 5 fps idle floor, so the cadence is the
// simulator's. Two things happen on the encode side: the fps throttle, then the encode. Dropped
// frames cost nothing — an H.264 P-frame carries the difference, so a jump from N to N+3 decodes
// as one slightly larger delta.

/// Runs the encode loop. `newest(1)` means a slow encoder or a relay that stops draining drops
/// old frames instead of queueing them without bound, which is the behaviour a live view needs.
///
/// The first frame forces an IDR so the viewer that just asked for the stream can start decoding
/// immediately rather than waiting for the encoder's own keyframe interval; after that
/// VideoToolbox spaces IDRs itself (`MaxKeyFrameInterval = fps * 5`, from serve-sim's encoder).
func encodeLoop() async {
    let intervalNanos = UInt64(1_000_000_000 / Double(options.fps))
    var lastSent: UInt64 = 0
    var started = false
    var metaEmitted = false
    for await frame in frames {
        if started, frame.atNanos &- lastSent < intervalNanos { continue }
        lastSent = frame.atNanos
        let forceKeyframe = !started
        started = true

        guard let prepared = prepareForEncode(frame.buffer) else { continue }
        if !metaEmitted {
            metaEmitted = true
            let meta: [String: Any] = [
                "udid": options.udid,
                "codec": options.codec == "avcc" ? "h264" : "mjpeg",
                "width": CVPixelBufferGetWidth(prepared),
                "height": CVPixelBufferGetHeight(prepared),
                "fps": options.fps,
                "deviceSet": ProcessInfo.processInfo.environment["SIMLOCK_IOS_DEVICE_SET"] ?? "default",
            ]
            if let json = try? JSONSerialization.data(withJSONObject: meta),
               let string = String(data: json, encoding: .utf8) {
                log("ready \(string)")
                emit(.meta, Data(string.utf8))
            }
        }
        if options.codec == "mjpeg" {
            if let data = try? await jpegEncoder.encode(pixelBuffer: prepared) {
                emit(.delta, data)
            }
        } else if let encoded = try? await encoder.encode(
            prepared,
            forceKeyframe: forceKeyframe
        ) {
            if let description = encoded.description {
                emit(.description, description)
            }
            emit(encoded.kind == .keyframe ? .keyframe : .delta, encoded.avcc)
        }
    }
}

/// Scales to the configured maximum and returns a buffer safe to encode. The encoder deep-copies
/// what it is given internally, so the recycled framebuffer IOSurface is never held.
func prepareForEncode(_ buffer: CVPixelBuffer) -> CVPixelBuffer? {
    let width = CVPixelBufferGetWidth(buffer)
    let height = CVPixelBufferGetHeight(buffer)
    guard options.maxDimension > 0, max(width, height) > options.maxDimension else {
        return buffer
    }
    session.lock.lock()
    if session.scaler == nil {
        let factor = Double(options.maxDimension) / Double(max(width, height))
        // Even dimensions: H.264 4:2:0 rejects an odd chroma plane.
        let targetWidth = max(2, Int(Double(width) * factor) & ~1)
        let targetHeight = max(2, Int(Double(height) * factor) & ~1)
        session.scaler = Scaler(targetWidth: targetWidth, targetHeight: targetHeight)
        session.scaledSize = Dimensions(width: targetWidth, height: targetHeight)
        log("scaling \(width)x\(height) -> \(targetWidth)x\(targetHeight)")
    }
    let scaler = session.scaler
    session.lock.unlock()
    return scaler?.transferFrom(buffer)
}

Task {
    do {
        try await capture.start(deviceUDID: options.udid) { pixelBuffer, _ in
            sink.yield(Pending(buffer: pixelBuffer, atNanos: DispatchTime.now().uptimeNanoseconds))
        }
    } catch {
        log("start failed: \(error)")
        _exit(1)
    }
    // The meta frame is written by the encode loop on the first frame, because that is the first
    // moment the encoded geometry (post-scale) is known.
    await encodeLoop()
}

if options.duration > 0 {
    try? await Task.sleep(nanoseconds: UInt64(options.duration * 1_000_000_000))
    let secs = max(0.001, Date.now.timeIntervalSince(startedAt))
    session.lock.lock()
    let counted = (session.frames, session.bytes)
    session.lock.unlock()
    let stats: [String: Any] = [
        "seconds": (secs * 100).rounded() / 100,
        "frames": counted.0,
        "bytes": counted.1,
        "fps": (Double(counted.0) / secs * 10).rounded() / 10,
        "kbps": ((Double(counted.1) * 8 / secs) / 1000).rounded(),
        "avgFrameBytes": counted.0 == 0 ? 0 : Int(Double(counted.1) / Double(counted.0)),
        "rssMb": Int(residentBytes() / 1_048_576),
    ]
    if let json = try? JSONSerialization.data(withJSONObject: stats) {
        log("RESULT \(String(data: json, encoding: .utf8)!)")
    }
    exit(0)
}

dispatchMain()
