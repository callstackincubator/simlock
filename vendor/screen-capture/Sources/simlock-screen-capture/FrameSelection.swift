// simlock's own, MIT-licensed (see NOTICE.md): which composites the simulator capture copies.
import CoreVideo
import Foundation
import IOSurface
import SimlockCapture

/// One composite the capture noticed, before any copy.
struct Composite {
    /// `DispatchTime.now().uptimeNanoseconds` at the moment the capture noticed the new seed.
    let seenNanos: UInt64
    /// The idle floor and a panel switch: always copied.
    let force: Bool
    let width: Int
    let height: Int
}

/// Decides, before the copy, whether a composite is copied. Its grid moves only for a copied one,
/// because a slot spent on a composite that is skipped would drop the app frame right after it.
struct FrameSelection {
    private var grid: FrameGrid
    private var size: (width: Int, height: Int)?

    init(fps: Int) {
        grid = FrameGrid(fps: fps)
    }

    mutating func decide(_ composite: Composite) -> Bool {
        let resized = size.map { $0 != (composite.width, composite.height) } ?? true
        size = (composite.width, composite.height)
        if composite.force || resized {
            if grid.isDue(atNanos: composite.seenNanos) { grid.commit(atNanos: composite.seenNanos) }
            return true
        }
        return grid.admit(atNanos: composite.seenNanos)
    }
}

/// A composite the capture noticed and has not copied yet.
struct Notice {
    let surface: IOSurface
    let seed: UInt32
    let seenNanos: UInt64
    let force: Bool
}

/// The copy half of the capture: a one-slot hand-off from the queue that notices composites, and a
/// serial queue of its own that decides and copies, so a 10-20 ms copy never holds up noticing the
/// next composite.
final class CopyStage: @unchecked Sendable {
    private let lock = NSLock()
    // why: internal so a test can wait for the queue to drain; nothing else touches it.
    let queue = DispatchQueue(label: "frame-copy", qos: .userInteractive)
    private var slot: Notice?
    private var stopped = false
    private var onFrame: (@Sendable (CVPixelBuffer, UInt64) -> Void)?
    // why: these two are touched only on `queue`, so they need no lock.
    private var photocopier = Photocopier()
    private var selection: FrameSelection

    init(fps: Int, onFrame: @escaping @Sendable (CVPixelBuffer, UInt64) -> Void) {
        selection = FrameSelection(fps: fps)
        self.onFrame = onFrame
    }

    /// Puts `notice` in the slot, replacing one not yet taken: the newer composite has its own notice.
    func offer(_ notice: Notice) {
        lock.lock()
        if stopped {
            lock.unlock()
            return
        }
        slot = notice
        lock.unlock()
        queue.async { self.copyNext() }
    }

    /// Drops a notice not yet taken; nothing is copied or handed over after this.
    func stop() {
        lock.lock()
        stopped = true
        slot = nil
        onFrame = nil
        lock.unlock()
    }

    private func take() -> Notice? {
        lock.lock()
        defer { lock.unlock() }
        let notice = slot
        slot = nil
        return notice
    }

    private func copyNext() {
        guard let notice = take() else { return }
        // why: a surface whose seed has moved on holds a newer composite, which has its own notice.
        guard IOSurfaceGetSeed(notice.surface) == notice.seed else { return }
        let composite = Composite(
            seenNanos: notice.seenNanos,
            force: notice.force,
            width: IOSurfaceGetWidth(notice.surface),
            height: IOSurfaceGetHeight(notice.surface)
        )
        guard selection.decide(composite) else { return }
        var pixelBuffer: Unmanaged<CVPixelBuffer>?
        let status = CVPixelBufferCreateWithIOSurface(
            kCFAllocatorDefault, notice.surface,
            [kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_32BGRA] as CFDictionary,
            &pixelBuffer
        )
        guard status == kCVReturnSuccess, let pb = pixelBuffer?.takeRetainedValue(),
              let copy = photocopier.copy(pb) else { return }
        lock.lock()
        let emit = onFrame
        lock.unlock()
        emit?(copy, notice.seenNanos)
    }
}
