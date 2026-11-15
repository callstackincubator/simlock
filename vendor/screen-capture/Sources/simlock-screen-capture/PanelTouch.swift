// simlock's own, MIT-licensed (see NOTICE.md): where a tap on the upright picture lands on a panel (#1535).
import Foundation

/// A touch as the HID injector sends it: the digitizer it targets and a fraction of that digitizer.
struct PanelTouchPoint: Equatable {
    let target: UInt32
    let x: Double
    let y: Double
}

enum PanelTouch {
    /// The digitizer one panel reads touches on, and the generic one a device with a single panel uses.
    static let singlePanelTarget: UInt32 = 0x32

    // why: SimulatorKit addresses a panel's digitizer as its screen id with 0x40000000 set; the
    // digitizer reads fractions of the panel's framebuffer, so a panel mounted turned (the inner
    // Duo panel, 270) gets the upright fraction turned back: (u, v) is sent as (v, 1 - u).
    static func map(_ panel: Panel?, x: Double, y: Double) -> PanelTouchPoint {
        guard let panel else { return PanelTouchPoint(target: singlePanelTarget, x: x, y: y) }
        let target = UInt32(panel.screenID) | 0x4000_0000
        if panel.nativeRotation == 270 { return PanelTouchPoint(target: target, x: y, y: 1 - x) }
        return PanelTouchPoint(target: target, x: x, y: y)
    }
}

extension Panel {
    /// The panel's size as its picture is shown, upright: a panel mounted on its side is streamed turned.
    var uprightSize: (width: Int, height: Int) {
        nativeRotation == 90 || nativeRotation == 270 ? (height, width) : (width, height)
    }
}
