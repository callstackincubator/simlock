import XCTest

@testable import SimlockCapture
@testable import simlock_screen_capture

final class FrameSelectionTests: XCTestCase {
    private let ms: UInt64 = 1_000_000

    private func composite(at time: UInt64, force: Bool = false, size: (Int, Int) = (1179, 2556)) -> Composite {
        Composite(seenNanos: time, force: force, width: size.0, height: size.1)
    }

    private func copied(_ times: [UInt64], fps: Int = 60) -> Int {
        var selection = FrameSelection(fps: fps)
        return times.filter { selection.decide(composite(at: $0)) }.count
    }

    func testTheCaptureDecidesBeforeItCopiesAndOnlyACopiedCompositeMovesTheGrid() {
        func steady(_ count: Int, every step: UInt64) -> [UInt64] { (0..<count).map { UInt64($0) * step } }
        XCTAssertEqual(copied(steady(200, every: 10 * ms)), 120, "100 a second for 2 s at fps 60")
        XCTAssertEqual(copied(steady(60, every: 33_333_333)), 60, "30 a second for 2 s at fps 60")

        var late = FrameSelection(fps: 60)
        XCTAssertTrue(late.decide(composite(at: 0)), "the first composite")
        XCTAssertTrue(late.decide(composite(at: 200 * ms, force: true)), "a forced composite 200 ms after")
        XCTAssertFalse(late.decide(composite(at: 203 * ms)), "the forced one moved the grid")

        var early = FrameSelection(fps: 60)
        XCTAssertTrue(early.decide(composite(at: 0)))
        XCTAssertTrue(early.decide(composite(at: 5 * ms, force: true)), "a forced composite 5 ms after is copied")
        XCTAssertTrue(early.decide(composite(at: 13 * ms)), "and it did not move the grid")

        var resized = FrameSelection(fps: 60)
        XCTAssertTrue(resized.decide(composite(at: 0)))
        XCTAssertTrue(resized.decide(composite(at: 5 * ms, size: (1398, 2034))), "a new picture size")
    }
}
