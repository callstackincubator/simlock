// simlock's own, MIT-licensed (see NOTICE.md): which panel of a foldable simulator to stream (#1534).
import Foundation

enum PanelRole: String {
    case cover, inner
}

enum Panels {
    static func primary(inLogLine line: String) -> PanelRole? {
        nil
    }
}
