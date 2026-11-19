// simlock's own, MIT-licensed (see NOTICE.md): which composites the simulator capture copies.

/// One composite the capture noticed, before any copy.
struct Composite {
    /// `DispatchTime.now().uptimeNanoseconds` at the moment the capture noticed the new seed.
    let seenNanos: UInt64
    /// The idle floor and a panel switch: always copied.
    let force: Bool
    let width: Int
    let height: Int
}

/// Decides, before the copy, whether a composite is copied. Its grid moves only for a copied one.
struct FrameSelection {
    init(fps: Int) {}

    mutating func decide(_ composite: Composite) -> Bool { false }
}
