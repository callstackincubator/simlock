import XCTest

@testable import simlock_screen_capture

// why: the parser is pure logic with many cases, and SpringBoard's log text is the part a new iOS
// release changes; the follower's tests drive it through `PanelFollower`.
final class PanelLogLineTests: XCTestCase {
    private let tag = "[com.apple.SpringBoard:DisplayContentMode]"

    func testALogLineNamesThePanelInUse() {
        let cases: [(line: String, expected: PanelRole?)] = [
            ("2026-11-11 10:00:00.1 Df SpringBoard[88:1f] \(tag) swapped  .inner:pri .cover:aux", .inner),
            ("2026-11-11 10:00:00.1 Df SpringBoard[88:1f] \(tag) swapped  .cover:pri .inner:aux", .cover),
            ("2026-11-11 10:00:00.1 Df SpringBoard[88:1f] \(tag) transitioning  .inner:off→pri .cover:aux", nil),
            ("Filtering the log data using \"... CONTAINS \".cover:pri\" OR eventMessage CONTAINS \".inner:pri\"\"", nil),
            ("2026-11-11 10:00:00.1 Df SpringBoard[88:1f] \(tag) swapped  .inner:pri .cover:pri", nil),
            ("2026-11-11 10:00:00.1 Df SpringBoard[88:1f] [com.apple.SpringBoard:Other] hello", nil),
        ]
        for (line, expected) in cases {
            XCTAssertEqual(Panels.primary(inLogLine: line), expected, line)
        }
    }
}
