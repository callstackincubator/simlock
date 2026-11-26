import Foundation
import XCTest

@testable import SimlockCapture

final class RegistrationRecordTests: XCTestCase {
    func testTheNextProgramOnASimulatorTakesTheUUIDsADeadProgramLeftAndATidyStopLeavesNone() {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("registration-record-\(UUID().uuidString)")
        try! FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let dead = RegistrationRecord(deviceUDID: "A", directory: directory)
        let other = RegistrationRecord(deviceUDID: "B", directory: directory)
        let first = [UUID(), UUID()]

        dead.write(first)
        other.write([UUID()])

        let next = RegistrationRecord(deviceUDID: "A", directory: directory)
        XCTAssertEqual(next.takeLeftovers(), first, "the dead program's UUIDs, in order")
        XCTAssertEqual(next.takeLeftovers(), [], "taken once")

        next.write([UUID()])
        next.clear()
        XCTAssertEqual(
            RegistrationRecord(deviceUDID: "A", directory: directory).takeLeftovers(), [],
            "a program that stopped left none"
        )
        XCTAssertEqual(other.takeLeftovers().count, 1, "another simulator's record is not touched")
    }
}
