// MODIFIED FILE — this file is derived from serve-sim (Copyright 2026 Evan Bacon, Apache-2.0;
// see NOTICE.md and LICENSES/ in this package) and it is NOT verbatim upstream. simlock rewrote
// it from upstream's `Sources/SimNative/PixelBufferUtils.swift` at the commit NOTICE.md names, and the
// result stays under Apache-2.0 as a modified file of serve-sim, not under simlock's MIT license.
// `NOTICE.md` prints the one command that diffs this file against pristine upstream at the commit
// it derives from. Read that notice before editing this file.
import CoreVideo

/// The size of a frame, in pixels.
struct Dimensions: Hashable, Sendable {
    var width: Int
    var height: Int
}

extension CVPixelBuffer {
    /// The buffer's pixel size.
    var dimensions: Dimensions {
        Dimensions(
            width: CVPixelBufferGetWidth(self),
            height: CVPixelBufferGetHeight(self)
        )
    }
}

/// Copies each captured frame into a buffer of our own, so that it can outlive the
/// frame callback that produced it.
///
/// What the capture path hands over is a `CVPixelBuffer` wrapped around SimulatorKit's
/// live framebuffer `IOSurface`, and the next frame the simulator draws lands in those
/// same pages, in place. So the pixels behind that buffer are only stable until the
/// simulator renders again — not long enough for a frame that is encoded after the
/// callback returns. Retaining the buffer would not help either: retention keeps the
/// object alive, not its contents. Only a copy does, which is why this exists at all —
/// it is a correctness requirement, not an optimisation. Skipping it shows up as torn
/// frames, not as an error.
///
/// The copies come out of a `CVPixelBufferPool`, so a long session recycles the same
/// few allocations instead of creating one per frame. That is the only reason this
/// holds state; the pool is rebuilt whenever the frame size changes, which happens on
/// a rotation.
public struct Photocopier {
    private var pool: CVPixelBufferPool?
    /// The frame size `pool` was built for, so a size change is noticed rather than
    /// silently copied into a buffer of the wrong dimensions.
    private var poolSize: Dimensions?

    public init() {}
    /// The pool that fits `size`, rebuilding it when the one on hand does not.
    private mutating func pool(for size: Dimensions) -> CVPixelBufferPool? {
        if let pool, poolSize == size {
            return pool
        }

        // IOSurface-backed deliberately: what consumes these buffers downstream is a
        // VideoToolbox compression session and a GPU pixel-transfer session, and both
        // want a surface the hardware can map rather than a plain allocated block.
        let format: [String: Any] = [
            kCVPixelBufferWidthKey as String: size.width,
            kCVPixelBufferHeightKey as String: size.height,
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferIOSurfacePropertiesKey as String: [:],
        ]
        var rebuilt: CVPixelBufferPool?
        CVPixelBufferPoolCreate(kCFAllocatorDefault, nil, format as CFDictionary, &rebuilt)
        pool = rebuilt
        poolSize = size
        return rebuilt
    }

    /// A buffer of our own holding the same pixels as `source`, or nil when no copy
    /// could be made.
    public mutating func copy(_ source: CVPixelBuffer) -> CVPixelBuffer? {
        guard let pool = pool(for: source.dimensions) else { return nil }
        var fresh: CVPixelBuffer?
        guard CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &fresh) == kCVReturnSuccess,
              let target = fresh
        else { return nil }

        // Locking is what hands out a base address at all — an IOSurface is not
        // guaranteed to be CPU-mapped until someone asks to read it.
        CVPixelBufferLockBaseAddress(source, .readOnly)
        CVPixelBufferLockBaseAddress(target, [])
        defer {
            CVPixelBufferUnlockBaseAddress(source, .readOnly)
            CVPixelBufferUnlockBaseAddress(target, [])
        }
        guard let from = CVPixelBufferGetBaseAddress(source),
              let into = CVPixelBufferGetBaseAddress(target)
        else { return nil }

        // Row by row, because a row of the copy and a row of the framebuffer are only
        // the same length by accident: each allocator pads the end of a row to its own
        // alignment, so the strides differ and the buffers cannot be copied as one
        // block. The shorter stride is the one that is pixels in both.
        let sourceStride = CVPixelBufferGetBytesPerRow(source)
        let targetStride = CVPixelBufferGetBytesPerRow(target)
        let rowBytes = min(sourceStride, targetStride)
        for row in 0..<CVPixelBufferGetHeight(source) {
            memcpy(into + row * targetStride, from + row * sourceStride, rowBytes)
        }
        return target
    }
}
