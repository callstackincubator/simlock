// simlock's own, MIT-licensed (see NOTICE.md): the stream's pacing grid.

/// The stream's pacing grid. A frame is due one interval after the last one sent, and may come a
/// quarter interval early.
public struct FrameGrid {
    public init(fps: Int) {}

    /// Whether a frame seen at `atNanos` is due. Asking moves nothing.
    public func isDue(atNanos: UInt64) -> Bool { false }

    /// Records that a frame seen at `atNanos` was sent.
    public mutating func commit(atNanos: UInt64) {}

    /// `isDue`, then `commit` when due.
    public mutating func admit(atNanos: UInt64) -> Bool { false }
}
