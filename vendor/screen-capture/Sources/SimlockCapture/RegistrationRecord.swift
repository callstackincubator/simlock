import Foundation

/// The frame-callback UUIDs a capture program has registered on one simulator, kept in a file so
/// the next program on that simulator can unregister those a SIGKILL or a crash left behind.
public struct RegistrationRecord {
    private let url: URL

    public init(deviceUDID: String, directory: URL = URL(fileURLWithPath: NSTemporaryDirectory())) {
        url = directory.appendingPathComponent("simlock-capture-\(deviceUDID).uuids")
    }

    /// Replaces the record with `uuids`.
    public func write(_ uuids: [UUID]) {
        try? uuids.map(\.uuidString).joined(separator: "\n").write(to: url, atomically: true, encoding: .utf8)
    }

    /// The UUIDs a program that did not stop left, forgotten once returned.
    public func takeLeftovers() -> [UUID] {
        defer { clear() }
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return [] }
        return text.split(separator: "\n").compactMap { UUID(uuidString: String($0)) }
    }

    /// Forgets the record: the program stopped, so it left nothing behind.
    public func clear() {
        try? FileManager.default.removeItem(at: url)
    }
}
