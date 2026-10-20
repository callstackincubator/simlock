// simlock's capture programs share one library: the option parser, the frame envelope, the
// lifecycle, the stats line, the scaler and the encode loop. Only the `ScreenSource` differs between
// them, so the whole shape around a source lives here and each program's `main.swift` is the source
// it picks plus the gate that names it.
//
// This file is simlock's own, MIT-licensed; the encoders beside it are serve-sim's modified files —
// see NOTICE.md.
import CoreVideo
import Foundation

/// The stream's settings, exactly as the daemon passes them.
public struct Options: Sendable {
    public var udid = ""
    public var codec = "avcc"
    public var fps = 30
    public var bitrate = 2_000_000
    public var maxDimension = 720
    public var duration = 0.0

    public init() {}
}

/// nil for anything the parser cannot make sense of, which is a usage error (exit 64).
public func parseOptions(_ args: [String]) -> Options? {
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

/// One line of text a source cannot go beyond: it is what the daemon turns into the reason a viewer
/// reads in a 503, and what the program prints as its last stderr line.
public struct CaptureError: Error, CustomStringConvertible, Sendable {
    public let message: String
    public var description: String { message }

    public init(_ message: String) {
        self.message = message
    }
}

/// What a source throws when it did not start because the caller had already asked it to stop. It is
/// not a reason a viewer needs: the caller asked for this, and it is the clean end it asked for.
public struct StoppedBeforeStart: Error {
    public init() {}
}

/// What hands decoded pictures to the encode loop. The simulator's framebuffer is one
/// implementation, CoreDevice's media stream is the second, and ADR 0031 names CoreMediaIO (the
/// QuickTime path) as the third. Each program picks one in its `main.swift`; there is no registry.
public protocol ScreenSource: AnyObject {
    /// Brings the source up for `deviceID` and returns once it is running — before its first
    /// picture, which is what the stream's first-frame bound measures to.
    ///
    /// Throws a `CaptureError` when it cannot start.
    func start(
        deviceID: String,
        onFrame: @escaping @Sendable (CVPixelBuffer) -> Void,
        onEnd: @escaping @Sendable (_ reason: String?) -> Void
    ) async throws

    /// Idempotent, and back within 1.5 s whatever the device is doing — a close the daemon waits on
    /// must not become the reason a lease outlives its viewer.
    func stop() async
}

/// serve-sim's AVCC envelope (`Sources/SimNative/StreamFormat.swift`) plus this tool's meta tag.
public enum Tag: UInt8 {
    case description = 0x01
    case keyframe = 0x02
    case delta = 0x03
    case seed = 0x04
    case meta = 0x05
}

/// The video channel: a private duplicate of the stdout the program was started with.
public enum Wire {
    /// Set by `claimStdout`, which every program's `main.swift` calls as its first statement.
    public private(set) static var fd: Int32 = -1

    /// Reserves the program's original stdout for the bitstream and points the inherited fd 1 at
    /// stderr, so text that any code in this process writes to stdout — the copied capture code logs
    /// with `print`, and frameworks do too — cannot cut a hole in the bitstream.
    @discardableResult
    public static func claimStdout() -> Int32 {
        guard fd < 0 else { return fd }
        let reserved = dup(STDOUT_FILENO)
        guard reserved >= 0 else {
            fatalError("could not duplicate stdout")
        }
        dup2(STDERR_FILENO, STDOUT_FILENO)
        fd = reserved
        return reserved
    }

    /// Writes one envelope frame to the video channel: length prefix (covering the tag and payload),
    /// tag, payload. A partial write would desynchronize every frame after it, so a short one is
    /// retried until the frame is out; the only way a frame stops part-way is a failed write, which
    /// ends the stream. Only the encode loop writes, which is why this is not `public`.
    static func emit(_ tag: Tag, _ data: Data, countedBy session: Session) {
        let total = UInt32(data.count + 1)
        var out = Data(capacity: data.count + 5)
        out.append(UInt8((total >> 24) & 0xff))
        out.append(UInt8((total >> 16) & 0xff))
        out.append(UInt8((total >> 8) & 0xff))
        out.append(UInt8(total & 0xff))
        out.append(tag.rawValue)
        out.append(data)
        session.recordWritten(out.count)
        out.withUnsafeBytes { pointer in
            var written = 0
            let base = pointer.baseAddress!
            while written < out.count {
                let n = write(fd, base + written, out.count - written)
                if n <= 0 {
                    // EPIPE is the viewer going away, which is a normal end of a stream and the only
                    // way one can end without anyone asking.
                    session.viewerGone()
                    return
                }
                written += n
            }
        }
    }
}

public func log(_ message: String) {
    FileHandle.standardError.write("[capture] \(message)\n".data(using: .utf8)!)
}

/// One line on why the program is stopping, as the very last thing on stderr, then exit 1. The
/// daemon reads that line as the stream's reason.
public func fail(_ reason: String) -> Never {
    fail(1, reason)
}

/// As above, with the exit code the reason calls for.
///
/// why: the daemon reads this program's *last* stderr line as the reason a viewer sees, and a
/// reason a framework handed back with newlines in it would arrive there as its last line only —
/// so the one line promised here is what goes out, with any inner break flattened.
public func fail(_ code: Int32, _ reason: String) -> Never {
    let oneLine = reason
        .split(whereSeparator: { $0.isNewline })
        .joined(separator: " / ")
    FileHandle.standardError.write("\(oneLine)\n".data(using: .utf8)!)
    exit(code)
}

/// Resident set of this process, in bytes. This is the number that answers "what does one open
/// stream cost the worker", so it is measured rather than estimated.
public func residentBytes() -> UInt64 {
    var info = mach_task_basic_info()
    var count = mach_msg_type_number_t(MemoryLayout<mach_task_basic_info>.size) / 4
    let status = withUnsafeMutablePointer(to: &info) { pointer -> kern_return_t in
        pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
            task_info(mach_task_self_, task_flavor_t(MACH_TASK_BASIC_INFO), $0, &count)
        }
    }
    return status == KERN_SUCCESS ? info.resident_size : 0
}
