import Foundation

/// The active developer directory — where this tool looks for the simulator's
/// frameworks, and the one thing about the host machine it has to ask rather than know.
enum Xcode {
    /// The directory `xcode-select` points at (`xcode-select -p`), e.g.
    /// `/Applications/Xcode.app/Contents/Developer`.
    ///
    /// Asking the tool is the only honest way to read this: Apple ships several switchable
    /// Xcodes and exposes no API for the active one, so any path written into this binary
    /// is a guess about somebody's machine. When the question cannot be asked at all —
    /// `xcode-select` is not where it is expected to be — the answer falls back to the
    /// standard install location, which is the more likely answer than no answer.
    static func developerDir() -> String {
        guard let output = run("/usr/bin/xcode-select", ["-p"]),
              let path = String(data: output, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
        else {
            return "/Applications/Xcode.app/Contents/Developer"
        }
        return path
    }

    /// The standard output of a short-lived program, or nil if it could not be started.
    ///
    /// Reading the pipe is only reached once `run()` has succeeded: asking a `Process` that
    /// never started to wait for its exit traps rather than throwing, so the two cannot be
    /// ordered the other way round.
    private static func run(_ launchPath: String, _ arguments: [String]) -> Data? {
        let output = Pipe()
        let program = Process()
        program.executableURL = URL(fileURLWithPath: launchPath)
        program.arguments = arguments
        program.standardOutput = output
        do {
            try program.run()
        } catch {
            return nil
        }
        program.waitUntilExit()
        return output.fileHandleForReading.readDataToEndOfFile()
    }
}
