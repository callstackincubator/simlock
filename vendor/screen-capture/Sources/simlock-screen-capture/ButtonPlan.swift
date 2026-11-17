// simlock's own, MIT-licensed (see NOTICE.md): the Indigo presses behind one button name.
import Foundation

/// One Indigo button message: the event source, the direction (1 down, 2 up) and the wait before the next step.
struct ButtonStep: Equatable {
    let source: Int32
    let direction: Int32
    let pauseAfter: TimeInterval
}

enum ButtonPlan {
    static func steps(for name: String) -> [ButtonStep] {
        []
    }
}
