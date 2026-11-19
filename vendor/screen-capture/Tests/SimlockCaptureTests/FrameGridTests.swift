import XCTest

@testable import SimlockCapture

final class FrameGridTests: XCTestCase {
    func testAskingIfAFrameIsDueMovesNothingAndACommittedFrameMakesTheNextOneWait() {
        let ms: UInt64 = 1_000_000
        var grid = FrameGrid(fps: 60)
        XCTAssertTrue(grid.isDue(atNanos: 0), "the first frame is due")
        XCTAssertTrue(grid.isDue(atNanos: 0), "asking twice gives the same answer")
        grid.commit(atNanos: 0)
        XCTAssertFalse(grid.isDue(atNanos: 5 * ms), "5 ms after a commit is not due")
        XCTAssertFalse(grid.isDue(atNanos: 5 * ms), "asking twice moves nothing")
        XCTAssertTrue(grid.isDue(atNanos: 13 * ms), "a quarter interval early is due")
        XCTAssertTrue(grid.admit(atNanos: 17 * ms))
        XCTAssertFalse(grid.admit(atNanos: 20 * ms), "admit commits the frame it admitted")
    }
}
