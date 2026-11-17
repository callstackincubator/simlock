import XCTest

@testable import simlock_screen_capture

final class ButtonPlanTests: XCTestCase {
    func testAButtonNameBecomesTheIndigoPressesTheHelperSends() {
        let lock = [
            ButtonStep(source: 1, direction: 1, pauseAfter: 0),
            ButtonStep(source: 1, direction: 2, pauseAfter: 0),
        ]
        let switcher = [
            ButtonStep(source: 0, direction: 1, pauseAfter: 0),
            ButtonStep(source: 0, direction: 2, pauseAfter: 0.05),
            ButtonStep(source: 0, direction: 1, pauseAfter: 0),
            ButtonStep(source: 0, direction: 2, pauseAfter: 0),
        ]
        let cases: [(String, [ButtonStep])] = [
            ("lock", lock),
            ("app_switcher", switcher),
            ("back", []),
            ("siri", []),
            ("", []),
        ]
        for (name, steps) in cases {
            XCTAssertEqual(ButtonPlan.steps(for: name), steps, "'\(name)'")
        }
    }
}
