// simlock's own, MIT-licensed (see NOTICE.md): the stream's pacing grid.

/// The stream's pacing grid. A frame is due one interval after the last one sent, and may come a
/// quarter interval early; the deadline never trails a frame by more than half an interval, so a
/// slightly early frame is not lost and a pause does not end in a burst.
public struct FrameGrid {
    private let intervalNanos: UInt64
    private var deadline: UInt64 = 0
    private var started = false

    public init(fps: Int) {
        intervalNanos = UInt64(1_000_000_000 / Double(fps))
    }

    /// Whether a frame seen at `atNanos` is due. Asking moves nothing.
    public func isDue(atNanos: UInt64) -> Bool {
        !started || atNanos &+ intervalNanos / 4 >= deadline
    }

    /// Records that a frame seen at `atNanos` was sent.
    public mutating func commit(atNanos: UInt64) {
        deadline = started
            ? max(deadline &+ intervalNanos, atNanos &+ intervalNanos / 2)
            : atNanos &+ intervalNanos
        started = true
    }

    /// `isDue`, then `commit` when due.
    public mutating func admit(atNanos: UInt64) -> Bool {
        guard isDue(atNanos: atNanos) else { return false }
        commit(atNanos: atNanos)
        return true
    }
}
