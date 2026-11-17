import XCTest

@testable import simlock_screen_capture

final class PanelTouchTests: XCTestCase {
    private let cover = Panel(name: "cover", screenID: 1, width: 1000, height: 2000, nativeRotation: 0, role: .cover)
    private let inner = Panel(name: "inner", screenID: 3, width: 3000, height: 2000, nativeRotation: 270, role: .inner)

    func testAFractionOfTheUprightPictureBecomesTheTouchTheDigitizerReads() {
        let cases: [(String, Panel?, Double, Double, UInt32, Double, Double)] = [
            ("cover", cover, 0.2, 0.1, 0x4000_0001, 0.2, 0.1),
            ("cover top left", cover, 0, 0, 0x4000_0001, 0, 0),
            ("cover bottom right", cover, 1, 1, 0x4000_0001, 1, 1),
            ("inner", inner, 0.2, 0.1, 0x4000_0003, 0.1, 0.8),
            ("inner top left", inner, 0, 0, 0x4000_0003, 0, 1),
            ("inner bottom right", inner, 1, 1, 0x4000_0003, 1, 0),
            ("one panel", nil, 0.2, 0.1, 0x32, 0.2, 0.1),
            ("one panel top left", nil, 0, 0, 0x32, 0, 0),
            ("one panel bottom right", nil, 1, 1, 0x32, 1, 1),
        ]
        for (name, panel, u, v, target, x, y) in cases {
            let touch = PanelTouch.map(panel, x: u, y: v)
            XCTAssertEqual(touch.target, target, name)
            XCTAssertEqual(touch.x, x, accuracy: 1e-9, name)
            XCTAssertEqual(touch.y, y, accuracy: 1e-9, name)
        }
    }
}
