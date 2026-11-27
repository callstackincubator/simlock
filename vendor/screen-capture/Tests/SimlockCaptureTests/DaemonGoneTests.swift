import Foundation
import XCTest

@testable import SimlockCapture

/// why: an internal-file test, for an ordering the surface cannot force: `runCapture` never returns,
/// and the claim is how the process ends. A SIGPIPE or an uncaught exception ends the process that
/// runs it, so the body runs in a child copy of this test bundle and the parent reads how it ended.
final class DaemonGoneTests: XCTestCase {
    private static let childKey = "SIMLOCK_DAEMON_GONE_REPORT"

    func testAProgramWhoseDaemonDiedTakesTheViewerGoneWayOutOnItsNextFrameAndLogLine() throws {
        if let report = ProcessInfo.processInfo.environment[Self.childKey] {
            Self.runAsChild(reportingTo: report)
        }
        let report = FileManager.default.temporaryDirectory
            .appendingPathComponent("daemon-gone-\(UUID().uuidString)").path
        defer { try? FileManager.default.removeItem(atPath: report) }

        let child = Process()
        child.executableURL = URL(fileURLWithPath: ProcessInfo.processInfo.arguments[0])
        child.arguments = [
            "-XCTest",
            "SimlockCaptureTests.DaemonGoneTests/testAProgramWhoseDaemonDiedTakesTheViewerGoneWayOutOnItsNextFrameAndLogLine",
            Bundle(for: Self.self).bundlePath,
        ]
        child.environment = ProcessInfo.processInfo.environment.merging([Self.childKey: report]) { $1 }
        // A daemon that dies closes its end of all three pipes: stdin reads end of file at once.
        child.standardInput = FileHandle.nullDevice
        child.standardOutput = FileHandle.nullDevice
        child.standardError = FileHandle.nullDevice
        try child.run()
        child.waitUntilExit()

        let how = child.terminationReason == .exit ? "exit" : "signal"
        XCTAssertEqual(
            "\(how) \(child.terminationStatus)", "exit 0",
            "the program died on a write to its daemon's closed pipe, before its stop could run"
        )
        XCTAssertEqual(
            try? String(contentsOfFile: report, encoding: .utf8),
            "viewer gone: true, exit request: clean stop"
        )
    }

    /// The program's start as `main.swift` and `runCapture` run it, then a daemon that has died: the
    /// reader of stdout and of stderr is gone and stdin is at end of file. One frame and one log line
    /// are written, as the encode loop and the stdin thread write them.
    private static func runAsChild(reportingTo report: String) -> Never {
        // A program starts with SIGPIPE's default action, whatever the test runner set.
        signal(SIGPIPE, SIG_DFL)
        dup2(brokenPipe(), STDERR_FILENO)
        dup2(brokenPipe(), STDOUT_FILENO)
        Wire.claimStdout()
        let session = Session()
        let sources = ExitSources(onExit: { reason in session.exitRequest.set(reason) })

        Wire.emit(.delta, Data([0]), countedBy: session)
        log("written after the daemon died")

        let exit: String
        switch session.exitRequest.offered() {
        case .none: exit = "none"
        case .some(.none): exit = "clean stop"
        case .some(.some(let reason)): exit = reason
        }
        FileManager.default.createFile(
            atPath: report,
            contents: Data("viewer gone: \(session.viewerGoneFlag), exit request: \(exit)".utf8)
        )
        withExtendedLifetime(sources) {}
        _exit(0)
    }

    /// The write end of a pipe whose read end is already closed.
    private static func brokenPipe() -> Int32 {
        var ends: [Int32] = [0, 0]
        precondition(pipe(&ends) == 0)
        close(ends[0])
        return ends[1]
    }
}
