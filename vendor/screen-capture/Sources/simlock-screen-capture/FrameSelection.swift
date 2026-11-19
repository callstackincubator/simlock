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
    /// `TileHasher.hashes(of:)` of the composite; nil when the caller does not tell tiles apart.
    var tiles: [UInt64]? = nil
}

/// Says whether a composite carries a new app frame, from which tiles of the screen changed. Liquid
/// Glass changes some tiles on every composite, so a composite whose only changes are on tiles that
/// changed on all of the last 8 composites repeats the app frame before it.
struct TileSelector {
    private let intervalNanos: UInt64
    private var previous: [UInt64]?
    private var previousSeenNanos: UInt64 = 0
    /// Per tile, one bit per composite taken (the newest lowest): set when the tile changed on it.
    private var history: [UInt8] = []

    init(intervalNanos: UInt64) {
        self.intervalNanos = intervalNanos
    }

    /// Takes the composite into the history and says whether it carries a new app frame.
    mutating func carriesNewFrame(tiles: [UInt64], seenNanos: UInt64, lastSentNanos: UInt64?) -> Bool {
        defer {
            previous = tiles
            previousSeenNanos = seenNanos
        }
        guard let before = previous, before.count == tiles.count else {
            history = [UInt8](repeating: 0, count: tiles.count)
            return true
        }
        var carriesNew = false
        var sometimes = 0
        var sometimesChanged = 0
        for tile in tiles.indices {
            let changed = tiles[tile] != before[tile]
            let alwaysChanging = history[tile] == UInt8.max
            if changed, history[tile] & 1 == 0, !alwaysChanging { carriesNew = true }
            if history[tile] != 0, !alwaysChanging {
                sometimes += 1
                if changed { sometimesChanged += 1 }
            }
            history[tile] = history[tile] << 1 | (changed ? 1 : 0)
        }
        if carriesNew || (sometimes > 0 && sometimesChanged * 2 >= sometimes) { return true }
        if seenNanos &- previousSeenNanos >= intervalNanos * 3 / 4 { return true }
        return lastSentNanos.map { seenNanos &- $0 >= intervalNanos * 3 / 2 } ?? true
    }

    mutating func reset() {
        previous = nil
    }
}

/// Decides, before the copy, whether a composite is copied. Its grid moves only for a copied one,
/// because a slot spent on a composite that is skipped would drop the app frame right after it.
struct FrameSelection {
    private var grid: FrameGrid
    private var tileSelector: TileSelector
    private var size: (width: Int, height: Int)?
    private var lastSentNanos: UInt64?

    init(fps: Int) {
        grid = FrameGrid(fps: fps)
        tileSelector = TileSelector(intervalNanos: UInt64(1_000_000_000 / Double(fps)))
    }

    mutating func decide(_ composite: Composite) -> Bool {
        let resized = size.map { $0 != (composite.width, composite.height) } ?? true
        size = (composite.width, composite.height)
        if resized { tileSelector.reset() }
        // why: the history sees every composite taken, so the selector is asked before the grid.
        let carriesNewFrame = composite.tiles.map {
            tileSelector.carriesNewFrame(tiles: $0, seenNanos: composite.seenNanos, lastSentNanos: lastSentNanos)
        } ?? true
        if composite.force || resized {
            if grid.isDue(atNanos: composite.seenNanos) { send(composite) }
            return true
        }
        guard grid.isDue(atNanos: composite.seenNanos), carriesNewFrame else { return false }
        send(composite)
        return true
    }

    private mutating func send(_ composite: Composite) {
        grid.commit(atNanos: composite.seenNanos)
        lastSentNanos = composite.seenNanos
    }
}

/// Tells which parts of a composite changed, without copying it.
enum TileHasher {
    static let tileWidth = 16
    static let tileHeight = 32

    /// One FNV-1a hash per 16x32-pixel tile over every 8th row and every 2nd pixel of the surface (32-bit pixels),
    /// row-major, the tiles on the right and bottom edges partial.
    static func hashes(of surface: IOSurface) -> [UInt64] {
        let width = IOSurfaceGetWidth(surface)
        let height = IOSurfaceGetHeight(surface)
        let columns = (width + tileWidth - 1) / tileWidth
        let rows = (height + tileHeight - 1) / tileHeight
        guard columns > 0, rows > 0 else { return [] }
        guard IOSurfaceLock(surface, .readOnly, nil) == kIOReturnSuccess else { return [] }
        defer { IOSurfaceUnlock(surface, .readOnly, nil) }
        let base = IOSurfaceGetBaseAddress(surface)
        let bytesPerRow = IOSurfaceGetBytesPerRow(surface)
        var hashes = [UInt64](repeating: 0xcbf2_9ce4_8422_2325, count: columns * rows)
        for y in stride(from: 0, to: height, by: 8) {
            let row = (base + y * bytesPerRow).assumingMemoryBound(to: UInt32.self)
            let tileRow = y / tileHeight
            for column in 0..<columns {
                let from = column * tileWidth
                var hash = hashes[tileRow * columns + column]
                for x in stride(from: from, to: min(from + tileWidth, width), by: 2) {
                    hash = (hash ^ UInt64(row[x])) &* 0x0000_0100_0000_01b3
                }
                hashes[tileRow * columns + column] = hash
            }
        }
        return hashes
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
            height: IOSurfaceGetHeight(notice.surface),
            tiles: TileHasher.hashes(of: notice.surface)
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

/// Says whether a seed is news, so a composite is noticed once.
struct SeedGate {
    private var lastSeeds: [ObjectIdentifier: UInt32] = [:]

    /// True for a seed other than the last one noticed for `key`, or when `force` is set.
    mutating func notice(key: ObjectIdentifier, seed: UInt32, force: Bool) -> Bool {
        let isNew = lastSeeds[key] != seed
        lastSeeds[key] = seed
        return isNew || force
    }

    /// Forgets every seed, so the next one of each key is news (the framebuffer was rewired).
    mutating func reset() {
        lastSeeds.removeAll()
    }
}
