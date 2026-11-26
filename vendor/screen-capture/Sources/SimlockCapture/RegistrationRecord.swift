import Foundation

/// The frame-callback UUIDs a capture program has registered on one simulator, kept in a file so
/// the next program on that simulator can unregister those a SIGKILL or a crash left behind.
/// The first line is the pid of the program that wrote it: only that program releases the record,
/// and only a record whose program is gone is taken as leftovers.
public struct RegistrationRecord {
    private let url: URL
    private let pid: Int32

    public init(
        deviceUDID: String, directory: URL = URL(fileURLWithPath: NSTemporaryDirectory()),
        pid: Int32 = getpid()
    ) {
        url = directory.appendingPathComponent("simlock-capture-\(deviceUDID).uuids")
        self.pid = pid
    }

    /// Replaces the record with `uuids`, now owned by this program.
    public func write(_ uuids: [UUID]) {
        let lines = ["\(pid)"] + uuids.map(\.uuidString)
        try? lines.joined(separator: "\n").write(to: url, atomically: true, encoding: .utf8)
    }

    /// The UUIDs a program that is gone left, forgotten once returned. A record this program wrote,
    /// or one whose program still runs, is not leftovers: it stays and nothing is returned.
    public func takeLeftovers() -> [UUID] {
        guard let (owner, uuids) = read(), owner != pid, !Self.isRunning(owner) else { return [] }
        try? FileManager.default.removeItem(at: url)
        return uuids
    }

    /// Forgets the record if this program wrote it: it stopped, so it left nothing behind. A record
    /// a later program wrote over it is that program's, and stays.
    public func release() {
        guard let (owner, _) = read(), owner == pid else { return }
        try? FileManager.default.removeItem(at: url)
    }

    private func read() -> (Int32, [UUID])? {
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        let lines = text.split(separator: "\n").map(String.init)
        guard let first = lines.first, let owner = Int32(first) else { return nil }
        return (owner, lines.dropFirst().compactMap { UUID(uuidString: $0) })
    }

    private static func isRunning(_ pid: Int32) -> Bool {
        kill(pid, 0) == 0 || errno == EPERM
    }
}
