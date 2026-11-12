import Foundation
import XCTest

@testable import simlock_screen_capture

final class WatchdogTests: XCTestCase {
    private func alive(_ pid: pid_t) -> Bool { kill(pid, 0) == 0 }

    /// Patience for a process to go; the assertion after it names what did not happen.
    private func waitUntil(_ done: () -> Bool) async {
        for _ in 0..<500 where !done() { try? await Task.sleep(nanoseconds: 10_000_000) }
    }

    private func startCommand(_ body: String) async throws -> (watchdog: Process, child: pid_t) {
        let file = NSTemporaryDirectory() + "watchdog-\(UUID().uuidString).pid"
        let watchdog = Watchdog.process(running: ["/bin/sh", "-c", "echo $$ > \(file); \(body)"])
        try watchdog.run()
        await waitUntil { FileManager.default.fileExists(atPath: file) && ((try? String(contentsOfFile: file)) ?? "").hasSuffix("\n") }
        let text = (try? String(contentsOfFile: file, encoding: .utf8)) ?? ""
        let pid = try XCTUnwrap(pid_t(text.trimmingCharacters(in: .whitespacesAndNewlines)), "the command never started")
        return (watchdog, pid)
    }

    func testTheWatchdogEndsItsCommandWhenTheStdinPipeClosesAndEndsWhenTheCommandDoes() async throws {
        let held = try await startCommand("exec sleep 60")
        XCTAssertTrue(alive(held.child), "the command is not running while the pipe is open")
        try (held.watchdog.standardInput as! Pipe).fileHandleForWriting.close()
        await waitUntil { !alive(held.child) }
        XCTAssertFalse(alive(held.child), "the command outlived the closed pipe")

        let short = try await startCommand("exec sleep 0.2")
        await waitUntil { !short.watchdog.isRunning }
        XCTAssertFalse(short.watchdog.isRunning, "the watchdog outlived its command")
        try (short.watchdog.standardInput as! Pipe).fileHandleForWriting.close()
    }

    func testTheWatchdogRunsItsFollowUpAfterKillingTheCommand() async throws {
        let marker = NSTemporaryDirectory() + "watchdog-then-\(UUID().uuidString)"
        let watchdog = Watchdog.process(running: ["/bin/sleep", "60"], then: "touch \(marker)")
        try watchdog.run()
        try (watchdog.standardInput as! Pipe).fileHandleForWriting.close()
        await waitUntil { FileManager.default.fileExists(atPath: marker) }
        XCTAssertTrue(FileManager.default.fileExists(atPath: marker), "the follow-up never ran after the pipe closed")
        try? FileManager.default.removeItem(atPath: marker)
    }
}
