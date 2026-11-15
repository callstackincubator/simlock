// simlock's own, MIT-licensed (see NOTICE.md): where a tap on the upright picture lands on a panel (#1535).
import Foundation

/// A touch as the HID injector sends it: the digitizer it targets and a fraction of that digitizer.
struct PanelTouchPoint: Equatable {
    let target: UInt32
    let x: Double
    let y: Double
}

enum PanelTouch {
    static func map(_ panel: Panel?, x: Double, y: Double) -> PanelTouchPoint {
        PanelTouchPoint(target: 0, x: 0, y: 0)
    }
}
