// simlock's own: the lifecycle both capture programs run — the counters a stream reports with, the
// scaler, the encode loop, and the one way out. MIT-licensed; see NOTICE.md.
import CoreVideo
import Dispatch
import Foundation
import VideoToolbox

/// Resolved once, by whichever way out arrives first, and read by the lifecycle's one waiter. A
/// class because a signal source, the stdin thread, a failed frame write and a source's own callback
/// all have to be able to reach it, and none of them runs on an actor.
public final class OneShot<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var settled = false
    /// Held as a closure because `Value` may itself be optional, and a `Value?` would not say whether
    /// the nil is the settled value or the absence of one.
    private var produce: (() -> Value)?
    private var waiters: [(Value) -> Void] = []

    public init() {}

    /// Takes the first value offered and ignores the rest, so a SIGTERM that lands while a stop is
    /// already running cannot ask for a second one.
    public func set(_ offered: Value) {
        lock.lock()
        guard !settled else {
            lock.unlock()
            return
        }
        settled = true
        produce = { offered }
        let pending = waiters
        waiters = []
        lock.unlock()
        for waiter in pending { waiter(offered) }
    }

    public func wait() async -> Value {
        await withCheckedContinuation { (continuation: CheckedContinuation<Value, Never>) in
            lock.lock()
            if let settled = produce {
                lock.unlock()
                continuation.resume(returning: settled())
                return
            }
            waiters.append { resumed in continuation.resume(returning: resumed) }
            lock.unlock()
        }
    }
}

/// A captured frame, handed from the source's queue to the encode queue.
struct Pending: @unchecked Sendable {
    let buffer: CVPixelBuffer
    /// Monotonic nanoseconds (`DispatchTime.uptimeNanoseconds`), so a wall-clock jump cannot stall
    /// the fps throttle.
    let atNanos: UInt64
}

/// What the frame path mutates, behind one lock. A class rather than an actor because the source's
/// callback is synchronous and stdout needs one writer at a time.
final class Session {
    private let lock = NSLock()
    private var writtenFrames = 0
    private var writtenBytes = 0
    private var _viewerGone = false
    var scaler: Scaler?
    var scaledSize = Dimensions(width: 0, height: 0)
    /// The way out every end goes through: nil for a clean stop, else the one line to print last.
    let exitRequest = OneShot<String?>()

    init() {}

    var counts: (frames: Int, bytes: Int) {
        lock.lock()
        defer { lock.unlock() }
        return (writtenFrames, writtenBytes)
    }

    /// Set the moment a write to the video channel fails. The encode loop stops on it, so a stream
    /// the far end hung up on goes out through the same door as one the daemon asked to stop.
    var viewerGoneFlag: Bool {
        lock.lock()
        defer { lock.unlock() }
        return _viewerGone
    }

    func recordWritten(_ byteCount: Int) {
        lock.lock()
        writtenFrames += 1
        writtenBytes += byteCount
        lock.unlock()
    }

    func viewerGone() {
        lock.lock()
        _viewerGone = true
        lock.unlock()
        exitRequest.set(nil)
    }
}

// MARK: - Downscale
//
// Both sources hand over a picture at the device's native size (1179x2556 on an iPhone 16). A viewer
// several hops away through the gateway does not need every pixel, and each one is paid for twice on
// the uplink. VTPixelTransferSession scales on the GPU, so the saving is bandwidth without a CPU cost
// on the worker.

/// Not thread-safe by itself: every call happens on the single encode queue.
final class Scaler {
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

/// Scales to the configured maximum and returns a buffer safe to encode. The encoder deep-copies what
/// it is given internally, so the recycled framebuffer IOSurface is never held.
func prepareForEncode(
    _ buffer: CVPixelBuffer,
    options: Options,
    session: Session
) -> CVPixelBuffer? {
    let width = CVPixelBufferGetWidth(buffer)
    let height = CVPixelBufferGetHeight(buffer)
    guard options.maxDimension > 0, max(width, height) > options.maxDimension else {
        return buffer
    }
    // why: sized once, from the first picture — a rotation changes the long edge and the scale factor
    // with it, and rebuilding the scaler mid-stream is out of scope for this task (see the module's
    // known gaps).
    if session.scaler == nil {
        let factor = Double(options.maxDimension) / Double(max(width, height))
        // Even dimensions: H.264 4:2:0 rejects an odd chroma plane.
        let targetWidth = max(2, Int(Double(width) * factor) & ~1)
        let targetHeight = max(2, Int(Double(height) * factor) & ~1)
        session.scaler = Scaler(targetWidth: targetWidth, targetHeight: targetHeight)
        session.scaledSize = Dimensions(width: targetWidth, height: targetHeight)
        log("scaling \(width)x\(height) -> \(targetWidth)x\(targetHeight)")
    }
    return session.scaler?.transferFrom(buffer)
}

// MARK: - The encode loop

/// Runs the encode loop until the viewer goes away. `newest(1)` on the stream means a slow encoder or
/// a relay that stops draining drops old frames instead of queueing them without bound, which is the
/// behaviour a live view needs.
///
/// The first frame forces an IDR so the viewer that just asked for the stream can start decoding
/// immediately rather than waiting for the encoder's own keyframe interval; after that VideoToolbox
/// spaces IDRs itself (`MaxKeyFrameInterval = fps * 5`, from serve-sim's encoder).
func encodeLoop(_ frames: AsyncStream<Pending>, options: Options, session: Session) async {
    let intervalNanos = UInt64(1_000_000_000 / Double(options.fps))
    var lastSent: UInt64 = 0
    var started = false
    var metaEmitted = false
    let encoder = H264Encoder(fps: options.fps, bitrate: options.bitrate)
    let jpegEncoder = VideoEncoder(quality: 0.7)
    for await frame in frames {
        if started, frame.atNanos &- lastSent < intervalNanos { continue }
        lastSent = frame.atNanos
        let forceKeyframe = !started
        started = true

        guard let prepared = prepareForEncode(frame.buffer, options: options, session: session) else {
            continue
        }
        // The meta frame rides the first picture because that is the first moment the encoded
        // geometry (post-scale) is known.
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
                Wire.emit(.meta, Data(string.utf8), countedBy: session)
            }
        }
        if options.codec == "mjpeg" {
            if let data = try? await jpegEncoder.encode(pixelBuffer: prepared) {
                Wire.emit(.delta, data, countedBy: session)
            }
        } else if let encoded = try? await encoder.encode(
            prepared,
            forceKeyframe: forceKeyframe
        ) {
            if let description = encoded.description {
                Wire.emit(.description, description, countedBy: session)
            }
            Wire.emit(
                encoded.kind == .keyframe ? .keyframe : .delta,
                encoded.avcc,
                countedBy: session
            )
        }
        if session.viewerGoneFlag { return }
    }
}

// MARK: - The lifecycle

/// Signals and stdin, on dispatch sources rather than C signal handlers so what runs there is
/// ordinary Swift and is allowed to stop a source.
final class ExitSources {
    private var sources: [DispatchSourceSignal] = []
    private let queue = DispatchQueue(label: "exit-sources")

    init(onExit: @escaping @Sendable (_ reason: String?) -> Void) {
        for sig in [SIGTERM, SIGINT, SIGHUP] {
            signal(sig, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: sig, queue: queue)
            source.setEventHandler { onExit(nil) }
            source.resume()
            sources.append(source)
        }
        // stdin is a liveness handle: the daemon that closes it is the daemon that asked for stop. A
        // plain thread reads it because a blocked `read` has no async form.
        Thread.detachNewThread {
            var byte: UInt8 = 0
            while read(0, &byte, 1) > 0 {}
            log("stdin closed")
            onExit(nil)
        }
    }
}

/// Reports the running totals every few seconds, so a caller's log carries what a stream cost even
/// though a stream ended by a viewer going away has no chance to report at exit.
func watchStats(_ session: Session, startedAt: Date) {
    Thread.detachNewThread {
        var lastFrames = 0
        var lastBytes = 0
        while true {
            Thread.sleep(forTimeInterval: 5)
            let counted = session.counts
            let secs = max(0.001, Date.now.timeIntervalSince(startedAt))
            log(
                "STATS {\"fps\": \((Double(counted.frames - lastFrames) / 5 * 10).rounded() / 10), "
                    + "\"kbps\": \(Int(Double(counted.bytes - lastBytes) * 8 / 5 / 1000)), "
                    + "\"totalFrames\": \(counted.frames), \"totalBytes\": \(counted.bytes), "
                    + "\"avgKbps\": \(Int(Double(counted.bytes) * 8 / secs / 1000)), "
                    + "\"rssMb\": \(Int(residentBytes() / 1_048_576))}"
            )
            lastFrames = counted.frames
            lastBytes = counted.bytes
        }
    }
}

/// Writes the `RESULT` line a `--duration` run promises, out of the counted totals.
func writeResultLine(_ session: Session, startedAt: Date) {
    let secs = max(0.001, Date.now.timeIntervalSince(startedAt))
    let counted = session.counts
    let stats: [String: Any] = [
        "seconds": (secs * 100).rounded() / 100,
        "frames": counted.frames,
        "bytes": counted.bytes,
        "fps": (Double(counted.frames) / secs * 10).rounded() / 10,
        "kbps": ((Double(counted.bytes) * 8 / secs) / 1000).rounded(),
        "avgFrameBytes": counted.frames == 0 ? 0 : Int(Double(counted.bytes) / Double(counted.frames)),
        "rssMb": Int(residentBytes() / 1_048_576),
    ]
    if let json = try? JSONSerialization.data(withJSONObject: stats) {
        log("RESULT \(String(data: json, encoding: .utf8)!)")
    }
}

/// Runs one capture: start the source, encode what it hands over, and take the first way out that
/// arrives — always `stop()` first, then the exit it calls for.
///
/// Every way out goes through here, because a capture that leaves its device-side state running is
/// the one thing this program must never do, and a bare `_exit` from a write path or a signal
/// handler skips exactly the cleanup that would have cleared it.
public func runCapture(options: Options, source: any ScreenSource) async -> Never {
    let session = Session()
    let signals = ExitSources(onExit: { reason in session.exitRequest.set(reason) })
    let startedAt = Date.now
    watchStats(session, startedAt: startedAt)
    if options.duration > 0 {
        Task.detached {
            try? await Task.sleep(nanoseconds: UInt64(options.duration * 1_000_000_000))
            writeResultLine(session, startedAt: startedAt)
            session.exitRequest.set(nil)
        }
    }

    let (frames, sink) = AsyncStream.makeStream(
        of: Pending.self,
        bufferingPolicy: .bufferingNewest(1)
    )
    do {
        try await source.start(
            deviceID: options.udid,
            onFrame: { buffer in
                sink.yield(Pending(buffer: buffer, atNanos: DispatchTime.now().uptimeNanoseconds))
            },
            onEnd: { reason in session.exitRequest.set(reason) }
        )
    } catch {
        log("start failed: \(error)")
        await source.stop()
        fail("\(error)")
    }
    log("capture started")

    let encoding = Task { await encodeLoop(frames, options: options, session: session) }
    let reason = await session.exitRequest.wait()
    encoding.cancel()
    await source.stop()
    withExtendedLifetime(signals) {}
    if let reason { fail(reason) }
    exit(0)
}
