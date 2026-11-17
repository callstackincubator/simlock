// simlock's own, MIT-licensed (see NOTICE.md): the Indigo presses behind one button name.
import Foundation

/// One Indigo button message: the event source, the direction (1 down, 2 up) and the wait before the next step.
struct ButtonStep: Equatable {
    let source: Int32
    let direction: Int32
    let pauseAfter: TimeInterval
}

enum ButtonPlan {
    private static let sourceHome: Int32 = 0
    private static let sourceLock: Int32 = 1
    private static let down: Int32 = 1
    private static let up: Int32 = 2

    /// The presses for a button name; a name with no plan (Back, Siri, an empty one) gets none, so
    /// the helper never sends Home on its own (ADR 0085 section 3).
    static func steps(for name: String) -> [ButtonStep] {
        switch name {
        case "lock":
            return [
                ButtonStep(source: sourceLock, direction: down, pauseAfter: 0),
                ButtonStep(source: sourceLock, direction: up, pauseAfter: 0),
            ]
        case "app_switcher":
            // why: two Home presses 50 ms apart opened the switcher on every runtime measured (ADR 0085).
            return [
                ButtonStep(source: sourceHome, direction: down, pauseAfter: 0),
                ButtonStep(source: sourceHome, direction: up, pauseAfter: 0.05),
                ButtonStep(source: sourceHome, direction: down, pauseAfter: 0),
                ButtonStep(source: sourceHome, direction: up, pauseAfter: 0),
            ]
        default:
            return []
        }
    }
}
