import Foundation

/// The frame-callback UUIDs a capture program has registered on one simulator, kept in a file so
/// the next program on that simulator can unregister those a SIGKILL or a crash left behind.
/// Each program writes its own file, named for its pid: programs that overlap on a simulator never
/// overwrite each other, only a program releases its own file, and a file whose program is gone is
/// leftovers.
public struct RegistrationRecord {
    private let directory: URL
    private let prefix: String
    private let pid: Int32

    public init(
        deviceUDID: String, directory: URL = URL(fileURLWithPath: NSTemporaryDirectory()),
        pid: Int32 = getpid()
    ) {
        self.directory = directory
        prefix = "simlock-capture-\(deviceUDID)."
        self.pid = pid
    }

    private var url: URL { file(for: pid) }

    private func file(for pid: Int32) -> URL {
        directory.appendingPathComponent("\(prefix)\(pid).uuids")
    }

    /// Replaces this program's record with `uuids`.
    public func write(_ uuids: [UUID]) {
        try? uuids.map(\.uuidString).joined(separator: "\n").write(to: url, atomically: true, encoding: .utf8)
    }

    /// The UUIDs the programs that are gone left, forgotten once returned. A record this program
    /// wrote, or one whose program still runs, is not leftovers: it stays and nothing is returned.
    public func takeLeftovers() -> [UUID] {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
        var leftovers: [UUID] = []
        for name in names.sorted() where name.hasPrefix(prefix) && name.hasSuffix(".uuids") {
            let middle = name.dropFirst(prefix.count).dropLast(".uuids".count)
            guard let owner = Int32(middle), owner != pid, !Self.isRunning(owner) else { continue }
            let path = directory.appendingPathComponent(name)
            if let text = try? String(contentsOf: path, encoding: .utf8) {
                leftovers += text.split(separator: "\n").compactMap { UUID(uuidString: String($0)) }
            }
            try? FileManager.default.removeItem(at: path)
        }
        return leftovers
    }

    /// Forgets this program's record: it stopped, so it left nothing behind.
    public func release() {
        try? FileManager.default.removeItem(at: url)
    }

    private static func isRunning(_ pid: Int32) -> Bool {
        kill(pid, 0) == 0 || errno == EPERM
    }
}
