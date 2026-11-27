import Foundation
import XCTest

@testable import SimlockCapture

final class RegistrationRecordTests: XCTestCase {
    private func makeDirectory() -> URL {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("registration-record-\(UUID().uuidString)")
        try! FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        return directory
    }

    private func exitedPid() throws -> Int32 {
        let child = Process()
        child.executableURL = URL(fileURLWithPath: "/usr/bin/true")
        try child.run()
        child.waitUntilExit()
        return child.processIdentifier
    }

    func testTheNextProgramOnASimulatorTakesTheUUIDsADeadProgramLeftAndATidyStopLeavesNone() throws {
        let directory = makeDirectory()
        let dead = RegistrationRecord(deviceUDID: "A", directory: directory, pid: try exitedPid())
        let other = RegistrationRecord(deviceUDID: "B", directory: directory, pid: try exitedPid())
        let first = [UUID(), UUID()]

        dead.write(first)
        other.write([UUID()])

        let next = RegistrationRecord(deviceUDID: "A", directory: directory)
        XCTAssertEqual(next.takeLeftovers(), first, "the dead program's UUIDs, in order")
        XCTAssertEqual(next.takeLeftovers(), [], "taken once")

        next.write([UUID()])
        next.release()
        XCTAssertEqual(
            RegistrationRecord(deviceUDID: "A", directory: directory, pid: try exitedPid()).takeLeftovers(), [],
            "a program that stopped left none"
        )
        XCTAssertEqual(
            RegistrationRecord(deviceUDID: "B", directory: directory).takeLeftovers().count, 1,
            "another simulator's record is not touched"
        )
    }

    func testAProgramThatIsStillRunningKeepsItsRecordAndAStopOnlyReleasesItsOwn() throws {
        let directory = makeDirectory()
        let sleeper = Process()
        sleeper.executableURL = URL(fileURLWithPath: "/bin/sleep")
        sleeper.arguments = ["30"]
        try sleeper.run()
        let running = RegistrationRecord(deviceUDID: "A", directory: directory, pid: sleeper.processIdentifier)
        let mine = RegistrationRecord(deviceUDID: "A", directory: directory)
        let uuids = [UUID()]

        running.write(uuids)
        XCTAssertEqual(mine.takeLeftovers(), [], "a live program's UUIDs are not unregistered")
        mine.release()

        sleeper.terminate()
        sleeper.waitUntilExit()
        XCTAssertEqual(
            mine.takeLeftovers(), uuids,
            "a stop that never wrote the record did not delete it, and once its program is gone it is leftovers"
        )
    }

    func testTwoProgramsThatOverlapOnASimulatorEachLeaveTheirOwnUUIDsWhenKilled() throws {
        let directory = makeDirectory()
        let sleepers = try (0..<2).map { _ -> Process in
            let sleeper = Process()
            sleeper.executableURL = URL(fileURLWithPath: "/bin/sleep")
            sleeper.arguments = ["30"]
            try sleeper.run()
            return sleeper
        }
        let uuids = [[UUID()], [UUID()]]
        for (sleeper, own) in zip(sleepers, uuids) {
            RegistrationRecord(deviceUDID: "A", directory: directory, pid: sleeper.processIdentifier).write(own)
        }
        let next = RegistrationRecord(deviceUDID: "A", directory: directory)
        XCTAssertEqual(next.takeLeftovers(), [], "both programs still run")

        for sleeper in sleepers {
            sleeper.terminate()
            sleeper.waitUntilExit()
        }
        XCTAssertEqual(
            Set(next.takeLeftovers()), Set(uuids.flatMap { $0 }),
            "the second program's write did not replace the first's record"
        )
    }
}
